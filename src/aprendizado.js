// aprendizado.js — varredura das conversas do WhatsApp para a IA aprender com
// o atendimento de verdade (principalmente o que o dono/equipe responde à mão).
//
// - Roda sozinha todo dia às 8h (horário de Brasília) ou no botão "Varrer agora".
// - Da primeira vez lê o histórico que a Evolution API tem de cada conversa;
//   depois lê só as mensagens NOVAS (guarda até onde leu em cada conversa).
// - Conversa com venda concluída (lead em "Fechado" ou venda confirmada) é
//   lida uma última vez e depois não é mais lida.
// - O resultado é um arquivo de aprendizados (texto) que entra no prompt da
//   IA. A empresa pode ler, editar, baixar ou desligar.

const { estado, salvar, agora } = require('./db');
const ia = require('./ia');
const whatsapp = require('./whatsapp');
const disparos = require('./disparos');

const LIMITE_CARACTERES_POR_LOTE = 45000; // um pedido para a IA
const MAX_LOTES_POR_VARREDURA = 4; // o que sobrar fica para a próxima (economiza tokens)
const MAX_MENSAGENS_PRIMEIRA_LEITURA = 120; // por conversa
const MAX_CONVERSAS_LISTADAS = 1000;

const SISTEMA = `Você é um analista de vendas e atendimento. Você recebe conversas reais de WhatsApp de uma empresa com os clientes dela — TODAS terminaram em VENDA — e o documento de aprendizados atual. Sua tarefa é ATUALIZAR o documento para que a IA de atendimento da empresa atenda cada vez mais parecido com o dono/equipe e venda mais, repetindo o que funcionou nessas vendas (como abordou, o que perguntou, como apresentou o preço, como respondeu objeções e como fechou).

Regras:
- Aprenda principalmente com as mensagens do "Atendente" (pessoa da empresa). Mensagens marcadas "IA (automático)" foram escritas pelo robô: use só como contexto, não como exemplo de estilo.
- Mescle o que já existe com o que for novo. Não repita. Remova o que ficou desatualizado (ex.: preço que mudou — fique com o mais recente).
- NUNCA inclua dados pessoais de clientes (nomes, telefones, endereços, CPFs). Pode citar exemplos de frases do atendente.
- Só registre informações que aparecem nas conversas. Não invente.
- Máximo de ~1200 palavras. Português do Brasil. Tópicos curtos.

Responda SOMENTE com o documento atualizado, nestas seções (pule a seção se não houver nada):
## Tom e jeito de falar
## Como começa e qualifica o cliente
## Informações que o atendente passa (preços, prazos, condições, endereço)
## Objeções e como o atendente responde
## Como fecha a venda / próximos passos
## Perguntas frequentes e respostas
## O que evitar`;

function configDa(empresa) {
  const a = empresa.aprendizado || {};
  return {
    texto: a.texto || '',
    diario: a.diario !== false,
    // só aprende com conversas que deram venda (as que não venderam ficam de fora)
    somenteVendas: a.somenteVendas !== false,
    usarNoPrompt: a.usarNoPrompt !== false,
    ultimaVarredura: a.ultimaVarredura || null,
    ultimoDiaAutomatico: a.ultimoDiaAutomatico || '',
    historico: a.historico || [],
    checkpoints: a.checkpoints || {},
    concluidas: a.concluidas || {},
    pendentes: a.pendentes || 0
  };
}

function guardar(empresa, mudancas) {
  empresa.aprendizado = { ...configDa(empresa), ...(empresa.aprendizado || {}), ...mudancas };
  salvar();
}

// ---------------------------------------------------------------- ler a Evolution

async function listarConversas(empresa) {
  const r = await whatsapp.evolucao(empresa, 'POST', '/chat/findChats/{instancia}', { where: {} });
  const lista = Array.isArray(r) ? r : r?.chats || [];
  return lista
    .filter((c) => /@(s\.whatsapp\.net|lid)$/.test(c.remoteJid || ''))
    .map((c) => ({ jid: c.remoteJid, nome: c.pushName || '', ultima: Number(c.lastMessage?.messageTimestamp || 0) || (c.updatedAt ? Math.floor(new Date(c.updatedAt).getTime() / 1000) : 0) }))
    .sort((a, b) => b.ultima - a.ultima)
    .slice(0, MAX_CONVERSAS_LISTADAS);
}

async function mensagensNovas(empresa, jid, desde) {
  const saida = [];
  for (let pagina = 1; pagina <= 3; pagina++) {
    const where = { key: { remoteJid: jid } };
    if (desde) where.messageTimestamp = { gte: new Date((desde + 1) * 1000).toISOString(), lte: new Date(Date.now() + 60000).toISOString() };
    const r = await whatsapp.evolucao(empresa, 'POST', '/chat/findMessages/{instancia}', { where, page: pagina, offset: 50 });
    const registros = r?.messages?.records || [];
    saida.push(...registros);
    if (registros.length < 50 || (!desde && saida.length >= MAX_MENSAGENS_PRIMEIRA_LEITURA)) break;
  }
  return saida
    .filter((m) => !desde || Number(m.messageTimestamp) > desde)
    .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp))
    .slice(-MAX_MENSAGENS_PRIMEIRA_LEITURA);
}

