// followup.js — FOLLOW-UP automático SEM IA (não gasta token nenhum).
//
// A empresa cadastra SEQUÊNCIAS de mensagens prontas. Cada sequência tem:
//   - quando começa: o cliente parou de responder (padrão), recebeu uma etiqueta
//     do WhatsApp (ex.: "Achou caro") ou entrou numa etapa do funil;
//   - para quem: todos, ou só quem tem certas etiquetas / está em certas etapas;
//   - passos: depois de X horas/dias, manda uma das VARIAÇÕES de texto (sorteada;
//     {nome} e {Oi|Olá} funcionam) e/ou mídias da biblioteca, na ordem escolhida.
// Já vem uma sequência recomendada, ligada para todos os leads. Dá para desligar
// tudo, uma sequência, ou o follow-up de UM cliente (lead.followupDesligado).
//
// Para sozinho quando o cliente responde (a sequência recomeça quando ele sumir de
// novo), compra, agenda, pede uma pessoa, pede para sair, está na lista negra ou
// numa etapa de fechado/perdido. Só em horário comercial (se ligado) e nunca
// manda atrasado para conversa antiga.

const { estado, salvar, novoId, agora } = require('./db');

const HORA = Number(process.env.FOLLOWUP_HORA_MS) || 3600 * 1000; // (testes encurtam a hora)
const JANELA_HORAS = 72; // passou do horário há mais que isso (ex.: CRM desligado): não manda atrasado
const POR_CICLO = 3;
const MAX_PASSOS = 10;
const MAX_SEQUENCIAS = 10;
const MAX_VARIACOES = 6;
const FEITO = 999; // sequência encerrada para este ciclo ("Não enviar")

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limpar = (v, n) => String(v ?? '').trim().slice(0, n);

// Recomendado (serve para qualquer ramo): 3 mensagens com variações, 1, 3 e 7 dias
const RECOMENDADO = () => [
  {
    id: novoId('fup'),
    horas: 24,
    textos: [
      '{Oi|Olá} {nome}! Tudo bem? Passando para saber se ficou alguma dúvida. Posso te ajudar? 😊',
      '{nome}, conseguiu ver as informações que te mandei? Qualquer dúvida é só me chamar!',
      '{Oi|Olá} {nome}! Ficou alguma dúvida? Estou por aqui para te ajudar 🙂'
    ],
    midias: [],
    midiaPrimeiro: false
  },
  {
    id: novoId('fup'),
    horas: 72,
    textos: [
      '{nome}, ainda dá tempo! Quer que eu veja um horário ou uma condição especial para você?',
      '{Oi|Olá} {nome}! Muita gente fecha depois de tirar uma dúvida rápida — quer que eu te explique melhor?'
    ],
    midias: [],
    midiaPrimeiro: false
  },
  {
    id: novoId('fup'),
    horas: 168,
    textos: [
      '{Oi|Olá} {nome}, vou deixar nossa conversa por aqui para não incomodar. Quando quiser, é só me chamar! 🙌',
      '{nome}, fico à disposição! Quando for o momento, me chama aqui. 😉'
    ],
    midias: [],
    midiaPrimeiro: false
  }
];

function sequenciaPadrao(passos = RECOMENDADO()) {
  return { id: 'seq_padrao', nome: 'Recomendado — quem parou de responder', ativa: true, ativadaEm: agora(), inicio: { tipo: 'sem_resposta' }, soEtiquetas: [], soEtapas: [], pararAoResponder: true, passos };
}

// mensagens de reserva que vinham prontas na versão com IA (não foram escritas pela empresa)
const RESERVAS_ANTIGAS = [
  '{Oi|Olá} {nome}! Tudo bem? Passando para saber se ficou alguma dúvida. Posso te ajudar a agendar? 😊',
  '{nome}, ainda dá tempo de garantir o seu horário! Quer que eu veja as opções disponíveis para você?',
  '{Oi|Olá} {nome}, vou deixar nossa conversa por aqui para não incomodar. Quando quiser agendar, é só me chamar! 🙌'
];

// Passo antigo (com IA) → passo sem IA: o texto fixo, a reserva que a empresa escreveu ou as variações recomendadas
function converterPasso(p, i) {
  const rec = RECOMENDADO();
  const reservaPropria = p.reserva && !RESERVAS_ANTIGAS.includes(p.reserva);
  const textos = Array.isArray(p.textos) ? p.textos : p.modo === 'texto' && p.texto ? [p.texto] : reservaPropria ? [p.reserva] : rec[Math.min(i, rec.length - 1)].textos;
  return { id: p.id || novoId('fup'), horas: Number(p.horas) || 24, textos: textos.map((t) => limpar(t, 2000)).filter(Boolean), midias: Array.isArray(p.midias) ? p.midias : [], midiaPrimeiro: p.midiaPrimeiro === true };
}

