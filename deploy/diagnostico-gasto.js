// Gasto de IA por empresa (só números): hoje e ontem, por tarefa e por modelo, com custo
// estimado. Nunca mostra conversas, nomes ou chaves.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const PRECO = { 'gemini-2.5-flash': [0.3, 2.5, 0.075], 'gemini-2.5-flash-lite': [0.1, 0.4, 0.025], 'gemini-2.5-pro': [1.25, 10, 0.31], 'claude-opus-5-5': [4, 20, 0.2], 'claude-sonnet-5-5': [2, 10, 0.2], 'claude-haiku-4-5': [1, 5, 0.1], 'gpt-5-mini': [0.25, 2, 0.025], 'gpt-5': [1.25, 10, 0.125] };
const diaSp = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const k = (n) => `${(n / 1000).toFixed(0)}k`;
for (const [n, e] of (db.empresas || []).entries()) {
  const dias = e.usoIa?.dias || {};
  for (const dia of [diaSp(Date.now()), diaSp(Date.now() - 864e5)]) {
    const d = dias[dia];
    if (!d) continue;
    // custo do dia: entrada/saída/cache do dia, com o preço do modelo mais usado (estimativa)
    const modelos = Object.entries(d.porModelo || {}).sort((a, b) => b[1].tokens - a[1].tokens);
    let custo = 0;
    for (const [mod, x] of modelos) {
      const p = PRECO[mod];
      if (!p) continue;
      // divide os tokens do modelo entre entrada/saída na mesma proporção do dia
      const tot = (d.entrada || 0) + (d.saida || 0) || 1;
      custo += (x.tokens * ((d.entrada || 0) / tot) * p[0] + x.tokens * ((d.saida || 0) / tot) * p[1] + (x.cache || 0) * p[2]) / 1e6;
    }
    console.log(`  Empresa ${n + 1} · ${dia}: ${d.chamadas} chamadas · entrada ${k(d.entrada || 0)} · saída (resposta + pensamento) ${k(d.saida || 0)} · cache ${k(d.cache || 0)} · custo estimado US$ ${custo.toFixed(2)} (~R$ ${(custo * 5.5).toFixed(2)})`);
    for (const [t, x] of Object.entries(d.porTarefa || {}).sort((a, b) => b[1].tokens - a[1].tokens)) console.log(`      tarefa ${t}: ${x.chamadas}x · ${k(x.tokens)} tokens · ${k(x.cache || 0)} cache · média ${k(x.tokens / x.chamadas)} por chamada`);
    for (const [mod, x] of modelos) console.log(`      modelo ${mod}: ${x.chamadas}x · ${k(x.tokens)} tokens · ${k(x.cache || 0)} cache`);
  }
}
