// Por que a IA falhou com "Requests ending with a model turn" (anônimo: só papéis, tamanhos e
// horários — nunca o texto). Para cada falha recente, refaz a conversa como estava na hora e
// mostra quem falou por último no que foi para a IA. Roda numa CÓPIA do banco (nada muda).
const fs = require('fs');
const os = require('os');
const path = require('path');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-turno-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
fs.chmodSync(copia, 0o600);
Object.assign(process.env, { CRM_DB_PATH: copia, SINCRONIA: 'nao', EVENTOS_IA: 'nao' });
const { estado } = require('../src/db');
const ia = require('../src/ia');
const leads = require('../src/leads');
const eventos = require('../src/eventos-ia');
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
const PAPEL = { visitante: 'C', equipe: 'E', assistente: 'IA' };
const marca = (m) => `${PAPEL[m.papel] || `?${m.papel}`}${!String(m.texto || '').trim() ? '∅' : ''}${m.apagada ? '✖' : ''}${m.eventoInterno ? '⚙' : ''}${m.disparoId ? '📣' : ''}${m.followupPasso ? '🔁' : ''}${m.antesDaConversa ? '⏮' : ''}${m.anexo ? '📎' : ''}${m.importada ? '⤵' : ''}`;
try {
  for (const [n, e] of estado.empresas.entries()) {
    const falhas = (e.whatsappConfig?.eventos || []).filter((ev) => /model turn/i.test(ev.motivo || '') && ev.leadId);
    const leadsComStatus = estado.conversas.filter((c) => c.empresaId === e.id && /model turn/i.test(c.iaStatus?.motivo || ''));
    if (!falhas.length && !leadsComStatus.length) continue;
    console.log(`  Empresa ${n + 1}: ${falhas.length} falha(s) "model turn" nos últimos eventos · ${leadsComStatus.length} conversa(s) com esse status agora · prompt novo em ${hora(e.promptNovo?.em)}`);
    const vistos = new Set();
    for (const ev of [...falhas, ...leadsComStatus.map((c) => ({ leadId: c.id, em: c.iaStatus.em, motivo: c.iaStatus.motivo }))]) {
      if (vistos.has(`${ev.leadId}|${ev.em}`) || vistos.size >= 8) continue;
      vistos.add(`${ev.leadId}|${ev.em}`);
      const lead = estado.conversas.find((c) => c.id === ev.leadId);
      if (!lead) { console.log(`    ${hora(ev.em)} conversa apagada`); continue; }
      // a conversa como estava na hora da falha
      const naHora = { ...lead, mensagens: (lead.mensagens || []).filter((m) => !m.em || m.em <= ev.em) };
      const hist = eventos.historicoParaIa(e, leads.historicoParaIa(naHora));
      const { historico } = require('../src/prompt-novo').separarHistorico(e, hist);
      const turnos = ia.paraTurnos(historico.slice(-30), { inicioReal: historico.length <= 30 });
      const ult = naHora.mensagens.slice(-8);
      console.log(`    ${hora(ev.em)} · msgs ${naHora.mensagens.length} (p/ IA ${historico.length}) · reiniciada ${lead.iaReiniciadaEm ? hora(lead.iaReiniciadaEm) : 'não'} · turnos ${turnos.map((t) => (t.role === 'user' ? 'u' : 'a')).join('')} · últimas: ${ult.map(marca).join(' ')} · minutos antes: ${ult.map((m) => (m.em ? Math.round((new Date(ev.em) - new Date(m.em)) / 60000) : '?')).join(',')}`);
    }
  }
} finally {
  fs.rmSync(pasta, { recursive: true, force: true });
}
