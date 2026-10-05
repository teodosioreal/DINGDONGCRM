// detector-agenda.js — percebe sozinho quando um agendamento é MARCADO,
// REMARCADO ou CANCELADO na conversa do WhatsApp, quem quer que tenha escrito
// (cliente, equipe pelo celular, equipe pelo painel ou a IA).
//
// Dois jeitos, juntos:
//   1. Código (na hora, sem IA): proposta de dia/hora seguida de "pode ser",
//      "fechado", "combinado"… do outro lado; ou "desmarca", "cancela o horário".
//   2. IA (barata), uns segundos depois da última mensagem: lê o fim da conversa
//      e diz se ficou combinado um horário, se mudou ou se foi cancelado.
// O que for detectado vira o aviso AGENDADO na conversa, avisa no sininho e
// (se ligado) manda o aviso de agendamento para o número cadastrado.

const { estado, salvar } = require('./db');

const ESPERA_MS = Number(process.env.AGENDA_DETECTOR_ESPERA_MS) || 20000;
const CONFIANCA_MINIMA = 0.7;
const timers = new Map(); // leadId → timeout

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Vale a pena olhar? (tem dia/hora, confirmação ou cancelamento nas últimas mensagens)
const PISTA_TEMPO = /\b(hoje|amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana que vem|\d{1,2}\/\d{1,2}|dia \d{1,2}|\d{1,2}\s*(h|hs|hrs|horas)\b|\d{1,2}:\d{2}|as \d{1,2}\b|horario|agend|marc|remarc)/;
const PISTA_CANCELA = /\b(desmarc|cancel|nao vou (poder|conseguir) (ir|comparecer)|nao vai dar|remarc|outro dia|adiar)/;
const ACEITE = /^(?:\s*(?:ok+|okay|blz|beleza|fechado|fechou|combinado|perfeito|otimo|show|pode ser|pode sim|pode|sim|claro|confirmado|confirmo|certo|ta bom|ta otimo|ta certo|feito|top|bora|vamos|vou sim|estarei ai|te espero|te vejo|nos vemos|ate (?:la|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)|obrigad[oa]|valeu|vlw|entao|combinadissimo|marcado|agendado|trocado)\b[\s!.,👍🙏😊🤝✅]*)+$/;
// confirmação perto de um dia/hora: só aí vale a IA conferir (falar de horário sem ninguém confirmar não marca nada)
const CONFIRMA = /\b(pode ser|pode sim|fechado|fechou|combinado|confirmad\w*|confirmo|agendad\w*|agendei|marcad\w*|marquei|te espero|estarei|vou sim|beleza|blz|perfeito|ta bom|ta certo|certo|ok|sim|desmarc\w*|cancel\w*|remarc\w*)\b/;
const DUVIDA = /\b(talvez|vou ver|vou verificar|se der|acho que|nao sei|depois (te )?(falo|aviso|confirmo)|vou confirmar|qualquer coisa)\b/;

function ehAgendado(ag) {
  return ag.status === 'agendado' && (!ag.quando || new Date(ag.quando).getTime() > Date.now() - 6 * 3600 * 1000);
}

