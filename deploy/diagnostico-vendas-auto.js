// Vendas criadas sozinhas (frase, IA, etiqueta) nos últimos 7 dias e a mensagem que causou — sem texto de cliente
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const limite = Date.now() - 7 * 86400000;
const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
for (const v of (db.vendas || []).filter((x) => new Date(x.criadoEm).getTime() > limite && !['manual', 'comprovante', 'painel'].includes(x.origem))) {
  const lead = (db.conversas || []).find((c) => c.id === v.leadId);
  const msgs = (lead?.mensagens || []).filter((m) => m.papel !== 'visitante' && m.texto && Math.abs(new Date(m.em) - new Date(v.criadoEm)) < 3 * 3600e3 + 3 * 86400e3);
  const outras = (db.vendas || []).filter((x) => x.leadId === v.leadId && x.id !== v.id && x.status !== 'cancelada');
  console.log(`      ${hora(v.criadoEm)} · origem ${v.origem}/${v.lidoPor} · ${v.status} · valor ${v.valor ? 'sim' : 'não'} · outras vendas do cliente: ${outras.map((x) => `${hora(x.criadoEm)} ${x.origem} ${x.status}`).join(', ') || 'nenhuma'}`);
  for (const m of msgs.filter((x) => /preferencia|avalia|comentario|google|g\.page|http/.test(sem(x.texto))).slice(-4)) {
    const t = sem(m.texto);
    console.log(`         msg ${hora(m.em)} · ${m.papel}${m.wid ? ' (do celular/webhook)' : ''}${m.pedido ? ` · pedido ${m.pedido}` : ''}${m.automacaoId ? ' · automação' : ''}${m.followupPasso ? ' · follow-up' : ''} · tem: ${['preferencia', 'avalia', 'comentario', 'google'].filter((k) => t.includes(k)).join('/') || '-'}${/https?:|g\.page|\.com/.test(t) ? '/link' : ''} · vendaVarrida ${m.vendaVarrida ? 'sim' : 'não'}`);
  }
}
