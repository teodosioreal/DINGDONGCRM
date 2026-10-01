// followup.js — FOLLOW-UP automático em passos, para qualquer nicho.
//
// Quando o cliente para de responder (a última mensagem é nossa), o CRM manda,
// em sequência, até 5 passos configuráveis (ex.: 1 dia, 3 dias, 7 dias). Cada
// passo pode ser escrito pela IA lendo AQUELA conversa (padrão) ou um texto fixo
// ({nome} vira o nome do cliente), e pode levar mídias da biblioteca.
//
// Para sozinho quando: o cliente responde (a sequência recomeça do zero na
// próxima vez que ele sumir), compra, vai para uma etapa de "fechado/perdido",
// pede uma pessoa, pediu SAIR, a equipe está atendendo (se escolhido) ou a IA
// já combinou um horário para retomar ([[RETOMAR]]). Só fala com quem está em
// Conversas, em horário comercial, e não dispara para conversa antiga ao ligar.

const { estado, salvar, novoId, agora } = require('./db');

const HORA = Number(process.env.FOLLOWUP_HORA_MS) || 3600 * 1000; // (testes encurtam a hora)
const JANELA_HORAS = 72; // passou do horário há mais que isso (ex.: CRM desligado): não manda atrasado
const POR_CICLO = 2;
const MAX_PASSOS = 5;

// Mensagens genéricas de reserva: saem se a IA falhar (sem chave, sem crédito, fora do ar)
const RESERVAS = [
  '{Oi|Olá} {nome}! Tudo bem? Passando para saber se ficou alguma dúvida. Posso te ajudar a agendar? 😊',
  '{nome}, ainda dá tempo de garantir o seu horário! Quer que eu veja as opções disponíveis para você?',
  '{Oi|Olá} {nome}, vou deixar nossa conversa por aqui para não incomodar. Quando quiser agendar, é só me chamar! 🙌'
];
const reservaPadrao = (i) => RESERVAS[Math.min(i, RESERVAS.length - 1)];

// Pré-configurado: 3 follow-ups, um a cada 48 h, escritos pela IA para cada conversa
const PADRAO = () => [
  { id: novoId('fup'), horas: 48, modo: 'ia', instrucao: 'Retome a conversa de forma leve: lembre do que o cliente queria, tire uma possível dúvida e convide para agendar com uma pergunta fácil de responder.', texto: '', reserva: RESERVAS[0], midias: [] },
  { id: novoId('fup'), horas: 48, modo: 'ia', instrucao: 'Traga um benefício, resultado ou prova (depoimento, garantia, trabalho feito) ligado ao que o cliente queria e convide de novo para agendar.', texto: '', reserva: RESERVAS[1], midias: [] },
  { id: novoId('fup'), horas: 48, modo: 'ia', instrucao: 'Última tentativa, bem educada: diga que vai deixar a conversa aberta e que, quando ele quiser agendar, é só chamar.', texto: '', reserva: RESERVAS[2], midias: [] }
];

// Quem já agendou não entra no follow-up (ticket de agendamento, etapa ou etiqueta "Agendado")
const sem = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function jaAgendou(empresa, lead) {
  if ((lead.agendamentos || []).some((a) => a.status !== 'cancelado')) return true;
  if (/agendad|marcad/.test(sem(lead.etapa))) return true;
  const nomes = new Map(require('./leads').etiquetasDa(empresa).map((t) => [t.id, sem(t.nome)]));
  return (lead.etiquetas || []).some((id) => /agendad/.test(nomes.get(id) || ''));
}

// Etiqueta "Indeciso": entra quando o follow-up começa, sai quando ele agenda ou compra
function etiquetaIndeciso(empresa, criar) {
  const lista = require('./leads').etiquetasDa(empresa);
  let t = lista.find((x) => sem(x.nome) === 'indeciso');
  if (!t && criar) {
    t = { id: novoId('tag'), nome: 'Indeciso', cor: '#f59e0b' };
    lista.push(t);
  }
  return t || null;
}

