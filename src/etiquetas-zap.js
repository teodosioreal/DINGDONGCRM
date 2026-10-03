// etiquetas-zap.js — etiquetas do WhatsApp Business ⇄ etiquetas do CRM.
// O CRM só tem as etiquetas do WhatsApp (não existe etiqueta só do CRM).
//
// - Etiqueta criada/renomeada no WhatsApp Business vira etiqueta do CRM (mesmo nome);
//   apagada no WhatsApp, some do CRM.
// - Marcou/desmarcou um cliente no celular → muda no CRM na hora (webhook).
// - Marcou/desmarcou no CRM (painel, lote, IA) → o CRM marca no WhatsApp.
// - Etiqueta nova se cria no WhatsApp Business (a Evolution não cria etiqueta lá).
// Só funciona em número de WhatsApp Business (o WhatsApp comum não tem etiquetas).

const { estado, salvar, novoId, agora } = require('./db');

// as 20 cores do WhatsApp Business (o número que vem no webhook é a posição)
const CORES_ZAP = ['#ff9485', '#64c4ff', '#ffd429', '#dfaef0', '#99b6c1', '#55ccb3', '#ff9dff', '#d3a91d', '#6d7cce', '#d7e752', '#00d0e2', '#ffc5c7', '#93ceac', '#f74848', '#00a0f2', '#83e422', '#ffaf04', '#b5ebff', '#9ba6ff', '#9368cf'];
const INTERVALO_MS = Number(process.env.ETIQUETAS_ZAP_INTERVALO_MS) || 15000;

