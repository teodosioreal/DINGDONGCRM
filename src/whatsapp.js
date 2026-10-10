// whatsapp.js — IA que responde no WhatsApp da empresa (via Evolution API).
//
// Conexão: a empresa só informa a Session ID (nome da instância que já existe
// na nossa Evolution API) e a API Key dessa instância. O CRM confere as duas na
// Evolution, mostra o número/nome/foto conectados e liga o webhook sozinho.
//
// Fluxo das mensagens:
//  1. A Evolution API manda cada mensagem recebida para o webhook do CRM.
//  2. O CRM acha o lead: pelo código "#ABC123" que o chat do site colocou na
//     mensagem (continua o atendimento do site) ou pelo número; senão, cria.
//  3. Espera o cliente parar de digitar (várias mensagens seguidas viram uma
//     resposta só) e a IA responde com todo o histórico (site + WhatsApp),
//     seguindo as instruções do WhatsApp. Ela pode mandar mídias, mudar a
//     etapa, colocar etiquetas e chamar uma pessoa da equipe.
//  4. Se alguém da equipe responder pelo celular, a IA para naquele lead.

const crypto = require('crypto');
const config = require('./config');
const { estado, salvar, agora } = require('./db');
const { hoje, soDigitos, numeroWhatsapp } = require('./util');
const ia = require('./ia');
const leads = require('./leads');
const fs = require('fs');
const midias = require('./midias');
const comprovantes = require('./comprovantes');
const origem = require('./origem');

// ---------------------------------------------------------------- configuração

// Endereço da Evolution API: o que o admin salvou no painel, senão o do .env
function evolutionUrlGlobal() {
  return String(estado.config?.evolutionUrl || config.evolutionUrlPadrao || '').replace(/\/+$/, '');
}

// Chave global da Evolution (a do servidor): permite o CRM criar as instâncias
// sozinho, como o DingDong Tracking. Do painel (admin) ou do .env.
function chaveGlobal() {
  return String(estado.config?.evolutionApiKey || config.evolutionApiKey || '').trim();
}

// Confere se a chave global é aceita pela Evolution (antes de salvar)
async function testarChaveGlobal(chave, url = evolutionUrlGlobal()) {
  try {
    await chamar({ evolutionUrl: url, instancia: '-', apiKey: chave }, 'GET', '/instance/fetchInstances');
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw erro('O servidor do WhatsApp recusou essa chave. Ela precisa ser a chave GLOBAL da Evolution (a mesma EVOLUTION_API_KEY do DingDong Tracking), não a de uma instância.', 400);
    }
    throw err;
  }
}

function podeCriarInstancia() {
  return Boolean(evolutionUrlGlobal() && chaveGlobal());
}

function configDa(empresa) {
  const c = empresa.whatsappConfig || {};
  return {
    // só o admin troca por empresa (caso raro: empresa com Evolution própria)
    evolutionUrl: (c.evolutionUrl || evolutionUrlGlobal()).replace(/\/+$/, ''),
    instancia: c.instancia || '',
    apiKey: c.apiKey || '',
    iaAtiva: c.iaAtiva !== false,
    segredo: c.segredo || '',
    perfil: c.perfil || null,
    criadaPeloCrm: Boolean(c.criadaPeloCrm)
  };
}

function garantirSegredo(empresa) {
  empresa.whatsappConfig = empresa.whatsappConfig || {};
  if (!empresa.whatsappConfig.segredo) {
    empresa.whatsappConfig.segredo = crypto.randomBytes(16).toString('hex');
    salvar();
  }
  return empresa.whatsappConfig.segredo;
}

function urlWebhook(empresa) {
  return `${config.urlPublica}/api/public/whatsapp/${empresa.id}/${garantirSegredo(empresa)}`;
}

function configurado(empresa) {
  const c = configDa(empresa);
  return Boolean(c.evolutionUrl && c.instancia && c.apiKey);
}

// ---------------------------------------------------------------- Evolution API

function erro(mensagem, status, extra = {}) {
  return Object.assign(new Error(mensagem), { status, ...extra });
}

// `c` = { evolutionUrl, instancia, apiKey } (permite testar antes de salvar)
async function chamar(c, metodo, caminho, corpo, { tempo = 30000 } = {}) {
  if (!c.evolutionUrl) throw erro('O endereço da Evolution API não está configurado (Configurações do sistema).', 400);
  if (!c.instancia || !c.apiKey) throw erro('WhatsApp não conectado: informe a Session ID e a API Key.', 400);
  let res;
  try {
    res = await fetch(`${c.evolutionUrl}${caminho.replace('{instancia}', encodeURIComponent(c.instancia))}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', apikey: c.apiKey },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(tempo)
    });
  } catch (err) {
    const esgotou = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw erro(
      esgotou ? `O servidor do WhatsApp demorou mais de ${Math.round(tempo / 1000)}s para responder.` : `Não consegui falar com o servidor do WhatsApp (${err.message}).`,
      esgotou ? 504 : 502,
      { semResposta: true }
    );
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    const bruto = dados?.response?.message || dados?.message || dados?.error || `HTTP ${res.status}`;
    const lista = Array.isArray(bruto) ? bruto.flat() : [bruto];
    const detalhe = lista.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ');
    throw erro(`Evolution API: ${detalhe}`, res.status);
  }
  return dados;
}

function evolution(empresa, metodo, caminho, corpo, opcoes) {
  // lista negra: nenhuma mensagem sai para esse número, venha de onde vier
  if (/^\/message\/send/i.test(caminho) && corpo?.number && leads.naListaNegra(empresa, corpo.number)) {
    return Promise.reject(Object.assign(new Error('Este cliente está na lista negra: nada é enviado para ele. Tire da lista para voltar a mandar.'), { status: 403, listaNegra: true }));
  }
  return chamar(configDa(empresa), metodo, caminho, corpo, opcoes);
}

// Normaliza a instância como a Evolution devolve (v2 e o formato antigo da v1)
function lerInstancia(item) {
  const i = item?.instance || item || {};
  const dono = i.ownerJid || i.owner || '';
  return {
    id: i.id || i.instanceId || '',
    nome: i.name || i.instanceName || '',
    estado: i.connectionStatus || i.status || i.state || '',
    numero: soDigitos(String(dono).split('@')[0]) || soDigitos(i.number) || '',
    perfilNome: i.profileName || '',
    foto: i.profilePicUrl || i.profilePictureUrl || '',
    integracao: i.integration || ''
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Acha a instância pela Session ID (nome da instância; aceita também o ID
// interno) usando a API Key dela. Erro claro quando algo não confere.
async function buscarInstancia(c) {
  const qs = UUID.test(c.instancia) ? `instanceId=${encodeURIComponent(c.instancia)}` : `instanceName=${encodeURIComponent(c.instancia)}`;
  let lista;
  try {
    lista = await chamar(c, 'GET', `/instance/fetchInstances?${qs}`);
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw erro('A Session ID ou a API Key não conferem. Copie de novo as duas da instância.', 400);
    if (err.status === 404) throw erro(`Não achei a sessão "${c.instancia}" no servidor do WhatsApp. Confira a Session ID.`, 400);
    if (err.status !== 400) throw err;
    lista = null;
  }
  const itens = (Array.isArray(lista) ? lista : lista ? [lista] : []).map(lerInstancia);
  let inst = itens.find((i) => i.nome === c.instancia || i.id === c.instancia) || itens[0];
  if (!inst) {
    // Evolution sem salvar instâncias no banco: confere pelo estado da conexão
    const r = await chamar(c, 'GET', '/instance/connectionState/{instancia}').catch((err) => {
      if (err.status === 401 || err.status === 403) throw erro('A Session ID ou a API Key não conferem. Copie de novo as duas da instância.', 400);
      if (err.status === 404) throw erro(`Não achei a sessão "${c.instancia}" no servidor do WhatsApp. Confira a Session ID.`, 400);
      throw err;
    });
    inst = { id: '', nome: c.instancia, estado: r?.instance?.state || r?.state || '', numero: '', perfilNome: '', foto: '' };
  }
  return inst;
}

// Situação atual da conexão (número, nome, foto, se está conectado)
async function situacao(empresa) {
  const c = configDa(empresa);
  if (!configurado(empresa)) return { conectado: false, configurado: false };
  const inst = await buscarInstancia(c);
  const perfil = {
    numero: inst.numero,
    nome: inst.perfilNome,
    foto: inst.foto,
    estado: inst.estado,
    conferidoEm: agora()
  };
  empresa.whatsappConfig.perfil = perfil;
  salvar();
  let webhookOk = null;
  try {
    webhookOk = ehNossoWebhook(empresa, await webhookAtual(empresa));
  } catch {
    webhookOk = null;
  }
  return { configurado: true, conectado: inst.estado === 'open', ...perfil, sessao: c.instancia, webhookOk };
}

async function qrCode(empresa) {
  const r = await evolution(empresa, 'GET', '/instance/connect/{instancia}');
  const estadoAgora = r?.instance?.state;
  return { conectado: estadoAgora === 'open', base64: r?.base64 || r?.qrcode?.base64 || null, codigo: r?.pairingCode || null };
}

// Código de 8 letras para conectar sem QR (WhatsApp → Aparelhos conectados →
// Conectar com número de telefone)
async function codigoPareamento(empresa, telefone) {
  const numero = numeroWhatsapp(telefone);
  if (numero.length < 10) throw erro('Informe o número do WhatsApp com DDD.', 400);
  const r = await evolution(empresa, 'GET', `/instance/connect/{instancia}?number=${numero}`);
  if (r?.instance?.state === 'open') return { conectado: true };
  const codigo = r?.pairingCode || r?.code;
  if (!codigo || String(codigo).length > 12) throw erro('O servidor do WhatsApp não devolveu o código agora. Tente de novo em alguns segundos ou use o QR code.', 502);
  return { codigo };
}

// Webhook que a instância já tem (cada instância da Evolution tem um só)
async function webhookAtual(empresa) {
  try {
    const r = await evolution(empresa, 'GET', '/webhook/find/{instancia}');
    const w = r?.webhook || r || {};
    return w.enabled === false ? '' : w.url || '';
  } catch (err) {
    if (err.status === 404) return '';
    throw err;
  }
}

// "é nosso" só se for o endereço desta mesma empresa no CRM (o rastreador,
// por exemplo, usa um caminho parecido: /api/public/whatsapp/…)
function ehNossoWebhook(empresa, url) {
  return Boolean(url) && url.startsWith(`${config.urlPublica}/api/public/whatsapp/${empresa.id}/`);
}

// Eventos que o CRM escuta: mensagens, conexão e conversa apagada no celular
// MESSAGES_SET: histórico que o celular manda ao reconectar (entra nas conversas, sem a IA responder)
const EVENTOS_WEBHOOK = ['MESSAGES_UPSERT', 'MESSAGES_SET', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'CHATS_DELETE', 'LABELS_EDIT', 'LABELS_ASSOCIATION'];

// Motivo da queda que a Evolution manda em connection.update (data.statusReason,
// o código HTTP que o Baileys usa internamente pra DisconnectReason). Serve pra
// saber se vale esperar reconectar sozinho ou se só escaneando o QR de novo
// resolve (ver reconexao.js).
const MOTIVOS_DESCONEXAO = {
  401: 'sessão encerrada pelo WhatsApp -- precisa escanear o QR de novo',
  403: 'bloqueado pelo WhatsApp (forbidden)',
  408: 'perda de conexão (rede) -- tende a voltar sozinha',
  411: 'excedeu o limite de aparelhos vinculados ao número',
  428: 'conexão encerrada -- tende a voltar sozinha',
  440: 'outro aparelho assumiu esta sessão (conectou em outro lugar)',
  500: 'sessão corrompida -- pode precisar escanear o QR de novo',
  503: 'servidor do WhatsApp indisponível -- tende a voltar sozinha',
  515: 'reinício interno do WhatsApp -- normal, reconecta sozinha'
};

// Confere o webhook da instância e conserta se for do CRM e estiver errado:
// desligado, com endereço antigo (ex.: depois de reconectar), sem algum evento
// ou sem webhook nenhum. Webhook de OUTRO sistema nunca é mexido.
async function revisarWebhook(empresa) {
  const r = await evolution(empresa, 'GET', '/webhook/find/{instancia}');
  const w = r?.webhook || r || {};
  if (w.url && !ehNossoWebhook(empresa, w.url)) return false;
  const eventos = (w.events || []).map((e) => String(e).toUpperCase());
  const certo = w.url === urlWebhook(empresa) && w.enabled !== false && EVENTOS_WEBHOOK.every((e) => eventos.includes(e));
  if (certo) return false;
  await configurarWebhook(empresa);
  console.log(`[whatsapp ${empresa.id}] webhook consertado (${!w.url ? 'não tinha' : w.enabled === false ? 'estava desligado' : w.url !== urlWebhook(empresa) ? 'endereço antigo' : 'faltava evento'})`);
  return true;
}

// Arquivar (ou desarquivar) a conversa no WhatsApp do celular também
async function arquivarNoWhatsapp(empresa, lead, arquivar) {
  if (!lead.whatsappJid || !configurado(empresa)) return false;
  await evolution(empresa, 'POST', '/chat/archiveChat/{instancia}', { chat: lead.whatsappJid, archive: arquivar });
  return true;
}

// Liga syncFullHistory na instância (preservando o resto das configurações)
// pra Evolution puxar o histórico completo do número ao conectar/reconectar:
// mensagens antigas, contatos, conversas e etiquetas do WhatsApp Business
// (sem isso, só o que acontece DEPOIS de conectar entra). Idempotente: só
// muda de verdade na primeira vez (devolve true), nas próximas é um no-op
// (devolve false) -- tanto pra instância nova (criarInstancia/conectar)
// quanto pras antigas já em uso (revisão periódica no server.js).
async function garantirSyncFullHistory(empresa) {
  try {
    const atual = await evolution(empresa, 'GET', '/settings/find/{instancia}');
    const base = atual?.settings || atual || {};
    if (base.syncFullHistory === true) return false;
    await evolution(empresa, 'POST', '/settings/set/{instancia}', { ...base, syncFullHistory: true });
    return true;
  } catch (err) {
    console.error(`[whatsapp ${empresa.id}] syncFullHistory:`, err.message);
    return false;
  }
}

// A Evolution tem a opção "readMessages" (ler sozinho): ligada, TODA mensagem que chega já fica
// lida no WhatsApp (tiques azuis para o cliente e conversa sem bolinha no celular), mesmo sem
// ninguém abrir. O CRM marca como lida só quando alguém abre a conversa — então ela fica desligada.
// Mexe só na instância desta empresa, preservando o resto das configurações.
async function garantirSemLeituraAutomatica(empresa) {
  try {
    const atual = await evolution(empresa, 'GET', '/settings/find/{instancia}');
    const base = atual?.settings || atual || {};
    if (base.readMessages !== true) return false;
    const { id, instanceId, createdAt, updatedAt, ...resto } = base;
    await evolution(empresa, 'POST', '/settings/set/{instancia}', { ...resto, readMessages: false });
    console.log(`[whatsapp ${empresa.id}] a Evolution lia as mensagens sozinha (readMessages): desliguei`);
    return true;
  } catch (err) {
    console.error(`[whatsapp ${empresa.id}] readMessages:`, err.message);
    return false;
  }
}

// Reinicia o socket da instância (Baileys reconecta sozinho; NÃO apaga a
// sessão nem pede QR novo) -- usado só depois de ligar syncFullHistory numa
// instância que já estava em uso, pra ajudar a resincronizar o estado atual
// (etiquetas incluídas) mais rápido, sem esperar a próxima queda/reconexão
// natural.
async function reiniciarSocket(empresa) {
  try {
    await evolution(empresa, 'POST', '/instance/restart/{instancia}');
  } catch (err) {
    console.error(`[whatsapp ${empresa.id}] restart:`, err.message);
  }
}

// Aponta o webhook da instância para o CRM.
// Se a instância já manda mensagens para OUTRO sistema, não substitui sem
// confirmação: trocar o webhook desliga o outro sistema.
async function configurarWebhook(empresa, { forcar = false } = {}) {
  const url = urlWebhook(empresa);
  const atual = await webhookAtual(empresa);
  if (atual && !ehNossoWebhook(empresa, atual) && !forcar) {
    throw erro(
      'Este WhatsApp já está ligado a outro sistema. Se continuar, o outro sistema para de receber as mensagens deste número.',
      409,
      { webhookAtual: atual }
    );
  }
  const eventos = EVENTOS_WEBHOOK;
  try {
    await evolution(empresa, 'POST', '/webhook/set/{instancia}', {
      webhook: { enabled: true, url, byEvents: false, base64: false, events: eventos }
    });
  } catch (err) {
    if (err.status !== 400) throw err;
    // versões mais antigas da Evolution usam o formato "achatado"
    await evolution(empresa, 'POST', '/webhook/set/{instancia}', {
      enabled: true,
      url,
      webhook_by_events: false,
      webhook_base64: false,
      events: eventos
    });
  }
  return url;
}

// Conecta o WhatsApp da empresa: confere a Session ID + API Key, salva e liga
// o webhook. Com `forcar`, substitui o webhook de outro sistema (confirmado).
async function conectar(empresa, { sessionId, apiKey, forcar = false }) {
  const atual = configDa(empresa);
  const c = {
    evolutionUrl: atual.evolutionUrl,
    instancia: String(sessionId || '').trim(),
    // deixar a API Key vazia mantém a salva (só se for a mesma sessão)
    apiKey: String(apiKey || '').trim() || (String(sessionId || '').trim() === atual.instancia ? atual.apiKey : '')
  };
  if (!c.instancia) throw erro('Informe a Session ID.', 400);
  if (!c.apiKey) throw erro('Informe a API Key.', 400);
  const inst = await buscarInstancia(c);
  // o mesmo número já está em outra empresa deste CRM: não deixa misturar
  const dona = estado.empresas.find((e) => e !== empresa && e.whatsappConfig?.instancia === (inst.nome || c.instancia) && configurado(e));
  if (dona && !forcar) throw erro(`Este WhatsApp já está conectado à empresa "${dona.nome}" neste CRM. Desconecte de lá primeiro.`, 409);
  const anterior = empresa.whatsappConfig ? { ...empresa.whatsappConfig } : undefined;
  empresa.whatsappConfig = {
    ...(empresa.whatsappConfig || {}),
    instancia: inst.nome || c.instancia,
    apiKey: c.apiKey,
    iaAtiva: atual.iaAtiva,
    perfil: { numero: inst.numero, nome: inst.perfilNome, foto: inst.foto, estado: inst.estado, conferidoEm: agora() },
    conectadoEm: agora()
  };
  garantirSegredo(empresa);
  try {
    await configurarWebhook(empresa, { forcar });
  } catch (err) {
    // recusou (número ligado a outro sistema) ou falhou: não fica conectado pela metade
    if (anterior) empresa.whatsappConfig = anterior;
    else delete empresa.whatsappConfig;
    salvar();
    throw err;
  }
  await garantirSyncFullHistory(empresa); // etiquetas e histórico completo também numa instância já existente
  await garantirSemLeituraAutomatica(empresa); // lida só quando alguém abrir a conversa
  empresa.whatsappConfig.webhookLigadoEm = agora();
  // número movido de outra empresa deste CRM (você confirmou): ela deixa de usar este WhatsApp
  if (dona) {
    dona.whatsappConfig = { segredo: dona.whatsappConfig.segredo, desconectadoEm: agora(), movidoPara: empresa.id };
    console.log(`[whatsapp] número movido da empresa ${dona.id} para ${empresa.id}`);
  }
  salvar();
  require('./sincronizar').aoReconectar(empresa); // traz as mensagens da última semana
  return situacao(empresa);
}

// Tira o WhatsApp do CRM (não desconecta o número da Evolution: a instância é
// da empresa). Desliga o webhook só se ele apontar para o CRM.
async function desconectar(empresa) {
  const c = configDa(empresa);
  if (configurado(empresa) && c.criadaPeloCrm && chaveGlobal()) {
    // instância criada pelo CRM: apaga da Evolution (sai do número junto)
    const admin = { evolutionUrl: c.evolutionUrl, instancia: c.instancia, apiKey: chaveGlobal() };
    await chamar(admin, 'DELETE', '/instance/logout/{instancia}').catch(() => {});
    await chamar(admin, 'DELETE', '/instance/delete/{instancia}').catch((err) => console.error(`[whatsapp ${empresa.id}] apagar instância:`, err.message));
  } else if (configurado(empresa)) {
    try {
      if (ehNossoWebhook(empresa, await webhookAtual(empresa))) {
        await evolution(empresa, 'POST', '/webhook/set/{instancia}', {
          webhook: { enabled: false, url: urlWebhook(empresa), events: ['MESSAGES_UPSERT'] }
        });
      }
    } catch (err) {
      console.error(`[whatsapp ${empresa.id}] desligar webhook:`, err.message);
    }
  }
  const { segredo, iaAtiva, evolutionUrl } = empresa.whatsappConfig || {};
  // segredo novo: o endereço antigo do webhook deixa de valer
  empresa.whatsappConfig = { iaAtiva, evolutionUrl, segredo: segredo ? crypto.randomBytes(16).toString('hex') : undefined };
  salvar();
}

// Nome da instância: nome da empresa + final do id (igual ao DingDong Tracking)
function nomeInstancia(empresa) {
  const base = String(empresa.nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return `crm-${base || 'empresa'}-${empresa.id.slice(-6)}`;
}

// Cria a instância na nossa Evolution API, já com o webhook do CRM, e devolve
// o QR code para o cliente escanear. Se a instância desta empresa já existir
// (ex.: criada antes e desconectada), reaproveita.
async function criarInstancia(empresa) {
  const url = evolutionUrlGlobal();
  const global = chaveGlobal();
  if (!url || !global) {
    throw erro('Falta a chave global da Evolution API (Configurações do sistema) para criar conexões automaticamente.', 400);
  }
  const nome = nomeInstancia(empresa);
  const webhook = { url: urlWebhook(empresa), byEvents: false, base64: false, events: EVENTOS_WEBHOOK };
  const admin = { evolutionUrl: url, instancia: nome, apiKey: global };
  let token = '';
  let qrDoCreate = null;
  try {
    const r = await chamar(admin, 'POST', '/instance/create', {
      instanceName: nome,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      groupsIgnore: true,
      webhook: { enabled: true, ...webhook }
    });
    token = typeof r?.hash === 'string' ? r.hash : r?.hash?.apikey || '';
    qrDoCreate = r?.qrcode?.base64 || null;
  } catch (err) {
    if (err.status === 401) throw erro('O servidor do WhatsApp recusou a chave global. Confira a chave em Configurações do sistema (a mesma EVOLUTION_API_KEY do DingDong Tracking).', 400);
    // já existe (criada antes por este CRM): busca o token dela
    if (!/already in use|já está em uso|exists/i.test(err.message) && err.status !== 403) throw err;
    const lista = await chamar(admin, 'GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(nome)}`);
    const item = (Array.isArray(lista) ? lista : [lista]).map((x) => x?.instance || x).find((x) => (x?.name || x?.instanceName) === nome);
    token = item?.token || item?.apikey || '';
  }
  empresa.whatsappConfig = {
    ...(empresa.whatsappConfig || {}),
    evolutionUrl: '',
    instancia: nome,
    // o token da própria instância; se a Evolution não devolver, usa a chave global
    apiKey: token || global,
    criadaPeloCrm: true,
    perfil: { estado: 'connecting', conferidoEm: agora() },
    criadaEm: agora()
  };
  garantirSegredo(empresa);
  salvar();
  // garante o webhook (versões antigas ignoram o webhook no create)
  await configurarWebhook(empresa, { forcar: false });
  // puxa o histórico completo (mensagens, contatos e etiquetas do WhatsApp
  // Business) desde a primeira conexão -- sem isso, só entra o que acontece
  // DEPOIS de escanear o QR.
  await garantirSyncFullHistory(empresa);
  const qr = await qrCode(empresa).catch(() => ({ conectado: false, base64: null }));
  // logo depois de criar, o connect às vezes ainda não tem o QR: usa o do create
  if (!qr.base64 && qrDoCreate) qr.base64 = qrDoCreate;
  return qr;
}

