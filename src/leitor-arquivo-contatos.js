// leitor-arquivo-contatos.js — lê a lista de contatos de um arquivo CSV ou JSON (ex.: o que o
// Apify / Google Maps Scraper exporta) ou do texto colado de uma planilha, e devolve cada
// contato com nome, telefone, endereço, cidade, nota, site… (os mesmos campos do PDF).
//
// CSV de verdade: campos entre aspas com vírgula, aspas dobradas e quebra de linha dentro,
// separador vírgula, ponto e vírgula ou tab, arquivo do Excel (BOM / Windows-1252).
// JSON: lista de objetos (ou { items: [...] }), com listas e objetos dentro (categories,
// emails, location…), achatados como no CSV do Apify ("categories/0").
// Sem IA: só código.

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// título da coluna → campo. A ordem importa: o primeiro que bate ganha.
const CAMPOS = [
  [/^(title|placename|empresa|nomefantasia|fantasia|razaosocial|estabelecimento|loja|negocio|company|companyname|business|businessname)$/, 'empresa'],
  [/^(nome|name|responsavel|contato|contatonome|cliente|pessoa)$/, 'nome'],
  [/^(phone|phoneunformatted|telefone|telefone1|celular|whatsapp|whats|fone|numero|contatotelefone|tel|mobile)$/, 'telefone'],
  [/^(totalscore|score|rating|nota|avaliacao)$/, 'nota'],
  [/^(reviewscount|reviews|avaliacoes|reviewcount|numerodeavaliacoes)$/, 'avaliacoes'],
  [/^(street|address|endereco|rua|logradouro|enderecocompleto)$/, 'endereco'],
  [/^(neighborhood|bairro)$/, 'bairro'],
  [/^(city|cidade|municipio|localidade)$/, 'cidade'],
  [/^(state|estado|uf)$/, 'estado'],
  [/^(postalcode|cep|zip|zipcode)$/, 'cep'],
  [/^(countrycode|country|pais)$/, 'pais'],
  [/^(website|site|webpage|homepage)$/, 'site'],
  [/^(url|link|mapsurl|googlemapsurl|googlemaps|mapa|maps|searchpageurl)$/, 'link'],
  [/^(categoryname|categories\d*|category|categoria|categorias|ramo|segmento|atividade|nicho|tipo)$/, 'categorias'],
  [/^(emails?\d*|email|e?mail)$/, 'email']
];
const campoDe = (titulo) => (CAMPOS.find(([re]) => re.test(sem(titulo))) || [])[1] || null;

const UF = { acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', distritofederal: 'DF', espiritosanto: 'ES', goias: 'GO', maranhao: 'MA', matogrosso: 'MT', matogrossodosul: 'MS', minasgerais: 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', riodejaneiro: 'RJ', riograndedonorte: 'RN', riograndedosul: 'RS', rondonia: 'RO', roraima: 'RR', santacatarina: 'SC', saopaulo: 'SP', sergipe: 'SE', tocantins: 'TO' };

function limpar(campo, v) {
  let s = String(v ?? '').trim();
  if (/^(undefined|null|nan|-|—|n\/a)$/i.test(s)) return '';
  if (campo === 'telefone') return s.replace(/[^\d+()\-\s]/g, '').replace(/\s+/g, ' ').trim();
  if (campo === 'site' || campo === 'email' || campo === 'link') return s.replace(/\s+/g, '');
  if (campo === 'nota') return s.replace(',', '.').match(/\d+(\.\d+)?/)?.[0] || '';
  if (campo === 'avaliacoes') return s.replace(/\D/g, '');
  if (campo === 'estado') return UF[sem(s)] || s;
  return s.replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------- texto do arquivo

// UTF-8 (com ou sem BOM); se não for UTF-8 válido, Windows-1252 (CSV do Excel antigo)
function textoDoArquivo(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''));
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  const utf8 = b.toString('utf8').replace(/^﻿/, '');
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1252').decode(b);
}

// ---------------------------------------------------------------- CSV

function separadorDe(texto) {
  const amostra = texto.split(/\r?\n/).slice(0, 5).join('\n');
  // conta fora das aspas
  const conta = (sep) => { let n = 0; let aspas = false; for (const ch of amostra) { if (ch === '"') aspas = !aspas; else if (!aspas && ch === sep) n++; } return n; };
  const [melhor, n] = ['\t', ';', ','].map((s) => [s, conta(s)]).sort((a, b) => b[1] - a[1])[0];
  return n ? melhor : ',';
}

function lerCsv(texto) {
  const sep = separadorDe(texto);
  const linhas = [];
  let linha = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += ch;
    } else if (ch === '"' && campo.trim() === '') { aspas = true; campo = ''; }
    else if (ch === sep) { linha.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.some((c) => c.trim())) linhas.push(linha);
      linha = [];
    } else campo += ch;
  }
  linha.push(campo);
  if (linha.some((c) => c.trim())) linhas.push(linha);
  return linhas;
}

// ---------------------------------------------------------------- JSON