// Quem já agendou não entra no follow-up de "parou de responder"
// Sequência feita para quem agendou (ex.: lembrete do horário): começa pela etiqueta/etapa de agendamento
function ehPosAgendamento(empresa, seq) {
  const nomes = new Map(require('./leads').etiquetasDa(empresa).map((t) => [t.id, sem(t.nome)]));
  if (seq.inicio?.tipo === 'etiqueta' && /agendad/.test(nomes.get(seq.inicio.etiqueta) || '')) return true;
  if (seq.inicio?.tipo === 'etapa' && /agendou|agendad|marcad/.test(sem(seq.inicio.etapa))) return true;
  return false;
}

function jaAgendou(empresa, lead) {
  if ((lead.agendamentos || []).some((a) => a.status === 'agendado')) return true;
  if (/agendou|agendad|marcad/.test(sem(lead.etapa))) return true;
  const nomes = new Map(require('./leads').etiquetasDa(empresa).map((t) => [t.id, sem(t.nome)]));
  return (lead.etiquetas || []).some((id) => /agendad/.test(nomes.get(id) || ''));
}

// Etiqueta "Indeciso": entra quando o follow-up começa, sai quando ele agenda ou compra.
// Só se existir no WhatsApp Business (o CRM não cria etiqueta própria).
function etiquetaIndeciso(empresa) {
  return require('./leads').etiquetasDa(empresa).find((x) => sem(x.nome) === 'indeciso') || null;
}

function configDa(empresa) {
  // já vem LIGADO e com a sequência recomendada (dá para desligar)
  if (!empresa.followup) empresa.followup = { ativo: true, ativadoEm: agora(), incluirPausados: true, pararEtapas: null, etiquetaIndeciso: true, semIa: true, sequencias: [sequenciaPadrao()] };
  const f = empresa.followup;
  let mudou = false;
  if (!f.etiquetasDesdeInicio) { f.etiquetasDesdeInicio = agora(); mudou = true; } // a partir daqui o CRM anota quando cada etiqueta entra
  // versão antiga (passos escritos pela IA): vira sequência sem IA
  if (!f.semIa || Array.isArray(f.passos)) {
    const antigos = Array.isArray(f.passos) ? f.passos : [];
    const passos = antigos.length && f.editadoEm ? antigos.map(converterPasso).filter((p) => p.textos.length || p.midias.length) : RECOMENDADO();
    const atual = Array.isArray(f.sequencias) ? f.sequencias : [];
    const padrao = atual.find((s) => s.id === 'seq_padrao');
    if (padrao) padrao.passos = passos.length ? passos : RECOMENDADO();
    else atual.unshift(sequenciaPadrao(passos.length ? passos : RECOMENDADO()));
    f.sequencias = atual;
    delete f.passos;
    if (!f.semIa) f.incluirPausados = true; // agora vale para todos os leads (dá para desligar por cliente)
    f.semIa = true;
    mudou = true;
  }
  if (!Array.isArray(f.sequencias)) { f.sequencias = [sequenciaPadrao()]; mudou = true; }
  for (const s of f.sequencias) {
    if (!s.inicio) s.inicio = { tipo: 'sem_resposta' };
    if (!Array.isArray(s.passos)) s.passos = [];
    if (!s.ativadaEm) s.ativadaEm = f.ativadoEm || agora();
  }
  if (!Array.isArray(f.pararEtapas)) {
    // padrão: para em etapas de fechado/perdido (pelo nome, serve para qualquer nicho)
    f.pararEtapas = require('./leads').etapasDa(empresa).filter((e) => /fechad|ganh|vendi|conclu|perdid|desist|cancel|nao fech/i.test(sem(e)));
    mudou = true;
  }
  if (mudou) salvar();
  return f;
}