// Desconecta o número do WhatsApp (sai do aparelho). A instância continua e
// dá para conectar outro número com um QR code novo.
async function sairDoNumero(empresa) {
  try {
    await evolution(empresa, 'DELETE', '/instance/logout/{instancia}');
  } catch (err) {
    if (!/not connected|não está conectad/i.test(err.message)) throw err;
  }
  empresa.whatsappConfig.perfil = { estado: 'close', conferidoEm: agora() };
  salvar();
}

// Para onde enviar: número puro se for um contato comum; senão o JID inteiro
function destinoDe(jid) {
  return /@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0] : jid;
}

// Destino de um lead: o JID do WhatsApp; senão o telefone que ele deixou
function destinoDoLead(lead) {
  if (lead.whatsappJid) return destinoDe(lead.whatsappJid);
  const n = numeroWhatsapp(lead.telefone);
  return n.length >= 10 ? n : '';
}

// ids das mensagens que o próprio CRM enviou, para não confundir com a equipe
const enviadosPeloCrm = new Map();
function lembrarEnvio(resposta, destino) {
  const id = resposta?.key?.id;
  if (id) enviadosPeloCrm.set(id, Date.now());
  if (id && destino) leads.registrarEnvioWhatsapp(destino, id); // a mensagem salva em seguida guarda o id (para apagar depois)
  if (enviadosPeloCrm.size > 5000) {
    const corte = Date.now() - 60 * 60 * 1000;
    for (const [k, t] of enviadosPeloCrm) if (t < corte) enviadosPeloCrm.delete(k);
  }
}

const foiEnviadoPeloCrm = (id) => enviadosPeloCrm.has(id);

// O eco de uma mensagem do CRM (messages.upsert com fromMe) pode chegar ANTES de a
// Evolution devolver o id do envio. Sem isto, a resposta da própria IA era tratada
// como "a equipe respondeu pelo celular" (pausava a IA e virava exemplo do clone).
// Guarda o texto/mídia que está saindo para cada destino por 3 minutos.
const ecosEsperados = new Map(); // dígitos do destino → [{ texto, midia, em }]
const digitosDe = (v) => String(v || '').split('@')[0].replace(/\D/g, '');
const normalizarEco = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
function esperarEco(destino, { texto = '', midia = false } = {}) {
  const k = digitosDe(destinoDe(destino));
  if (!k) return;
  const corte = Date.now() - 3 * 60 * 1000;
  const lista = (ecosEsperados.get(k) || []).filter((x) => x.em > corte);
  lista.push({ texto: normalizarEco(texto), midia, em: Date.now() });
  ecosEsperados.set(k, lista.slice(-20));
  if (ecosEsperados.size > 3000) ecosEsperados.delete(ecosEsperados.keys().next().value);
}
// esta mensagem "da empresa" é o eco de algo que o CRM acabou de mandar?
function ehEcoDoCrm(msg, lead, texto) {
  const chaves = new Set([msg?.key?.remoteJid, msg?.key?.remoteJidAlt, lead?.whatsappJid, lead?.lidJid, lead?.telefone].map(digitosDe).filter(Boolean));
  const corte = Date.now() - 3 * 60 * 1000;
  const m = msg?.message || {};
  const ehMidia = Boolean(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.documentWithCaptionMessage);
  const alvo = normalizarEco(texto);
  for (const k of chaves) {
    const lista = ecosEsperados.get(k) || [];
    const i = lista.findIndex((x) => x.em > corte && (ehMidia ? x.midia : !x.midia && x.texto && x.texto === alvo));
    if (i >= 0) {
      lista.splice(i, 1);
      return true;
    }
  }
  return false;
}
// a IA já vai responder (ou está escrevendo) para este contato?
const iaOcupadaCom = (leadId) => agendadas.has(leadId) || emResposta.has(leadId);

// "digitando…" proporcional ao tamanho, como uma pessoa (máx. 5 s)
// Ritmo da IA no WhatsApp. "espera": quanto tempo ela espera o cliente parar
// de mandar mensagens antes de responder; "digitando": quanto tempo aparece
// "digitando…" antes de cada mensagem (maior para textos maiores).
const VELOCIDADES = {
  rapido: { nome: 'Rápido', espera: 3000, base: 600, porLetra: 12, max: 3000 },
  humanizado: { nome: 'Humanizado', espera: 8000, base: 1500, porLetra: 35, max: 10000 },
  lento: { nome: 'Mais lento', espera: 25000, base: 4000, porLetra: 60, max: 20000 }
};

function ritmoDa(empresa) {
  return VELOCIDADES[empresa?.whatsappConfig?.velocidade] || VELOCIDADES.humanizado;
}

function tempoDigitando(texto, empresa) {
  const v = ritmoDa(empresa);
  return Math.min(v.max, v.base + String(texto || '').length * v.porLetra);
}

// Quanto esperar antes de responder (a 1ª mensagem de um lead novo pode esperar mais)
function esperaParaResponder(empresa, lead) {
  const base = process.env.WHATSAPP_ESPERA_MS ? config.whatsappEsperaMs : ritmoDa(empresa).espera;
  const jaRespondido = (lead.mensagens || []).some((m) => m.papel === 'assistente' || m.papel === 'equipe');
  const primeira = Math.max(0, Math.min(3600, Number(empresa?.whatsappConfig?.esperaPrimeiraSeg) || 0)) * 1000;
  return base + (jaRespondido ? 0 : primeira);
}

async function enviarTexto(empresa, destino, texto, { digitando = true } = {}) {
  esperarEco(destino, { texto });
  const r = await evolution(empresa, 'POST', '/message/sendText/{instancia}', {
    number: destinoDe(destino),
    text: texto,
    ...(digitando ? { delay: tempoDigitando(texto, empresa) } : {})
  });
  lembrarEnvio(r, destino);
  return r;
}

// Vídeo pronto para tocar na conversa? (MP4 leve; o resto vai como arquivo para não falhar)
function videoTocaNoWhatsapp(midia) {
  return midia.mimetype === 'video/mp4' && midia.tamanho <= require('./video').LIMITE_WHATSAPP && midia.videoOk !== false;
}

