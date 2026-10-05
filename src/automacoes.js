// automacoes.js — a "máquina de vendas": mensagens automáticas no WhatsApp
// que saem sozinhas quando o lead cumpre um critério. Exemplos (receitas):
//  - recuperar quem parou de responder é o FOLLOW-UP (followup.js), que fica
//    no topo desta mesma página — aqui ficam as outras regras;
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

// Horário dos envios automáticos: UM só para o follow-up e todas as automações
// (antes cada regra e o follow-up tinham o seu). Padrão: 8h às 20h.
function horarioAutomatico(empresa) {
  if (typeof empresa.horarioAutomatico === 'boolean') return empresa.horarioAutomatico;
  return empresa.followup?.horarioComercial !== false;
}

// Receitas prontas: a empresa liga com um clique e ajusta se quiser
const RECEITAS = {
  avaliacao: (empresa) => ({
    nome: 'Pedir avaliação no Google',
    explicacao: 'Dois dias depois da venda confirmada (comprovante de Pix, venda marcada pela IA ou pela equipe), agradece e manda o link de avaliação do Google Meu Negócio. Mais avaliações = mais clientes novos.',
    gatilho: { tipo: 'venda', horas: 48 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'texto',
      texto:
        '{Oi|Olá} {nome}! Muito obrigado por escolher a {empresa} 🙏\n\nSe puder, conta pra gente como foi? Sua avaliação ajuda muito outras pessoas a nos conhecerem:\n{link_avaliacao}'
    },
    maxPorLead: 1,
    incluirPausados: true,
  }),
  comentario: (empresa) => ({
    nome: 'Pedir comentário no anúncio (Instagram/Facebook)',
    explicacao: 'Quatro dias depois de fechar, agradece e manda o link do seu anúncio para o cliente comentar como foi. Comentários de clientes reais no anúncio passam confiança para quem vê o anúncio.',
    gatilho: { tipo: 'venda', horas: 96 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'texto',
      texto:
        '{Oi|Olá} {nome}! Que bom que deu tudo certo 😊\n\nPosso te pedir uma ajuda rápida? Deixa um comentário no nosso post contando como foi com a {empresa}. Isso ajuda muito outras pessoas a confiarem na gente 🙏\n{link_anuncio}'
    },
    maxPorLead: 1,
    incluirPausados: true,
  }),
  reativar: (empresa) => ({
    nome: 'Reativar quem desistiu',
    explicacao: '15 dias depois de o lead ir para "Não fechou", a IA pergunta se ainda tem interesse e lembra uma condição ou novidade (sem inventar).',
    gatilho: { tipo: 'etapa', etapa: etapaParecida(empresa, 'perdid', 'nao fech') || leads.etapasDa(empresa).slice(-1)[0], horas: 15 * 24 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'ia',
      instrucao:
        'Este cliente não fechou há algumas semanas. Mande uma mensagem curta e amigável perguntando se ainda tem interesse, citando uma vantagem, promoção ou novidade que esteja em "Sobre a empresa" (não invente). Termine com uma pergunta simples.'
    },
    maxPorLead: 1,
    incluirPausados: true,
  }),
  posvenda: (empresa) => ({
    nome: 'Pós-venda: está tudo certo?',
    explicacao: '7 dias depois de fechar, pergunta se está tudo certo. Cliente bem atendido volta e indica.',
    gatilho: { tipo: 'venda', horas: 7 * 24 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'ia',
      instrucao:
        'Já faz uma semana que o cliente fechou. Pergunte de forma calorosa se está tudo certo com o serviço/produto e se ele precisa de algo. Se fizer sentido, lembre que indicações são bem-vindas.'
    },
    maxPorLead: 1,
    incluirPausados: true,
  }),
  recompra: (empresa) => ({
    nome: 'Chamar para comprar de novo',
    explicacao: '60 dias depois de fechar, a IA lembra o cliente e oferece o serviço/produto de novo (manutenção, reposição, novidade).',
    gatilho: { tipo: 'venda', horas: 60 * 24 },
    filtro: { etapas: [], etiquetas: [] },
    acao: {
      modo: 'ia',
      instrucao:
        'O cliente comprou há uns 2 meses. Mande uma mensagem curta oferecendo de novo o que faz sentido para ele (manutenção, reposição, complemento, novidade que esteja em "Sobre a empresa"). Sem inventar preço ou promoção.'
    },
    maxPorLead: 1,
    incluirPausados: true,
  })
};

