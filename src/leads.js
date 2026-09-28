// leads.js — cada atendimento é um lead que passa pelas etapas do funil.
// O mesmo lead junta as mensagens do chat do site e do WhatsApp: quando o
// visitante sai do site para o WhatsApp, a mensagem leva um código
// (#ABC123) que liga as duas conversas, e a IA do WhatsApp continua de onde
// a IA do site parou.

const crypto = require('crypto');
const { estado, salvar, novoId, agora } = require('./db');

const ETAPAS_PADRAO = [
  'Novo',
  'Conversando no site',
  'No WhatsApp',
  'Qualificado',
  'Proposta / agendamento',
  'Fechado',
  'Perdido'
];

const MAX_LEADS_GUARDADOS = 20000;
const MAX_MENSAGENS_POR_LEAD = 400;

function etapasDa(empresa) {
  const lista = (empresa?.etapas || []).map((e) => String(e).trim()).filter(Boolean);
  return lista.length ? lista : ETAPAS_PADRAO.slice();
}

// Acha a etapa pelo nome sem ligar para maiúsculas/acentos (a IA às vezes varia)
function acharEtapa(empresa, nome) {
  const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const alvo = limpar(nome);
  return etapasDa(empresa).find((e) => limpar(e) === alvo) || null;
}

function novoCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const codigo = Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('');
    if (!estado.conversas.some((c) => c.codigo === codigo)) return codigo;
  }
}

function criarLead({ empresa, bot, canal, visitanteId, pagina, nome, telefone, whatsappJid }) {
  const etapas = etapasDa(empresa);
  const lead = {
    id: novoId('cv'),
    empresaId: empresa.id,
    botId: bot?.id || null,
    codigo: novoCodigo(),
    origem: canal,
    etapa:
      canal === 'whatsapp'
        ? acharEtapa(empresa, 'No WhatsApp') || etapas[0]
        : canal === 'manual'
          ? etapas[0]
          : acharEtapa(empresa, 'Conversando no site') || etapas[0],
    etapaHistorico: [],
    nome: nome || '',
    telefone: telefone || '',
    whatsappJid: whatsappJid || '',
    visitanteId: visitanteId || '',
    pagina: pagina || '',
    mensagens: [],
    etiquetas: [],
    iaPausada: false,
    criadoEm: agora(),
    atualizadoEm: agora()
  };
  estado.conversas.push(lead);
  if (estado.conversas.length > MAX_LEADS_GUARDADOS) estado.conversas.splice(0, estado.conversas.length - MAX_LEADS_GUARDADOS);
  salvar();
  return lead;
}

function adicionarMensagem(lead, msg) {
  lead.mensagens.push({ em: agora(), ...msg });
  if (lead.mensagens.length > MAX_MENSAGENS_POR_LEAD) lead.mensagens.splice(0, lead.mensagens.length - MAX_MENSAGENS_POR_LEAD);
  lead.atualizadoEm = agora();
}

// Muda a etapa (se for uma etapa válida da empresa). `por`: 'ia-site', 'ia-whatsapp', 'equipe', 'sistema'.
function moverEtapa(lead, empresa, nomeEtapa, por) {
  const etapa = acharEtapa(empresa, nomeEtapa);
  if (!etapa || etapa === lead.etapa) return false;
  lead.etapaHistorico = lead.etapaHistorico || [];
  lead.etapaHistorico.push({ de: lead.etapa, para: etapa, por, em: agora() });
  lead.etapa = etapa;
  lead.atualizadoEm = agora();
  return true;
}

// Etapas "de entrada": enquanto o lead estiver nelas, chegar no WhatsApp o
// move para "No WhatsApp". Etapas mais avançadas não voltam para trás.
function aoChegarNoWhatsapp(lead, empresa) {
  const etapas = etapasDa(empresa);
  const noZap = acharEtapa(empresa, 'No WhatsApp');
  if (!noZap) return;
  const posAtual = etapas.indexOf(lead.etapa);
  const posZap = etapas.indexOf(noZap);
  if (posAtual === -1 || posAtual < posZap) moverEtapa(lead, empresa, noZap, 'sistema');
}

// ---------------------------------------------------------------- etiquetas
// Cada empresa tem as suas etiquetas (ex.: "Quente", "Orçamento enviado").
// O lead guarda só os ids; a equipe e as IAs podem marcar.

const CORES_ETIQUETA = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

const ETIQUETAS_PADRAO = [
  { nome: 'Quente', cor: '#ef4444' },
  { nome: 'Morno', cor: '#f59e0b' },
  { nome: 'Frio', cor: '#3b82f6' },
  { nome: 'Cliente', cor: '#10b981' }
];

function etiquetasDa(empresa) {
  if (!empresa) return [];
  if (!Array.isArray(empresa.etiquetas)) {
    empresa.etiquetas = ETIQUETAS_PADRAO.map((e) => ({ id: novoId('tag'), ...e }));
    salvar();
  }
  return empresa.etiquetas;
}

function limparNome(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function aplicarEtiqueta(lead, empresa, nome) {
  const alvo = limparNome(nome);
  const etiqueta = etiquetasDa(empresa).find((e) => limparNome(e.nome) === alvo);
  if (!etiqueta) return false;
  lead.etiquetas = lead.etiquetas || [];
  if (lead.etiquetas.includes(etiqueta.id)) return false;
  lead.etiquetas.push(etiqueta.id);
  lead.atualizadoEm = agora();
  return true;
}

// Leads criados por versões antigas (antes do funil) ganham os campos novos
function migrarLeads() {
  let mudou = false;
  for (const c of estado.conversas) {
    if (c.codigo && c.etapa) continue;
    const empresa = estado.empresas.find((e) => e.id === c.empresaId);
    if (!c.codigo) c.codigo = novoCodigo();
    if (!c.etapa) c.etapa = c.lead ? acharEtapa(empresa, 'No WhatsApp') || etapasDa(empresa)[0] : acharEtapa(empresa, 'Conversando no site') || etapasDa(empresa)[0];
    c.origem = c.origem || 'site';
    c.etapaHistorico = c.etapaHistorico || [];
    delete c.conversoes;
    for (const m of c.mensagens || []) m.canal = m.canal || 'site';
    mudou = true;
  }
  if (mudou) salvar();
}

module.exports = {
  ETAPAS_PADRAO,
  CORES_ETIQUETA,
  etiquetasDa,
  aplicarEtiqueta,
  etapasDa,
  acharEtapa,
  criarLead,
  adicionarMensagem,
  moverEtapa,
  aoChegarNoWhatsapp,
  migrarLeads
};
