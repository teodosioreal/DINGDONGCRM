// Por que um agendamento NÃO entrou (anônimo: só sim/não, papéis e horários — nunca o texto).
// Pega as conversas com movimento nas últimas 6 h que falam de dia/hora e mostra cada passo
// do detector. Roda numa CÓPIA do banco (nada muda; a leitura pela IA não grava nada).
const fs = require('fs');
const os = require('os');
const path = require('path');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ag-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
fs.chmodSync(copia, 0o600);
Object.assign(process.env, { CRM_DB_PATH: copia, SINCRONIA: 'nao', EVENTOS_IA: 'nao' });
const { estado } = require('../src/db');
const det = require('../src/detector-agenda');
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PISTA = /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}\/\d{1,2}|dia \d{1,2}|\d{1,2}\s*(h|hs|hrs|horas)\b|\d{1,2}:\d{2}|as \d{1,2}\b|horario|agend|marc|confirm)/;
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
(async () => {
  const limite = Date.now() - 6 * 3600e3;
  for (const [n, e] of estado.empresas.entries()) {
    if (!e.whatsappConfig?.instancia) continue;
    const lista = estado.conversas
      .filter((c) => c.empresaId === e.id && (c.mensagens || []).some((m) => new Date(m.em || 0).getTime() > limite))
      .filter((c) => PISTA.test(semAcento((c.mensagens || []).filter((m) => m.texto).slice(-8).map((m) => m.texto).join(' '))))
      .sort((a, b) => String(b.mensagens.slice(-1)[0]?.em).localeCompare(String(a.mensagens.slice(-1)[0]?.em)))
      .slice(0, 6);
    console.log(`  Empresa ${n + 1}: agenda automática ${e.agendaAutomatica === false ? 'DESLIGADA' : 'ligada'} · exige endereço ${require('../src/endereco').exige(e) ? 'sim' : 'não'} · conversas com dia/hora nas últimas 6 h: ${lista.length}`);
    for (const [i, c] of lista.entries()) {
      const msgs = (c.mensagens || []).filter((m) => m.texto && !m.apagada).slice(-8);
      const papel = (m) => ({ visitante: 'C', equipe: 'E', assistente: 'IA' }[m.papel] || '?');
      const seq = msgs.map((m) => {
        const t = semAcento(m.texto);
        const dia = /\b(hoje|amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana que vem|\d{1,2}\/\d{1,2}|dia \d{1,2})\b/.test(t);
        const periodo = /\b(de manha|pela manha|cedo|de tarde|a tarde|pela tarde|de noite|a noite|depois do almoco|meio dia|meio-dia|horario de almoco)\b/.test(t);
        return `${papel(m)}${dia ? '📆' : ''}${periodo ? '🌓' : ''}${det.TEM_HORA.test(t) ? '⏰' : ''}${det.EMPRESA_CONFIRMA.test(t) ? '✔' : ''}${det.ACEITE.test(t.trim()) ? '👍' : ''}${t.includes('?') ? '?' : ''}${m.agendaFrase ? '📌' : ''}`;
      }).join(' ');
      const ags = (c.agendamentos || []).map((a) => `${a.status}${a.quando ? ' ' + hora(a.quando) : ''} por ${a.por}${a.detectadoPor ? '/' + a.detectadoPor : ''} criado ${hora(a.criadoEm)}`).join(' | ') || 'nenhum';
      let codigo = null;
      try { codigo = det.porCodigo(e, c); } catch (err) { codigo = { erro: err.message }; }
      const end = require('../src/endereco');
      const temEnd = Boolean(end.enderecoDo(c, codigo?.extras || []));
      const iaResponde = require('../src/whatsapp').iaVaiResponder(e, c);
      const deslig = require('../src/ia-desligada').motivo(e, c);
      const conf = /\b(pode ser|pode sim|fechado|fechou|combinado|confirmad\w*|confirmo|agendad\w*|agendei|marcad\w*|marquei|te espero|estarei|vou sim|beleza|blz|perfeito|ta bom|ta certo|certo|ok|sim)\b/.test(semAcento(msgs.slice(-2).map((m) => m.texto).join(' ')));
      console.log(`    conversa ${i + 1}: etapa "${c.etapa}" · últimas msgs [${seq}] · última ${hora(msgs.slice(-1)[0]?.em)}`);
      console.log(`      agendamentos: ${ags}`);
      console.log(`      código achou: ${codigo ? (codigo.erro ? 'ERRO ' + codigo.erro : `${codigo.acao} ${hora(codigo.quando)}`) : 'nada'} · endereço na conversa: ${temEnd ? 'sim' : 'NÃO'} · IA atendendo esta conversa: ${iaResponde ? 'sim (aí o CRM confia na tag da IA e não confere)' : 'não'} · IA desligada por: ${deslig?.por || '-'} · confirmação nas 2 últimas: ${conf ? 'sim' : 'não'} · já conferida pela IA até a última msg: ${c.agendaConferidaAte && c.agendaConferidaAte === msgs.slice(-1)[0]?.id ? 'sim' : 'não'}`);
      // o que a IA diria agora (só a decisão, nunca o texto)
      try {
        if (i > 0) throw new Error('(só lê a 1ª conversa com a IA)');
        const d = await Promise.race([det.porIa(e, c), new Promise((_, nao) => setTimeout(() => nao(new Error('IA demorou mais de 25 s')), 25000))]);
        if (d) console.log(`      leitura da IA agora: ${d.acao}${d.quando ? ' ' + hora(d.quando) : ''}`);
      } catch (err) { console.log(`      leitura da IA: erro ${String(err.message).slice(0, 80)}`); }
    }
    const avisos = (estado.alertas || []).filter((a) => a.empresaId === e.id && /^agenda:/.test(a.chave || a.tipo || '') && new Date(a.ultimoEm || a.criadoEm || 0).getTime() > limite);
    console.log(`    avisos de agenda nas últimas 6 h: ${avisos.length} ${avisos.map((a) => (/endere/.test(a.mensagem) ? '📍falta endereço' : /cancel/.test(a.mensagem) ? '❌cancelado' : /detectado|confirmado/.test(a.mensagem) ? '📅marcou' : '?')).join(' ')}`);
  }
  fs.rmSync(pasta, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => { console.log('    erro:', err.message); process.exit(0); });
