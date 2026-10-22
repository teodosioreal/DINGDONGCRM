// prospeccao.js — listas de contatos para disparo (ex.: empresas que não conhecem a sua ainda)
// e as proteções do "modo prospecção" dos disparos.
//
// Lista importada (planilha/CSV colado): cada contato vira um lead com lead.prospeccao
// { listaId, empresa, cidade, ramo }. Telefone fixo fica de fora (não tem WhatsApp) e
// repetidos não entram de novo. Quando alguém responde, cai no atendimento normal.
//
// Modo prospecção no disparo: limite por dia com aquecimento (começa baixo e sobe um pouco a
// cada dia), confere se o número tem WhatsApp antes de mandar, intervalo maior e freio
// automático quando os envios começam a falhar.

const { estado, salvar, novoId, agora } = require('./db');
const { texto, numeroWhatsapp } = require('./util');

const PADRAO = { limiteInicial: 20, aumentoDia: 10, tetoDia: 80, intervaloMin: 60, intervaloMax: 180, freioErros: 3 };
const INTERVALO_MINIMO_PROSPECCAO = 45; // segundos

function configDa(empresa) {
  const c = empresa?.prospeccao || {};
  const n = (v, def, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.round(Number(v)) : def));
  return {
    limiteInicial: n(c.limiteInicial, PADRAO.limiteInicial, 5, 500),
    aumentoDia: n(c.aumentoDia, PADRAO.aumentoDia, 0, 200),
    tetoDia: n(c.tetoDia, PADRAO.tetoDia, 5, 1000),
    intervaloMin: n(c.intervaloMin, PADRAO.intervaloMin, INTERVALO_MINIMO_PROSPECCAO, 900),
    intervaloMax: n(c.intervaloMax, PADRAO.intervaloMax, INTERVALO_MINIMO_PROSPECCAO, 1800),
    freioErros: n(c.freioErros, PADRAO.freioErros, 2, 20)
  };
}

function salvarConfig(empresa, b = {}) {
  empresa.prospeccao = { ...(empresa.prospeccao || {}), ...Object.fromEntries(Object.keys(PADRAO).filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) };
  empresa.prospeccao = configDa(empresa);
  if (empresa.prospeccao.intervaloMax < empresa.prospeccao.intervaloMin) empresa.prospeccao.intervaloMax = empresa.prospeccao.intervaloMin;
  if (empresa.prospeccao.tetoDia < empresa.prospeccao.limiteInicial) empresa.prospeccao.tetoDia = empresa.prospeccao.limiteInicial;
  salvar();
  return empresa.prospeccao;
}

// Brasil: celular tem 9 dígitos depois do DDD e começa com 9; fixo tem 8 e começa com 2 a 5
function ehFixo(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  if (!d.startsWith('55')) return false; // de fora do Brasil: não dá para saber
  const resto = d.slice(4);
  return resto.length === 8 && /^[2-5]/.test(resto);
}

// ---------------------------------------------------------------- listas

function listasDa(empresa) {
  if (!Array.isArray(empresa.listasContatos)) empresa.listasContatos = [];
  return empresa.listasContatos;
}

function contatosDaLista(empresa, listaId) {
  return estado.conversas.filter((c) => c.empresaId === empresa.id && c.prospeccao?.listaId === listaId);
}

function resumoLista(empresa, l) {
  const contatos = contatosDaLista(empresa, l.id);
  const responderam = contatos.filter((c) => (c.mensagens || []).some((m) => m.papel === 'visitante')).length;
  const semWhatsapp = contatos.filter((c) => c.temWhatsapp === false).length;
  const sairam = contatos.filter((c) => c.naoDisparar).length;
  return { ...l, contatos: contatos.length, responderam, semWhatsapp, sairam };
}

