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
const EVENTOS_WEBHOOK = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CHATS_DELETE'];

// Instâncias ligadas antes desta versão não mandam "conversa apagada":
// se o webhook é do CRM e falta o evento, liga de novo (sem mexer em outros sistemas)
async function revisarWebhook(empresa) {
  const r = await evolution(empresa, 'GET', '/webhook/find/{instancia}');
  const w = r?.webhook || r || {};
  if (!ehNossoWebhook(empresa, w.url) || w.enabled === false) return false;
  const eventos = (w.events || []).map((e) => String(e).toUpperCase());
  if (EVENTOS_WEBHOOK.every((e) => eventos.includes(e))) return false;
  await configurarWebhook(empresa);
  return true;
}

// Arquivar (ou desarquivar) a conversa no WhatsApp do celular também
async function arquivarNoWhatsapp(empresa, lead, arquivar) {
  if (!lead.whatsappJid || !configurado(empresa)) return false;
  await evolution(empresa, 'POST', '/chat/archiveChat/{instancia}', { chat: lead.whatsappJid, archive: arquivar });
  return true;
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
  const r = await evolution(empresa, 'POST', '/message/sendText/{instancia}', {
    number: destinoDe(destino),
    text: texto,
    ...(digitando ? { delay: tempoDigitando(texto, empresa) } : {})
  });
  lembrarEnvio(r);
  return r;
}

// Vídeo pronto para tocar na conversa? (MP4 leve; o resto vai como arquivo para não falhar)
function videoTocaNoWhatsapp(midia) {
  return midia.mimetype === 'video/mp4' && midia.tamanho <= require('./video').LIMITE_WHATSAPP && midia.videoOk !== false;
}

async function enviarMidia(empresa, destino, midia, legenda = '') {
  if (midia.processando) throw erro(`O vídeo "${midia.codigo || midia.nome}" ainda está sendo convertido para o WhatsApp. Tente de novo em instantes.`, 409);
  const url = midias.urlPublica(midia);
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
        fileName: midia.arquivo,
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
  // 1b) código de um clique no botão do WhatsApp do site (sem chat): o lead
  // nasce já com a origem do cliente (anúncio, página que ele via…)
  const visita = codigo && origem.tirarVisita(empresa.id, codigo);
  // 2) mesmo número → mesmo lead (o mais recente)
  const existente = leadDoNumero(empresa, jid);
  if (existente) {
    existente.whatsappJid = jid;
    if (msg.pushName && !existente.nome) existente.nome = msg.pushName;
    if (visita) origem.registrarNoLead(existente, visita.rastro);
    return existente;
  }
  // 3) novo lead que chegou direto pelo WhatsApp
  const bot = botDoWhatsapp(empresa);
  const novo = leads.criarLead({ empresa, bot, canal: 'whatsapp', nome: msg.pushName || '', telefone: telefoneDe(msg), whatsappJid: jid });
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
  // mudança de conexão: guarda para o painel mostrar
  if (eventoDe(corpo) === 'connection.update') {
    const st = corpo?.data?.state || corpo?.data?.status;
    if (st && empresa.whatsappConfig) {
      empresa.whatsappConfig.perfil = { ...(empresa.whatsappConfig.perfil || {}), estado: st, conferidoEm: agora() };
      salvar();
    }
    return;
  }
  // conversa apagada no WhatsApp do celular: sai da lista do CRM (vai para "Arquivadas")
  if (eventoDe(corpo) === 'chats.delete') {
    const jids = (Array.isArray(corpo?.data) ? corpo.data : [corpo?.data]).map((x) => (typeof x === 'string' ? x : x?.remoteJid || x?.id)).filter(Boolean);
    for (const lead of estado.conversas.filter((c) => c.empresaId === empresa.id && jids.includes(c.whatsappJid))) {
      lead.arquivado = true;
      lead.arquivadoPor = 'apagada no WhatsApp';
      lead.arquivadoEm = agora();
    }
    salvar();
    return;
  }
  for (const msg of mensagensDoWebhook(corpo)) {
    const jid = msg?.key?.remoteJid || '';
    if (!jid || /@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue; // grupos, status, canais
    if (jaProcessada(msg.key.id)) continue;
    let texto = textoDa(msg);
    if (!texto) continue;

    if (msg.key.fromMe) {
      // enviada pelo próprio CRM (eco) → ignora; enviada pela equipe no celular → IA para
      if (enviadosPeloCrm.has(msg.key.id)) continue;
      // atalho digitado no celular (ex.: /preco) → o CRM manda a resposta pronta com a mídia
      const atalho = respostaPorAtalho(empresa, texto);
      if (atalho) {
        await usarAtalhoDoCelular(empresa, jid, msg, atalho).catch((err) => console.error(`[whatsapp atalho ${jid}]`, err.message));
        continue;
      }
      const lead = estado.conversas.find((c) => c.empresaId === empresa.id && c.whatsappJid === jid);
      if (!lead) continue;
      const anexo = await baixarAnexo(empresa, lead, msg).catch(() => null);
      const NOME_TIPO = { image: 'uma foto', audio: 'um áudio', video: 'um vídeo', document: 'um arquivo' };
      const legenda = texto.replace(/^\[o cliente enviou (um|uma) [^\]]+\]\s*/, '');
      const textoEquipe = anexo ? legenda || `[enviou ${NOME_TIPO[anexo.anexo.tipo] || 'um arquivo'}]` : texto;
      leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: textoEquipe, anexo: anexo?.anexo });
      lead.iaPausada = true;
      lead.iaPausadaMotivo = 'A equipe respondeu pelo WhatsApp';
      cancelarResposta(lead.id);
      salvar();
      continue;
    }

    const lead = acharOuCriarLead(empresa, jid, texto, msg);
    // cliente mandou mensagem de novo: a conversa volta para a lista
    if (lead.arquivado) {
      lead.arquivado = false;
      lead.arquivadoPor = '';
    }
    // veio de um anúncio de clique para WhatsApp (Meta)? guarda qual
    const anuncioMeta = origem.anuncioDoWhatsapp(msg);
    if (anuncioMeta) origem.registrarAnuncioWhatsapp(lead, anuncioMeta);
    // áudio vira texto (Gemini) e foto vira descrição, para a IA entender
    let anexo = null;
    try {
      const r = await baixarAnexo(empresa, lead, msg, { entender: true });
      if (r) {
        anexo = r.anexo;
        if (r.entendido) texto = r.entendido;
      }
    } catch (err) {
      console.error(`[whatsapp ${lead.id}] anexo:`, err.message);
    }
    leads.adicionarMensagem(lead, { papel: 'visitante', canal: 'whatsapp', texto, anexo: anexo || undefined });
    origem.aplicarAnuncio(empresa, lead);
    require('./automacoes').cancelarFollowupsDaIa(lead); // respondeu antes do follow-up
    lead.naoLidas = (lead.naoLidas || 0) + 1;
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

