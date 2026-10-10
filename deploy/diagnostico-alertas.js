// Alertas das últimas 24 h (os de nível "erro" também vão para o WhatsApp de avisos).
// Anônimo: nomes de clientes, números, links e trechos entre aspas são escondidos.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const nomes = [...new Set((db.conversas || []).map((c) => String(c.nome || '').trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function anonimo(t) {
  let s = String(t || '');
  for (const n of nomes) s = s.replace(new RegExp(`\\b${esc(n)}\\b`, 'gi'), '[cliente]');
  return s
    .replace(/Cliente [^:]{1,60}:/g, 'Cliente [x]:')
    .replace(/"[^"]{0,200}"|“[^”]{0,200}”/g, '"…"')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[núm]')
    .slice(0, 260);
}
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const limite = Date.now() - 24 * 3600 * 1000;
const empresas = (db.empresas || []).map((e) => e.id);
const lista = (db.alertas || []).filter((a) => new Date(a.ultimoEm || a.criadoEm).getTime() > limite);
if (!lista.length) console.log('      nenhum alerta nas últimas 24 h');
for (const a of lista.slice(0, 25)) {
  const emp = empresas.indexOf(a.empresaId) + 1;
  console.log(`      ${hora(a.ultimoEm || a.criadoEm)} · empresa ${emp || '-'} · ${a.tipo} · ${a.nivel}${a.nivel === 'erro' ? ' (vai pro WhatsApp)' : ''} · ${a.vezes}x${a.resolvido ? ' · resolvido' : ''}`);
  console.log(`         ${anonimo(a.mensagem)}`);
}
// clientes esperando a IA (horário / crédito)
for (const [n, e] of (db.empresas || []).entries()) {
  const daEmp = (db.conversas || []).filter((c) => c.empresaId === e.id);
  const h = daEmp.filter((c) => c.iaEsperaHorario).length;
  const cr = daEmp.filter((c) => c.iaEsperaCota).length;
  if (h || cr) console.log(`      empresa ${n + 1}: ${h} esperando o horário da IA · ${cr} esperando a IA voltar (crédito)`);
}
