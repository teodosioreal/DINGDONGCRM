// comprovantes.js — vendas pelo WhatsApp: quando o cliente manda o comprovante
// do Pix (foto ou PDF), o CRM lê o comprovante e registra a venda no
// Faturamento da empresa.
//
// Para não gastar crédito de IA, a leitura é feita primeiro SEM IA:
//  - PDF: extrai o texto do arquivo;
//  - foto/print: reconhecimento de texto (OCR) rodando no próprio servidor.
// Só se não der para ler assim (foto torta, borrada…) a IA da empresa tenta,
// e isso pode ser desligado no painel.
//
// Anti-fraude: se a empresa cadastrar quem recebe (nome, CNPJ/CPF ou chave
// Pix), comprovante para outra pessoa, repetido ou antigo fica "A conferir".

const path = require('path');
const crypto = require('crypto');
const { estado, salvar, novoId, agora } = require('./db');
const leads = require('./leads');

// ---------------------------------------------------------------- ler o texto sem IA

let ocrOcupado = Promise.resolve();

// OCR local (tesseract.js + português embutido, funciona sem internet).
// Um de cada vez, para não pesar no servidor.
function textoDaImagem(buffer) {
  const tarefa = ocrOcupado.then(async () => {
    let tesseract;
    try {
      tesseract = require('tesseract.js');
    } catch {
      return '';
    }
    const langPath = path.dirname(require.resolve('@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz'));
    const worker = await tesseract.createWorker('por', 1, { langPath, cacheMethod: 'none', gzip: true });
    try {
      const r = await worker.recognize(buffer);
      return r.data.text || '';
    } finally {
      await worker.terminate().catch(() => {});
    }
  });
  ocrOcupado = tarefa.catch(() => {});
  return Promise.race([tarefa, new Promise((_, rej) => setTimeout(() => rej(new Error('OCR demorou demais')), 60000))]);
}

