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
    moverParaFechado: c.moverParaFechado !== false,
    vendaPorFrase: c.vendaPorFrase !== false,
    frasesVenda: String(c.frasesVenda ?? 'obrigado pela preferência, obrigada pela preferência')
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
  return etapas.find((e) => ehEtapaDeVenda(e)) || ''; // "Não fechou" não é a etapa de venda
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
  // a IA já tinha registrado esta venda "em dinheiro" pela conversa: o comprovante
  // chegou depois, então ela vira Pix (com o valor do comprovante) em vez de duplicar
  if (lead && extra.origem === 'comprovante') {
    const daIa = vendasDa(empresa)
      .filter((v) => v.leadId === lead.id && v.origem === 'ia' && v.status !== 'cancelada' && Date.now() - new Date(v.criadoEm).getTime() < 7 * 24 * 3600 * 1000)
      .pop();
    if (daIa) {
      Object.assign(daIa, {
        valor: dados.valor || daIa.valor,
        forma: dados.forma || 'Pix',
        pagador: dados.pagador || daIa.pagador,
        recebedor: dados.recebedor || '',
        banco: dados.banco || '',
        idTransacao: dados.idTransacao || '',
        origem: 'comprovante',
        lidoPor: extra.lidoPor || 'texto',
        anexo: extra.anexo || null,
        hash,
        status: 'confirmada',
        confirmadaEm: daIa.confirmadaEm || agora(),
        motivoConferir: ''
      });
      salvar();
      return { venda: daIa, repetida: false, convertida: true };
    }
  }
  const confere = recebedorConfere(empresa, extra.textoCompleto || '', dados.recebedor);
  if (confere === false) motivos.push('o recebedor do comprovante não é a empresa');
  if (dados.data && Date.now() - new Date(dados.data).getTime() > 3 * 24 * 3600 * 1000) motivos.push('comprovante com data antiga');
  // lido pela IA vale igual ao lido sem IA: com recebedores cadastrados, só confirma
  // se o Pix foi para a empresa (o "recebedor não é a empresa" acima já cuida disso)
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
  if (venda.status === 'confirmada') venda.confirmadaEm = venda.criadoEm;
  estado.vendas.push(venda);
  if (lead && venda.status === 'confirmada') aoVender(empresa, lead);
  // o cliente mandou o comprovante: já sai de "agendado" (etapa, etiqueta, agenda),
  // mesmo que o valor ainda fique para a equipe conferir
  else if (lead && venda.origem === 'comprovante') aoVender(empresa, lead);
  salvar();
  return { venda, repetida: false };
}

// Lead que pagou: vai para "Fechado" e ganha a etiqueta "Cliente"
// Venda concluída (comprovante, IA, equipe ou Faturamento): o cliente sai de
// "agendado" e vai para o lugar certo — etapa de venda no funil, etiqueta de venda
// no WhatsApp e o horário marcado como concluído na aba Agendamentos.
function aoVender(empresa, lead) {
  const cfg = configDa(empresa);
  const fechado = etapaFechado(empresa);
  if (cfg.moverParaFechado && fechado) leads.moverEtapa(lead, empresa, fechado, 'sistema');
  // o mesmo cliente pode ter mais de uma conversa (número com/sem 9, id escondido do WhatsApp):
  // a venda tira TODAS do "agendado"
  for (const c of conversasDoCliente(empresa, lead)) {
    trocarEtiquetaDeVenda(empresa, c);
    concluirAgendamentos(c);
  }
}

// ---------------------------------------------------------------- venda tira da agenda
// Regra: teve venda (comprovante, frase, IA ou confirmada à mão) → o agendamento
// sai de "Próximos" e vai para "Passados" como ✅ venda concluída. Vale para todas as
// conversas do mesmo cliente. Agendamento marcado DEPOIS da venda (ex.: pagou e
// agendou a entrega) continua na agenda.
const digitos = (t) => String(t || '').replace(/\D/g, '');
const sem9 = (n) => (/^55\d{2}9\d{8}$/.test(n) ? n.slice(0, 4) + n.slice(5) : n);
function numeroDa(c) {
  const doJid = /@s\.whatsapp\.net$/.test(c.whatsappJid || '') ? digitos(c.whatsappJid.split('@')[0]) : '';
  const n = doJid || digitos(c.telefone);
  return n.length >= 10 ? sem9(n.length <= 11 ? `55${n}` : n) : '';
}
function conversasDoCliente(empresa, lead) {
  if (!lead) return [];
  const num = numeroDa(lead);
  const lids = new Set([lead.whatsappJid, ...(lead.jidsAlternativos || [])].filter(Boolean));
  return estado.conversas.filter((c) => c.empresaId === empresa.id && (c === lead || (num && numeroDa(c) === num) || (c.whatsappJid && lids.has(c.whatsappJid))));
}

