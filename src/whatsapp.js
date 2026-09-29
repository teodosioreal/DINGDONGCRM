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
const midias = require('./midias');

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
async function chamar(c, metodo, caminho, corpo) {
  if (!c.evolutionUrl) throw erro('O endereço da Evolution API não está configurado (Configurações do sistema).', 400);
  if (!c.instancia || !c.apiKey) throw erro('WhatsApp não conectado: informe a Session ID e a API Key.', 400);
  let res;
  try {
    res = await fetch(`${c.evolutionUrl}${caminho.replace('{instancia}', encodeURIComponent(c.instancia))}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', apikey: c.apiKey },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    throw erro(`Não consegui falar com o servidor do WhatsApp (${err.message}).`, 502);
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

function evolution(empresa, metodo, caminho, corpo) {
  return chamar(configDa(empresa), metodo, caminho, corpo);
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
  const eventos = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];
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
  empresa.whatsappConfig = {
    ...(empresa.whatsappConfig || {}),
    instancia: inst.nome || c.instancia,
    apiKey: c.apiKey,
    iaAtiva: atual.iaAtiva,
    perfil: { numero: inst.numero, nome: inst.perfilNome, foto: inst.foto, estado: inst.estado, conferidoEm: agora() },
    conectadoEm: agora()
  };
  garantirSegredo(empresa);
  salvar();
  await configurarWebhook(empresa, { forcar });
  empresa.whatsappConfig.webhookLigadoEm = agora();
  salvar();
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
  const webhook = { url: urlWebhook(empresa), byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] };
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
function lembrarEnvio(resposta) {
  const id = resposta?.key?.id;
  if (id) enviadosPeloCrm.set(id, Date.now());
  if (enviadosPeloCrm.size > 5000) {
    const corte = Date.now() - 60 * 60 * 1000;
    for (const [k, t] of enviadosPeloCrm) if (t < corte) enviadosPeloCrm.delete(k);
  }
}

// "digitando…" proporcional ao tamanho, como uma pessoa (máx. 5 s)
function tempoDigitando(texto) {
  return Math.min(5000, 800 + String(texto || '').length * 25);
}

async function enviarTexto(empresa, destino, texto, { digitando = true } = {}) {
  const r = await evolution(empresa, 'POST', '/message/sendText/{instancia}', {
    number: destinoDe(destino),
    text: texto,
    ...(digitando ? { delay: tempoDigitando(texto) } : {})
  });
  lembrarEnvio(r);
  return r;
}

async function enviarMidia(empresa, destino, midia, legenda = '') {
  const url = midias.urlPublica(midia);
  const r =
    midia.tipo === 'audio'
      ? await evolution(empresa, 'POST', '/message/sendWhatsAppAudio/{instancia}', { number: destinoDe(destino), audio: url, delay: 1500 })
      : await evolution(empresa, 'POST', '/message/sendMedia/{instancia}', {
          number: destinoDe(destino),
          mediatype: midia.tipo,
          mimetype: midia.mimetype,
          media: url,
          fileName: midia.arquivo,
          caption: legenda || '',
          delay: 1200
        });
  lembrarEnvio(r);
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

function leadDoNumero(empresa, jid) {
  const numero = jid.split('@')[0];
  return estado.conversas
    .filter((c) => c.empresaId === empresa.id && (c.whatsappJid === jid || (!c.whatsappJid && mesmoNumero(c.telefone, numero))))
    .sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1))[0];
}

function acharOuCriarLead(empresa, jid, texto, msg) {
  const doEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
  // 1) código do chat do site na mensagem → continua aquele atendimento
  const codigo = (texto.match(/#([A-Z2-9]{6})\b/) || [])[1];
  if (codigo) {
    const doSite = doEmpresa.find((c) => c.codigo === codigo);
    if (doSite && (!doSite.whatsappJid || doSite.whatsappJid === jid)) {
      doSite.whatsappJid = jid;
      doSite.telefone = doSite.telefone || telefoneDe(msg);
      if (msg.pushName && !doSite.nome) doSite.nome = msg.pushName;
      return doSite;
    }
  }
  // 2) mesmo número → mesmo lead (o mais recente)
  const existente = leadDoNumero(empresa, jid);
  if (existente) {
    existente.whatsappJid = jid;
    if (msg.pushName && !existente.nome) existente.nome = msg.pushName;
    return existente;
  }
  // 3) novo lead que chegou direto pelo WhatsApp
  const bot = botDoWhatsapp(empresa);
  return leads.criarLead({ empresa, bot, canal: 'whatsapp', nome: msg.pushName || '', telefone: telefoneDe(msg), whatsappJid: jid });
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
  // mudança de conexão: guarda para o painel mostrar
  if (eventoDe(corpo) === 'connection.update') {
    const st = corpo?.data?.state || corpo?.data?.status;
    if (st && empresa.whatsappConfig) {
      empresa.whatsappConfig.perfil = { ...(empresa.whatsappConfig.perfil || {}), estado: st, conferidoEm: agora() };
      salvar();
    }
    return;
  }
  for (const msg of mensagensDoWebhook(corpo)) {
    const jid = msg?.key?.remoteJid || '';
    if (!jid || /@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue; // grupos, status, canais
    if (jaProcessada(msg.key.id)) continue;
    const texto = textoDa(msg);
    if (!texto) continue;

    if (msg.key.fromMe) {
      // enviada pelo próprio CRM (eco) → ignora; enviada pela equipe no celular → IA para
      if (enviadosPeloCrm.has(msg.key.id)) continue;
      const lead = estado.conversas.find((c) => c.empresaId === empresa.id && c.whatsappJid === jid);
      if (!lead) continue;
      leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto });
      lead.iaPausada = true;
      lead.iaPausadaMotivo = 'A equipe respondeu pelo WhatsApp';
      cancelarResposta(lead.id);
      salvar();
      continue;
    }

    const lead = acharOuCriarLead(empresa, jid, texto, msg);
    leads.adicionarMensagem(lead, { papel: 'visitante', canal: 'whatsapp', texto });
    leads.aoChegarNoWhatsapp(lead, empresa);

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
      continue;
    }
    salvar();
    agendarResposta(empresa, lead);
  }
}

// ---------------------------------------------------------------- resposta da IA

const agendadas = new Map();
function cancelarResposta(leadId) {
  clearTimeout(agendadas.get(leadId));
  agendadas.delete(leadId);
}

function agendarResposta(empresa, lead) {
  if (!configDa(empresa).iaAtiva || lead.iaPausada) return;
  cancelarResposta(lead.id);
  agendadas.set(
    lead.id,
    setTimeout(() => {
      agendadas.delete(lead.id);
      responderLead(empresa.id, lead.id).catch((err) => console.error(`[whatsapp ${lead.id}]`, err.message));
    }, config.whatsappEsperaMs)
  );
}

async function responderLead(empresaId, leadId) {
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  const lead = estado.conversas.find((c) => c.id === leadId);
  if (!empresa || !lead || lead.iaPausada || !configDa(empresa).iaAtiva || empresa.ativa === false) return;
  const bot = botDoWhatsapp(empresa);
  if (!bot) return;

  const usoHoje = estado.uso[bot.id]?.data === hoje() ? estado.uso[bot.id] : { data: hoje(), mensagens: 0 };
  if (usoHoje.mensagens >= (bot.limiteDiario || 500)) return; // limite do dia: a equipe atende
  usoHoje.mensagens += 1;
  estado.uso[bot.id] = usoHoje;

  let r;
  try {
    r = await ia.responder(bot, empresa, lead.mensagens, {
      canal: 'whatsapp',
      etapas: leads.etapasDa(empresa),
      etapaAtual: lead.etapa,
      midias: midias.midiasDa(empresa),
      etiquetas: leads.etiquetasDa(empresa)
    });
  } catch (err) {
    console.error(`[whatsapp ${lead.id}] IA:`, ia.descreverErroIa(err));
    return;
  }
  // se a equipe assumiu enquanto a IA pensava, não responde
  if (lead.iaPausada) return;

  if (r.texto) {
    await enviarTexto(empresa, lead.whatsappJid, r.texto);
    leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: r.texto });
  }
  for (const nome of r.midias) {
    const midia = midias.acharPorNome(empresa, nome);
    if (!midia) continue;
    try {
      await enviarMidia(empresa, lead.whatsappJid, midia);
      leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: `[enviou a mídia: ${midia.nome}]`, midiaId: midia.id });
    } catch (err) {
      console.error(`[whatsapp ${lead.id}] mídia ${midia.nome}:`, err.message);
    }
  }
  if (r.etapa) leads.moverEtapa(lead, empresa, r.etapa, 'ia-whatsapp');
  for (const nome of r.etiquetas || []) leads.aplicarEtiqueta(lead, empresa, nome);
  if (r.humano) {
    lead.iaPausada = true;
    lead.iaPausadaMotivo = 'A IA chamou uma pessoa da equipe';
    lead.precisaHumano = true;
  }
  salvar();
}

// Mensagem escrita pela equipe no painel: vai pelo WhatsApp e a IA para no lead
async function enviarPelaEquipe(empresa, lead, texto) {
  const destino = destinoDoLead(lead);
  if (!destino) throw erro('Este lead não tem WhatsApp.', 400);
  await enviarTexto(empresa, destino, texto, { digitando: false });
  leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto });
  lead.iaPausada = true;
  lead.iaPausadaMotivo = 'A equipe respondeu pelo painel';
  cancelarResposta(lead.id);
  salvar();
}

module.exports = {
  evolutionUrlGlobal,
  chaveGlobal,
  testarChaveGlobal,
  podeCriarInstancia,
  criarInstancia,
  codigoPareamento,
  sairDoNumero,
  configDa,
  configurado,
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
  agendarResposta,
  cancelarResposta,
  responderLead
};