async function enviarMidia(empresa, destino, midia, legenda = '') {
  if (midia.processando) throw erro(`O vídeo "${midia.codigo || midia.nome}" ainda está sendo convertido para o WhatsApp. Tente de novo em instantes.`, 409);
  const url = midias.urlPublica(midia);
  esperarEco(destino, { midia: true });
  // o WhatsApp baixa o arquivo do CRM e sobe para os servidores dele: vídeo grande demora
  const tempo = midia.tipo === 'image' ? 60000 : 180000;
  const mandar = (mediatype) =>
    evolution(
      empresa,
      'POST',
      '/message/sendMedia/{instancia}',
      {
        number: destinoDe(destino),
        mediatype,
        mimetype: midia.mimetype,
        media: url,
        fileName: midias.nomeComExtensao(midia.arquivo, midia.mimetype),
        caption: legenda || '',
        delay: 1200
      },
      { tempo }
    );
  let r;
  if (midia.tipo === 'audio') {
    r = await evolution(empresa, 'POST', '/message/sendWhatsAppAudio/{instancia}', { number: destinoDe(destino), audio: url, delay: 1500 }, { tempo });
  } else if (midia.tipo === 'video' && !videoTocaNoWhatsapp(midia)) {
    r = await mandar('document');
  } else {
    try {
      r = await mandar(midia.tipo);
    } catch (err) {
      // o WhatsApp recusou o vídeo como vídeo: manda como arquivo para o cliente receber mesmo assim
      // (se o servidor só demorou, não repete — poderia chegar duas vezes)
      if (midia.tipo !== 'video' || err.semResposta) throw err;
      console.error(`[whatsapp] vídeo ${midia.codigo} recusado como vídeo (${err.message}); enviando como arquivo`);
      r = await mandar('document');
    }
  }
  lembrarEnvio(r, destino);
  return r;
}

// ---------------------------------------------------------------- mensagens recebidas

function textoDa(msg) {
  const m = msg.message || {};
  const texto =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    '';
  const anexo = m.imageMessage
    ? '[o cliente enviou uma imagem]'
    : m.audioMessage
      ? '[o cliente enviou um áudio]'
      : m.videoMessage
        ? '[o cliente enviou um vídeo]'
        : m.documentMessage || m.documentWithCaptionMessage
          ? '[o cliente enviou um documento]'
          : m.stickerMessage
            ? '[o cliente enviou uma figurinha]'
            : m.locationMessage
              ? '[o cliente enviou uma localização]'
              : m.contactMessage
                ? '[o cliente enviou um contato]'
                : '';
  return [anexo, texto].filter(Boolean).join(' ').trim();
}

function telefoneDe(msg) {
  const k = msg.key || {};
  const candidato = [k.remoteJid, k.senderPn, k.remoteJidAlt, msg.senderPn].find((j) => /@s\.whatsapp\.net$/.test(j || ''));
  return candidato ? candidato.split('@')[0] : '';
}

const processadas = new Map(); // evita processar a mesma mensagem duas vezes
function jaProcessada(id) {
  if (!id) return false;
  if (processadas.has(id)) return true;
  processadas.set(id, Date.now());
  if (processadas.size > 5000) {
    const corte = Date.now() - 6 * 60 * 60 * 1000;
    for (const [k, t] of processadas) if (t < corte) processadas.delete(k);
  }
  return false;
}

// Lead que tem este número: pelo JID ou pelo telefone que deixou no site
// Celular do Brasil pode vir com ou sem o 9 depois do DDD (5521988887777 = 552188887777)
function mesmoNumero(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const sem9 = (n) => (/^55\d{2}9\d{8}$/.test(n) ? n.slice(0, 4) + n.slice(5) : n);
  return sem9(a) === sem9(b);
}


function acharOuCriarLead(empresa, jid, texto, msg) {
  const doEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
  // 1) código do chat do site na mensagem → continua aquele atendimento
  const codigo = (texto.match(/#([A-Z2-9]{6})\b/) || [])[1];
  const identidade = require('./identidade');
  const msgCom = { ...msg, key: { ...(msg?.key || {}), remoteJid: msg?.key?.remoteJid || jid, ...(msg?.key?.remoteJid && msg.key.remoteJid !== jid ? { remoteJidAlt: msg.key.remoteJidAlt || jid } : {}) } };
  if (codigo) {
    const doSite = doEmpresa.find((c) => c.codigo === codigo);
    const doMesmoCliente = doSite && doSite.whatsappJid && identidade.conversasDoCliente(empresa, identidade.enderecos(msgCom)).includes(doSite);
    if (doSite && (!doSite.whatsappJid || doSite.whatsappJid === jid || doMesmoCliente)) {
      doSite.whatsappJid = doSite.whatsappJid && doMesmoCliente ? doSite.whatsappJid : jid;
      doSite.telefone = doSite.telefone || telefoneDe(msg);
      if (msg.pushName && !doSite.nome) doSite.nome = msg.pushName;
      return doSite;
    }
  }
  // 1b) código de um clique no botão do WhatsApp do site (sem chat): o lead
  // nasce já com a origem do cliente (anúncio, página que ele via…)
  const visita = codigo && origem.tirarVisita(empresa.id, codigo);
  // 2) o mesmo cliente (número com/sem 9, id escondido…) → a mesma conversa
  const existente = identidade.acharCliente(empresa, msgCom);
  if (existente) {
    if (msg.pushName && !existente.nome) existente.nome = msg.pushName;
    if (visita) origem.registrarNoLead(existente, visita.rastro);
    return existente;
  }
  // 3) novo lead que chegou direto pelo WhatsApp
  const bot = botDoWhatsapp(empresa);
  const e = identidade.enderecos(msgCom);
  const novo = leads.criarLead({ empresa, bot, canal: 'whatsapp', nome: msg.pushName || '', telefone: telefoneDe(msgCom), whatsappJid: identidade.jidPreferido(empresa, msgCom) });
  if (e.lid) novo.lidJid = e.lid;
  require('./localizacao').garantir(novo);
  if (visita) {
    novo.codigo = codigo; // o mesmo código da mensagem, para a equipe achar
    novo.veioDoSite = true;
    origem.registrarNoLead(novo, visita.rastro);
  }
  return novo;
}

function botDoWhatsapp(empresa) {
  const daEmpresa = estado.bots.filter((b) => b.empresaId === empresa.id);
  return daEmpresa.find((b) => b.principal) || daEmpresa[0] || null;
}

// Evolution manda { event, instance, data } — data pode ser uma mensagem ou lista
function eventoDe(corpo) {
  return String(corpo?.event || '').toLowerCase().replace(/_/g, '.');
}

function mensagensDoWebhook(corpo) {
  const evento = eventoDe(corpo);
  if (evento && evento !== 'messages.upsert') return [];
  const d = corpo?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.messages)) return d.messages;
  return d ? [d] : [];
}

// Palavras que tiram o contato dos disparos em massa
const PALAVRAS_SAIR = ['sair', 'parar', 'pare', 'stop', 'cancelar inscricao', 'nao quero mais receber', 'descadastrar'];
function pediuParaSair(texto) {
  const t = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\w ]/g, '').trim();
  return PALAVRAS_SAIR.includes(t);
}

async function receberWebhook(empresa, corpo) {
  empresa.whatsappConfig = empresa.whatsappConfig || {};
  empresa.whatsappConfig.ultimoWebhookEm = new Date().toISOString();
  empresa.whatsappConfig.ultimoEvento = String(corpo?.event || '').slice(0, 40);
  if (require('./entre-empresas').aprenderNumeroProprio(empresa, corpo)) salvar();
  // mudança de conexão: guarda para o painel mostrar
  if (eventoDe(corpo) === 'connection.update') {
    const st = corpo?.data?.state || corpo?.data?.status;
    const motivo = corpo?.data?.statusReason;
    if (st && empresa.whatsappConfig) {
      const antes = empresa.whatsappConfig.perfil?.estado;
      empresa.whatsappConfig.perfil = { ...(empresa.whatsappConfig.perfil || {}), estado: st, conferidoEm: agora(), motivoFechou: st === 'close' ? motivo : undefined };
      salvar();
      // caiu (o WhatsApp encerrou a sessão do aparelho): avisa no sininho na hora
      if (st === 'close' && antes !== 'close') {
        const rotulo = MOTIVOS_DESCONEXAO[Number(motivo)] || (motivo !== undefined ? `código ${motivo}` : 'motivo não informado pela Evolution');
        console.log(`[whatsapp ${empresa.id}] desconectou: ${rotulo}`);
        require('./alertas').registrar(empresa, 'whatsapp-desconectado', `O WhatsApp da empresa desconectou (${rotulo}). A IA não recebe nem responde mensagens até conectar de novo em IA do WhatsApp.`);
        // só tenta reconectar sozinho (reiniciar o socket) se o motivo for recuperável;
        // sessão encerrada pelo WhatsApp (QR/login) só resolve escaneando de novo
        if (antes === 'open') require('./reconexao').registrarQueda(empresa, motivo);
      }
      // voltou a conectar: busca o que chegou enquanto estava fora
      if (st === 'open' && antes !== 'open') {
        empresa.whatsappConfig.reconectouEm = agora(); // o celular reenvia as etiquetas logo depois
        require('./alertas').resolverTipo(empresa, 'whatsapp-desconectado');
        require('./reconexao').registrarVolta(empresa);
        require('./sincronizar').aoReconectar(empresa);
        require('./etiquetas-zap').carregar(empresa).catch(() => {});
        // ao conectar, o celular manda as etiquetas aos poucos: lê de novo depois
        setTimeout(() => require('./etiquetas-zap').carregar(empresa).catch(() => {}), 90 * 1000).unref?.();
      }
    }
    return;
  }
  // etiquetas do WhatsApp Business (criou/renomeou, marcou/desmarcou um cliente)
  if (eventoDe(corpo) === 'labels.edit' || eventoDe(corpo) === 'labels.association') {
    require('./etiquetas-zap').receberWebhook(empresa, eventoDe(corpo), corpo?.data);
    return;
  }
  // histórico que o celular manda ao reconectar: entra nas conversas, sem a IA responder
  if (eventoDe(corpo) === 'messages.set') {
    const d = corpo?.data;
    const lista = Array.isArray(d) ? d : Array.isArray(d?.messages) ? d.messages : [];
    const n = require('./sincronizar').importarLote(empresa, lista);
    if (n) console.log(`[whatsapp ${empresa.id}] histórico: ${n} mensagem(ns) recuperada(s)`);
    return;
  }
  // conversa apagada no WhatsApp do celular: sai da lista do CRM (vai para "Arquivadas")
  if (eventoDe(corpo) === 'chats.delete') {
    const jids = (Array.isArray(corpo?.data) ? corpo.data : [corpo?.data]).map((x) => (typeof x === 'string' ? x : x?.remoteJid || x?.id)).filter(Boolean);
    const doCliente = jids.map((j) => require('./identidade').conversaDoEndereco(empresa, j)).filter(Boolean);
    for (const lead of [...new Set(doCliente)]) {
      lead.arquivado = true;
      lead.arquivadoPor = 'apagada no WhatsApp';
      lead.arquivadoEm = agora();
    }
    salvar();
    return;
  }
  // confirmação do WhatsApp para o que saiu (✓ servidor, ✓✓ entregue, azul lida, erro)
  if (eventoDe(corpo) === 'messages.update') {
    receberStatusEntrega(empresa, corpo?.data);
    return;
  }
  // mensagem apagada "para todos" no WhatsApp (pelo cliente ou pelo celular da empresa)
  if (eventoDe(corpo) === 'messages.delete') {
    const itens = Array.isArray(corpo?.data) ? corpo.data : [corpo?.data];
    for (const d of itens) {
      // dois formatos: { remoteJid, fromMe, id } ou { id: <id interno>, key: { id, remoteJid } }
      const wid = d?.key?.id || d?.id;
      const jid = d?.key?.remoteJid || d?.remoteJid || '';
      if (!wid) continue;
      const lead = estado.conversas.find((c) => c.empresaId === empresa.id && (!jid || c.whatsappJid === jid) && (c.mensagens || []).some((m) => m.wid === wid || m.wids?.includes(wid)));
      const m = lead?.mensagens.find((x) => x.wid === wid || x.wids?.includes(wid));
      if (m && !m.apagada) marcarApagada(lead, m, m.papel === 'visitante' ? 'cliente' : 'celular');
    }
    salvar();
    return;
  }
  for (const msg of mensagensDoWebhook(corpo)) {
    const jid = msg?.key?.remoteJid || '';
    // grupo de gastos da empresa (Faturamento): cada mensagem vira gasto
    if (/@g\.us$/.test(jid) && require('./gastos').ehDoGrupo(empresa, jid)) {
      await require('./gastos').daMensagem(empresa, msg).catch((err) => console.error(`[gastos ${empresa.id}]`, err.message));
      continue;
    }
    if (!jid || /@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue; // grupos, status, canais
    if (jaProcessada(msg.key.id)) continue;
    // conversa apagada no painel: mensagem (atrasada) de antes de apagar não volta
    const tsMsg = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || 0;
    if (tsMsg && require('./lixeira').mensagemApagada(empresa, msg, (tsMsg > 1e12 ? tsMsg : tsMsg * 1000))) continue;
    let texto = textoDa(msg);
    if (!texto) continue;
    // número novo + conversas antigas só com id escondido: descobre se é o mesmo cliente
    await require('./identidade').aprenderLidDaMensagem(empresa, msg).catch(() => null);

    if (msg.key.fromMe) {
      // enviada pelo próprio CRM (eco) → ignora; enviada pela equipe no celular → IA para
      if (enviadosPeloCrm.has(msg.key.id)) {
        ehEcoDoCrm(msg, require('./identidade').acharCliente(empresa, msg), texto); // já reconhecido pelo id: tira da lista de ecos esperados
        continue;
      }
      // atalho digitado no celular (ex.: /preco) → o CRM manda a resposta pronta com a mídia
      const atalho = respostaPorAtalho(empresa, texto);
      if (atalho) {
        await usarAtalhoDoCelular(empresa, jid, msg, atalho).catch((err) => console.error(`[whatsapp atalho ${jid}]`, err.message));
        continue;
      }
      // a equipe respondeu pelo celular: acha a conversa por qualquer endereço do cliente
      const lead = require('./identidade').acharCliente(empresa, msg);
      if (!lead) continue;
      // eco da IA/automação que chegou antes da confirmação do envio: não é a equipe
      if (ehEcoDoCrm(msg, lead, texto)) {
        enviadosPeloCrm.set(msg.key.id, Date.now());
        continue;
      }
      const anexo = await baixarAnexo(empresa, lead, msg).catch(() => null);
      const NOME_TIPO = { image: 'uma foto', audio: 'um áudio', video: 'um vídeo', document: 'um arquivo' };
      const legenda = texto.replace(/^\[o cliente enviou (um|uma) [^\]]+\]\s*/, '');
      const textoEquipe = anexo ? legenda || `[enviou ${NOME_TIPO[anexo.anexo.tipo] || 'um arquivo'}]` : texto;
      leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: textoEquipe, anexo: anexo?.anexo, wid: msg.key.id });
      require('./tickets').agendamentoDaMensagem(empresa, lead, textoEquipe, 'equipe');
      require('./detector-agenda').observar(empresa, lead); // marcou/desmarcou pelo celular
      // modo clone: aprende com o que você respondeu pelo celular (texto e arquivo)
      if (anexo?.anexo) require('./clone').aprenderAnexo(empresa, lead, anexo.anexo, legenda);
      else require('./clone').registrar(empresa, lead, { texto: textoEquipe });
      pausarPorMensagemManual(empresa, lead, 'A equipe respondeu pelo WhatsApp');
      salvar();
      continue;
    }

    // número de outra empresa do CRM: não vira conversa e a IA não responde (senão as duas IAs conversam sem parar)
    if (require('./entre-empresas').mensagemDeOutraEmpresa(empresa, msg)) continue;
    const lead = acharOuCriarLead(empresa, jid, texto, msg);
    // "não atropelar": enquanto esta mensagem é preparada (foto descrita pela IA, áudio
    // transcrito…), a IA não responde este cliente — responde tudo junto depois
    marcarChegando(lead.id, +1);
    try {
      await receberDoCliente(empresa, lead, jid, msg, texto);
    } finally {
      marcarChegando(lead.id, -1);
    }
  }
}

