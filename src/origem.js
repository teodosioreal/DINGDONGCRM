// origem.js — de onde o cliente veio e em que página do site ele está.
//
// O widget (chat.js) anota no navegador do visitante como ele chegou ao site
// (Google, Instagram, anúncio, campanha UTM…) e as páginas que ele abriu.
// Isso vai junto com cada mensagem do chat — ou com o clique no botão do
// WhatsApp do site — e fica guardado no lead. As duas IAs (site e WhatsApp)
// recebem esse contexto e, se ligado, um resumo do texto da página onde o
// cliente está, para entender o que ele estava olhando.

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { estado, salvar, agora } = require('./db');
const { hostDe } = require('./util');

const MAX_PAGINAS = 15;
const MAX_VISITAS = 5000;
const VISITA_VALIDA_MS = 7 * 24 * 3600 * 1000;

// ---------------------------------------------------------------- limpeza do que o widget manda

const txt = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function urlLimpa(v) {
  const s = txt(v, 600);
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.toString().slice(0, 500);
  } catch {
    return '';
  }
}

function pagina(p) {
  if (!p || typeof p !== 'object') return null;
  const url = urlLimpa(p.url);
  if (!url) return null;
  return { url, titulo: txt(p.titulo, 160), em: typeof p.em === 'number' ? new Date(p.em).toISOString() : agora() };
}

const CAMPOS_UTM = ['source', 'medium', 'campaign', 'term', 'content'];
const CAMPOS_CLID = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'];

function chegada(c) {
  if (!c || typeof c !== 'object') return null;
  const url = urlLimpa(c.url);
  if (!url) return null;
  const utm = {};
  const clid = {};
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  for (const k of CAMPOS_UTM) {
    const v = txt(c.utm?.[k] || params.get(`utm_${k}`), 120);
    if (v) utm[k] = v;
  }
  for (const k of CAMPOS_CLID) if (c.clid?.[k] || params.get(k)) clid[k] = true;
  return {
    url,
    titulo: txt(c.titulo, 160),
    referrer: urlLimpa(c.referrer),
    utm,
    clid,
    em: typeof c.em === 'number' ? new Date(c.em).toISOString() : agora()
  };
}

// Normaliza o "rastro" enviado pelo widget: { atual, chegada, primeira, paginas }
function normalizarRastro(r) {
  if (!r || typeof r !== 'object') return null;
  const saida = {
    atual: pagina(r.atual),
    chegada: chegada(r.chegada),
    primeira: chegada(r.primeira),
    paginas: (Array.isArray(r.paginas) ? r.paginas : []).slice(-MAX_PAGINAS).map(pagina).filter(Boolean)
  };
  if (!saida.atual && !saida.chegada && !saida.paginas.length) return null;
  return saida;
}

// ---------------------------------------------------------------- de onde veio (rótulo legível)

const REDES = [
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'WhatsApp'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'LinkedIn'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'X (Twitter)'],
  [/(^|\.)pinterest\./, 'Pinterest'],
  [/(^|\.)kwai\./, 'Kwai']
];
const BUSCAS = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)(search\.)?yahoo\./, 'Yahoo'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo']
];
const PAGO = /^(cpc|ppc|paid|pago|ads?|anuncio|paidsocial|paid_social|paid-social|display|cpm)$/i;

function nomeDaFonte(s) {
  const v = String(s || '').toLowerCase();
  if (/^(ig|insta|instagram)/.test(v)) return 'Instagram';
  if (/^(fb|facebook|meta)/.test(v)) return 'Facebook/Instagram';
  if (/google|adwords|gads/.test(v)) return 'Google';
  if (/tiktok/.test(v)) return 'TikTok';
  if (/youtube|yt/.test(v)) return 'YouTube';
  if (/whats|wpp|zap/.test(v)) return 'WhatsApp';
  if (/email|e-mail|newsletter|mail/.test(v)) return 'E-mail';
  return s;
}

