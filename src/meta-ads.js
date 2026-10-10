// meta-ads.js — manda para a Meta Ads (API de Conversões) as vendas de clientes que
// chegaram por um anúncio do Facebook/Instagram. Só código, sem IA.
//
// Caminho: anúncio → site (o link traz o fbclid; o widget guarda a chegada por 30 dias
// e os cookies _fbp/_fbc do Pixel, se o site tiver) → botão do WhatsApp (código do
// atendimento liga a visita à conversa) → venda confirmada no CRM (comprovante, frase,
// IA ou à mão) → evento "Purchase" com o valor, de no máximo 30 dias depois do clique.
//
// Por empresa: Pixel (conjunto de dados), token da API de Conversões e, para testar,
// o código de teste (os eventos aparecem em "Eventos de teste" e não contam na campanha).
// Cada venda vai uma vez só (event_id = id da venda). Telefone e nome vão criptografados.

const crypto = require('crypto');
const { estado, salvar, agora } = require('./db');

const DIAS_CLIQUE = 30; // a venda vale até 30 dias depois do clique no anúncio
const DIAS_EVENTO = 7; // a Meta só aceita eventos de até 7 dias atrás
const CICLO_MS = Number(process.env.META_ADS_CICLO_MS) || 5 * 60 * 1000;
const MAX_TENTATIVAS = 5;
const URL_GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com';

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function configDa(empresa) {
  const c = empresa?.metaAds || {};
  return {
    ativo: c.ativo === true,
    pixelId: String(c.pixelId || ''),
    token: String(c.token || ''),
    codigoTeste: String(c.codigoTeste || ''),
    ativadoEm: c.ativadoEm || null
  };
}
const pronto = (c) => c.ativo && /^\d{5,25}$/.test(c.pixelId) && c.token.length > 20;

// o clique no anúncio deste cliente (fbclid da página de chegada), ou null
function cliqueDo(lead) {
  const o = lead?.origemSite || {};
  for (const ch of [o.chegada, o.primeira]) {
    if (!ch?.url) continue;
    let fbclid = '';
    try {
      fbclid = new URL(ch.url).searchParams.get('fbclid') || '';
    } catch {
      fbclid = '';
    }
    if (!fbclid) continue;
    const emMs = new Date(ch.em).getTime() || Date.now();
    const nav = o.navegador || {};
    let pagina = ch.url;
    try {
      const u = new URL(ch.url);
      u.search = '';
      pagina = u.toString();
    } catch { /* fica a url inteira */ }
    return {
      fbclid,
      em: new Date(emMs).toISOString(),
      fbc: nav.fbc || `fb.1.${emMs}.${fbclid}`,
      fbp: nav.fbp || '',
      ip: nav.ip || '',
      ua: nav.ua || '',
      pagina
    };
  }
  return null;
}

const telefoneDe = (lead) => {
  const doJid = /@s\.whatsapp\.net$/.test(lead.whatsappJid || '') ? lead.whatsappJid.split('@')[0] : '';
  const n = String(doJid || lead.telefone || '').replace(/\D/g, '');
  if (n.length < 10) return '';
  return n.length <= 11 ? `55${n}` : n;
};