// Salva a configuração vinda do painel
function salvarConfig(empresa, b = {}) {
  const f = configDa(empresa);
  const leads = require('./leads');
  if (b.ativo !== undefined) {
    if (b.ativo === true && !f.ativo) f.ativadoEm = agora(); // não dispara para conversa parada antes de ligar
    f.ativo = b.ativo === true;
  }
  // horário vale para o follow-up E as automações (um só, na Máquina de vendas)
  if (b.horarioComercial !== undefined) empresa.horarioAutomatico = b.horarioComercial !== false;
  if (b.incluirPausados !== undefined) f.incluirPausados = b.incluirPausados === true;
  if (b.etiquetaIndeciso !== undefined) f.etiquetaIndeciso = b.etiquetaIndeciso === true;
  if (Array.isArray(b.pararEtapas)) f.pararEtapas = b.pararEtapas.map((e) => limpar(e, 60)).filter(Boolean);
  // formato antigo (só "passos"): vira a sequência recomendada
  if (Array.isArray(b.passos) && !Array.isArray(b.sequencias)) {
    b.sequencias = f.sequencias.map((s) => (s.id === 'seq_padrao' ? { ...s, passos: b.passos.map((p, i) => ({ ...p, textos: Array.isArray(p.textos) ? p.textos : [p.modo === 'texto' ? p.texto : p.reserva || ''] })) } : s));
    if (!b.sequencias.some((s) => s.id === 'seq_padrao')) b.sequencias.unshift({ ...sequenciaPadrao(), passos: b.passos.map((p) => ({ ...p, textos: [p.texto || p.reserva || ''] })) });
  }
  if (Array.isArray(b.sequencias)) {
    const md = require('./midias');
    const codigos = new Set([...md.midiasDa(empresa), ...md.albunsDa(empresa), ...md.pastasDa(empresa)].map((m) => m.codigo).filter(Boolean));
    const etiquetas = new Set(leads.etiquetasDa(empresa).map((t) => t.id));
    const etapas = new Set(leads.etapasDa(empresa));
    const antigas = new Map(f.sequencias.map((s) => [s.id, s]));
    f.sequencias = b.sequencias.slice(0, MAX_SEQUENCIAS).map((s, si) => {
      const antiga = antigas.get(s.id);
      const tipo = ['sem_resposta', 'etiqueta', 'etapa'].includes(s.inicio?.tipo) ? s.inicio.tipo : 'sem_resposta';
      const inicio = { tipo };
      if (tipo === 'etiqueta') {
        inicio.etiqueta = etiquetas.has(s.inicio?.etiqueta) ? s.inicio.etiqueta : '';
        if (!inicio.etiqueta) throw Object.assign(new Error(`Sequência ${si + 1}: escolha a etiqueta que começa a sequência.`), { status: 400 });
      }
      if (tipo === 'etapa') {
        inicio.etapa = etapas.has(s.inicio?.etapa) ? s.inicio.etapa : '';
        if (!inicio.etapa) throw Object.assign(new Error(`Sequência ${si + 1}: escolha a etapa que começa a sequência.`), { status: 400 });
      }
      const ativa = s.ativa !== false;
      const passos = (Array.isArray(s.passos) ? s.passos : []).slice(0, MAX_PASSOS).map((p) => ({
        id: p.id && String(p.id).startsWith('fup') ? String(p.id) : novoId('fup'),
        horas: Math.max(1, Math.min(24 * 90, Math.round(Number(p.horas) || 24))),
        textos: (Array.isArray(p.textos) ? p.textos : [p.texto]).map((t) => limpar(t, 2000)).filter(Boolean).slice(0, MAX_VARIACOES),
        midias: (Array.isArray(p.midias) ? p.midias : []).map((c) => limpar(c, 40)).filter((c) => codigos.has(c)).slice(0, 5),
        midiaPrimeiro: p.midiaPrimeiro === true
      }));
      passos.forEach((p, i) => {
        if (!p.textos.length && !p.midias.length) throw Object.assign(new Error(`Sequência ${si + 1}, passo ${i + 1}: escreva pelo menos um texto ou escolha uma mídia.`), { status: 400 });
      });
      return {
        id: antiga ? antiga.id : s.id === 'seq_padrao' ? 'seq_padrao' : novoId('seq'),
        nome: limpar(s.nome, 60) || `Sequência ${si + 1}`,
        ativa,
        // ligou agora: só vale para quem parar/receber a etiqueta/entrar na etapa a partir de agora
        ativadaEm: ativa && (!antiga || !antiga.ativa) ? agora() : antiga?.ativadaEm || agora(),
        inicio,
        soEtiquetas: (Array.isArray(s.soEtiquetas) ? s.soEtiquetas : []).filter((id) => etiquetas.has(id)),
        soEtapas: (Array.isArray(s.soEtapas) ? s.soEtapas : []).filter((e) => etapas.has(e)),
        pararAoResponder: s.pararAoResponder !== false,
        passos
      };
    });
  }
  f.editadoEm = agora();
  salvar();
  return f;
}

// ---------------------------------------------------------------- quando cada etiqueta entrou no lead
// Guarda a hora em que o cliente recebeu cada etiqueta (para "X dias depois de cair em tal etiqueta").
// Etiquetas que já estavam lá antes de o CRM começar a anotar ficam com hora "antiga" (não disparam).
function anotarEtiquetas(lead, inicio = '') {
  const atuais = lead.etiquetas || [];
  // cliente que já existia antes de o CRM começar a anotar: as etiquetas dele são "antigas"
  const primeira = !lead.etiquetasDesde && (!inicio || String(lead.criadoEm || '') < inicio);
  const d = lead.etiquetasDesde || {};
  let mudou = primeira;
  for (const id of atuais) if (!d[id]) { d[id] = primeira ? '1970-01-01T00:00:00.000Z' : agora(); mudou = true; }
  for (const id of Object.keys(d)) if (!atuais.includes(id)) { delete d[id]; mudou = true; }
  lead.etiquetasDesde = d;
  return mudou;
}

function entrouNaEtapa(lead, etapa) {
  if (lead.etapa !== etapa) return null;
  const h = [...(lead.etapaHistorico || [])].reverse().find((x) => x.para === etapa);
  return h?.em || null;
}