// { fonte, tipo: 'anuncio'|'busca'|'rede'|'site'|'direto', campanha }
function classificar(c, hostDoSite = '') {
  if (!c) return null;
  const { utm = {}, clid = {} } = c;
  const campanha = utm.campaign || '';
  if (clid.gclid || clid.gbraid || clid.wbraid) return { fonte: 'Google Ads', tipo: 'anuncio', campanha };
  if (clid.fbclid && PAGO.test(utm.medium || '')) return { fonte: `Anúncio ${nomeDaFonte(utm.source || 'Facebook/Instagram')}`, tipo: 'anuncio', campanha };
  if (clid.ttclid) return { fonte: 'TikTok Ads', tipo: 'anuncio', campanha };
  if (clid.msclkid) return { fonte: 'Microsoft Ads', tipo: 'anuncio', campanha };
  if (utm.source) {
    const nome = nomeDaFonte(utm.source);
    return PAGO.test(utm.medium || '') ? { fonte: `Anúncio ${nome}`, tipo: 'anuncio', campanha } : { fonte: nome, tipo: 'rede', campanha };
  }
  const ref = hostDe(c.referrer);
  if (!ref || (hostDoSite && (ref === hostDoSite || ref.endsWith(`.${hostDoSite}`) || hostDoSite.endsWith(`.${ref}`)))) {
    if (clid.fbclid) return { fonte: 'Facebook/Instagram', tipo: 'rede', campanha };
    return { fonte: 'Direto', tipo: 'direto', campanha };
  }
  for (const [re, nome] of BUSCAS) if (re.test(ref)) return { fonte: `${nome} (busca)`, tipo: 'busca', campanha };
  for (const [re, nome] of REDES) if (re.test(ref)) return { fonte: nome, tipo: 'rede', campanha };
  return { fonte: ref, tipo: 'site', campanha };
}

// ---------------------------------------------------------------- guardar no lead

function registrarNoLead(lead, rastro) {
  if (!lead || !rastro) return;
  const site = hostDe(rastro.atual?.url || rastro.chegada?.url || '');
  const o = lead.origemSite || {};
  // a chegada que trouxe o cliente fica fixa (é ela que diz "de onde veio")
  if (!o.chegada && rastro.chegada) {
    o.chegada = rastro.chegada;
    o.classificacao = classificar(rastro.chegada, site);
  }
  if (!o.primeira && rastro.primeira && rastro.primeira.url !== rastro.chegada?.url) o.primeira = rastro.primeira;
  if (rastro.atual) o.atual = rastro.atual;
  const vistas = [...(o.paginas || [])];
  for (const p of [...rastro.paginas, rastro.atual].filter(Boolean)) {
    const i = vistas.findIndex((v) => v.url === p.url);
    if (i >= 0) vistas.splice(i, 1);
    vistas.push(p);
  }
  o.paginas = vistas.slice(-MAX_PAGINAS);
  o.site = o.site || site;
  lead.origemSite = o;
  if (!lead.pagina && rastro.atual) lead.pagina = rastro.atual.url;
}

// Clique num botão de WhatsApp do site (sem conversa no chat): guarda o rastro
// com o código que vai na mensagem; quando a mensagem chegar no WhatsApp, o
// lead nasce já sabendo de onde o cliente veio.
function guardarVisita(empresaId, botId, codigo, rastro) {
  if (!/^[A-Z2-9]{6}$/.test(codigo || '') || !rastro) return false;
  estado.visitas = estado.visitas || {};
  if (estado.conversas.some((c) => c.codigo === codigo)) return false;
  estado.visitas[codigo] = { empresaId, botId, rastro, em: Date.now() };
  const chaves = Object.keys(estado.visitas);
  const limite = Date.now() - VISITA_VALIDA_MS;
  for (const k of chaves) if (estado.visitas[k].em < limite) delete estado.visitas[k];
  const restantes = Object.keys(estado.visitas);
  if (restantes.length > MAX_VISITAS) for (const k of restantes.slice(0, restantes.length - MAX_VISITAS)) delete estado.visitas[k];
  salvar();
  return true;
}

function tirarVisita(empresaId, codigo) {
  const v = estado.visitas?.[codigo];
  if (!v || v.empresaId !== empresaId || Date.now() - v.em > VISITA_VALIDA_MS) return null;
  delete estado.visitas[codigo];
  return v;
}

// ---------------------------------------------------------------- ler a página (para a IA entender o contexto)

const cachePaginas = new Map(); // url → { em, dados }
const CACHE_MS = 6 * 3600 * 1000;
const MAX_BYTES = 1500 * 1024;

