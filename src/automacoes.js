// automacoes.js — a "máquina de vendas": mensagens automáticas no WhatsApp
// que saem sozinhas quando o lead cumpre um critério. Exemplos (receitas):
//  - recuperar quem parou de responder (a IA retoma a conversa);
//  - pedir avaliação no Google para quem já fechou;
//  - reativar quem desistiu; pós-venda; chamar para comprar de novo.
// Também envia as mensagens agendadas pela equipe em cada lead.
//
// Cuidados: respeita quem pediu SAIR, não fala com quem está esperando a
// equipe, só age numa janela de tempo depois do critério (ligar uma regra não
// dispara para leads antigos), no máximo poucas mensagens por minuto por
// empresa e, por padrão, só em horário comercial.

const { estado, salvar, novoId, agora } = require('./db');
const { texto } = require('./util');
const ia = require('./ia');
const leads = require('./leads');
const midias = require('./midias');
const whatsapp = require('./whatsapp');
const disparos = require('./disparos');

const HORA = 60 * 60 * 1000;
const JANELA_HORAS = 72; // só age até 3 dias depois de o critério ser cumprido
const POR_CICLO = 2; // mensagens automáticas por empresa a cada minuto
const INTERVALO_CICLO = Number(process.env.AUTOMACOES_CICLO_MS) || 60 * 1000;

function etapaParecida(empresa, ...nomes) {
  const etapas = leads.etapasDa(empresa);
  const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const n of nomes) {
    const e = etapas.find((x) => limpar(x).includes(limpar(n)));
    if (e) return e;
  }
  return '';
}

// Receitas prontas: a empresa liga com um clique e ajusta se quiser
const RECEITAS = {
  recuperar: (empresa) => ({
    nome: 'Recuperar quem parou de responder',
    explicacao: 'Quando o cliente some no meio da conversa, a IA retoma o assunto de forma leve, com uma pergunta fácil. Até 2 tentativas.',
    gatilho: { tipo: 'sem_resposta', horas: 20 },
    filtro: {
      etapas: leads.etapasDa(empresa).filter((e) => e !== etapaParecida(empresa, 'fechad', 'ganh', 'vendid') && e !== etapaParecida(empresa, 'perdid')),
      etiquetas: []
    },
    acao: {
      modo: 'ia',
      instrucao:
        'O cliente parou de responder. Retome a conversa de forma leve e útil: lembre do que ele queria, resolva uma possível dúvida ou objeção e termine com uma pergunta fácil de responder. Não seja insistente e não repita a última mensagem.'
    },
    maxPorLead: 2,
    incluirPausados: false,
    horarioComercial: true
  }),
  avaliacao: (empresa) => ({
    nome: 'Pedir avaliação no Google',
    explicacao: 'Dois dias depois de fechar, agradece e manda o link de avaliação do Google Meu Negócio. Mais avaliações = mais clientes novos.',
    gatilho: { tipo: 'etapa', etapa: etapaParecida(empresa, 'fechad', 'ganh', 'vendid') || leads.etapasDa(empresa).slice(-2)[0], horas: 48 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'texto',
      texto:
        '{Oi|Olá} {nome}! Muito obrigado por escolher a {empresa} 🙏\n\nSe puder, conta pra gente como foi? Sua avaliação ajuda muito outras pessoas a nos conhecerem:\n{link_avaliacao}'
    },
    maxPorLead: 1,
    incluirPausados: true,
    horarioComercial: true
  }),
  reativar: (empresa) => ({
    nome: 'Reativar quem desistiu',
    explicacao: '15 dias depois de o lead ir para "Perdido", a IA pergunta se ainda tem interesse e lembra uma condição ou novidade (sem inventar).',
    gatilho: { tipo: 'etapa', etapa: etapaParecida(empresa, 'perdid') || leads.etapasDa(empresa).slice(-1)[0], horas: 15 * 24 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'ia',
      instrucao:
        'Este cliente não fechou há algumas semanas. Mande uma mensagem curta e amigável perguntando se ainda tem interesse, citando uma vantagem, promoção ou novidade que esteja em "Sobre a empresa" (não invente). Termine com uma pergunta simples.'
    },
    maxPorLead: 1,
    incluirPausados: true,
    horarioComercial: true
  }),
  posvenda: (empresa) => ({
    nome: 'Pós-venda: está tudo certo?',
    explicacao: '7 dias depois de fechar, pergunta se está tudo certo. Cliente bem atendido volta e indica.',
    gatilho: { tipo: 'etapa', etapa: etapaParecida(empresa, 'fechad', 'ganh', 'vendid') || leads.etapasDa(empresa).slice(-2)[0], horas: 7 * 24 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'ia',
      instrucao:
        'Já faz uma semana que o cliente fechou. Pergunte de forma calorosa se está tudo certo com o serviço/produto e se ele precisa de algo. Se fizer sentido, lembre que indicações são bem-vindas.'
    },
    maxPorLead: 1,
    incluirPausados: true,
    horarioComercial: true
  }),
  recompra: (empresa) => ({
    nome: 'Chamar para comprar de novo',
    explicacao: '60 dias depois de fechar, a IA lembra o cliente e oferece o serviço/produto de novo (manutenção, reposição, novidade).',
    gatilho: { tipo: 'etapa', etapa: etapaParecida(empresa, 'fechad', 'ganh', 'vendid') || leads.etapasDa(empresa).slice(-2)[0], horas: 60 * 24 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'ia',
      instrucao:
        'O cliente comprou há uns 2 meses. Mande uma mensagem curta oferecendo de novo o que faz sentido para ele (manutenção, reposição, complemento, novidade que esteja em "Sobre a empresa"). Sem inventar preço ou promoção.'
    },
    maxPorLead: 1,
    incluirPausados: true,
    horarioComercial: true
  })
};

