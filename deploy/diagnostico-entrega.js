// Mensagens que o WhatsApp devolveu com erro (48 h) e o que aconteceu depois. Sem texto de cliente.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const limite = Date.now() - 48 * 3600 * 1000;
const tipoDe = (m) => (m.midiaId ? `mídia ${m.midiaCodigo || ''}` : m.anexo ? `anexo ${m.anexo.tipo || ''}` : 'texto') + (m.followupPasso ? ` · follow-up ${m.followupPasso}` : '') + (m.automacaoId ? ' · automação' : '') + (m.pedido ? ` · pedido ${m.pedido}` : '') + (m.eventoIa ? ` · evento ${m.eventoIa}` : '');
// alertas de envio: qual conversa e o que aconteceu com as mensagens daquele momento
for (const a of (db.alertas || []).filter((x) => x.tipo === 'whatsapp-envio' && new Date(x.ultimoEm).getTime() > limite)) {
  const lead = (db.conversas || []).find((c) => c.id === a.leadId);
  console.log(`      alerta ${hora(a.ultimoEm)} · ${a.vezes}x · conversa ${lead ? (lead.whatsappJid || '').replace(/^\d+/, '[núm]') : 'não achada'}${lead?.lidJid ? ' · tem id escondido (@lid)' : ''}`);
  if (!lead) continue;
  const t = new Date(a.criadoEm).getTime();
  for (const m of (lead.mensagens || []).filter((x) => x.papel !== 'visitante' && Math.abs(new Date(x.em).getTime() - t) < 20 * 60 * 1000)) {
    console.log(`         ${hora(m.em)} · ${m.papel} · ${tipoDe(m)} · ${m.texto ? `${String(m.texto).length} letras` : ''} · situação agora: ${m.entrega || 'sem confirmação'}${m.apagada ? ' · apagada' : ''}`);
  }
}
// todas as que estão com erro agora
let n = 0;
for (const c of db.conversas || []) for (const m of c.mensagens || []) {
  if (m.entrega !== 'erro' || new Date(m.em).getTime() < limite) continue;
  n++;
  if (n <= 10) console.log(`      com erro agora: ${hora(m.em)} · ${m.papel} · ${tipoDe(m)}`);
}
console.log(`      mensagens com erro de entrega (48 h): ${n}`);
