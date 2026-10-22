// prospeccao.js — listas de contatos para disparo (ex.: empresas que não conhecem a sua ainda)
// e as proteções do "modo prospecção" dos disparos.
//
// Lista importada (PDF do Google Maps, planilha ou CSV colado): cada contato vira um lead com
// lead.prospeccao { listaId, empresa, cidade, ramo, endereço, nota, site… }. Telefone fixo fica
// de fora (a não ser que peça para incluir) e repetidos não entram de novo; a prévia avisa quem
// já recebeu disparo em massa. Quando alguém responde, cai no atendimento normal.
//
// Modo prospecção no disparo: limite por dia com aquecimento (começa baixo e sobe um pouco a
// cada dia), confere se o número tem WhatsApp antes de mandar, intervalo maior e freio
// automático quando os envios começam a falhar.

const { estado, salvar, novoId, agora } = require('./db');
const { texto, numeroWhatsapp } = require('./util');

const PADRAO = { limiteInicial: 20, aumentoDia: 10, tetoDia: 80, intervaloMin: 60, intervaloMax: 180, freioErros: 3 };
// perfis prontos (aba Segurança e Novo disparo): o "recomendado" é o PADRAO
const PERFIS = {
  novo: { limiteInicial: 10, aumentoDia: 5, tetoDia: 40, intervaloMin: 120, intervaloMax: 300, freioErros: 2 },
  recomendado: { ...PADRAO },
  aquecido: { limiteInicial: 30, aumentoDia: 15, tetoDia: 150, intervaloMin: 45, intervaloMax: 120, freioErros: 3 }
};
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
    freioErros: n(c.freioErros, PADRAO.freioErros, 2, 20),
    perfil: ['novo', 'recomendado', 'aquecido', 'personalizado'].includes(c.perfil) ? c.perfil : 'recomendado'
  };
}

function salvarConfig(empresa, b = {}) {
  const perfil = PERFIS[b.perfil] ? b.perfil : 'personalizado';
  const valores = PERFIS[b.perfil] || b;
  empresa.prospeccao = { ...(empresa.prospeccao || {}), ...Object.fromEntries(Object.keys(PADRAO).filter((k) => valores[k] !== undefined).map((k) => [k, valores[k]])), perfil };
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
  const disparados = contatos.filter((c) => disparosRecebidos(c).length).length;
  return { ...l, contatos: contatos.length, responderam, semWhatsapp, sairam, disparados };
}

// ---------------------------------------------------------------- já está no CRM? já recebeu disparo?

// o mesmo celular pode estar guardado com ou sem o 9 extra (o WhatsApp devolve sem em números antigos)
function chavesDoNumero(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  if (!d) return [];
  const k = [d];
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') k.push(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12 && /^[6-9]/.test(d[4])) k.push(`${d.slice(0, 4)}9${d.slice(4)}`);
  return k;
}
const chaveDoLead = (c) => (c.whatsappJid ? c.whatsappJid.split('@')[0] : c.telefone);
const nomeLimpo = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// leads da empresa por número (todas as variações) e por nome da empresa + cidade
function indiceDosLeads(empresa) {
  const porNumero = new Map();
  const porNome = new Map();
  for (const c of estado.conversas) {
    if (c.empresaId !== empresa.id) continue;
    for (const k of chavesDoNumero(chaveDoLead(c))) if (!porNumero.has(k)) porNumero.set(k, c);
    if (c.telefone) for (const k of chavesDoNumero(c.telefone)) if (!porNumero.has(k)) porNumero.set(k, c);
    const n = nomeLimpo(c.prospeccao?.empresa || c.nome);
    if (n.length >= 5) porNome.set(`${n}|${nomeLimpo(c.prospeccao?.cidade)}`, c);
  }
  const acharNumero = (numero) => chavesDoNumero(numero).map((k) => porNumero.get(k)).find(Boolean) || null;
  const acharNome = (nome, cidade) => {
    const n = nomeLimpo(nome);
    if (n.length < 5) return null;
    return porNome.get(`${n}|${nomeLimpo(cidade)}`) || porNome.get(`${n}|`) || null;
  };
  return { acharNumero, acharNome, porNumero };
}