// ---------------------------------------------------------------- situação de UM cliente
function motivoGeral(empresa, lead, f) {
  const leads = require('./leads');
  const whatsapp = require('./whatsapp');
  if (!f.ativo) return 'desligado';
  if (empresa.ativa === false || !whatsapp.configurado(empresa)) return 'empresa sem WhatsApp';
  if (lead.followupDesligado) return 'follow-up desligado para este cliente';
  if (!leads.iaPodeFalarCom(lead)) return 'nunca conversou';
  const manual = Boolean(lead.followupManual) || f.paraManual === true;
  if (lead.historicoImportado && !manual) return 'conversa antiga recuperada';
  if (!whatsapp.liberadoNoModoTeste(empresa, lead)) return 'modo teste';
  if (lead.naoDisparar) return 'pediu para não receber';
  if (leads.naListaNegra?.(empresa, lead)) return 'lista negra';
  if (lead.precisaHumano && !manual) return 'esperando a equipe';
  if (whatsapp.iaOcupadaCom(lead.id)) return 'a IA está respondendo agora';
  if (lead.iaPausada && !f.incluirPausados && !manual) return 'equipe atendendo';
  // mensagem agendada pela EQUIPE ainda vai sair: não junta com o follow-up. (O follow-up
  // que a IA combinou sozinha é trocado pela sequência quando o cliente é colocado à mão.)
  const pendentes = (lead.agendadas || []).filter((a) => a.status === 'pendente' && !(manual && a.criadoPor === 'IA'));
  if (pendentes.length) return 'já tem mensagem agendada pela equipe (cancele na conversa para usar o follow-up)';
  return null;
}

function estadoDe(lead, seq) {
  const todos = lead.followups || {};
  // clientes que já estavam no follow-up antigo continuam de onde pararam
  if (!todos[seq.id] && seq.id === 'seq_padrao' && lead.followup?.ciclo) return { ...lead.followup };
  return todos[seq.id] || null;
}

// Uma sequência para um cliente: qual passo vem e quando (ou por que não)
function situacaoNa(empresa, lead, seq, f, agoraMs) {
  if (!seq.ativa) return { motivo: 'sequência desligada' };
  // já comprou (venda no CRM, venda à mão, etiqueta de venda do WhatsApp ou etapa de venda):
  // não recebe follow-up nenhum, nem o de pós-venda (avaliação e comentário são automações)
  const venda = require('./comprovantes').jaVendeu(empresa, lead);
  if (venda) return { motivo: `já comprou (${venda.por})` };
  if (require('./entre-empresas').leadDeOutraEmpresa(empresa, lead)) return { motivo: 'é o número de outra empresa do CRM' };
  if (!seq.passos.length) return { motivo: 'sequência sem passos' };
  // agendou: a sequência é cancelada. Só com "IA atende quem agendou" ligado as sequências
  // feitas para quem agendou (ex.: lembrete) continuam
  if (jaAgendou(empresa, lead) && !(ehPosAgendamento(empresa, seq) && require('./ia-desligada').iaComAgendados(empresa))) return { motivo: 'já agendou' };
  // colocado na fila à mão (painel → Follow-up): conta a partir de quando entrou na fila
  const manual = lead.followupManual?.seqId === seq.id ? lead.followupManual : null;
  if (!manual && seq.soEtiquetas?.length && !(lead.etiquetas || []).some((id) => seq.soEtiquetas.includes(id))) return { motivo: 'fora das etiquetas da sequência' };
  if (!manual && seq.soEtapas?.length && !seq.soEtapas.includes(lead.etapa)) return { motivo: 'fora das etapas da sequência' };
  const msgs = (lead.mensagens || []).filter((m) => (m.texto || m.anexo) && !m.apagada);
  const ultima = msgs[msgs.length - 1];
  const ultimaDoCliente = [...msgs].reverse().find((m) => m.papel === 'visitante');
  let ciclo;
  let base; // a partir de quando conta o passo 1
  if (manual) {
    ciclo = `manual:${manual.desde}`;
    // "mandar a 1ª já": o passo 1 vence na hora em que entrou na fila
    base = manual.jaPrimeira ? new Date(new Date(manual.desde).getTime() - (seq.passos[0]?.horas || 0) * HORA).toISOString() : manual.desde;
  } else if (seq.inicio.tipo === 'sem_resposta') {
    if (f.pararEtapas.includes(lead.etapa)) return { motivo: `etapa ${lead.etapa}` };
    if (!ultima || ultima.papel === 'visitante') return { motivo: 'cliente falou por último' };
    if (!ultimaDoCliente) return { motivo: 'cliente nunca respondeu' };
    ciclo = ultimaDoCliente.em;
    base = ultima.em;
    const st0 = estadoDe(lead, seq);
    if ((!st0 || st0.ciclo !== ciclo) && f.ativadoEm && ultima.em < f.ativadoEm) return { motivo: 'parado antes de ligar o follow-up' };
    if ((!st0 || st0.ciclo !== ciclo) && seq.ativadaEm && ultima.em < seq.ativadaEm) return { motivo: 'parado antes de ligar a sequência' };
  } else {
    const desde = seq.inicio.tipo === 'etiqueta' ? lead.etiquetasDesde?.[seq.inicio.etiqueta] : entrouNaEtapa(lead, seq.inicio.etapa);
    if (!desde) return { motivo: seq.inicio.tipo === 'etiqueta' ? 'não tem a etiqueta' : 'não está na etapa' };
    if (desde < (seq.ativadaEm || '')) return { motivo: 'entrou antes de ligar a sequência' };
    ciclo = `${seq.inicio.tipo}:${desde}`;
    base = desde;
  }
  const st = estadoDe(lead, seq);
  const atual = st && st.ciclo === ciclo ? st : { ciclo, feitos: 0 };
  const passo = seq.passos[atual.feitos];
  if (!passo) return { motivo: atual.feitos >= FEITO ? 'encerrado ("Não enviar")' : 'sequência concluída', feitos: atual.feitos };
  // cada passo conta a partir do anterior (o passo 1, do início da sequência)
  const desdeIso = atual.feitos ? atual.ultimoEm || base : base;
  if ((manual || seq.inicio.tipo !== 'sem_resposta') && seq.pararAoResponder !== false && ultima?.papel === 'visitante' && ultima.em > (manual ? manual.desde : desdeIso)) return { motivo: 'cliente respondeu' };
  let quandoMs = new Date(desdeIso).getTime() + passo.horas * HORA;
  if (agoraMs - quandoMs > JANELA_HORAS * HORA) return { motivo: 'antigo demais' };
  const auto = require('./automacoes');
  if (auto.horarioAutomatico(empresa)) quandoMs = auto.noHorarioComercial(quandoMs);
  return { motivo: null, seq, passo, indice: atual.feitos, quando: new Date(quandoMs).toISOString(), ciclo, pronto: quandoMs <= agoraMs };
}

