// Agendamentos e o funil de cada empresa (anônimo: só contagens e tempos, sem nome, telefone,
// texto ou valor em R$): leads → agendou → comprou por semana, de onde vieram os agendamentos,
// quantos aconteceram/cancelaram, tempo da 1ª resposta, e o que o follow-up recuperou.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const DIA = 864e5;
const agora = Date.now();
const ms = (x) => new Date(x || 0).getTime();
const mediana = (l) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const minTxt = (m) => (m == null ? '-' : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} dias`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
for (const [n, e] of (db.empresas || []).entries()) {
  const leads = (db.conversas || []).filter((l) => l.empresaId === e.id && !/@g\.us$/.test(l.whatsappJid || '') && (l.mensagens || []).some((m) => m.papel === 'visitante'));
  if (!leads.length) continue;
  const vendas = (db.vendas || []).filter((v) => v.empresaId === e.id && v.status === 'confirmada');
  const vendeu = (l, de, ate) => vendas.some((v) => v.leadId === l.id && ms(v.criadoEm) >= de && ms(v.criadoEm) < ate);
  console.log(`  Empresa ${n + 1}:`);
  // por semana (4 semanas, a mais recente primeiro)
  for (let s = 0; s < 4; s++) {
    const ate = agora - s * 7 * DIA;
    const de = ate - 7 * DIA;
    const novos = leads.filter((l) => ms(l.criadoEm) >= de && ms(l.criadoEm) < ate);
    const ags = leads.flatMap((l) => (l.agendamentos || []).map((a) => ({ a, l }))).filter(({ a }) => ms(a.criadoEm) >= de && ms(a.criadoEm) < ate);
    const leadsAg = new Set(ags.map(({ l }) => l.id));
    const vendasSem = vendas.filter((v) => ms(v.criadoEm) >= de && ms(v.criadoEm) < ate);
    const novosQueAgendaram = novos.filter((l) => (l.agendamentos || []).length).length;
    console.log(`    semana ${new Date(de).toISOString().slice(5, 10)} a ${new Date(ate).toISOString().slice(5, 10)}: leads novos ${novos.length} · agendamentos marcados ${ags.length} (${leadsAg.size} clientes) · dos leads novos, agendaram ${novosQueAgendaram} (${pct(novosQueAgendaram, novos.length)}) · vendas confirmadas ${vendasSem.length}`);
  }
  // agendamentos de 28 dias: origem e o que aconteceu
  const de28 = agora - 28 * DIA;
  const todos = leads.flatMap((l) => (l.agendamentos || []).map((a) => ({ a, l }))).filter(({ a }) => ms(a.criadoEm) >= de28);
  const conta = (f) => { const c = {}; for (const x of todos) { const k = f(x); c[k] = (c[k] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nenhum'; };
  const ORIGEM = (a) => (a.por === 'ia' ? 'IA na conversa' : a.por === 'detectado' ? `detectado pelo CRM (${a.detectadoPor || '?'})` : a.detectadoPor === 'frase' ? 'você digitou "agendamento confirmado"' : a.por === 'etiqueta' ? 'etiqueta Agendado' : a.por === 'equipe' ? 'você marcou à mão' : a.por || '?');
  console.log(`    agendamentos 28 dias: ${todos.length} · quem marcou: ${conta(({ a }) => ORIGEM(a))}`);
  console.log(`      situação: ${conta(({ a }) => a.status || '?')} · sem data ("a combinar"): ${todos.filter(({ a }) => !a.quando).length} · com valor: ${todos.filter(({ a }) => a.valor > 0).length}`);
  const passaram = todos.filter(({ a }) => a.quando && ms(a.quando) < agora - 3 * 3600e3 && a.status !== 'remarcado');
  const pagos = passaram.filter(({ a, l }) => vendeu(l, ms(a.criadoEm) - DIA, ms(a.quando) + 3 * DIA));
  const cancel = passaram.filter(({ a }) => a.status === 'cancelado');
  console.log(`      dos que já passaram do horário (${passaram.length}): com venda confirmada perto do dia ${pagos.length} (${pct(pagos.length, passaram.length)}) · cancelados ${cancel.length} · sem venda e sem cancelar ${passaram.length - pagos.length - cancel.length}`);
  const ateAgendar = todos.map(({ a, l }) => (ms(a.criadoEm) - ms(l.criadoEm)) / 60000).filter((x) => x >= 0);
  const antecedencia = todos.filter(({ a }) => a.quando).map(({ a }) => (ms(a.quando) - ms(a.criadoEm)) / 60000).filter((x) => x >= 0);
  console.log(`      tempo do 1º contato até agendar (mediana): ${minTxt(mediana(ateAgendar))} · marcado com antecedência de (mediana): ${minTxt(mediana(antecedencia))}`);
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const porDia = {};
  for (const { a } of todos) if (a.quando) { const d = dias[new Date(ms(a.quando) - 3 * 3600e3).getUTCDay()]; porDia[d] = (porDia[d] || 0) + 1; }
  console.log(`      dias da semana marcados: ${dias.map((d) => `${d} ${porDia[d] || 0}`).join(' · ')}`);
  // 1ª resposta e quem atende (leads novos de 28 dias)
  const novos28 = leads.filter((l) => ms(l.criadoEm) >= de28);
  const tempos = [];
  let pelaIa = 0, pelaEquipe = 0, semResposta = 0, aguardando = 0;
  for (const l of novos28) {
    const msgs = (l.mensagens || []).filter((m) => !m.apagada);
    const primeira = msgs.find((m) => m.papel === 'visitante');
    const resp = msgs.find((m) => (m.papel === 'assistente' || m.papel === 'equipe') && ms(m.em) >= ms(primeira?.em) && !m.disparoId && !m.followupPasso);
    if (!resp) { if (agora - ms(primeira?.em) < 2 * 3600e3) aguardando++; else semResposta++; continue; }
    tempos.push((ms(resp.em) - ms(primeira.em)) / 60000);
    if (resp.papel === 'assistente') pelaIa++; else pelaEquipe++;
  }
  console.log(`    1ª resposta (leads novos 28 dias: ${novos28.length}): mediana ${minTxt(mediana(tempos))} · respondida primeiro pela IA ${pelaIa} · pela equipe ${pelaEquipe} · nunca respondidos ${semResposta} · esperando agora ${aguardando}`);
  const lentos = tempos.filter((t) => t > 60).length;
  console.log(`      respondidos em até 5 min: ${tempos.filter((t) => t <= 5).length} · até 1 h: ${tempos.filter((t) => t <= 60).length} · mais de 1 h: ${lentos}`);
  // o que acontece com quem não agendou
  const naoAgendou = novos28.filter((l) => !(l.agendamentos || []).length && !vendas.some((v) => v.leadId === l.id));
  const parou = naoAgendou.filter((l) => { const ult = (l.mensagens || []).filter((m) => !m.apagada).slice(-1)[0]; return ult && ult.papel !== 'visitante'; });
  console.log(`    leads novos que não agendaram nem compraram: ${naoAgendou.length} · desses, a última mensagem é nossa (cliente sumiu) ${parou.length} · última é do cliente (ficou sem resposta) ${naoAgendou.length - parou.length}`);
  // follow-up: quem recebeu e depois agendou/comprou
  const comFup = leads.filter((l) => (l.mensagens || []).some((m) => m.followupPasso != null && ms(m.em) >= de28));
  const recuperados = comFup.filter((l) => { const f = ms((l.mensagens || []).find((m) => m.followupPasso != null && ms(m.em) >= de28)?.em); return (l.agendamentos || []).some((a) => ms(a.criadoEm) > f) || vendas.some((v) => v.leadId === l.id && ms(v.criadoEm) > f); });
  const responderam = comFup.filter((l) => { const f = ms((l.mensagens || []).find((m) => m.followupPasso != null && ms(m.em) >= de28)?.em); return (l.mensagens || []).some((m) => m.papel === 'visitante' && ms(m.em) > f); });
  console.log(`    follow-up 28 dias: clientes que receberam ${comFup.length} · responderam depois ${responderam.length} · agendaram ou compraram depois ${recuperados.length}`);
  // agendamentos que o CRM não marcou por falta de endereço (avisos do sininho)
  const semEnd = (db.alertas || []).filter((a) => a.empresaId === e.id && /endereço/.test(a.mensagem || '') && /agend/i.test(a.mensagem || '') && ms(a.ultimoEm) >= de28);
  console.log(`    "combinaram horário mas falta endereço — não agendei" (28 dias): ${semEnd.length} cliente(s) · ${semEnd.reduce((s, a) => s + (a.vezes || 1), 0)} aviso(s)`);
}
