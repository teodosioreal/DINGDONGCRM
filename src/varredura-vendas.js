// varredura-vendas.js — de hora em hora, procura vendas nas conversas SEM gastar IA.
//
//   1. Frase de venda da equipe: quando a empresa manda "obrigado pela preferência"
//      (ou outra frase cadastrada em Faturamento), é venda. O código procura o valor
//      na conversa (R$ 350, 350,00, 1.200…): achou → venda confirmada com o valor;
//      não achou → venda "a conferir" + aviso no sininho para a equipe pôr o valor.
//   2. Comprovante de Pix que ficou para trás (foto/PDF do cliente que não virou venda):
//      relê sem IA; a IA só olha a foto quando a conversa fala de pagamento
//      ("pix", "paguei", "comprovante", "segue"…) — economiza crédito.
// Cada mensagem é olhada uma vez só. Não duplica: venda do mesmo cliente nas últimas
// 24 h (ex.: comprovante já lido) só ganha o valor, se faltava.

const fs = require('fs');
const { estado, salvar, agora } = require('./db');

const A_CADA_MS = Number(process.env.VARREDURA_VENDAS_MS) || 60 * 60 * 1000;
const JANELA_DIAS = 3;
const FRASES_PADRAO = 'obrigado pela preferência, obrigada pela preferência';

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function frasesDa(empresa) {
  const c = empresa.faturamento || {};
  if (c.vendaPorFrase === false) return [];
  return String(c.frasesVenda ?? FRASES_PADRAO)
    .split(/[,;\n]+/)
    .map((f) => sem(f).replace(/[^\w ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((f) => f.length >= 6);
}

const normal = (t) => sem(t).replace(/[^\w ]/g, ' ').replace(/\s+/g, ' ').trim();

// Valores em dinheiro num texto: "R$ 350", "350,00", "1.200,50", "R$1200", "350 reais"
function valoresNoTexto(texto) {
  const t = String(texto || '');
  const achados = [];
  const re = /(?:r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?)|(?:\b(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b)|(?:\b(\d{2,6})\s*(?:reais|conto)\b)/gi;
  let m;
  while ((m = re.exec(t))) {
    const inteiro = (m[1] || m[3] || m[5] || '').replace(/\./g, '');
    const centavos = m[2] || m[4] || '00';
    const v = Number(`${inteiro}.${centavos}`);
    if (Number.isFinite(v) && v >= 10 && v <= 200000) achados.push(v);
  }
  return achados;
}

// O valor da venda: o último valor falado na conversa antes da frase (até 3 dias),
// preferindo o que está na própria mensagem da frase
function valorDaVenda(lead, idx) {
  const msgs = lead.mensagens || [];
  const proprio = valoresNoTexto(msgs[idx]?.texto);
  if (proprio.length) return proprio[proprio.length - 1];
  const limite = new Date(msgs[idx]?.em || Date.now()).getTime() - JANELA_DIAS * 86400000;
  for (let i = idx - 1; i >= 0 && i >= idx - 40; i--) {
    const m = msgs[i];
    if (!m?.texto || new Date(m.em).getTime() < limite) break;
    if (/\[o cliente enviou o comprovante/.test(m.texto)) continue; // já virou venda pelo comprovante
    const v = valoresNoTexto(m.texto);
    if (v.length) return v[v.length - 1];
  }
  return null;
}

// Já existe venda deste cliente perto da hora da frase (2 dias para trás ou para frente)?
function vendaPerto(lead, em) {
  const t = new Date(em).getTime();
  return (estado.vendas || []).find((v) => v.leadId === lead.id && v.status !== 'cancelada' && Math.abs(new Date(v.criadoEm || v.data).getTime() - t) < 48 * 3600 * 1000) || null;
}

// Pedido de avaliação/comentário, automação, follow-up: o "obrigado pela preferência"
// dessas mensagens agradece uma venda que já aconteceu — não é venda nova
const PEDIDO_POS_VENDA = /\b(avali\w*|coment[aá]\w*|estrelas?|google|depoimento|feedback|indica[cç]\w*)\b/;
function ehPosVenda(empresa, m) {
  if (m.pedido || m.automacaoId || m.followupPasso || m.eventoInterno || m.agendadaId) return true;
  // pedido de avaliação/comentário escrito de qualquer jeito (com ou sem link)
  if (PEDIDO_POS_VENDA.test(sem(m.texto))) return true;
  return require('./automacoes').pedidosNoTexto(empresa, m.texto).length > 0;
}

// o cliente já comprou nos 30 dias antes desta mensagem: o "obrigado pela preferência" é dessa venda
function vendaAntes(lead, em) {
  const t = new Date(em).getTime();
  return (estado.vendas || []).find((v) => v.leadId === lead.id && v.status !== 'cancelada' && new Date(v.criadoEm || v.data).getTime() <= t + 60000 && t - new Date(v.criadoEm || v.data).getTime() < 30 * 86400000) || null;
}

// 1. frase de venda mandada pela empresa
function porFrase(empresa, lead) {
  const frases = frasesDa(empresa);
  if (!frases.length) return 0;
  const comprovantes = require('./comprovantes');
  const limite = Date.now() - JANELA_DIAS * 86400000;
  let n = 0;
  (lead.mensagens || []).forEach((m, idx) => {
    if (m.vendaVarrida || m.papel === 'visitante' || !m.texto || new Date(m.em).getTime() < limite) return;
    m.vendaVarrida = true;
    if (ehPosVenda(empresa, m)) return;
    const t = normal(m.texto);
    if (!frases.some((f) => t.includes(f))) return;
    const valor = valorDaVenda(lead, idx);
    const recente = vendaPerto(lead, m.em) || vendaAntes(lead, m.em);
    if (recente) {
      // já tinha venda (ex.: comprovante): só completa o valor que faltava
      if (!recente.valor && valor) Object.assign(recente, { valor, status: 'confirmada', confirmadaEm: agora(), motivoConferir: '' });
      return;
    }
    const { venda } = comprovantes.registrar(empresa, lead, { valor: valor || 0, forma: 'Pix', pagador: lead.nome || '' }, { origem: 'frase', lidoPor: 'frase', descricao: '' });
    if (valor) {
      venda.status = 'confirmada';
      venda.confirmadaEm = venda.confirmadaEm || agora();
      venda.motivoConferir = '';
    } else {
      venda.status = 'conferir';
      delete venda.confirmadaEm;
      venda.motivoConferir = `a equipe mandou "${String(m.texto).slice(0, 60)}" — não achei o valor na conversa, coloque o valor`;
      require('./alertas').registrar(empresa, 'venda-sem-valor', `💰 Venda de ${lead.nome || 'um cliente'} registrada pela frase de venda, mas sem valor. Abra o Faturamento e coloque o valor.`, { nivel: 'aviso', leadId: lead.id });
    }
    comprovantes.aoVender(empresa, lead); // sai de "agendado": etapa, etiqueta e agenda
    n++;
  });
  return n;
}

// 2. comprovantes que ficaram para trás
// só palavras de pagamento de verdade ("segue", "mandei", "entrada" sozinhos faziam a IA ler fotos à toa)
const PISTA_PAGAMENTO = /\b(pix|paguei|pago|pagamento|comprovante|transferi|transferencia|deposit\w*|ted\b|boleto|sinal de|valor do sinal)/;
function falaDePagamento(lead, idx, extra = '') {
  const msgs = lead.mensagens || [];
  const ate = idx === undefined ? msgs.length : idx + 3;
  const de = idx === undefined ? msgs.length - 4 : idx - 4;
  const perto = msgs.slice(Math.max(0, de), ate).map((m) => sem(m.texto)).join(' ') + ' ' + sem(extra);
  return PISTA_PAGAMENTO.test(perto);
}

async function porComprovante(empresa, lead) {
  const whatsapp = require('./whatsapp');
  const comprovantes = require('./comprovantes');
  const midias = require('./midias');
  const ia = require('./ia');
  if (!comprovantes.configDa(empresa).ativo) return 0;
  const limite = Date.now() - JANELA_DIAS * 86400000;
  let n = 0;
  const msgs = lead.mensagens || [];
  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx];
    const a = m.anexo;
    if (m.papel !== 'visitante' || !a || a.vendaId || a.varrido || new Date(m.em).getTime() < limite) continue;
    if (!(a.tipo === 'image' || /pdf/i.test(a.mimetype || ''))) continue;
    a.varrido = true;
    let buffer;
    try {
      buffer = fs.readFileSync(midias.caminhoAnexo(lead.id, a.arquivo));
    } catch {
      continue;
    }
    const base64 = buffer.toString('base64');
    const usarIa = falaDePagamento(lead, idx) && !a.comprovanteRevisto; // a IA só olha quando a conversa fala de pagamento
    const comp = await comprovantes
      .processarArquivo(empresa, lead, { buffer, mimetype: a.mimetype, anexo: a, forcarIa: usarIa, lerComIa: usarIa ? () => ia.lerComprovante(whatsapp.botDoWhatsapp(empresa), empresa, base64, a.mimetype) : null })
      .catch(() => null);
    if (comp && !comp.texto.includes('mandou de novo')) {
      a.vendaId = comp.venda.id;
      a.descricao = `Comprovante ${comp.venda.forma} de ${comprovantes.brl(comp.venda.valor)}`;
      n++;
    }
  }
  return n;
}

let rodando = false;
async function varrer() {
  if (rodando) return { emAndamento: true };
  rodando = true;
  const r = { frase: 0, comprovante: 0 };
  try {
    const limite = new Date(Date.now() - JANELA_DIAS * 86400000).toISOString();
    for (const empresa of estado.empresas) {
      // aviso "venda sem valor" de venda que a equipe já resolveu (confirmou/cancelou): sai do sininho
      for (const a of estado.alertas || []) {
        if (a.empresaId !== empresa.id || a.tipo !== 'venda-sem-valor' || a.resolvido || !a.leadId) continue;
        if (!(estado.vendas || []).some((v) => v.leadId === a.leadId && v.status === 'conferir')) Object.assign(a, { resolvido: true, lido: true });
      }
      if (empresa.ativa === false) continue;
      for (const lead of estado.conversas.filter((c) => c.empresaId === empresa.id && String(c.atualizadoEm || '') >= limite)) {
        r.frase += porFrase(empresa, lead);
        r.comprovante += await porComprovante(empresa, lead);
      }
    }
    salvar();
    if (r.frase || r.comprovante) console.log(`[varredura-vendas] ${r.frase} venda(s) pela frase, ${r.comprovante} pelo comprovante`);
  } catch (err) {
    console.error('[varredura-vendas]', err.message);
  } finally {
    rodando = false;
  }
  return r;
}

let timer = null;
function iniciar() {
  if (timer || process.env.VARREDURA_VENDAS === 'nao') return;
  setTimeout(() => varrer().catch(() => {}), Math.min(2 * 60 * 1000, A_CADA_MS)).unref?.();
  timer = setInterval(() => varrer().catch(() => {}), A_CADA_MS);
  timer.unref?.();
}

module.exports = { falaDePagamento, iniciar, varrer, valoresNoTexto, frasesDa, FRASES_PADRAO };