// contatos: [{ nome, telefone, empresa, cidade, ramo }]
function importar(empresa, { nome, contatos, etiquetaId, principal }) {
  const { criarLead } = require('./leads');
  const lista = Array.isArray(contatos) ? contatos.slice(0, 5000) : [];
  if (!lista.length) throw Object.assign(new Error('Cole ou envie pelo menos um contato com telefone.'), { status: 400 });
  const l = { id: novoId('lst'), nome: texto(nome, 80) || `Lista de ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, criadoEm: agora(), importados: 0, repetidos: 0, fixos: 0, invalidos: 0 };
  const existentes = new Set(estado.conversas.filter((c) => c.empresaId === empresa.id).map((c) => (c.whatsappJid ? c.whatsappJid.split('@')[0] : c.telefone)).filter(Boolean));
  const etiquetaOk = etiquetaId && require('./leads').etiquetasDa(empresa).some((t) => t.id === etiquetaId) ? etiquetaId : null;
  for (const x of lista) {
    const telefone = numeroWhatsapp(x?.telefone);
    if (telefone.length < 10) { l.invalidos++; continue; }
    if (ehFixo(telefone)) { l.fixos++; continue; }
    if (existentes.has(telefone)) { l.repetidos++; continue; }
    existentes.add(telefone);
    const lead = criarLead({ empresa, bot: principal, canal: 'manual', nome: texto(x?.nome || x?.empresa, 120), telefone });
    lead.prospeccao = { listaId: l.id, empresa: texto(x?.empresa, 120), cidade: texto(x?.cidade, 80), ramo: texto(x?.ramo, 80), importadoEm: agora() };
    if (etiquetaOk) lead.etiquetas = [...new Set([...(lead.etiquetas || []), etiquetaOk])];
    l.importados++;
  }
  if (!l.importados) throw Object.assign(new Error(`Nenhum contato novo: ${l.repetidos} já existiam, ${l.fixos} são telefone fixo e ${l.invalidos} estão sem telefone válido.`), { status: 400 });
  listasDa(empresa).push(l);
  salvar();
  return resumoLista(empresa, l);
}

// Apaga a lista; os contatos que nunca responderam saem junto (quem conversou fica como lead)
function apagarLista(empresa, listaId) {
  const l = listasDa(empresa).find((x) => x.id === listaId);
  if (!l) throw Object.assign(new Error('Lista não encontrada.'), { status: 404 });
  const emAndamento = (estado.disparos || []).some((d) => d.empresaId === empresa.id && d.filtro?.listaId === listaId && ['enviando', 'agendado'].includes(d.status));
  if (emAndamento) throw Object.assign(new Error('Tem um disparo desta lista em andamento. Pause ou cancele antes de apagar.'), { status: 400 });
  let removidos = 0;
  let ficaram = 0;
  estado.conversas = estado.conversas.filter((c) => {
    if (c.empresaId !== empresa.id || c.prospeccao?.listaId !== listaId) return true;
    if ((c.mensagens || []).some((m) => m.papel === 'visitante')) { ficaram++; return true; }
    removidos++;
    return false;
  });
  empresa.listasContatos = listasDa(empresa).filter((x) => x.id !== listaId);
  salvar();
  return { removidos, ficaram };
}

// ---------------------------------------------------------------- disparo em modo prospecção

const diaSp = (ms = Date.now()) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);

// quantos podem sair hoje: começa no limite inicial e sobe "aumento" a cada dia que já teve envio
function limiteDeHoje(d) {
  const p = d.prospeccaoCfg || PADRAO;
  const hoje = diaSp();
  const diasAntes = Object.keys(d.enviadosPorDia || {}).filter((k) => k < hoje && d.enviadosPorDia[k] > 0).length;
  return Math.min(p.tetoDia, p.limiteInicial + p.aumentoDia * diasAntes);
}
function enviadosHoje(d) {
  return (d.enviadosPorDia || {})[diaSp()] || 0;
}
function contarEnvio(d) {
  d.enviadosPorDia = d.enviadosPorDia || {};
  const k = diaSp();
  d.enviadosPorDia[k] = (d.enviadosPorDia[k] || 0) + 1;
}

// o número tem WhatsApp? true / false / null (não deu para saber: segue)
async function temWhatsapp(empresa, destino) {
  const numero = String(destino || '').split('@')[0].replace(/\D/g, '');
  if (!numero) return null;
  try {
    const r = await require('./whatsapp').evolucao(empresa, 'POST', '/chat/whatsappNumbers/{instancia}', { numbers: [numero] });
    const x = Array.isArray(r) ? r[0] : null;
    if (!x || typeof x.exists !== 'boolean') return null;
    return x.exists ? (x.jid || true) : false;
  } catch {
    return null;
  }
}

module.exports = { PADRAO, INTERVALO_MINIMO_PROSPECCAO, configDa, salvarConfig, ehFixo, listasDa, contatosDaLista, resumoLista, importar, apagarLista, limiteDeHoje, enviadosHoje, contarEnvio, temWhatsapp, diaSp };