function configDa(empresa) {
  // já vem LIGADO e pré-configurado (dá para desligar); só pega conversas que pararem a partir de agora
  if (!empresa.followup) empresa.followup = { ativo: true, ativadoEm: agora(), passos: PADRAO(), incluirPausados: false, pararEtapas: null, etiquetaIndeciso: true, padraoV2: true };
  const f = empresa.followup;
  if (!Array.isArray(f.passos)) f.passos = PADRAO();
  if (!f.padraoV2) {
    // empresas que não mexeram no follow-up recebem o novo padrão (3 × 48 h, ligado)
    if (!f.editadoEm && !empresa.followupMigradoEm) {
      f.passos = PADRAO();
      if (!f.ativo) f.ativadoEm = agora();
      f.ativo = true;
    }
    f.passos.forEach((p, i) => { if (p.modo === 'ia' && !p.reserva) p.reserva = reservaPadrao(i); });
    if (f.etiquetaIndeciso === undefined) f.etiquetaIndeciso = true;
    f.padraoV2 = true;
    salvar();
  }
  if (!Array.isArray(f.pararEtapas)) {
    // padrão: para em etapas de fechado/perdido (pelo nome, serve para qualquer nicho)
    f.pararEtapas = require('./leads').etapasDa(empresa).filter((e) => /fechad|ganh|vendid|conclu|perdid|desist|cancel/i.test(e.normalize('NFD').replace(/[̀-ͯ]/g, '')));
  }
  return f;
}

const limpar = (v, n) => String(v ?? '').trim().slice(0, n);

// Salva a configuração vinda do painel
function salvarConfig(empresa, b = {}) {
  const f = configDa(empresa);
  if (b.ativo !== undefined) {
    if (b.ativo === true && !f.ativo) f.ativadoEm = agora(); // não dispara para conversa parada antes de ligar
    f.ativo = b.ativo === true;
  }
  // horário vale para o follow-up E as automações (um só, na Máquina de vendas)
  if (b.horarioComercial !== undefined) empresa.horarioAutomatico = b.horarioComercial !== false;
  if (b.incluirPausados !== undefined) f.incluirPausados = b.incluirPausados === true;
  if (b.etiquetaIndeciso !== undefined) f.etiquetaIndeciso = b.etiquetaIndeciso === true;
  if (Array.isArray(b.pararEtapas)) f.pararEtapas = b.pararEtapas.map((e) => limpar(e, 60)).filter(Boolean);
  if (Array.isArray(b.passos)) {
    const md = require('./midias');
    const codigos = new Set([...md.midiasDa(empresa), ...md.albunsDa(empresa), ...md.pastasDa(empresa)].map((m) => m.codigo).filter(Boolean));
    const passos = b.passos.slice(0, MAX_PASSOS).map((p) => ({
      id: p.id && String(p.id).startsWith('fup') ? String(p.id) : novoId('fup'),
      horas: Math.max(1, Math.min(24 * 60, Number(p.horas) || 24)),
      modo: p.modo === 'texto' ? 'texto' : 'ia',
      instrucao: limpar(p.instrucao, 500),
      texto: limpar(p.texto, 2000),
      reserva: limpar(p.reserva, 1000),
      midias: (Array.isArray(p.midias) ? p.midias : []).map((c) => limpar(c, 40)).filter((c) => codigos.has(c)).slice(0, 5)
    }));
    for (const p of passos) {
      if (p.modo === 'texto' && !p.texto) throw Object.assign(new Error('Passo com texto fixo precisa do texto da mensagem.'), { status: 400 });
    }
    f.passos = passos;
  }
  f.editadoEm = agora();
  salvar();
  return f;
}