// A venda mais recente deste cliente (em qualquer conversa dele), ou null
function ultimaVendaDoCliente(empresa, lead) {
  const conversas = conversasDoCliente(empresa, lead);
  const ids = new Set(conversas.map((c) => c.id));
  const doCliente = vendasDa(empresa).filter((v) => v.status !== 'cancelada' && v.leadId && ids.has(v.leadId));
  // "Venda concluída" marcada à mão (mesmo sem valor no Faturamento) também conta
  for (const c of conversas) if (c.vendaConcluidaManual && c.vendaConcluidaEm) doCliente.push({ id: `manual-${c.id}`, leadId: c.id, criadoEm: c.vendaConcluidaEm, manual: true });
  return doCliente.sort((a, b) => String(a.criadoEm || a.data).localeCompare(String(b.criadoEm || b.data))).pop() || null;
}

// Agendamento "agendado" que já tem venda depois (ou até 1 h antes) de ter sido marcado → concluído
function concluirVendidos(empresa) {
  let n = 0;
  for (const lead of estado.conversas) {
    if (lead.empresaId !== empresa.id || !(lead.agendamentos || []).some((a) => a.status === 'agendado')) continue;
    const venda = ultimaVendaDoCliente(empresa, lead);
    const vendeu = venda || jaVendeu(empresa, lead); // venda no Faturamento, etapa, etiqueta ou à mão
    if (!vendeu) continue;
    const tVenda = venda ? new Date(venda.criadoEm || venda.data).getTime() : new Date(vendeu.em || 0).getTime() || 0;
    const antes = n;
    for (const a of lead.agendamentos) {
      if (a.status !== 'agendado') continue;
      // marcado depois da venda: fica (menos o "data a combinar" criado pela etiqueta Agendado
      // velha que voltou da cópia do servidor — esse não é agendamento de verdade)
      if (tVenda < new Date(a.criadoEm || 0).getTime() - 3600 * 1000 && !(a.por === 'etiqueta' && !a.quando)) continue;
      a.status = 'concluido';
      a.concluidoEm = agora();
      a.concluidoPor = 'venda';
      n++;
    }
    if (n > antes) trocarEtiquetaDeVenda(empresa, lead);
  }
  if (n) salvar();
  return n;
}

// Ao ligar o servidor: arruma quem já vendeu e continuava em "agendado"
function arrumarVendidosAgendados() {
  let n = 0;
  for (const empresa of estado.empresas) n += concluirVendidos(empresa);
  if (n) console.log(`[faturamento] ${n} agendamento(s) com venda saíram de "Próximos"`);
  return n;
}

function concluirAgendamentos(lead) {
  for (const a of lead.agendamentos || []) {
    if (a.status !== 'agendado') continue;
    a.status = 'concluido';
    a.concluidoEm = new Date().toISOString();
    a.concluidoPor = 'venda';
  }
}

// Etiquetas do WhatsApp: a venda entra → sai "Agendado" (e "Orçamento", "Negociando"…)
// e entra a etiqueta de venda que existir no celular ("Pago", "Vendido", "Venda
// concluída", "Cliente"…). O CRM espelha no WhatsApp sozinho.
// a ordem é a preferência: "Venda Concluída" primeiro (é a que a empresa usa no celular)
const ETIQUETA_VENDA = [/^venda conclu/, /^vend(id|a)/, /conclu/, /^pag[oa]s?\b|^pagamento (ok|confirmado|feito)/, /^fechad/, /^finaliz|^entregue/, /^client/];
const ETIQUETA_ANTES_DA_VENDA = /^(agendad|orcament|negocia|aguardando pag|pendente|interessad|novo cliente|lead)/;
function trocarEtiquetaDeVenda(empresa, lead, preferida = null) {
  const tags = leads.etiquetasDa(empresa);
  const valeComoVenda = (t) => !ETIQUETA_ANTES_DA_VENDA.test(limpar(t.nome).trim()) && !/orcament/.test(limpar(t.nome));
  // a etiqueta de venda que a pessoa pôs (ex.: "Pago" no celular) vale; senão a preferida da lista
  let alvo = preferida ? tags.find((t) => t.id === preferida) || null : null;
  if (!alvo) {
    for (const re of ETIQUETA_VENDA) {
      alvo = tags.find((t) => re.test(limpar(t.nome).trim()) && valeComoVenda(t));
      if (alvo) break;
    }
  }
  // o cliente já tem uma etiqueta de venda: não põe outra
  if (!preferida && (lead.etiquetas || []).some((id) => { const t = tags.find((x) => x.id === id); return t && ehEtiquetaDeVenda(t.nome); })) alvo = null;
  const tirar = new Set(tags.filter((t) => ETIQUETA_ANTES_DA_VENDA.test(limpar(t.nome).trim())).map((t) => t.id));
  const antes = (lead.etiquetas || []).join();
  // guarda o que a venda tirou: se a mesma etiqueta voltar "velha" (cópia do servidor,
  // celular reenviando ao reconectar), o CRM tira de novo — aqui e no WhatsApp
  const tiradas = (lead.etiquetas || []).filter((id) => tirar.has(id));
  if (tiradas.length) {
    lead.tiradasPelaVenda = { ...(lead.tiradasPelaVenda || {}) };
    for (const id of tiradas) lead.tiradasPelaVenda[id] = new Date().toISOString();
  }
  if (alvo && !(lead.etiquetas || []).includes(alvo.id)) lead.etiquetaVendaPeloCrm = alvo.id; // o "desfazer" tira
  lead.etiquetas = [...new Set([...(lead.etiquetas || []).filter((id) => !tirar.has(id)), ...(alvo ? [alvo.id] : [])])];
  if (alvo) lead.etiquetasDesde = { ...(lead.etiquetasDesde || {}), [alvo.id]: lead.etiquetasDesde?.[alvo.id] || new Date().toISOString() };
  if (lead.etiquetas.join() !== antes) lead.atualizadoEm = new Date().toISOString();
  return true;
}

