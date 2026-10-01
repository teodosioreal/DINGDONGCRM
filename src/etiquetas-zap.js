// etiquetas-zap.js — etiquetas do WhatsApp Business ⇄ etiquetas do CRM.
//
// - Etiqueta criada/renomeada no WhatsApp Business vira etiqueta do CRM (mesmo nome).
// - Marcou/desmarcou um cliente no celular → muda no CRM na hora (webhook).
// - Marcou/desmarcou no CRM (painel, lote, IA) → o CRM marca no WhatsApp.
// - As duas ligam pelo NOME (sem acento/maiúscula). A Evolution não cria etiqueta
//   nova no WhatsApp: etiqueta que só existe no CRM fica só no CRM até você criar
//   uma com o mesmo nome no WhatsApp Business.
// Só funciona em número de WhatsApp Business (o WhatsApp comum não tem etiquetas).

const { estado, salvar, novoId, agora } = require('./db');

// as 20 cores do WhatsApp Business (o número que vem no webhook é a posição)
const CORES_ZAP = ['#ff9485', '#64c4ff', '#ffd429', '#dfaef0', '#99b6c1', '#55ccb3', '#ff9dff', '#d3a91d', '#6d7cce', '#d7e752', '#00d0e2', '#ffc5c7', '#93ceac', '#f74848', '#00a0f2', '#83e422', '#ffaf04', '#b5ebff', '#9ba6ff', '#9368cf'];
const INTERVALO_MS = Number(process.env.ETIQUETAS_ZAP_INTERVALO_MS) || 15000;

const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const digitos = (s) => String(s || '').split('@')[0].replace(/\D/g, '');

function configDa(empresa) {
  if (!empresa.etiquetasZap || typeof empresa.etiquetasZap !== 'object') empresa.etiquetasZap = { ativo: true, labels: {}, pendentes: {} };
  const c = empresa.etiquetasZap;
  c.labels = c.labels || {};
  c.pendentes = c.pendentes || {};
  return c;
}

const ativo = (empresa) => configDa(empresa).ativo !== false && require('./whatsapp').configurado(empresa);