function textoDaMensagem(m) {
  const msg = m.message || {};
  const t =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    '';
  const tipo = msg.imageMessage ? '[foto] ' : msg.audioMessage ? '[áudio] ' : msg.videoMessage ? '[vídeo] ' : msg.documentMessage ? '[arquivo] ' : msg.stickerMessage ? '[figurinha] ' : '';
  return `${tipo}${t}`.trim();
}

function leadDoJid(empresa, jid) {
  const achou = require('./identidade').conversaDoEndereco(empresa, jid);
  if (achou) return achou;
  const numero = jid.split('@')[0];
  return estado.conversas.find((c) => c.empresaId === empresa.id && (c.whatsappJid === jid || (c.telefone && c.telefone === numero)));
}

// Conversa de antes do CRM (sem lead): sinais de venda no texto, sem gastar IA
const SINAIS_DE_VENDA = /comprovante|paguei|pago\b|pagamento (feito|realizado|enviado)|pix (feito|enviado|realizado)|transferi|fechad[oa]|pode (agendar|marcar)|agendad[oa]|confirmad[oa]|obrigad[oa] pela (compra|prefer[eê]ncia)/i;
function temSinalDeVenda(mensagens) {
  return mensagens.some((m) => SINAIS_DE_VENDA.test(String(textoDaMensagem(m) || '')));
}

function vendaConcluida(empresa, lead) {
  if (!lead) return false;
  if (lead.vendaConcluidaManual === true) return true; // movida à mão para "Vendas concluídas"
  if (lead.etapa && require('./comprovantes').ehEtapaDeVenda(lead.etapa)) return true; // "Não fechado" não conta
  return (estado.vendas || []).some((v) => v.leadId === lead.id && v.status === 'confirmada');
}

