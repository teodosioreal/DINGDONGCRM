// gastos.js — gastos da empresa lançados por um grupo do WhatsApp.
//
// A empresa escolhe um grupo (o número da empresa participa dele). Tudo o que
// alguém manda nesse grupo vira gasto no Faturamento:
//   • texto: "gastei 50 gasolina", "120,00 aluguel", "35 almoço categoria equipe"
//     → o código acha o valor e a categoria (por palavras-chave) — sem IA;
//   • comprovante (foto/PDF do Pix que a empresa PAGOU): lido sem IA primeiro;
//     a IA (modelo barato) só ajuda quando a leitura simples não acha o valor.
// O CRM responde no grupo confirmando ("✅ Gasto de R$ 50,00 · Combustível").
// "desfazer" (ou "apagar último") no grupo remove o último gasto lançado.
// As mensagens dos outros grupos continuam ignoradas.

const crypto = require('crypto');
const { estado, salvar, agora, novoId } = require('./db');

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const CATEGORIAS_PADRAO = [
  { nome: 'Combustível', palavras: 'gasolina, combustivel, etanol, alcool, diesel, posto, abasteci, abastecer, gnv' },
  { nome: 'Alimentação', palavras: 'almoco, janta, jantar, lanche, comida, cafe, restaurante, ifood, padaria, marmita, mercado, agua mineral' },
  { nome: 'Material e produtos', palavras: 'material, materiais, produto, produtos, peca, pecas, estoque, fornecedor, mercadoria, insumo, insumos, ferramenta, embalagem' },
  { nome: 'Marketing', palavras: 'anuncio, anuncios, ads, trafego, facebook, instagram, google, meta, impulsionar, impulsionamento, panfleto, propaganda, marketing' },
  { nome: 'Aluguel e contas', palavras: 'aluguel, luz, energia, agua, internet, telefone, celular, condominio, gas, iptu' },
  { nome: 'Equipe', palavras: 'salario, diaria, funcionario, funcionarios, comissao, freela, ajudante, vale, adiantamento, folha' },
  { nome: 'Transporte e entrega', palavras: 'uber, 99, frete, entrega, correio, correios, motoboy, estacionamento, pedagio, onibus, passagem' },
  { nome: 'Impostos e taxas', palavras: 'imposto, impostos, das, mei, taxa, taxas, tarifa, juros, contador, contabilidade, multa' },
  { nome: 'Sistemas e assinaturas', palavras: 'sistema, assinatura, software, aplicativo, mensalidade, plano, hospedagem, dominio, crm' },
  { nome: 'Outros', palavras: '' }
];

function configDa(empresa) {
  const c = empresa.gastos || {};
  return {
    grupoJid: c.grupoJid || '',
    grupoNome: c.grupoNome || '',
    conectadoEm: c.conectadoEm || null,
    responderNoGrupo: c.responderNoGrupo !== false,
    usarIa: c.usarIa !== false,
    categorias: Array.isArray(c.categorias) && c.categorias.length ? c.categorias : CATEGORIAS_PADRAO,
    ultimaBusca: c.ultimaBusca || null
  };
}

function gastosDa(empresa) {
  return (estado.gastos || []).filter((g) => g.empresaId === empresa.id);
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------------------------------------------------------- entender o texto

// "R$ 1.250,90", "50", "50,00", "35.5", "120 reais" → número (o primeiro valor do texto)
function valorDoTexto(texto) {
  const t = String(texto || '');
  const re = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(?:reais|real|conto|pila))?/gi;
  let m;
  while ((m = re.exec(t))) {
    const bruto = m[1];
    const antes = t.slice(Math.max(0, m.index - 1), m.index);
    const depois = t.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (/[\d/:\p{L}-]/u.test(antes) || /[\d/:%]/.test(depois)) continue; // data, hora, telefone, porcentagem, "nota2"
    if (/^\d{7,}$/.test(bruto)) continue;
    let n;
    if (/,\d{1,2}$/.test(bruto)) n = Number(bruto.replace(/\./g, '').replace(',', '.'));
    else if (/\.\d{3}/.test(bruto)) n = Number(bruto.replace(/\./g, ''));
    else n = Number(bruto);
    if (Number.isFinite(n) && n > 0 && n <= 1000000) return { valor: Math.round(n * 100) / 100, trecho: m[0] };
  }
  return null;
}

