// Uso de IA e movimento dos últimos 30 dias por empresa (só números): leads novos, conversas
// com mensagem do cliente, mensagens do cliente e da IA, e tokens por tarefa/modelo.
// Serve para estimar quanto custaria com outra IA. Nunca mostra conversas, nomes ou chaves.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const diaSp = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const desde = Date.now() - 30 * 864e5;
const k = (n) => `${Math.round(n / 1000)}k`;
for (const [n, e] of (db.empresas || []).entries()) {
  const conversas = (db.conversas || []).filter((c) => c.empresaId === e.id);
  const novos = conversas.filter((c) => new Date(c.criadoEm || 0).getTime() > desde).length;
  let msgsCliente = 0;
  let msgsIa = 0;
  let comCliente = 0;
  for (const c of conversas) {
    const recentes = (c.mensagens || []).filter((m) => new Date(m.em || 0).getTime() > desde);
    const doCliente = recentes.filter((m) => m.papel === 'visitante').length;
    msgsCliente += doCliente;
    msgsIa += recentes.filter((m) => m.papel === 'assistente').length;
    if (doCliente) comCliente++;
  }
  const dias = Object.entries(e.usoIa?.dias || {}).filter(([d]) => d >= diaSp(desde));
  if (!novos && !dias.length) continue;
  const tot = { chamadas: 0, entrada: 0, saida: 0, cache: 0 };
  const porTarefa = {};
  const porModelo = {};
  for (const [, d] of dias) {
    for (const x of ['chamadas', 'entrada', 'saida', 'cache']) tot[x] += d[x] || 0;
    for (const [t, x] of Object.entries(d.porTarefa || {})) { const a = (porTarefa[t] = porTarefa[t] || { chamadas: 0, tokens: 0, cache: 0 }); a.chamadas += x.chamadas; a.tokens += x.tokens; a.cache += x.cache || 0; }
    for (const [m, x] of Object.entries(d.porModelo || {})) { const a = (porModelo[m] = porModelo[m] || { chamadas: 0, tokens: 0 }); a.chamadas += x.chamadas; a.tokens += x.tokens; }
  }
  console.log(`  Empresa ${n + 1} (30 dias): leads novos ${novos} (${(novos / 30).toFixed(1)}/dia) · conversas com mensagem do cliente ${comCliente} · msgs do cliente ${msgsCliente} · msgs da IA ${msgsIa}`);
  console.log(`      IA: ${dias.length} dias com uso · ${tot.chamadas} chamadas · entrada ${k(tot.entrada)} · saída ${k(tot.saida)} · cache ${k(tot.cache)} · por dia: entrada ${k(tot.entrada / Math.max(1, dias.length))}, saída ${k(tot.saida / Math.max(1, dias.length))}`);
  for (const [t, x] of Object.entries(porTarefa).sort((a, b) => b[1].tokens - a[1].tokens)) console.log(`      tarefa ${t}: ${x.chamadas}x · ${k(x.tokens)} tokens · ${k(x.cache)} cache · média ${k(x.tokens / x.chamadas)}/chamada`);
  for (const [m, x] of Object.entries(porModelo).sort((a, b) => b[1].tokens - a[1].tokens)) console.log(`      modelo ${m}: ${x.chamadas}x · ${k(x.tokens)} tokens`);
}
