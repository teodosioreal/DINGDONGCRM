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
console.log(`  Chave do administrador: ${Object.keys(CAMPO).map((p) => `${p} ${admin[p] ? `chave ${apelido(admin[p])}` : 'nenhuma'}`).join(' · ')}`);
const usoPorChave = {};
const desde = Date.now() - 7 * 864e5;
for (const [n, e] of (db.empresas || []).entries()) {
  const podePadrao = e.usarChavePadrao !== false;
  const conversas = (db.conversas || []).filter((c) => c.empresaId === e.id).length;
  const dias = Object.entries(e.usoIa?.dias || {}).filter(([d]) => new Date(d).getTime() > desde);
  const chamadas7d = dias.reduce((s, [, d]) => s + (d.chamadas || 0), 0);
  const linhas = [];
  const usadas = new Set();
  for (const p of Object.keys(CAMPO)) {
    const propria = (e.chavesIa || {})[CAMPO[p]] || '';
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
  console.log(`  Empresa ${n + 1}${e.ativa === false ? ' (desativada)' : ''} · ${conversas} conversas · ${chamadas7d} chamadas de IA em 7 dias · pode usar a do administrador: ${podePadrao ? 'SIM' : 'não'}`);
  console.log(`      ${linhas.join(' · ')}`);
  if (motores.length) console.log(`      ordem das IAs: ${motores.join(' · ')}`);
}
const divididas = Object.entries(usoPorChave).filter(([, l]) => l.length > 1);
console.log(divididas.length ? `  ⚠️ Chaves usadas por mais de uma empresa: ${divididas.map(([k, l]) => `${k} → empresas ${l.join(', ')}`).join(' · ')}` : '  Nenhuma chave é usada por duas empresas.');
