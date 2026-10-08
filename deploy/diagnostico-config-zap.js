// Configurações da instância de cada empresa na Evolution (só os interruptores, sem dados):
// readMessages ligado = toda mensagem que chega já fica lida no WhatsApp sem ninguém abrir.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
(async () => {
  for (const [n, e] of (db.empresas || []).entries()) {
    const c = e.whatsappConfig || {};
    if (!c.instancia) continue;
    const base = (c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    try {
      const r = await fetch(`${base}/settings/find/${encodeURIComponent(c.instancia)}`, { headers: { apikey: c.apiKey }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      const s = j?.settings || j || {};
      const f = (k) => `${k}=${s[k] === undefined ? '?' : s[k]}`;
      console.log(`  Empresa ${n + 1}: HTTP ${r.status} · ${['readMessages', 'readStatus', 'alwaysOnline', 'groupsIgnore', 'rejectCall', 'syncFullHistory'].map(f).join(' · ')}`);
    } catch (err) {
      console.log(`  Empresa ${n + 1}: erro ${err.message}`);
    }
  }
})();
