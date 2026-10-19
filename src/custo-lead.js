// custo-lead.js — quanto custou cada cliente que veio de anúncio e quanto ele comprou.
//
// Investimento = gastos do mês na categoria de anúncios (Marketing), lançados no Faturamento
// (à mão ou pelo grupo do WhatsApp). Leads de anúncio = os que chegaram no mês por clique de
// anúncio (site com fbclid/gclid/UTM pago, anúncio de clique para o WhatsApp ou anúncio cadastrado).
//   custo por lead  = investimento ÷ leads de anúncio do mês
//   custo por venda = investimento ÷ clientes de anúncio que compraram no mês
//   retorno         = faturamento desses clientes ÷ investimento
// Sem IA e sem ligar na Meta: só com o que já está no CRM.

const { estado } = require('./db');

const r2 = (n) => Math.round(n * 100) / 100;
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ehCategoriaDeAnuncio = (nome) => /marketing|anuncio|trafego|ads\b|propaganda|impulsion/.test(semAcento(nome));

// o lead chegou por um anúncio pago?
function veioDeAnuncio(lead) {
  if (!lead) return false;
  if (lead.anuncioId || lead.origemSite?.anuncioMeta) return true;
  if (lead.origemSite?.classificacao?.tipo === 'anuncio') return true;
  try { if (require('./origem').campanhaDoLead(lead)) return true; } catch { /* sem origem */ }
  const urls = [lead.origemSite?.chegada?.url, lead.origemSite?.primeira?.url].join(' ');
  return /[?&](fbclid|gclid|gbraid|wbraid|ttclid)=/.test(urls);
}

// números de um mês (AAAA-MM, horário de Brasília)
function doMes(empresa, mes) {
  const gastos = require('./gastos');
  const mesDe = gastos.mesDe;
  const alvo = mes || mesDe(new Date().toISOString());
  const investimento = r2(gastos.gastosDa(empresa).filter((g) => mesDe(g.data) === alvo && ehCategoriaDeAnuncio(g.categoria)).reduce((s, g) => s + (Number(g.valor) || 0), 0));
  const daEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
  const novos = daEmpresa.filter((c) => mesDe(c.criadoEm) === alvo);
  const deAnuncio = novos.filter(veioDeAnuncio);
  const porLead = new Map(daEmpresa.map((c) => [c.id, c]));
  const vendasMes = require('./comprovantes').vendasDa(empresa).filter((v) => v.status === 'confirmada' && mesDe(v.data) === alvo);
  const vendasAnuncio = vendasMes.filter((v) => v.leadId && veioDeAnuncio(porLead.get(v.leadId)));
  const clientes = new Set(vendasAnuncio.map((v) => v.leadId)).size;
  const faturamento = r2(vendasAnuncio.reduce((s, v) => s + (Number(v.valor) || 0), 0));
  const custoProdutos = require('./catalogo').somarCustos(empresa, vendasAnuncio).custo;
  return {
    mes: alvo,
    investimento,
    leadsNovos: novos.length,
    leadsAnuncio: deAnuncio.length,
    custoPorLead: investimento && deAnuncio.length ? r2(investimento / deAnuncio.length) : null,
    clientesAnuncio: clientes,
    vendasAnuncio: vendasAnuncio.length,
    custoPorVenda: investimento && clientes ? r2(investimento / clientes) : null,
    faturamentoAnuncio: faturamento,
    retorno: investimento ? Math.round((faturamento / investimento) * 10) / 10 : null,
    lucroAnuncio: r2(faturamento - custoProdutos - investimento)
  };
}

// para a conversa: quanto este cliente custou (média do mês em que chegou) e quanto comprou
function doLead(empresa, lead) {
  if (!veioDeAnuncio(lead)) return null;
  const m = doMes(empresa, require('./gastos').mesDe(lead.criadoEm));
  const vendas = require('./comprovantes').vendasDa(empresa).filter((v) => v.leadId === lead.id && v.status === 'confirmada');
  const comprou = r2(vendas.reduce((s, v) => s + (Number(v.valor) || 0), 0));
  const custoProdutos = require('./catalogo').somarCustos(empresa, vendas).custo;
  return {
    mes: m.mes,
    custou: m.custoPorLead, // null = não tem investimento lançado no mês em que ele chegou
    comprou,
    lucro: m.custoPorLead != null && comprou ? r2(comprou - custoProdutos - m.custoPorLead) : null
  };
}

module.exports = { veioDeAnuncio, doMes, doLead, ehCategoriaDeAnuncio };
