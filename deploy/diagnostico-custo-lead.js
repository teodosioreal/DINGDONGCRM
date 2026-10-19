// Custo por lead (anônimo, só contagens e somas): de onde sai o número do Faturamento.
// Roda numa CÓPIA do banco (nada muda no CRM).
const fs = require('fs');
const os = require('os');
const path = require('path');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-cl-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
fs.chmodSync(copia, 0o600);
Object.assign(process.env, { CRM_DB_PATH: copia, SINCRONIA: 'nao', EVENTOS_IA: 'nao' });
const { estado } = require('../src/db');
const cl = require('../src/custo-lead');
const gastos = require('../src/gastos');
const brl = (v) => `R$ ${Number(v || 0).toFixed(2)}`;
const mesAtual = gastos.mesDe(new Date().toISOString());
const [a, m] = mesAtual.split('-').map(Number);
const mesAnterior = `${m === 1 ? a - 1 : a}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
const primeira = (l) => String(((l.mensagens || []).find((x) => x.papel === 'visitante' && x.texto) || {}).texto || '');
for (const [n, e] of estado.empresas.entries()) {
  if (!e.whatsappConfig?.instancia) continue;
  for (const mes of [mesAtual, mesAnterior]) {
    const r = cl.doMes(e, mes);
    const mk = gastos.gastosDa(e).filter((g) => gastos.mesDe(g.data) === mes && cl.ehCategoriaDeAnuncio(g.categoria));
    const novos = estado.conversas.filter((c) => c.empresaId === e.id && gastos.mesDe(c.criadoEm) === mes);
    const por = { fbclid: 0, gclid: 0, anuncioWhatsapp: 0, anuncioCadastrado: 0, utmPago: 0 };
    for (const c of novos) {
      const u = `${c.origemSite?.chegada?.url || ''} ${c.origemSite?.primeira?.url || ''}`;
      if (/[?&]fbclid=/.test(u)) por.fbclid++;
      if (/[?&](gclid|gbraid|wbraid)=/.test(u)) por.gclid++;
      if (c.origemSite?.anuncioMeta) por.anuncioWhatsapp++;
      if (c.anuncioId) por.anuncioCadastrado++;
      if (c.origemSite?.classificacao?.tipo === 'anuncio') por.utmPago++;
    }
    const fora = novos.filter((c) => !cl.veioDeAnuncio(c));
    const foraSite = fora.filter((c) => /Localidade:|Tenho interesse|Meu carro:/i.test(primeira(c))).length;
    const foraSemOrigem = fora.filter((c) => !c.origemSite).length;
    const importados = novos.filter((c) => c.historicoImportado).length;
    const semConversa = novos.filter((c) => !(c.mensagens || []).some((x) => x.papel === 'visitante')).length;
    console.log(`  Empresa ${n + 1} · ${mes}: investido ${brl(r.investimento)} em ${mk.length} lançamento(s) [${mk.map((g) => `${g.categoria} ${brl(g.valor)} ${String(g.data).slice(5, 10)}`).join(' | ')}]`);
    console.log(`      leads novos ${r.leadsNovos} · reconhecidos de anúncio ${r.leadsAnuncio} (${JSON.stringify(por)}) · custo por lead ${r.custoPorLead != null ? brl(r.custoPorLead) : '—'} · se dividir por TODOS os novos: ${r.investimento && r.leadsNovos ? brl(r.investimento / r.leadsNovos) : '—'}`);
    console.log(`      novos NÃO reconhecidos: ${fora.length} · desses com a pré-mensagem do site: ${foraSite} · sem nenhuma origem gravada: ${foraSemOrigem} · conversas importadas do celular: ${importados} · sem mensagem do cliente: ${semConversa}`);
    console.log(`      vendas de anúncio ${r.vendasAnuncio} (${r.clientesAnuncio} cliente(s)) · ${brl(r.faturamentoAnuncio)} · custo por venda ${r.custoPorVenda != null ? brl(r.custoPorVenda) : '—'} · retorno ${r.retorno ?? '—'}x`);
  }
}
fs.rmSync(pasta, { recursive: true, force: true });
process.exit(0);
