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

const nomeProvisorio = (labelId) => `Etiqueta nova do WhatsApp (nº ${labelId})`;
function etiquetaProvisoria(empresa, labelId) {
  const cfg = configDa(empresa);
  if (!/^\d{1,6}$/.test(String(labelId))) return null;
  cfg.labels[labelId] = { id: String(labelId), nome: nomeProvisorio(labelId), cor: 0, provisoria: true };
  const t = etiquetaDoCrm(empresa, cfg.labels[labelId]);
  require('./alertas').registrar(empresa, 'etiqueta-nova', 'Chegou uma etiqueta nova do WhatsApp, mas o celular não mandou o nome dela. Dê o nome em IA do WhatsApp → Etiquetas do WhatsApp Business (uma vez só).', { nivel: 'aviso' });
  console.log(`[etiquetas-zap ${empresa.id}] etiqueta nova sem nome (nº ${labelId}): criada com nome provisório`);
  return t;
}

// A empresa dá o nome de uma etiqueta que chegou sem nome (só as provisórias)
function nomear(empresa, labelId, nome) {
  const cfg = configDa(empresa);
  const l = cfg.labels[String(labelId)];
  if (!l?.provisoria) throw Object.assign(new Error('Só dá para dar nome aqui às etiquetas que chegaram sem nome. As outras mudam no celular.'), { status: 400 });
  const limpo = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!limpo) throw Object.assign(new Error('Escreva o nome igual ao do celular.'), { status: 400 });
  const lista = require('./leads').etiquetasDa(empresa);
  const t = lista.find((e) => e.zapId === l.id);
  if (lista.some((e) => e !== t && limpar(e.nome) === limpar(limpo))) throw Object.assign(new Error('Já existe uma etiqueta com esse nome.'), { status: 400 });
  l.nome = limpo;
  l.nomeDadoNoCrm = true;
  if (t) t.nome = limpo;
  salvar();
  return resumo(empresa);
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
  if (ehListaDoWhatsapp(nome)) {
    // Favoritos, Grupos, Não lidas…: lembra o número para nunca virar "etiqueta nova"
    cfg.listasDoWhatsapp = { ...(cfg.listasDoWhatsapp || {}), [id]: true };
    return;
  }
  if (!nome) return;
  const antigo = cfg.labels[id];
  // chegou o nome de verdade de uma etiqueta que estava com nome provisório
  if (antigo?.provisoria) {
    const real = /[^\x20-\x7E]/.test(nome) ? nome : consertarAcentos(nome);
    cfg.labels[id] = { id, nome: real, cor: l.color ?? l.cor ?? 0 };
    const ligada = require('./leads').etiquetasDa(empresa).find((t) => t.zapId === id);
    if (ligada) Object.assign(ligada, { nome: real.slice(0, 40), cor: corDoZap(l.color ?? l.cor ?? 0) });
    return;
  }
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
// Marcou/desmarcou no WhatsApp
function associar(empresa, jid, labelId, tipo, { aoVivo = false } = {}) {
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
  let t = label ? etiquetaDoCrm(empresa, label) : require('./leads').etiquetasDa(empresa).find((e) => e.zapId === labelId);
  // etiqueta criada no celular depois de conectar: o WhatsApp manda a marcação, mas nem sempre o
  // nome. Cria já (com nome provisório) para o cliente não ficar sem ela; o nome certo chega na
  // próxima leitura ou a empresa dá o nome na aba IA do WhatsApp
  if (!t && tipo === 'add' && !cfg.listasDoWhatsapp?.[labelId]) t = etiquetaProvisoria(empresa, labelId);
  if (!t) return false;
  const comprovantes = require('./comprovantes');
  // "Agendado" (ou outra de antes da venda) que a venda tirou voltando velha: não volta no CRM
  // e o CRM tira de novo no WhatsApp (fica marcada como "está no zap" para o espelho remover)
  if (tipo === 'add' && comprovantes.etiquetaChegandoEhVelha(empresa, lead, t.id, { aoVivo })) {
    lead.etiquetasZap = [...new Set([...(lead.etiquetasZap || []), t.id])];
    lead.etiquetas = (lead.etiquetas || []).filter((x) => x !== t.id);
    return false;
  }
  // posta de propósito depois da venda (ex.: agendou a entrega): vale, e não é mais "tirada pela venda"
  if (tipo === 'add' && lead.tiradasPelaVenda?.[t.id]) delete lead.tiradasPelaVenda[t.id];
  const atuais = new Set(lead.etiquetas || []);
  const zap = new Set(lead.etiquetasZap || []);
  const tinha = atuais.has(t.id);
  if (tipo === 'add') {
    atuais.add(t.id);
    zap.add(t.id);
  } else {
    atuais.delete(t.id);
    zap.delete(t.id);
  }
  lead.etiquetas = [...atuais];
  lead.etiquetasZap = [...zap]; // já está igual no WhatsApp: não manda de volta
  // colocou a etiqueta de venda ("Venda Concluída") no celular: sai do agendado (CRM e WhatsApp)
  if (tipo === 'add' && !tinha && comprovantes.ehEtiquetaDeVenda(t.nome)) comprovantes.marcarVendido(empresa, lead, { etiqueta: t.id });
  // etiqueta "Agendado": entra/sai da aba Agendamentos
  const agenda = require('./detector-agenda');
  if (agenda.ehEtiquetaAgendado(t.nome) && tipo === 'add' && !tinha) agenda.pelaEtiqueta(empresa, lead, { aoVivo }).catch((err) => console.error('[etiquetas-zap] agenda:', err.message));
  if (agenda.ehEtiquetaAgendado(t.nome) && tipo !== 'add' && tinha && aoVivo) agenda.etiquetaTirada(empresa, lead);
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
      associar(empresa, jid, labelId, tipo, { aoVivo: true });
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
  const doMapa = /@lid$/.test(lead.whatsappJid || '') ? empresa.mapaLid?.[lead.whatsappJid] : ''; // id escondido → número real (se o CRM já sabe)
  const numero = /@s\.whatsapp\.net$/.test(lead.whatsappJid || '') ? digitos(lead.whatsappJid) : String(lead.telefone || '').replace(/\D/g, '').length >= 12 ? String(lead.telefone).replace(/\D/g, '') : doMapa ? digitos(doMapa) : lead.whatsappJid;
  if (!numero) return;
  const mudar = [...[...agoraSet].filter((id) => !zap.has(id)).map((id) => [id, 'add']), ...[...zap].filter((id) => !agoraSet.has(id)).map((id) => [id, 'remove'])];
  lead.falhasEtiquetaZap = lead.falhasEtiquetaZap || {};
  const pendentes = new Set(mudar.map(([id, acao]) => `${id}:${acao}`));
  for (const k of Object.keys(lead.falhasEtiquetaZap)) if (!pendentes.has(k)) delete lead.falhasEtiquetaZap[k]; // não precisa mais
  let mudou = false;
  for (const [id, acao] of mudar) {
    const t = porId.get(id);
    const falha = lead.falhasEtiquetaZap[`${id}:${acao}`];
    if (falha && Date.now() < new Date(falha.proxima).getTime()) continue; // espera para tentar de novo
    mudou = true;
    try {
      if (t?.zapId) await whatsapp.evolution(empresa, 'POST', '/label/handleLabel/{instancia}', { number: numero, labelId: t.zapId, action: acao });
      if (acao === 'add') zap.add(id);
      else zap.delete(id);
      delete lead.falhasEtiquetaZap[`${id}:${acao}`];
      delete lead.erroEtiquetaZap;
    } catch (err) {
      // tenta de novo mais tarde (1, 5, 15, 60 min…); depois de 6 tentativas desiste e avisa
      const n = (falha?.n || 0) + 1;
      lead.erroEtiquetaZap = { em: agora(), msg: String(err.message).slice(0, 160) };
      if (n >= 6) {
        delete lead.falhasEtiquetaZap[`${id}:${acao}`];
        if (acao === 'add') zap.add(id);
        else zap.delete(id);
        require('./alertas').registrar(empresa, 'etiqueta-zap', `Não consegui ${acao === 'add' ? 'colocar' : 'tirar'} a etiqueta "${t?.nome || id}" no WhatsApp de ${lead.nome || 'um cliente'}: ${String(err.message).slice(0, 120)}. Ajuste no celular.`, { nivel: 'aviso', leadId: lead.id });
      } else {
        const minutos = [1, 5, 15, 60, 180][n - 1] || 180;
        lead.falhasEtiquetaZap[`${id}:${acao}`] = { n, proxima: new Date(Date.now() + minutos * 60000).toISOString() };
      }
    }
  }
  if (!Object.keys(lead.falhasEtiquetaZap).length) delete lead.falhasEtiquetaZap;
  lead.etiquetasZap = [...zap];
  if (mudou) salvar();
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
    reiniciadoEm: cfg.reiniciadoEm || null,
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

module.exports = { nomear, consertarAcentos, importarCopia, configDa, carregar, receberWebhook, espelharLead, varrer, resumo, ligar, iniciar, associar, CORES_ZAP };
