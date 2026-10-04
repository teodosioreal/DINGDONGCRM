// eventos-ia.js — avisos internos da plataforma para a IA do WhatsApp.
//
// A IA recebe uma "mensagem" entre colchetes que o cliente nunca vê e responde
// de acordo com a situação:
//   [CLIENTE_ENVIOU_FOTO]  na hora em que o cliente manda uma imagem
//   [SEM_RESPOSTA]         X minutos depois da última mensagem da IA sem o cliente responder
//   [CHECAR_VIDEO]         X minutos depois da IA mandar um vídeo, se o cliente não respondeu
//   [FOLLOWUP_1]           X minutos (ex.: 24 h) depois da última mensagem da IA — 1ª retomada
// Os tempos são por empresa (painel → IA do WhatsApp). Cada evento só dispara se a
// IA não estiver pausada no contato, uma vez por "silêncio" do cliente (quando ele
// responde, conta de novo) e só para conversas depois de o evento ser ligado.
// Os eventos com tempo usam IA (gastam crédito); o Follow-up sem IA continua separado.

const { estado, salvar, agora } = require('./db');

const EVENTOS = {
  fotoCliente: { tag: 'CLIENTE_ENVIOU_FOTO', nome: 'Cliente enviou foto', padrao: { ativo: true }, semTempo: true },
  semResposta: { tag: 'SEM_RESPOSTA', nome: 'Cliente sem responder', padrao: { ativo: false, minutos: 30 } },
  checarVideo: { tag: 'CHECAR_VIDEO', nome: 'Conferir se viu o vídeo', padrao: { ativo: false, minutos: 10 } },
  followup1: { tag: 'FOLLOWUP_1', nome: '1º follow-up (com IA)', padrao: { ativo: false, minutos: 1440 } }
};
const CICLO_MS = Number(process.env.EVENTOS_IA_CICLO_MS) || 60 * 1000;
const MINUTO_MS = Number(process.env.EVENTOS_IA_MINUTO_MS) || 60 * 1000; // (testes encurtam o minuto)
const JANELA_DIAS = 8; // conversa parada há mais que isso não acorda
const MAX_POR_RODADA = 15;

function configDa(empresa) {
  const c = empresa.eventosIa || {};
  const r = {};
  for (const [k, ev] of Object.entries(EVENTOS)) r[k] = { ...ev.padrao, ...(c[k] || {}), tag: ev.tag, nome: ev.nome, semTempo: Boolean(ev.semTempo) };
  return r;
}

function salvarConfig(empresa, corpo = {}) {
  empresa.eventosIa = empresa.eventosIa || {};
  for (const k of Object.keys(EVENTOS)) {
    const b = corpo[k];
    if (!b || typeof b !== 'object') continue;
    const atual = { ...EVENTOS[k].padrao, ...(empresa.eventosIa[k] || {}) };
    if (b.ativo !== undefined) {
      const ligar = b.ativo === true;
      if (ligar && !atual.ativo) atual.ativadoEm = agora(); // só conversas daqui para frente
      atual.ativo = ligar;
    }
    if (b.minutos !== undefined && !EVENTOS[k].semTempo) {
      const n = Math.round(Number(b.minutos));
      if (!Number.isFinite(n) || n < 1 || n > 14 * 24 * 60) throw Object.assign(new Error(`Tempo inválido em "${EVENTOS[k].nome}" (de 1 minuto a 14 dias).`), { status: 400 });
      atual.minutos = n;
    }
    empresa.eventosIa[k] = atual;
  }
  salvar();
  return configDa(empresa);
}

// Histórico que vai para a IA: fotos do cliente marcadas com [CLIENTE_ENVIOU_FOTO]
// e, se for o caso, o evento desta vez no fim (nada disso é gravado na conversa)
const EH_FOTO = /^\[(?:foto do cliente\]|o cliente enviou (?:uma imagem|uma foto))/i;
function historicoParaIa(empresa, historico, evento) {
  const cfg = configDa(empresa);
  let lista = historico;
  if (cfg.fotoCliente.ativo) lista = lista.map((m) => (m.papel === 'visitante' && EH_FOTO.test(m.texto || '') ? { ...m, texto: `[CLIENTE_ENVIOU_FOTO] ${m.texto}` } : m));
  if (evento) lista = [...lista, { papel: 'visitante', canal: 'whatsapp', texto: `[${evento}]`, em: agora(), eventoInterno: true }];
  return lista;
}