const RECEITAS_DE_VENDA = new Set(['avaliacao', 'comentario', 'posvenda', 'recompra']);

function automacoesDa(empresa) {
  const lista = Array.isArray(empresa.automacoes) ? empresa.automacoes : [];
  // regras antigas de pós-venda disparavam pela etapa "Fechado": agora é pela venda confirmada
  let mudou = false;
  for (const r of lista) {
    if (RECEITAS_DE_VENDA.has(r.receita) && r.gatilho?.tipo === 'etapa' && !r.migradoParaVenda) {
      r.gatilho = { tipo: 'venda', horas: r.gatilho.horas };
      r.migradoParaVenda = true;
      mudou = true;
    }
  }
  if (lista.some((r) => r.gatilho?.tipo === 'sem_resposta')) {
    migrarRecuperarParaFollowup(empresa, lista);
    mudou = true;
  }
  if (mudou) salvar();
  return empresa.automacoes || lista;
}

// As regras antigas "parou de responder" viram passos do Follow-up (uma vez só):
// mesma ideia, um lugar só. Quem já recebeu a regra antiga não recebe de novo
// (o follow-up só começa para conversas que pararem depois da migração).
function migrarRecuperarParaFollowup(empresa, lista) {
  const velhas = lista.filter((r) => r.gatilho?.tipo === 'sem_resposta');
  const base = velhas.find((r) => r.ativa) || velhas[0];
  const fup = require('./followup');
  // follow-up que você já configurou (ligou ou salvou) fica como está; senão vira a regra antiga
  const jaConfigurado = Boolean(empresa.followup && (empresa.followup.ativo || empresa.followup.editadoEm));
  const f = fup.configDa(empresa);
  if (!jaConfigurado && base) {
    const codigo = base.acao?.midiaId && midias.midiasDa(empresa).find((m) => m.id === base.acao.midiaId)?.codigo;
    f.passos = Array.from({ length: Math.min(5, Math.max(1, base.maxPorLead || 1)) }, (_, i) => ({
      id: novoId('fup'),
      horas: base.gatilho.horas || 24,
      modo: base.acao?.modo === 'texto' ? 'texto' : 'ia',
      instrucao: base.acao?.instrucao || '',
      texto: base.acao?.texto || '',
      midias: i === 0 && codigo ? [codigo] : []
    })).filter((p) => (p.modo === 'texto' ? p.texto : true));
    if (!f.passos.length) f.passos = fup.PADRAO();
    f.incluirPausados = base.incluirPausados === true;
    if (typeof empresa.horarioAutomatico !== 'boolean') empresa.horarioAutomatico = base.horarioComercial !== false;
  }
  if (velhas.some((r) => r.ativa) && !f.ativo) {
    f.ativo = true;
    f.ativadoEm = agora();
  }
  empresa.automacoes = lista.filter((r) => r.gatilho?.tipo !== 'sem_resposta');
  empresa.followupMigradoEm = agora();
  console.log(`[automações ${empresa.id}] ${velhas.length} regra(s) "parou de responder" viraram o Follow-up`);
}

// Quando o lead comprou: a venda confirmada mais recente (comprovante de Pix,
// venda da IA ou da equipe) ou, sem venda registrada, a entrada em "Fechado"
function vendaDoLead(lead, empresa) {
  const vendas = (estado.vendas || []).filter((v) => v.leadId === lead.id && v.status === 'confirmada');
  const ultima = vendas.map((v) => v.confirmadaEm || v.criadoEm).sort().pop();
  if (ultima) return ultima;
  if (lead.vendaConcluidaManual && lead.vendaConcluidaEm) return lead.vendaConcluidaEm; // marcada à mão
  const fechado = etapaParecida(empresa, 'fechad', 'ganh', 'vendi');
  return fechado ? entrouNaEtapaEm(lead, fechado) : null;
}

// ---------------------------------------------------------------- validação

