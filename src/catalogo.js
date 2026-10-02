// catalogo.js — "Serviços e preços": a lista oficial do que a empresa vende.
// Cada item tem nome, preço, detalhes e as mídias que mostram aquele serviço.
// A IA consulta isto em TODA resposta (é a fonte da verdade de preços): mudou
// aqui, vale na próxima mensagem, sem mexer no prompt.

const { estado, salvar, novoId, agora } = require('./db');

const MAX_ITENS = 200;
const limpar = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function itensDa(empresa) {
  if (!Array.isArray(empresa.catalogo)) empresa.catalogo = [];
  return empresa.catalogo;
}

// "350", "350,00", "R$ 1.200,50" → 350 / 1200.5 ; vazio → null
function lerPreco(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  let t = String(v).replace(/[^\d.,]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function normalizar(b, antigo = {}) {
  const item = {
    id: antigo.id || novoId('cat'),
    tipo: b.tipo === 'produto' ? 'produto' : 'servico',
    nome: limpar(b.nome ?? antigo.nome, 100),
    categoria: limpar(b.categoria ?? antigo.categoria ?? '', 60),
    preco: b.preco !== undefined ? lerPreco(b.preco) : antigo.preco ?? null,
    precoAte: b.precoAte !== undefined ? lerPreco(b.precoAte) : antigo.precoAte ?? null,
    precoObs: limpar(b.precoObs ?? antigo.precoObs ?? '', 120), // "a partir de", "no Pix", "em até 3x"…
    descricao: String(b.descricao ?? antigo.descricao ?? '').trim().slice(0, 1500),
    duracao: limpar(b.duracao ?? antigo.duracao ?? '', 80),
    midias: Array.isArray(b.midias) ? [...new Set(b.midias.map((c) => limpar(c, 40)).filter(Boolean))].slice(0, 20) : antigo.midias || [],
    ativo: b.ativo !== undefined ? b.ativo !== false : antigo.ativo !== false,
    criadoEm: antigo.criadoEm || agora(),
    atualizadoEm: agora()
  };
  if (!item.nome) throw Object.assign(new Error('Dê um nome ao serviço ou produto.'), { status: 400 });
  if (item.precoAte !== null && item.preco !== null && item.precoAte < item.preco) [item.preco, item.precoAte] = [item.precoAte, item.preco];
  return item;
}

function criar(empresa, b) {
  const lista = itensDa(empresa);
  if (lista.length >= MAX_ITENS) throw Object.assign(new Error(`Limite de ${MAX_ITENS} itens.`), { status: 400 });
  const item = normalizar(b);
  if (lista.some((x) => semAcento(x.nome) === semAcento(item.nome))) throw Object.assign(new Error(`Já existe "${item.nome}" no catálogo.`), { status: 400 });
  lista.push(item);
  salvar();
  return item;
}

function atualizar(empresa, id, b) {
  const lista = itensDa(empresa);
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0) throw Object.assign(new Error('Item não encontrado.'), { status: 404 });
  const item = normalizar(b, lista[i]);
  if (lista.some((x) => x.id !== id && semAcento(x.nome) === semAcento(item.nome))) throw Object.assign(new Error(`Já existe "${item.nome}" no catálogo.`), { status: 400 });
  lista[i] = item;
  salvar();
  return item;
}

function apagar(empresa, id) {
  const lista = itensDa(empresa);
  const antes = lista.length;
  empresa.catalogo = lista.filter((x) => x.id !== id);
  salvar();
  return antes !== empresa.catalogo.length;
}

// Quando uma mídia some da biblioteca, sai dos itens também
function esquecerMidia(empresa, codigo) {
  let mudou = false;
  for (const x of itensDa(empresa)) {
    if (x.midias.includes(codigo)) { x.midias = x.midias.filter((c) => c !== codigo); mudou = true; }
  }
  if (mudou) salvar();
}

function textoPreco(x) {
  if (x.preco === null && x.precoAte === null) return x.precoObs || 'preço sob consulta (não informe valor: diga que vai confirmar)';
  const faixa = x.precoAte !== null && x.preco !== null ? `${brl(x.preco)} a ${brl(x.precoAte)}` : brl(x.preco ?? x.precoAte);
  return `${faixa}${x.precoObs ? ` (${x.precoObs})` : ''}`;
}

// código da mídia → nomes dos itens ativos ligados a ela
function midiasLigadas(empresa) {
  const mapa = new Map();
  for (const x of itensDa(empresa).filter((i) => i.ativo)) for (const c of x.midias) mapa.set(c, [...(mapa.get(c) || []), x.nome]);
  return mapa;
}

// Bloco que vai para a IA (fonte da verdade de serviços, produtos e preços)
function paraIa(empresa) {
  const ativos = itensDa(empresa).filter((x) => x.ativo);
  if (!ativos.length) return '';
  const disponiveis = new Set(require('./midias').paraIa(empresa, { followup: true }).map((m) => m.codigo));
  return ativos
    .map((x) => {
      const linhas = [`- ${x.tipo === 'produto' ? 'PRODUTO' : 'SERVIÇO'}: ${x.nome}${x.categoria ? ` [${x.categoria}]` : ''}`, `  Preço: ${textoPreco(x)}`];
      if (x.duracao) linhas.push(`  ${x.tipo === 'produto' ? 'Prazo/entrega' : 'Duração/prazo'}: ${x.duracao}`);
      if (x.descricao) linhas.push(`  Detalhes: ${x.descricao.replace(/\s*\n\s*/g, ' / ')}`);
      const cods = x.midias.filter((c) => disponiveis.has(c));
      if (cods.length) linhas.push(`  Mídias deste item (mande quando falar dele): ${cods.map((c) => `[[MIDIA: ${c}]]`).join(' ')}`);
      return linhas.join('\n');
    })
    .join('\n');
}

function resumo(empresa) {
  const lista = itensDa(empresa);
  return { total: lista.length, ativos: lista.filter((x) => x.ativo).length, atualizadoEm: lista.reduce((m, x) => (x.atualizadoEm > m ? x.atualizadoEm : m), '') || null };
}

// "Trazer do Sobre a empresa": a IA lê o texto e sugere itens (a equipe confere antes de salvar)
async function sugerirDoTexto(empresa, bot) {
  const texto = String(bot?.conhecimento || '').trim();
  if (texto.replace(/\.\.\.|R\$ \.\.\./g, '').length < 30) throw Object.assign(new Error('"Sobre a empresa" ainda não tem serviços e preços escritos.'), { status: 400 });
  const r = await require('./ia').gerarTexto(
    bot,
    empresa,
    'Você extrai do texto de uma empresa a lista de serviços e produtos que ela vende, com preço. Responda SOMENTE com JSON, sem texto antes ou depois. Não invente nada: só o que está escrito.',
    `Texto da empresa:\n<texto>\n${texto.slice(0, 12000)}\n</texto>\n\nJSON: {"itens": [{"tipo": "servico|produto", "nome": "...", "preco": "350,00 ou vazio", "precoAte": "valor máximo se for faixa, ou vazio", "precoObs": "ex.: a partir de, no Pix, em até 3x — ou vazio", "duracao": "tempo/prazo se houver", "descricao": "detalhes curtos do que está escrito"}]}`,
    3000,
    { barato: true }
  );
  const m = String(r).match(/\{[\s\S]*\}/);
  const itens = m ? JSON.parse(m[0]).itens : [];
  const ja = new Set(itensDa(empresa).map((x) => semAcento(x.nome)));
  return (Array.isArray(itens) ? itens : [])
    .map((x) => ({ tipo: x.tipo === 'produto' ? 'produto' : 'servico', nome: limpar(x.nome, 100), preco: lerPreco(x.preco), precoAte: lerPreco(x.precoAte), precoObs: limpar(x.precoObs, 120), duracao: limpar(x.duracao, 80), descricao: String(x.descricao || '').trim().slice(0, 1500) }))
    .filter((x) => x.nome && !ja.has(semAcento(x.nome)))
    .slice(0, 50);
}

module.exports = { itensDa, criar, atualizar, apagar, esquecerMidia, paraIa, midiasLigadas, resumo, sugerirDoTexto, lerPreco, textoPreco };