// Não deixa o servidor ser usado para abrir endereços internos (SSRF)
function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return ipPrivado(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

// Só para testes locais: hosts liberados mesmo sendo endereços internos
const HOSTS_LIBERADOS = new Set(String(process.env.ORIGEM_HOSTS_LIBERADOS_TESTE || '').split(',').map((h) => h.trim()).filter(Boolean));

function lookupSeguro(host, opcoes, cb) {
  if (HOSTS_LIBERADOS.has(host)) return dns.lookup(host, opcoes, cb);
  dns.lookup(host, { ...opcoes, all: true }, (err, enderecos) => {
    if (err) return cb(err);
    if (!enderecos.length || enderecos.some((e) => ipPrivado(e.address))) return cb(new Error('endereço interno bloqueado'));
    if (opcoes?.all) return cb(null, enderecos);
    cb(null, enderecos[0].address, enderecos[0].family);
  });
}

function baixarHtml(url, redirecionamentos = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('URL inválida'));
    }
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port) && !HOSTS_LIBERADOS.has(u.hostname))) return reject(new Error('URL não permitida'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !HOSTS_LIBERADOS.has(u.hostname)) return reject(new Error('IP direto não permitido'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      u,
      { lookup: lookupSeguro, timeout: 6000, headers: { 'user-agent': 'Mozilla/5.0 (compatible; DingDongCRM/1.0; +https://odingdong.tech)', accept: 'text/html,application/xhtml+xml' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (!redirecionamentos) return reject(new Error('muitos redirecionamentos'));
          return resolve(baixarHtml(new URL(res.headers.location, u).toString(), redirecionamentos - 1));
        }
        if (res.statusCode !== 200 || !/html/i.test(res.headers['content-type'] || '')) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const partes = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_BYTES) {
            res.destroy();
            return;
          }
          partes.push(c);
        });
        res.on('close', () => resolve(Buffer.concat(partes).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodificar(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m);
}

function meta(html, nome) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${nome}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0] || '';
  return decodificar((tag.match(/content=["']([^"']*)["']/i) || [])[1] || '').trim();
}