function automacoesDa(empresa) {
  return Array.isArray(empresa.automacoes) ? empresa.automacoes : [];
}

// ---------------------------------------------------------------- validação

function normalizarRegra(empresa, b, atual = {}) {
  const etapas = leads.etapasDa(empresa);
  const idsEtiquetas = new Set(leads.etiquetasDa(empresa).map((t) => t.id));
  const gat = b.gatilho || atual.gatilho || {};
  const tipo = gat.tipo === 'etapa' ? 'etapa' : 'sem_resposta';
  const horas = Math.min(24 * 365, Math.max(1, Number(gat.horas) || 24));
  const etapa = tipo === 'etapa' ? leads.acharEtapa(empresa, gat.etapa) : '';
  if (tipo === 'etapa' && !etapa) throw Object.assign(new Error('Escolha a etapa que dispara a automação.'), { status: 400 });
  const acao = b.acao || atual.acao || {};
  const modo = acao.modo === 'texto' ? 'texto' : 'ia';
  const regra = {
    ...atual,
    nome: texto(b.nome ?? atual.nome, 80) || 'Automação',
    explicacao: texto(b.explicacao ?? atual.explicacao, 300),
    ativa: b.ativa !== undefined ? b.ativa === true : atual.ativa !== false,
    gatilho: { tipo, horas, ...(etapa ? { etapa } : {}) },
    filtro: {
      etapas: (b.filtro?.etapas ?? atual.filtro?.etapas ?? []).filter((e) => etapas.includes(e)),
      etiquetas: (b.filtro?.etiquetas ?? atual.filtro?.etiquetas ?? []).filter((t) => idsEtiquetas.has(t))
    },
    acao: {
      modo,
      texto: texto(acao.texto, 2000),
      instrucao: texto(acao.instrucao, 1000),
      midiaId: texto(acao.midiaId, 60) || null
    },
    maxPorLead: Math.min(5, Math.max(1, Number(b.maxPorLead ?? atual.maxPorLead) || 1)),
    incluirPausados: (b.incluirPausados ?? atual.incluirPausados) === true,
    horarioComercial: (b.horarioComercial ?? atual.horarioComercial) !== false
  };
  if (modo === 'texto' && !regra.acao.texto) throw Object.assign(new Error('Escreva a mensagem.'), { status: 400 });
  if (modo === 'ia' && !regra.acao.instrucao) throw Object.assign(new Error('Diga para a IA o que ela deve escrever.'), { status: 400 });
  return regra;
}

function criarDeReceita(empresa, receita) {
  const f = RECEITAS[receita];
  if (!f) throw Object.assign(new Error('Receita desconhecida.'), { status: 400 });
  const regra = { id: novoId('aut'), receita, ...normalizarRegra(empresa, { ...f(empresa), ativa: true }), criadoEm: agora() };
  empresa.automacoes = [...automacoesDa(empresa), regra];
  salvar();
  return regra;
}

// ---------------------------------------------------------------- critérios

function entrouNaEtapaEm(lead, etapa) {
  if (lead.etapa !== etapa) return null;
  const h = [...(lead.etapaHistorico || [])].reverse().find((x) => x.para === etapa);
  return h ? h.em : lead.criadoEm;
}