// disparos em massa que o lead já recebeu (pelas mensagens marcadas), o mais recente primeiro
function disparosRecebidos(lead) {
  const porId = new Map();
  for (const m of lead?.mensagens || []) if (m.disparoId && !porId.has(m.disparoId)) porId.set(m.disparoId, m.em);
  const lista = [...porId].map(([id, em]) => ({ id, em, nome: (estado.disparos || []).find((d) => d.id === id)?.nome || 'Disparo em massa' }));
  // mensagens antigas podem ter saído do histórico: a data do último disparo continua no lead
  if (!lista.length && lead?.ultimoDisparoEm) lista.push({ id: null, em: lead.ultimoDisparoEm, nome: 'Disparo em massa' });
  return lista.sort((a, b) => (a.em < b.em ? 1 : -1));
}

// 🛡️ já recebeu disparo em massa? Vale o próprio número e a mesma empresa com outro número
// (marcada na importação). excetoId: o disparo que está enviando agora não conta.
function jaRecebeuDisparo(lead, excetoId = null) {
  const outro = (c) => disparosRecebidos(c).some((x) => !excetoId || x.id !== excetoId);
  if (outro(lead)) return true;
  const par = lead?.prospeccao?.parecidoCom && estado.conversas.find((c) => c.id === lead.prospeccao.parecidoCom);
  return Boolean(par && outro(par));
}

const resumoDoLead = (empresa, c) => ({
  id: c.id,
  nome: c.nome || '',
  etapa: c.etapa || '',
  lista: c.prospeccao?.listaId ? listasDa(empresa).find((l) => l.id === c.prospeccao.listaId)?.nome || 'lista apagada' : '',
  respondeu: (c.mensagens || []).some((m) => m.papel === 'visitante'),
  naoDisparar: Boolean(c.naoDisparar)
});

// Antes de importar: para cada contato diz se é novo, fixo, sem número, repetido no arquivo ou
// já está no CRM — e se já recebeu disparo em massa (quando e qual).
function analisar(empresa, contatos, { incluirFixos = false } = {}) {
  const idx = indiceDosLeads(empresa);
  const noArquivo = new Set();
  return (Array.isArray(contatos) ? contatos.slice(0, 5000) : []).map((x) => {
    const numero = numeroWhatsapp(x?.telefone);
    const lead = numero.length >= 10 ? idx.acharNumero(numero) : null;
    const parecido = lead ? null : idx.acharNome(x?.empresa || x?.nome, x?.cidade);
    let situacao = 'novo';
    if (numero.length < 10) situacao = 'invalido';
    else if (lead) situacao = 'existe';
    else if (chavesDoNumero(numero).some((k) => noArquivo.has(k))) situacao = 'repetido';
    else if (ehFixo(numero) && !incluirFixos) situacao = 'fixo';
    if (numero.length >= 10) chavesDoNumero(numero).forEach((k) => noArquivo.add(k));
    const quem = lead || parecido;
    return {
      ...x,
      analise: {
        numero,
        fixo: numero.length >= 10 && ehFixo(numero),
        situacao,
        lead: lead ? resumoDoLead(empresa, lead) : null,
        // mesmo nome de empresa (e cidade) com outro telefone: pode ser a mesma empresa
        parecido: parecido ? resumoDoLead(empresa, parecido) : null,
        disparos: quem ? disparosRecebidos(quem).slice(0, 5) : []
      }
    };
  });
}

// dados extras de cada empresa (do PDF do Google Maps ou da planilha)
const EXTRAS = { nota: 10, avaliacoes: 12, endereco: 200, bairro: 80, estado: 40, cep: 20, pais: 40, site: 300, email: 160, categorias: 200, mapsUrl: 600 };

