// leitor-pdf-contatos.js — lê a tabela de empresas de um PDF (ex.: resultado do "Google Maps
// Scraper" salvo em PDF) e separa cada empresa com nome, telefone, endereço, cidade, nota…
//
// O PDF é uma tabela impressa: cada célula pode quebrar em várias linhas e cada pedaço de texto
// vem solto. Por isso usa a POSIÇÃO de cada pedaço (x, y):
//   - colunas: pela linha de títulos (title, totalScore, phone…, ou Nome, Telefone…);
//   - empresas: pelo número da 1ª coluna (#) de cada linha da tabela;
//   - cada pedaço vai para a coluna em que começa e para a empresa mais perto na vertical.
// Sem IA: só código.

// título da coluna (chave técnica do Apify ou nome comum) → campo do contato
const CAMPOS = [
  [/^(title|placename|place|name|nome|empresa|estabelecimento)$/, 'empresa'],
  [/^(totalscore|score|rating|nota|avaliacao)$/, 'nota'],
  [/^(reviewscount|reviews|avaliacoes|reviewcount)$/, 'avaliacoes'],
  [/^(street|address|endereco|rua|logradouro)$/, 'endereco'],
  [/^(neighborhood|bairro)$/, 'bairro'],
  [/^(city|cidade|municipio)$/, 'cidade'],
  [/^(state|estado|uf)$/, 'estado'],
  [/^(postalcode|cep)$/, 'cep'],
  [/^(countrycode|country|pais)$/, 'pais'],
  [/^(website|site|webpage)$/, 'site'],
  [/^(url|link|mapsurl|googlemaps|mapa|maps)$/, 'link'], // no Apify, "url" é o link do Google Maps
  [/^(phone|phoneunformatted|telefone|celular|whatsapp|fone)$/, 'telefone'],
  [/^(categories|categoryname|category|categoria|categorias|ramo|segmento)$/, 'categorias'],
  [/^(emails?|email)$/, 'email']
];
const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const campoDoTitulo = (t) => (CAMPOS.find(([re]) => re.test(sem(t))) || [])[1] || null;

async function itensDoPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const paginas = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
      const pg = await doc.getPage(p);
      const altura = pg.getViewport({ scale: 1 }).height;
      const tc = await pg.getTextContent();
      paginas.push(tc.items.filter((i) => String(i.str || '').trim()).map((i) => ({ t: i.str, x: i.transform[4], y: altura - i.transform[5], w: i.width || 0 })));
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return paginas;
}

// junta os pedaços de uma célula: mesma linha sem espaço quando estão colados ("Comil"+"â"+"ncia")
function juntar(pedacos) {
  const linhas = [];
  for (const p of pedacos.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const l = linhas.find((x) => Math.abs(x.y - p.y) < 3);
    if (l) l.itens.push(p); else linhas.push({ y: p.y, itens: [p] });
  }
  const textos = linhas
    .sort((a, b) => a.y - b.y)
    .map((l) => l.itens.sort((a, b) => a.x - b.x).reduce((s, p, i, arr) => (i === 0 ? p.t : s + (p.x - (arr[i - 1].x + arr[i - 1].w) > 1.5 ? ' ' : '') + p.t), '').trim());
  // linha que termina em "-" (telefone "2482-" / número "168-") emenda direto na de baixo
  return textos.reduce((s, l) => (!s ? l : /[^\s]-$/.test(s) ? s + l : `${s} ${l}`), '').replace(/\s+/g, ' ').trim();
}

// acha as colunas na página: linha com várias chaves conhecidas (title, phone, city…)
function colunasDaPagina(itens) {
  const candidatos = itens.filter((i) => campoDoTitulo(i.t));
  // agrupa por linha e pega a que tem mais títulos (e tem telefone)
  const porLinha = new Map();
  for (const c of candidatos) {
    const k = [...porLinha.keys()].find((y) => Math.abs(y - c.y) < 3) ?? c.y;
    porLinha.set(k, [...(porLinha.get(k) || []), c]);
  }
  const melhor = [...porLinha.values()].filter((l) => l.some((c) => campoDoTitulo(c.t) === 'telefone')).sort((a, b) => b.length - a.length)[0];
  if (!melhor || melhor.length < 2) return null;
  // o cabeçalho pode ter 2 ou 3 linhas ("Total / Score / totalScore"): junta tudo que está
  // na faixa do cabeçalho e agrupa por coluna (posição x)
  const y0 = melhor[0].y;
  const faixa = itens.filter((i) => i.y >= y0 - 25 && i.y <= y0 + 25 && !/^\d+%$/.test(i.t.trim()) && i.t.trim() !== '#');
  const grupos = [];
  for (const i of faixa.sort((a, b) => a.x - b.x)) {
    const g = grupos.find((x) => Math.abs(x.x - i.x) < 12);
    if (g) { g.itens.push(i); g.x = Math.min(g.x, i.x); } else grupos.push({ x: i.x, itens: [i] });
  }
  const vistos = new Set();
  const cols = grupos
    .map((g) => ({ campo: g.itens.map((i) => campoDoTitulo(i.t)).find(Boolean) || null, x: g.x }))
    .filter((c) => c.campo && !vistos.has(c.campo) && vistos.add(c.campo))
    .sort((a, b) => a.x - b.x);
  if (cols.length < 2) return null;
  const yTitulos = Math.max(...faixa.filter((i) => grupos.some((g) => g.itens.includes(i))).map((i) => i.y));
  return { cols, yTitulos };
}