// A próxima mensagem de follow-up deste cliente (a sequência que vence primeiro)
function situacao(empresa, lead, agoraMs = Date.now()) {
  const f = configDa(empresa);
  const geral = motivoGeral(empresa, lead, f);
  if (geral) return { motivo: geral };
  let melhor = null;
  let motivo = 'nenhuma sequência vale para este cliente';
  // na fila à mão: só a sequência escolhida (enquanto ela não terminar)
  const seqManual = lead.followupManual && f.sequencias.find((q) => q.id === lead.followupManual.seqId);
  if (seqManual) {
    const s = situacaoNa(empresa, lead, seqManual, f, agoraMs);
    if (!s.motivo) return { ...s, manual: true };
    if (/já comprou|já agendou/.test(s.motivo)) return s;
  }
  for (const seq of f.sequencias) {
    if (seq === seqManual) continue;
    const s = situacaoNa(empresa, lead, seq, f, agoraMs);
    if (s.motivo) {
      if (f.sequencias.length === 1) motivo = s.motivo;
      continue;
    }
    if (!melhor || s.quando < melhor.quando) melhor = s;
  }
  return melhor || { motivo };
}

// Para o cronômetro do painel
function proximo(empresa, lead) {
  const s = situacao(empresa, lead);
  if (s.motivo) return null;
  const n = s.seq.passos.length;
  const p = s.passo;
  const detalhe = [p.textos[0] ? p.textos[0].slice(0, 120) + (p.textos.length > 1 ? ` (+${p.textos.length - 1} variação${p.textos.length > 2 ? 'ões' : ''})` : '') : '', p.midias.length ? `🖼️ ${p.midias.length} mídia(s)` : ''].filter(Boolean).join(' · ');
  return { tipo: 'followup', id: p.id, quando: s.quando, titulo: `Follow-up ${s.indice + 1} de ${n}${configDa(empresa).sequencias.length > 1 ? ` · ${s.seq.nome}` : ''}`, detalhe, porIa: false };
}

async function enviar(empresa, lead, s) {
  const whatsapp = require('./whatsapp');
  const leads = require('./leads');
  const destino = lead.whatsappJid || whatsapp.destinoDoLead(lead);
  const p = s.passo;
  // sorteia uma das variações (evita repetir a que este cliente recebeu por último)
  const ultimaVar = lead.followups?.[s.seq.id]?.variacao;
  const opcoes = p.textos.map((_, i) => i).filter((i) => p.textos.length === 1 || i !== ultimaVar);
  const variacao = p.textos.length ? opcoes[Math.floor(Math.random() * opcoes.length)] : null;
  const texto = variacao !== null ? require('./disparos').montarMensagem(p.textos[variacao], lead, empresa) : '';
  if (!texto && !p.midias.length) throw new Error('mensagem vazia');
  const mandarTexto = async () => {
    if (!texto) return;
    await whatsapp.enviarTexto(empresa, destino, texto);
    leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto, followupPasso: s.indice + 1, followupSequencia: s.seq.id });
  };
  const mandarMidias = async () => {
    if (p.midias.length) await whatsapp.enviarMidiasPedidas(empresa, lead, p.midias, 'equipe', { papelMensagem: 'assistente' });
  };
  if (p.midiaPrimeiro) {
    await mandarMidias();
    await mandarTexto();
  } else {
    await mandarTexto();
    await mandarMidias();
  }
  lead.followups = lead.followups || {};
  lead.followups[s.seq.id] = { ciclo: s.ciclo, feitos: s.indice + 1, ultimoEm: agora(), variacao };
  if (s.seq.id === 'seq_padrao') delete lead.followup; // estado antigo já migrado
  if (configDa(empresa).etiquetaIndeciso !== false && s.seq.inicio.tipo === 'sem_resposta') {
    const t = etiquetaIndeciso(empresa);
    if (t && !(lead.etiquetas || []).includes(t.id)) lead.etiquetas = [...(lead.etiquetas || []), t.id];
  }
  lead.ultimaAutomacaoEm = agora(); // entra nos números da Máquina de vendas
  salvar();
}

