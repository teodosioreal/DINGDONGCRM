// Últimas mensagens que cada empresa mandou pelo WhatsApp e o que voltou (anônimo, sem texto).
const fs = require('fs');
const path = require('path');
const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : {};
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');
const desde = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
for (const [n, e] of (db.empresas || []).entries()) {
  if (!e.whatsappConfig?.instancia) continue;
  const saidas = [];
  for (const l of db.conversas || []) {
    if (l.empresaId !== e.id) continue;
    for (const m of l.mensagens || []) if (m.papel !== 'visitante' && m.em > desde && m.canal !== 'site') saidas.push(m);
  }
  saidas.sort((a, b) => (a.em < b.em ? 1 : -1));
  const c = {};
  for (const m of saidas) { const k = m.envio === 'erro' ? 'falhou' : m.entrega || 'sem confirmação'; c[k] = (c[k] || 0) + 1; }
  console.log(`      Empresa ${n + 1}${/lead/i.test(e.nome || '') ? ' (LEADS)' : ''}: últimas 3 h ${saidas.length} saídas · ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  for (const m of saidas.slice(0, 5)) console.log(`         ${hora(m.em)} · ${m.papel} · id ${m.wid ? 'sim' : 'NÃO'} · envio ${m.envio || '-'} · entrega ${m.entrega || 'sem confirmação'}${m.erroEnvio ? ` · ${String(m.erroEnvio).replace(/\d{6,}/g, '[núm]').slice(0, 80)}` : ''}`);
}