function motivoInelegivel(regra, lead, empresa, agoraMs = Date.now()) {
  if (!whatsapp.destinoDoLead(lead)) return 'sem WhatsApp';
  if (lead.naoDisparar) return 'pediu para não receber';
  if (lead.precisaHumano) return 'esperando a equipe';
  if (lead.iaPausada && !regra.incluirPausados) return 'equipe atendendo';
  if (regra.filtro.etapas.length && !regra.filtro.etapas.includes(lead.etapa)) return 'fora do filtro';
  if (regra.filtro.etiquetas.length && !(lead.etiquetas || []).some((t) => regra.filtro.etiquetas.includes(t))) return 'fora do filtro';
  const hist = lead.automacoes?.[regra.id] || { enviados: 0 };
  if (hist.enviados >= regra.maxPorLead) return 'já recebeu';
  const horas = regra.gatilho.horas;
  let desde;
  if (regra.gatilho.tipo === 'sem_resposta') {
    const comTexto = lead.mensagens.filter((m) => m.texto || m.anexo);
    const ultima = comTexto[comTexto.length - 1];
    if (!ultima || ultima.papel === 'visitante') return 'cliente falou por último';
    if (!comTexto.some((m) => m.papel === 'visitante')) return 'cliente nunca respondeu';
    desde = ultima.em;
  } else {
    desde = entrouNaEtapaEm(lead, regra.gatilho.etapa);
    if (!desde) return 'fora da etapa';
    if (hist.ultimoEm && hist.ultimoEm >= desde) return 'já recebeu';
  }
  const passou = (agoraMs - new Date(desde).getTime()) / HORA;
  if (passou < horas) return 'ainda não deu o tempo';
  if (passou > horas + JANELA_HORAS) return 'antigo demais';
  if (regra.acao.modo === 'texto' && /\{link_avaliacao\}/i.test(regra.acao.texto)) {
    const bot = whatsapp.botDoWhatsapp(empresa);
    if (!bot?.linkAvaliacao) return 'falta o link de avaliação';
  }
  return null;
}

// ---------------------------------------------------------------- envio

async function executar(regra, lead, empresa) {
  const bot = whatsapp.botDoWhatsapp(empresa);
  const destino = lead.whatsappJid || whatsapp.destinoDoLead(lead);
  let mensagem = '';
  let midiasPedidas = [];
  if (regra.acao.modo === 'texto') {
    mensagem = disparos.montarMensagem(regra.acao.texto, lead, empresa);
  } else {
    if (!bot) throw new Error('empresa sem assistente');
    const r = await ia.escreverMensagem(bot, empresa, lead.mensagens, regra.acao.instrucao, {
      etapas: leads.etapasDa(empresa),
      etapaAtual: lead.etapa,
      midias: midias.paraIa(empresa),
      links: midias.linksDa(empresa),
      etiquetas: leads.etiquetasDa(empresa)
    });
    mensagem = r.texto;
    midiasPedidas = r.midias || [];
  }
  if (!mensagem) throw new Error('mensagem vazia');
  await whatsapp.enviarTexto(empresa, destino, mensagem);
  leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: mensagem, automacaoId: regra.id, automacaoNome: regra.nome });
  const midiaFixa = regra.acao.midiaId && midias.midiasDa(empresa).find((m) => m.id === regra.acao.midiaId);
  if (midiaFixa) midiasPedidas.push(midiaFixa.nome);
  await whatsapp.enviarMidiasPedidas(empresa, lead, midiasPedidas);
  lead.automacoes = lead.automacoes || {};
  const hist = lead.automacoes[regra.id] || { enviados: 0 };
  lead.automacoes[regra.id] = { enviados: hist.enviados + 1, ultimoEm: agora() };
  lead.ultimaAutomacaoEm = agora();
  regra.stats = { enviados: (regra.stats?.enviados || 0) + 1, ultimoEm: agora() };
  salvar();
}

function dentroDoHorario() {
  const h = disparos.horaEmSaoPaulo();
  return h >= disparos.HORA_INICIO && h < disparos.HORA_FIM;
}