// Situação do follow-up de UM cliente: qual passo vem e quando (ou por que não)
function situacao(empresa, lead, agoraMs = Date.now()) {
  const f = configDa(empresa);
  const leads = require('./leads');
  const whatsapp = require('./whatsapp');
  if (!f.ativo || !f.passos.length) return { motivo: 'desligado' };
  if (empresa.ativa === false || !whatsapp.configurado(empresa)) return { motivo: 'empresa sem WhatsApp' };
  if (!leads.iaPodeFalarCom(lead)) return { motivo: 'nunca conversou' };
  if (lead.historicoImportado) return { motivo: 'conversa antiga recuperada' };
  if (!whatsapp.liberadoNoModoTeste(empresa, lead)) return { motivo: 'modo teste' };
  if (lead.naoDisparar) return { motivo: 'pediu para não receber' };
  if (lead.precisaHumano) return { motivo: 'esperando a equipe' };
  if (lead.iaPausada && !f.incluirPausados) return { motivo: 'equipe atendendo' };
  if (f.pararEtapas.includes(lead.etapa)) return { motivo: `etapa ${lead.etapa}` };
  if ((lead.agendadas || []).some((a) => a.status === 'pendente')) return { motivo: 'já tem mensagem agendada' };
  if ((estado.vendas || []).some((v) => v.leadId === lead.id && v.status !== 'cancelada')) return { motivo: 'já comprou' };
  if (jaAgendou(empresa, lead)) return { motivo: 'já agendou' };
  const msgs = (lead.mensagens || []).filter((m) => (m.texto || m.anexo) && !m.apagada);
  const ultima = msgs[msgs.length - 1];
  if (!ultima || ultima.papel === 'visitante') return { motivo: 'cliente falou por último' };
  const ultimaDoCliente = [...msgs].reverse().find((m) => m.papel === 'visitante');
  if (!ultimaDoCliente) return { motivo: 'cliente nunca respondeu' };
  // a sequência recomeça quando o cliente responde
  const estadoLead = lead.followup && lead.followup.ciclo === ultimaDoCliente.em ? lead.followup : { ciclo: ultimaDoCliente.em, feitos: 0 };
  const passo = f.passos[estadoLead.feitos];
  if (!passo) return { motivo: 'sequência concluída', feitos: estadoLead.feitos };
  // não começa sequência para quem já estava parado antes de ligar o follow-up
  if (estadoLead.feitos === 0 && f.ativadoEm && ultima.em < f.ativadoEm) return { motivo: 'parado antes de ligar o follow-up' };
  // conta a partir da nossa última mensagem (o passo anterior também conta)
  let quandoMs = new Date(ultima.em).getTime() + passo.horas * HORA;
  if (agoraMs - quandoMs > JANELA_HORAS * HORA) return { motivo: 'antigo demais' };
  if (require('./automacoes').horarioAutomatico(empresa)) quandoMs = require('./automacoes').noHorarioComercial(quandoMs);
  return { motivo: null, passo, indice: estadoLead.feitos, quando: new Date(quandoMs).toISOString(), ciclo: ultimaDoCliente.em, pronto: quandoMs <= agoraMs };
}

// Para o cronômetro do painel
function proximo(empresa, lead) {
  const s = situacao(empresa, lead);
  if (s.motivo) return null;
  const n = configDa(empresa).passos.length;
  return { tipo: 'followup', id: s.passo.id, quando: s.quando, titulo: `Follow-up ${s.indice + 1} de ${n}`, detalhe: s.passo.modo === 'ia' ? 'a IA escreve na hora, lendo a conversa' : s.passo.texto.slice(0, 120), porIa: s.passo.modo === 'ia' };
}

async function enviar(empresa, lead, s) {
  const whatsapp = require('./whatsapp');
  const leads = require('./leads');
  const ia = require('./ia');
  const midias = require('./midias');
  const destino = lead.whatsappJid || whatsapp.destinoDoLead(lead);
  let texto = '';
  let pedidas = [];
  let reserva = false;
  if (s.passo.modo === 'texto') {
    texto = require('./disparos').montarMensagem(s.passo.texto, lead, empresa);
  } else {
    try {
      const bot = whatsapp.botDoWhatsapp(empresa);
      if (!bot) throw new Error('empresa sem assistente');
      const total = configDa(empresa).passos.length;
      const r = await ia.escreverMensagem(
        bot,
        empresa,
        lead.mensagens,
        `Follow-up ${s.indice + 1} de ${total}: o cliente parou de responder. ${s.passo.instrucao || 'Retome a conversa de forma leve.'} Leia a conversa inteira e fale do que ELE queria, sem repetir mensagens anteriores e sem pressionar. Mensagem curta.`,
        { etapas: leads.etapasDa(empresa), etapaAtual: lead.etapa, midias: midias.paraIa(empresa, { followup: true }), links: midias.linksDa(empresa), clone: require('./clone').paraIa(empresa, lead), tickets: require('./tickets').paraIa(lead) }
      );
      texto = r.texto;
      pedidas = r.midias || [];
      if (!texto) throw new Error('a IA não escreveu a mensagem');
    } catch (err) {
      // a IA falhou: vai a mensagem genérica de reserva (o cliente não fica sem o follow-up)
      texto = require('./disparos').montarMensagem(s.passo.reserva || reservaPadrao(s.indice), lead, empresa);
      pedidas = [];
      reserva = true;
      require('./alertas').registrar(empresa, 'automacao', `A IA não escreveu o follow-up ${s.indice + 1} para ${lead.nome || 'um cliente'} (${err.message}). Mandei a mensagem genérica de reserva.`, { nivel: 'aviso', leadId: lead.id });
    }
  }
  if (!texto && !s.passo.midias.length) throw new Error('mensagem vazia');
  if (texto) {
    await whatsapp.enviarTexto(empresa, destino, texto);
    leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto, followupPasso: s.indice + 1, ...(reserva ? { followupReserva: true } : {}) });
  }
  // mídias escolhidas para o passo (podem ser "a configurar": foram escolhidas à mão) + as que a IA pediu
  if (s.passo.midias.length) await whatsapp.enviarMidiasPedidas(empresa, lead, s.passo.midias, 'equipe', { papelMensagem: 'assistente' });
  if (pedidas.length) await whatsapp.enviarMidiasPedidas(empresa, lead, pedidas, 'assistente', { followup: true });
  lead.followup = { ciclo: s.ciclo, feitos: s.indice + 1, ultimoEm: agora() };
  if (configDa(empresa).etiquetaIndeciso !== false) {
    const t = etiquetaIndeciso(empresa, true);
    if (!(lead.etiquetas || []).includes(t.id)) lead.etiquetas = [...(lead.etiquetas || []), t.id];
  }
  lead.ultimaAutomacaoEm = agora(); // entra nos números da Máquina de vendas
  salvar();
}