// ---------------------------------------------------------------- anexos recebidos

const TIPO_DA_MENSAGEM = [
  ['imageMessage', 'image'],
  ['audioMessage', 'audio'],
  ['videoMessage', 'video'],
  ['documentMessage', 'document'],
  ['documentWithCaptionMessage', 'document']
];

// Baixa o arquivo da mensagem pela Evolution e guarda no lead. Com `entender`,
// transcreve áudio e descreve foto para a IA responder ao conteúdo.
async function baixarAnexo(empresa, lead, msg, { entender = false } = {}) {
  const m = msg.message || {};
  const achado = TIPO_DA_MENSAGEM.find(([campo]) => m[campo]);
  if (!achado) return null;
  const [campo, tipo] = achado;
  const info = campo === 'documentWithCaptionMessage' ? m[campo]?.message?.documentMessage || {} : m[campo];
  const tamanho = Number(info?.fileLength?.low ?? info?.fileLength ?? 0);
  if (tamanho > midias.TAMANHO_MAXIMO) return null;
  const r = await evolution(empresa, 'POST', '/chat/getBase64FromMediaMessage/{instancia}', {
    message: { key: msg.key, message: msg.message },
    convertToMp4: false
  });
  if (!r?.base64) return null;
  const mimetype = r.mimetype || info?.mimetype || '';
  const buffer = Buffer.from(r.base64, 'base64');
  const anexo = midias.salvarAnexo(lead.id, buffer, mimetype, r.fileName || info?.fileName || '');
  anexo.tipo = tipo;
  let entendido = null;
  if (entender) {
    const legenda = info?.caption ? ` ${info.caption}` : '';
    // comprovante de Pix (foto ou PDF) → venda no Faturamento (lê sem IA primeiro)
    if (tipo === 'image' || /pdf/i.test(mimetype)) {
      const comp = await comprovantes
        .processarArquivo(empresa, lead, {
          buffer,
          mimetype,
          anexo,
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
    try {
      if (tipo === 'audio') {
        const t = await ia.transcreverAudio(empresa, r.base64, mimetype);
        if (t) {
          anexo.transcricao = t;
          entendido = `[áudio do cliente]: ${t}`;
        }
      } else if (tipo === 'image') {
        const d = await ia.descreverImagem(botDoWhatsapp(empresa), empresa, r.base64, mimetype);
        if (d) {
          anexo.descricao = d;
          entendido = `[foto do cliente]: ${d}${legenda}`;
        }
      }
    } catch (err) {
      console.error(`[whatsapp ${lead.id}] entender ${tipo}:`, ia.descreverErroIa(err));
    }
  }
  return { anexo, entendido };
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
            fileName: nome || `arquivo${tipo === 'image' ? '.jpg' : ''}`,
            caption: legenda
          },
          { tempo }
        );
  lembrarEnvio(r);
  return { r, tipo };
}

// ---------------------------------------------------------------- resposta da IA

const agendadas = new Map();
function cancelarResposta(leadId) {
  clearTimeout(agendadas.get(leadId));
  agendadas.delete(leadId);
}

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
  if (lead.iaPausada) return registrarIa(empresa, lead, 'ignorou', `IA pausada neste cliente: ${lead.iaPausadaMotivo || 'a equipe assumiu'}.`);
  if (!liberadoNoModoTeste(empresa, lead)) {
    const numero = numeroDoLead(lead);
    return registrarIa(empresa, lead, 'ignorou', numero ? `Modo teste ligado: o número +${numero} não está na lista de teste.` : 'Modo teste ligado e o WhatsApp não mostrou o número deste contato.');
  }
  cancelarResposta(lead.id);
  agendadas.set(
    lead.id,
    setTimeout(() => {
      agendadas.delete(lead.id);
      responderLead(empresa.id, lead.id).catch((err) => console.error(`[whatsapp ${lead.id}]`, err.message));
    }, esperaParaResponder(empresa, lead))
  );
}