// ---------------------------------------------------------------- 1. código (na hora)
function porCodigo(empresa, lead) {
  const tickets = require('./tickets');
  const msgs = (lead.mensagens || []).filter((m) => m.texto && !m.apagada).slice(-4);
  const ultima = msgs[msgs.length - 1];
  if (!ultima) return null;
  const t = semAcento(ultima.texto);
  // "pode ser" / "fechado" respondendo a uma proposta com dia/hora do outro lado
  // a mensagem INTEIRA é um aceite curto (sem pergunta): "pode sim", "fechado!", "ok, obrigado"
  if (ACEITE.test(t.trim()) && t.length < 60 && !t.includes('?')) {
    const lado = (m) => (m.papel === 'visitante' ? 'cliente' : 'empresa');
    const proposta = [...msgs.slice(0, -1)].reverse().find((m) => lado(m) !== lado(ultima) && tickets.quandoNoTexto(m.texto));
    if (proposta && DUVIDA.test(semAcento(proposta.texto))) return null; // "talvez sábado, vou ver" não é proposta firme
    if (proposta) {
      const quando = tickets.quandoNoTexto(proposta.texto, new Date(proposta.em || Date.now()));
      if (quando && new Date(quando).getTime() > Date.now() - 3600 * 1000) {
        return { acao: 'agendar', quando, descricao: String(proposta.texto).replace(/\s+/g, ' ').trim().slice(0, 120), fonte: 'codigo' };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 2. IA (alguns segundos depois)
async function porIa(empresa, lead) {
  const bot = require('./whatsapp').botDoWhatsapp(empresa);
  if (!bot || !require('./ia').motoresDa(empresa, bot).length) return null; // sem chave de IA: só o código percebe
  const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const conversa = require('./leads').historicoParaIa(lead)
    .filter((m) => m.texto && !m.apagada)
    .slice(-16)
    .map((m) => `[${m.em ? fmt(m.em) : '?'}] ${m.papel === 'visitante' ? 'CLIENTE' : m.papel === 'equipe' ? 'EMPRESA (equipe)' : 'EMPRESA (IA)'}: ${String(m.texto).slice(0, 500)}`)
    .join('\n');
  const ativos = (lead.agendamentos || []).filter(ehAgendado);
  const agora = fmt(new Date().toISOString());
  const servicos = require('./catalogo').itensDa(empresa).filter((x) => x.ativo).map((x) => x.nome).slice(0, 30).join(', ');
  const sistema =
    'Você confere conversas de WhatsApp de uma empresa e diz se um AGENDAMENTO (visita, serviço, consulta, instalação, entrega, horário) foi MARCADO, REMARCADO ou CANCELADO. Responda SOMENTE com JSON, sem texto antes ou depois.\n' +
    'Regras:\n' +
    '- "agendar": os dois lados combinaram um dia (e horário, se falaram) — a empresa propôs e o cliente aceitou, ou o cliente pediu e a empresa confirmou. Proposta ainda sem resposta, "vou ver" ou "talvez" = "nada".\n' +
    '- "remarcar": já havia agendamento e combinaram outro dia/horário.\n' +
    '- "cancelar": o cliente ou a empresa desmarcou/cancelou um agendamento existente (sem marcar outro).\n' +
    '- "nada": qualquer outra situação (inclusive "te chamo amanhã", que é só retorno de contato, não horário marcado).\n' +
    '- "quando": data e hora no formato dd/mm/aaaa hh:mm, calculada a partir da data/hora de cada mensagem (ex.: "sábado" dito numa quinta = o sábado seguinte). Sem horário combinado, use 09:00 e diga em "semHora": true.\n' +
    '- Não invente: só o que está na conversa.';
  const pedido =
    `Agora: ${agora} (horário de Brasília).\n` +
    `Agendamentos ativos deste cliente: ${ativos.length ? ativos.map((a) => `${a.id} = ${a.quando ? fmt(a.quando) : a.quandoTexto}${a.descricao ? ` (${a.descricao})` : ''}`).join('; ') : 'nenhum'}.\n` +
    (servicos ? `Serviços da empresa: ${servicos}.\n` : '') +
    `\nConversa (mais recente por último):\n${conversa}\n\n` +
    'JSON: {"acao": "agendar|remarcar|cancelar|nada", "quando": "dd/mm/aaaa hh:mm ou vazio", "semHora": false, "descricao": "o que foi agendado, curto", "agendamentoId": "id do agendamento ativo afetado (remarcar/cancelar) ou vazio", "confianca": 0.0, "trecho": "frase da conversa que prova"}';
  const ia = require('./ia');
  const r = await ia.comTarefa('agenda', () => ia.gerarTexto(bot, empresa, sistema, pedido, 600, { barato: true }));
  const m = String(r).match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  if (!['agendar', 'remarcar', 'cancelar'].includes(j.acao) || !(Number(j.confianca) >= CONFIANCA_MINIMA)) return { acao: 'nada' };
  const quando = j.quando ? require('./tickets').quandoDe(j.quando) : null;
  if ((j.acao === 'agendar' || j.acao === 'remarcar') && !quando) return { acao: 'nada' };
  return { acao: j.acao, quando, descricao: String(j.descricao || '').slice(0, 200), agendamentoId: String(j.agendamentoId || ''), trecho: String(j.trecho || '').slice(0, 200), fonte: 'ia' };
}

// ---------------------------------------------------------------- aplicar
function aplicar(empresa, lead, d) {
  if (!d || d.acao === 'nada') return null;
  const tickets = require('./tickets');
  const ativos = (lead.agendamentos || []).filter(ehAgendado);
  const nome = lead.nome || 'Cliente';
  const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const avisar = (texto) => require('./alertas').registrar(empresa, `agenda:${lead.id}`, texto, { nivel: 'info', leadId: lead.id });

  if (d.acao === 'cancelar') {
    const alvo = ativos.find((a) => a.id === d.agendamentoId) || (ativos.length === 1 ? ativos[0] : null);
    if (!alvo) return null;
    tickets.cancelarAgendamento(lead, alvo.id, { por: 'detectado', motivo: d.trecho || 'cancelado na conversa', empresa });
    avisar(`❌ Agendamento cancelado na conversa: ${nome} — ${alvo.quando ? fmt(alvo.quando) : alvo.quandoTexto}.`);
    return { acao: 'cancelar', agendamento: alvo };
  }
  // agendar/remarcar: horário que já passou = nada a fazer
  if (!d.quando || new Date(d.quando).getTime() < Date.now() - 3600 * 1000) return null;
  const jaMarcado = ativos.find((a) => a.quando === d.quando);
  if (d.acao === 'remarcar') {
    // o horário velho sai (mesmo que o novo já tenha sido marcado pelo código um instante antes)
    const outros = ativos.filter((a) => a.quando !== d.quando);
    const antigo = outros.find((a) => a.id === d.agendamentoId) || (outros.length === 1 ? outros[0] : null);
    if (antigo) {
      tickets.cancelarAgendamento(lead, antigo.id, { por: 'detectado', motivo: 'remarcado', remarcado: true, empresa });
      if (jaMarcado) {
        avisar(`🔁 Agendamento remarcado na conversa: ${nome} — de ${antigo.quando ? fmt(antigo.quando) : antigo.quandoTexto} para ${fmt(d.quando)}.`);
        return { acao: 'remarcar', agendamento: jaMarcado };
      }
    }
  }
  if (jaMarcado) return null;
  const r = tickets.registrarAgendamento(empresa, lead, { quando: d.quando, descricao: d.descricao, por: 'detectado' });
  if (!r?.novo) return null;
  r.agendamento.detectadoPor = d.fonte;
  if (d.trecho) r.agendamento.trecho = d.trecho;
  salvar();
  avisar(`📅 ${d.acao === 'remarcar' ? 'Agendamento remarcado' : 'Novo agendamento'} detectado na conversa: ${nome} — ${fmt(d.quando)}${d.descricao ? ` (${d.descricao})` : ''}. Se não for isso, desfaça na conversa.`);
  return { acao: d.acao, agendamento: r.agendamento };
}

// ---------------------------------------------------------------- etiqueta "Agendado" do WhatsApp
// Colocou a etiqueta Agendado no cliente (no celular ou no CRM): ele entra em
// Agendamentos. A IA procura na conversa o dia/hora combinado; sem data, entra
// como "data a combinar". Tirou a etiqueta: sai (só o que a etiqueta criou).
const ehEtiquetaAgendado = (nome) => /^agendad/.test(semAcento(nome).trim());
const DIAS_IMPORTACAO = 14;

async function pelaEtiqueta(empresa, lead, { aoVivo = true } = {}) {
  if (!empresa || !lead || (lead.agendamentos || []).some(ehAgendado)) return null; // já está na agenda
  // (o "Agendado" velho que volta depois da venda — cópia do servidor / celular reconectando — já é
  // barrado antes de chegar aqui; posto de propósito depois da venda, ex.: entrega, vale)
  // etiqueta antiga vinda da leitura geral: só conversas recentes, sem IA e sem aviso
  if (!aoVivo && Date.now() - new Date(lead.atualizadoEm || lead.criadoEm || 0).getTime() > DIAS_IMPORTACAO * 86400000) return null;
  const tickets = require('./tickets');
  // 1º código: a última data/hora dita na conversa (que ainda não passou)
  const pelaConversa = (() => {
    // só vale data CONFIRMADA: a própria mensagem confirma ("agendado sábado 9h") ou o outro
    // lado aceitou logo depois ("pode ser"). Horário de funcionamento/opções soltas → IA decide
    const msgs = (lead.mensagens || []).filter((x) => x.texto && !x.apagada).slice(-10);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const t = semAcento(m.texto);
      if (DUVIDA.test(t) || /\b(atendemos|funcionamos|abrimos|horario de funcionamento|de segunda a)\b/.test(t) || /\bou\b.*\d/.test(t)) continue;
      const q = tickets.quandoNoTexto(m.texto, new Date(m.em || Date.now()));
      if (!q || new Date(q).getTime() < Date.now() - 3600 * 1000) continue;
      const depois = msgs[i + 1];
      const aceito = depois && depois.papel !== m.papel && ACEITE.test(semAcento(depois.texto).trim());
      if (/\b(agendad\w*|marcad\w*|confirmad\w*|combinado|fechado)\b/.test(t) || aceito) return { quando: q, descricao: String(m.texto).replace(/\s+/g, ' ').trim().slice(0, 120) };
    }
    return null;
  })();
  if (pelaConversa) {
    const r = tickets.registrarAgendamento(empresa, lead, { quando: pelaConversa.quando, descricao: pelaConversa.descricao, por: 'etiqueta', semAviso: !aoVivo });
    if (r?.agendamento) {
      r.agendamento.detectadoPor = 'codigo';
      salvar();
      return r.agendamento;
    }
  }
  if (aoVivo) {
    try {
      const d = await porIa(empresa, lead);
      if (d && (d.acao === 'agendar' || d.acao === 'remarcar') && d.quando && new Date(d.quando).getTime() > Date.now() - 3600 * 1000 && !(lead.agendamentos || []).some(ehAgendado)) {
        const r = tickets.registrarAgendamento(empresa, lead, { quando: d.quando, descricao: d.descricao, por: 'etiqueta' });
        if (r?.agendamento) {
          r.agendamento.detectadoPor = 'ia';
          if (d.trecho) r.agendamento.trecho = d.trecho;
          salvar();
          return r.agendamento;
        }
      }
    } catch (err) {
      console.error('[agenda] etiqueta:', err.message);
    }
  }
  if ((lead.agendamentos || []).some(ehAgendado)) return null; // a conversa marcou enquanto a IA lia
  const r = tickets.registrarAgendamento(empresa, lead, { quando: 'Data a combinar', descricao: '', por: 'etiqueta', semAviso: !aoVivo });
  require('./alertas').registrar(empresa, `agenda:${lead.id}`, `🏷️ ${lead.nome || 'Cliente'} recebeu a etiqueta Agendado no WhatsApp e entrou em Agendamentos (data a combinar — coloque o dia na conversa).`, { nivel: 'info', leadId: lead.id });
  return r?.agendamento || null;
}

function etiquetaTirada(empresa, lead) {
  const tickets = require('./tickets');
  for (const a of (lead.agendamentos || []).filter((x) => x.status === 'agendado' && x.por === 'etiqueta')) {
    tickets.cancelarAgendamento(lead, a.id, { por: 'equipe', motivo: 'tirou a etiqueta Agendado', empresa });
  }
}

// ---------------------------------------------------------------- entrada: cada mensagem nova
function observar(empresa, lead) {
  if (!empresa || !lead || empresa.agendaAutomatica === false) return;
  const ultimas = (lead.mensagens || []).filter((m) => m.texto && !m.apagada).slice(-3);
  const texto = semAcento(ultimas.map((m) => m.texto).join(' \n '));
  const temAtivo = (lead.agendamentos || []).some(ehAgendado);
  if (!PISTA_TEMPO.test(texto) && !(temAtivo && PISTA_CANCELA.test(texto)) && !ACEITE.test(semAcento(ultimas[ultimas.length - 1]?.texto || ''))) return;
  // código: na hora
  try {
    const d = porCodigo(empresa, lead);
    if (d) aplicar(empresa, lead, d);
  } catch (err) {
    console.error('[agenda] código:', err.message);
  }
  // IA só quando precisa:
  // - a IA que atende este cliente já marca/desmarca sozinha ([[AGENDAMENTO]] / [[DESMARCAR]]): não confere de novo
  // - sem confirmação perto do dia/hora (só falaram de horário), não há o que marcar
  if (require('./whatsapp').iaVaiResponder(empresa, lead)) return;
  if (require('./ia-desligada').motivo(empresa, lead)) return; // já comprou/agendou: sem gastar IA
  if (!CONFIRMA.test(semAcento(ultimas.slice(-2).map((m) => m.texto).join(' ')))) return;
  // IA: espera a conversa assentar (várias mensagens seguidas viram uma leitura só)
  clearTimeout(timers.get(lead.id));
  timers.set(lead.id, setTimeout(() => conferir(empresa.id, lead.id).catch((err) => console.error('[agenda] IA:', err.message)), ESPERA_MS));
  timers.get(lead.id).unref?.();
}

async function conferir(empresaId, leadId) {
  timers.delete(leadId);
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  const lead = estado.conversas.find((c) => c.id === leadId);
  if (!empresa || !lead) return null;
  const ultimaId = (lead.mensagens || []).filter((m) => m.texto).slice(-1)[0]?.id;
  if (ultimaId && lead.agendaConferidaAte === ultimaId) return null; // nada novo desde a última leitura
  const d = await porIa(empresa, lead);
  lead.agendaConferidaAte = ultimaId;
  salvar();
  return aplicar(empresa, lead, d);
}

// Ao subir: confere as conversas dos últimos 2 dias que falam de horário (pega o que ficou para trás)
function revisarRecentes() {
  const limite = Date.now() - 2 * 86400000;
  const lista = estado.conversas.filter((c) => new Date(c.atualizadoEm || 0).getTime() > limite && (c.mensagens || []).length);
  let i = 0;
  for (const lead of lista.slice(-40)) {
    const empresa = estado.empresas.find((e) => e.id === lead.empresaId);
    if (!empresa || empresa.agendaAutomatica === false || !require('./whatsapp').configurado(empresa)) continue;
    const texto = semAcento((lead.mensagens || []).filter((m) => m.texto).slice(-6).map((m) => m.texto).join(' '));
    if (!PISTA_TEMPO.test(texto) && !PISTA_CANCELA.test(texto)) continue;
    // só pelo código (sem IA): a cada deploy relia até 40 conversas com IA
    setTimeout(() => {
      try {
        const d = porCodigo(empresa, lead);
        if (d) aplicar(empresa, lead, d);
      } catch { /* só confere */ }
    }, 60000 + i++ * 500).unref?.();
  }
}

module.exports = { pelaEtiqueta, etiquetaTirada, ehEtiquetaAgendado, observar, conferir, aplicar, porCodigo, revisarRecentes, ACEITE };
