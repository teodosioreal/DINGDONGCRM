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
//
// Só vai a venda com TODOS os dados para a Meta ligar ao anúncio: o clique (fbclid → fbc) e o
// telefone do cliente. Sem o clique (o cliente não passou pelo site com o código do CRM) não vai.

const crypto = require('crypto');
const { estado, salvar, agora } = require('./db');
const { numeroDoAtendimento } = require('./util');

const DIAS_CLIQUE = 30; // a venda vale até 30 dias depois do clique no anúncio
const DIAS_EVENTO = 7; // a Meta só aceita eventos de até 7 dias atrás
const CICLO_MS = Number(process.env.META_ADS_CICLO_MS) || 5 * 60 * 1000; // de quanto em quanto confere se deu a hora
const ENVIO_MS = Number(process.env.META_ADS_ENVIO_MS) || 60 * 60 * 1000; // envia as vendas de hora em hora
const MAX_TENTATIVAS = 5;
const URL_GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const VERSAO_GRAPH = process.env.META_GRAPH_VERSAO || 'v23.0';

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function configDa(empresa) {
  const c = empresa?.metaAds || {};
  return {
    ativo: c.ativo === true,
    pixelId: String(c.pixelId || ''),
    token: String(c.token || ''),
    codigoTeste: String(c.codigoTeste || ''),
    // todas as vendas válidas: com o clique quando tem; sem ele, a Meta reconhece o cliente pelo telefone
    todasVendas: c.todasVendas === true,
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

// cliente sem o fbclid que passou pelo site: cookie do Pixel (o _fbc vale 90 dias), IP e navegador
function dadosDoNavegador(lead) {
  const o = lead?.origemSite || {};
  const nav = o.navegador || {};
  if (!nav.fbp && !nav.fbc && !nav.ua) return null;
  let pagina = '';
  try {
    const u = new URL(o.chegada?.url || o.primeira?.url || '');
    u.search = '';
    pagina = u.toString();
  } catch { /* sem página */ }
  return { fbc: nav.fbc || '', fbp: nav.fbp || '', ip: nav.ip || '', ua: pagina ? nav.ua || '' : '', pagina };
}

const telefoneDe = (lead) => {
  const doJid = /@s\.whatsapp\.net$/.test(lead.whatsappJid || '') ? lead.whatsappJid.split('@')[0] : '';
  const n = String(doJid || lead.telefone || '').replace(/\D/g, '');
  if (n.length < 10) return '';
  return n.length <= 11 ? `55${n}` : n;
};

// cidade e estado do cliente (ajudam a Meta a reconhecer a pessoa), só quando a localização é
// "Cidade - UF" e não foi chutada pelo DDD. Formato da Meta: minúsculas, sem acento nem espaço.
function cidadeEstado(lead) {
  const l = lead?.localizacao;
  if (!l?.texto || l.fonte === 'ddd') return {};
  const m = String(l.texto).match(/^(.{2,40}?)\s*[-–,/]\s*([A-Za-z]{2})$/);
  if (!m) return {};
  const cidade = sem(m[1]).toLowerCase().replace(/[^a-z]/g, '');
  return cidade ? { ct: [sha(cidade)], st: [sha(m[2].toLowerCase())] } : {};
}

// o evento que vai para a Meta (sem nada de texto de conversa)
function montarEvento(venda, lead, clique = null, valor = venda.valor) {
  clique = clique || {};
  const quando = Math.min(Date.now(), new Date(venda.confirmadaEm || venda.data || venda.criadoEm).getTime() || Date.now());
  const fone = telefoneDe(lead);
  const nomes = sem(lead.nome || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const user = {
    ...(fone ? { ph: [sha(fone)] } : {}),
    ...(nomes[0] && !/^\d/.test(lead.nome || '') ? { fn: [sha(nomes[0])] } : {}),
    ...(nomes.length > 1 ? { ln: [sha(nomes[nomes.length - 1])] } : {}),
    country: [sha('br')],
    ...cidadeEstado(lead),
    external_id: [sha(lead.id)],
    ...(clique.fbc ? { fbc: clique.fbc } : {}),
    ...(clique.fbp ? { fbp: clique.fbp } : {}),
    ...(clique.ip ? { client_ip_address: clique.ip } : {}),
    ...(clique.ua ? { client_user_agent: clique.ua } : {})
  };
  return {
    event_name: 'Purchase',
    event_time: Math.floor(quando / 1000),
    event_id: venda.id,
    // com o navegador do clique é evento "do site"; sem ele, a venda foi fechada na conversa
    // do WhatsApp ("chat" = conversão feita por aplicativo de mensagens, na definição da Meta)
    action_source: clique.ua ? 'website' : 'chat',
    ...(clique.ua ? { event_source_url: clique.pagina } : {}),
    user_data: user,
    custom_data: { currency: 'BRL', value: Math.round(Number(valor) * 100) / 100 }
  };
}

// por que esta venda NÃO vai (ou null se vai)
function motivoNaoEnviar(empresa, venda, c = configDa(empresa)) {
  if (venda.status !== 'confirmada') return 'venda ainda não confirmada';
  if (!(Number(venda.valor) > 0)) return 'venda sem valor';
  const ja = venda.metaAds;
  // já foi de verdade (com a Meta confirmando); envio de teste volta para a fila quando o código sai,
  // e envio sem confirmação da Meta tenta de novo (o event_id é o mesmo, a Meta não conta em dobro)
  if (ja?.enviadoEm && (!ja.teste || c.codigoTeste) && (ja.teste || ja.juntoCom || Number(ja.recebidos) >= 1)) return 'já enviada';
  if ((ja?.tentativas || 0) >= MAX_TENTATIVAS) return 'desistiu depois de 5 erros';
  const lead = venda.leadId && estado.conversas.find((l) => l.id === venda.leadId && l.empresaId === empresa.id);
  if (!lead) return 'venda sem conversa ligada';
  const clique = cliqueDo(lead);
  const vendaMs = new Date(venda.confirmadaEm || venda.data || venda.criadoEm).getTime();
  if (!clique && !c.todasVendas) return 'sem o clique do anúncio (fbclid): o cliente não passou pelo site com o código do CRM';
  if (!telefoneDe(lead)) return 'sem o telefone do cliente';
  if (clique && !c.todasVendas && vendaMs - new Date(clique.em).getTime() > DIAS_CLIQUE * 86400000) return 'venda mais de 30 dias depois do clique';
  if (Date.now() - vendaMs > DIAS_EVENTO * 86400000) return 'venda de mais de 7 dias (a Meta não aceita)';
  return null;
}

// erro da Meta em português, com o que fazer
function traduzirErro(e = {}, status = 0) {
  const original = String(e.error_user_msg || e.message || `HTTP ${status}`).replace(/access_token=[^&\s]+/g, 'access_token=[escondido]').replace(/\s+/g, ' ').trim();
  const codigo = e.code ? ` · código ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}` : '';
  const meta = ` (Meta${codigo}: ${original.slice(0, 220)})`;
  if (e.code === 190 || /access token|OAuth/i.test(original)) return `token inválido ou vencido — gere outro token no Pixel (Configurações → API de Conversões) e cole de novo${meta}`;
  if ((e.code === 100 && e.error_subcode === 33) || /does not exist|cannot be loaded due to missing permissions/i.test(original)) return `a Meta não achou esse Pixel com esse token — confira se o ID é do mesmo Pixel em que o token foi gerado${meta}`;
  if (e.code === 10 || e.code === 200 || /permission/i.test(original)) return `o token não tem permissão para enviar eventos nesse Pixel — gere o token dentro do próprio Pixel${meta}`;
  if (/test_event_code|test event/i.test(original)) return `código de teste inválido — copie de novo na aba Eventos de teste do Pixel${meta}`;
  return `o evento foi recusado${meta}`;
}

const versaoRecusada = (e = {}) => e.code === 2635 || /version|Unknown path components/i.test(String(e.message || ''));

async function enviarEventos(c, eventos) {
  const corpo = { data: eventos, ...(c.codigoTeste ? { test_event_code: c.codigoTeste } : {}) };
  const chamar = (versao) => fetch(`${URL_GRAPH}/${versao ? `${versao}/` : ''}${encodeURIComponent(c.pixelId)}/events?access_token=${encodeURIComponent(c.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(20000)
  });
  let r = await chamar(VERSAO_GRAPH);
  let dados = await r.json().catch(() => ({}));
  // versão da API que a Meta não aceita mais: tenta na versão padrão da conta
  if (dados.error && versaoRecusada(dados.error)) {
    r = await chamar('');
    dados = await r.json().catch(() => ({}));
  }
  if (!r.ok || dados.error) {
    const err = new Error(traduzirErro(dados.error || {}, r.status));
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
  // pagamentos do mesmo cliente no mesmo dia (sinal + restante) vão juntos, como UMA compra;
  // quem envia é a primeira venda do grupo, depois da espera (dá tempo do comprovante chegar)
  const grupo = grupoDaVenda(empresa, venda, c);
  if (grupo[0].id !== venda.id || Date.now() < esperaDoGrupo(grupo)) return false;
  const lead = estado.conversas.find((l) => l.id === venda.leadId);
  for (const v of grupo) enviando.add(v.id);
  try {
    // com o clique do anúncio quando tem; sem ele, o que o site guardou do navegador (cookie do Pixel, IP)
    const k = cliqueDo(lead) || dadosDoNavegador(lead);
    const total = Math.round(grupo.reduce((t, v) => t + (Number(v.valor) || 0), 0) * 100) / 100;
    const evento = montarEvento(venda, lead, k, total);
    const r = await enviarEventos(c, [evento]);
    // a Meta responde events_received = quantos eventos aceitou; sem isso, NÃO foi
    if (!(Number(r.events_received) >= 1)) {
      const err = new Error(`a Meta respondeu sem confirmar o recebimento (events_received: ${r.events_received ?? 'vazio'})${r.fbtrace_id ? ` · fbtrace ${String(r.fbtrace_id).slice(0, 40)}` : ''}`);
      err.status = 502;
      throw err;
    }
    const u = evento.user_data;
    // a prova: o que a Meta respondeu e quais dados foram (para conferir no painel)
    const prova = {
      enviadoEm: agora(),
      teste: Boolean(c.codigoTeste),
      recebidos: r.events_received ?? null,
      fbtrace: String(r.fbtrace_id || '').slice(0, 40),
      ...(Array.isArray(r.messages) && r.messages.length ? { avisosMeta: r.messages.map((x) => String(x).slice(0, 200)).slice(0, 5) } : {}),
      fonte: evento.action_source,
      comClique: Boolean(cliqueDo(lead)), // false = foi pelo telefone (modo todas as vendas)
      dados: { clique: Boolean(u.fbc), telefone: Boolean(u.ph), nome: Boolean(u.fn), ip: Boolean(u.client_ip_address), navegador: Boolean(u.client_user_agent), pixelDoSite: Boolean(u.fbp) },
      valorEnviado: total,
      ...(grupo.length > 1 ? { grupo: grupo.map((v) => v.id) } : {})
    };
    for (const v of grupo) v.metaAds = { ...prova, ...(v.id !== venda.id ? { juntoCom: venda.id } : {}), tentativas: (v.metaAds?.tentativas || 0) + 1 };
    console.log(`[meta-ads ${empresa.id}] venda enviada${grupo.length > 1 ? ` (${grupo.length} pagamentos juntos)` : ''}${c.codigoTeste ? ' (teste)' : ''}`);
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
    for (const v of grupo) enviando.delete(v.id);
    salvar();
  }
}

// ---------------------------------------------------------------- espera e grupo
// venda com comprovante espera 3 h (junta sinal + restante do mesmo dia); sem comprovante
// (IA, frase, à mão) espera 6 h: dá tempo do comprovante chegar e corrigir o valor
const msDoAmbiente = (nome, padrao) => (/^\d+$/.test(process.env[nome] || '') ? Number(process.env[nome]) : padrao);
const ESPERA_COM_COMPROVANTE_MS = msDoAmbiente('META_ADS_ESPERA_COM_MS', 3 * 3600 * 1000);
const ESPERA_SEM_COMPROVANTE_MS = msDoAmbiente('META_ADS_ESPERA_SEM_MS', 6 * 3600 * 1000);
const temComprovante = (v) => v.origem === 'comprovante' || Boolean(v.idTransacao || v.anexo);
const quandoDa = (v) => new Date(v.confirmadaEm || v.data || v.criadoEm).getTime() || Date.now();
const diaSP = (ms) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
// de onde veio o valor da venda (para conferir no painel)
function origemDoValor(v) {
  if (temComprovante(v)) return { tipo: 'comprovante', texto: `📄 comprovante${v.lidoPor === 'ocr' ? ' (foto)' : v.lidoPor === 'ia' ? ' (lido pela IA)' : v.lidoPor === 'texto' ? ' (PDF)' : ''}` };
  if (v.origem === 'ia' || v.lidoPor === 'ia-conversa') return { tipo: 'ia', texto: '🤖 IA na conversa (sem comprovante)' };
  if (v.origem === 'frase' || v.lidoPor === 'frase') return { tipo: 'frase', texto: '💬 frase de venda da equipe (sem comprovante)' };
  return { tipo: 'manual', texto: '✍️ lançada à mão' };
}
// as vendas ainda não enviadas do mesmo cliente no mesmo dia que podem ir (em ordem)
function grupoDaVenda(empresa, venda, c = configDa(empresa)) {
  if (!venda.leadId) return [venda];
  const dia = diaSP(quandoDa(venda));
  return (estado.vendas || [])
    .filter((v) => v.empresaId === empresa.id && v.leadId === venda.leadId && diaSP(quandoDa(v)) === dia && (v.id === venda.id || motivoNaoEnviar(empresa, v, c) === null))
    .sort((a, b) => quandoDa(a) - quandoDa(b) || (a.id < b.id ? -1 : 1));
}
const esperaDoGrupo = (grupo) => Math.max(...grupo.map((v) => quandoDa(v) + (temComprovante(v) ? ESPERA_COM_COMPROVANTE_MS : ESPERA_SEM_COMPROVANTE_MS)));
const horaSP = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// venda que vai, mas ainda está na espera: até quando e por quê (ou null)
function esperaDaVenda(empresa, v, c = configDa(empresa)) {
  if (v.metaAds?.enviadoEm || motivoNaoEnviar(empresa, v, c) !== null) return null;
  const grupo = grupoDaVenda(empresa, v, c);
  const ate = esperaDoGrupo(grupo);
  if (Date.now() >= ate) return null;
  const sem = grupo.some((x) => !temComprovante(x));
  return { ate: new Date(ate).toISOString(), texto: `esperando até ${horaSP(ate)} ${sem ? '(sem comprovante: dá tempo do comprovante chegar e corrigir o valor)' : '(junta outro pagamento do mesmo dia, se vier)'}${grupo.length > 1 ? ` · vai junto com ${grupo.length - 1} outro(s) pagamento(s) do dia` : ''}` };
}

let rodando = false;
// envia as vendas prontas. soDaHora: só as empresas cujo último envio foi há 1 hora ou mais
// (a hora fica salva: reiniciar o CRM não atrasa nem adianta o envio). empresaId: só uma empresa
async function verificar({ soDaHora = false, empresaId = null } = {}) {
  if (rodando) return 0;
  rodando = true;
  let n = 0;
  try {
    const limite = Date.now() - DIAS_EVENTO * 86400000;
    for (const empresa of estado.empresas) {
      if (empresaId && empresa.id !== empresaId) continue;
      if (!pronto(configDa(empresa))) continue;
      if (soDaHora && Date.now() - new Date(empresa.metaAdsCiclo?.em || 0).getTime() < ENVIO_MS) continue;
      const vendas = (estado.vendas || []).filter((v) => v.empresaId === empresa.id && new Date(v.confirmadaEm || v.data || v.criadoEm).getTime() > limite);
      let daEmpresa = 0;
      for (const v of vendas) if (await enviarVenda(empresa, v)) daEmpresa++;
      n += daEmpresa;
      empresa.metaAdsCiclo = { em: agora(), enviadas: daEmpresa };
      salvar();
      if (daEmpresa) console.log(`[meta-ads ${empresa.id}] envio da hora: ${daEmpresa} venda(s) enviada(s)`);
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
  timer = setInterval(() => verificar({ soDaHora: true }).catch(() => {}), CICLO_MS);
  timer.unref?.();
}

// ---------------------------------------------------------------- painel

// Como a venda está na Meta, sem enfeitar:
//  'enviada'            a Meta confirmou e foi com o clique do anúncio (dá para ligar à campanha)
//  'enviada-sem-clique' a Meta confirmou, mas sem o clique: conta no Gerenciador de Eventos e
//                       normalmente NÃO aparece como compra da campanha no Gerenciador de Anúncios
//  'teste'              foi só para "Eventos de teste" (não conta na campanha)
//  'sem-confirmacao'    saiu, mas a Meta não confirmou o recebimento (envios antigos)
//  null                 não foi
function estadoDoEnvio(v) {
  const m = v.metaAds;
  if (!m?.enviadoEm) return null;
  if (m.teste) return 'teste';
  if (!(Number(m.recebidos) >= 1) && !m.juntoCom) return 'sem-confirmacao';
  return m.comClique || m.dados?.clique ? 'enviada' : 'enviada-sem-clique';
}

// texto da situação de uma venda na Meta (com a confirmação da Meta quando foi)
function situacaoDaVenda(v, motivo, c, empresa = null) {
  const m = v.metaAds;
  if (m?.enviadoEm && m.juntoCom && (!m.teste || c.codigoTeste)) {
    return `enviada junto com outro pagamento do mesmo dia (uma compra de R$ ${Number(m.valorEnviado || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}) ${horaSP(new Date(m.enviadoEm).getTime())}`;
  }
  if (m?.enviadoEm && m.teste) {
    return `foi só para "Eventos de teste" em ${new Date(m.enviadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — NÃO conta na campanha.${c.codigoTeste ? ' Apague o código de teste e salve: ela vai de verdade no próximo envio (se tiver até 7 dias).' : ' Vai de verdade no próximo envio, se tiver até 7 dias.'}`;
  }
  if (m?.enviadoEm) {
    const conf = Number(m.recebidos) >= 1 ? ` · a Meta confirmou o recebimento${m.fbtrace ? ` (fbtrace ${m.fbtrace})` : ''}` : ' · a Meta NÃO confirmou o recebimento';
    const como = m.comClique === false ? ' pelo telefone, sem o clique do anúncio' : m.comClique ? ' com o clique do anúncio' : '';
    const soma = m.grupo?.length > 1 ? ` · ${m.grupo.length} pagamentos do dia numa compra de R$ ${Number(m.valorEnviado || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '';
    const semClique = estadoDoEnvio(v) === 'enviada-sem-clique' ? ' · sem o clique: a compra está no Gerenciador de Eventos e só entra na campanha se a Meta reconhecer o cliente (pelo telefone e nome) entre quem viu ou clicou no anúncio' : '';
    const avisos = m.avisosMeta?.length ? ` · aviso da Meta: ${m.avisosMeta.join(' / ')}` : '';
    return `enviada${como}${soma} ${new Date(m.enviadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${conf}${avisos}${semClique}`;
  }
  if (m?.erro && motivo === null) return `não foi: ${m.erro}${(m.tentativas || 0) < MAX_TENTATIVAS ? ` · o CRM tenta de novo no próximo envio (tentativa ${m.tentativas || 0} de ${MAX_TENTATIVAS})` : ''}`;
  const espera = motivo === null && empresa ? esperaDaVenda(empresa, v, c) : null;
  if (espera) return espera.texto;
  return motivo || (pronto(c) ? 'pronta: vai no próximo envio (de hora em hora)' : 'vai quando ligar o envio');
}

// Bloco "📣 Meta Ads" da conversa: o clique do anúncio deste cliente e as vendas dele na Meta
function paraConversa(empresa, lead) {
  const o = lead?.origemSite || {};
  const k = cliqueDo(lead);
  const zap = o.anuncioMeta || null; // anúncio de clique para o WhatsApp (sem passar pelo site)
  // UTMs da página de chegada (campanha, conjunto, anúncio)
  let utm = {};
  let pagina = '';
  try {
    const u = new URL(o.chegada?.url || o.primeira?.url || '');
    for (const c of ['source', 'medium', 'campaign', 'content', 'term']) utm[c] = (u.searchParams.get(`utm_${c}`) || '').slice(0, 80);
    pagina = (u.pathname || '/').slice(0, 80);
  } catch { /* sem página de chegada */ }
  const daMeta = /^(fb|facebook|ig|insta|instagram|meta)/i.test(utm.source || '') || /facebook|instagram|meta/i.test(o.classificacao?.fonte || '');
  if (!k && !zap && !daMeta) return null;
  const c = configDa(empresa);
  const nav = o.navegador || {};
  const vendas = (estado.vendas || [])
    .filter((v) => v.empresaId === empresa.id && v.leadId === lead.id && v.status !== 'cancelada')
    .map((v) => ({ valor: v.valor, em: v.confirmadaEm || v.data || v.criadoEm, situacao: situacaoDaVenda(v, motivoNaoEnviar(empresa, v, c), c, empresa) }));
  // se este cliente comprar hoje, a venda vai para a Meta?
  const ate = k ? new Date(new Date(k.em).getTime() + DIAS_CLIQUE * 86400000).toISOString() : null;
  const peloTelefone = !k && c.todasVendas && Boolean(telefoneDe(lead));
  const naoVai = peloTelefone ? null : !k
    ? (zap ? 'veio de anúncio direto para o WhatsApp (sem passar pelo site), não tem o fbclid' : 'não tem o fbclid do clique (chegou sem passar pelo código do site)')
    : !telefoneDe(lead) ? 'sem o telefone do cliente'
    : Date.now() > new Date(ate).getTime() ? 'o clique tem mais de 30 dias'
    : null;
  return {
    via: k ? 'site' : zap ? 'whatsapp' : 'utm',
    fbclid: k?.fbclid || '',
    clicouEm: k?.em || zap?.em || o.chegada?.em || null,
    campanha: utm.campaign || '',
    conjunto: utm.term || '',
    anuncio: utm.content || '',
    origem: [utm.source, utm.medium].filter(Boolean).join(' / '),
    pagina,
    anuncioZap: zap ? { titulo: zap.titulo || '', id: zap.id || '' } : null,
    dados: { clique: Boolean(k), telefone: Boolean(telefoneDe(lead)), nome: Boolean(lead.nome && !/^\d/.test(lead.nome)), pixelDoSite: Boolean(nav.fbp || nav.fbc), ipNavegador: Boolean(nav.ip && nav.ua) },
    temPixelDoSite: Boolean(k?.fbp),
    ligado: pronto(c),
    vaiAte: naoVai || peloTelefone ? null : ate,
    peloTelefone,
    naoVai,
    vendas
  };
}

// o site carregou o código do CRM? (só na memória: mostra no painel se está instalado)
const vistoNoSite = new Map(); // empresaId → { ok: {em, host}, bloqueado: {em, host, motivo} }
function siteVisto(empresaId, host, bloqueado, motivo) {
  const v = vistoNoSite.get(empresaId) || {};
  v[bloqueado ? 'bloqueado' : 'ok'] = { em: agora(), host: String(host || '').slice(0, 80), motivo: bloqueado ? motivo : undefined };
  vistoNoSite.set(empresaId, v);
}
function situacaoDoSite(empresa) {
  const ativos = estado.bots.filter((b) => b.empresaId === empresa.id && b.ativo !== false);
  const bots = ativos.length ? ativos : estado.bots.filter((b) => b.empresaId === empresa.id);
  const principal = bots.find((b) => b.principal) || bots[0];
  return {
    assistente: Boolean(principal),
    chatLigado: ativos.length > 0,
    whatsapp: Boolean(principal && numeroDoAtendimento(principal, empresa)),
    dominios: [...new Set(bots.flatMap((b) => b.dominios || []))],
    visto: vistoNoSite.get(empresa.id) || null
  };
}

// cada critério de uma venda (todos, não só o primeiro que falta) — para mapear o que chega
function criteriosDaVenda(empresa, v, lead, todas = configDa(empresa).todasVendas) {
  const clique = lead ? cliqueDo(lead) : null;
  const vendaMs = new Date(v.confirmadaEm || v.data || v.criadoEm).getTime();
  const nav = lead?.origemSite?.navegador || {};
  return {
    obrigatorios: [
      ['confirmada', v.status === 'confirmada'],
      ['com valor', Number(v.valor) > 0],
      ...(todas ? [] : [['clique do anúncio (fbclid)', Boolean(clique)]]),
      ['telefone', Boolean(lead && telefoneDe(lead))],
      ...(todas ? [] : [['até 30 dias do clique', Boolean(clique) && vendaMs - new Date(clique.em).getTime() <= DIAS_CLIQUE * 86400000]]),
      ['até 7 dias (prazo da Meta)', Date.now() - vendaMs <= DIAS_EVENTO * 86400000 || Boolean(v.metaAds?.enviadoEm)]
    ],
    extras: [
      ...(todas ? [['clique do anúncio (fbclid)', Boolean(clique)]] : []),
      ['nome', Boolean(lead?.nome && !/^\d/.test(lead.nome))],
      ['cookie do Pixel', Boolean(nav.fbp || nav.fbc)],
      ['IP e navegador', Boolean(nav.ip && nav.ua)],
      ...(lead?.origemSite?.anuncioMeta && !clique ? [['veio de anúncio "clique para WhatsApp" (sem o fbclid do site)', true]] : [])
    ]
  };
}

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
    .filter((v) => v.metaAds || c.todasVendas || (v.leadId && comClique.some((l) => l.id === v.leadId)))
    .filter((v) => v.status === 'confirmada' || v.metaAds)
    .slice(0, 15)
    .map((v) => {
      const lead = daEmpresa.find((l) => l.id === v.leadId);
      const motivo = motivoNaoEnviar(empresa, v, c);
      return {
        cliente: lead?.nome || v.cliente || '',
        valor: v.valor,
        em: v.confirmadaEm || v.data || v.criadoEm,
        situacao: situacaoDaVenda(v, motivo, c, empresa),
        recebidos: v.metaAds?.recebidos ?? null,
        dados: v.metaAds?.dados || null,
        enviadoEm: v.metaAds?.enviadoEm || null
      };
    });
  // vendas de clientes que vieram do anúncio (+ as já enviadas): critérios e situação de cada uma
  const comCliqueIds = new Set(daEmpresa.filter((l) => cliqueDo(l)).map((l) => l.id));
  const desde = Date.now() - DIAS_CLIQUE * 86400000;
  const doPeriodo = vendas.filter((v) => v.status !== 'cancelada' && new Date(v.confirmadaEm || v.data || v.criadoEm).getTime() > desde);
  const criterios = doPeriodo
    .filter((v) => c.todasVendas || comCliqueIds.has(v.leadId) || v.metaAds?.enviadoEm)
    .slice(0, 40)
    .map((v) => {
      const lead = daEmpresa.find((l) => l.id === v.leadId);
      const motivo = motivoNaoEnviar(empresa, v, c);
      const envio = estadoDoEnvio(v);
      // envio de teste com o código já apagado: volta para a fila (vai de verdade)
      const enviada = envio && !(envio === 'teste' && !c.codigoTeste) ? envio : null;
      return {
        leadId: lead?.id || null,
        cliente: lead?.nome || v.cliente || '',
        valor: v.valor,
        em: v.confirmadaEm || v.data || v.criadoEm,
        ...criteriosDaVenda(empresa, v, lead, c.todasVendas),
        comClique: comCliqueIds.has(v.leadId),
        // deu erro no último envio: vermelho até ir de verdade (o CRM tenta de novo sozinho)
        status: enviada || (v.metaAds?.erro && motivo === null && pronto(c) ? 'erro' : null) || (motivo === null ? (!pronto(c) ? 'desligado' : esperaDaVenda(empresa, v, c) ? 'esperando' : 'pronta') : v.metaAds?.erro ? 'erro' : 'nao-vai'),
        anuncioZap: Boolean(lead?.origemSite?.anuncioMeta) && !cliqueDo(lead),
        origemValor: origemDoValor(v).texto,
        valorEnviado: v.metaAds?.enviadoEm ? v.metaAds.valorEnviado ?? null : null,
        situacao: situacaoDaVenda(v, motivo, c, empresa),
        recebidos: v.metaAds?.recebidos ?? null
      };
    });
  const semClique = c.todasVendas ? 0 : doPeriodo.filter((v) => v.status === 'confirmada' && !comCliqueIds.has(v.leadId) && !v.metaAds?.enviadoEm).length;
  const ciclo = empresa.metaAdsCiclo || null;
  const clientes = comClique
    .map((l) => {
      const k = cliqueDo(l);
      const compras = vendas.filter((v) => v.leadId === l.id && v.status === 'confirmada' && new Date(v.confirmadaEm || v.data || v.criadoEm) >= new Date(k.em));
      let campanha = '';
      try {
        campanha = new URL(l.origemSite?.chegada?.url || '').searchParams.get('utm_campaign') || '';
      } catch { /* sem campanha */ }
      return { id: l.id, nome: l.nome || '', clicouEm: k.em, fbclid: k.fbclid, campanha: campanha.slice(0, 80), comprou: compras.reduce((s, v) => s + (Number(v.valor) || 0), 0) };
    })
    .sort((a, b) => (a.clicouEm < b.clicouEm ? 1 : -1))
    .slice(0, 50);
  return {
    testes: empresa.metaAdsTeste || {},
    clientes,
    ativo: c.ativo,
    pixelId: c.pixelId,
    tokenSalvo: Boolean(c.token),
    tokenFim: c.token ? c.token.slice(-4) : '',
    codigoTeste: c.codigoTeste,
    todasVendas: c.todasVendas,
    pronto: pronto(c),
    clientesComClique: comClique.length,
    // o código do CRM está no site? (sem ele o CRM nunca recebe o fbclid)
    chegadasDoSite30d: daEmpresa.filter((l) => l.origemSite?.chegada && new Date(l.origemSite.chegada.em || l.criadoEm).getTime() > trinta).length,
    site: { ...situacaoDoSite(empresa), teste: empresa.metaAdsSite || null },
    criterios,
    semClique,
    envio: { ultimo: ciclo?.em || null, enviadasNoUltimo: ciclo?.enviadas ?? null, proximo: ciclo?.em ? new Date(Math.max(Date.now(), new Date(ciclo.em).getTime() + ENVIO_MS)).toISOString() : null, aCadaMin: Math.round(ENVIO_MS / 60000) },
    // cliques no WhatsApp do site: quantos chegaram como conversa (com o código ou pelo horário)
    caminho: require('./origem').resumoVisitas(empresa.id),
    enviadas: vendas.filter((v) => ['enviada', 'enviada-sem-clique'].includes(estadoDoEnvio(v))).length,
    enviadasComClique: vendas.filter((v) => estadoDoEnvio(v) === 'enviada').length,
    enviadasSemClique: vendas.filter((v) => estadoDoEnvio(v) === 'enviada-sem-clique').length,
    semConfirmacao: vendas.filter((v) => estadoDoEnvio(v) === 'sem-confirmacao').length,
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
    todasVendas: b.todasVendas !== undefined ? b.todasVendas === true : atual.todasVendas === true,
    ativadoEm: ativo && !atual.ativo ? agora() : atual.ativadoEm || null
  };
  if (b.apagarToken === true) empresa.metaAds = { ...empresa.metaAds, token: '', ativo: false };
  // trocou o Pixel ou o token: os testes feitos antes não valem mais
  if (empresa.metaAds.pixelId !== (atual.pixelId || '') || empresa.metaAds.token !== (atual.token || '')) delete empresa.metaAdsTeste;
  salvar();
  if (empresa.metaAds.ativo) setTimeout(() => verificar({ empresaId: empresa.id }).catch(() => {}), 2000).unref?.();
  return paraPainel(empresa);
}

// testa o Pixel e o token sem mandar venda nenhuma (só lê o conjunto de dados)
const marcarTeste = (empresa, chave, dados) => {
  empresa.metaAdsTeste = { ...(empresa.metaAdsTeste || {}), [chave]: { ...dados, em: agora() } };
  salvar();
};

// 🔎 Testar o site: abre a página (como um visitante) e procura o código do CRM desta empresa
const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const mesmoNumero = (a, b) => {
  a = soDigitos(a); b = soDigitos(b);
  return Boolean(a && b) && (a === b || a.slice(-8) === b.slice(-8));
};
async function testarSite(empresa, endereco) {
  let url = String(endereco || '').trim().slice(0, 500);
  if (!url) throw Object.assign(new Error('Digite o endereço do seu site (ex.: www.minhaloja.com.br).'), { status: 400 });
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const { hostDe, dominioPermitido } = require('./util');
  const host = hostDe(url);
  if (!host || (!host.includes('.') && host !== 'localhost')) throw Object.assign(new Error('Endereço inválido. Ex.: www.minhaloja.com.br'), { status: 400 });
  const ativos = estado.bots.filter((b) => b.empresaId === empresa.id && b.ativo !== false);
  const bots = ativos.length ? ativos : estado.bots.filter((b) => b.empresaId === empresa.id);
  const principal = bots.find((b) => b.principal) || bots[0];
  const res = { url, host, em: agora(), itens: [] };
  const item = (ok, texto) => res.itens.push({ ok, texto });
  let html;
  try {
    html = await require('./origem').baixarHtml(url);
  } catch (err) {
    res.ok = false;
    item(false, `Não consegui abrir o site (${String(err.message || err).slice(0, 80)}). Confira o endereço e se o site está no ar.`);
    empresa.metaAdsSite = res;
    salvar();
    return res;
  }
  const tags = html.match(/<script\b[^>]*chat\.js[^>]*>/gi) || [];
  const attr = (tag, nome) => (tag.match(new RegExp(`${nome}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1] || '';
  const daEmpresa = tags.filter((t) => attr(t, 'data-empresa') === empresa.id || bots.some((b) => b.id === attr(t, 'data-bot')) || estado.bots.some((b) => b.id === attr(t, 'data-bot') && b.empresaId === empresa.id));
  const deOutra = tags.filter((t) => !daEmpresa.includes(t) && (attr(t, 'data-empresa') || attr(t, 'data-bot')));
  if (daEmpresa.length) {
    const t = daEmpresa[0];
    item(true, `Código do CRM encontrado na página${/data-chat\s*=\s*["']nao["']/i.test(t) ? ' (só rastrear, sem chat)' : ' (com o chat da IA)'}${daEmpresa.length > 1 ? ` — está colado ${daEmpresa.length} vezes, deixe só um` : ''}.`);
    if (!/odingdong\.tech|\/crm\/chat\.js/i.test(attr(t, 'src'))) item(null, 'O endereço do script parece diferente do código do CRM — copie de novo daqui.');
  } else if (deOutra.length) {
    item(false, 'Achei um código do CRM, mas de OUTRA empresa (o ID não é desta). Copie o código desta aba e troque no site.');
  } else if (/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i.test(html)) {
    item(null, 'Não achei o código no HTML da página. O site usa o Gerenciador de Tags do Google: se você colocou o código por lá, abra o site no navegador e recarregue esta aba — deve aparecer "Código instalado: o site carregou…".');
  } else {
    item(false, 'O código do CRM NÃO está nesta página. Cole a linha antes de </body> e publique o site (se usa cache/CDN, limpe o cache).');
  }
  if (!principal) item(false, 'A empresa não tem assistente — crie em IA do site (pode ser só para rastrear).');
  else if (!ativos.length && daEmpresa.length && !/data-chat\s*=\s*["']nao["']/i.test(daEmpresa[0])) item(null, 'O chat da IA do site está desligado: o código rastreia o anúncio, mas a janelinha do chat não aparece.');
  else if (!dominioPermitido(principal, url) && !bots.some((b) => (b.dominios || []).length && dominioPermitido(b, url))) item(false, `O site ${host} não está na lista de domínios do assistente do site (${(principal.dominios || []).join(', ')}). Adicione ${host} em IA do site.`);
  // botões de WhatsApp da página: precisam ser do mesmo número do assistente para levar o código
  const numero = principal && numeroDoAtendimento(principal, empresa);
  const links = [...new Set((html.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=|whatsapp\.com\/send\?phone=)\+?\d{8,15}/gi) || []).map((l) => soDigitos(l.split(/wa\.me\/|phone=/i)[1])))];
  if (links.length && numero) {
    const iguais = links.filter((n) => mesmoNumero(n, numero));
    if (iguais.length === links.length) item(true, `Botão de WhatsApp da página é do mesmo número do CRM (…${soDigitos(numero).slice(-4)}): ele vai levar o código do atendimento.`);
    else item(false, `Achei botão de WhatsApp com número diferente do CRM (site: …${links.filter((n) => !mesmoNumero(n, numero)).map((n) => n.slice(-4)).join(', …')}; CRM: …${soDigitos(numero).slice(-4)}). Esse botão não leva o código — use o mesmo número.`);
  } else if (!links.length) {
    item(null, 'Não achei link de WhatsApp no HTML (pode ser montado por script ou estar em outra página). Tudo bem se o botão abre o WhatsApp do mesmo número do CRM.');
  }
  res.ok = res.itens.every((i) => i.ok !== false) && res.itens.some((i) => i.ok === true);
  empresa.metaAdsSite = res;
  salvar();
  return res;
}

// evento de teste que nunca conta na campanha (vai só para "Eventos de teste" do Pixel)
function eventoDeTeste(req, nome, valor) {
  const id = `teste-${Date.now()}`;
  return {
    event_name: nome,
    event_time: Math.floor(Date.now() / 1000),
    event_id: id,
    action_source: 'website',
    event_source_url: `${require('./config').urlPublica || 'https://odingdong.tech/crm'}/`,
    user_data: {
      country: [sha('br')],
    ...cidadeEstado(lead),
      external_id: [sha(id)],
      client_ip_address: String(req?.ip || '').replace(/^::ffff:/, '') || '127.0.0.1',
      client_user_agent: String(req?.get?.('user-agent') || 'DingDong CRM').slice(0, 400)
    },
    ...(valor ? { custom_data: { currency: 'BRL', value: valor } } : {})
  };
}

// Testa o Pixel e o token do jeito que o CRM usa de verdade: ENVIANDO um evento de teste.
// (Ler os dados do Pixel não serve: o token da API de Conversões costuma só ter permissão de enviar.)
// Sem código de teste, usa um código próprio — o evento não conta na campanha de jeito nenhum.
async function testarConexao(empresa, req) {
  const c = configDa(empresa);
  if (!c.pixelId || !c.token) throw Object.assign(new Error('Salve o ID do Pixel e o token primeiro.'), { status: 400 });
  try {
    const r = await enviarEventos({ ...c, codigoTeste: c.codigoTeste || 'TESTCRM' }, [eventoDeTeste(req, 'PageView')]);
    marcarTeste(empresa, 'conexao', { ok: true, nome: '' });
    return { ok: true, recebidos: r.events_received ?? 1 };
  } catch (err) {
    const erro = err.status ? err.message : 'sem conexão com a Meta agora — tente de novo em instantes';
    marcarTeste(empresa, 'conexao', { ok: false, erro });
    throw Object.assign(new Error(`A Meta recusou: ${erro}.`), { status: 400 });
  }
}

// compra de TESTE (R$ 1,00) só para "Eventos de teste" do Pixel: confere o caminho inteiro
// sem venda de verdade e sem contar na campanha (exige o código de teste)
async function enviarCompraTeste(empresa, req) {
  const c = configDa(empresa);
  if (!c.pixelId || !c.token) throw Object.assign(new Error('Salve o ID do Pixel e o token primeiro.'), { status: 400 });
  if (!c.codigoTeste) throw Object.assign(new Error('Cole o código de teste (aba "Eventos de teste" do Pixel) e salve antes — sem ele a compra de teste contaria na campanha.'), { status: 400 });
  const evento = eventoDeTeste(req, 'Purchase', 1);
  try {
    const r = await enviarEventos(c, [evento]);
    marcarTeste(empresa, 'evento', { ok: true, codigo: c.codigoTeste });
    return { ok: true, recebidos: r.events_received ?? 1, codigo: c.codigoTeste };
  } catch (err) {
    marcarTeste(empresa, 'evento', { ok: false, erro: err.message });
    throw Object.assign(new Error(err.status ? `A Meta recusou: ${err.message}.` : 'Não consegui falar com a Meta agora (sem conexão). Tente de novo em instantes.'), { status: 400 });
  }
}

module.exports = { testarSite, siteVisto, configDa, paraConversa, cliqueDo, montarEvento, motivoNaoEnviar, enviarVenda, verificar, iniciar, paraPainel, salvarPainel, testarConexao, enviarCompraTeste, telefoneDe };
