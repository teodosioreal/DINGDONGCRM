// Chaves de IA por empresa (só leitura, anônimo): de onde vem a chave que cada empresa usa
// (a própria, a da IA na ordem, ou a do administrador) e se duas empresas usam a MESMA chave.
// Nunca mostra a chave: só um apelido (A, B, C…) igual para chaves iguais.
const fs = require('fs');
const crypto = require('crypto');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const CAMPO = { anthropic: 'anthropicApiKey', openai: 'openaiApiKey', gemini: 'geminiApiKey' };
const ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const apelidos = new Map();
const apelido = (k) => {
  if (!k) return '';
  const h = crypto.createHash('sha256').update(k).digest('hex');
  if (!apelidos.has(h)) apelidos.set(h, String.fromCharCode(65 + apelidos.size));
  return apelidos.get(h);
};
const admin = {};
for (const p of Object.keys(CAMPO)) admin[p] = (db.config || {})[CAMPO[p]] || process.env[ENV[p]] || '';
console.log(`  Chave do servidor (não usada por nenhuma empresa): ${Object.keys(CAMPO).map((p) => `${p} ${admin[p] ? `chave ${apelido(admin[p])}` : 'nenhuma'}`).join(' · ')}`);
const usoPorChave = {};
const desde = Date.now() - 7 * 864e5;
for (const [n, e] of (db.empresas || []).entries()) {
  const podePadrao = false; // desde 06/10: nenhuma empresa usa a chave do servidor
  const conversas = (db.conversas || []).filter((c) => c.empresaId === e.id).length;
  const dias = Object.entries(e.usoIa?.dias || {}).filter(([d]) => new Date(d).getTime() > desde);
  const chamadas7d = dias.reduce((s, [, d]) => s + (d.chamadas || 0), 0);
  const linhas = [];
  const usadas = new Set();
  for (const p of Object.keys(CAMPO)) {
    const propria = (e.chavesIa || {})[CAMPO[p]] || ((Array.isArray(e.motoresIa) ? e.motoresIa : []).find((m) => (['gemini', 'openai'].includes(m?.provedor) ? m.provedor : 'anthropic') === p && m?.chave) || {}).chave || '';
    const final = propria || (podePadrao ? admin[p] : '');
    if (final) usadas.add(`${p}:${apelido(final)}`);
    linhas.push(`${p}: ${propria ? `própria (chave ${apelido(propria)})` : final ? `USA A DO ADMINISTRADOR (chave ${apelido(final)})` : 'sem chave'}`);
  }
  const motores = (Array.isArray(e.motoresIa) ? e.motoresIa : []).slice(0, 3).map((m, i) => {
    const p = ['gemini', 'openai'].includes(m?.provedor) ? m.provedor : 'anthropic';
    const k = m?.chave || (e.chavesIa || {})[CAMPO[p]] || (podePadrao ? admin[p] : '');
    if (k) usadas.add(`${p}:${apelido(k)}`);
    return `${i + 1}ª ${p}/${m?.modelo || '?'} → ${m?.chave ? `chave só desta IA (${apelido(m.chave)})` : (e.chavesIa || {})[CAMPO[p]] ? `chave da empresa (${apelido(k)})` : k ? `CHAVE DO ADMINISTRADOR (${apelido(k)})` : 'SEM CHAVE'}`;
  });
  for (const u of usadas) (usoPorChave[u] = usoPorChave[u] || []).push(n + 1);
  console.log(`  Empresa ${n + 1}${e.ativa === false ? ' (desativada)' : ''} · ${conversas} conversas · ${chamadas7d} chamadas de IA em 7 dias `);
  console.log(`      ${linhas.join(' · ')}`);
  if (motores.length) console.log(`      ordem das IAs: ${motores.join(' · ')}`);
}
const divididas = Object.entries(usoPorChave).filter(([, l]) => l.length > 1);
console.log(divididas.length ? `  ⚠️ Chaves usadas por mais de uma empresa: ${divididas.map(([k, l]) => `${k} → empresas ${l.join(', ')}`).join(' · ')}` : '  Nenhuma chave é usada por duas empresas.');

// A chave funciona? (lista de modelos do Google/OpenAI: não gasta token) + últimas falhas da IA
(async () => {
  const limpo = (t) => String(t || '').replace(/AIza[\w-]{10,}|sk-[\w-]{10,}/g, '[chave]').replace(/\d{6,}/g, '[núm]').slice(0, 160);
  for (const [n, e] of (db.empresas || []).entries()) {
    const testadas = new Set();
    const lista = [];
    for (const m of Array.isArray(e.motoresIa) ? e.motoresIa : []) if (m?.chave) lista.push(['gemini', 'openai'].includes(m.provedor) ? m.provedor : 'anthropic', m.chave);
    for (const [p, campo] of Object.entries(CAMPO)) if ((e.chavesIa || {})[campo]) lista.push(p, e.chavesIa[campo]);
    for (let i = 0; i < lista.length; i += 2) {
      const [p, k] = [lista[i], lista[i + 1]];
      if (testadas.has(k)) continue;
      testadas.add(k);
      let r = '';
      try {
        if (p === 'gemini') r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': k }, signal: AbortSignal.timeout(10000) }).then(async (x) => `HTTP ${x.status}${x.ok ? ' (aceita)' : ` ${limpo((await x.json().catch(() => ({}))).error?.message)}`}`);
        else if (p === 'openai') r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(10000) }).then((x) => `HTTP ${x.status}`);
        else r = 'não testada';
      } catch (err) { r = `erro de rede: ${err.message}`; }
      const formato = `${k.length} caracteres${p === 'gemini' ? (k.startsWith('AIza') ? ', começa com AIza' : ', NÃO começa com AIza') : ''}${/[\s"'`\u200B-\u200D\uFEFF]/.test(k) ? ', TEM espaço/aspas/caractere invisível' : ''}, termina em ${k.slice(-4)}`;
      console.log(`  Empresa ${n + 1} · ${p} chave ${apelido(k)} (${formato}): ${r}`);
    }
    const res = e.iaReserva;
    if (res) console.log(`  Empresa ${n + 1} · última vez que uma IA falhou e outra entrou: ${res.em} · ${res.tarefa} · usou ${res.usou} · falhas: ${(res.falhas || []).map(limpo).join(' | ')}`);
    for (const a of (db.alertas || []).filter((x) => x.empresaId === e.id && /ia|chave/i.test(x.tipo)).slice(-5)) console.log(`  Empresa ${n + 1} · alerta ${a.tipo} (${a.ultimoEm || a.em}${a.resolvido ? ', resolvido' : ''}): ${limpo(String(a.mensagem || '').replace(/^Cliente [^:]{0,60}:\s*/, ''))}`);
    const dias = Object.keys(e.usoIa?.dias || {}).sort();
    if (dias.length) console.log(`  Empresa ${n + 1} · último dia com uso de IA: ${dias[dias.length - 1]} (${e.usoIa.dias[dias[dias.length - 1]].chamadas} chamadas)`);
  }
})();