// transcrição anônima (sem nome/telefone do cliente)
function transcrever(empresa, jid, mensagens, indice) {
  const lead = leadDoJid(empresa, jid);
  // textos que a IA/automação do CRM mandou: não servem de exemplo de estilo
  const doRobo = new Set((lead?.mensagens || []).filter((m) => m.papel === 'assistente' || m.disparoId || m.automacaoId).map((m) => String(m.texto || '').trim()));
  const linhas = [];
  for (const m of mensagens) {
    const t = textoDaMensagem(m);
    if (!t) continue;
    const quem = m.key?.fromMe ? (doRobo.has(t) ? 'IA (automático)' : 'Atendente') : 'Cliente';
    const quando = new Date(Number(m.messageTimestamp) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    linhas.push(`[${quando}] ${quem}: ${t.slice(0, 800).replace(/\d{10,13}/g, '[número]')}`);
  }
  return linhas.length ? `### Conversa ${indice}${lead?.etapa ? ` (etapa: ${lead.etapa})` : ''}\n${linhas.join('\n')}` : '';
}

// ---------------------------------------------------------------- varredura

const rodando = new Map(); // empresaId -> progresso

function progresso(empresa) {
  return rodando.get(empresa.id) || null;
}

async function varrer(empresa, { motivo = 'manual' } = {}) {
  if (rodando.has(empresa.id)) throw Object.assign(new Error('Já existe uma varredura em andamento.'), { status: 409 });
  if (!whatsapp.configurado(empresa)) throw Object.assign(new Error('Conecte o WhatsApp primeiro.'), { status: 400 });
  const bot = whatsapp.botDoWhatsapp(empresa);
  if (!bot) throw Object.assign(new Error('A empresa não tem assistente.'), { status: 400 });
  const prog = { etapa: 'Listando as conversas…', conversas: 0, lidas: 0, mensagens: 0, lotes: 0, inicio: agora() };
  rodando.set(empresa.id, prog);
  const registro = { em: agora(), motivo, conversas: 0, mensagens: 0, concluidasIgnoradas: 0, semVenda: 0, status: 'ok', erro: '' };
  try {
    const cfg = configDa(empresa);
    const checkpoints = { ...cfg.checkpoints };
    const concluidas = { ...cfg.concluidas };
    let texto = cfg.texto;
    const conversas = await listarConversas(empresa);
    prog.conversas = conversas.length;
    let lote = [];
    let tamanho = 0;
    let loteCheckpoints = {};
    let pendentes = 0;

    const enviarLote = async () => {
      if (!lote.length) return;
      prog.etapa = `A IA está estudando as conversas (parte ${prog.lotes + 1})…`;
      const pedido = `DOCUMENTO ATUAL DE APRENDIZADOS:\n${texto || '(vazio — primeira leitura)'}\n\nCONVERSAS NOVAS PARA ESTUDAR:\n\n${lote.join('\n\n')}`;
      const novo = await ia.comTarefa('aprendizado', () => ia.gerarTexto(bot, empresa, SISTEMA, pedido, 3000, { barato: true }));
      if (novo && novo.length > 40) texto = novo.replace(/^```\w*\n?|```$/g, '').trim();
      Object.assign(checkpoints, loteCheckpoints);
      prog.lotes++;
      // guarda o progresso a cada lote (se cair no meio, não perde o que já leu)
      guardar(empresa, { texto, checkpoints, concluidas });
      lote = [];
      tamanho = 0;
      loteCheckpoints = {};
    };

    for (const c of conversas) {
      if (concluidas[c.jid]) {
        registro.concluidasIgnoradas++;
        continue;
      }
      const desde = checkpoints[c.jid] || 0;
      if (desde && c.ultima && c.ultima <= desde) continue; // nada novo
      if (prog.lotes >= MAX_LOTES_POR_VARREDURA) {
        pendentes++;
        continue;
      }
      prog.etapa = `Lendo conversa ${prog.lidas + 1} de ${conversas.length}…`;
      const lead = leadDoJid(empresa, c.jid);
      let acabou = vendaConcluida(empresa, lead);
      // conversa sem venda: não estuda (e não marca como lida — se virar venda, lê tudo depois)
      if (cfg.somenteVendas && lead && !acabou) {
        registro.semVenda++;
        continue;
      }
      let novas;
      try {
        novas = await mensagensNovas(empresa, c.jid, desde);
      } catch (err) {
        console.error(`[aprendizado ${empresa.id}] ${c.jid}:`, err.message);
        continue;
      }
      prog.lidas++;
      if (cfg.somenteVendas && !lead) {
        if (!temSinalDeVenda(novas)) {
          registro.semVenda++;
          continue;
        }
        acabou = true;
      }
      const ultimaTs = Math.max(desde, ...novas.map((m) => Number(m.messageTimestamp) || 0));
      const bloco = transcrever(empresa, c.jid, novas, registro.conversas + 1);
      if (bloco) {
        if (tamanho + bloco.length > LIMITE_CARACTERES_POR_LOTE) await enviarLote();
        if (prog.lotes >= MAX_LOTES_POR_VARREDURA) {
          pendentes++;
          continue;
        }
        lote.push(bloco.slice(0, LIMITE_CARACTERES_POR_LOTE));
        tamanho += Math.min(bloco.length, LIMITE_CARACTERES_POR_LOTE);
        registro.conversas++;
        registro.mensagens += novas.length;
        prog.mensagens += novas.length;
      }
      loteCheckpoints[c.jid] = ultimaTs;
      if (acabou) concluidas[c.jid] = true; // venda concluída: lida uma última vez
    }
    await enviarLote();
    Object.assign(checkpoints, loteCheckpoints);
    registro.pendentes = pendentes;
    const historico = [registro, ...cfg.historico].slice(0, 30);
    guardar(empresa, { texto, checkpoints, concluidas, ultimaVarredura: agora(), historico, pendentes });
    return registro;
  } catch (err) {
    registro.status = 'erro';
    registro.erro = ia.descreverErroIa(err);
    guardar(empresa, { historico: [registro, ...configDa(empresa).historico].slice(0, 30) });
    throw Object.assign(new Error(registro.erro), { status: 502 });
  } finally {
    rodando.delete(empresa.id);
  }
}

// Chamado a cada minuto: às 8h (Brasília), uma vez por dia
function hojeEmSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function verificarAgenda(empresa) {
  const cfg = configDa(empresa);
  if (!cfg.diario || rodando.has(empresa.id) || !whatsapp.configurado(empresa)) return;
  // aprendizados fora do prompt (ex.: "Atualizar prompt"): a leitura diária com IA não serviria para nada
  if (cfg.usarNoPrompt === false) return;
  if (disparos.horaEmSaoPaulo() < 8) return;
  const hoje = hojeEmSaoPaulo();
  if (cfg.ultimoDiaAutomatico === hoje) return;
  guardar(empresa, { ultimoDiaAutomatico: hoje });
  varrer(empresa, { motivo: 'automática (8h)' }).catch((err) => console.error(`[aprendizado ${empresa.id}]`, err.message));
}

// "Reiniciar aprendizado da conversa": a varredura lê esta conversa de novo, do zero
function esquecerConversa(empresa, jid) {
  if (!jid || !empresa.aprendizado) return;
  const a = empresa.aprendizado;
  if (a.checkpoints) delete a.checkpoints[jid];
  if (a.concluidas) delete a.concluidas[jid];
  salvar();
}

function zerar(empresa) {
  if (rodando.has(empresa.id)) throw Object.assign(new Error('Espere a varredura terminar.'), { status: 409 });
  guardar(empresa, { texto: '', checkpoints: {}, concluidas: {}, historico: [], pendentes: 0, ultimaVarredura: null });
}

function resumo(empresa) {
  const cfg = configDa(empresa);
  const { checkpoints, concluidas, ...resto } = cfg;
  return {
    ...resto,
    conversasConhecidas: Object.keys(checkpoints).length,
    conversasConcluidas: Object.keys(concluidas).length,
    rodando: progresso(empresa)
  };
}

module.exports = { esquecerConversa, varrer, verificarAgenda, zerar, resumo, configDa, guardar, progresso, vendaConcluida };