async function responderLead(empresaId, leadId) {
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  const lead = estado.conversas.find((c) => c.id === leadId);
  if (!empresa || !lead || lead.iaPausada || !configDa(empresa).iaAtiva) return;
  if (empresa.ativa === false) return registrarIa(empresa, lead, 'ignorou', MOTIVO_EMPRESA_PAUSADA);
  if (!liberadoNoModoTeste(empresa, lead)) return;
  const bot = botDoWhatsapp(empresa);
  if (!bot) return registrarIa(empresa, lead, 'erro', 'A empresa não tem assistente de IA.');

  const usoHoje = estado.uso[bot.id]?.data === hoje() ? estado.uso[bot.id] : { data: hoje(), mensagens: 0 };
  if (usoHoje.mensagens >= (bot.limiteDiario || 500)) return registrarIa(empresa, lead, 'ignorou', `Limite de ${bot.limiteDiario || 500} respostas por dia atingido.`);
  usoHoje.mensagens += 1;
  estado.uso[bot.id] = usoHoje;

  let r;
  try {
    r = await ia.responder(bot, empresa, lead.mensagens, {
      canal: 'whatsapp',
      origem: await origem.contextoParaIa(lead, bot, 'whatsapp', empresa),
      midiasEnviadas: [...new Set(lead.mensagens.filter((m) => m.midiaCodigo).map((m) => m.midiaCodigo))],
      tickets: require('./tickets').paraIa(lead),
      etapas: leads.etapasDa(empresa),
      etapaAtual: lead.etapa,
      midias: midias.paraIa(empresa),
      links: midias.linksDa(empresa),
      etiquetas: leads.etiquetasDa(empresa)
    });
  } catch (err) {
    return registrarIa(empresa, lead, 'erro', `A IA não conseguiu responder: ${ia.descreverErroIa(err)}`);
  }
  // se a equipe assumiu enquanto a IA pensava, não responde
  if (lead.iaPausada) return registrarIa(empresa, lead, 'ignorou', 'A equipe assumiu enquanto a IA pensava.');

  if (r.texto) {
    try {
      await enviarTexto(empresa, lead.whatsappJid, r.texto);
    } catch (err) {
      return registrarIa(empresa, lead, 'erro', `A IA escreveu a resposta, mas o WhatsApp não enviou: ${err.message}`);
    }
    leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: r.texto });
  }
  await enviarMidiasPedidas(empresa, lead, r.midias);
  if (r.etapa) leads.moverEtapa(lead, empresa, r.etapa, 'ia-whatsapp');
  // venda/agendamento confirmados → aviso na conversa (e venda no Faturamento)
  try {
    require('./tickets').aplicarDaIa(empresa, lead, r);
  } catch (err) {
    console.error(`[whatsapp ${lead.id}] venda/agendamento:`, err.message);
  }
  // a IA combinou de retomar depois → follow-up agendado (com cronômetro no painel)
  if (r.retomar) require('./automacoes').agendarFollowupDaIa(empresa, lead, r.retomar);
  for (const nome of r.etiquetas || []) leads.aplicarEtiqueta(lead, empresa, nome);
  if (r.humano) {
    lead.iaPausada = true;
    lead.iaPausadaMotivo = 'A IA chamou uma pessoa da equipe';
    lead.precisaHumano = true;
  }
  registrarIa(empresa, lead, 'respondeu', r.humano ? 'Respondeu e chamou a equipe.' : 'Respondeu.');
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
  }
  if (resposta.midia) await enviarMidiasPedidas(empresa, lead, [resposta.midia], 'equipe');
}