// A Evolution guarda o nome SEM os caracteres acentuados ("Orçamento" vira "Oramento").
// Compara pelo que sobra e conserta as palavras mais comuns.
const chaveAscii = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const CONSERTOS = {
  servio: 'serviço', servios: 'serviços', oramento: 'orçamento', oramentos: 'orçamentos', anncio: 'anúncio', anncios: 'anúncios',
  trfego: 'tráfego', gesto: 'gestão', petrpolis: 'petrópolis', tera: 'terça', negociao: 'negociação', promoo: 'promoção',
  manuteno: 'manutenção', indicao: 'indicação', avaliao: 'avaliação', reunio: 'reunião', cotao: 'cotação', ligao: 'ligação',
  ateno: 'atenção', instalao: 'instalação', confirmao: 'confirmação', concludo: 'concluído', concluda: 'concluída',
  pagamento: 'pagamento', pendncia: 'pendência', urgncia: 'urgência', prximo: 'próximo', crdito: 'crédito', vdeo: 'vídeo',
  nibus: 'ônibus', niteri: 'niterói', so: 'são', joo: 'joão', terespolis: 'teresópolis', maca: 'macaé', ltima: 'última'
};
const VERBO_APOS_NAO = /^(lid[ao]s?|fechou|respondeu|responde|pagou|quer|veio|compareceu|atende|retornou|comprou|agendou)$/i;
// listas automáticas do próprio WhatsApp (não são etiquetas de verdade)
const LISTAS_DO_WHATSAPP = new Set(['no lidas', 'nao lidas', 'favoritos', 'grupos', 'unread', 'favorites', 'groups', 'contatos', 'contacts']);
const ehListaDoWhatsapp = (nome) => LISTAS_DO_WHATSAPP.has(chaveAscii(String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')));

function consertarAcentos(nome) {
  const palavras = String(nome || '').split(' ');
  return palavras
    .map((p, i) => {
      const k = p.toLowerCase();
      let novo = CONSERTOS[k];
      if (!novo && k === 'no' && VERBO_APOS_NAO.test(palavras[i + 1] || '')) novo = 'não';
      if (!novo) return p;
      if (p === p.toUpperCase() && p !== p.toLowerCase()) return novo.toUpperCase();
      if (p[0] === p[0].toUpperCase()) return novo[0].toUpperCase() + novo.slice(1);
      return novo;
    })
    .join(' ');
}

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
  let t = lista.find((e) => e.zapId === label.id) || lista.find((e) => limpar(e.nome) === limpar(label.nome)) || lista.find((e) => chaveAscii(e.nome) === chaveAscii(label.nome));
  if (!t && criar && label.nome) {
    t = { id: novoId('tag'), nome: consertarAcentos(label.nome).slice(0, 40), cor: corDoZap(label.cor) };
    lista.push(t);
  }
  if (t) t.zapId = label.id;
  return t || null;
}

// Etiqueta apagada no WhatsApp: sai da lista e dos leads
function tirarEtiqueta(empresa, zapId) {
  const lista = require('./leads').etiquetasDa(empresa);
  const fora = new Set(lista.filter((t) => t.zapId === zapId).map((t) => t.id));
  if (!fora.size) return;
  empresa.etiquetas = lista.filter((t) => !fora.has(t.id));
  for (const c of estado.conversas) {
    if (c.empresaId !== empresa.id) continue;
    if (c.etiquetas?.some((x) => fora.has(x))) c.etiquetas = c.etiquetas.filter((x) => !fora.has(x));
    if (c.etiquetasZap?.some((x) => fora.has(x))) c.etiquetasZap = c.etiquetasZap.filter((x) => !fora.has(x));
  }
}

// Uma etiqueta do WhatsApp chegou (lista inicial ou edição)
function registrarLabel(empresa, l) {
  const cfg = configDa(empresa);
  const id = String(l?.id ?? l?.labelId ?? '');
  if (!id) return;
  if (l.deleted) {
    delete cfg.labels[id];
    tirarEtiqueta(empresa, id); // apagou no celular: some do CRM também
    return;
  }
  let nome = String(l.name || l.nome || '').trim();
  if (!nome || ehListaDoWhatsapp(nome)) return;
  const antigo = cfg.labels[id];
  // nome sem acento (cópia do banco da Evolution) não estraga um nome bom que já temos
  if (antigo && chaveAscii(antigo.nome) === chaveAscii(nome)) nome = /[^\x20-\x7E]/.test(nome) ? nome : antigo.nome;
  else if (!/[^\x20-\x7E]/.test(nome)) nome = consertarAcentos(nome);
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
  return require('./identidade').conversaDoEndereco(empresa, jid);
}
function acharLeadAntigo(empresa, jid) {
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
  configDa(empresa).ultimoEventoEm = agora(); // o painel mostra: prova de que o celular está mandando
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

// ---------------------------------------------------------------- cópia vinda do servidor
// O deploy copia (só lendo) do banco da Evolution as etiquetas e as marcações
// dos números deste CRM: assim entram também as marcadas ANTES de o CRM ouvir
// os avisos de etiqueta. Arquivo ao lado do banco do CRM; reimporta quando muda.
const ARQUIVO_COPIA = require('path').join(require('path').dirname(process.env.CRM_DB_PATH || require('path').join(__dirname, '..', 'data.json')), 'etiquetas-evolution.json');
function importarCopia(arquivo = ARQUIVO_COPIA) {
  const fs = require('fs');
  let st;
  try {
    st = fs.statSync(arquivo);
  } catch {
    return 0;
  }
  const marca = `${st.mtimeMs}|${st.size}`;
  if (estado.config?.etiquetasCopiaImportada === marca) return 0;
  let dados;
  try {
    dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (err) {
    console.error('[etiquetas-zap] cópia ilegível:', err.message);
    return 0;
  }
  let marcadas = 0;
  for (const empresa of estado.empresas) {
    const inst = empresa.whatsappConfig?.instancia;
    if (!inst || configDa(empresa).ativo === false) continue;
    for (const l of (dados.etiquetas || []).filter((x) => x.instancia === inst)) registrarLabel(empresa, { id: l.id, name: l.nome, color: l.cor });
    // ligação "id escondido → número": junta conversas duplicadas e mostra o número real
    const ligacoes = (dados.mapaLid || []).filter((x) => x.instancia === inst && /@lid$/.test(x.lid || '') && /@s\.whatsapp\.net$/.test(x.fone || ''));
    if (ligacoes.length) {
      empresa.mapaLid = empresa.mapaLid || {};
      for (const x of ligacoes) empresa.mapaLid[x.lid] = x.fone;
      const sinc = require('./sincronizar');
      let convertidas = 0;
      for (const x of ligacoes) {
        if (estado.conversas.some((c) => c.empresaId === empresa.id && c.whatsappJid === x.lid)) {
          sinc.consertarLid(empresa, x.lid, x.fone);
          convertidas++;
        }
      }
      const juntadas = require('./identidade').repararDuplicadas(empresa);
      console.log(`[identidade ${empresa.id}] ${ligacoes.length} ligação(ões) LID→número; ${convertidas} conversa(s) com número real; ${juntadas} duplicada(s) juntada(s)`);
    }
    for (const c of (dados.conversas || []).filter((x) => x.instancia === inst)) {
      for (const labelId of Array.isArray(c.labels) ? c.labels : []) if (associar(empresa, c.jid, String(labelId), 'add')) marcadas++;
    }
  }
  estado.config = estado.config || {};
  estado.config.etiquetasCopiaImportada = marca;
  salvar();
  if (marcadas) console.log(`[etiquetas-zap] cópia do servidor: ${marcadas} etiqueta(s) aplicada(s) nas conversas`);
  return marcadas;
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
  return {
    ativo: cfg.ativo !== false,
    carregadoEm: cfg.carregadoEm || null,
    ultimoEventoEm: cfg.ultimoEventoEm || null,
    numero: String(empresa.whatsappConfig?.perfil?.numero || ''),
    erro: cfg.erro || '',
    noZap: Object.values(cfg.labels).map((l) => ({ ...l, cor: corDoZap(l.cor) }))
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
  // cópia do servidor (feita a cada deploy): confere a cada 10 min se mudou
  setTimeout(() => importarCopia(), Math.min(40000, INTERVALO_MS * 3)).unref?.();
  setInterval(() => importarCopia(), Math.min(10 * 60 * 1000, INTERVALO_MS * 4)).unref?.();
}

module.exports = { consertarAcentos, importarCopia, configDa, carregar, receberWebhook, espelharLead, varrer, resumo, ligar, iniciar, associar, CORES_ZAP };