function normalizarRegra(empresa, b, atual = {}) {
  const etapas = leads.etapasDa(empresa);
  const idsEtiquetas = new Set(leads.etiquetasDa(empresa).map((t) => t.id));
  const gat = b.gatilho || atual.gatilho || {};
  if (!['etapa', 'venda'].includes(gat.tipo)) {
    throw Object.assign(new Error('Para quem parou de responder, use o Follow-up (no topo da Máquina de vendas).'), { status: 400 });
  }
  const tipo = gat.tipo;
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
    // também para quem comprou ANTES de ligar a regra (0 = só vendas novas)
    incluirAntigosDias: Math.min(365, Math.max(0, Number(b.incluirAntigosDias ?? atual.incluirAntigosDias) || 0))
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
  if (!leads.iaPodeFalarCom(lead)) return 'nunca conversou (não está em Conversas)';
  if (lead.historicoImportado) return 'conversa antiga recuperada do WhatsApp';
  if (!whatsapp.liberadoNoModoTeste(empresa, lead)) return 'modo teste';
  if (lead.naoDisparar) return 'pediu para não receber';
  if (lead.precisaHumano) return 'esperando a equipe';
  // já comprou/agendou: só os pedidos de avaliação e de comentário no anúncio continuam
  if (!require('./ia-desligada').RECEITAS_LIBERADAS.has(regra.receita)) {
    const venda = require('./comprovantes').jaVendeu(empresa, lead);
    if (venda) return 'já comprou';
    if (!require('./ia-desligada').iaComAgendados(empresa) && require('./followup').jaAgendou(empresa, lead)) return 'já agendou';
  }
  if (lead.iaPausada && !regra.incluirPausados) return 'equipe atendendo';
  if (regra.gatilho.tipo === 'sem_resposta') return 'o Follow-up cuida disso'; // (regra antiga, antes de migrar)
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
  } else if (regra.gatilho.tipo === 'venda') {
    desde = vendaDoLead(lead, empresa);
    if (!desde) return 'ainda não comprou';
    if (hist.ultimoEm && hist.ultimoEm >= desde) return 'já recebeu';
  } else {
    desde = entrouNaEtapaEm(lead, regra.gatilho.etapa);
    if (!desde) return 'fora da etapa';
    if (hist.ultimoEm && hist.ultimoEm >= desde) return 'já recebeu';
  }
  const passou = (agoraMs - new Date(desde).getTime()) / HORA;
  if (passou < horas) return 'ainda não deu o tempo';
  // quem comprou antes de ligar a regra: só entra se a regra incluir os antigos
  const janela = regra.gatilho.tipo === 'venda' && regra.incluirAntigosDias ? Math.max(JANELA_HORAS, regra.incluirAntigosDias * 24) : JANELA_HORAS;
  if (passou > horas + janela) return 'antigo demais';
  // já recebeu o mesmo pedido à mão (botão na conversa)
  if (regra.receita && (lead.pedidosManuais || {})[regra.receita]) return 'já recebeu';
  if (regra.acao.modo === 'texto' && /\{link_avaliacao\}/i.test(regra.acao.texto)) {
    const bot = whatsapp.botDoWhatsapp(empresa);
    if (!bot?.linkAvaliacao) return 'falta o link de avaliação';
  }
  if (regra.acao.modo === 'texto' && /\{link_anuncio\}/i.test(regra.acao.texto)) {
    const bot = whatsapp.botDoWhatsapp(empresa);
    if (!bot?.linkAnuncio) return 'falta o link do anúncio';
  }
  return null;
}

// ---------------------------------------------------------------- próximos envios (cronômetro no painel)

// Desde quando a regra conta o tempo para este lead (sem olhar o resto)
function inicioDaRegra(regra, lead, empresa) {
  if (regra.gatilho.tipo === 'sem_resposta') {
    const comTexto = lead.mensagens.filter((m) => m.texto || m.anexo);
    const ultima = comTexto[comTexto.length - 1];
    return ultima && ultima.papel !== 'visitante' ? ultima.em : null;
  }
  if (regra.gatilho.tipo === 'venda') return vendaDoLead(lead, empresa);
  return entrouNaEtapaEm(lead, regra.gatilho.etapa);
}

// Horário comercial (8h–20h de Brasília): fora dele, o envio fica para as 8h
function noHorarioComercial(ms) {
  const sp = new Date(ms - 3 * HORA); // Brasília = UTC-3
  const h = sp.getUTCHours();
  if (h >= 8 && h < 20) return ms;
  const base = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + (h >= 20 ? 1 : 0), 8 + 3, 0, 0);
  return base;
}

