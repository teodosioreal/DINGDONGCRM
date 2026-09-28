// whatsapp.js — IA que responde no WhatsApp da empresa (via Evolution API).
//
// Fluxo:
//  1. A Evolution API manda cada mensagem recebida para o webhook do CRM.
//  2. O CRM acha o lead: pelo código "#ABC123" que o chat do site colocou na
//     mensagem (continua o atendimento do site) ou pelo número; senão, cria.
//  3. Espera o cliente parar de digitar (várias mensagens seguidas viram uma
//     resposta só) e a IA responde com todo o histórico (site + WhatsApp),
//     seguindo as instruções do WhatsApp. Ela pode mandar mídias, mudar a
//     etapa do lead e chamar uma pessoa da equipe.
//  4. Se alguém da equipe responder pelo celular, a IA para naquele lead.

const crypto = require('crypto');
const config = require('./config');
const { estado, salvar } = require('./db');
const { hoje } = require('./util');
const ia = require('./ia');
const leads = require('./leads');
const midias = require('./midias');

// ---------------------------------------------------------------- configuração

function configDa(empresa) {
  const c = empresa.whatsappConfig || {};
  return {
    evolutionUrl: (c.evolutionUrl || config.evolutionUrlPadrao || '').replace(/\/+$/, ''),
    instancia: c.instancia || '',
    apiKey: c.apiKey || '',
    iaAtiva: c.iaAtiva !== false,
    segredo: c.segredo || ''
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

async function evolution(empresa, metodo, caminho, corpo) {
  const c = configDa(empresa);
  if (!c.evolutionUrl || !c.instancia || !c.apiKey) {
    throw Object.assign(new Error('WhatsApp não configurado (endereço da Evolution, instância e API key).'), { status: 400 });
  }
  let res;
  try {
    res = await fetch(`${c.evolutionUrl}${caminho.replace('{instancia}', encodeURIComponent(c.instancia))}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', apikey: c.apiKey },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    throw Object.assign(new Error(`Não consegui falar com a Evolution API: ${err.message}`), { status: 502 });
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detalhe = dados?.response?.message || dados?.message || dados?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Evolution API: ${Array.isArray(detalhe) ? detalhe.join('; ') : detalhe}`), { status: res.status });
  }
  return dados;
}

// Para onde responder: número puro se for um contato comum; senão o JID inteiro
function destinoDe(jid) {
  return /@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0] : jid;
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

async function enviarTexto(empresa, jid, texto) {
  const r = await evolution(empresa, 'POST', '/message/sendText/{instancia}', { number: destinoDe(jid), text: texto });
  lembrarEnvio(r);
  return r;
}

async function enviarMidia(empresa, jid, midia) {
  const url = midias.urlPublica(midia);
  const r =
    midia.tipo === 'audio'
      ? await evolution(empresa, 'POST', '/message/sendWhatsAppAudio/{instancia}', { number: destinoDe(jid), audio: url })
      : await evolution(empresa, 'POST', '/message/sendMedia/{instancia}', {
          number: destinoDe(jid),
          mediatype: midia.tipo,
          mimetype: midia.mimetype,
          media: url,
          fileName: midia.arquivo,
          caption: ''
        });
  lembrarEnvio(r);
  return r;
}

async function estadoConexao(empresa) {
  const r = await evolution(empresa, 'GET', '/instance/connectionState/{instancia}');
  return r?.instance?.state || r?.state || 'desconhecido';
}

async function qrCode(empresa) {
  const r = await evolution(empresa, 'GET', '/instance/connect/{instancia}');
  return { base64: r?.base64 || r?.qrcode?.base64 || null, codigo: r?.pairingCode || r?.code || null };
}

// Aponta o webhook da instância para o CRM (só o evento de mensagens)
async function configurarWebhook(empresa) {
  const url = urlWebhook(empresa);
  try {
    await evolution(empresa, 'POST', '/webhook/set/{instancia}', {
      webhook: { enabled: true, url, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] }
    });
  } catch (err) {
    if (err.status !== 400) throw err;
    // versões mais antigas da Evolution usam o formato "achatado"
    await evolution(empresa, 'POST', '/webhook/set/{instancia}', {
      enabled: true,
      url,
      webhook_by_events: false,
      webhook_base64: false,
      events: ['MESSAGES_UPSERT']
    });
  }
  return url;
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
  const existente = doEmpresa.filter((c) => c.whatsappJid === jid).sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1))[0];
  if (existente) {
    if (msg.pushName && !existente.nome) existente.nome = msg.pushName;
    return existente;
  }
  // 3) novo lead que chegou direto pelo WhatsApp
  const bot = botDoWhatsapp(empresa);
  return leads.criarLead({ empresa, bot, canal: 'whatsapp', nome: msg.pushName || '', telefone: telefoneDe(msg), whatsappJid: jid });
}

function botDoWhatsapp(empresa) {
  const ativos = estado.bots.filter((b) => b.empresaId === empresa.id && b.ativo !== false);
  return ativos.find((b) => b.principal) || ativos[0] || null;
}

// Evolution manda { event, instance, data } — data pode ser uma mensagem ou lista
function mensagensDoWebhook(corpo) {
  const evento = String(corpo?.event || '').toLowerCase().replace(/_/g, '.');
  if (evento && evento !== 'messages.upsert') return [];
  const d = corpo?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.messages)) return d.messages;
  return d ? [d] : [];
}

async function receberWebhook(empresa, corpo) {
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
      midias: midias.midiasDa(empresa)
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
  if (r.humano) {
    lead.iaPausada = true;
    lead.iaPausadaMotivo = 'A IA chamou uma pessoa da equipe';
    lead.precisaHumano = true;
  }
  salvar();
}

// Mensagem escrita pela equipe no painel: vai pelo WhatsApp e a IA para no lead
async function enviarPelaEquipe(empresa, lead, texto) {
  if (!lead.whatsappJid) throw Object.assign(new Error('Este lead ainda não chegou no WhatsApp.'), { status: 400 });
  await enviarTexto(empresa, lead.whatsappJid, texto);
  leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto });
  lead.iaPausada = true;
  lead.iaPausadaMotivo = 'A equipe respondeu pelo painel';
  cancelarResposta(lead.id);
  salvar();
}

module.exports = {
  configDa,
  configurado,
  urlWebhook,
  garantirSegredo,
  estadoConexao,
  qrCode,
  configurarWebhook,
  receberWebhook,
  enviarPelaEquipe,
  agendarResposta,
  cancelarResposta,
  responderLead
};