// Uma mensagem do cliente (já com a conversa achada)
async function receberDoCliente(empresa, lead, jid, msg, texto) {
  delete lead.historicoImportado; // o cliente escreveu de verdade agora
  // número escondido pelo WhatsApp: pergunta à Evolution qual é o de verdade (sem travar a resposta)
  if (/@lid$/.test(lead.whatsappJid || '') && (!lead.lidTentativaEm || Date.now() - new Date(lead.lidTentativaEm).getTime() > 6 * 3600 * 1000)) {
    lead.lidTentativaEm = agora();
    const lid = lead.whatsappJid;
    require('./sincronizar').descobrirNumeroDoLid(empresa, lid).then((tel) => tel && (require('./sincronizar').consertarLid(empresa, lid, tel), salvar())).catch(() => {});
  }
  require('./fotos-clientes').agendar(lead); // foto de perfil do cliente (se ainda não tem ou está velha)
  // cliente mandou mensagem de novo: a conversa volta para a lista
  if (lead.arquivado) {
    lead.arquivado = false;
    lead.arquivadoPor = '';
  }
  // veio de um anúncio de clique para WhatsApp (Meta)? guarda qual
  const anuncioMeta = origem.anuncioDoWhatsapp(msg);
  if (anuncioMeta) origem.registrarAnuncioWhatsapp(lead, anuncioMeta);
  // áudio vira texto e foto vira descrição, para a IA entender — só se a IA vai
  // responder este cliente (economiza tokens); comprovante de Pix é lido sempre (sem IA)
  let anexo = null;
  try {
    const r = await baixarAnexo(empresa, lead, msg, { entender: iaVaiResponder(empresa, lead), comprovante: true });
    if (r) {
      anexo = r.anexo;
      if (r.entendido) texto = r.entendido;
    }
  } catch (err) {
    console.error(`[whatsapp ${lead.id}] anexo:`, err.message);
  }
  // a busca de mensagens (sincronizar) pode ter trazido esta mesma mensagem enquanto a
  // foto/áudio era preparado: completa a que já está lá em vez de duplicar
  const jaTem = (lead.mensagens || []).find((m) => m.papel === 'visitante' && (m.wid === msg.key.id || m.wids?.includes(msg.key.id)));
  if (jaTem) {
    jaTem.texto = texto;
    if (anexo && !jaTem.anexo) jaTem.anexo = anexo;
    delete jaTem.importada;
    lead.atualizadoEm = agora();
  } else leads.adicionarMensagem(lead, { papel: 'visitante', canal: 'whatsapp', texto, anexo: anexo || undefined, wid: msg.key.id });
  require('./localizacao').lerMensagem(lead, texto); // "sou de Petrópolis" → 📍 Petrópolis
  require('./tickets').agendamentoDaMensagem(empresa, lead, texto, 'cliente'); // "confirmado sábado 9h"
  require('./detector-agenda').observar(empresa, lead); // "pode ser", "vou ter que desmarcar"…
  origem.aplicarAnuncio(empresa, lead);
  require('./automacoes').cancelarFollowupsDaIa(lead); // respondeu antes do follow-up
  lead.naoLidas = (lead.naoLidas || 0) + 1;
  leads.aoChegarNoWhatsapp(lead, empresa);
  leads.aoConversar(lead, empresa); // 2ª mensagem do cliente: Lead novo → Convertendo

  // lista negra: a mensagem aparece em Conversas, mas ninguém (nem a IA) responde
  if (leads.naListaNegra(empresa, lead)) {
    lead.listaNegra = true;
    salvar();
    return;
  }

  // resposta "SAIR" a um disparo em massa: não recebe mais disparos
  if (lead.ultimoDisparoEm && pediuParaSair(texto)) {
    lead.naoDisparar = true;
    salvar();
    const confirmacao = 'Pronto! Você não vai mais receber nossas mensagens automáticas. Se precisar, é só chamar aqui. 👍';
    enviarTexto(empresa, jid, confirmacao)
      .then(() => {
        leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: confirmacao });
        salvar();
      })
      .catch((err) => console.error(`[whatsapp ${lead.id}] sair:`, err.message));
    return;
  }
  salvar();
  if (resolverSemIa(empresa, lead, texto, jid)) return;
  agendarResposta(empresa, lead);
}

// ---------------------------------------------------------------- o que dá para resolver sem IA (economiza tokens)