// Extrai o essencial da página: título, descrição, títulos (h1/h2) e o texto
function extrairTexto(html, maxTexto = 2500) {
  const titulo = decodificar((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const descricao = meta(html, 'description') || meta(html, 'og:description');
  const semLixo = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, ' ');
  const cabecalhos = [...semLixo.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => decodificar(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8);
  const corpo = decodificar(
    semLixo
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 2)
    .filter((l, i, a) => a.indexOf(l) === i)
    .join('\n');
  return { titulo, descricao, cabecalhos, texto: corpo.slice(0, maxTexto) };
}

// A página só é lida se for do site da empresa (domínios do assistente) ou,
// quando o assistente não tem domínios, do mesmo site em que o chat rodou.
function podeLer(url, bot, siteDoChat) {
  const host = hostDe(url);
  if (!host) return false;
  const dominios = bot?.dominios || [];
  if (dominios.length) return dominios.some((d) => host === d || host.endsWith(`.${d}`));
  return Boolean(siteDoChat) && (host === siteDoChat || host.endsWith(`.${siteDoChat}`));
}

async function lerPagina(url, bot, siteDoChat) {
  if (!url || bot?.lerPaginaDoSite === false || !podeLer(url, bot, siteDoChat)) return null;
  const guardado = cachePaginas.get(url);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado.dados;
  let dados = null;
  try {
    dados = extrairTexto(await baixarHtml(url));
  } catch (err) {
    console.error('[origem] não consegui ler a página:', hostDe(url), err.message);
  }
  cachePaginas.set(url, { em: Date.now(), dados });
  if (cachePaginas.size > 300) cachePaginas.delete(cachePaginas.keys().next().value);
  return dados;
}

// ---------------------------------------------------------------- anúncios e campanhas
// Em "Aprendizados da IA" a empresa cadastra cada anúncio/campanha: um nome,
// palavras para o CRM reconhecer e o que a IA precisa saber (oferta, preço,
// público). O CRM liga o lead ao anúncio sozinho (UTM, link do anúncio,
// anúncio de clique para WhatsApp do Meta, mensagem pronta do anúncio) e a
// equipe pode corrigir no lead.

const semAcento = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function anunciosDa(empresa) {
  return Array.isArray(empresa?.anuncios) ? empresa.anuncios : [];
}

function normalizarAnuncios(lista, existentes = []) {
  const saida = [];
  for (const a of (Array.isArray(lista) ? lista : []).slice(0, 50)) {
    const nome = txt(a?.nome, 80);
    const info = String(a?.info ?? '').trim().slice(0, 3000);
    const palavras = (Array.isArray(a?.palavras) ? a.palavras : String(a?.palavras || '').split(','))
      .map((p) => txt(p, 120))
      .filter((p) => p.length >= 3)
      .slice(0, 12);
    if (!nome && !info && !palavras.length) continue;
    if (!nome) throw Object.assign(new Error('Dê um nome para cada anúncio.'), { status: 400 });
    const antigo = existentes.find((x) => x.id === a?.id);
    saida.push({ id: antigo?.id || `anc_${require('crypto').randomBytes(5).toString('hex')}`, nome, palavras, info, ativo: a?.ativo !== false, criadoEm: antigo?.criadoEm || agora() });
  }
  return saida;
}

// Anúncio de "clique para WhatsApp" do Meta: a primeira mensagem traz os dados
function anuncioDoWhatsapp(msg) {
  const m = msg?.message || {};
  const candidatos = [msg?.contextInfo, m.contextInfo, ...Object.values(m).map((v) => v && typeof v === 'object' ? v.contextInfo : null)];
  for (const c of candidatos) {
    const ad = c?.externalAdReply;
    if (!ad || typeof ad !== 'object') continue;
    const dados = {
      titulo: txt(ad.title, 200),
      texto: txt(ad.body, 600),
      url: urlLimpa(ad.sourceUrl),
      id: txt(ad.sourceId, 60),
      tipo: txt(ad.sourceType, 20),
      em: agora()
    };
    if (dados.titulo || dados.texto || dados.url || dados.id) return dados;
  }
  return null;
}

function registrarAnuncioWhatsapp(lead, ad) {
  if (!lead || !ad) return;
  const o = lead.origemSite || {};
  if (!o.anuncioMeta) o.anuncioMeta = ad;
  if (!o.classificacao || o.classificacao.tipo !== 'anuncio') {
    o.classificacao = { fonte: 'Anúncio Meta (clique para WhatsApp)', tipo: 'anuncio', campanha: ad.titulo || '' };
  }
  lead.origemSite = o;
}

// Onde procurar as palavras do anúncio
function textoDeReconhecimento(lead) {
  const o = lead.origemSite || {};
  const primeira = (lead.mensagens || []).find((m) => m.papel === 'visitante');
  return semAcento(
    [
      ...Object.values(o.chegada?.utm || {}),
      o.chegada?.url,
      o.anuncioMeta?.titulo,
      o.anuncioMeta?.texto,
      o.anuncioMeta?.url,
      o.anuncioMeta?.id,
      String(primeira?.texto || '').slice(0, 300)
    ]
      .filter(Boolean)
      .join(' \n ')
  );
}

function acharAnuncio(empresa, lead) {
  const alvo = textoDeReconhecimento(lead);
  if (!alvo) return null;
  return anunciosDa(empresa).find((a) => a.ativo !== false && a.palavras.some((p) => alvo.includes(semAcento(p)))) || null;
}

// Liga o lead ao anúncio (sem mexer no que a equipe escolheu à mão)
function aplicarAnuncio(empresa, lead) {
  if (!lead || lead.anuncioPor === 'equipe') return null;
  if (lead.anuncioId && anunciosDa(empresa).some((a) => a.id === lead.anuncioId)) return lead.anuncioId;
  const a = acharAnuncio(empresa, lead);
  if (a) {
    lead.anuncioId = a.id;
    lead.anuncioPor = 'automatico';
  }
  return a?.id || null;
}

// ---------------------------------------------------------------- texto para o prompt da IA

function caminho(url) {
  try {
    const u = new URL(url);
    return (u.pathname + (u.search ? u.search.replace(/([?&])(utm_[a-z]+|gclid|gbraid|wbraid|fbclid|ttclid|msclkid)=[^&]*/gi, '$1').replace(/[?&]+$/, '') : '')) || '/';
  } catch {
    return url;
  }
}

const descreverPagina = (p) => (p.titulo ? `"${p.titulo}" (${caminho(p.url)})` : caminho(p.url));

// `canal`: 'site' (o cliente está no site agora) ou 'whatsapp' (veio do site antes)
async function contextoParaIa(lead, bot, canal, empresa = null) {
  const o = lead?.origemSite || {};
  const linhas = [];
  if (empresa) aplicarAnuncio(empresa, lead);
  const anuncio = empresa && lead?.anuncioId ? anunciosDa(empresa).find((a) => a.id === lead.anuncioId) : null;
  if (lead?.origemManual) linhas.push(`- A equipe anotou sobre a origem deste cliente: ${lead.origemManual}.`);
  if (anuncio) {
    linhas.push(`- Veio do anúncio/campanha "${anuncio.nome}".${anuncio.info ? ' O que a empresa quer que você saiba sobre esse anúncio (siga isto):' : ''}`);
    if (anuncio.info) linhas.push('<anuncio>', anuncio.info, '</anuncio>');
  }
  if (o.anuncioMeta) {
    const ad = o.anuncioMeta;
    linhas.push(`- Chegou clicando num anúncio do Instagram/Facebook que abre o WhatsApp${ad.titulo ? `: "${ad.titulo}"` : ''}${ad.texto ? ` — texto do anúncio: "${ad.texto}"` : ''}.`);
  }
  if (!o.chegada && !o.atual && !o.paginas?.length) return linhas.join('\n');
  const c = o.classificacao;
  if (c && !(o.anuncioMeta && c.fonte.startsWith('Anúncio Meta'))) {
    const tipo = { anuncio: 'clicou num anúncio', busca: 'pesquisou no Google/buscador', rede: 'veio de uma rede social ou link', direto: 'entrou direto no site (digitou o endereço ou tinha salvo)', site: 'veio de um link em outro site' }[c.tipo] || '';
    linhas.push(`- Como chegou ao site: ${c.fonte}${tipo ? ` — ${tipo}` : ''}${c.campanha ? `; campanha "${c.campanha}"` : ''}${o.chegada?.utm?.term ? `; termo "${o.chegada.utm.term}"` : ''}.`);
  }
  const atual = o.atual || o.paginas?.[o.paginas.length - 1];
  if (o.chegada && o.chegada.url !== atual?.url) linhas.push(`- Primeira página que abriu: ${descreverPagina(o.chegada)}.`);
  if (atual) linhas.push(canal === 'site' ? `- Página em que está agora, conversando com você: ${descreverPagina(atual)}.` : `- Última página do site que viu antes de vir para o WhatsApp: ${descreverPagina(atual)}.`);
  const outras = (o.paginas || []).filter((p) => p.url !== atual?.url && p.url !== o.chegada?.url).slice(-6);
  if (outras.length) linhas.push(`- Outras páginas que viu: ${outras.map(descreverPagina).join('; ')}.`);
  if (atual) {
    const lida = await lerPagina(atual.url, bot, o.site);
    if (lida && (lida.texto || lida.descricao)) {
      linhas.push(
        '- O que está escrito nessa página (resumo automático — use para saber qual produto/serviço ele estava olhando):',
        '<pagina>',
        [lida.titulo && `Título: ${lida.titulo}`, lida.descricao && `Descrição: ${lida.descricao}`, lida.cabecalhos.length && `Títulos: ${lida.cabecalhos.join(' | ')}`, lida.texto].filter(Boolean).join('\n'),
        '</pagina>'
      );
    }
  }
  return linhas.join('\n');
}

// Resumo para o painel
function resumoOrigem(lead, empresa = null) {
  const o = lead.origemSite || {};
  const anuncio = empresa && lead.anuncioId ? anunciosDa(empresa).find((a) => a.id === lead.anuncioId) : null;
  if (!lead.origemSite && !anuncio && !lead.origemManual) return null;
  return {
    anuncio: anuncio ? { id: anuncio.id, nome: anuncio.nome, por: lead.anuncioPor || 'automatico' } : null,
    anuncioMeta: o.anuncioMeta || null,
    manual: lead.origemManual || '',
    fonte: o.classificacao?.fonte || '',
    tipo: o.classificacao?.tipo || '',
    campanha: o.classificacao?.campanha || '',
    utm: o.chegada?.utm || {},
    chegada: o.chegada ? { url: o.chegada.url, titulo: o.chegada.titulo, referrer: o.chegada.referrer, em: o.chegada.em } : null,
    atual: o.atual || null,
    paginas: o.paginas || []
  };
}

module.exports = {
  normalizarRastro,
  classificar,
  registrarNoLead,
  guardarVisita,
  tirarVisita,
  lerPagina,
  extrairTexto,
  baixarHtml,
  contextoParaIa,
  resumoOrigem,
  anunciosDa,
  normalizarAnuncios,
  anuncioDoWhatsapp,
  registrarAnuncioWhatsapp,
  acharAnuncio,
  aplicarAnuncio,
  ipPrivado
};
