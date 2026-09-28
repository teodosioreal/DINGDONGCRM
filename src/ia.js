// ia.js — conversa com a IA escolhida em cada assistente (Claude ou Gemini).

const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('./config');
const { estado } = require('./db');

const PROVEDORES = {
  anthropic: { nome: 'Claude (Anthropic)' },
  gemini: { nome: 'Gemini (Google)' }
};

const MODELOS_CLAUDE = [
  { id: 'claude-opus-5', nome: 'Claude Opus 5 (mais inteligente)' },
  { id: 'claude-sonnet-5', nome: 'Claude Sonnet 5 (equilibrado)' },
  { id: 'claude-haiku-4-5', nome: 'Claude Haiku 4.5 (mais rápido e barato)' }
];
// Sugestões usadas só se não der para consultar a lista real da sua chave do Google
const MODELOS_GEMINI_SUGERIDOS = [
  { id: 'gemini-2.5-flash', nome: 'gemini-2.5-flash' },
  { id: 'gemini-2.5-pro', nome: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash-lite', nome: 'gemini-2.5-flash-lite' }
];
const MODELO_PADRAO = { anthropic: 'claude-opus-5', gemini: 'gemini-2.5-flash' };

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const MARCADOR_WHATSAPP = /\[\[WHATSAPP\]\]\s*([\s\S]*)$/;

// ---------------------------------------------------------------- chaves

// A chave salva no painel (Configurações) tem prioridade sobre a do .env
function chave(provedor) {
  const salvas = estado.config || {};
  if (provedor === 'gemini') return salvas.geminiApiKey || config.geminiApiKey || '';
  return salvas.anthropicApiKey || config.anthropicApiKey || '';
}

function provedoresConfigurados() {
  return Object.keys(PROVEDORES).filter((p) => Boolean(chave(p)));
}

function erroSemChave(provedor) {
  const erro = new Error(`A chave do ${PROVEDORES[provedor].nome} não está configurada (painel → Configurações).`);
  erro.status = 503;
  return erro;
}

let clienteAnthropic = null;
let chaveDoCliente = null;
function obterClienteAnthropic() {
  const k = chave('anthropic');
  if (!k) throw erroSemChave('anthropic');
  if (!clienteAnthropic || chaveDoCliente !== k) {
    clienteAnthropic = new Anthropic({ apiKey: k, maxRetries: 2 });
    chaveDoCliente = k;
  }
  return clienteAnthropic;
}

// ---------------------------------------------------------------- modelos

function normalizarProvedor(p) {
  return p === 'gemini' ? 'gemini' : 'anthropic';
}

function normalizarModelo(provedor, modelo) {
  const m = String(modelo || '').trim().replace(/^models\//, '');
  if (provedor === 'anthropic') return MODELOS_CLAUDE.some((x) => x.id === m) ? m : MODELO_PADRAO.anthropic;
  return /^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(m) ? m : MODELO_PADRAO.gemini;
}

async function chamarGemini(caminho, opcoes = {}) {
  const k = chave('gemini');
  if (!k) throw erroSemChave('gemini');
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/${caminho}`, {
      ...opcoes,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k, ...(opcoes.headers || {}) },
      signal: AbortSignal.timeout(60000)
    });
  } catch (err) {
    const erro = new Error(`Falha de rede ao chamar o Gemini: ${err.message}`);
    erro.provedor = 'gemini';
    throw erro;
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    const erro = new Error(dados?.error?.message || `HTTP ${res.status}`);
    erro.status = res.status;
    erro.provedor = 'gemini';
    erro.motivo = dados?.error?.status || '';
    throw erro;
  }
  return dados;
}

let cacheGemini = { em: 0, chave: '', lista: null };
// Modelos de texto que a chave do Google pode usar (cache de 10 minutos)
async function listarModelosGemini() {
  const k = chave('gemini');
  if (cacheGemini.lista && cacheGemini.chave === k && Date.now() - cacheGemini.em < 10 * 60 * 1000) return cacheGemini.lista;
  const dados = await chamarGemini('models?pageSize=1000');
  const lista = (dados.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), nome: m.displayName || m.name }))
    .filter((m) => /gemini/i.test(m.id) && !/(embedding|tts|image|audio|live|vision)/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  cacheGemini = { em: Date.now(), chave: k, lista };
  return lista;
}

async function listarModelos(provedor) {
  if (provedor === 'gemini') {
    try {
      const lista = await listarModelosGemini();
      return { modelos: lista.length ? lista : MODELOS_GEMINI_SUGERIDOS, daChave: lista.length > 0 };
    } catch (err) {
      return { modelos: MODELOS_GEMINI_SUGERIDOS, daChave: false, aviso: descreverErroIa(err) };
    }
  }
  return { modelos: MODELOS_CLAUDE, daChave: false };
}

// Confere se a chave funciona sem gastar créditos (só lista modelos)
async function testarChave(provedor) {
  if (provedor === 'gemini') {
    cacheGemini = { em: 0, chave: '', lista: null };
    const lista = await listarModelosGemini();
    return `Chave do Gemini funcionando (${lista.length} modelos de texto disponíveis).`;
  }
  const client = obterClienteAnthropic();
  await client.models.list({ limit: 1 });
  return 'Chave do Claude funcionando.';
}

// ---------------------------------------------------------------- prompt

function montarPromptSistema(bot, empresa) {
  const nomeAssistente = bot.nomeAssistente || 'Assistente';
  const nicho = empresa?.nicho ? ` (${empresa.nicho})` : '';
  const tom = bot.tom || 'simpático, próximo e profissional';
  const temWhatsapp = Boolean(bot.whatsapp || empresa?.whatsapp);

  const partes = [
    `Você é ${nomeAssistente}, o assistente virtual de atendimento da empresa "${empresa?.nome || bot.nome}"${nicho}. Você conversa com visitantes do site da empresa por uma janela de chat parecida com o WhatsApp.`,
    '',
    'Como responder:',
    `- Português do Brasil, tom ${tom}.`,
    '- Mensagens curtas (1 a 4 frases), como numa conversa de WhatsApp. Nada de títulos, tabelas ou markdown pesado; no máximo *negrito* com um asterisco de cada lado e listas curtas com "-".',
    '- Use apenas as informações da seção "Sobre a empresa". Se a resposta não estiver lá (preço, prazo, disponibilidade, qualquer detalhe), não invente: diga que vai confirmar com a equipe.',
    '- Faça uma pergunta por vez para entender o que o cliente precisa.',
    '- Se perguntarem, deixe claro que você é um assistente virtual (uma IA), não uma pessoa.',
    '- Assuntos sem relação com a empresa: responda com educação que você só ajuda com assuntos da empresa.'
  ];

  if (temWhatsapp) {
    partes.push(
      '',
      'Passagem para o WhatsApp da equipe:',
      '- Quando o cliente quiser fechar, agendar, pedir orçamento personalizado, falar com uma pessoa, ou quando você não souber responder, convide-o a continuar no WhatsApp.',
      '- Nesses casos, termine a sua resposta com uma linha separada exatamente neste formato:',
      '[[WHATSAPP]] <mensagem que o cliente vai enviar para a equipe, em primeira pessoa, resumindo o que ele quer e os dados que ele já passou>',
      '- Exemplo: [[WHATSAPP]] Olá! Tenho um Onix 2020 e quero o revestimento completo. Moro no Quitandinha.',
      '- Use essa linha no máximo uma vez por resposta e só quando fizer sentido; o site transforma ela num botão "Continuar no WhatsApp".'
    );
  }

  if (bot.regras?.trim()) {
    partes.push('', 'Regras extras definidas pela empresa:', bot.regras.trim());
  }

  partes.push('', 'Sobre a empresa:', '<conhecimento>', (bot.conhecimento || '').trim() || '(nenhuma informação cadastrada ainda)', '</conhecimento>');

  return partes.join('\n');
}

// Converte o histórico salvo ({ papel: 'visitante'|'assistente', texto }) em
// turnos alternados. A primeira mensagem precisa ser do usuário, então pulamos
// eventuais mensagens do assistente no começo (ex.: a saudação automática).
function paraTurnos(historico) {
  const turnos = [];
  for (const m of historico) {
    const role = m.papel === 'visitante' ? 'user' : 'assistant';
    if (turnos.length === 0 && role !== 'user') continue;
    const ultimo = turnos[turnos.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n\n${m.texto}`;
    else turnos.push({ role, content: m.texto });
  }
  return turnos;
}

const RESPOSTA_RECUSA = 'Desculpe, não consigo ajudar com isso por aqui. Posso te ajudar com alguma dúvida sobre nossos serviços?';

// ---------------------------------------------------------------- provedores

async function responderClaude(bot, sistema, turnos) {
  const client = obterClienteAnthropic();
  const modelo = normalizarModelo('anthropic', bot.modelo);
  const params = {
    model: modelo,
    max_tokens: 4000,
    system: [{ type: 'text', text: sistema, cache_control: { type: 'ephemeral' } }],
    messages: turnos,
    // Conversa de atendimento: esforço baixo deixa as respostas rápidas e baratas.
    ...(modelo === 'claude-haiku-4-5' ? {} : { output_config: { effort: 'low' } })
  };

  const resposta =
    modelo === 'claude-opus-5'
      ? // Se o modelo recusar por segurança, a própria API tenta de novo num modelo reserva.
        await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);

  if (resposta.stop_reason === 'refusal') return { texto: RESPOSTA_RECUSA, recusado: true };
  const texto = resposta.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { texto };
}