// "ok", "obrigado", "👍", figurinha… depois de uma resposta nossa que não perguntou nada:
// não precisa de resposta (a IA não é chamada)
const SO_CONFIRMACAO = /^(ok+|okay|okey|blz|beleza|obrigad[oa]s?|obg|brigad[oa]|vlw|valeu|tmj|show|top|perfeito|certo|certinho|combinado|entendi|entendido|t[aá]|t[aá] bom|t[aá] certo|de nada|tudo bem|kk+|rs+|haha+|hehe+|sim sim|beleza então|fechou)[\s!.,]*$/i;
function soConfirmacao(texto) {
  const t = String(texto || '').trim();
  if (!t) return false;
  if (t === '[o cliente enviou uma figurinha]') return true;
  const semEmoji = t.replace(/[\p{Extended_Pictographic}\u200d\ufe0f\s]/gu, '');
  if (!semEmoji) return true; // só emoji
  return SO_CONFIRMACAO.test(t.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').trim());
}

// "quero falar com um atendente / uma pessoa / humano"
const PEDE_HUMANO = /\b(falar|conversar|atendimento)\s+(com\s+)?(um|uma|algu[eé]m|o|a)?\s*(atendente|humano|pessoa( de verdade)?|vendedor[a]?|dono|respons[aá]vel|gerente)\b|\batendimento humano\b|\bn[aã]o quero (falar com )?(rob[oô]|bot|ia)\b/i;

function resolverSemIa(empresa, lead, texto, jid) {
  if (!iaVaiResponder(empresa, lead)) return false; // a IA nem ia responder: segue o fluxo normal (que registra o motivo)
  const nossas = (lead.mensagens || []).filter((m) => m.papel !== 'visitante' && !m.apagada);
  const ultimaNossa = nossas[nossas.length - 1];
  // antes deste "ok" o cliente já tinha mandado algo sem resposta? então precisa responder
  const visiveis = (lead.mensagens || []).filter((m) => !m.apagada);
  const anterior = visiveis[visiveis.length - 2];
  // (a própria mensagem que está chegando conta 1 em "chegando": só outra a mais é pendência)
  const temPendente = anterior?.papel === 'visitante' || (chegando.get(lead.id) || 0) > 1 || emResposta.has(lead.id) || agendadas.has(lead.id);
  if (soConfirmacao(texto) && ultimaNossa && !temPendente && !/\?\s*$/.test(ultimaNossa.texto || '')) {
    const ultima = visiveis[visiveis.length - 1];
    if (ultima?.papel === 'visitante') ultima.semResposta = true; // não faz a IA refazer o que está escrevendo
    registrarIa(empresa, lead, 'ignorou', 'Só confirmação ("ok", "obrigado", emoji…) — não precisava de resposta.');
    return true;
  }
  if (PEDE_HUMANO.test(texto)) {
    const aviso = 'Claro! Já chamei uma pessoa da equipe para falar com você. Em instantes alguém te responde por aqui. 😊';
    lead.iaPausada = true;
    lead.iaPausadaMotivo = 'O cliente pediu para falar com uma pessoa';
    lead.precisaHumano = true;
    salvar();
    enviarTexto(empresa, jid, aviso)
      .then(() => {
        leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: aviso });
        registrarIa(empresa, lead, 'respondeu', 'O cliente pediu uma pessoa: avisei e chamei a equipe (sem gastar IA).');
        salvar();
      })
      .catch((err) => console.error(`[whatsapp ${lead.id}] humano:`, err.message));
    require('./alertas').registrar(empresa, 'humano', `O cliente ${lead.nome || lead.telefone || ''} pediu para falar com uma pessoa.`, { nivel: 'aviso', leadId: lead.id });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- anexos recebidos

const TIPO_DA_MENSAGEM = [
  ['imageMessage', 'image'],
  ['audioMessage', 'audio'],
  ['videoMessage', 'video'],
  ['documentMessage', 'document'],
  ['documentWithCaptionMessage', 'document']
];

// Mensagens que chegaram SEM passar pelo webhook (recuperadas depois de uma queda
// do WhatsApp): baixa a foto/PDF do cliente e lê o comprovante, igual à mensagem ao
// vivo. Uma de cada vez, para não sobrecarregar a Evolution.
const filaAnexos = [];
let processandoAnexos = false;
function anexoAtrasado(empresa, lead, msg, mensagem, opcoes = {}) {
  if (!mensagem || mensagem.anexo || mensagem.anexoTentado) return;
  mensagem.anexoTentado = true;
  filaAnexos.push({ empresaId: empresa.id, leadId: lead.id, msg, mensagemId: mensagem.id, opcoes });
  if (!processandoAnexos) processarFilaAnexos();
}
async function processarFilaAnexos() {
  processandoAnexos = true;
  while (filaAnexos.length) {
    const t = filaAnexos.shift();
    const empresa = estado.empresas.find((e) => e.id === t.empresaId);
    const lead = estado.conversas.find((c) => c.id === t.leadId);
    const mensagem = lead?.mensagens.find((m) => m.id === t.mensagemId);
    if (!empresa || !lead || !mensagem || !configurado(empresa)) continue;
    try {
      const r = await baixarAnexo(empresa, lead, t.msg, { entender: false, comprovante: true, soChave: t.opcoes.soChave });
      if (r?.anexo) {
        mensagem.anexo = r.anexo;
        if (r.entendido) mensagem.texto = r.entendido;
        lead.atualizadoEm = lead.atualizadoEm || agora();
        salvar();
        if (r.anexo.vendaId) console.log(`[whatsapp ${lead.id}] comprovante recuperado de mensagem atrasada`);
      }
    } catch (err) {
      console.error(`[whatsapp ${lead.id}] anexo atrasado:`, err.message);
    }
    await new Promise((ok) => setTimeout(ok, 400));
  }
  processandoAnexos = false;
}

// Ao subir: fotos/PDFs de clientes dos últimos 3 dias que entraram sem o arquivo
// (vieram da busca depois de uma queda): baixa e lê os comprovantes que faltaram
function recuperarAnexosRecentes() {
  const limite = Date.now() - 3 * 86400000;
  let n = 0;
  for (const empresa of estado.empresas) {
    if (!configurado(empresa) || empresa.ativa === false) continue;
    for (const lead of estado.conversas) {
      if (lead.empresaId !== empresa.id || !lead.whatsappJid) continue;
      for (const m of lead.mensagens || []) {
        if (m.papel !== 'visitante' || m.anexo || m.anexoTentado || !m.wid || new Date(m.em).getTime() < limite) continue;
        const tipo = /^\[o cliente enviou uma imagem\]/.test(m.texto || '') ? 'imageMessage' : /^\[o cliente enviou um documento\]/.test(m.texto || '') ? 'documentMessage' : '';
        if (!tipo) continue;
        anexoAtrasado(empresa, lead, { key: { id: m.wid, remoteJid: lead.whatsappJid, fromMe: false }, message: { [tipo]: {} } }, m, { soChave: true });
        n++;
      }
    }
  }
  if (n) console.log(`[whatsapp] ${n} foto(s)/PDF(s) de clientes recuperada(s) para ler comprovantes`);
  return n;
}

// Baixa o arquivo da mensagem pela Evolution e guarda no lead. Com `entender`,
// transcreve áudio e descreve foto para a IA responder ao conteúdo.
// A IA vai responder este cliente? (senão não vale gastar tokens entendendo foto/áudio)
function iaVaiResponder(empresa, lead) {
  return Boolean(configDa(empresa).iaAtiva && empresa.ativa !== false && !lead.iaPausada && liberadoNoModoTeste(empresa, lead) && !require('./ia-desligada').motivo(empresa, lead));
}

async function baixarAnexo(empresa, lead, msg, { entender = false, comprovante = entender, soChave = false } = {}) {
  const m = msg.message || {};
  const achado = TIPO_DA_MENSAGEM.find(([campo]) => m[campo]);
  if (!achado) return null;
  const [campo, tipo] = achado;
  const info = campo === 'documentWithCaptionMessage' ? m[campo]?.message?.documentMessage || {} : m[campo];
  const tamanho = Number(info?.fileLength?.low ?? info?.fileLength ?? 0);
  if (tamanho > midias.TAMANHO_MAXIMO) return null;
  // soChave: mensagem antiga (só sabemos o id): a Evolution acha o arquivo no banco dela
  const r = await evolution(empresa, 'POST', '/chat/getBase64FromMediaMessage/{instancia}', {
    message: soChave ? { key: msg.key } : { key: msg.key, message: msg.message },
    convertToMp4: false
  });
  if (!r?.base64) return null;
  const mimetype = r.mimetype || info?.mimetype || '';
  const buffer = Buffer.from(r.base64, 'base64');
  const anexo = midias.salvarAnexo(lead.id, buffer, mimetype, r.fileName || info?.fileName || '');
  anexo.tipo = tipo;
  let entendido = null;
  const legenda = info?.caption ? ` ${info.caption}` : '';
  // Foto lida UMA vez: se a IA vai responder este cliente, a foto é descrita primeiro e a
  // descrição serve para tudo (resposta, sugestão de mídia e decidir se é comprovante).
  // A leitura do comprovante pela IA só acontece se a foto parece pagamento.
  let descricao = null;
  if (entender && tipo === 'image') {
    try {
      descricao = await ia.descreverImagem(botDoWhatsapp(empresa), empresa, r.base64, mimetype);
    } catch (err) {
      console.error(`[whatsapp ${lead.id}] entender image:`, ia.descreverErroIa(err));
    }
  }
  if (comprovante) {
    // comprovante de Pix (foto ou PDF) → venda no Faturamento (lê sem IA primeiro)
    if (tipo === 'image' || /pdf/i.test(mimetype)) {
      // comprovante chega → venda sobe NA HORA: foto que a leitura simples não entendeu
      // passa pela IA (modelo barato), MESMO se a IA não responde este cliente — a não ser
      // que a descrição já mostre que não é pagamento (ex.: foto do volante)
      const forcarIa = tipo === 'image' && (!descricao || PARECE_PAGAMENTO.test(descricao));
      if (tipo === 'image') anexo.comprovanteRevisto = true; // a varredura de hora em hora não repete a IA nesta foto
      const comp = await comprovantes
        .processarArquivo(empresa, lead, {
          buffer,
          mimetype,
          anexo,
          forcarIa,
          lerComIa: () => ia.lerComprovante(botDoWhatsapp(empresa), empresa, r.base64, mimetype)
        })
        .catch((err) => {
          console.error(`[whatsapp ${lead.id}] comprovante:`, err.message);
          return null;
        });
      if (comp) {
        anexo.vendaId = comp.venda.id;
        anexo.descricao = `Comprovante ${comp.venda.forma} de ${comprovantes.brl(comp.venda.valor)}`;
        return { anexo, entendido: `${comp.texto}${legenda}` };
      }
    }
  }
  if (descricao) {
    anexo.descricao = descricao;
    entendido = `[foto do cliente]: ${descricao}${legenda}`;
  }
  if (entender && tipo === 'audio') {
    try {
      const t = await ia.transcreverAudio(empresa, r.base64, mimetype);
      if (t) {
        anexo.transcricao = t;
        entendido = `[áudio do cliente]: ${t}`;
      }
    } catch (err) {
      console.error(`[whatsapp ${lead.id}] entender audio:`, ia.descreverErroIa(err));
    }
  }
  return { anexo, entendido };
}

// a descrição da foto parece pagamento? (aí vale ler o comprovante com a IA)
const PARECE_PAGAMENTO = /comprovante|pix|transfer[eê]ncia|pagamento|\bpag[oa]\b|recibo|boleto|banco|r\$\s*\d|valor|extrato|nota fiscal|qr ?code|dep[oó]sito/i;

// Arquivo grande mandado pela equipe na conversa: o WhatsApp baixa o ORIGINAL por
// um link temporário (sem base64, sem recomprimir). Vídeo que não toca na conversa
// (não é MP4 ou é grande demais) — ou que o WhatsApp recusar — vai como arquivo.
async function enviarAnexoPorUrl(empresa, destino, leadId, anexo, legenda = '') {
  const url = midias.linkTemporario(leadId, anexo);
  const tempo = Math.min(15 * 60 * 1000, 60000 + Math.ceil((anexo.tamanho || 0) / 1048576) * 3000);
  const corpo = (mediatype) => ({ number: destinoDe(destino), mediatype, mimetype: anexo.mimetype, media: url, fileName: midias.nomeComExtensao(anexo.nome || anexo.arquivo, anexo.mimetype), caption: legenda || '' });
  let tipo = anexo.tipo;
  if (tipo === 'video' && (anexo.mimetype !== 'video/mp4' || anexo.tamanho > require('./video').LIMITE_WHATSAPP)) tipo = 'document';
  let r;
  if (tipo === 'audio') {
    r = await evolution(empresa, 'POST', '/message/sendWhatsAppAudio/{instancia}', { number: destinoDe(destino), audio: url }, { tempo });
  } else {
    try {
      r = await evolution(empresa, 'POST', '/message/sendMedia/{instancia}', corpo(tipo), { tempo });
    } catch (err) {
      if (!['video', 'image'].includes(tipo) || err.semResposta) throw err;
      console.error(`[whatsapp] ${tipo} recusado (${err.message}); enviando como arquivo`);
      r = await evolution(empresa, 'POST', '/message/sendMedia/{instancia}', corpo('document'), { tempo });
      tipo = 'document';
    }
  }
  lembrarEnvio(r); // o id fica direto na mensagem (quem chamou guarda)
  return { r, tipo, wid: r?.key?.id || null };
}

// Arquivo mandado pela equipe no painel (vai em base64, sem precisar de link público)
async function enviarArquivo(empresa, destino, { buffer, mimetype, nome, legenda = '' }) {
  let tipo = midias.tipoDoMime(mimetype);
  // vídeo que não é MP4 (ex.: .mov) ou pesado demais vai como arquivo, senão o WhatsApp recusa
  if (tipo === 'video' && (mimetype !== 'video/mp4' || buffer.length > require('./video').LIMITE_WHATSAPP)) tipo = 'document';
  const base64 = buffer.toString('base64');
  const tempo = tipo === 'image' ? 60000 : 180000;
  const r =
    tipo === 'audio'
      ? await evolution(empresa, 'POST', '/message/sendWhatsAppAudio/{instancia}', { number: destinoDe(destino), audio: base64 }, { tempo })
      : await evolution(
          empresa,
          'POST',
          '/message/sendMedia/{instancia}',
          {
            number: destinoDe(destino),
            mediatype: tipo,
            mimetype,
            media: base64,
            fileName: midias.nomeComExtensao(nome || 'arquivo', mimetype),
            caption: legenda
          },
          { tempo }
        );
  lembrarEnvio(r, destino);
  return { r, tipo };
}

// ---------------------------------------------------------------- resposta da IA

const agendadas = new Map();
function cancelarResposta(leadId) {
  clearTimeout(agendadas.get(leadId));
  agendadas.delete(leadId);
}

// Mensagens do cliente que ainda estão sendo preparadas (foto sendo descrita, áudio
// sendo transcrito…). Enquanto houver alguma, a IA não responde nem envia: senão a
// mensagem seguinte (mais rápida) era respondida antes e a foto gerava outra resposta.
const chegando = new Map(); // leadId → quantas
function marcarChegando(leadId, delta) {
  const n = Math.max(0, (chegando.get(leadId) || 0) + delta);
  if (n) chegando.set(leadId, n);
  else chegando.delete(leadId);
}
const clienteMandando = (leadId) => (chegando.get(leadId) || 0) > 0;

// ---------------------------------------------------------------- modo teste
// Com o modo teste ligado, a IA (e as automações) só falam com os números de
// teste. As mensagens dos outros clientes continuam chegando no CRM normalmente.

function numerosDeTeste(empresa) {
  const c = empresa.whatsappConfig || {};
  if (!c.modoTeste) return null;
  return String(c.numerosTeste || '')
    .split(/[,;\n]+/)
    .map((n) => numeroWhatsapp(n))
    .filter((n) => n.length >= 10);
}

function numeroDoLead(lead) {
  const doJid = /@s\.whatsapp\.net$/.test(lead.whatsappJid || '') ? lead.whatsappJid.split('@')[0] : '';
  return doJid || numeroWhatsapp(lead.telefone);
}

// true = pode falar com este lead
function liberadoNoModoTeste(empresa, lead) {
  const lista = numerosDeTeste(empresa);
  if (!lista) return true;
  const numero = numeroDoLead(lead);
  return Boolean(numero) && lista.some((n) => mesmoNumero(n, numero));
}

// ---------------------------------------------------------------- diagnóstico
// Guarda o que a IA fez (ou por que NÃO respondeu) em cada lead e um histórico
// curto por empresa, para o painel mostrar sem precisar olhar os logs.

const MOTIVO_EMPRESA_PAUSADA = 'A empresa está pausada no CRM.';

function registrarIa(empresa, lead, tipo, motivo) {
  const evento = { em: new Date().toISOString(), tipo, motivo: String(motivo || '').slice(0, 300), leadId: lead?.id || null, cliente: lead?.nome || (lead?.telefone ? `+${lead.telefone}` : '') };
  if (lead) lead.iaStatus = { em: evento.em, tipo, motivo: evento.motivo };
  if (empresa) {
    empresa.whatsappConfig = empresa.whatsappConfig || {};
    empresa.whatsappConfig.eventos = [evento, ...(empresa.whatsappConfig.eventos || [])].slice(0, 40);
  }
  salvar();
  if (tipo === 'erro') {
    console.error(`[whatsapp ${empresa?.id} ${lead?.id}] ${evento.motivo}`);
    require('./alertas').registrar(empresa, /WhatsApp não enviou/.test(evento.motivo) ? 'whatsapp-envio' : 'ia-erro', `${evento.cliente ? `Cliente ${evento.cliente}: ` : ''}${evento.motivo}`, { leadId: lead?.id });
  }
}

function agendarResposta(empresa, lead) {
  if (!configDa(empresa).iaAtiva) return registrarIa(empresa, lead, 'ignorou', 'A IA do WhatsApp está desligada.');
  // já comprou (ou agendou): a IA fica desligada nesta conversa até você ligar à mão
  const desligada = require('./ia-desligada').conferir(empresa, lead);
  if (desligada) return registrarIa(empresa, lead, 'ignorou', desligada.texto);
  if (lead.iaPausada) return registrarIa(empresa, lead, 'ignorou', `IA pausada neste cliente: ${lead.iaPausadaMotivo || 'a equipe assumiu'}.`);
  if (!liberadoNoModoTeste(empresa, lead)) {
    const numero = numeroDoLead(lead);
    return registrarIa(empresa, lead, 'ignorou', numero ? `Modo teste ligado: o número +${numero} não está na lista de teste.` : 'Modo teste ligado e o WhatsApp não mostrou o número deste contato.');
  }
  cancelarResposta(lead.id);
  // fora do horário da IA responder: guarda e responde quando abrir
  const expediente = require('./expediente');
  const foraDoHorario = () => {
    expediente.esperarHorario(lead);
    registrarIa(empresa, lead, 'aguardando', `Fora do horário da IA (${expediente.descreverIa(empresa)}): responde quando abrir.`);
  };
  if (!expediente.iaNoHorario(empresa)) return foraDoHorario();
  delete lead.iaEsperaHorario;
  const disparar = () => {
    // ainda chegando mensagem do cliente (ex.: foto sendo lida): espera mais um pouco
    if (clienteMandando(lead.id)) return agendadas.set(lead.id, setTimeout(disparar, ESPERA_CHEGANDO_MS));
    agendadas.delete(lead.id);
    if (!expediente.iaNoHorario(empresa)) return foraDoHorario(); // fechou enquanto esperava
    responderLead(empresa.id, lead.id).catch((err) => console.error(`[whatsapp ${lead.id}]`, err.message));
  };
  agendadas.set(lead.id, setTimeout(disparar, esperaParaResponder(empresa, lead)));
}
const ESPERA_CHEGANDO_MS = 1500;

// "Não atropelar": se o cliente manda outra mensagem enquanto a IA ainda está
// escrevendo, a resposta antiga é descartada (não sai) e a IA escreve de novo
// lendo tudo o que ele mandou — uma resposta só, mais completa. Ligado por padrão.
const emResposta = new Map(); // leadId → { refazer }
const naoAtropelar = (empresa) => empresa?.whatsappConfig?.naoAtropelar !== false;
// última mensagem do cliente que pede resposta ("ok"/figurinha que a IA ignora não contam)
const ultimaDoCliente = (lead) => [...(lead.mensagens || [])].reverse().find((m) => m.papel === 'visitante' && !m.semResposta) || null;

// opcoes.evento: aviso interno da plataforma (ex.: 'SEM_RESPOSTA') que a IA recebe como
// [SEM_RESPOSTA] no fim da conversa — o cliente nunca vê
async function responderLead(empresaId, leadId, tentativa = 0, opcoes = {}) {
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  if (naoAtropelar(empresa) && emResposta.has(leadId)) {
    emResposta.get(leadId).refazer = true; // a IA já está escrevendo: refaz quando ela terminar
    return;
  }
  const vez = { refazer: false };
  emResposta.set(leadId, vez);
  let refazer = false;
  try {
    refazer = await responderLeadUmaVez(empresaId, leadId, vez, tentativa, opcoes);
  } finally {
    if (emResposta.get(leadId) === vez) emResposta.delete(leadId);
  }
  // o cliente mandou mais coisa enquanto a IA escrevia: responde tudo junto.
  // Se já tem uma resposta agendada (cliente ainda digitando) ou uma mensagem ainda
  // sendo preparada (ela agenda a resposta quando terminar), elas cuidam disso.
  if (refazer && !agendadas.has(leadId) && !clienteMandando(leadId)) return responderLead(empresaId, leadId, tentativa + 1);
}

// ---------------------------------------------------------------- entrega no WhatsApp
// messages.update da Evolution: v2 manda { keyId, remoteJid, fromMe, status: 'DELIVERY_ACK' };
// o formato do Baileys é { key: { id, remoteJid, fromMe }, update: { status: 3 } }.
const STATUS_ENTREGA = { ERROR: 'erro', PENDING: 'enviando', SERVER_ACK: 'servidor', DELIVERY_ACK: 'entregue', READ: 'lida', PLAYED: 'lida', 0: 'erro', 1: 'enviando', 2: 'servidor', 3: 'entregue', 4: 'lida', 5: 'lida' };
// A mensagem que saiu com esse id. A confirmação pode vir com o id escondido (@lid) do cliente
// e a conversa estar só com o número: primeiro procura pelo jid, depois em todas as conversas
// da empresa (só nas mensagens mais recentes de cada uma).
function acharMensagemSaida(empresa, wid, jid = '') {
  const tem = (x) => x.papel !== 'visitante' && (x.wid === wid || x.wids?.includes(wid));
  const procurar = (c) => {
    const msgs = c.mensagens || [];
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 60); i--) if (tem(msgs[i])) return msgs[i];
    return null;
  };
  const daEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
  if (jid) {
    for (const c of daEmpresa) {
      if (c.whatsappJid !== jid && c.lidJid !== jid) continue;
      const m = procurar(c);
      if (m) return { lead: c, m };
    }
  }
  for (const c of daEmpresa) {
    const m = procurar(c);
    if (m) {
      // aprendeu o id escondido desta conversa (ajuda as próximas confirmações)
      if (jid && /@lid$/.test(jid) && !c.lidJid) c.lidJid = jid;
      return { lead: c, m };
    }
  }
  return null;
}

// Mensagem do cliente lida no celular da empresa: as não lidas da conversa ficam só as que
// chegaram depois dela. true se mudou.
function lidaNoCelular(empresa, wid, jid) {
  const daEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id && c.naoLidas > 0);
  const doJid = jid ? daEmpresa.filter((c) => c.whatsappJid === jid || c.lidJid === jid) : [];
  for (const c of [...doJid, ...daEmpresa.filter((x) => !doJid.includes(x))]) {
    const msgs = c.mensagens || [];
    let depois = 0;
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 60); i--) {
      const m = msgs[i];
      if (m.papel !== 'visitante') continue;
      if (m.wid === wid || m.wids?.includes(wid)) {
        if (depois >= c.naoLidas) return false;
        c.naoLidas = depois;
        console.log('[whatsapp] conversa lida no celular: não lidas atualizadas no CRM');
        return true;
      }
      depois++;
    }
  }
  return false;
}

