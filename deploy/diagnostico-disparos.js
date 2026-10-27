// Disparos em massa e a IA depois deles (anônimo: sem nomes, números nem textos das mensagens).
// Para cada empresa com disparo: os últimos disparos (status, por que parou, erros) e, de quem
// respondeu, se a IA respondeu ou por que não.
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
if (!fs.existsSync(arquivo)) {
  console.log('      (sem banco ainda)');
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
const limpo = (s, n = 140) => String(s || '').replace(/\+?\d[\d\s()-]{7,}\d/g, '[núm]').replace(/\s+/g, ' ').slice(0, n);
const hojeSp = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
console.log(`      agora ${hora(new Date().toISOString())}`);

// endereço da Evolution: o da empresa (raro) ou o geral do sistema
const URL_EVOLUTION = (w) => String(w.evolutionUrl || db.config?.evolutionUrl || process.env.EVOLUTION_API_URL || 'https://api.evolutiondingdong.online').replace(/\/+$/, '');
// estado da conexão na Evolution (só o estado, nada da conta)
async function conexao(w) {
  if (!w.instancia || !w.apiKey) return 'sem configuração';
  try {
    const r = await fetch(`${URL_EVOLUTION(w)}/instance/connectionState/${encodeURIComponent(w.instancia)}`, { headers: { apikey: w.apiKey }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    return `${r.status} ${j?.instance?.state || j?.state || limpo(JSON.stringify(j), 60)}`;
  } catch (err) {
    return `erro ao consultar (${limpo(err.message, 60)})`;
  }
}

(async () => {
for (const [n, e] of (db.empresas || []).entries()) {
  const disparos = (db.disparos || []).filter((d) => d.empresaId === e.id).sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  const ehLeads = /lead/i.test(String(e.nome || ''));
  if (!disparos.length && !ehLeads) continue;
  const w = e.whatsappConfig || {};
  const bots = (db.bots || []).filter((b) => b.empresaId === e.id);
  console.log(`      Empresa ${n + 1}${ehLeads ? ' (nome com "lead")' : ''}: ativa ${e.ativa === false ? 'NÃO' : 'sim'} · WhatsApp ${w.instancia && w.apiKey ? 'configurado' : 'NÃO configurado'} · IA ${w.iaAtiva === false ? 'DESLIGADA' : 'ligada'} · modo teste ${w.modoTeste ? 'LIGADO' : 'não'} · horário da IA ${e.expedienteIa?.ativo ? `${e.expedienteIa.inicio}–${e.expedienteIa.fim}` : 'sem limite'} · bots ${bots.length} · prompt do WhatsApp ${bots.some((b) => String(b.promptWhatsapp || '').trim()) ? 'preenchido' : 'VAZIO'}`);
  console.log(`        conexão na Evolution agora: ${await conexao(w)}`);
  // o que saiu da empresa nas últimas 24 h e o que o WhatsApp respondeu (entregue, lida, erro…)
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const saidas = [];
  for (const l of db.conversas || []) {
    if (l.empresaId !== e.id) continue;
    for (const m of l.mensagens || []) if (m.papel !== 'visitante' && m.em > desde && m.canal !== 'site') saidas.push({ m, lid: /@lid$/.test(l.whatsappJid || '') });
  }
  const porEntrega = {};
  for (const { m } of saidas) {
    const k = m.envio === 'erro' ? 'falhou ao enviar' : m.entrega || 'sem confirmação';
    porEntrega[k] = (porEntrega[k] || 0) + 1;
  }
  const ok = saidas.filter(({ m }) => ['entregue', 'lida', 'tocada'].includes(m.entrega)).map(({ m }) => m.em).sort().pop();
  const errosEnvio = saidas.filter(({ m }) => m.envio === 'erro' && m.erroEnvio).map(({ m }) => limpo(m.erroEnvio, 80));
  const primeiroErro = saidas.filter(({ m }) => m.entrega === 'erro').map(({ m }) => m.em).sort()[0];
  console.log(`        saídas 24 h: ${saidas.length} · ${Object.entries(porEntrega).map(([k, v]) => `${k} ${v}`).join(', ') || '-'} · última entregue/lida ${hora(ok)} · 1º erro de entrega ${hora(primeiroErro)} · erro em conversa @lid ${saidas.filter(({ m, lid }) => lid && m.entrega === 'erro').length}`);
  if (errosEnvio.length) console.log(`        motivos de falha: ${[...new Set(errosEnvio)].slice(0, 4).join(' | ')}`);
  // as últimas que saíram: para que tipo de endereço foram e o que o WhatsApp respondeu
  const tipoJid = (l) => {
    const j = String(l.whatsappJid || '');
    if (/@lid$/.test(j)) return 'id escondido (@lid)';
    if (/@s\.whatsapp\.net$/.test(j)) return `número ${j.split('@')[0].length} dígitos`;
    return j ? 'outro' : `sem jid (telefone ${String(l.telefone || '').replace(/\D/g, '').length} díg.)`;
  };
  const ultimas = [];
  for (const l of db.conversas || []) {
    if (l.empresaId !== e.id) continue;
    for (const m of l.mensagens || []) if (m.papel !== 'visitante' && m.em > desde) ultimas.push({ l, m });
  }
  ultimas.sort((a, b) => (a.m.em < b.m.em ? 1 : -1));
  for (const { l, m } of ultimas.slice(0, 8)) {
    console.log(`          saiu ${hora(m.em)} · ${m.papel}${m.disparoId ? ' (disparo)' : ''}${m.midiaCodigo || m.anexo ? ' · mídia' : ''} · para ${tipoJid(l)}${l.lidJid ? ' · conversa também tem @lid' : ''}${l.origem ? ` · lead de ${l.origem}` : ''} · id do WhatsApp ${m.wid ? 'sim' : 'NÃO'} · envio ${m.envio || '-'} · entrega ${m.entrega || 'sem confirmação'}${m.erroEnvio ? ` · erro: ${limpo(m.erroEnvio, 90)}` : ''}`);
  }
  for (const [i, d] of disparos.slice(0, 4).entries()) {
    const c = {};
    const erros = {};
    for (const x of d.destinatarios || []) {
      c[x.status] = (c[x.status] || 0) + 1;
      if (x.erro) erros[limpo(x.erro, 60)] = (erros[limpo(x.erro, 60)] || 0) + 1;
    }
    const lemb = (d.destinatarios || []).filter((x) => x.lembrete === 'enviado').length;
    console.log(`        disparo ${i + 1}: ${d.status}${d.prospeccao ? ' · prospecção' : ''} · criado ${hora(d.criadoEm)} · agendado p/ ${hora(d.agendadoPara)} · iniciou ${hora(d.iniciadoEm)} · total ${(d.destinatarios || []).length} · ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`           intervalo ${d.intervaloMin}-${d.intervaloMax}s · horário comercial ${d.horarioComercial ? 'sim' : 'não'} · hoje enviados ${d.enviadosPorDia?.[hojeSp] || 0}${d.prospeccaoCfg ? ` (1º dia ${d.prospeccaoCfg.limiteInicial}, teto ${d.prospeccaoCfg.tetoDia})` : ''} · próximo envio ${hora(d.proximoEnvioEm)} · esperando horário ${d.aguardandoHorario ? 'SIM' : 'não'} · esperando amanhã ${d.aguardandoAmanha ? 'SIM' : 'não'}${d.motivoPausa ? ` · pausa: ${limpo(d.motivoPausa)}` : ''} · roteiro ${d.roteiro ? 'sim' : 'não'} · lembrete ${d.lembrete ? `sim (${lemb} enviados)` : 'não'} · foto c/ nome ${d.personalizar ? 'sim' : 'não'}`);
    if (Object.keys(erros).length) console.log(`           erros/de fora: ${Object.entries(erros).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(' | ')}`);
  }
  // quem respondeu a um disparo: a IA respondeu depois?
  const ids = new Set(disparos.map((d) => d.id));
  const responderam = [];
  for (const l of db.conversas || []) {
    if (l.empresaId !== e.id) continue;
    const msgs = (l.mensagens || []).filter((m) => !m.apagada);
    const disp = msgs.filter((m) => m.disparoId && ids.has(m.disparoId)).pop();
    if (!disp) continue;
    const resp = msgs.find((m) => m.papel === 'visitante' && m.em > disp.em);
    if (resp) responderam.push({ l, msgs, disp, resp });
  }
  responderam.sort((a, b) => (a.resp.em < b.resp.em ? 1 : -1));
  const ia = responderam.filter(({ msgs, resp }) => msgs.some((m) => m.papel === 'assistente' && m.em > resp.em && !m.sistema)).length;
  console.log(`        responderam a disparo: ${responderam.length} · a IA respondeu ${ia} · sem resposta da IA ${responderam.length - ia}`);
  for (const [i, { l, msgs, resp }] of responderam.slice(0, 6).entries()) {
    const depois = msgs.filter((m) => m.em >= resp.em);
    const iaDepois = depois.filter((m) => m.papel === 'assistente' && !m.sistema).length;
    const log = (db.logRespostas || []).filter((x) => x.leadId === l.id).slice(-1)[0];
    console.log(`          resposta ${i + 1}: cliente escreveu ${hora(resp.em)} · depois: ${depois.map((m) => m.papel[0]).join('')} (v=cliente a=IA e=equipe) · IA respondeu ${iaDepois} · status da IA: ${l.iaStatus ? `${l.iaStatus.tipo} ${hora(l.iaStatus.em)} — ${limpo(l.iaStatus.motivo)}` : 'nenhum'} · pausada ${l.iaPausada ? `SIM (${limpo(l.iaPausadaMotivo, 60)})` : 'não'} · desligada ${l.iaDesligadaPor || '-'} · esperando token ${l.iaEsperaCota ? 'SIM' : 'não'} · esperando horário ${l.iaEsperaHorario ? 'SIM' : 'não'}${log ? ` · log: ${limpo(log.situacao, 60)}${log.erros?.length ? ` erros: ${limpo(log.erros.join(' | '))}` : ''}` : ''}`);
  }
  const eventos = (w.eventos || []).slice(0, 8);
  if (eventos.length) console.log(`        últimos eventos da IA: ${eventos.map((ev) => `${hora(ev.em)} ${ev.tipo}: ${limpo(ev.motivo, 90)}`).join(' | ')}`);
}
})();