// "Não enviar" na conversa: encerra a sequência deste cliente até ele responder de novo
function pular(empresa, lead, por = '') {
  const s = situacao(empresa, lead);
  if (s.motivo) return false;
  lead.followups = lead.followups || {};
  lead.followups[s.seq.id] = { ciclo: s.ciclo, feitos: FEITO, puladoEm: agora(), puladoPor: por };
  salvar();
  return true;
}

// ---------------------------------------------------------------- fila (painel → Follow-up)
const nomeDo = (c) => c.nome || (c.telefone ? `+${c.telefone}` : 'Cliente');

// Todos os clientes na fila (com quando sai a próxima mensagem) e os desativados
function fila(empresa) {
  const conversas = estado.conversas.filter((c) => c.empresaId === empresa.id);
  const naFila = conversas
    .map((c) => ({ c, s: situacao(empresa, c) }))
    .filter((x) => !x.s.motivo)
    .sort((a, b) => (a.s.quando < b.s.quando ? -1 : 1))
    .slice(0, 500)
    .map(({ c, s }) => ({ leadId: c.id, nome: nomeDo(c), telefone: c.telefone || '', seqId: s.seq.id, sequencia: s.seq.nome, passo: s.indice + 1, total: s.seq.passos.length, quando: s.quando, manual: Boolean(s.manual), etapa: c.etapa || '' }));
  const desligados = conversas.filter((c) => c.followupDesligado).map((c) => ({ leadId: c.id, nome: nomeDo(c), telefone: c.telefone || '', em: c.followupDesligadoEm || '' }));
  return { naFila, desligados };
}

// Busca de clientes para colocar na fila à mão (com o motivo de quem não pode entrar)
const soDigitos = (t) => String(t || '').replace(/\D/g, '');
// número completo para comparar: com 55 e sem o 9 depois do DDD (o WhatsApp usa os dois jeitos)
function numeroComparavel(n) {
  let d = soDigitos(n);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (/^55\d{2}9\d{8}$/.test(d)) d = d.slice(0, 4) + d.slice(5);
  return d;
}
function numeroDaConversa(c) {
  const doJid = /@s\.whatsapp\.net$/.test(c.whatsappJid || '') ? c.whatsappJid.split('@')[0] : '';
  return soDigitos(c.telefone) || soDigitos(doJid);
}