function receberStatusEntrega(empresa, dados) {
  let mudou = false;
  if (!empresa.whatsappConfig.statusEntregaEm) {
    empresa.whatsappConfig.statusEntregaEm = agora(); // a partir daqui as mensagens que saem mostram "aguardando"
    mudou = true;
  }
  for (const d of Array.isArray(dados) ? dados : [dados]) {
    const fromMe = d?.fromMe ?? d?.key?.fromMe;
    const wid = d?.keyId || d?.key?.id;
    const entrega = STATUS_ENTREGA[d?.status ?? d?.update?.status];
    if (fromMe === false) {
      // a empresa leu a mensagem do cliente no celular: lida aqui também
      if (wid && entrega === 'lida' && lidaNoCelular(empresa, wid, d?.remoteJid || d?.key?.remoteJid || '')) mudou = true;
      continue;
    }
    if (!wid || !entrega) continue;
    const achou = acharMensagemSaida(empresa, wid, d?.remoteJid || d?.key?.remoteJid || '');
    const lead = achou?.lead;
    const m = achou?.m;
    if (!m) {
      leads.guardarStatusEntrega(wid, entrega); // a mensagem ainda vai ser salva
      continue;
    }
    if (!leads.subirEntrega(m, entrega)) continue;
    mudou = true;
    if (entrega === 'erro') {
      const oque = m.anexo || m.midiaId ? 'Uma mídia' : 'Uma mensagem';
      require('./alertas').registrar(empresa, 'whatsapp-envio', `${oque} não foi entregue: o WhatsApp devolveu erro no envio. Tente mandar de novo.`, { leadId: lead.id });
    }
  }
  if (mudou) salvar();
}

// Rede de segurança das confirmações: mensagem que saiu e ficou "aguardando" (o aviso do
// WhatsApp se perdeu ou chegou antes de salvar) → pergunta à Evolution o status dela.
const statusDoRegistro = (x) => STATUS_ENTREGA[x?.status] || STATUS_ENTREGA[(Array.isArray(x?.MessageUpdate) ? x.MessageUpdate[x.MessageUpdate.length - 1] : null)?.status] || null;
async function conferirEntregasPendentes(empresa, { max = 25 } = {}) {
  if (!configurado(empresa)) return 0;
  const agoraMs = Date.now();
  const pendentes = [];
  for (const c of estado.conversas) {
    if (c.empresaId !== empresa.id) continue;
    const msgs = c.mensagens || [];
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 30); i--) {
      const m = msgs[i];
      const idade = agoraMs - new Date(m.em).getTime();
      if (m.entrega === 'enviando' && idade > 60 * 1000 && idade < 48 * 3600 * 1000 && (m.wid || m.wids?.length)) pendentes.push(m);
    }
  }
  let mudou = 0;
  for (const m of pendentes.slice(0, max)) {
    const wid = m.wid || m.wids[0];
    try {
      const r = await evolution(empresa, 'POST', '/chat/findMessages/{instancia}', { where: { key: { id: wid } } }, { tempo: 15000 });
      const reg = (r?.messages?.records || (Array.isArray(r) ? r : []))[0];
      const entrega = statusDoRegistro(reg);
      if (entrega && entrega !== 'enviando' && leads.subirEntrega(m, entrega)) mudou++;
    } catch {
      /* tenta de novo no próximo ciclo */
    }
  }
  if (mudou) salvar();
  return mudou;
}
function iniciarConferenciaEntregas() {
  const ciclo = async () => {
    for (const e of estado.empresas) await conferirEntregasPendentes(e).catch(() => {});
  };
  setTimeout(ciclo, 45 * 1000).unref?.();
  setInterval(ciclo, 2 * 60 * 1000).unref?.();
}

// ---------------------------------------------------------------- "lido" no WhatsApp
// Abriu a conversa no painel: as mensagens do cliente ficam como lidas também no WhatsApp
// (tiques azuis para o cliente e sem o número de não lidas no celular).
async function marcarComoLidas(empresa, lead) {
  if (!configurado(empresa) || !lead?.whatsappJid) return 0;
  const limite = Date.now() - 7 * 86400000;
  const pendentes = (lead.mensagens || []).filter((m) => m.papel === 'visitante' && m.wid && !m.lidaNoZap && !m.apagada && new Date(m.em).getTime() > limite).slice(-50);
  if (!pendentes.length) return 0;
  // o mesmo cliente pode ter mensagens no número e no id escondido (LID)
  const jids = [...new Set([lead.whatsappJid, lead.lidJid].filter(Boolean))];
  const readMessages = pendentes.flatMap((m) => jids.map((remoteJid) => ({ remoteJid, fromMe: false, id: m.wid })));
  await evolution(empresa, 'POST', '/chat/markMessageAsRead/{instancia}', { readMessages }, { tempo: 15000 });
  for (const m of pendentes) m.lidaNoZap = true;
  salvar();
  return pendentes.length;
}

// ---------------------------------------------------------------- respostas prontas automáticas (sem IA)
// Resposta rápida com "responder sozinha": quando o cliente pergunta algo que bate com uma
// das frases cadastradas (ex.: "endereço", "onde fica"), o CRM manda a resposta pronta
// (texto + mídia) sem chamar a IA. Só em pergunta curta e clara: se bater com mais de uma
// resposta, se tiver foto/áudio no meio ou se essa resposta já foi nas últimas 24 h, a IA responde.
const normalizarFrase = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function respostaAutomatica(empresa, lead) {
  const lista = (empresa.respostasRapidas || []).filter((r) => r.auto && r.gatilhos && (r.texto || r.midia));
  if (!lista.length) return null;
  const msgs = (lead.mensagens || []).filter((m) => !m.apagada);
  const pendentes = [];
  for (let i = msgs.length - 1; i >= 0 && msgs[i].papel === 'visitante'; i--) pendentes.unshift(msgs[i]);
  if (!pendentes.length || pendentes.some((m) => m.anexo || /^\[(o cliente enviou|foto do cliente|áudio do cliente)/i.test(m.texto || ''))) return null;
  const texto = normalizarFrase(pendentes.map((m) => m.texto).join(' '));
  if (!texto || texto.length > 120) return null; // mensagem longa: tem mais coisa — a IA responde
  const batem = lista.filter((r) =>
    String(r.gatilhos)
      .split(/[,;\n]+/)
      .map(normalizarFrase)
      .filter((g) => g.length >= 3)
      .some((g) => ` ${texto} `.includes(` ${g} `))
  );
  if (batem.length !== 1) return null;
  const r = batem[0];
  const ultimaVez = lead.respostasAuto?.[r.id];
  if (ultimaVez && Date.now() - new Date(ultimaVez).getTime() < 24 * 3600 * 1000) return null;
  return r;
}

async function enviarRespostaAutomatica(empresa, lead, r, vez, tentativa, ultimaAntes) {
  const logs = require('./log-respostas');
  const log = { origem: 'resposta-pronta', codigos: [], midias: [], avisos: [`Respondido com a resposta pronta /${r.atalho}, sem IA.`], erros: [] };
  const texto = r.texto ? require('./disparos').montarMensagem(r.texto, lead, empresa) : '';
  if (texto) {
    const espera = tempoDigitando(texto, empresa);
    evolution(empresa, 'POST', '/chat/sendPresence/{instancia}', { number: destinoDe(lead.whatsappJid), presence: 'composing', delay: espera }, { tempo: espera + 10000 }).catch(() => {});
    await new Promise((ok) => setTimeout(ok, espera));
    if (lead.iaPausada) return registrarIa(empresa, lead, 'ignorou', 'A equipe assumiu antes da resposta pronta sair.');
    if (naoAtropelar(empresa) && tentativa < 3 && (vez.refazer || clienteMandando(lead.id) || ultimaDoCliente(lead) !== ultimaAntes)) return true;
    try {
      await enviarTexto(empresa, lead.whatsappJid, texto, { digitando: false });
      log.textoEnviado = texto;
    } catch (err) {
      logs.registrar(empresa, lead, { ...log, situacao: 'erro', erros: [`O WhatsApp não enviou a resposta pronta: ${err.message}`] });
      return registrarIa(empresa, lead, 'erro', `A resposta pronta não saiu: ${err.message}`);
    }
    leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto, respostaAuto: r.atalho });
  }
  if (r.midia) {
    try {
      log.midias = (await enviarMidiasPedidas(empresa, lead, [r.midia], 'equipe', { papelMensagem: 'assistente' })).itens;
    } catch (err) {
      log.erros.push(`Falha ao enviar a mídia: ${err.message}`);
    }
  }
  lead.respostasAuto = { ...(lead.respostasAuto || {}), [r.id]: agora() };
  logs.registrar(empresa, lead, { ...log, situacao: 'enviada' });
  registrarIa(empresa, lead, 'respondeu', `Resposta pronta /${r.atalho} (sem gastar IA).`);
  salvar();
  return false;
}

// true = descartou a resposta porque o cliente mandou mensagem nova (precisa refazer)
async function responderLeadUmaVez(empresaId, leadId, vez, tentativa, opcoes = {}) {
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  const lead = estado.conversas.find((c) => c.id === leadId);
  if (!empresa || !lead || lead.iaPausada || !configDa(empresa).iaAtiva) return;
  if (require('./ia-desligada').conferir(empresa, lead)) return; // já comprou/agendou
  if (empresa.ativa === false) return registrarIa(empresa, lead, 'ignorou', MOTIVO_EMPRESA_PAUSADA);
  if (!liberadoNoModoTeste(empresa, lead)) return;
  if (!leads.iaPodeFalarCom(lead)) return; // só responde quem escreveu e está em Conversas
  const bot = botDoWhatsapp(empresa);
  if (!bot) return registrarIa(empresa, lead, 'erro', 'A empresa não tem assistente de IA.');

  const usoHoje = estado.uso[bot.id]?.data === hoje() ? estado.uso[bot.id] : { data: hoje(), mensagens: 0 };
  if (usoHoje.mensagens >= (bot.limiteDiario || 500)) return registrarIa(empresa, lead, 'ignorou', `Limite de ${bot.limiteDiario || 500} respostas por dia atingido.`);
  usoHoje.mensagens += 1;
  estado.uso[bot.id] = usoHoje;

  const ultimaAntes = ultimaDoCliente(lead);
  // pergunta que tem resposta pronta cadastrada ("responder sozinha"): sai sem IA
  const pronta = opcoes.evento ? null : respostaAutomatica(empresa, lead);
  if (pronta) {
    usoHoje.mensagens -= 1; // não gastou IA
    return enviarRespostaAutomatica(empresa, lead, pronta, vez, tentativa, ultimaAntes);
  }
  const eventos = require('./eventos-ia');
  const logs = require('./log-respostas');
  const origemLog = opcoes.evento ? `evento:${opcoes.evento}` : 'resposta';
  // avisos internos: [CLIENTE_ENVIOU_FOTO] nas fotos do cliente e o evento desta vez no fim
  const historico = eventos.historicoParaIa(empresa, leads.historicoParaIa(lead), opcoes.evento);
  let r;
  const horarios = require('./horarios-ia');
  const origemIa = await origem.contextoParaIa(lead, bot, 'whatsapp', empresa).catch(() => '');
  const pedirIa = (avisoAgenda = '') =>
    ia.responder(bot, empresa, historico, {
      horariosIa: [horarios.paraIa(empresa, lead), avisoAgenda].filter(Boolean).join('\n'),
      canal: 'whatsapp',
      tarefa: opcoes.evento ? 'evento' : 'resposta',
      origem: origemIa,
      midiasEnviadas: [...new Set([...Object.keys(lead.midiasEnviadas || {}), ...lead.mensagens.filter((m) => m.midiaCodigo && !m.apagada).map((m) => m.midiaCodigo)])].map((c) => midias.numeroDoCodigo(empresa, c)),
      tickets: require('./tickets').paraIa(lead),
      localizacao: require('./localizacao').paraIa(lead),
      endereco: require('./endereco').enderecoDo(lead),
      clone: require('./clone').paraIa(empresa, lead), // modo clone: respostas reais do dono como modelo
      etapas: leads.etapasDa(empresa),
      etapaAtual: lead.etapa,
      midias: midias.paraIa(empresa),
      links: midias.linksDa(empresa),
      etiquetas: leads.etiquetasDa(empresa)
    });
  try {
    r = await pedirIa();
    // agenda da IA ligada: o horário marcado tem que estar livre na lista (confere antes de enviar)
    // só agenda com o endereço do cliente (regra da aba Agendamentos): sem ele, a IA pede o endereço
    const semEndereco = (x) => x?.agendamento && !(lead.agendamentos || []).some((a) => a.status === 'agendado') && !require('./endereco').podeAgendar(empresa, lead, [x.agendamento.descricao]);
    if (semEndereco(r)) {
      console.log(`[agenda-ia ${lead.id}] a IA marcou sem o endereço do cliente; reescrevendo`);
      r = await pedirIa('- ATENÇÃO: na resposta anterior você marcou [[AGENDAMENTO]], mas o cliente ainda NÃO passou o endereço. Escreva de novo SEM [[AGENDAMENTO]]: confirme o dia/horário que ele quer e peça o endereço completo (rua, número e bairro) para finalizar o agendamento.');
      if (semEndereco(r)) delete r.agendamento;
    }
    const recusa = horarios.validar(empresa, lead, r);
    if (recusa) {
      console.log(`[agenda-ia ${lead.id}] a IA marcou fora da agenda (${recusa}); reescrevendo`);
      r = await pedirIa(`- ATENÇÃO: na resposta anterior ${recusa}. Escreva de novo a resposta ao cliente SEM esse agendamento: ofereça só os horários livres da lista (ou, se não houver, continue o atendimento sem marcar).`);
      const denovo = horarios.validar(empresa, lead, r);
      if (denovo) {
        delete r.agendamento; // não registra: a equipe confere
        require('./alertas').registrar(empresa, 'agenda', `A IA tentou agendar fora dos horários livres (${denovo}). Confira a conversa.`, { nivel: 'aviso', leadId: lead.id });
      }
    }
  } catch (err) {
    logs.registrar(empresa, lead, { origem: origemLog, situacao: 'erro', erros: [`A IA não conseguiu responder: ${ia.descreverErroIa(err)}`] });
    return registrarIa(empresa, lead, 'erro', `A IA não conseguiu responder: ${ia.descreverErroIa(err)}`);
  }
  const log = { origem: origemLog, bruto: r.bruto, codigos: r.codigos, modelo: r.modelo, escalou: r.escalou, midias: [], avisos: [], erros: [] };
  // se a equipe assumiu enquanto a IA pensava, não responde
  if (lead.iaPausada) {
    logs.registrar(empresa, lead, { ...log, situacao: 'descartada', avisos: ['A equipe assumiu enquanto a IA pensava: nada foi enviado.'] });
    return registrarIa(empresa, lead, 'ignorou', 'A equipe assumiu enquanto a IA pensava.');
  }
  // o cliente mandou outra mensagem enquanto a IA escrevia → descarta e refaz com tudo (até 3 vezes)
  if (naoAtropelar(empresa) && tentativa < 3 && (vez.refazer || clienteMandando(lead.id) || ultimaDoCliente(lead) !== ultimaAntes)) {
    logs.registrar(empresa, lead, { ...log, situacao: 'descartada', avisos: ['O cliente mandou outra mensagem enquanto a IA escrevia: esta resposta foi descartada e a IA respondeu tudo junto.'] });
    registrarIa(empresa, lead, 'ignorou', 'O cliente mandou outra mensagem enquanto a IA escrevia: a resposta foi descartada e a IA vai responder tudo junto.');
    return true;
  }
  if (logs.prometeuMidiaSemCodigo(r.texto, r.midias)) {
    // a IA disse que ia mandar e esqueceu o código: se a mídia certa é clara (pelo que ela
    // escreveu + o que o cliente pediu), o CRM manda; senão só avisa no log
    const daIa = new Set(midias.paraIa(empresa).map((m) => m.codigo));
    const certa = midias.conexaoCerta(empresa, `${r.texto} ${ultimaDoCliente(lead)?.texto || ''}`);
    if (certa && daIa.has(certa.codigo) && !jaEnviouMidia(lead, certa.codigo)) {
      r.midias = [...(r.midias || []), certa.codigo];
      log.avisos.push(`A IA disse que ia mandar mídia sem escrever o código: o CRM mandou ${certa.codigoVisivel}, a que combina com a conversa.`);
    } else log.avisos.push('A IA disse que ia mandar foto/vídeo/áudio, mas não escreveu nenhum código de mídia.');
  }

  // envio em partes: cada linha vira uma mensagem e cada #MIDIA_ sai na mesma posição
  const enviou = await enviarRespostaEmPartes(empresa, lead, r, { log, opcoes, vez, tentativa, ultimaAntes });
  if (enviou !== 'ok') return enviou === 'refazer' ? true : undefined;
  if (r.etapa) leads.moverEtapa(lead, empresa, r.etapa, 'ia-whatsapp');
  // venda/agendamento confirmados → aviso na conversa (e venda no Faturamento)
  try {
    require('./tickets').aplicarDaIa(empresa, lead, r);
  } catch (err) {
    console.error(`[whatsapp ${lead.id}] venda/agendamento:`, err.message);
  }
  if (r.local) require('./localizacao').definir(lead, r.local, 'ia'); // o cliente disse onde está
  // a IA combinou de retomar depois → follow-up agendado (com cronômetro no painel)
  if (r.retomar) require('./automacoes').agendarFollowupDaIa(empresa, lead, r.retomar);
  for (const nome of r.etiquetas || []) leads.aplicarEtiqueta(lead, empresa, nome);
  // #PAUSAR: pausa a IA neste contato DEPOIS dos envios (no painel: "Devolver para a IA")
  if (r.humano) {
    lead.iaPausada = true;
    lead.iaPausadaMotivo = 'A IA pausou (#PAUSAR) e chamou uma pessoa da equipe';
    lead.precisaHumano = true;
  }
  logs.registrar(empresa, lead, { ...log, pausou: r.humano, situacao: !r.texto && !log.midias.some((m) => m.status === 'enviada') ? 'nada' : r.humano ? 'pausada' : 'enviada' });
  registrarIa(empresa, lead, 'respondeu', r.humano ? 'Respondeu e chamou a equipe.' : !r.texto && r.nada ? 'Não tinha nada a dizer (#NADA).' : 'Respondeu.');
}