// O que ainda vai sair para este cliente, com a hora: follow-ups automáticos e agendados
function proximosEnvios(lead, empresa) {
  const agoraMs = Date.now();
  const lista = [];
  for (const a of (lead.agendadas || []).filter((x) => x.status === 'pendente')) {
    lista.push({ tipo: 'agendada', id: a.id, quando: a.quando, titulo: a.criadoPor === 'IA' ? 'Follow-up que a IA agendou' : 'Mensagem agendada pela equipe', detalhe: a.modo === 'ia' ? a.instrucao : a.texto, porIa: a.criadoPor === 'IA' });
  }
  if (empresa.ativa !== false && whatsapp.configurado(empresa)) {
    const fup = require('./followup').proximo(empresa, lead);
    if (fup) lista.push({ ...fup, quando: new Date(Math.max(new Date(fup.quando).getTime(), agoraMs)).toISOString() });
    for (const regra of automacoesDa(empresa).filter((r) => r.ativa)) {
      const motivo = motivoInelegivel(regra, lead, empresa, agoraMs);
      let quandoMs = null;
      if (motivo === null) quandoMs = agoraMs;
      else if (motivo === 'ainda não deu o tempo') {
        const desde = inicioDaRegra(regra, lead, empresa);
        if (!desde) continue;
        quandoMs = new Date(desde).getTime() + regra.gatilho.horas * HORA;
        // nada mais impede quando chegar a hora?
        if (motivoInelegivel(regra, lead, empresa, quandoMs + 60 * 1000) !== null) continue;
      } else continue;
      if (horarioAutomatico(empresa)) quandoMs = noHorarioComercial(quandoMs);
      lista.push({ tipo: 'automacao', id: regra.id, quando: new Date(Math.max(quandoMs, agoraMs)).toISOString(), titulo: regra.nome, detalhe: regra.acao.modo === 'ia' ? 'a IA escreve na hora' : regra.acao.texto.slice(0, 120), porIa: regra.acao.modo === 'ia' });
    }
  }
  return lista.sort((a, b) => (a.quando < b.quando ? -1 : 1));
}

// A IA marcou [[RETOMAR: 2h | sobre o quê]]: follow-up que ela mesma vai escrever na hora
function quandoRetomar(texto) {
  const t = String(texto || '').trim().toLowerCase();
  const rel = t.match(/^(\d+(?:[.,]\d+)?)\s*(min|minutos?|h|horas?|d|dias?)\b/);
  if (rel) {
    const n = Number(rel[1].replace(',', '.'));
    const mult = /^min/.test(rel[2]) ? 60 * 1000 : /^h/.test(rel[2]) ? HORA : 24 * HORA;
    return new Date(Date.now() + n * mult).toISOString();
  }
  return require('./tickets').quandoDe(texto);
}

function agendarFollowupDaIa(empresa, lead, { quando, assunto, mensagem }) {
  const iso = quandoRetomar(quando);
  if (!iso || new Date(iso).getTime() < Date.now() + 5 * 60 * 1000) return null; // precisa ser no futuro
  if (new Date(iso).getTime() > Date.now() + 60 * 24 * HORA) return null; // no máximo 60 dias
  lead.agendadas = (lead.agendadas || []).map((a) => (a.status === 'pendente' && a.criadoPor === 'IA' ? { ...a, status: 'cancelada', motivo: 'a IA remarcou' } : a));
  // a IA já escreveu a mensagem na hora em que combinou: na hora marcada só envia (sem gastar tokens de novo)
  // sem a mensagem pronta: vai um texto fixo (follow-up nunca gasta token na hora de enviar)
  const pronta = texto(mensagem, 1000) || require('./disparos').montarMensagem('{Oi|Olá} {nome}! Conforme combinamos, passando para retomar nossa conversa 😊', lead, empresa);
  const a = { id: novoId('agd'), modo: 'texto', instrucao: texto(assunto, 300) || 'retomar a conversa de onde parou', texto: pronta, quando: iso, status: 'pendente', criadoPor: 'IA', criadoEm: agora() };
  lead.agendadas.push(a);
  salvar();
  return a;
}

