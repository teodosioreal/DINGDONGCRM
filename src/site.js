// site.js — o site da empresa como conhecimento da IA.
//
// Em "Aprendizados da IA" a empresa cola o link do site (o CRM lê a página e,
// se quiser, as páginas ligadas a ela) ou cola a copy inteira. As duas IAs
// usam esse texto para conhecer produtos, preços e o jeito de vender. O site é
// relido sozinho uma vez por semana.

const { salvar, agora } = require('./db');
const { hostDe } = require('./util');
const origem = require('./origem');

const MAX_LINKS = 10;
const MAX_PAGINAS = 20;
const MAX_POR_PAGINA = 6000;
const MAX_COPIA = 30000;
const MAX_NO_PROMPT = 12000; // o essencial do site em cada resposta (economiza tokens)
const RELER_A_CADA_MS = 7 * 24 * 3600 * 1000;
const POUCO_TEXTO = 300;

const lendo = new Map(); // empresaId → { lidas, total }

function siteDa(empresa) {
  const s = empresa.site || {};
  return {
    links: Array.isArray(s.links) ? s.links : [],
    seguirLinks: s.seguirLinks !== false,
    copia: s.copia || '',
    usar: s.usar !== false,
    paginas: Array.isArray(s.paginas) ? s.paginas : [],
    lidoEm: s.lidoEm || null,
    erro: s.erro || ''
  };
}

function normalizarLinks(lista) {
  const saida = [];
  for (const bruto of (Array.isArray(lista) ? lista : String(lista || '').split(/[\s,]+/)).slice(0, MAX_LINKS * 2)) {
    let v = String(bruto || '').trim();
    if (!v) continue;
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      if (!saida.includes(u.toString())) saida.push(u.toString());
    } catch {
      throw Object.assign(new Error(`Link inválido: ${bruto}`), { status: 400 });
    }
  }
  return saida.slice(0, MAX_LINKS);
}

function guardar(empresa, mudancas) {
  const atual = siteDa(empresa);
  const novo = { ...(empresa.site || {}) };
  if (mudancas.links !== undefined) novo.links = normalizarLinks(mudancas.links);
  if (mudancas.seguirLinks !== undefined) novo.seguirLinks = mudancas.seguirLinks !== false;
  if (mudancas.copia !== undefined) novo.copia = String(mudancas.copia || '').slice(0, MAX_COPIA);
  if (mudancas.usar !== undefined) novo.usar = mudancas.usar !== false;
  // tirou todos os links: as páginas lidas saem também
  if (mudancas.links !== undefined && !novo.links.length) novo.paginas = [];
  empresa.site = novo;
  salvar();
  return { ...atual, ...siteDa(empresa) };
}

// Links da mesma página para outras páginas do mesmo site
function linksInternos(html, base) {
  const host = hostDe(base);
  const achados = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (!/^https?:$/.test(u.protocol) || hostDe(u.toString()) !== host) continue;
      if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|css|js|xml|ico)$/i.test(u.pathname)) continue;
      if (/\/(wp-admin|wp-login|carrinho|cart|checkout|login|minha-conta|account)\b/i.test(u.pathname)) continue;
      u.hash = '';
      u.search = '';
      achados.push(u.toString());
    } catch {
      /* link quebrado: ignora */
    }
  }
  return [...new Set(achados)];
}

async function lerSite(empresa, { motivo = 'manual' } = {}) {
  const s = siteDa(empresa);
  if (!s.links.length) throw Object.assign(new Error('Cole pelo menos um link do seu site.'), { status: 400 });
  if (lendo.has(empresa.id)) throw Object.assign(new Error('O site já está sendo lido. Aguarde um pouco.'), { status: 409 });
  const fila = [...s.links];
  const vistos = new Set(fila);
  const paginas = [];
  const progresso = { lidas: 0, total: fila.length };
  lendo.set(empresa.id, progresso);
  const erros = [];
  try {
    while (fila.length && paginas.length < MAX_PAGINAS) {
      const url = fila.shift();
      let html;
      try {
        html = await origem.baixarHtml(url);
      } catch (err) {
        erros.push(`${url}: ${err.message}`);
        continue;
      } finally {
        progresso.lidas++;
      }
      const lida = origem.extrairTexto(html, MAX_POR_PAGINA);
      const texto = [lida.descricao, lida.cabecalhos.join(' | '), lida.texto].filter(Boolean).join('\n');
      paginas.push({ url, titulo: lida.titulo, caracteres: texto.length, texto });
      if (s.seguirLinks) {
        for (const l of linksInternos(html, url)) {
          if (vistos.has(l) || vistos.size >= MAX_PAGINAS * 3) continue;
          vistos.add(l);
          fila.push(l);
        }
        progresso.total = Math.min(vistos.size, MAX_PAGINAS);
      }
    }
  } finally {
    lendo.delete(empresa.id);
  }
  empresa.site = {
    ...(empresa.site || {}),
    paginas,
    lidoEm: agora(),
    lidoPor: motivo,
    erro: !paginas.length ? `Não consegui abrir o site. ${erros[0] || ''}`.trim() : erros.length ? `${erros.length} página(s) não abriram.` : ''
  };
  salvar();
  return siteDa(empresa);
}

// Relê sozinho uma vez por semana (chamado pelo ciclo das automações)
function verificarAgenda(empresa) {
  const s = siteDa(empresa);
  if (!s.links.length || lendo.has(empresa.id)) return;
  if (s.lidoEm && Date.now() - new Date(s.lidoEm).getTime() < RELER_A_CADA_MS) return;
  lerSite(empresa, { motivo: 'semanal' }).catch((err) => console.error(`[site ${empresa.id}]`, err.message));
}

// Texto que vai no prompt das IAs
function textoParaIa(empresa) {
  const s = siteDa(empresa);
  if (!s.usar) return '';
  const partes = [];
  if (s.copia.trim()) partes.push(s.copia.trim());
  for (const p of s.paginas) {
    if (!p.texto) continue;
    partes.push(`--- Página: ${p.titulo || p.url} (${p.url})\n${p.texto}`);
  }
  const texto = partes.join('\n\n');
  return texto.length > MAX_NO_PROMPT ? `${texto.slice(0, MAX_NO_PROMPT)}\n[…]` : texto;
}

function resumo(empresa) {
  const s = siteDa(empresa);
  return {
    links: s.links,
    seguirLinks: s.seguirLinks,
    copia: s.copia,
    usar: s.usar,
    lidoEm: s.lidoEm,
    erro: s.erro,
    lendo: lendo.get(empresa.id) || null,
    paginas: s.paginas.map((p) => ({ url: p.url, titulo: p.titulo, caracteres: p.caracteres, poucoTexto: p.caracteres < POUCO_TEXTO })),
    caracteresNaIa: textoParaIa(empresa).length,
    maxCopia: MAX_COPIA
  };
}

module.exports = { siteDa, guardar, lerSite, verificarAgenda, textoParaIa, resumo, linksInternos };