// ---------------------------------------------------------------- envio da resposta em partes
// Cada linha da resposta da IA vira uma mensagem no WhatsApp, na ordem (linhas vazias são
// ignoradas); a linha com #MIDIA_ vira o envio da mídia na mesma posição. Entre os envios o
// cliente vê "digitando…": antes da mídia, depois da mídia e entre textos (tempos da empresa).
const TEMPOS_ENVIO_PADRAO = { antesMidia: 3, depoisMidia: 10, entreTextos: 5 }; // segundos
function temposDeEnvio(empresa) {
  const c = empresa?.whatsappConfig || {};
  const seg = (v, padrao) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? padrao : Math.min(120, Math.max(0, Number(v))));
  return {
    antesMidia: seg(c.esperaAntesMidiaSeg, TEMPOS_ENVIO_PADRAO.antesMidia) * 1000,
    depoisMidia: seg(c.esperaDepoisMidiaSeg, TEMPOS_ENVIO_PADRAO.depoisMidia) * 1000,
    entreTextos: seg(c.esperaEntreTextosSeg, TEMPOS_ENVIO_PADRAO.entreTextos) * 1000
  };
}

// A resposta em partes, na ordem: [{ tipo: 'texto', texto } | { tipo: 'midia', codigo }].
// O texto vem do r.texto (já limpo de códigos e com a abertura variada); a posição das
// mídias vem da resposta original, linha a linha.
function partesDaResposta(r) {
  const textos = String(r.texto || '').split('\n').map((t) => t.trim()).filter(Boolean);
  const partes = [];
  const midiasJa = new Set();
  const addMidia = (codigo) => {
    const k = String(codigo).toUpperCase().replace(/-/g, '_');
    if (midiasJa.has(k)) return;
    midiasJa.add(k);
    partes.push({ tipo: 'midia', codigo });
  };
  let iT = 0;
  for (const linha of String(r.bruto || r.texto || '').split('\n')) {
    if (!linha.trim()) continue;
    const x = ia.extrairAcoes(linha);
    for (const limpo of String(x.texto || '').split('\n').map((t) => t.trim()).filter(Boolean)) {
      // acha a linha correspondente do texto final (a abertura repetida pode ter sido tirada)
      let j = -1;
      for (let k = iT; k < Math.min(textos.length, iT + 2); k++) {
        if (limpo === textos[k] || limpo.includes(textos[k]) || textos[k].includes(limpo)) { j = k; break; }
      }
      if (j === -1) continue;
      while (iT <= j) partes.push({ tipo: 'texto', texto: textos[iT++] });
    }
    for (const m of x.midias) addMidia(m);
  }
  while (iT < textos.length) partes.push({ tipo: 'texto', texto: textos[iT++] }); // o que sobrou, no fim
  for (const m of r.midias || []) addMidia(m); // mídia que o CRM acrescentou (ex.: prometeu e esqueceu o código)
  return partes;
}

function digitandoPor(empresa, lead, ms) {
  if (ms <= 0) return Promise.resolve();
  evolution(empresa, 'POST', '/chat/sendPresence/{instancia}', { number: destinoDe(lead.whatsappJid), presence: 'composing', delay: ms }, { tempo: ms + 10000 }).catch(() => {});
  return new Promise((ok) => setTimeout(ok, ms));
}

// Envia as partes. Devolve 'ok', 'refazer' (o cliente escreveu antes do 1º envio) ou 'parou'.
async function enviarRespostaEmPartes(empresa, lead, r, { log, opcoes = {}, vez = {}, tentativa = 0, ultimaAntes } = {}) {
  const logs = require('./log-respostas');
  const partes = partesDaResposta(r);
  const tempos = temposDeEnvio(empresa);
  const textos = [];
  log.midias = [];
  log.envios = [];
  let anterior = null;
  for (const [i, p] of partes.entries()) {
    // mídia que não vai sair (não existe ou já foi para este cliente): sem espera
    const vaiPular = p.tipo === 'midia' && (() => {
      const pedido = midias.resolverPedido(empresa, p.codigo);
      return !pedido.alvo || (!opcoes.evento && pedido.itens.every((m) => m.umaVezPorConversa !== false && jaEnviouMidia(lead, m.codigo)));
    })();
    if (i === 0) {
      // 1º envio: "digitando…" e, se o cliente escrever nesse meio tempo, a IA responde tudo junto
      await digitandoPor(empresa, lead, p.tipo === 'texto' ? tempoDigitando(p.texto, empresa) : vaiPular ? 0 : tempos.antesMidia);
      if (lead.iaPausada) {
        logs.registrar(empresa, lead, { ...log, situacao: 'descartada', avisos: [...log.avisos, 'A equipe assumiu enquanto a IA digitava: nada foi enviado.'] });
        registrarIa(empresa, lead, 'ignorou', 'A equipe assumiu enquanto a IA digitava.');
        return 'parou';
      }
      if (naoAtropelar(empresa) && tentativa < 3 && (vez.refazer || clienteMandando(lead.id) || ultimaDoCliente(lead) !== ultimaAntes)) {
        logs.registrar(empresa, lead, { ...log, situacao: 'descartada', avisos: [...log.avisos, 'O cliente mandou outra mensagem enquanto a IA digitava: esta resposta foi descartada e a IA respondeu tudo junto.'] });
        registrarIa(empresa, lead, 'ignorou', 'O cliente mandou outra mensagem enquanto a IA digitava: a IA vai responder tudo junto.');
        return 'refazer';
      }
    } else {
      const espera = p.tipo === 'midia' ? (vaiPular ? 0 : tempos.antesMidia) : anterior === 'midia' ? tempos.depoisMidia : tempos.entreTextos;
      await digitandoPor(empresa, lead, espera);
      if (lead.iaPausada) {
        log.avisos.push('A equipe assumiu no meio do envio: o resto da resposta não foi enviado.');
        break;
      }
    }
    if (p.tipo === 'texto') {
      try {
        const env = await enviarTexto(empresa, lead.whatsappJid, p.texto, { digitando: false });
        if (!log.evolutionTexto) log.evolutionTexto = { endpoint: 'sendText', id: env?.key?.id || null, status: env?.status || null };
        log.envios.push({ tipo: 'texto', em: agora(), id: env?.key?.id || null });
      } catch (err) {
        if (!textos.length && !log.midias.length) {
          logs.registrar(empresa, lead, { ...log, situacao: 'erro', erros: [`O WhatsApp não enviou o texto: ${err.message}`] });
          registrarIa(empresa, lead, 'erro', `A IA escreveu a resposta, mas o WhatsApp não enviou: ${err.message}`);
          return 'parou';
        }
        log.erros.push(`O WhatsApp não enviou uma parte do texto: ${err.message}`);
        break;
      }
      textos.push(p.texto);
      leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: p.texto, ...(opcoes.evento ? { eventoIa: opcoes.evento } : {}) });
      anterior = 'texto';
    } else {
      let itens = [];
      try {
        const res = await enviarMidiasPedidas(empresa, lead, [p.codigo]);
        itens = res.itens;
        for (const t of res.trocas || []) log.avisos.push(`A IA escreveu o código ${t.pedido}, que não existe: o CRM mandou ${t.enviado}, a mídia que combina.`);
        for (const t of res.revezados || []) log.avisos.push(`🔁 Revezamento: a IA pediu ${t.pedido} e foi ${t.enviado} (a vez deste cliente).`);
      } catch (err) {
        log.erros.push(`Falha ao enviar a mídia ${p.codigo}: ${err.message}`);
      }
      log.midias.push(...itens);
      if (itens.some((x) => x.status === 'enviada')) {
        log.envios.push({ tipo: 'midia', codigo: p.codigo, em: agora() });
        anterior = 'midia';
      }
    }
  }
  if (textos.length) {
    const todo = textos.join('\n');
    log.textoEnviado = todo;
    if (!r.agendamento) require('./tickets').agendamentoDaMensagem(empresa, lead, todo, 'ia');
    if (!r.agendamento && !r.desmarcar) require('./detector-agenda').observar(empresa, lead);
  }
  return 'ok';
}

// ---------------------------------------------------------------- respostas rápidas com mídia

function respostaPorAtalho(empresa, texto) {
  if (empresa.atalhosNoCelular === false) return null;
  const m = String(texto || '').trim().match(/^\/([\w\u00C0-\u017F-]{1,30})$/);
  if (!m) return null;
  const alvo = m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return (empresa.respostasRapidas || []).find((r) => r.atalho.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === alvo) || null;
}

// Manda uma resposta pronta (texto + mídia/álbum) para o lead
async function enviarRespostaRapida(empresa, lead, resposta) {
  const destino = lead.whatsappJid || destinoDoLead(lead);
  if (resposta.texto) {
    await enviarTexto(empresa, destino, resposta.texto, { digitando: false });
    leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: resposta.texto, respostaRapida: resposta.atalho });
    require('./tickets').agendamentoDaMensagem(empresa, lead, resposta.texto, 'equipe');
    require('./detector-agenda').observar(empresa, lead);
    require('./clone').registrar(empresa, lead, { texto: resposta.texto, midias: resposta.midia ? [midias.resolverPedido(empresa, resposta.midia).alvo?.codigo] : [] });
  }
  if (resposta.midia) await enviarMidiasPedidas(empresa, lead, [resposta.midia], 'equipe');
}

async function usarAtalhoDoCelular(empresa, jid, msg, resposta) {
  // apaga o "/preco" da conversa do cliente (se der) antes de mandar a resposta
  await evolution(empresa, 'DELETE', '/chat/deleteMessageForEveryone/{instancia}', { id: msg.key.id, fromMe: true, remoteJid: jid }).catch(() => {});
  const lead = acharOuCriarLead(empresa, jid, '', { ...msg, pushName: '' });
  await enviarRespostaRapida(empresa, lead, resposta);
  // a equipe está atendendo esse cliente pelo celular
  pausarPorMensagemManual(empresa, lead, 'A equipe respondeu pelo WhatsApp');
  salvar();
}

// [[MIDIA: …]] pedidas pela IA (mídia avulsa ou álbum inteiro)
// papel: quem pediu ('assistente' = IA/automação: só mídia pronta e na etapa certa; 'equipe' = escolhida à mão).
// papelMensagem: como aparece na conversa (ex.: follow-up escolhido à mão, mas enviado pela IA)
// Esta mídia já foi para este contato? (registro novo + mensagens antigas)
function jaEnviouMidia(lead, codigo) {
  if (!codigo) return false;
  return Boolean(lead.midiasEnviadas?.[codigo]) || (lead.mensagens || []).some((m) => m.midiaCodigo === codigo && !m.apagada);
}

function anotarMidiaEnviada(lead, midia) {
  if (!midia.codigo) return;
  lead.midiasEnviadas = lead.midiasEnviadas || {};
  const antes = lead.midiasEnviadas[midia.codigo];
  lead.midiasEnviadas[midia.codigo] = { nome: midia.nome, tipo: midia.tipo, primeiraEm: antes?.primeiraEm || agora(), em: agora(), vezes: (antes?.vezes || 0) + 1 };
}

