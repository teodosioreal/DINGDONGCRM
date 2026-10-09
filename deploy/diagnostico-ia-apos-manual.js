// A IA falou DEPOIS de uma mensagem manual? (só leitura, anônimo: tipos, horários e estado — sem texto)
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const desde = Date.now() - 3 * 86400000;
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tipoIa = (m) => (m.followupPasso ? `follow-up passo ${m.followupPasso}` : m.automacaoId ? 'automação' : m.eventoIa ? `aviso ${m.eventoIa}` : m.respostaAuto ? 'resposta pronta' : m.pedido ? `pedido ${m.pedido}` : 'resposta da IA');
for (const [n, e] of (db.empresas || []).entries()) {
  if (!e.whatsappConfig?.instancia) continue;
  console.log(`  Empresa ${n + 1} · "IA continua depois da mensagem manual": ${e.whatsappConfig.iaAposManual === true ? 'LIGADO (a IA continua)' : 'desligado (a IA para)'}`);
  let k = 0;
  for (const l of db.conversas || []) {
    if (l.empresaId !== e.id) continue;
    const msgs = (l.mensagens || []).filter((m) => !m.apagada && new Date(m.em).getTime() > desde);
    const casos = [];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].papel !== 'equipe' || msgs[i].pedido) continue;
      const depois = msgs.slice(i + 1).find((m) => m.papel === 'assistente');
      if (!depois) continue;
      const entre = msgs.slice(i + 1, msgs.indexOf(depois)).map((m) => (m.papel === 'visitante' ? 'C' : m.papel === 'equipe' ? 'E' : 'I')).join('');
      casos.push(`equipe ${hora(msgs[i].em)} (${msgs[i].wid ? 'celular' : 'painel'}) → ${tipoIa(depois)} ${hora(depois.em)} · entre: ${entre || '-'}`);
      i = msgs.indexOf(depois);
    }
    if (!casos.length) continue;
    k++;
    const logs = (db.logRespostas || []).filter((x) => x.leadId === l.id && new Date(x.em).getTime() > desde).slice(-6).map((x) => `${hora(x.em)} ${x.origem || '?'}/${x.situacao || '?'}`);
    console.log(`    Conversa ${k}: IA agora ${l.iaPausada ? `pausada (${String(l.iaPausadaMotivo || '').slice(0, 40)})` : 'LIGADA'}${l.iaLigadaAMao ? ' · ligada à mão' : ''}`);
    for (const c of casos.slice(-4)) console.log(`      ${c}`);
    if (logs.length) console.log(`      registro da IA: ${logs.join(' | ')}`);
  }
  if (!k) console.log('    nenhuma conversa com a IA falando depois de mensagem manual (3 dias)');
}