// o evento que vai para a Meta (sem nada de texto de conversa)
function montarEvento(venda, lead, clique) {
  const quando = Math.min(Date.now(), new Date(venda.confirmadaEm || venda.data || venda.criadoEm).getTime() || Date.now());
  const fone = telefoneDe(lead);
  const nomes = sem(lead.nome || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const user = {
    ...(fone ? { ph: [sha(fone)] } : {}),
    ...(nomes[0] && !/^\d/.test(lead.nome || '') ? { fn: [sha(nomes[0])] } : {}),
    ...(nomes.length > 1 ? { ln: [sha(nomes[nomes.length - 1])] } : {}),
    country: [sha('br')],
    external_id: [sha(lead.id)],
    fbc: clique.fbc,
    ...(clique.fbp ? { fbp: clique.fbp } : {}),
    ...(clique.ip ? { client_ip_address: clique.ip } : {}),
    ...(clique.ua ? { client_user_agent: clique.ua } : {})
  };
  return {
    event_name: 'Purchase',
    event_time: Math.floor(quando / 1000),
    event_id: venda.id,
    // com o navegador do clique é evento "do site"; sem ele, gerado pelo sistema (CRM)
    action_source: clique.ua ? 'website' : 'system_generated',
    ...(clique.ua ? { event_source_url: clique.pagina } : {}),
    user_data: user,
    custom_data: { currency: 'BRL', value: Math.round(Number(venda.valor) * 100) / 100 }
  };
}

// por que esta venda NÃO vai (ou null se vai)
function motivoNaoEnviar(empresa, venda, c = configDa(empresa)) {
  if (venda.status !== 'confirmada') return 'venda ainda não confirmada';
  if (!(Number(venda.valor) > 0)) return 'venda sem valor';
  const ja = venda.metaAds;
  if (ja?.enviadoEm && (!ja.teste || c.codigoTeste)) return 'já enviada';
  if ((ja?.tentativas || 0) >= MAX_TENTATIVAS) return 'desistiu depois de 5 erros';
  const lead = venda.leadId && estado.conversas.find((l) => l.id === venda.leadId && l.empresaId === empresa.id);
  if (!lead) return 'venda sem conversa ligada';
  const clique = cliqueDo(lead);
  if (!clique) return 'cliente não veio de anúncio do Facebook/Instagram';
  const vendaMs = new Date(venda.confirmadaEm || venda.data || venda.criadoEm).getTime();
  if (vendaMs - new Date(clique.em).getTime() > DIAS_CLIQUE * 86400000) return 'venda mais de 30 dias depois do clique';
  if (Date.now() - vendaMs > DIAS_EVENTO * 86400000) return 'venda de mais de 7 dias (a Meta não aceita)';
  return null;
}

async function enviarEventos(c, eventos) {
  const corpo = { data: eventos, ...(c.codigoTeste ? { test_event_code: c.codigoTeste } : {}) };
  const r = await fetch(`${URL_GRAPH}/${encodeURIComponent(c.pixelId)}/events?access_token=${encodeURIComponent(c.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(20000)
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok || dados.error) {
    const e = dados.error || {};
    const err = new Error(String(e.error_user_msg || e.message || `HTTP ${r.status}`).replace(/access_token=[^&\s]+/g, 'access_token=[escondido]').slice(0, 240));
    err.status = r.status;
    throw err;
  }
  return dados;
}

const enviando = new Set();
async function enviarVenda(empresa, venda) {
  const c = configDa(empresa);
  if (!pronto(c) || enviando.has(venda.id)) return false;
  if (motivoNaoEnviar(empresa, venda, c)) return false;
  const lead = estado.conversas.find((l) => l.id === venda.leadId);
  enviando.add(venda.id);
  try {
    const r = await enviarEventos(c, [montarEvento(venda, lead, cliqueDo(lead))]);
    venda.metaAds = { enviadoEm: agora(), teste: Boolean(c.codigoTeste), recebidos: r.events_received ?? null, tentativas: (venda.metaAds?.tentativas || 0) + 1 };
    console.log(`[meta-ads ${empresa.id}] venda enviada${c.codigoTeste ? ' (teste)' : ''}`);
    return true;
  } catch (err) {
    // sem internet / Meta fora do ar: tenta de novo no próximo ciclo, sem gastar tentativa
    const rede = !err.status;
    if (rede) {
      venda.metaAds = { ...(venda.metaAds || {}), erro: 'sem conexão com a Meta agora — tenta de novo em 5 min', erroEm: agora() };
      return false;
    }
    venda.metaAds = { ...(venda.metaAds || {}), tentativas: (venda.metaAds?.tentativas || 0) + 1, erro: err.message, erroEm: agora() };
    console.error(`[meta-ads ${empresa.id}] não enviou: ${err.message}`);
    if (venda.metaAds.tentativas >= MAX_TENTATIVAS || err.status === 400 || err.status === 401 || err.status === 403) {
      require('./alertas').registrar(empresa, 'meta-ads', `Uma venda não foi para a Meta Ads: ${err.message}. Confira o Pixel e o token em Faturamento → Meta Ads.`, { nivel: 'aviso', leadId: lead?.id });
    }
    return false;
  } finally {
    enviando.delete(venda.id);
    salvar();
  }
}

let rodando = false;
async function verificar() {
  if (rodando) return 0;
  rodando = true;
  let n = 0;
  try {
    const limite = Date.now() - DIAS_EVENTO * 86400000;
    for (const empresa of estado.empresas) {
      if (!pronto(configDa(empresa))) continue;
      const vendas = (estado.vendas || []).filter((v) => v.empresaId === empresa.id && new Date(v.confirmadaEm || v.data || v.criadoEm).getTime() > limite);
      for (const v of vendas) if (await enviarVenda(empresa, v)) n++;
    }
  } catch (err) {
    console.error('[meta-ads]', err.message);
  } finally {
    rodando = false;
  }
  return n;
}

let timer = null;
function iniciar() {
  if (timer || process.env.META_ADS === 'nao') return;
  timer = setInterval(() => verificar().catch(() => {}), CICLO_MS);
  timer.unref?.();
}

// ---------------------------------------------------------------- painel

function paraPainel(empresa) {
  const c = configDa(empresa);
  const trinta = Date.now() - DIAS_CLIQUE * 86400000;
  const daEmpresa = estado.conversas.filter((l) => l.empresaId === empresa.id);
  const comClique = daEmpresa.filter((l) => {
    const k = cliqueDo(l);
    return k && new Date(k.em).getTime() > trinta;
  });
  const vendas = (estado.vendas || []).filter((v) => v.empresaId === empresa.id).sort((a, b) => ((b.confirmadaEm || b.criadoEm) > (a.confirmadaEm || a.criadoEm) ? 1 : -1));
  const recentes = vendas
    .filter((v) => v.metaAds || (v.leadId && comClique.some((l) => l.id === v.leadId)))
    .slice(0, 15)
    .map((v) => {
      const lead = daEmpresa.find((l) => l.id === v.leadId);
      const motivo = motivoNaoEnviar(empresa, v, c);
      return {
        cliente: lead?.nome || v.cliente || '',
        valor: v.valor,
        em: v.confirmadaEm || v.data || v.criadoEm,
        situacao: v.metaAds?.enviadoEm && (!v.metaAds.teste || c.codigoTeste) ? (v.metaAds.teste ? 'enviada (teste)' : 'enviada') : v.metaAds?.erro && motivo === null ? `erro: ${v.metaAds.erro}` : motivo || (pronto(c) ? 'na fila (sai em até 5 min)' : 'vai quando ligar'),
        enviadoEm: v.metaAds?.enviadoEm || null
      };
    });
  const clientes = comClique
    .map((l) => {
      const k = cliqueDo(l);
      const compras = vendas.filter((v) => v.leadId === l.id && v.status === 'confirmada' && new Date(v.confirmadaEm || v.data || v.criadoEm) >= new Date(k.em));
      let campanha = '';
      try {
        campanha = new URL(l.origemSite?.chegada?.url || '').searchParams.get('utm_campaign') || '';
      } catch { /* sem campanha */ }
      return { id: l.id, nome: l.nome || '', clicouEm: k.em, campanha: campanha.slice(0, 80), comprou: compras.reduce((s, v) => s + (Number(v.valor) || 0), 0) };
    })
    .sort((a, b) => (a.clicouEm < b.clicouEm ? 1 : -1))
    .slice(0, 50);
  return {
    clientes,
    ativo: c.ativo,
    pixelId: c.pixelId,
    tokenSalvo: Boolean(c.token),
    tokenFim: c.token ? c.token.slice(-4) : '',
    codigoTeste: c.codigoTeste,
    pronto: pronto(c),
    clientesComClique: comClique.length,
    enviadas: vendas.filter((v) => v.metaAds?.enviadoEm && !v.metaAds.teste).length,
    enviadasTeste: vendas.filter((v) => v.metaAds?.enviadoEm && v.metaAds.teste).length,
    recentes
  };
}

function salvarPainel(empresa, b = {}) {
  const atual = empresa.metaAds || {};
  const pixelId = b.pixelId !== undefined ? String(b.pixelId).replace(/\D/g, '') : atual.pixelId || '';
  if (b.pixelId !== undefined && pixelId && !/^\d{5,25}$/.test(pixelId)) throw Object.assign(new Error('O ID do Pixel (conjunto de dados) tem só números.'), { status: 400 });
  const token = b.token !== undefined && String(b.token).trim() ? String(b.token).trim() : atual.token || '';
  if (b.token !== undefined && String(b.token).trim() && (token.length < 20 || /\s/.test(token))) throw Object.assign(new Error('Esse token não parece certo: copie o token inteiro da API de Conversões.'), { status: 400 });
  const ativo = b.ativo !== undefined ? b.ativo === true : atual.ativo === true;
  if (ativo && (!pixelId || !token)) throw Object.assign(new Error('Para ligar, salve o ID do Pixel e o token.'), { status: 400 });
  empresa.metaAds = {
    ativo,
    pixelId,
    token,
    codigoTeste: b.codigoTeste !== undefined ? String(b.codigoTeste).trim().slice(0, 40) : atual.codigoTeste || '',
    ativadoEm: ativo && !atual.ativo ? agora() : atual.ativadoEm || null
  };
  if (b.apagarToken === true) empresa.metaAds = { ...empresa.metaAds, token: '', ativo: false };
  salvar();
  if (empresa.metaAds.ativo) setTimeout(() => verificar().catch(() => {}), 2000).unref?.();
  return paraPainel(empresa);
}

// testa o Pixel e o token sem mandar venda nenhuma (só lê o conjunto de dados)
async function testarConexao(empresa) {
  const c = configDa(empresa);
  if (!c.pixelId || !c.token) throw Object.assign(new Error('Salve o ID do Pixel e o token primeiro.'), { status: 400 });
  const r = await fetch(`${URL_GRAPH}/${encodeURIComponent(c.pixelId)}?fields=name&access_token=${encodeURIComponent(c.token)}`, { signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const msg = String(d.error?.message || `HTTP ${r.status}`).replace(/access_token=[^&\s]+/g, '').slice(0, 200);
    throw Object.assign(new Error(`A Meta recusou: ${msg}`), { status: 400 });
  }
  return { ok: true, nome: d.name || '' };
}

module.exports = { configDa, cliqueDo, montarEvento, motivoNaoEnviar, enviarVenda, verificar, iniciar, paraPainel, salvarPainel, testarConexao, telefoneDe };
