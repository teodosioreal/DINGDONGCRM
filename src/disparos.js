// disparos.js — disparos em massa pelo WhatsApp para os leads da empresa.
//
// Cuidados para o número não ser bloqueado pelo WhatsApp:
//  - só envia para quem já é lead da empresa (nunca para listas compradas);
//  - uma mensagem por vez, com intervalo aleatório entre elas;
//  - variações de texto ({Oi|Olá}) e o nome da pessoa ({nome});
//  - por padrão só envia em horário comercial;
//  - quem responde SAIR não recebe mais (e o CRM confirma);
//  - se a conexão cair, o disparo pausa sozinho (sem perder a fila).
// Quando o lead responde, a IA do WhatsApp continua a conversa normalmente.

const { estado, salvar, novoId, agora } = require('./db');
const { texto } = require('./util');
const leads = require('./leads');
const midias = require('./midias');
const whatsapp = require('./whatsapp');

const MAX_DESTINATARIOS = 2000;
const INTERVALO_MINIMO = 8; // segundos
const HORA_INICIO = 8;
const HORA_FIM = 20;

const timers = new Map();

function erro(mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { status });
}

// ---------------------------------------------------------------- quem recebe

function normalizarFiltro(f = {}) {
  const lista = (v) => (Array.isArray(v) ? v.map((x) => texto(x, 80)).filter(Boolean) : []);
  return {
    etapas: lista(f.etapas),
    etiquetas: lista(f.etiquetas),
    origem: ['site', 'whatsapp', 'manual'].includes(f.origem) ? f.origem : 'todos',
    leadIds: lista(f.leadIds)
  };
}

function destinatariosPara(empresa, filtroBruto) {
  const filtro = normalizarFiltro(filtroBruto);
  const vistos = new Set();
  const saida = [];
  const lista = estado.conversas
    .filter((c) => c.empresaId === empresa.id)
    .sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1));
  let semNumero = 0;
  let sairam = 0;
  for (const c of lista) {
    if (filtro.leadIds.length && !filtro.leadIds.includes(c.id)) continue;
    if (filtro.etapas.length && !filtro.etapas.includes(c.etapa)) continue;
    if (filtro.etiquetas.length && !(c.etiquetas || []).some((t) => filtro.etiquetas.includes(t))) continue;
    if (filtro.origem !== 'todos' && (c.origem || 'site') !== filtro.origem) continue;
    if (c.naoDisparar) {
      sairam++;
      continue;
    }
    const destino = whatsapp.destinoDoLead(c);
    if (!destino) {
      semNumero++;
      continue;
    }
    if (vistos.has(destino)) continue;
    vistos.add(destino);
    saida.push({ leadId: c.id, nome: c.nome || '', destino });
  }
  return { filtro, destinatarios: saida, semNumero, sairam };
}

// ---------------------------------------------------------------- texto

