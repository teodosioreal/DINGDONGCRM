// Disparos de teste e respostas recentes da LEADS (anônimo: sem nomes, números nem textos).
// Mostra em que conversa cada resposta caiu, por qual endereço chegou e o que a IA fez.
const fs = require('fs');
const path = require('path');
const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : {};
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');
const limpo = (s, n = 120) => String(s || '').replace(/\+?\d[\d\s()-]{7,}\d/g, '[núm]').replace(/\s+/g, ' ').slice(0, n);
const tipo = (j) => (/@lid$/.test(j || '') ? 'lid' : /@s\.whatsapp\.net$/.test(j || '') ? 'número' : j ? 'outro' : '-');
const fone = (n) => { let d = String(n || '').split('@')[0].replace(/\D/g, ''); if (/^55\d{2}9\d{8}$/.test(d)) d = d.slice(0, 4) + d.slice(5); return d; };
const desde = new Date(Date.now() - 4 * 3600 * 1000).toISOString();

for (const [n, e] of (db.empresas || []).entries()) {
  if (!/lead/i.test(e.nome || '')) continue;
  const testes = (db.disparos || []).filter((d) => d.empresaId === e.id && d.teste).slice(-5);
  const leadsTeste = new Set(testes.flatMap((d) => d.destinatarios.map((x) => x.leadId)));
  const fonesTeste = new Set((db.conversas || []).filter((c) => leadsTeste.has(c.id)).map((c) => fone(c.telefone || c.whatsappJid)).filter(Boolean));
  console.log(`      Empresa ${n + 1} (LEADS): testes ${testes.length} · IA ${e.whatsappConfig?.iaAtiva === false ? 'DESLIGADA' : 'ligada'} · modo teste ${e.whatsappConfig?.modoTeste ? 'LIGADO' : 'não'} · 1ª mensagem espera ${e.whatsappConfig?.esperaPrimeiraSeg || 0}s · mapa LID ${Object.keys(e.mapaLid || {}).length}`);
  for (const d of testes) console.log(`        teste ${hora(d.criadoEm)} · ${d.destinatarios.map((x) => `${x.status}${x.erro ? ` (${limpo(x.erro, 60)})` : ''}`).join(',')} · roteiro ${d.roteiro ? 'sim' : 'não'}`);
  const recentes = (db.conversas || []).filter((c) => c.empresaId === e.id && ((c.mensagens || []).some((m) => m.em > desde) || c.criadoEm > desde));
  for (const c of recentes.sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1)).slice(0, 10)) {
    const msgs = (c.mensagens || []).filter((m) => m.em > desde);
    const seq = msgs.map((m) => (m.papel === 'visitante' ? 'C' : m.papel === 'assistente' ? (m.sistema ? 's' : 'IA') : m.disparoId ? 'D' : 'E')).join(' ');
    const doTeste = leadsTeste.has(c.id) ? 'É A CONVERSA DO TESTE' : fonesTeste.has(fone(c.telefone || c.whatsappJid)) ? 'mesmo número do teste (OUTRA conversa)' : '';
    console.log(`        conversa criada ${hora(c.criadoEm)} · jid ${tipo(c.whatsappJid)}${c.lidJid ? ' + lid' : ''} · telefone ${c.telefone ? 'sim' : 'não'} · origem ${c.origem || '-'} ${doTeste ? `· ${doTeste}` : ''}`);
    console.log(`           mensagens (4 h): ${seq || '-'}  [C=cliente IA=resposta da IA D=disparo E=equipe s=sistema] · último horário ${hora(msgs[msgs.length - 1]?.em)}`);
    console.log(`           IA: ${c.iaStatus ? `${c.iaStatus.tipo} ${hora(c.iaStatus.em)} — ${limpo(c.iaStatus.motivo)}` : 'nenhum status'} · pausada ${c.iaPausada ? `SIM (${limpo(c.iaPausadaMotivo, 60)})` : 'não'} · desligada ${c.iaDesligadaPor || '-'} · esperando token ${c.iaEsperaCota ? 'SIM' : 'não'} · esperando horário ${c.iaEsperaHorario ? 'SIM' : 'não'} · lista negra ${c.listaNegra ? 'SIM' : 'não'}`);
  }
  const ev = (e.whatsappConfig?.eventos || []).filter((x) => x.em > desde).slice(0, 10);
  console.log(`        eventos da IA (4 h): ${ev.map((x) => `${hora(x.em)} ${x.tipo}: ${limpo(x.motivo, 70)}`).join(' | ') || 'nenhum'}`);
}
