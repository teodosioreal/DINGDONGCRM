// As 3 conversas com mensagem de cliente mais recente: por que a IA respondeu ou não (anônimo).
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');
for (const [n, e] of (db.empresas || []).entries()) {
  const w = e.whatsappConfig || {};
  if (!w.instancia) continue;
  console.log(`  Empresa ${n + 1}: IA ${w.iaAtiva ? 'ligada' : 'DESLIGADA'} · modo teste ${w.modoTeste ? 'LIGADO' : 'não'} · velocidade ${w.velocidade || 'humanizado'} · 1ª mensagem espera ${w.esperaPrimeiraSeg || 0}s · horário da IA ${e.expedienteIa?.ativo ? `${e.expedienteIa.inicio}–${e.expedienteIa.fim}` : 'sem limite'} · agora ${hora(new Date().toISOString())}`);
  const ultimaCli = (l) => [...(l.mensagens || [])].reverse().find((m) => m.papel === 'visitante' && !m.apagada);
  const leads = (db.conversas || []).filter((l) => l.empresaId === e.id && ultimaCli(l)).sort((a, b) => (ultimaCli(b).em > ultimaCli(a).em ? 1 : -1)).slice(0, 3);
  for (const [i, l] of leads.entries()) {
    const msgs = (l.mensagens || []).filter((m) => !m.apagada);
    const u = msgs[msgs.length - 1];
    const logs = (db.logRespostas || []).filter((x) => x.leadId === l.id).slice(-2);
    console.log(`    conversa ${i + 1}: criada ${hora(l.criadoEm)} · última do cliente ${hora(ultimaCli(l).em)} · última mensagem é de: ${u.papel} · nº de mensagens ${msgs.length} · respostas da IA ${msgs.filter((m) => m.papel === 'assistente').length}`);
    console.log(`       status da IA: ${l.iaStatus ? `${l.iaStatus.tipo} (${hora(l.iaStatus.em)}): ${String(l.iaStatus.motivo || '').replace(/\d{8,}/g, '[núm]').slice(0, 160)}` : 'nenhum'} · pausada ${l.iaPausada ? `SIM (${String(l.iaPausadaMotivo || '').slice(0, 80)})` : 'não'} · desligada por ${l.iaDesligadaPor || '-'} · esperando token ${l.iaEsperaCota ? 'SIM' : 'não'} · esperando horário ${l.iaEsperaHorario ? 'SIM' : 'não'} · lista negra/naoDisparar ${l.naoDisparar ? 'SIM' : 'não'} · etapa ${l.etapa}`);
    for (const x of logs) console.log(`       log ${hora(x.em)}: ${x.situacao}${x.erros?.length ? ` · erros: ${x.erros.join(' | ').slice(0, 160)}` : ''}${x.avisos?.length ? ` · avisos: ${x.avisos.join(' | ').slice(0, 160)}` : ''}`);
  }
}