const corDoZap = (cor) => (/^#/.test(String(cor)) ? cor : CORES_ZAP[Number(cor) % CORES_ZAP.length] || '#64748b');

// Etiqueta do CRM que corresponde a uma do WhatsApp (cria se não existir)
function etiquetaDoCrm(empresa, label, criar = true) {
  const leads = require('./leads');
  const lista = leads.etiquetasDa(empresa);
  let t = lista.find((e) => e.zapId === label.id) || lista.find((e) => limpar(e.nome) === limpar(label.nome));
  if (!t && criar && label.nome) {
    t = { id: novoId('tag'), nome: String(label.nome).slice(0, 40), cor: corDoZap(label.cor) };
    lista.push(t);
  }
  if (t) t.zapId = label.id;
  return t || null;
}

// Uma etiqueta do WhatsApp chegou (lista inicial ou edição)
function registrarLabel(empresa, l) {
  const cfg = configDa(empresa);
  const id = String(l?.id ?? l?.labelId ?? '');
  if (!id) return;
  if (l.deleted) {
    delete cfg.labels[id];
    for (const t of require('./leads').etiquetasDa(empresa)) if (t.zapId === id) delete t.zapId; // a do CRM continua
    return;
  }
  const nome = String(l.name || l.nome || '').trim();
  if (!nome) return;
  const antigo = cfg.labels[id];
  cfg.labels[id] = { id, nome, cor: l.color ?? l.cor ?? 0 };
  // renomeou no WhatsApp: renomeia a ligada no CRM
  const ligada = require('./leads').etiquetasDa(empresa).find((t) => t.zapId === id);
  if (ligada && antigo && antigo.nome !== nome && !require('./leads').etiquetasDa(empresa).some((t) => t !== ligada && limpar(t.nome) === limpar(nome))) ligada.nome = nome.slice(0, 40);
  etiquetaDoCrm(empresa, cfg.labels[id]);
}

// Busca a lista de etiquetas do WhatsApp (botão, ao conectar, a cada 6 h)
async function carregar(empresa) {
  const whatsapp = require('./whatsapp');
  const cfg = configDa(empresa);
  try {
    const r = await whatsapp.evolution(empresa, 'GET', '/label/findLabels/{instancia}');
    const lista = Array.isArray(r) ? r : Array.isArray(r?.labels) ? r.labels : [];
    for (const l of lista) registrarLabel(empresa, l);
    cfg.carregadoEm = agora();
    cfg.erro = lista.length ? '' : 'O WhatsApp não mandou nenhuma etiqueta (o número é WhatsApp Business? já tem etiquetas criadas?).';
  } catch (err) {
    cfg.carregadoEm = agora();
    cfg.erro = `Não consegui ler as etiquetas: ${String(err.message).slice(0, 160)}`;
  }
  // conversas que já vêm com etiquetas (algumas versões da Evolution mandam no findChats)
  try {
    const chats = await whatsapp.evolution(empresa, 'POST', '/chat/findChats/{instancia}', {});
    for (const ch of Array.isArray(chats) ? chats : []) {
      const jid = ch.remoteJid || ch.id;
      const labels = Array.isArray(ch.labels) ? ch.labels : [];
      if (jid && labels.length) for (const lid of labels) associar(empresa, jid, String(lid?.id ?? lid), 'add');
    }
  } catch {
    /* opcional */
  }
  salvar();
  return resumo(empresa);
}

function acharLead(empresa, jid) {
  const d = digitos(jid);
  const da = estado.conversas.filter((c) => c.empresaId === empresa.id);
  return (
    da.find((c) => c.whatsappJid === jid) ||
    (/@lid$/.test(jid) ? null : da.find((c) => d.length >= 10 && (digitos(c.whatsappJid) === d || String(c.telefone || '').replace(/\D/g, '') === d))) ||
    null
  );
}

// Marcou/desmarcou no WhatsApp
function associar(empresa, jid, labelId, tipo) {
  const cfg = configDa(empresa);
  if (!jid || !labelId || /@g\.us$/.test(jid)) return false;
  const label = cfg.labels[labelId] || null;
  const lead = acharLead(empresa, jid);
  if (!lead) {
    // cliente ainda não está no CRM: guarda e aplica quando ele aparecer
    const p = new Set(cfg.pendentes[jid] || []);
    if (tipo === 'add') p.add(labelId);
    else p.delete(labelId);
    if (p.size) cfg.pendentes[jid] = [...p];
    else delete cfg.pendentes[jid];
    return false;
  }
  const t = label ? etiquetaDoCrm(empresa, label) : require('./leads').etiquetasDa(empresa).find((e) => e.zapId === labelId);
  if (!t) return false; // etiqueta desconhecida: vem na próxima leitura da lista
  const atuais = new Set(lead.etiquetas || []);
  const zap = new Set(lead.etiquetasZap || []);
  if (tipo === 'add') {
    atuais.add(t.id);
    zap.add(t.id);
  } else {
    atuais.delete(t.id);
    zap.delete(t.id);
  }
  lead.etiquetas = [...atuais];
  lead.etiquetasZap = [...zap]; // já está igual no WhatsApp: não manda de volta
  lead.atualizadoEm = agora();
  return true;
}

function receberWebhook(empresa, evento, data) {
  if (configDa(empresa).ativo === false) return;
  if (evento === 'labels.edit') {
    for (const l of Array.isArray(data) ? data : [data]) registrarLabel(empresa, l);
  } else if (evento === 'labels.association') {
    const itens = Array.isArray(data) ? data : [data];
    for (const d of itens) {
      const jid = d?.chatId || d?.association?.chatId || '';
      const labelId = String(d?.labelId ?? d?.association?.labelId ?? '');
      const tipo = d?.type === 'remove' ? 'remove' : 'add';
      associar(empresa, jid, labelId, tipo);
    }
  }
  salvar();
}

// ---------------------------------------------------------------- CRM → WhatsApp
// Compara as etiquetas do lead com o que já está no WhatsApp e acerta a diferença
async function espelharLead(empresa, lead) {
  const whatsapp = require('./whatsapp');
  const leads = require('./leads');
  const cfg = configDa(empresa);
  const porId = new Map(leads.etiquetasDa(empresa).map((t) => [t.id, t]));
  const agoraSet = new Set((lead.etiquetas || []).filter((id) => porId.get(id)?.zapId && cfg.labels[porId.get(id).zapId]));
  const zap = new Set(lead.etiquetasZap || []);
  const numero = /@s\.whatsapp\.net$/.test(lead.whatsappJid || '') ? digitos(lead.whatsappJid) : String(lead.telefone || '').replace(/\D/g, '').length >= 12 ? String(lead.telefone).replace(/\D/g, '') : lead.whatsappJid;
  if (!numero) return;
  const mudar = [...[...agoraSet].filter((id) => !zap.has(id)).map((id) => [id, 'add']), ...[...zap].filter((id) => !agoraSet.has(id)).map((id) => [id, 'remove'])];
  for (const [id, acao] of mudar) {
    const t = porId.get(id);
    try {
      if (t?.zapId) await whatsapp.evolution(empresa, 'POST', '/label/handleLabel/{instancia}', { number: numero, labelId: t.zapId, action: acao });
      if (acao === 'add') zap.add(id);
      else zap.delete(id);
      delete lead.erroEtiquetaZap;
    } catch (err) {
      lead.erroEtiquetaZap = { em: agora(), msg: String(err.message).slice(0, 160) };
      // não fica tentando sem parar: considera feito (a etiqueta continua no CRM)
      if (acao === 'add') zap.add(id);
      else zap.delete(id);
    }
  }
  lead.etiquetasZap = [...zap];
  if (mudar.length) salvar();
}

// Passa por todos a cada 15 s (barato: só chama a Evolution quando algo mudou)
let rodando = false;
async function varrer() {
  if (rodando) return;
  rodando = true;
  try {
    for (const empresa of estado.empresas) {
      if (!ativo(empresa)) continue;
      const cfg = configDa(empresa);
      // pendentes de quem já apareceu
      for (const [jid, ids] of Object.entries(cfg.pendentes)) {
        if (!acharLead(empresa, jid)) continue;
        delete cfg.pendentes[jid];
        for (const id of ids) associar(empresa, jid, id, 'add');
        salvar();
      }
      if (!Object.keys(cfg.labels).length) continue;
      const ligadas = new Set(require('./leads').etiquetasDa(empresa).filter((t) => t.zapId && cfg.labels[t.zapId]).map((t) => t.id));
      for (const lead of estado.conversas) {
        if (lead.empresaId !== empresa.id || !lead.whatsappJid) continue;
        const a = (lead.etiquetas || []).filter((id) => ligadas.has(id)).sort().join();
        const z = (lead.etiquetasZap || []).filter((id) => ligadas.has(id)).sort().join();
        if (a !== z) await espelharLead(empresa, lead);
      }
    }
  } catch (err) {
    console.error('[etiquetas-zap]', err.message);
  } finally {
    rodando = false;
  }
}

function resumo(empresa) {
  const cfg = configDa(empresa);
  const crm = require('./leads').etiquetasDa(empresa);
  return {
    ativo: cfg.ativo !== false,
    carregadoEm: cfg.carregadoEm || null,
    erro: cfg.erro || '',
    noZap: Object.values(cfg.labels).map((l) => ({ ...l, cor: corDoZap(l.cor) })),
    soNoCrm: crm.filter((t) => !t.zapId || !cfg.labels[t.zapId]).map((t) => t.nome)
  };
}

function ligar(empresa, sim) {
  configDa(empresa).ativo = sim === true;
  salvar();
}

let timer = null;
function iniciar() {
  if (timer || process.env.ETIQUETAS_ZAP === 'nao') return;
  timer = setInterval(varrer, INTERVALO_MS);
  timer.unref?.();
  // lê a lista de etiquetas ao ligar e a cada 6 h
  const ler = () => estado.empresas.filter(ativo).reduce((p, e) => p.then(() => carregar(e)).catch(() => {}), Promise.resolve());
  setTimeout(ler, 30000).unref?.();
  setInterval(ler, 6 * 3600 * 1000).unref?.();
}

module.exports = { configDa, carregar, receberWebhook, espelharLead, varrer, resumo, ligar, iniciar, associar, CORES_ZAP };