// categoria escrita de propósito: "categoria equipe", "cat: marketing", "#combustivel"
function categoriaEscrita(texto) {
  const m = String(texto || '').match(/(?:\bcategoria|\bcat)\s*[:=-]?\s*([\p{L}\d][\p{L}\d ]{1,40})$|#([\p{L}\d_]{2,40})/iu);
  return m ? (m[1] || m[2]).replace(/_/g, ' ').trim() : '';
}

function acharCategoria(empresa, ...textos) {
  const lista = configDa(empresa).categorias;
  const junto = ` ${sem(textos.filter(Boolean).join(' ')).replace(/[^\w ]/g, ' ').replace(/\s+/g, ' ')} `;
  // 1) nome da categoria no texto
  for (const c of lista) if (junto.includes(` ${sem(c.nome)} `)) return c.nome;
  // 2) palavras-chave
  for (const c of lista) {
    const palavras = String(c.palavras || '').split(/[,;\n]+/).map((p) => sem(p).trim()).filter(Boolean);
    if (palavras.some((p) => junto.includes(` ${p} `) || (p.length >= 5 && junto.includes(` ${p}`)))) return c.nome;
  }
  return '';
}

// nome de categoria escrito pela pessoa → a categoria cadastrada parecida, ou uma nova
function resolverCategoria(empresa, escrita) {
  const lista = configDa(empresa).categorias;
  const s = sem(escrita);
  const igual = lista.find((c) => sem(c.nome) === s) || lista.find((c) => sem(c.nome).startsWith(s) || s.startsWith(sem(c.nome))) || null;
  if (igual) return igual.nome;
  const pelaPalavra = acharCategoria(empresa, escrita);
  if (pelaPalavra) return pelaPalavra;
  // categoria nova: entra na lista da empresa
  const nome = escrita.charAt(0).toUpperCase() + escrita.slice(1).toLowerCase();
  empresa.gastos = { ...(empresa.gastos || {}), categorias: [...lista.filter((c) => c.nome !== 'Outros'), { nome, palavras: '' }, ...lista.filter((c) => c.nome === 'Outros')] };
  return nome;
}

// Texto do grupo → { valor, categoria, descricao } ou null (conversa normal, sem valor)
function interpretarTexto(empresa, texto) {
  const t = String(texto || '').trim();
  if (!t || t.length > 300) return null;
  const v = valorDoTexto(t);
  if (!v) return null;
  const escrita = categoriaEscrita(t);
  const descricao = t
    .replace(v.trecho, ' ')
    .replace(/(?:\bcategoria|\bcat)\s*[:=-]?\s*[\p{L}\d][\p{L}\d ]{1,40}$|#[\p{L}\d_]{2,40}/iu, ' ')
    .replace(/\b(gastei|gasto|gastos|paguei|pago|comprei|compra|com|de|no|na|em|do|da|reais|real|r\$)\b/gi, ' ')
    .replace(/[-:=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categoria = escrita ? resolverCategoria(empresa, escrita) : acharCategoria(empresa, descricao) || 'Outros';
  return { valor: v.valor, categoria, descricao: descricao.slice(0, 200) };
}

// ---------------------------------------------------------------- registrar

function registrar(empresa, dados, extra = {}) {
  estado.gastos = estado.gastos || [];
  const g = {
    id: novoId('gst'),
    empresaId: empresa.id,
    valor: Math.round(Number(dados.valor) * 100) / 100,
    categoria: dados.categoria || 'Outros',
    descricao: String(dados.descricao || '').slice(0, 200),
    data: dados.data || agora(),
    origem: extra.origem || 'manual',
    lidoPor: extra.lidoPor || extra.origem || 'manual',
    autor: String(extra.autor || '').slice(0, 80),
    wid: extra.wid || undefined,
    hash: extra.hash || undefined,
    recebedor: dados.recebedor ? String(dados.recebedor).slice(0, 120) : undefined,
    anexo: extra.anexo || undefined,
    criadoEm: agora()
  };
  estado.gastos.push(g);
  salvar();
  return g;
}

// ---------------------------------------------------------------- mensagens do grupo

const vistas = new Set(); // ids já processados (webhook + busca periódica)
function jaVista(empresa, wid) {
  if (!wid) return false;
  if (vistas.has(wid)) return true;
  if (gastosDa(empresa).some((g) => g.wid === wid)) return true;
  vistas.add(wid);
  if (vistas.size > 3000) vistas.clear();
  return false;
}

function ehDoGrupo(empresa, jid) {
  const c = configDa(empresa);
  return Boolean(c.grupoJid) && jid === c.grupoJid;
}

async function responder(empresa, texto) {
  const c = configDa(empresa);
  if (!c.responderNoGrupo || !c.grupoJid) return;
  const whatsapp = require('./whatsapp');
  await whatsapp.enviarTexto(empresa, c.grupoJid, texto, { digitando: false }).catch((err) => console.error(`[gastos ${empresa.id}] responder no grupo:`, err.message));
}

const ehDesfazer = (t) => /^\s*(desfazer|apagar (o )?ultimo( gasto)?|cancelar (o )?ultimo( gasto)?|excluir (o )?ultimo( gasto)?)\s*[.!]?\s*$/.test(sem(t));

// Uma mensagem do grupo de gastos (chamada pelo webhook e pela busca periódica).
// Devolve o gasto criado (ou null).
async function daMensagem(empresa, msg, { aoVivo = true } = {}) {
  const wid = msg?.key?.id;
  if (!ehDoGrupo(empresa, msg?.key?.remoteJid) || jaVista(empresa, wid)) return null;
  const whatsapp = require('./whatsapp');
  if (whatsapp.foiEnviadoPeloCrm(wid)) return null; // a própria confirmação do CRM
  const c = configDa(empresa);
  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || 0;
  if (c.conectadoEm && ts && ts * 1000 < new Date(c.conectadoEm).getTime() - 60000) return null; // mensagem de antes de conectar o grupo
  const data = ts ? new Date(ts * 1000).toISOString() : agora();
  const autor = msg.pushName || (msg.key.fromMe ? 'Empresa' : '');
  const m = msg.message || {};
  const legenda = m.imageMessage?.caption || m.documentMessage?.caption || m.documentWithCaptionMessage?.message?.documentMessage?.caption || '';
  const texto = m.conversation || m.extendedTextMessage?.text || '';

  // "desfazer" → apaga o último gasto do grupo
  if (texto && ehDesfazer(texto)) {
    const ultimo = gastosDa(empresa).filter((g) => g.origem === 'grupo').sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))[0];
    if (!ultimo) return null;
    estado.gastos = estado.gastos.filter((g) => g.id !== ultimo.id);
    salvar();
    if (aoVivo) await responder(empresa, `↩️ Apaguei o último gasto: ${brl(ultimo.valor)} · ${ultimo.categoria}${ultimo.descricao ? ` (${ultimo.descricao})` : ''}`);
    return null;
  }

  // comprovante (foto ou PDF)
  const ehArquivo = m.imageMessage || m.documentMessage || m.documentWithCaptionMessage;
  if (ehArquivo) {
    const g = await doComprovante(empresa, msg, { legenda, data, autor });
    if (g && aoVivo) await responder(empresa, `✅ Gasto de ${brl(g.valor)} · ${g.categoria}${g.descricao ? ` (${g.descricao})` : ''} — lido do comprovante.${g.categoria === 'Outros' ? ' Para escolher a categoria, mande na legenda: "categoria combustível".' : ''}`);
    else if (!g && aoVivo) await responder(empresa, '⚠️ Não consegui ler o valor deste comprovante. Escreva assim: *gastei 50 gasolina*');
    return g;
  }

  if (!texto || /^\s*(✅|↩️|⚠️|💸)/.test(texto)) return null; // as respostas do próprio CRM no grupo
  const d = interpretarTexto(empresa, texto);
  if (!d) return null; // conversa normal no grupo
  const g = registrar(empresa, { ...d, data }, { origem: 'grupo', lidoPor: 'texto', autor, wid });
  if (aoVivo) await responder(empresa, `✅ Gasto de ${brl(g.valor)} · ${g.categoria}${g.descricao ? ` (${g.descricao})` : ''}${g.categoria === 'Outros' ? '\nPara escolher a categoria: "gastei 50 gasolina categoria combustível".' : ''}`);
  return g;
}

async function doComprovante(empresa, msg, { legenda, data, autor }) {
  const whatsapp = require('./whatsapp');
  const comprovantes = require('./comprovantes');
  const midias = require('./midias');
  const r = await whatsapp.evolution(empresa, 'POST', '/chat/getBase64FromMediaMessage/{instancia}', { message: msg.message ? { key: msg.key, message: msg.message } : { key: msg.key }, convertToMp4: false }).catch(() => null);
  if (!r?.base64) return null;
  const m = msg.message || {};
  const info = m.imageMessage || m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage || {};
  const mimetype = r.mimetype || info.mimetype || '';
  if (!/^image\/|pdf/i.test(mimetype)) return null;
  const buffer = Buffer.from(r.base64, 'base64');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const repetido = gastosDa(empresa).find((g) => g.hash === hash);
  if (repetido) return repetido;
  let dados = null;
  let lidoPor = 'ocr';
  try {
    const textoCompleto = await comprovantes.lerTexto(buffer, mimetype);
    lidoPor = /pdf/i.test(mimetype) ? 'texto' : 'ocr';
    const x = comprovantes.interpretar(textoCompleto);
    if (x.valor) dados = x;
  } catch (err) {
    console.error(`[gastos ${empresa.id}] leitura sem IA:`, err.message);
  }
  if (!dados && configDa(empresa).usarIa) {
    try {
      const ia = require('./ia');
      const x = await ia.lerComprovante(whatsapp.botDoWhatsapp(empresa), empresa, r.base64, mimetype);
      const valor = x?.valor ? comprovantes.paraNumero(x.valor) ?? Number(x.valor) : null;
      if (valor) {
        dados = { ...x, valor };
        lidoPor = 'ia';
      }
    } catch (err) {
      console.error(`[gastos ${empresa.id}] IA:`, err.message);
    }
  }
  // sem valor no arquivo, mas a legenda tem ("50 gasolina")
  const daLegenda = legenda ? interpretarTexto(empresa, legenda) : null;
  if (!dados?.valor && daLegenda) dados = { valor: daLegenda.valor };
  if (!dados?.valor) return null;
  const escrita = categoriaEscrita(legenda);
  const categoria = escrita ? resolverCategoria(empresa, escrita) : acharCategoria(empresa, legenda, dados.recebedor) || 'Outros';
  const descricao = (daLegenda?.descricao || String(legenda || '').replace(/(?:\bcategoria|\bcat)\s*[:=-]?.*$|#[\p{L}\d_]+/iu, '').trim() || (dados.recebedor ? `para ${dados.recebedor}` : '')).slice(0, 200);
  const anexo = midias.salvarAnexo(`gastos-${empresa.id}`, buffer, mimetype, r.fileName || info.fileName || 'comprovante');
  // data do comprovante só se for perto de quando mandaram (leitura errada não joga o gasto em outro mês)
  const dataBoa = dados.data && Math.abs(new Date(dados.data).getTime() - new Date(data).getTime()) < 31 * 86400000 ? dados.data : data;
  return registrar(empresa, { valor: dados.valor, categoria, descricao, data: dataBoa, recebedor: dados.recebedor }, { origem: 'grupo', lidoPor, autor, wid: msg.key.id, hash, anexo: { arquivo: anexo.arquivo, mimetype: anexo.mimetype } });
}

// ---------------------------------------------------------------- grupos e conexão

async function listarGrupos(empresa) {
  const whatsapp = require('./whatsapp');
  const r = await whatsapp.evolution(empresa, 'GET', '/group/fetchAllGroups/{instancia}?getParticipants=false');
  const lista = Array.isArray(r) ? r : r?.groups || [];
  return lista
    .map((g) => ({ id: g.id || g.jid, nome: g.subject || g.name || 'Grupo sem nome', membros: g.size || g.participants?.length || null }))
    .filter((g) => /@g\.us$/.test(g.id || ''))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// A instância da empresa precisa receber mensagens de grupo (groupsIgnore = false)
// para o grupo de gastos funcionar. Só mexe na instância DESTA empresa.
async function ajustarGrupos(empresa, receber) {
  const whatsapp = require('./whatsapp');
  const atual = await whatsapp.evolution(empresa, 'GET', '/settings/find/{instancia}').catch(() => null);
  const base = atual?.settings || atual || {};
  if (base.groupsIgnore === !receber) return false;
  const { id, instanceId, createdAt, updatedAt, ...resto } = base;
  await whatsapp.evolution(empresa, 'POST', '/settings/set/{instancia}', { ...resto, groupsIgnore: !receber });
  return true;
}

async function conectarGrupo(empresa, { grupoJid, grupoNome }) {
  if (!grupoJid) {
    empresa.gastos = { ...(empresa.gastos || {}), grupoJid: '', grupoNome: '', conectadoEm: null };
    salvar();
    await ajustarGrupos(empresa, false).catch((err) => console.error(`[gastos ${empresa.id}] groupsIgnore:`, err.message));
    return configDa(empresa);
  }
  if (!/@g\.us$/.test(grupoJid)) throw Object.assign(new Error('Escolha um grupo da lista.'), { status: 400 });
  try {
    await ajustarGrupos(empresa, true);
  } catch (err) {
    throw Object.assign(new Error(`Não consegui liberar as mensagens de grupo na conexão do WhatsApp: ${err.message}`), { status: 502 });
  }
  empresa.gastos = { ...(empresa.gastos || {}), grupoJid, grupoNome: String(grupoNome || '').slice(0, 100), conectadoEm: agora() };
  salvar();
  await responder(empresa, '💸 Grupo de gastos conectado ao CRM!\nMande aqui o que a empresa gastou, por exemplo:\n• *gastei 50 gasolina*\n• *120 aluguel*\n• *35 almoço categoria equipe*\n• ou a foto/PDF do comprovante do Pix\nPara apagar o último: *desfazer*');
  return configDa(empresa);
}

// Busca as mensagens do grupo que não chegaram pelo webhook (ex.: WhatsApp caiu)
async function buscarNoGrupo(empresa) {
  const c = configDa(empresa);
  if (!c.grupoJid) return 0;
  const whatsapp = require('./whatsapp');
  const desde = new Date(Math.max(new Date(c.conectadoEm || 0).getTime(), Date.now() - 3 * 86400000));
  const r = await whatsapp.evolution(empresa, 'POST', '/chat/findMessages/{instancia}', { where: { key: { remoteJid: c.grupoJid }, messageTimestamp: { gte: desde.toISOString(), lte: new Date(Date.now() + 60000).toISOString() } }, page: 1, offset: 200 });
  const recs = (r?.messages?.records || []).slice().sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0));
  let n = 0;
  for (const msg of recs) {
    if (msg?.key?.remoteJid !== c.grupoJid) continue;
    const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || 0;
    if (ts && Date.now() - ts * 1000 < 60000) continue; // recente: o webhook cuida
    const g = await daMensagem(empresa, msg, { aoVivo: false }).catch(() => null);
    if (g) n++;
  }
  empresa.gastos = { ...(empresa.gastos || {}), ultimaBusca: { em: agora(), achados: n } };
  salvar();
  if (n) console.log(`[gastos ${empresa.id}] ${n} gasto(s) recuperado(s) do grupo`);
  return n;
}

let timer = null;
function iniciar() {
  if (timer || process.env.GASTOS_BUSCA === 'nao') return;
  const ms = Number(process.env.GASTOS_BUSCA_MS) || 30 * 60 * 1000;
  const rodar = async () => {
    for (const e of estado.empresas) {
      if (e.ativa === false || !configDa(e).grupoJid) continue;
      await buscarNoGrupo(e).catch((err) => console.error(`[gastos ${e.id}] busca:`, err.message));
    }
  };
  setTimeout(() => rodar().catch(() => {}), Math.min(3 * 60 * 1000, ms)).unref?.();
  timer = setInterval(() => rodar().catch(() => {}), ms);
  timer.unref?.();
}

// ---------------------------------------------------------------- números para o painel

const mesDe = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7);

function resumo(empresa, mes) {
  const alvo = mes || mesDe(new Date().toISOString());
  const doMes = gastosDa(empresa).filter((g) => mesDe(g.data) === alvo);
  const soma = (l) => Math.round(l.reduce((s, g) => s + (g.valor || 0), 0) * 100) / 100;
  const porCategoria = {};
  for (const g of doMes) porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + g.valor;
  const vendasMes = require('./comprovantes')
    .vendasDa(empresa)
    .filter((v) => v.status === 'confirmada' && mesDe(v.data) === alvo);
  const faturamento = soma(vendasMes);
  const gastos = soma(doMes);
  return {
    mes: alvo,
    faturamento,
    gastos,
    lucro: Math.round((faturamento - gastos) * 100) / 100,
    quantidade: doMes.length,
    porCategoria: Object.entries(porCategoria)
      .map(([categoria, total]) => ({ categoria, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total)
  };
}

module.exports = {
  CATEGORIAS_PADRAO,
  configDa,
  gastosDa,
  interpretarTexto,
  valorDoTexto,
  acharCategoria,
  registrar,
  ehDoGrupo,
  daMensagem,
  listarGrupos,
  conectarGrupo,
  buscarNoGrupo,
  iniciar,
  resumo,
  mesDe
};