const ehVideo = (m) => {
  if (!m?.midiaId) return false;
  return require('./midias').acharPorId(m.midiaId)?.tipo === 'video';
};

// Qual evento (com tempo) está vencido para este lead agora? → { chave, tag, ref } ou null
function eventoVencido(empresa, lead, cfg, agoraMs = Date.now()) {
  const msgs = (lead.mensagens || []).filter((m) => !m.apagada && ['visitante', 'assistente', 'equipe'].includes(m.papel));
  const ultima = msgs[msgs.length - 1];
  if (!ultima || ultima.papel !== 'assistente') return null; // o cliente (ou a equipe) falou por último
  const ultimaDoCliente = [...msgs].reverse().find((m) => m.papel === 'visitante');
  if (!ultimaDoCliente) return null;
  const tUltima = new Date(ultima.em).getTime();
  if (agoraMs - tUltima > JANELA_DIAS * 86400000) return null;
  const feitos = lead.eventosIa || {};
  const ciclo = ultimaDoCliente.id || ultimaDoCliente.em; // um por silêncio do cliente
  const candidatos = [];
  // vídeo: a última coisa que a IA mandou foi um vídeo
  if (cfg.checarVideo.ativo && ehVideo(ultima)) candidatos.push(['checarVideo', ultima.id]);
  if (cfg.semResposta.ativo) candidatos.push(['semResposta', ciclo]);
  if (cfg.followup1.ativo) candidatos.push(['followup1', ciclo]);
  for (const [chave, ref] of candidatos) {
    const c = cfg[chave];
    if (feitos[chave]?.ref === ref) continue; // já disparou neste silêncio
    if (c.ativadoEm && tUltima < new Date(c.ativadoEm).getTime()) continue; // conversa de antes de ligar
    if (agoraMs - tUltima < c.minutos * MINUTO_MS) continue;
    // o follow-up (24 h) não dispara junto com o "sem resposta": espera o tempo dele
    return { chave, tag: c.tag, ref };
  }
  return null;
}

let rodando = false;
async function verificar() {
  if (rodando) return 0;
  rodando = true;
  let n = 0;
  try {
    const whatsapp = require('./whatsapp');
    const leads = require('./leads');
    for (const empresa of estado.empresas) {
      if (empresa.ativa === false || !whatsapp.configurado(empresa) || !whatsapp.configDa(empresa).iaAtiva) continue;
      const cfg = configDa(empresa);
      if (!cfg.semResposta.ativo && !cfg.checarVideo.ativo && !cfg.followup1.ativo) continue;
      const limite = new Date(Date.now() - JANELA_DIAS * 86400000).toISOString();
      for (const lead of estado.conversas) {
        if (n >= MAX_POR_RODADA) break;
        if (lead.empresaId !== empresa.id || !lead.whatsappJid || lead.iaPausada || lead.arquivado || lead.naoDisparar || String(lead.atualizadoEm || '') < limite) continue;
        if (!leads.iaPodeFalarCom(lead) || !whatsapp.liberadoNoModoTeste(empresa, lead) || whatsapp.iaOcupadaCom(lead.id)) continue;
        const ev = eventoVencido(empresa, lead, cfg);
        if (!ev) continue;
        lead.eventosIa = { ...(lead.eventosIa || {}), [ev.chave]: { ref: ev.ref, em: agora() } };
        salvar();
        n++;
        await whatsapp.responderLead(empresa.id, lead.id, 0, { evento: ev.tag }).catch((err) => console.error(`[eventos-ia ${lead.id}] ${ev.tag}:`, err.message));
      }
    }
  } finally {
    rodando = false;
  }
  return n;
}

let timer = null;
function iniciar() {
  if (timer || process.env.EVENTOS_IA === 'nao') return;
  timer = setInterval(() => verificar().catch((err) => console.error('[eventos-ia]', err.message)), CICLO_MS);
  timer.unref?.();
}

module.exports = { EVENTOS, configDa, salvarConfig, historicoParaIa, eventoVencido, verificar, iniciar };