async function textoDoPdf(buffer) {
  let PDFParse;
  try {
    ({ PDFParse } = require('pdf-parse'));
  } catch {
    return '';
  }
  const parser = new PDFParse({ data: buffer });
  try {
    const r = await parser.getText();
    return r.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function lerTexto(buffer, mimetype) {
  if (/pdf/i.test(mimetype)) return textoDoPdf(buffer);
  if (/^image\//i.test(mimetype)) return textoDaImagem(buffer);
  return '';
}

// ---------------------------------------------------------------- entender o texto

const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

function paraNumero(v) {
  // "1.250,90" → 1250.9 ; "380,00" → 380 ; "1250.90" → 1250.9
  let t = String(v).replace(/[^\d.,]/g, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,2}$/.test(t) && (t.match(/\./g) || []).length === 1) t = t.replace(/,/g, '');
  else t = t.replace(/[.,]/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function acharValor(linhas) {
  const dinheiro = /R\$\s*([\d.]{1,12},\d{2})/i;
  // 1) valor logo depois da palavra "Valor"
  for (let i = 0; i < linhas.length; i++) {
    if (/^\s*valor( (do|da) (pix|transfer[eê]ncia|pagamento))?( pago| total| enviado)?\s*:?\s*/i.test(linhas[i]) && !/tarifa|juros|desconto/i.test(linhas[i])) {
      for (const l of [linhas[i], linhas[i + 1] || '', linhas[i + 2] || '']) {
        const m = l.match(dinheiro) || l.match(/^\s*([\d.]{1,12},\d{2})\s*$/);
        if (m) return paraNumero(m[1]);
      }
    }
  }
  // 2) o maior "R$ …" do comprovante
  const todos = linhas.flatMap((l) => [...l.matchAll(/R\$\s*([\d.]{1,12},\d{2})/gi)].map((m) => paraNumero(m[1]))).filter(Boolean);
  return todos.length ? Math.max(...todos) : null;
}

function acharData(texto) {
  let m = texto.match(/(\d{2})\/(\d{2})\/(\d{4})(?:[^\d]{1,12}(\d{2}):(\d{2}))?/);
  if (m) return montarData(m[3], m[2], m[1], m[4], m[5]);
  m = texto.match(/(\d{1,2})\s+(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\.?\s+(?:de\s+)?(\d{4})(?:[^\d]{1,12}(\d{2}):(\d{2}))?/i);
  if (m) return montarData(m[3], MESES[m[2].toLowerCase()], m[1], m[4], m[5]);
  m = texto.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return montarData(m[1], m[2], m[3], m[4], m[5]);
  return null;
}

function montarData(ano, mes, dia, h = '12', min = '00') {
  // horário de Brasília (UTC-3)
  const d = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia), Number(h || 12) + 3, Number(min || 0)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const SECAO_DESTINO = /^(destino|recebedor|favorecido|para|quem recebeu|dados do recebedor|benefici[aá]rio)\b/i;
const SECAO_ORIGEM = /^(origem|pagador|de|quem pagou|remetente|dados do pagador)\b/i;

function acharPartes(linhas) {
  let secao = '';
  let pagador = '';
  let recebedor = '';
  let banco = '';
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim();
    if (SECAO_DESTINO.test(l)) secao = 'destino';
    else if (SECAO_ORIGEM.test(l)) secao = 'origem';
    const nome = l.match(/^(?:nome|nome do (?:pagador|recebedor|favorecido)|pagador|recebedor|favorecido|para|de)\s*:?\s+(.{3,80})$/i);
    const valorNome = nome ? nome[1].trim() : '';
    if (valorNome && !/^\d|R\$/.test(valorNome)) {
      if (/^(pagador|de)\b/i.test(l) || (secao === 'origem' && !/^(recebedor|favorecido|para)\b/i.test(l))) pagador = pagador || valorNome;
      else if (/^(recebedor|favorecido|para)\b/i.test(l) || secao === 'destino') recebedor = recebedor || valorNome;
    }
    // "Pagador" numa linha e o nome na linha de baixo
    const proxima = (linhas[i + 1] || '').trim();
    const ehNome = (x) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'&-]{2,79}$/.test(x) && !SECAO_DESTINO.test(x) && !SECAO_ORIGEM.test(x) && !/^(nome|cpf|cnpj|institui|banco|ag[eê]ncia|conta|chave|valor|data|tipo)/i.test(x);
    if (/^(pagador|de|origem|quem pagou|remetente)\s*:?$/i.test(l) && ehNome(proxima)) pagador = pagador || proxima;
    if (/^(recebedor|favorecido|para|destino|quem recebeu|benefici[aá]rio)\s*:?$/i.test(l) && ehNome(proxima)) recebedor = recebedor || proxima;
    const inst = l.match(/^(?:institui[cç][aã]o|banco)\s*:?\s+(.{2,60})$/i);
    if (inst && secao === 'origem' && !banco) banco = inst[1].trim();
  }
  return { pagador, recebedor, banco };
}

function interpretar(texto) {
  const t = String(texto || '').replace(/\r/g, '');
  const linhas = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const palavras = /comprovante|pix|transfer[eê]ncia|pagamento (efetuado|realizado|enviado)|recibo|autentica[cç][aã]o/i.test(t);
  const valor = acharValor(linhas);
  const idTransacao = (t.match(/\bE[0-9A-Za-z]{31}\b/) || [])[0] || (t.match(/(?:id|identificador|autentica[cç][aã]o|c[oó]digo)[^\n:]*:?\s*\n?\s*([A-Za-z0-9]{12,40})/i) || [])[1] || '';
  const forma = /pix/i.test(t) ? 'Pix' : /boleto/i.test(t) ? 'Boleto' : /ted|doc|transfer/i.test(t) ? 'Transferência' : 'Pix';
  const ehComprovante = Boolean(palavras && valor);
  return { ehComprovante, valor, data: acharData(t), idTransacao, forma, ...acharPartes(linhas) };
}

// ---------------------------------------------------------------- vendas

function configDa(empresa) {
  const c = empresa.faturamento || {};
  return {
    ativo: c.ativo !== false,
    usarIa: c.usarIa !== false,
    recebedores: String(c.recebedores || ''),
    moverParaFechado: c.moverParaFechado !== false
  };
}

function vendasDa(empresa) {
  return (estado.vendas || []).filter((v) => v.empresaId === empresa.id);
}

const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Confere se o comprovante foi para a empresa (nome, CNPJ/CPF ou chave Pix)
function recebedorConfere(empresa, textoCompleto, recebedor) {
  const lista = configDa(empresa)
    .recebedores.split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
  if (!lista.length) return null; // não configurado
  const nomes = lista.filter((x) => x.replace(/\D/g, '').length < 8);
  const numeros = lista.map((x) => x.replace(/\D/g, '')).filter((d) => d.length >= 8);
  const digitosTexto = limpar(textoCompleto).replace(/\D/g, '');
  const nomeConfere = recebedor && nomes.some((n) => limpar(recebedor).includes(limpar(n)) || limpar(n).includes(limpar(recebedor)));
  const chaveConfere = numeros.some((d) => digitosTexto.includes(d)) || lista.some((x) => /@|\+/.test(x) && limpar(textoCompleto).includes(limpar(x)));
  // o nome do recebedor lido manda: se ele for outro, fica "a conferir" mesmo com o CNPJ no texto
  if (recebedor && nomes.length) return Boolean(nomeConfere);
  return Boolean(nomeConfere || chaveConfere || (!recebedor && nomes.some((n) => limpar(textoCompleto).includes(limpar(n)))));
}

function etapaFechado(empresa) {
  const etapas = leads.etapasDa(empresa);
  return etapas.find((e) => /fechad|ganh|vendid|conclu/i.test(limpar(e))) || '';
}

function brl(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Registra (ou marca como repetido) um comprovante lido. Retorna a venda.
function registrar(empresa, lead, dados, extra = {}) {
  estado.vendas = estado.vendas || [];
  const motivos = [];
  const hash = extra.hash || '';
  const repetida = vendasDa(empresa).find(
    (v) => v.status !== 'cancelada' && ((dados.idTransacao && v.idTransacao === dados.idTransacao) || (hash && v.hash === hash))
  );
  if (repetida) return { venda: repetida, repetida: true };
  const confere = recebedorConfere(empresa, extra.textoCompleto || '', dados.recebedor);
  if (confere === false) motivos.push('o recebedor do comprovante não é a empresa');
  if (dados.data && Date.now() - new Date(dados.data).getTime() > 3 * 24 * 3600 * 1000) motivos.push('comprovante com data antiga');
  if (extra.lidoPor === 'ia') motivos.push('lido pela IA (confira o valor)');
  const venda = {
    id: novoId('vnd'),
    empresaId: empresa.id,
    leadId: lead?.id || null,
    cliente: lead?.nome || dados.pagador || '',
    valor: dados.valor,
    data: dados.data || agora(),
    forma: dados.forma || 'Pix',
    pagador: dados.pagador || '',
    recebedor: dados.recebedor || '',
    banco: dados.banco || '',
    idTransacao: dados.idTransacao || '',
    origem: extra.origem || 'comprovante',
    lidoPor: extra.lidoPor || 'texto',
    status: motivos.length && extra.lidoPor !== 'manual' ? 'conferir' : 'confirmada',
    motivoConferir: motivos.join('; '),
    anexo: extra.anexo || null,
    descricao: extra.descricao || '',
    hash,
    criadoEm: agora()
  };
  estado.vendas.push(venda);
  if (lead && venda.status === 'confirmada') aoVender(empresa, lead);
  salvar();
  return { venda, repetida: false };
}

// Lead que pagou: vai para "Fechado" e ganha a etiqueta "Cliente"
function aoVender(empresa, lead) {
  const cfg = configDa(empresa);
  const fechado = etapaFechado(empresa);
  if (cfg.moverParaFechado && fechado) leads.moverEtapa(lead, empresa, fechado, 'sistema');
  leads.aplicarEtiqueta(lead, empresa, 'Cliente');
}

function hashDe(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

// Chamado quando chega foto/PDF do cliente no WhatsApp.
// Retorna { texto } para a conversa (a IA lê isso) ou null se não era comprovante.
async function processarArquivo(empresa, lead, { buffer, mimetype, anexo, lerComIa }) {
  const cfg = configDa(empresa);
  if (!cfg.ativo) return null;
  let dados = null;
  let lidoPor = 'texto';
  let textoCompleto = '';
  try {
    textoCompleto = await lerTexto(buffer, mimetype);
    lidoPor = /pdf/i.test(mimetype) ? 'texto' : 'ocr';
    const r = interpretar(textoCompleto);
    if (r.ehComprovante) dados = r;
  } catch (err) {
    console.error(`[comprovante ${lead?.id}] leitura sem IA:`, err.message);
  }
  // não deu para ler sem IA, mas parece comprovante → IA (se permitido)
  if (!dados && cfg.usarIa && lerComIa && (/comprovante|pix|transfer/i.test(textoCompleto) || !textoCompleto.trim() || /pdf/i.test(mimetype))) {
    try {
      const r = await lerComIa();
      if (r?.ehComprovante && r.valor) {
        dados = { ...r, valor: paraNumero(r.valor) ?? Number(r.valor), data: r.data ? acharData(String(r.data)) || null : null };
        lidoPor = 'ia';
      }
    } catch (err) {
      console.error(`[comprovante ${lead?.id}] IA:`, err.message);
    }
  }
  if (!dados || !dados.valor) return null;
  const { venda, repetida } = registrar(empresa, lead, dados, { lidoPor, textoCompleto, hash: hashDe(buffer), anexo: anexo ? { leadId: lead?.id, arquivo: anexo.arquivo } : null });
  const valor = brl(venda.valor);
  if (repetida) return { venda, texto: `[o cliente mandou de novo um comprovante de ${valor} que já tinha sido registrado]` };
  return {
    venda,
    texto:
      venda.status === 'confirmada'
        ? `[o cliente enviou o comprovante de pagamento ${venda.forma} de ${valor} — pagamento registrado. Agradeça e confirme os próximos passos.]`
        : `[o cliente enviou um comprovante de ${valor}; a equipe vai conferir o pagamento. Agradeça e diga que a equipe confirma em instantes, sem prometer nada.]`
  };
}

// ---------------------------------------------------------------- números do Faturamento

function inicioDoDiaBrasilia(d = new Date()) {
  const b = new Date(d.getTime() - 3 * 3600 * 1000);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) + 3 * 3600 * 1000);
}

function resumo(empresa) {
  const validas = vendasDa(empresa).filter((v) => v.status === 'confirmada');
  const hoje = inicioDoDiaBrasilia();
  const bHoje = new Date(hoje.getTime() - 3 * 3600 * 1000);
  const inicioMes = new Date(Date.UTC(bHoje.getUTCFullYear(), bHoje.getUTCMonth(), 1) + 3 * 3600 * 1000);
  const inicioMesAnterior = new Date(Date.UTC(bHoje.getUTCFullYear(), bHoje.getUTCMonth() - 1, 1) + 3 * 3600 * 1000);
  const soma = (lista) => Math.round(lista.reduce((s, v) => s + (v.valor || 0), 0) * 100) / 100;
  const desde = (t) => validas.filter((v) => new Date(v.data) >= t);
  const doMes = desde(inicioMes);
  const mesAnterior = validas.filter((v) => new Date(v.data) >= inicioMesAnterior && new Date(v.data) < inicioMes);
  const porDia = [];
  for (let i = 29; i >= 0; i--) {
    const ini = new Date(hoje.getTime() - i * 24 * 3600 * 1000);
    const fim = new Date(ini.getTime() + 24 * 3600 * 1000);
    const doDia = validas.filter((v) => new Date(v.data) >= ini && new Date(v.data) < fim);
    porDia.push({ dia: ini.toISOString(), total: soma(doDia), vendas: doDia.length });
  }
  return {
    hoje: soma(desde(hoje)),
    seteDias: soma(desde(new Date(hoje.getTime() - 6 * 24 * 3600 * 1000))),
    mes: soma(doMes),
    mesAnterior: soma(mesAnterior),
    vendasMes: doMes.length,
    ticketMedio: doMes.length ? Math.round((soma(doMes) / doMes.length) * 100) / 100 : 0,
    aConferir: vendasDa(empresa).filter((v) => v.status === 'conferir').length,
    porDia
  };
}

module.exports = {
  interpretar,
  lerTexto,
  paraNumero,
  configDa,
  vendasDa,
  registrar,
  aoVender,
  processarArquivo,
  resumo,
  brl
};