// {Oi|Olá|E aí} → escolhe uma; {nome} → primeiro nome; {nome_completo}; {empresa}
function montarMensagem(modelo, lead, empresa) {
  const nomeCompleto = String(lead?.nome || '').trim();
  const primeiro = nomeCompleto.split(/\s+/)[0] || '';
  const bot = estado.bots.find((b) => b.empresaId === empresa.id && b.principal) || estado.bots.find((b) => b.empresaId === empresa.id);
  const valores = {
    nome: primeiro,
    primeiro_nome: primeiro,
    nome_completo: nomeCompleto,
    empresa: empresa.nome || '',
    link_avaliacao: bot?.linkAvaliacao || '',
    link_anuncio: bot?.linkAnuncio || ''
  };
  let t = String(modelo || '').replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opcoes) => {
    const lista = opcoes.split('|');
    return lista[Math.floor(Math.random() * lista.length)];
  });
  t = t.replace(/\{(nome|primeiro_nome|nome_completo|empresa|link_avaliacao|link_anuncio)\}/gi, (_, v) => valores[v.toLowerCase()]);
  // "Oi , tudo bem?" quando não sabemos o nome
  return t.replace(/ +([,!?.])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

const RODAPE_SAIR = 'Para não receber mais mensagens, responda SAIR.';

// ---------------------------------------------------------------- execução

function horaEmSaoPaulo() {
  return Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
}

function dentroDoHorario(d) {
  if (!d.horarioComercial) return true;
  const h = horaEmSaoPaulo();
  return h >= HORA_INICIO && h < HORA_FIM;
}

function agendar(d, ms) {
  clearTimeout(timers.get(d.id));
  const t = setTimeout(() => {
    timers.delete(d.id);
    processar(d.id).catch((err) => console.error(`[disparo ${d.id}]`, err.message));
  }, Math.max(0, Math.min(ms, 60 * 60 * 1000)));
  t.unref?.();
  timers.set(d.id, t);
}

function sorteioIntervalo(d) {
  const min = Math.max(INTERVALO_MINIMO, d.intervaloMin || 20);
  const max = Math.max(min, d.intervaloMax || 60);
  return (min + Math.random() * (max - min)) * 1000;
}

function pausarPorErro(d, motivo) {
  d.status = 'pausado';
  d.motivoPausa = motivo;
  d.proximoEnvioEm = null;
  salvar();
}

async function processar(id) {
  const d = estado.disparos.find((x) => x.id === id);
  if (!d) return;
  if (d.status === 'agendado') {
    const falta = new Date(d.agendadoPara).getTime() - Date.now();
    if (falta > 1000) return agendar(d, falta);
    d.status = 'enviando';
    d.iniciadoEm = d.iniciadoEm || agora();
    salvar();
  }
  if (d.status !== 'enviando') return;
  const empresa = estado.empresas.find((e) => e.id === d.empresaId);
  if (!empresa) return pausarPorErro(d, 'Empresa não encontrada.');
  if (!whatsapp.configurado(empresa)) return pausarPorErro(d, 'O WhatsApp da empresa não está conectado.');

  if (!dentroDoHorario(d)) {
    d.proximoEnvioEm = null;
    d.aguardandoHorario = true;
    salvar();
    return agendar(d, 10 * 60 * 1000); // confere de novo em 10 minutos
  }
  d.aguardandoHorario = false;

  const item = d.destinatarios.find((x) => x.status === 'pendente');
  if (!item) {
    d.status = 'concluido';
    d.concluidoEm = agora();
    d.proximoEnvioEm = null;
    salvar();
    return;
  }

  const lead = estado.conversas.find((c) => c.id === item.leadId);
  if (!lead || lead.naoDisparar) {
    item.status = 'ignorado';
    item.erro = lead ? 'Pediu para não receber' : 'Lead apagado';
    item.em = agora();
    salvar();
    return agendar(d, 500);
  }

  const mensagem = montarMensagem(d.mensagem, lead, empresa) + (d.rodapeSair ? `\n\n${RODAPE_SAIR}` : '');
  const midia = d.midiaId ? midias.midiasDa(empresa).find((m) => m.id === d.midiaId) : null;
  try {
    let r;
    if (midia && midia.tipo !== 'audio') {
      // foto/vídeo/PDF com o texto como legenda: uma mensagem só
      r = await whatsapp.enviarMidia(empresa, item.destino, midia, mensagem);
    } else {
      r = await whatsapp.enviarTexto(empresa, item.destino, mensagem);
      if (midia) await whatsapp.enviarMidia(empresa, item.destino, midia);
    }
    // o WhatsApp devolve o JID de verdade (ex.: sem o 9 extra em números antigos)
    const jidReal = r?.key?.remoteJid;
    if (!lead.whatsappJid && /@s\.whatsapp\.net$/.test(jidReal || '')) lead.whatsappJid = jidReal;
    item.status = 'enviado';
    item.em = agora();
    leads.adicionarMensagem(lead, {
      papel: 'equipe',
      canal: 'whatsapp',
      texto: midia ? `${mensagem}\n[mídia: ${midia.nome}]` : mensagem,
      disparoId: d.id
    });
    lead.ultimoDisparoEm = agora();
  } catch (err) {
    // queda de conexão / servidor fora: pausa sem gastar a fila
    if (!err.status || err.status >= 500 || /connection closed|not connected|disconnected/i.test(err.message)) {
      return pausarPorErro(d, `Pausado: ${err.message}`);
    }
    item.status = 'erro';
    item.erro = /exists|not.*whatsapp|jid/i.test(err.message) ? 'Número sem WhatsApp' : err.message.slice(0, 200);
    item.em = agora();
  }
  const espera = sorteioIntervalo(d);
  d.proximoEnvioEm = new Date(Date.now() + espera).toISOString();
  salvar();
  agendar(d, espera);
}

// ---------------------------------------------------------------- operações

function criar(empresa, corpo, usuario) {
  const mensagem = texto(corpo.mensagem, 3000);
  if (!mensagem) throw erro('Escreva a mensagem.');
  if (!whatsapp.configurado(empresa)) throw erro('Conecte o WhatsApp da empresa antes de fazer disparos.');
  const midiaId = texto(corpo.midiaId, 60);
  if (midiaId && !midias.midiasDa(empresa).some((m) => m.id === midiaId)) throw erro('Mídia não encontrada.');
  const { filtro, destinatarios } = destinatariosPara(empresa, corpo.filtro);
  if (!destinatarios.length) throw erro('Nenhum lead com WhatsApp nesse filtro.');
  if (destinatarios.length > MAX_DESTINATARIOS) throw erro(`No máximo ${MAX_DESTINATARIOS} contatos por disparo. Filtre por etapa ou etiqueta.`);
  const min = Math.max(INTERVALO_MINIMO, Number(corpo.intervaloMin) || 20);
  const max = Math.max(min, Number(corpo.intervaloMax) || 60);
  let agendadoPara = null;
  if (corpo.agendadoPara) {
    const t = new Date(corpo.agendadoPara);
    if (Number.isNaN(t.getTime())) throw erro('Data de agendamento inválida.');
    if (t.getTime() > Date.now() + 60 * 1000) agendadoPara = t.toISOString();
  }
  const d = {
    id: novoId('dsp'),
    empresaId: empresa.id,
    nome: texto(corpo.nome, 100) || `Disparo de ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
    mensagem,
    midiaId: midiaId || null,
    filtro,
    intervaloMin: Math.min(min, 600),
    intervaloMax: Math.min(max, 900),
    horarioComercial: corpo.horarioComercial !== false,
    rodapeSair: corpo.rodapeSair !== false,
    status: agendadoPara ? 'agendado' : 'enviando',
    agendadoPara,
    destinatarios: destinatarios.map((x) => ({ ...x, status: 'pendente', erro: '', em: null })),
    criadoPor: usuario?.email || '',
    criadoEm: agora(),
    iniciadoEm: agendadoPara ? null : agora(),
    concluidoEm: null
  };
  estado.disparos.push(d);
  // guarda só os 200 mais recentes por empresa
  const daEmpresa = estado.disparos.filter((x) => x.empresaId === empresa.id);
  if (daEmpresa.length > 200) {
    const antigos = new Set(daEmpresa.slice(0, daEmpresa.length - 200).filter((x) => !['enviando', 'agendado'].includes(x.status)).map((x) => x.id));
    estado.disparos = estado.disparos.filter((x) => !antigos.has(x.id));
  }
  salvar();
  agendar(d, agendadoPara ? new Date(agendadoPara).getTime() - Date.now() : 1000);
  return d;
}

function pausar(d) {
  if (!['enviando', 'agendado'].includes(d.status)) throw erro('Este disparo não está em andamento.');
  clearTimeout(timers.get(d.id));
  timers.delete(d.id);
  d.status = 'pausado';
  d.motivoPausa = 'Pausado pela equipe';
  d.proximoEnvioEm = null;
  salvar();
}

function retomar(d) {
  if (d.status !== 'pausado') throw erro('Este disparo não está pausado.');
  d.status = 'enviando';
  d.motivoPausa = '';
  d.iniciadoEm = d.iniciadoEm || agora();
  salvar();
  agendar(d, 1000);
}

function cancelar(d) {
  if (['concluido', 'cancelado'].includes(d.status)) throw erro('Este disparo já terminou.');
  clearTimeout(timers.get(d.id));
  timers.delete(d.id);
  d.status = 'cancelado';
  d.concluidoEm = agora();
  d.proximoEnvioEm = null;
  for (const x of d.destinatarios) if (x.status === 'pendente') x.status = 'cancelado';
  salvar();
}

function apagar(d) {
  if (['enviando', 'agendado'].includes(d.status)) throw erro('Pause ou cancele o disparo antes de apagar.');
  estado.disparos = estado.disparos.filter((x) => x.id !== d.id);
  salvar();
}

function apagarTodosDa(empresaId) {
  for (const d of estado.disparos.filter((x) => x.empresaId === empresaId)) {
    clearTimeout(timers.get(d.id));
    timers.delete(d.id);
  }
  estado.disparos = estado.disparos.filter((x) => x.empresaId !== empresaId);
}

// Números do disparo para o painel (inclui quantos responderam depois)
function resumo(d) {
  const cont = { pendente: 0, enviado: 0, erro: 0, ignorado: 0, cancelado: 0 };
  let responderam = 0;
  for (const x of d.destinatarios) {
    cont[x.status] = (cont[x.status] || 0) + 1;
    if (x.status === 'enviado') {
      const lead = estado.conversas.find((c) => c.id === x.leadId);
      if (lead?.mensagens.some((m) => m.papel === 'visitante' && m.em > x.em)) responderam++;
    }
  }
  const { destinatarios, ...resto } = d;
  return { ...resto, total: destinatarios.length, ...cont, responderam };
}

// Ao subir o app: continua os disparos que estavam em andamento
function retomarAoIniciar() {
  for (const d of estado.disparos || []) {
    if (d.status === 'enviando') agendar(d, 5000);
    if (d.status === 'agendado') agendar(d, new Date(d.agendadoPara).getTime() - Date.now());
  }
}

module.exports = {
  RODAPE_SAIR,
  horaEmSaoPaulo,
  HORA_INICIO,
  HORA_FIM,
  destinatariosPara,
  montarMensagem,
  criar,
  pausar,
  retomar,
  cancelar,
  apagar,
  apagarTodosDa,
  resumo,
  retomarAoIniciar
};
