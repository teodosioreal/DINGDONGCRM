// Agendamentos de hoje (só leitura, anônimo): para cada conversa que falou de horário hoje, a
// ESTRUTURA das últimas mensagens (quem escreveu, se tinha dia, horário, pergunta, endereço,
// confirmação) e o que o CRM fez — nunca o texto, nomes ou números.
const fs = require('fs');
const path = require('path');
const os = require('os');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-diag-agenda-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
fs.chmodSync(copia, 0o600);
process.env.CRM_DB_PATH = copia;
process.env.SINCRONIA = 'nao';
process.env.EVENTOS_IA = 'nao';
const { estado } = require('../src/db');
const det = require('../src/detector-agenda');
const tickets = require('../src/tickets');
const endereco = require('../src/endereco');
const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const diaSp = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const hoje = diaSp(new Date().toISOString());
const ontem = diaSp(new Date(Date.now() - 864e5).toISOString());
for (const [n, e] of estado.empresas.entries()) {
  if (!e.whatsappConfig?.instancia) continue;
  console.log(`  Empresa ${n + 1} · exige endereço: ${e.agendaExigeEndereco !== false ? 'sim' : 'não'} · agenda automática: ${e.agendaAutomatica === false ? 'DESLIGADA' : 'ligada'}`);
  let k = 0;
  for (const l of estado.conversas) {
    if (l.empresaId !== e.id) continue;
    const msgs = (l.mensagens || []).filter((m) => m.texto && !m.apagada && [hoje, ontem].includes(diaSp(m.em)));
    const tx = sem(msgs.map((m) => m.texto).join(' '));
    if (!msgs.length || !/(agend|marc|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}\s*h\b|\d{1,2}:\d{2})/.test(tx)) continue;
    k++;
    const ags = (l.agendamentos || []).filter((a) => [hoje, ontem].includes(diaSp(a.criadoEm || 0)) || a.status === 'agendado');
    const ia = require('../src/ia-desligada').motivo(e, l);
    console.log(`    Conversa ${k}: ${msgs.length} msgs hoje/ontem · IA ${l.iaPausada ? 'pausada' : ia ? `desligada (${ia.por || ia})` : 'ligada'} · agendamentos: ${ags.map((a) => `${a.status}/${a.por}${a.detectadoPor ? `/${a.detectadoPor}` : ''}${a.quando ? '' : '/sem data'}`).join(', ') || 'nenhum'} · endereço do cliente: ${endereco.enderecoDo(l) ? 'SIM' : 'não'}`);
    for (const m of msgs.slice(-12)) {
      const t = sem(m.texto);
      const f = [];
      if (tickets.quandoNoTexto(m.texto, new Date(m.em))) f.push('dia');
      if (det.TEM_HORA.test(t)) f.push('HORA');
      if (t.includes('?')) f.push('pergunta');
      if (endereco.ehEndereco(m.texto)) f.push('ENDEREÇO');
      if (det.EMPRESA_CONFIRMA.test(t)) f.push('palavra-confirma');
      if (det.ACEITE.test(t.trim()) && det.ACEITE_FIRME.test(t)) f.push('aceite');
      if (det.DUVIDA.test(t)) f.push('dúvida');
      if (/\[\[agendamento/i.test(m.texto)) f.push('[[AGENDAMENTO]]');
      const quem = m.papel === 'visitante' ? 'cliente' : m.papel === 'equipe' ? `equipe${m.porCelular || m.doCelular ? '(cel)' : ''}` : 'IA';
      console.log(`      ${hora(m.em)} ${quem.padEnd(8)} ${String(m.texto.length).padStart(4)} letras · ${f.join(' ') || '-'}`);
    }
    const logs = (estado.logRespostas || []).filter((x) => x.leadId === l.id && [hoje, ontem].includes(diaSp(x.em)));
    const comAg = logs.filter((x) => /\[\[\s*AGENDAMENTO/i.test(x.bruto || '')).length;
    if (logs.length) console.log(`      IA respondeu ${logs.length}x · escreveu [[AGENDAMENTO]] ${comAg}x · avisos: ${[...new Set(logs.flatMap((x) => x.avisos || []))].map((a) => String(a).replace(/\d{6,}/g, '[n]').slice(0, 80)).join(' | ') || '-'}`);
  }
  // avisos da agenda hoje (sem nomes)
  const al = (estado.alertas || []).filter((a) => a.empresaId === e.id && /agenda/.test(a.tipo) && [hoje, ontem].includes(diaSp(a.ultimoEm || a.em)));
  for (const a of al) console.log(`    aviso ${hora(a.ultimoEm || a.em)}: ${/endereço/.test(a.mensagem) ? 'NÃO AGENDOU POR FALTA DE ENDEREÇO' : /etiqueta/.test(a.mensagem) ? 'entrou pela etiqueta' : /Novo agendamento|remarcado/.test(a.mensagem) ? 'agendamento detectado' : /cancelado/.test(a.mensagem) ? 'cancelamento' : 'outro'}`);
}
fs.rmSync(pasta, { recursive: true, force: true });