// Cliente respondeu antes da hora: o follow-up que a IA agendou não faz mais sentido
function cancelarFollowupsDaIa(lead, motivo = 'o cliente respondeu antes') {
  let n = 0;
  for (const a of lead.agendadas || []) {
    if (a.status === 'pendente' && a.criadoPor === 'IA') {
      a.status = 'cancelada';
      a.motivo = motivo;
      n++;
    }
  }
  return n;
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
    const r = await ia.escreverMensagem(bot, empresa, leads.historicoParaIa(lead), regra.acao.instrucao, {
      origem: await require('./origem').contextoParaIa(lead, bot, 'whatsapp', empresa),
      etapas: leads.etapasDa(empresa),
      etapaAtual: lead.etapa,
      midias: midias.paraIa(empresa, { followup: true }),
      links: midias.linksDa(empresa),
      etiquetas: leads.etiquetasDa(empresa)
    });
    mensagem = r.texto;
    midiasPedidas = r.midias || [];
  }
  if (!mensagem) throw new Error('mensagem vazia');
  await whatsapp.enviarTexto(empresa, destino, mensagem);
  leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: mensagem, automacaoId: regra.id, automacaoNome: regra.nome });
  // mídias que a IA escolheu: só as prontas (regra da IA)
  if (midiasPedidas.length) await whatsapp.enviarMidiasPedidas(empresa, lead, midiasPedidas, 'assistente', { followup: true });
  // mídia que o dono escolheu na automação (sem IA): vai mesmo "a configurar", como no follow-up
  const midiaFixa = regra.acao.midiaId && midias.midiasDa(empresa).find((m) => m.id === regra.acao.midiaId);
  if (midiaFixa) await whatsapp.enviarMidiasPedidas(empresa, lead, [midiaFixa.codigo || midiaFixa.nome], 'equipe', { papelMensagem: 'assistente' });
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
        let textoEnvio = a.texto;
        let midiasPedidas = [];
        if (leads.naListaNegra(empresa, lead)) {
          a.status = 'cancelada';
          a.motivo = 'cliente na lista negra';
          continue;
        }
        if ((a.modo === 'ia' || a.criadoPor === 'IA') && !leads.iaPodeFalarCom(lead)) {
          a.status = 'cancelada';
          a.motivo = 'a IA só escreve para quem já conversou (está em Conversas)';
          salvar();
          continue;
        }
        // follow-up que a IA combinou: não sai para quem já comprou (ou agendou, por padrão)
        const desligada = a.modo === 'ia' || a.criadoPor === 'IA' ? require('./ia-desligada').motivo(empresa, lead) : null;
        if (desligada) {
          a.status = 'cancelada';
          a.motivo = desligada.por === 'venda' ? 'o cliente já comprou' : 'o cliente agendou';
          salvar();
          continue;
        }
        if (a.modo === 'ia') {
          // follow-up agendado pela IA: ela escreve agora, com a conversa atualizada
          const bot = whatsapp.botDoWhatsapp(empresa);
          if (!bot) throw new Error('empresa sem assistente');
          const r = await ia.escreverMensagem(bot, empresa, leads.historicoParaIa(lead), `Chegou a hora do follow-up combinado com o cliente. Retome a conversa: ${a.instrucao}. Seja breve e natural, sem pressionar.`, {
            etapas: leads.etapasDa(empresa),
            etapaAtual: lead.etapa,
            midias: midias.paraIa(empresa, { followup: true }),
            links: midias.linksDa(empresa)
          });
          textoEnvio = r.texto;
          midiasPedidas = r.midias || [];
          if (!textoEnvio) throw new Error('a IA não escreveu o follow-up');
        }
        await whatsapp.enviarTexto(empresa, destino, textoEnvio);
        leads.adicionarMensagem(lead, { papel: a.modo === 'ia' || a.criadoPor === 'IA' ? 'assistente' : 'equipe', canal: 'whatsapp', texto: textoEnvio, agendadaId: a.id });
        if (midiasPedidas.length) await whatsapp.enviarMidiasPedidas(empresa, lead, midiasPedidas, 'assistente', { followup: true });
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
    await require('./followup').processar(empresa); // follow-up em passos (seção Follow-up)
    const ativas = automacoesDa(empresa).filter((r) => r.ativa);
    if (!ativas.length || (horarioAutomatico(empresa) && !dentroDoHorario())) return;
    let enviadas = 0;
    const doEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
    for (const regra of ativas) {
      for (const lead of doEmpresa) {
        if (enviadas >= POR_CICLO) return;
        if (motivoInelegivel(regra, lead, empresa)) continue;
        try {
          await executar(regra, lead, empresa);
          enviadas++;
        } catch (err) {
          console.error(`[automação ${regra.id} ${lead.id}]`, err.message);
          require('./alertas').registrar(empresa, 'automacao', `A automação "${regra.nome}" deu erro com ${lead.nome || 'um cliente'}: ${err.message}`, { leadId: lead.id });
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
    if (empresa.ativa === false) continue;
    require('./site').verificarAgenda(empresa); // relê o site da empresa uma vez por semana
    if (!whatsapp.configurado(empresa)) continue;
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

// Quando cada pedido (avaliação / comentário) já foi feito a este cliente —
// pela automação ou à mão pela equipe
function pedidosFeitos(lead, empresa) {
  const saida = {};
  for (const tipo of ['avaliacao', 'comentario']) {
    const manual = (lead.pedidosManuais || {})[tipo] || null;
    const regras = automacoesDa(empresa).filter((r) => r.receita === tipo);
    const auto = regras.map((r) => lead.automacoes?.[r.id]).filter((h) => h?.ultimoEm && !h.erro).map((h) => h.ultimoEm).sort().pop() || null;
    saida[tipo] = [manual, auto].filter(Boolean).sort().pop() || null;
  }
  return saida;
}

// Mensagem do pedido: a da automação da empresa (se ela editou) ou a da receita
function mensagemDoPedido(empresa, tipo) {
  const regra = automacoesDa(empresa).find((r) => r.receita === tipo && r.acao?.modo === 'texto' && r.acao.texto);
  return regra ? regra.acao.texto : RECEITAS[tipo](empresa).acao.texto;
}

async function enviarPedidoManual(empresa, lead, tipo, { forcar = false, usuario = '' } = {}) {
  if (!['avaliacao', 'comentario'].includes(tipo)) throw Object.assign(new Error('Pedido inválido.'), { status: 400 });
  const destino = whatsapp.destinoDoLead(lead);
  if (!destino) throw Object.assign(new Error('Este cliente não tem WhatsApp.'), { status: 400 });
  const bot = whatsapp.botDoWhatsapp(empresa);
  if (tipo === 'avaliacao' && !bot?.linkAvaliacao) throw Object.assign(new Error('Salve antes o link de avaliação do Google (Máquina de vendas).'), { status: 400 });
  if (tipo === 'comentario' && !bot?.linkAnuncio) throw Object.assign(new Error('Salve antes o link do anúncio (Máquina de vendas).'), { status: 400 });
  const ja = pedidosFeitos(lead, empresa)[tipo];
  if (ja && !forcar) throw Object.assign(new Error('Este cliente já recebeu este pedido.'), { status: 409, jaEnviadoEm: ja });
  const texto = disparos.montarMensagem(mensagemDoPedido(empresa, tipo), lead, empresa);
  await whatsapp.enviarTexto(empresa, destino, texto);
  leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto, pedido: tipo });
  lead.pedidosManuais = { ...(lead.pedidosManuais || {}), [tipo]: agora() };
  // a automação do mesmo pedido não manda de novo para este cliente
  for (const r of automacoesDa(empresa).filter((x) => x.receita === tipo)) {
    const h = lead.automacoes?.[r.id] || { enviados: 0 };
    lead.automacoes = { ...(lead.automacoes || {}), [r.id]: { ...h, enviados: Math.max(h.enviados, r.maxPorLead), ultimoEm: agora(), manualPor: usuario } };
  }
  salvar();
  return { texto };
}

// Situação dos pedidos pós-venda de um cliente: tem link? a automação está ligada? em quanto tempo manda?
function posVenda(empresa, lead) {
  const bot = whatsapp.botDoWhatsapp(empresa);
  const feitos = pedidosFeitos(lead, empresa);
  const info = (tipo, link) => {
    const regra = automacoesDa(empresa).find((r) => r.receita === tipo && r.ativa);
    return { link: Boolean(link), automatica: Boolean(regra), horas: regra?.gatilho?.horas ?? null, jaPedido: feitos[tipo] };
  };
  return { avaliacao: info('avaliacao', bot?.linkAvaliacao), comentario: info('comentario', bot?.linkAnuncio) };
}

// "Não mandar" para este cliente: a automação do pedido não manda para ele
function naoMandarPedido(empresa, lead, tipo, usuario = '') {
  for (const r of automacoesDa(empresa).filter((x) => x.receita === tipo)) {
    const h = lead.automacoes?.[r.id] || { enviados: 0 };
    lead.automacoes = { ...(lead.automacoes || {}), [r.id]: { ...h, enviados: Math.max(h.enviados || 0, r.maxPorLead), puladoEm: agora(), puladoPor: usuario } };
  }
  salvar();
}

module.exports = {
  posVenda,
  naoMandarPedido,
  noHorarioComercial,
  proximosEnvios,
  agendarFollowupDaIa,
  cancelarFollowupsDaIa,
  quandoRetomar,
  vendaDoLead,
  pedidosFeitos,
  enviarPedidoManual,
  RECEITAS_DE_VENDA,
  RECEITAS,
  horarioAutomatico,
  automacoesDa,
  normalizarRegra,
  criarDeReceita,
  motivoInelegivel,
  resumo,
  agendarMensagem,
  enviarAgendadas,
  ciclo,
  iniciar
};