// Mensagens agendadas pela equipe num lead
async function enviarAgendadas(empresa) {
  const agoraIso = agora();
  for (const lead of estado.conversas.filter((c) => c.empresaId === empresa.id && c.agendadas?.length)) {
    for (const a of lead.agendadas.filter((x) => x.status === 'pendente' && x.quando <= agoraIso)) {
      try {
        const destino = whatsapp.destinoDoLead(lead);
        if (!destino) throw new Error('lead sem WhatsApp');
        await whatsapp.enviarTexto(empresa, destino, a.texto);
        leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: a.texto, agendadaId: a.id });
        a.status = 'enviada';
        a.enviadaEm = agora();
      } catch (err) {
        // servidor fora do ar: tenta de novo no próximo minuto (até 1 hora)
        if ((!err.status || err.status >= 500) && Date.now() - new Date(a.quando).getTime() < HORA) continue;
        a.status = 'erro';
        a.erro = err.message.slice(0, 200);
      }
      salvar();
    }
  }
}

const ocupadas = new Set();
async function cicloDaEmpresa(empresa) {
  if (ocupadas.has(empresa.id)) return;
  ocupadas.add(empresa.id);
  try {
    await enviarAgendadas(empresa);
    const ativas = automacoesDa(empresa).filter((r) => r.ativa);
    if (!ativas.length) return;
    let enviadas = 0;
    const doEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
    for (const regra of ativas) {
      if (regra.horarioComercial && !dentroDoHorario()) continue;
      for (const lead of doEmpresa) {
        if (enviadas >= POR_CICLO) return;
        if (motivoInelegivel(regra, lead, empresa)) continue;
        try {
          await executar(regra, lead, empresa);
          enviadas++;
        } catch (err) {
          console.error(`[automação ${regra.id} ${lead.id}]`, err.message);
          // não tenta de novo sem parar: conta como tentativa
          lead.automacoes = lead.automacoes || {};
          const hist = lead.automacoes[regra.id] || { enviados: 0 };
          lead.automacoes[regra.id] = { ...hist, enviados: hist.enviados + 1, ultimoEm: agora(), erro: err.message.slice(0, 200) };
          salvar();
          if (!err.status || err.status >= 500) return; // conexão fora: espera o próximo ciclo
        }
      }
    }
  } finally {
    ocupadas.delete(empresa.id);
  }
}

async function ciclo() {
  for (const empresa of estado.empresas) {
    if (empresa.ativa === false || !whatsapp.configurado(empresa)) continue;
    await cicloDaEmpresa(empresa).catch((err) => console.error(`[automações ${empresa.id}]`, err.message));
    require('./aprendizado').verificarAgenda(empresa);
  }
}

let timer = null;
function iniciar() {
  if (timer) return;
  timer = setInterval(() => ciclo().catch(() => {}), INTERVALO_CICLO);
  timer.unref?.();
}

// ---------------------------------------------------------------- números para o painel

function resumo(regra, empresa) {
  let enviados = 0;
  let responderam = 0;
  let pendentes = 0;
  for (const lead of estado.conversas.filter((c) => c.empresaId === empresa.id)) {
    const h = lead.automacoes?.[regra.id];
    if (h?.ultimoEm && !h.erro) {
      enviados++;
      if (lead.mensagens.some((m) => m.papel === 'visitante' && m.em > h.ultimoEm)) responderam++;
    }
    if (regra.ativa && !motivoInelegivel(regra, lead, empresa)) pendentes++;
  }
  return { ...regra, numeros: { leadsAtingidos: enviados, responderam, prontosAgora: pendentes } };
}

function agendarMensagem(lead, { texto: t, quando }, usuario) {
  const msg = texto(t, 4000);
  const data = new Date(quando);
  if (!msg) throw Object.assign(new Error('Escreva a mensagem.'), { status: 400 });
  if (Number.isNaN(data.getTime()) || data.getTime() < Date.now() - 60 * 1000) {
    throw Object.assign(new Error('Escolha uma data e hora no futuro.'), { status: 400 });
  }
  if (!whatsapp.destinoDoLead(lead)) throw Object.assign(new Error('Este lead não tem WhatsApp.'), { status: 400 });
  lead.agendadas = (lead.agendadas || []).filter((a) => a.status === 'pendente' || Date.now() - new Date(a.quando).getTime() < 30 * 24 * HORA);
  const a = { id: novoId('agd'), texto: msg, quando: data.toISOString(), status: 'pendente', criadoPor: usuario?.email || '', criadoEm: agora() };
  lead.agendadas.push(a);
  salvar();
  return a;
}

module.exports = {
  RECEITAS,
  automacoesDa,
  normalizarRegra,
  criarDeReceita,
  motivoInelegivel,
  resumo,
  agendarMensagem,
  ciclo,
  iniciar
};