async function responderGemini(bot, sistema, turnos) {
  const modelo = normalizarModelo('gemini', bot.modelo);
  const dados = await chamarGemini(`models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: turnos.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
      generationConfig: { maxOutputTokens: 4000, temperature: 0.6 }
    })
  });

  const candidato = dados.candidates?.[0];
  if (!candidato || dados.promptFeedback?.blockReason) return { texto: RESPOSTA_RECUSA, recusado: true };
  const texto = (candidato.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!texto.trim() && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(candidato.finishReason)) {
    return { texto: RESPOSTA_RECUSA, recusado: true };
  }
  return { texto };
}

/**
 * Gera a resposta do assistente.
 * @returns {{ texto: string, mensagemWhatsapp: string|null }}
 */
async function responder(bot, empresa, historico) {
  const turnos = paraTurnos(historico.slice(-30));
  if (turnos.length === 0) throw new Error('Nenhuma mensagem do visitante para responder.');
  const sistema = montarPromptSistema(bot, empresa);
  const provedor = normalizarProvedor(bot.provedor);

  const bruto = provedor === 'gemini' ? await responderGemini(bot, sistema, turnos) : await responderClaude(bot, sistema, turnos);
  if (bruto.recusado) return { texto: bruto.texto, mensagemWhatsapp: null };

  let texto = bruto.texto.trim();
  let mensagemWhatsapp = null;
  const marcador = texto.match(MARCADOR_WHATSAPP);
  if (marcador) {
    mensagemWhatsapp = marcador[1].trim() || null;
    texto = texto.slice(0, marcador.index).trim();
  }
  if (!texto) texto = 'Posso te passar para a nossa equipe no WhatsApp para continuar o atendimento?';
  return { texto, mensagemWhatsapp };
}

function descreverErroIa(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Chave do Claude inválida. Confira em Configurações.';
  if (err instanceof Anthropic.RateLimitError) return 'O Claude está recebendo muitas mensagens agora. Tente de novo em instantes.';
  if (err instanceof Anthropic.NotFoundError) return 'Modelo do Claude não encontrado para esta chave.';
  if (err instanceof Anthropic.BadRequestError) return `O Claude recusou o pedido: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Erro no Claude (HTTP ${err.status}).`;
  if (err.provedor === 'gemini') {
    if (/API_KEY_INVALID|API key not valid/i.test(err.message) || err.status === 401 || err.status === 403) {
      return 'Chave do Gemini inválida ou sem permissão. Confira em Configurações.';
    }
    if (err.status === 429) return 'Limite do Gemini atingido (cota da sua chave). Tente de novo mais tarde.';
    if (err.status === 404) return 'Modelo do Gemini não encontrado para esta chave. Escolha outro no assistente.';
    return `Erro no Gemini: ${err.message}`;
  }
  return err.message || 'Erro desconhecido na IA.';
}

module.exports = {
  responder,
  descreverErroIa,
  montarPromptSistema,
  listarModelos,
  testarChave,
  chave,
  provedoresConfigurados,
  normalizarProvedor,
  normalizarModelo,
  PROVEDORES,
  MODELO_PADRAO
};