// números de linha (#): o que fica antes da 1ª coluna e é só número
function linhasDaPagina(itens, cols, yTitulos) {
  const x0 = cols[0].x;
  const fim = Math.min(...itens.filter((i) => /items per page|itens por p[aá]gina|go to page/i.test(i.t)).map((i) => i.y), Infinity);
  return itens.filter((i) => i.x < x0 - 3 && /^\d{1,4}$/.test(i.t.trim()) && i.y > yTitulos + 4 && i.y < fim).sort((a, b) => a.y - b.y).map((i) => ({ n: Number(i.t), y: i.y, fim }));
}

const UF = { acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', distritofederal: 'DF', espiritosanto: 'ES', goias: 'GO', maranhao: 'MA', matogrosso: 'MT', matogrossodosul: 'MS', minasgerais: 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', riodejaneiro: 'RJ', riograndedonorte: 'RN', riograndedosul: 'RS', rondonia: 'RO', roraima: 'RR', santacatarina: 'SC', saopaulo: 'SP', sergipe: 'SE', tocantins: 'TO' };

function limparCampo(campo, v) {
  let s = String(v || '').trim();
  if (/^(undefined|null|nan|-|—)$/i.test(s)) return '';
  if (campo === 'telefone') return s.replace(/[^\d+()\-\s]/g, '').replace(/-\s+/g, '-').replace(/\s+/g, ' ').trim();
  if (campo === 'site' || campo === 'email' || campo === 'link') return s.replace(/\s+/g, '');
  if (campo === 'nota') return s.replace(',', '.').match(/\d+(\.\d+)?/)?.[0] || '';
  if (campo === 'avaliacoes') return s.replace(/\D/g, '');
  if (campo === 'estado') return UF[sem(s)] || s;
  if (campo === 'categorias' && /^\d+ items?$/i.test(s)) return ''; // "7 items": a lista não veio no PDF
  return s;
}

async function lerContatosDoPdf(buffer) {
  const paginas = await itensDoPdf(buffer);
  const contatos = [];
  let cab = null;
  for (const itens of paginas) {
    cab = colunasDaPagina(itens) || cab;
    if (!cab) continue;
    const { cols } = cab;
    const yTitulos = colunasDaPagina(itens)?.yTitulos ?? -Infinity;
    const linhas = linhasDaPagina(itens, cols, yTitulos);
    if (!linhas.length) continue;
    // faixa vertical de cada empresa: até o meio do caminho para a próxima
    linhas.forEach((l, i) => {
      l.de = i === 0 ? Math.max(yTitulos + 4, l.y - (linhas[1] ? (linhas[1].y - l.y) / 2 : 30)) : (linhas[i - 1].y + l.y) / 2;
      l.ate = i === linhas.length - 1 ? Math.min(l.fim - 2, l.y + (i ? (l.y - linhas[i - 1].y) / 2 : 30)) : (l.y + linhas[i + 1].y) / 2;
    });
    const colunaDe = (x) => { let c = null; for (const col of cols) if (x >= col.x - 3) c = col; return c; };
    for (const l of linhas) {
      const celulas = {};
      for (const it of itens) {
        if (it.y < l.de || it.y >= l.ate || it.x < cols[0].x - 3) continue;
        const col = colunaDe(it.x);
        if (col) (celulas[col.campo] = celulas[col.campo] || []).push(it);
      }
      const c = { n: l.n };
      const cortados = [];
      for (const [campo, pedacos] of Object.entries(celulas)) {
        let v = juntar(pedacos);
        if (/…$/.test(v)) { cortados.push(campo); v = v.replace(/\s*…$/, ''); }
        v = limparCampo(campo, v);
        if (v) c[campo] = v;
      }
      if (c.link) {
        const linkCortado = cortados.includes('link');
        if (/google\.[a-z.]+\/maps|maps\.app\.goo|goo\.gl\/maps/i.test(c.link)) { if (!linkCortado) c.mapsUrl = c.link; } // cortado não abre: o CRM monta o link do mapa pelo endereço
        else if (!c.site) { c.site = c.link; if (linkCortado) cortados.push('site'); }
        delete c.link;
        if (linkCortado) cortados.splice(cortados.indexOf('link'), 1);
      }
      if (cortados.length) c.cortados = cortados; // texto cortado no PDF (ex.: site, nome comprido)
      if (c.empresa || c.telefone) contatos.push(c);
    }
  }
  return { contatos, colunas: cab ? cab.cols.map((c) => c.campo) : [], paginas: paginas.length };
}

module.exports = { lerContatosDoPdf, juntar, campoDoTitulo };