// contatos: [{ nome, telefone, empresa, cidade, ramo, endereco, nota… }]
function importar(empresa, { nome, contatos, etiquetaId, principal, incluirFixos = false }) {
  const { criarLead } = require('./leads');
  const lista = Array.isArray(contatos) ? contatos.slice(0, 5000) : [];
  if (!lista.length) throw Object.assign(new Error('Cole ou envie pelo menos um contato com telefone.'), { status: 400 });
  const l = { id: novoId('lst'), nome: texto(nome, 80) || `Lista de ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, criadoEm: agora(), importados: 0, repetidos: 0, fixos: 0, invalidos: 0, jaDisparados: 0 };
  const etiquetaOk = etiquetaId && require('./leads').etiquetasDa(empresa).some((t) => t.id === etiquetaId) ? etiquetaId : null;
  for (const x of analisar(empresa, lista, { incluirFixos })) {
    const a = x.analise;
    if (a.situacao === 'invalido') { l.invalidos++; continue; }
    if (a.situacao === 'fixo') { l.fixos++; continue; }
    if (a.situacao === 'existe' || a.situacao === 'repetido') { l.repetidos++; if (a.disparos.length) l.jaDisparados++; continue; }
    const lead = criarLead({ empresa, bot: principal, canal: 'manual', nome: texto(x?.nome || x?.empresa, 120), telefone: a.numero });
    lead.prospeccao = { listaId: l.id, empresa: texto(x?.empresa, 120), cidade: texto(x?.cidade, 80), ramo: texto(x?.ramo || x?.categorias, 80), importadoEm: agora() };
    for (const [k, max] of Object.entries(EXTRAS)) { const v = texto(x?.[k], max); if (v) lead.prospeccao[k] = v; }
    if (a.fixo) lead.prospeccao.fixo = true;
    const cortados = (Array.isArray(x?.cortados) ? x.cortados : []).filter((k) => ['empresa', 'endereco', 'site', 'categorias', 'email'].includes(k));
    if (cortados.length) lead.prospeccao.cortados = cortados; // texto que veio cortado no PDF ("…")
    if (a.parecido) lead.prospeccao.parecidoCom = a.parecido.id; // mesma empresa com outro número?
    if (etiquetaOk) lead.etiquetas = [...new Set([...(lead.etiquetas || []), etiquetaOk])];
    l.importados++;
  }
  if (!l.importados) throw Object.assign(new Error(`Nenhum contato novo: ${l.repetidos} já existiam, ${l.fixos} são telefone fixo e ${l.invalidos} estão sem telefone válido.`), { status: 400 });
  listasDa(empresa).push(l);
  salvar();
  return resumoLista(empresa, l);
}

// Ficha de cada contato da lista: dados da empresa + o que já aconteceu com ele
function detalheLista(empresa, listaId) {
  const l = listasDa(empresa).find((x) => x.id === listaId);
  if (!l) throw Object.assign(new Error('Lista não encontrada.'), { status: 404 });
  const contatos = contatosDaLista(empresa, listaId).map((c) => {
    const p = c.prospeccao || {};
    const parecido = p.parecidoCom && estado.conversas.find((x) => x.id === p.parecidoCom && x.empresaId === empresa.id);
    return {
      id: c.id,
      nome: c.nome || '',
      telefone: c.telefone || '',
      etapa: c.etapa || '',
      ...Object.fromEntries(['empresa', 'cidade', 'ramo', ...Object.keys(EXTRAS), 'fixo', 'cortados'].filter((k) => p[k]).map((k) => [k, p[k]])),
      temWhatsapp: c.temWhatsapp ?? null,
      respondeu: (c.mensagens || []).some((m) => m.papel === 'visitante'),
      naoDisparar: Boolean(c.naoDisparar),
      disparos: disparosRecebidos(c).slice(0, 5),
      parecido: parecido ? { ...resumoDoLead(empresa, parecido), disparos: disparosRecebidos(parecido).slice(0, 3) } : null
    };
  });
  return { lista: resumoLista(empresa, l), contatos };
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

module.exports = { jaRecebeuDisparo, PERFIS, PADRAO, INTERVALO_MINIMO_PROSPECCAO, configDa, salvarConfig, ehFixo, listasDa, contatosDaLista, resumoLista, analisar, disparosRecebidos, chavesDoNumero, importar, detalheLista, apagarLista, limiteDeHoje, enviadosHoje, contarEnvio, temWhatsapp, diaSp };