// "Não enviar" na conversa: encerra a sequência deste cliente até ele responder de novo
function pular(empresa, lead, por = '') {
  const s = situacao(empresa, lead);
  if (s.motivo) return false;
  lead.followup = { ciclo: s.ciclo, feitos: MAX_PASSOS, puladoEm: agora(), puladoPor: por };
  salvar();
  return true;
}

// Chamado pelo ciclo das automações (a cada minuto)
const ocupados = new Set();
async function processar(empresa) {
  const f = configDa(empresa);
  if (!f.ativo || ocupados.has(empresa.id)) return 0;
  ocupados.add(empresa.id);
  let enviados = 0;
  try {
    const indeciso = etiquetaIndeciso(empresa, false);
    for (const lead of estado.conversas.filter((c) => c.empresaId === empresa.id)) {
      // agendou ou comprou: deixa de ser "Indeciso"
      if (indeciso && (lead.etiquetas || []).includes(indeciso.id) && (jaAgendou(empresa, lead) || (estado.vendas || []).some((v) => v.leadId === lead.id && v.status !== 'cancelada'))) {
        lead.etiquetas = lead.etiquetas.filter((t) => t !== indeciso.id);
        salvar();
      }
      if (enviados >= POR_CICLO) continue;
      const s = situacao(empresa, lead);
      if (s.motivo || !s.pronto) continue;
      try {
        await enviar(empresa, lead, s);
        enviados++;
      } catch (err) {
        // não fica tentando de novo sem parar: marca o passo como feito e avisa
        lead.followup = { ciclo: s.ciclo, feitos: s.indice + 1, ultimoEm: agora(), erro: String(err.message).slice(0, 200) };
        salvar();
        require('./alertas').registrar(empresa, 'automacao', `O follow-up ${s.indice + 1} não foi enviado para ${lead.nome || 'um cliente'}: ${err.message}`, { leadId: lead.id });
      }
    }
  } finally {
    ocupados.delete(empresa.id);
  }
  return enviados;
}

function paraPainel(empresa) {
  const f = configDa(empresa);
  const naFila = estado.conversas.filter((c) => c.empresaId === empresa.id).map((c) => ({ c, s: situacao(empresa, c) })).filter((x) => !x.s.motivo);
  return {
    ...f,
    horarioComercial: require('./automacoes').horarioAutomatico(empresa),
    naFila: naFila.length,
    proximos: naFila
      .sort((a, b) => (a.s.quando < b.s.quando ? -1 : 1))
      .slice(0, 20)
      .map(({ c, s }) => ({ leadId: c.id, nome: c.nome || c.telefone || 'Cliente', passo: s.indice + 1, quando: s.quando })),
    enviadosHoje: estado.conversas.filter((c) => c.empresaId === empresa.id).reduce((n, c) => n + (c.mensagens || []).filter((m) => m.followupPasso && m.em >= new Date().toISOString().slice(0, 10)).length, 0)
  };
}

module.exports = { jaAgendou, RESERVAS, configDa, salvarConfig, situacao, proximo, processar, paraPainel, pular, PADRAO };