async function usarAtalhoDoCelular(empresa, jid, msg, resposta) {
  // apaga o "/preco" da conversa do cliente (se der) antes de mandar a resposta
  await evolution(empresa, 'DELETE', '/chat/deleteMessageForEveryone/{instancia}', { id: msg.key.id, fromMe: true, remoteJid: jid }).catch(() => {});
  const lead = acharOuCriarLead(empresa, jid, '', { ...msg, pushName: '' });
  await enviarRespostaRapida(empresa, lead, resposta);
  // a equipe está atendendo esse cliente pelo celular
  lead.iaPausada = true;
  lead.iaPausadaMotivo = 'A equipe respondeu pelo WhatsApp';
  cancelarResposta(lead.id);
  salvar();
}

// [[MIDIA: …]] pedidas pela IA (mídia avulsa ou álbum inteiro)
async function enviarMidiasPedidas(empresa, lead, nomes, papel = 'assistente') {
  const resultado = { enviadas: 0, falhas: [] };
  for (const nome of nomes || []) {
    const pedido = midias.resolverPedido(empresa, nome);
    const achadas = pedido.itens;
    // mídia presa a uma etapa só sai quando o lead está nela (pedido da IA; a equipe manda sempre)
    if (papel === 'assistente' && pedido.etapas?.length && !pedido.etapas.some((e) => leads.acharEtapa(empresa, e) === lead.etapa)) {
      console.error(`[whatsapp ${lead.id}] mídia ${nome} é da etapa ${pedido.etapas.join('/')}, o lead está em ${lead.etapa}: não enviei`);
      continue;
    }
    if (!achadas.length) {
      require('./alertas').registrar(empresa, 'midia', `A IA pediu a mídia "${nome}", mas não existe mídia com esse código. Confira os códigos em Mídias.`, { nivel: 'aviso', leadId: lead.id });
    }
    for (const midia of achadas) {
      try {
        await enviarMidia(empresa, lead.whatsappJid || whatsappDestino(lead), midia);
        leads.adicionarMensagem(lead, { papel, canal: 'whatsapp', texto: `[enviou a mídia: ${midia.codigo ? `${midia.codigo} — ` : ''}${midia.nome}]`, midiaId: midia.id, midiaCodigo: midia.codigo || '' });
        resultado.enviadas++;
      } catch (err) {
        console.error(`[whatsapp ${lead.id}] mídia ${midia.nome}:`, err.message);
        resultado.falhas.push(`${midia.codigo || midia.nome}: ${err.message}`);
        if (err.status !== 409) require('./alertas').registrar(empresa, 'midia', `A mídia "${midia.codigo || midia.nome}" não foi enviada: ${err.message}`, { leadId: lead.id });
      }
    }
  }
  return resultado;
}

function whatsappDestino(lead) {
  return destinoDoLead(lead);
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
  diagnostico,
  evolutionUrlGlobal,
  liberadoNoModoTeste,
  numerosDeTeste,
  evolucao: evolution,
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
  VELOCIDADES,
  revisarWebhook,
  arquivarNoWhatsapp,
  MOTIVO_EMPRESA_PAUSADA,
  cancelarResposta,
  responderLead
};