// Etiqueta de "antes da venda" (Agendado, Orçamento…) voltando para quem a venda tirou há
// menos de 7 dias: é a velha (cópia do servidor / celular reenviando) — não volta
const DIAS_TIRADA = 7;
function voltaVelha(empresa, lead, etiquetaId) {
  const em = lead.tiradasPelaVenda?.[etiquetaId];
  return Boolean(em && Date.now() - new Date(em).getTime() < DIAS_TIRADA * 86400000);
}
// Etiqueta chegando agora é a velha? Só quando vem da cópia do servidor ou do celular
// reenviando tudo logo depois de reconectar — posta de propósito (no celular ou no CRM) vale
function etiquetaChegandoEhVelha(empresa, lead, etiquetaId, { aoVivo = false } = {}) {
  // "Agendado"/"Orçamento" para quem já comprou, vindo da cópia ou da reconexão: também é velha
  // (mesmo depois dos 7 dias) — senão volta a aparecer como agendado e cria agendamento falso
  const t = leads.etiquetasDa(empresa).find((x) => x.id === etiquetaId);
  const antesDaVendaEmVendido = Boolean(t && ETIQUETA_ANTES_DA_VENDA.test(limpar(t.nome).trim()) && jaVendeu(empresa, lead));
  if (!(voltaVelha(empresa, lead, etiquetaId) || antesDaVendaEmVendido) || (lead.etiquetas || []).includes(etiquetaId)) return false;
  if (!aoVivo) return true;
  const reconectou = empresa.whatsappConfig?.reconectouEm;
  return Boolean(reconectou && Date.now() - new Date(reconectou).getTime() < 10 * 60 * 1000);
}

// "Desfazer venda": volta o que a venda mudou — as etiquetas que ela tirou (Agendado…), a
// etiqueta de venda que ela pôs e os agendamentos que ela concluiu (se ainda não passaram)
function desfazerVendido(empresa, lead) {
  for (const c of conversasDoCliente(empresa, lead)) {
    // outra conversa do cliente com venda própria: fica como está
    if (c !== lead && (c.vendaConcluidaManual || vendasDa(empresa).some((v) => v.leadId === c.id && v.status !== 'cancelada'))) continue;
    const volta = Object.keys(c.tiradasPelaVenda || {}).filter((id) => voltaVelha(empresa, c, id));
    let etiquetas = (c.etiquetas || []).filter((id) => id !== c.etiquetaVendaPeloCrm);
    etiquetas = [...new Set([...etiquetas, ...volta])];
    c.etiquetas = etiquetas;
    delete c.tiradasPelaVenda;
    delete c.etiquetaVendaPeloCrm;
    for (const a of c.agendamentos || []) {
      if (a.status === 'concluido' && a.concluidoPor === 'venda' && (!a.quando || new Date(a.quando).getTime() > Date.now())) {
        a.status = 'agendado';
        delete a.concluidoEm;
        delete a.concluidoPor;
      }
    }
    c.atualizadoEm = new Date().toISOString();
  }
}

// Venda vinda do funil (etapa "Vendi") ou da etiqueta de venda posta no celular: troca as
// etiquetas e conclui o agendamento em todas as conversas do cliente (sem registrar venda nova)
function marcarVendido(empresa, lead, { etiqueta = null } = {}) {
  for (const c of conversasDoCliente(empresa, lead)) {
    trocarEtiquetaDeVenda(empresa, c, etiqueta);
    concluirAgendamentos(c);
  }
}