async function enviarMidiasPedidas(empresa, lead, nomes, papel = 'assistente', { papelMensagem = papel, followup = false } = {}) {
  // itens: o que aconteceu com cada mídia (vai para o log da resposta)
  const resultado = { enviadas: 0, falhas: [], itens: [] };
  const visivel = (c, ref) => (c ? midias.numeroDoCodigo(empresa, c) : String(ref || ''));
  const daIa = papel === 'assistente' && !followup;
  const jaNestaResposta = new Set();
  for (const nome of nomes || []) {
    let pedido = midias.resolverPedido(empresa, nome);
    // a IA escreveu um código que não existe (inventou ou cortou): se as palavras do código
    // apontam com clareza para uma mídia que ela pode mandar, manda essa
    if (!pedido.alvo && papel === 'assistente') {
      const palavras = String(nome).replace(/^#?\s*M[IÍ]DIA[_:\s-]*/i, '').replace(/[_-]+/g, ' ');
      const pode = new Set(midias.paraIa(empresa, { followup }).map((x) => x.codigo));
      const porConexao = midias.conexaoCerta(empresa, palavras);
      const certa = porConexao && pode.has(porConexao.codigo) ? porConexao : midias.midiaPorPalavraRara(empresa, palavras, pode);
      if (certa && pode.has(certa.codigo)) {
        pedido = midias.resolverPedido(empresa, certa.codigo);
        resultado.trocas = [...(resultado.trocas || []), { pedido: String(nome), enviado: certa.codigoVisivel }];
      }
    }
    // revezamento: a IA pediu uma mídia que reveza com outra → vai a da vez deste cliente
    if (papel === 'assistente' && pedido.alvo && pedido.itens.length === 1 && pedido.itens[0] === pedido.alvo && pedido.alvo.revezar) {
      const daVez = midias.escolherRevezando(empresa, pedido.alvo, (m) => jaEnviouMidia(lead, m.codigo));
      if (daVez !== pedido.alvo) {
        resultado.revezados = [...(resultado.revezados || []), { pedido: visivel(pedido.alvo.codigo, nome), enviado: visivel(daVez.codigo) }];
        pedido = midias.resolverPedido(empresa, daVez.codigo);
      }
    }
    const codigoPedido = visivel(pedido.alvo?.codigo, nome);
    if (!pedido.alvo) {
      resultado.itens.push({ codigo: String(nome).startsWith('#') ? String(nome) : `#MIDIA_${String(nome).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, status: 'nao-existe', motivo: 'não existe mídia com esse código nesta empresa' });
      require('./alertas').registrar(empresa, 'midia', `A IA pediu a mídia "${nome}", mas não existe mídia com esse código nesta empresa. Nada foi enviado — confira os códigos em Mídias.`, { nivel: 'aviso', leadId: lead.id });
      continue;
    }
    // a IA só manda mídia ATIVA (pronta); a equipe, o follow-up sem IA e a mídia fixa das
    // automações (escolhidas pelo dono, papel 'equipe') mandam qualquer uma
    // (mídia citada nas instruções do WhatsApp vale mesmo "a configurar": o dono mandou enviar)
    const doPrompt = papel === 'assistente' ? midias.codigosDoPrompt(empresa) : new Set();
    const naoProntas = papel === 'assistente' && !doPrompt.has(pedido.alvo.codigo) ? pedido.itens.filter((m) => !midias.prontaParaIa(m) && !doPrompt.has(m.codigo)) : [];
    const achadas = pedido.itens.filter((m) => !naoProntas.includes(m));
    if (naoProntas.length && !achadas.length) {
      resultado.itens.push({ codigo: codigoPedido, nome: pedido.alvo.nome, status: 'inativa', motivo: 'a mídia está desativada (a configurar)' });
      require('./alertas').registrar(empresa, 'midia', `A IA quis enviar "${codigoPedido}", mas a mídia está desativada. Nada foi enviado — ative em Mídias.`, { nivel: 'aviso', leadId: lead.id });
      continue;
    }
    // mídia "só no follow-up": a IA não manda numa conversa normal
    if (daIa && pedido.alvo?.soFollowup) {
      resultado.itens.push({ codigo: codigoPedido, nome: pedido.alvo.nome, status: 'pulada', motivo: 'é só do follow-up' });
      continue;
    }
    // mídia presa a uma etapa só sai quando o lead está nela (pedido da IA; a equipe manda sempre)
    if (papel === 'assistente' && pedido.etapas?.length && !pedido.etapas.some((e) => leads.acharEtapa(empresa, e) === lead.etapa)) {
      resultado.itens.push({ codigo: codigoPedido, nome: pedido.alvo.nome, status: 'pulada', motivo: `só na etapa ${pedido.etapas.join('/')} (o lead está em ${lead.etapa})` });
      continue;
    }
    if (!achadas.length) {
      resultado.itens.push({ codigo: codigoPedido, nome: pedido.alvo.nome, status: 'nao-existe', motivo: 'álbum/pasta sem arquivos' });
      continue;
    }
    for (const midia of achadas) {
      const codigo = visivel(midia.codigo, midia.nome);
      if (jaNestaResposta.has(midia.id)) continue; // a IA repetiu o código na mesma resposta
      jaNestaResposta.add(midia.id);
      // "enviar uma vez por conversa" (padrão): a IA não repete para o mesmo contato
      if (daIa && midia.umaVezPorConversa !== false && jaEnviouMidia(lead, midia.codigo)) {
        resultado.itens.push({ codigo, nome: midia.nome, tipo: midia.tipo, status: 'ja-enviada', motivo: `já enviada para este contato em ${new Date(lead.midiasEnviadas?.[midia.codigo]?.em || Date.now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` });
        continue;
      }
      try {
        const r = await enviarMidia(empresa, lead.whatsappJid || whatsappDestino(lead), midia, midia.tipo === 'audio' ? '' : midia.legenda || '');
        leads.adicionarMensagem(lead, { papel: papelMensagem, canal: 'whatsapp', texto: `[enviou a mídia: ${midia.codigo ? `${codigo} — ` : ''}${midia.nome}]`, midiaId: midia.id, midiaCodigo: midia.codigo || '' });
        anotarMidiaEnviada(lead, midia);
        resultado.enviadas++;
        resultado.itens.push({ codigo, nome: midia.nome, tipo: midia.tipo, status: 'enviada', endpoint: midia.tipo === 'audio' ? 'sendWhatsAppAudio' : `sendMedia (${midia.tipo === 'video' && !videoTocaNoWhatsapp(midia) ? 'document' : midia.tipo})`, evolution: { id: r?.key?.id || null, status: r?.status || null } });
      } catch (err) {
        console.error(`[whatsapp ${lead.id}] mídia ${midia.nome}:`, err.message);
        resultado.falhas.push(`${codigo}: ${err.message}`);
        resultado.itens.push({ codigo, nome: midia.nome, tipo: midia.tipo, status: 'erro', motivo: err.message });
        if (err.status !== 409) require('./alertas').registrar(empresa, 'midia', `A mídia "${codigo}" não foi enviada: ${err.message}`, { leadId: lead.id });
      }
    }
  }
  return resultado;
}

function whatsappDestino(lead) {
  return destinoDoLead(lead);
}

// ---------------------------------------------------------------- apagar mensagens
// O WhatsApp só deixa "apagar para todos" mensagens que SAÍRAM da empresa e até
// cerca de 2 dias depois do envio. Mensagem do cliente só dá para apagar do CRM.
const LIMITE_APAGAR_PARA_TODOS_MS = 48 * 3600 * 1000;

function podeApagarParaTodos(m) {
  return Boolean(m.canal === 'whatsapp' && m.papel !== 'visitante' && (m.wid || m.wids?.length) && !m.apagada && Date.now() - new Date(m.em).getTime() < LIMITE_APAGAR_PARA_TODOS_MS);
}

// Some o conteúdo (texto e arquivo), fica o aviso "mensagem apagada" como no WhatsApp
function apagarArquivoDoAnexo(lead, m) {
  const caminho = m.anexo?.arquivo && midias.caminhoAnexo(lead.id, m.anexo.arquivo);
  if (caminho) fs.rmSync(caminho, { force: true });
}

function marcarApagada(lead, m, por) {
  apagarArquivoDoAnexo(lead, m);
  m.apagada = { por, em: agora() };
  m.texto = '';
  if (m.anexo) m.anexoApagado = { tipo: m.anexo.tipo };
  delete m.anexo;
}

async function apagarMensagem(empresa, lead, msgId, { paraTodos = false } = {}) {
  const i = (lead.mensagens || []).findIndex((m) => m.id === msgId);
  if (i < 0) throw erro('Mensagem não encontrada (atualize a conversa).', 404);
  const m = lead.mensagens[i];
  if (paraTodos) {
    if (!podeApagarParaTodos(m)) {
      throw erro(
        m.papel === 'visitante'
          ? 'Mensagem do cliente só pode ser apagada aqui no CRM (o WhatsApp não deixa apagar do celular dele).'
          : 'O WhatsApp só deixa apagar para todos até ~2 dias depois do envio. Apague só do CRM.',
        400
      );
    }
    const jid = lead.whatsappJid || `${destinoDoLead(lead)}@s.whatsapp.net`;
    for (const wid of m.wids || [m.wid]) {
      await evolution(empresa, 'DELETE', '/chat/deleteMessageForEveryone/{instancia}', { id: wid, fromMe: true, remoteJid: jid });
    }
    marcarApagada(lead, m, 'equipe');
  } else {
    // só do CRM: sai da conversa do painel e do que a IA lê (o cliente continua vendo no celular dele)
    apagarArquivoDoAnexo(lead, m);
    lead.mensagens.splice(i, 1);
  }
  salvar();
  return { ok: true };
}

// Mensagem manual (painel ou celular): por padrão a IA para naquele cliente e a
// equipe assume. Em "IA do WhatsApp" dá para deixar a IA continuar atendendo.
function iaContinuaAposManual(empresa) {
  return empresa?.whatsappConfig?.iaAposManual === true;
}

function pausarPorMensagemManual(empresa, lead, motivo) {
  cancelarResposta(lead.id); // a resposta que a IA ia mandar agora não sai (a pessoa já respondeu)
  if (iaContinuaAposManual(empresa)) return;
  lead.iaPausada = true;
  lead.iaPausadaMotivo = motivo;
}

// Mensagem escrita pela equipe no painel: vai pelo WhatsApp e a IA para no lead
async function enviarPelaEquipe(empresa, lead, texto) {
  const destino = destinoDoLead(lead);
  if (!destino) throw erro('Este lead não tem WhatsApp.', 400);
  await enviarTexto(empresa, destino, texto, { digitando: false });
  leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto });
  require('./tickets').agendamentoDaMensagem(empresa, lead, texto, 'equipe'); // "agendado sábado 9h" → ticket AGENDADO
  require('./detector-agenda').observar(empresa, lead);
  require('./clone').registrar(empresa, lead, { texto }); // modo clone: aprende com a sua resposta
  pausarPorMensagemManual(empresa, lead, 'A equipe respondeu pelo painel');
  salvar();
}

// Checagem completa: por que a IA pode não estar respondendo
async function diagnostico(empresa) {
  const c = configDa(empresa);
  const itens = [];
  const add = (ok, titulo, detalhe = '') => itens.push({ ok, titulo, detalhe });
  add(empresa.ativa !== false, 'Empresa ativa no CRM', empresa.ativa === false ? 'A empresa está PAUSADA: a IA e as automações não respondem ninguém. Clique em "Reativar a empresa".' : '');
  add(/^https:\/\//.test(config.urlPublica), 'Endereço público do CRM', config.urlPublica ? config.urlPublica : 'PUBLIC_URL vazio no .env do servidor: o WhatsApp não consegue mandar as mensagens para o CRM.');
  add(configurado(empresa), 'WhatsApp conectado ao CRM', configurado(empresa) ? `sessão ${c.instancia}` : 'Conecte o WhatsApp na tela IA do WhatsApp.');
  if (configurado(empresa)) {
    try {
      const s = await situacao(empresa);
      add(s.conectado, 'Celular conectado', s.conectado ? `${s.nome || ''} ${s.numero ? `+${s.numero}` : ''}`.trim() : `Estado: ${s.estado || 'desconhecido'} — gere o QR code de novo.`);
    } catch (err) {
      add(false, 'Celular conectado', err.message);
    }
    try {
      const atual = await webhookAtual(empresa);
      add(ehNossoWebhook(empresa, atual), 'Mensagens chegando no CRM (webhook)', ehNossoWebhook(empresa, atual) ? 'o WhatsApp manda as mensagens para o CRM' : atual ? `o webhook aponta para outro sistema: ${atual}` : 'o webhook está desligado — clique em "Consertar".');
    } catch (err) {
      add(false, 'Mensagens chegando no CRM (webhook)', err.message);
    }
  }
  const ultimo = empresa.whatsappConfig?.ultimoWebhookEm;
  add(Boolean(ultimo), 'Última mensagem recebida pelo CRM', ultimo ? new Date(ultimo).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'nenhuma ainda — mande um "oi" de outro número para o WhatsApp da empresa.');
  add(c.iaAtiva, 'IA do WhatsApp ligada', c.iaAtiva ? '' : 'Ligue na tela IA do WhatsApp.');
  const bot = botDoWhatsapp(empresa);
  if (bot) {
    const motores = ia.motoresDa(empresa, bot);
    if (!motores.length) add(false, 'IA com chave', 'Nenhuma IA tem chave. Cadastre em IAs e chaves.');
    // testa cada IA da ordem com um pedido bem curto (pega chave errada, modelo sem acesso e falta de crédito)
    for (const [i, m] of motores.entries()) {
      try {
        await ia.testarMotor(empresa, m);
        add(true, `${i + 1}ª IA ${i ? '(reserva)' : '(principal)'} funcionando`, `${ia.PROVEDORES[m.provedor].nome} · ${m.modelo}`);
      } catch (err) {
        add(false, `${i + 1}ª IA ${i ? '(reserva)' : '(principal)'} funcionando`, `${ia.PROVEDORES[m.provedor].nome} · ${m.modelo}: ${ia.descreverErroIa(err)}`);
      }
    }
    if (motores.length === 1) add(true, 'IA reserva', 'nenhuma — cadastre uma 2ª IA em IAs e chaves para nunca ficar sem resposta');
  } else add(false, 'Assistente de IA', 'A empresa não tem assistente.');
  const teste = numerosDeTeste(empresa);
  add(!teste, 'Modo teste', teste ? `ligado — a IA só responde: ${teste.map((n) => `+${n}`).join(', ')}` : 'desligado (a IA responde todos)');
  const pausados = estado.conversas.filter((l) => l.empresaId === empresa.id && l.iaPausada && l.whatsappJid);
  add(true, 'Conversas com a IA pausada', pausados.length ? `${pausados.length} (a equipe respondeu ou a IA chamou alguém) — nelas a IA não responde até você devolver` : 'nenhuma');
  return { itens, eventos: empresa.whatsappConfig?.eventos || [] };
}

module.exports = {
  conferirEntregasPendentes,
  iniciarConferenciaEntregas,
  temposDeEnvio,
  partesDaResposta,
  iaVaiResponder,
  marcarComoLidas,
  respostaAutomatica,
  anexoAtrasado,
  recuperarAnexosRecentes,
  diagnostico,
  evolutionUrlGlobal,
  garantirSyncFullHistory,
  garantirSemLeituraAutomatica,
  reiniciarSocket,
  MOTIVOS_DESCONEXAO,
  numerosDeTeste,
  evolucao: evolution,
  textoDa,
  acharOuCriarLead,
  enviarRespostaRapida,
  respostaPorAtalho,
  enviarArquivo,
  enviarMidiasPedidas,
  botDoWhatsapp,
  chaveGlobal,
  testarChaveGlobal,
  podeCriarInstancia,
  criarInstancia,
  codigoPareamento,
  sairDoNumero,
  configDa,
  configurado,
  evolution,
  foiEnviadoPeloCrm,
  iaOcupadaCom,
  liberadoNoModoTeste,
  jaEnviouMidia,
  urlWebhook,
  garantirSegredo,
  situacao,
  conectar,
  desconectar,
  qrCode,
  configurarWebhook,
  receberWebhook,
  enviarTexto,
  enviarMidia,
  destinoDoLead,
  enviarPelaEquipe,
  enviarAnexoPorUrl,
  pausarPorMensagemManual,
  iaContinuaAposManual,
  apagarMensagem,
  podeApagarParaTodos,
  agendarResposta,
  VELOCIDADES,
  revisarWebhook,
  arquivarNoWhatsapp,
  MOTIVO_EMPRESA_PAUSADA,
  cancelarResposta,
  responderLead
};