// { a: { b: 1 }, c: [x, y] } → { "a/b": 1, "c/0": x, "c/1": y } (igual ao CSV do Apify)
function achatar(obj, prefixo = '', saida = {}) {
  if (obj === null || obj === undefined) return saida;
  if (Array.isArray(obj)) {
    if (obj.every((x) => x === null || typeof x !== 'object')) { obj.forEach((x, i) => { saida[`${prefixo}/${i}`] = x; }); return saida; }
    obj.slice(0, 10).forEach((x, i) => achatar(x, `${prefixo}/${i}`, saida));
    return saida;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) achatar(v, prefixo ? `${prefixo}/${k}` : k, saida);
    return saida;
  }
  saida[prefixo] = obj;
  return saida;
}

function linhasDoJson(texto) {
  let dados = JSON.parse(texto);
  if (!Array.isArray(dados)) dados = dados?.items || dados?.data || dados?.results || dados?.contatos || [dados];
  const objs = dados.filter((x) => x && typeof x === 'object').map((x) => achatar(x));
  const chaves = [...new Set(objs.flatMap((o) => Object.keys(o)))];
  return [chaves, ...objs.map((o) => chaves.map((k) => (o[k] === undefined || o[k] === null ? '' : String(o[k]))))];
}

// JSON Lines (um objeto por linha)
function linhasDoJsonl(texto) {
  return linhasDoJson(`[${texto.split(/\r?\n/).filter((l) => l.trim()).join(',')}]`);
}

// ---------------------------------------------------------------- linhas → contatos

function contatosDasLinhas(linhas) {
  if (!linhas.length) return { contatos: [], colunas: [] };
  const titulo = linhas[0];
  // coluna de cada campo; "categories/0", "categories/1"… e "emails/0"… juntam
  const mapa = {};
  titulo.forEach((t, i) => {
    // "categories/0", "emails/1"…: vale o nome antes da barra
    const campo = campoDe(t) || (/^[^/]+\/\d+$/.test(t) ? campoDe(String(t).split('/')[0]) : null);
    if (!campo) return;
    if (['categorias', 'email'].includes(campo)) (mapa[campo] = mapa[campo] || []).push(i);
    else if (mapa[campo] === undefined) mapa[campo] = [i];
    // endereço: a rua ("street") vale mais que o endereço completo ("address", que repete cidade e CEP)
    else if (campo === 'endereco' && /^(street|rua|logradouro)$/.test(sem(t))) mapa[campo] = [i];
  });
  // só tem "nome" (sem coluna de empresa): o nome é o da empresa
  if (!mapa.empresa && mapa.nome) { mapa.empresa = mapa.nome; delete mapa.nome; }
  let comCabecalho = Boolean(mapa.telefone);
  let corpo = linhas.slice(1);
  if (!comCabecalho) {
    // sem títulos: acha a coluna do telefone pelos números; o resto vira empresa, nome, cidade, ramo
    const ehTel = (s) => String(s).replace(/\D/g, '').length >= 10 && String(s).replace(/\D/g, '').length <= 13;
    corpo = linhas;
    const iTel = linhas[0].findIndex(ehTel);
    if (iTel < 0) return { contatos: [], colunas: [] };
    const outras = linhas[0].map((_, i) => i).filter((i) => i !== iTel);
    Object.assign(mapa, { telefone: [iTel] }, ...['empresa', 'nome', 'cidade', 'categorias'].map((k, j) => (outras[j] !== undefined ? { [k]: [outras[j]] } : {})));
  }
  const contatos = [];
  for (const l of corpo) {
    const c = {};
    for (const [campo, idx] of Object.entries(mapa)) {
      const valores = idx.map((i) => limpar(campo, l[i])).filter(Boolean);
      if (!valores.length) continue;
      c[campo] = campo === 'categorias' ? [...new Set(valores)].join(', ') : valores[0];
    }
    // "url" do Apify é o link do Google Maps; outro link sem site vira o site
    if (c.link) {
      if (/google\.[a-z.]+\/maps|maps\.app\.goo|goo\.gl\/maps/i.test(c.link)) c.mapsUrl = c.link;
      else if (!c.site) c.site = c.link;
      delete c.link;
    }
    if (c.telefone || c.empresa) contatos.push(c);
  }
  return { contatos, colunas: Object.keys(mapa).filter((k) => k !== 'link') };
}

// arquivo (Buffer) ou texto colado → { contatos, colunas, formato }
function lerContatosDoArquivo(entrada, nomeArquivo = '') {
  const texto = textoDoArquivo(entrada).trim();
  if (!texto) return { contatos: [], colunas: [], formato: '' };
  const ext = String(nomeArquivo).toLowerCase().split('.').pop();
  let linhas;
  let formato;
  if (ext === 'json' || ext === 'jsonl' || /^[[{]/.test(texto)) {
    try {
      linhas = /^\{/.test(texto) && /\}\s*\r?\n\s*\{/.test(texto) ? linhasDoJsonl(texto) : linhasDoJson(texto);
      formato = 'JSON';
    } catch {
      if (ext === 'json') throw Object.assign(new Error('Esse JSON está com defeito (não consegui ler).'), { status: 400 });
    }
  }
  if (!linhas) { linhas = lerCsv(texto); formato = ext === 'txt' || !ext ? 'texto' : 'CSV'; }
  return { ...contatosDasLinhas(linhas.slice(0, 20001)), formato };
}

module.exports = { lerContatosDoArquivo, lerCsv, achatar, campoDe };