// Clientes para colocar na fila à mão: busca por nome ou número com DDD; sem busca,
// as conversas mais recentes. Mostra o motivo de quem não pode entrar.
function buscar(empresa, q) {
  const texto = String(q || '').trim();
  const digitos = soDigitos(texto);
  const ehNumero = digitos.length >= 3 && digitos.length >= texto.replace(/[\s()+-]/g, '').length;
  const alvo = ehNumero ? '' : sem(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const alvoNum = ehNumero && digitos.length >= 10 ? numeroComparavel(digitos) : '';
  const f = configDa(empresa);
  const bate = (c) => {
    if (!texto) return true;
    if (alvo) return sem(c.nome).includes(alvo) || sem(c.nome).replace(/[^a-z0-9 ]/g, ' ').includes(alvo);
    const n = numeroDaConversa(c);
    if (!n) return false;
    return alvoNum ? numeroComparavel(n) === alvoNum : n.includes(digitos) || numeroComparavel(n).includes(digitos);
  };
  return estado.conversas
    .filter((c) => c.empresaId === empresa.id && !c.arquivado && (c.mensagens || []).some((m) => m.papel === 'visitante') && bate(c))
    .sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')))
    .slice(0, texto ? 30 : 40)
    .map((c) => {
      const venda = require('./comprovantes').jaVendeu(empresa, c);
      const geral = motivoGeral(empresa, c, { ...f, ativo: true, paraManual: true });
      const agendou = jaAgendou(empresa, c);
      const s = situacao(empresa, c);
      const bloqueio = venda ? `já comprou (${venda.por})` : agendou ? 'já agendou' : geral && geral !== 'follow-up desligado para este cliente' ? geral : '';
      const ultima = [...(c.mensagens || [])].reverse().find((m) => !m.apagada && m.texto);
      return { leadId: c.id, nome: nomeDo(c), telefone: c.telefone || '', escondido: !numeroDaConversa(c), etapa: c.etapa || '', atualizadoEm: c.atualizadoEm || '', ultima: String(ultima?.texto || '').slice(0, 60), naFila: !s.motivo, sequencia: s.seq?.nome || '', desligado: Boolean(c.followupDesligado), bloqueio };
    });
}

// Coloca um cliente na fila de uma sequência, à mão (religa o follow-up dele se estava desligado)
function colocarNaFila(empresa, lead, seqId, { jaPrimeira = false, por = '' } = {}) {
  const f = configDa(empresa);
  const seq = f.sequencias.find((q) => q.id === seqId);
  const erro = (m) => Object.assign(new Error(m), { status: 400 });
  if (!seq) throw erro('Escolha uma sequência.');
  if (!seq.ativa) throw erro(`A sequência "${seq.nome}" está desligada. Ligue ela primeiro.`);
  if (!seq.passos.length) throw erro('Essa sequência não tem mensagens.');
  const venda = require('./comprovantes').jaVendeu(empresa, lead);
  if (venda) throw erro(`Este cliente já comprou (${venda.por}): follow-up não vai para quem comprou.`);
  if (jaAgendou(empresa, lead) && !(ehPosAgendamento(empresa, seq) && require('./ia-desligada').iaComAgendados(empresa))) throw erro('Este cliente já agendou: o follow-up não vai para quem agendou.');
  const geral = motivoGeral(empresa, lead, { ...f, ativo: true, paraManual: true });
  if (geral && geral !== 'follow-up desligado para este cliente') throw erro(`Não dá para colocar na fila: ${geral}.`);
  const antes = { desligado: lead.followupDesligado, desligadoEm: lead.followupDesligadoEm, manual: lead.followupManual };
  delete lead.followupDesligado;
  delete lead.followupDesligadoEm;
  lead.followupManual = { seqId: seq.id, desde: agora(), por, jaPrimeira: jaPrimeira === true };
  const s = situacao(empresa, lead);
  if (s.motivo) {
    // não entrou de verdade: desfaz e diz o porquê (em vez de dizer que deu certo)
    if (antes.desligado) lead.followupDesligado = antes.desligado;
    if (antes.desligadoEm) lead.followupDesligadoEm = antes.desligadoEm;
    if (antes.manual) lead.followupManual = antes.manual;
    else delete lead.followupManual;
    throw erro(`Não entrou na fila: ${s.motivo}${f.ativo ? '' : ' — ligue o follow-up no topo da página'}.`);
  }
  // o follow-up que a IA tinha combinado sozinha é trocado pela sequência escolhida
  for (const a of lead.agendadas || []) if (a.status === 'pendente' && a.criadoPor === 'IA') Object.assign(a, { status: 'cancelada', motivo: 'trocado pelo follow-up colocado à mão' });
  salvar();
  return s;
}

// Liga/desliga o follow-up de UM cliente
function ligarParaLead(lead, ligado) {
  if (ligado) {
    delete lead.followupDesligado;
    delete lead.followupDesligadoEm;
  } else {
    lead.followupDesligado = true;
    lead.followupDesligadoEm = agora();
    delete lead.followupManual;
  }
  salvar();
}

// Chamado pelo ciclo das automações (a cada minuto)
const ocupados = new Set();
async function processar(empresa) {
  const f = configDa(empresa);
  if (ocupados.has(empresa.id)) return 0;
  ocupados.add(empresa.id);
  let enviados = 0;
  try {
    const indeciso = etiquetaIndeciso(empresa);
    let mudou = false;
    for (const lead of estado.conversas.filter((c) => c.empresaId === empresa.id)) {
      if (anotarEtiquetas(lead, f.etiquetasDesdeInicio)) mudou = true;
      // agendou ou comprou: deixa de ser "Indeciso"
      if (indeciso && (lead.etiquetas || []).includes(indeciso.id) && (jaAgendou(empresa, lead) || (estado.vendas || []).some((v) => v.leadId === lead.id && v.status !== 'cancelada'))) {
        lead.etiquetas = lead.etiquetas.filter((t) => t !== indeciso.id);
        mudou = true;
      }
      if (lead.followupManual) {
        const seqM = f.sequencias.find((q) => q.id === lead.followupManual.seqId);
        const fim = seqM ? situacaoNa(empresa, lead, seqM, f, Date.now()).motivo : 'sequência apagada';
        // terminou de vez (agendou, comprou, respondeu, acabou ou foi tirado): sai do modo "à mão"
        if (!seqM || (fim && /agendou|comprou|respondeu|concluída|encerrado|desligada|antigo demais/.test(fim))) {
          lead.followupManual = { ...lead.followupManual, canceladoEm: agora(), motivo: fim };
          lead.followupManualCancelado = lead.followupManual;
          delete lead.followupManual;
          mudou = true;
        }
      }
      if (!f.ativo || enviados >= POR_CICLO) continue;
      const s = situacao(empresa, lead);
      if (s.motivo || !s.pronto) continue;
      try {
        await enviar(empresa, lead, s);
        enviados++;
      } catch (err) {
        // não fica tentando de novo sem parar: marca o passo como feito e avisa
        lead.followups = lead.followups || {};
        lead.followups[s.seq.id] = { ciclo: s.ciclo, feitos: s.indice + 1, ultimoEm: agora(), erro: String(err.message).slice(0, 200) };
        salvar();
        require('./alertas').registrar(empresa, 'automacao', `O follow-up ${s.indice + 1} ("${s.seq.nome}") não foi enviado para ${lead.nome || 'um cliente'}: ${err.message}`, { leadId: lead.id });
      }
    }
    if (mudou) salvar();
  } finally {
    ocupados.delete(empresa.id);
  }
  return enviados;
}

function paraPainel(empresa) {
  const f = configDa(empresa);
  const naFila = estado.conversas.filter((c) => c.empresaId === empresa.id).map((c) => ({ c, s: situacao(empresa, c) })).filter((x) => !x.s.motivo);
  const hoje = new Date().toISOString().slice(0, 10);
  return {
    ...f,
    horarioComercial: require('./automacoes').horarioAutomatico(empresa),
    naFila: naFila.length,
    porSequencia: Object.fromEntries(f.sequencias.map((s) => [s.id, naFila.filter((x) => x.s.seq.id === s.id).length])),
    desligadosPorCliente: estado.conversas.filter((c) => c.empresaId === empresa.id && c.followupDesligado).length,
    proximos: naFila
      .sort((a, b) => (a.s.quando < b.s.quando ? -1 : 1))
      .slice(0, 20)
      .map(({ c, s }) => ({ leadId: c.id, nome: c.nome || c.telefone || 'Cliente', passo: s.indice + 1, sequencia: s.seq.nome, quando: s.quando })),
    enviadosHoje: estado.conversas.filter((c) => c.empresaId === empresa.id).reduce((n, c) => n + (c.mensagens || []).filter((m) => m.followupPasso && m.em >= hoje).length, 0)
  };
}

// 📤 Teste: manda passo(s) do follow-up para um número qualquer, igual chega no cliente
// (texto com {nome} trocado e uma variação, mídias na ordem escolhida). Não grava nada.
async function testar(empresa, { numero, passos, variacao = null, nome = '' } = {}) {
  const whatsapp = require('./whatsapp');
  const midias = require('./midias');
  const { numeroWhatsapp } = require('./util');
  if (!whatsapp.configurado(empresa)) throw Object.assign(new Error('Conecte o WhatsApp da empresa primeiro.'), { status: 400 });
  const destino = numeroWhatsapp(numero);
  if (!destino || destino.length < 12) throw Object.assign(new Error('Digite o número com DDD (ex.: 21 99999-9999).'), { status: 400 });
  const lista = (Array.isArray(passos) ? passos : []).slice(0, MAX_PASSOS);
  if (!lista.length) throw Object.assign(new Error('Nada para enviar.'), { status: 400 });
  const falso = { nome: limpar(nome, 60) || 'Cliente' };
  const enviados = [];
  for (const [i, p] of lista.entries()) {
    const textos = (Array.isArray(p.textos) ? p.textos : []).map((t) => limpar(t, 2000)).filter(Boolean);
    const codigos = (Array.isArray(p.midias) ? p.midias : []).slice(0, 5);
    if (!textos.length && !codigos.length) continue;
    const v = textos.length ? (variacao !== null && textos[variacao] ? Number(variacao) : Math.floor(Math.random() * textos.length)) : null;
    const texto = v !== null ? require('./disparos').montarMensagem(textos[v], falso, empresa) : '';
    const mandarTexto = async () => { if (texto) await whatsapp.enviarTexto(empresa, destino, texto, { digitando: false }); };
    const mandarMidias = async () => {
      for (const c of codigos) for (const m of midias.resolverPedido(empresa, c).itens) await whatsapp.enviarMidia(empresa, destino, m);
    };
    if (lista.length > 1) await whatsapp.enviarTexto(empresa, destino, `🧪 Teste do follow-up · mensagem ${i + 1}${textos.length > 1 ? ` (variação ${v + 1} de ${textos.length})` : ''}`, { digitando: false });
    if (p.midiaPrimeiro) { await mandarMidias(); await mandarTexto(); } else { await mandarTexto(); await mandarMidias(); }
    enviados.push({ passo: i + 1, variacao: v === null ? null : v + 1, midias: codigos.length });
  }
  return { ok: true, enviados };
}

// Compatibilidade: migração antiga das automações "parou de responder"
const PADRAO = RECOMENDADO;
const RESERVAS = RECOMENDADO().map((p) => p.textos[0]);

module.exports = { fila, buscar, colocarNaFila, testar, jaAgendou, RESERVAS, configDa, salvarConfig, situacao, proximo, processar, paraPainel, pular, ligarParaLead, anotarEtiquetas, PADRAO, RECOMENDADO };