// ---------------------------------------------------------------- o cliente já comprou?
// Vale qualquer sinal, em qualquer conversa do mesmo cliente: venda no Faturamento (não
// cancelada), "Venda concluída" marcada à mão, etiqueta de venda do WhatsApp ("Venda
// concluída", "Vendido", "Pago", "Fechado", "Entregue"…) ou etapa de venda do funil.
// Devolve { por, em } (em = quando, se der para saber) ou null.
const ETIQUETA_JA_VENDEU = ETIQUETA_VENDA.filter((re) => !re.test('cliente'));
const ETAPA_JA_VENDEU = /fechad|ganh|vendi|vendid|venda conclu|^conclu|^pag[oa]\b/;
const ehEtiquetaDeVenda = (nome) => ETIQUETA_JA_VENDEU.some((re) => re.test(limpar(nome).trim())) && !ETIQUETA_ANTES_DA_VENDA.test(limpar(nome).trim());
const ETAPA_PERDIDA = /\bnao\b|\bsem\b|perdid|desist|cancel/;
const ehEtapaDeVenda = (nome) => ETAPA_JA_VENDEU.test(limpar(nome)) && !ETAPA_PERDIDA.test(limpar(nome));
// venda (no CRM ou à mão) de mais de 90 dias não bloqueia: o cliente voltou para comprar de novo.
// Etiqueta e etapa de venda bloqueiam enquanto estiverem no cliente (tirou, libera).
const VENDA_VALE_DIAS = 90;
const cacheVendeu = new Map(); // leadId → { em, r } (várias consultas seguidas na mesma volta)
function jaVendeu(empresa, lead) {
  if (!empresa || !lead) return null;
  // muda etiqueta, etapa, venda à mão ou o total de vendas → recalcula na hora
  const marca = `${(lead.etiquetas || []).join()}|${lead.etapa}|${lead.vendaConcluidaManual ? 1 : 0}|${(estado.vendas || []).length}|${leads.etiquetasDa(empresa).length}`;
  const c = cacheVendeu.get(lead.id);
  if (c && c.marca === marca && Date.now() - c.em < 3000) return c.r;
  const r = jaVendeuAgora(empresa, lead);
  if (cacheVendeu.size > 20000) cacheVendeu.clear();
  cacheVendeu.set(lead.id, { em: Date.now(), marca, r });
  return r;
}
function jaVendeuAgora(empresa, lead) {
  const recente = (em) => !em || Date.now() - new Date(em).getTime() < VENDA_VALE_DIAS * 86400000;
  const conversas = conversasDoCliente(empresa, lead);
  const ids = new Set(conversas.map((c) => c.id));
  const sinais = [];
  for (const v of vendasDa(empresa)) if (v.status !== 'cancelada' && v.leadId && ids.has(v.leadId) && recente(v.criadoEm || v.data)) sinais.push({ por: 'venda no CRM', em: v.criadoEm || v.data || '' });
  const nomes = new Map(leads.etiquetasDa(empresa).map((t) => [t.id, t.nome]));
  for (const c of conversas) {
    if (c.vendaConcluidaManual && recente(c.vendaConcluidaEm)) sinais.push({ por: 'venda concluída marcada à mão', em: c.vendaConcluidaEm || '' });
    for (const id of c.etiquetas || []) if (ehEtiquetaDeVenda(nomes.get(id) || '')) sinais.push({ por: `etiqueta "${nomes.get(id)}"`, em: c.etiquetasDesde?.[id] || '' });
    if (c.etapa && ehEtapaDeVenda(c.etapa)) sinais.push({ por: `etapa "${c.etapa}"`, em: [...(c.etapaHistorico || [])].reverse().find((h) => h.para === c.etapa)?.em || '' });
  }
  if (!sinais.length) return null;
  return sinais.sort((a, b) => String(a.em).localeCompare(String(b.em))).pop(); // o mais recente
}

function hashDe(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

// Chamado quando chega foto/PDF do cliente no WhatsApp.
// Retorna { texto } para a conversa (a IA lê isso) ou null se não era comprovante.
async function processarArquivo(empresa, lead, { buffer, mimetype, anexo, lerComIa, forcarIa = false }) {
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
  if (!dados && cfg.usarIa && lerComIa && (forcarIa || /comprovante|pix|transfer|pagamento|recibo|r\$\s*\d/i.test(textoCompleto) || /pdf/i.test(mimetype))) {
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
  jaVendeu,
  voltaVelha,
  etiquetaChegandoEhVelha,
  marcarVendido,
  desfazerVendido,
  ehEtiquetaDeVenda,
  ehEtapaDeVenda,
  interpretar,
  lerTexto,
  paraNumero,
  configDa,
  vendasDa,
  registrar,
  aoVender,
  concluirVendidos,
  ultimaVendaDoCliente,
  conversasDoCliente,
  arrumarVendidosAgendados,
  trocarEtiquetaDeVenda,
  processarArquivo,
  resumo,
  brl
};
