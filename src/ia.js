// ia.js — conversa com as IAs da empresa (Claude, GPT ou Gemini), com até
// 3 IAs em ordem: se a principal falhar, as reservas respondem.

const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('./config');
const { estado } = require('./db');
const { numeroDoAtendimento } = require('./util');
const { AsyncLocalStorage } = require('async_hooks');

// Para que serviu cada chamada à IA (resposta, foto, agenda…): vai junto com os tokens
// gastos, para o painel mostrar onde o dinheiro vai. comTarefa('agenda', () => …)
const tarefaAtual = new AsyncLocalStorage();
const comTarefa = (tarefa, fn) => tarefaAtual.run(tarefa, fn);

const PROVEDORES = {
  anthropic: { nome: 'Claude (Anthropic)' },
  openai: { nome: 'ChatGPT (OpenAI)' },
  gemini: { nome: 'Gemini (Google)' }
};

const MODELOS_CLAUDE = [
  { id: 'claude-opus-5-5', nome: 'Claude Opus 5.5 (mais inteligente)' },
  { id: 'claude-sonnet-5-5', nome: 'Claude Sonnet 5.5 (equilibrado)' },
  { id: 'claude-haiku-4-5', nome: 'Claude Haiku 4.5 (mais rápido e barato)' },
  { id: 'claude-opus-5', nome: 'Claude Opus 5 (anterior)' },
  { id: 'claude-sonnet-5', nome: 'Claude Sonnet 5 (anterior)' }
];
// modelos em que a própria API tenta de novo em outro modelo se recusar por segurança
const COM_FALLBACK = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// Sugestões usadas só se não der para consultar a lista real da sua chave do Google
const MODELOS_GEMINI_SUGERIDOS = [
  { id: 'gemini-flash-latest', nome: 'Flash mais novo (gemini-flash-latest)' },
  { id: 'gemini-flash-lite-latest', nome: 'Flash Lite mais novo (gemini-flash-lite-latest)' },
  { id: 'gemini-2.5-flash', nome: 'gemini-2.5-flash' },
  { id: 'gemini-2.5-pro', nome: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash-lite', nome: 'gemini-2.5-flash-lite' }
];
// Sugestões usadas só se não der para consultar a lista real da chave da OpenAI
const MODELOS_OPENAI_SUGERIDOS = [
  { id: 'gpt-5', nome: 'gpt-5' },
  { id: 'gpt-5-mini', nome: 'gpt-5-mini (mais barato)' },
  { id: 'gpt-4.1', nome: 'gpt-4.1' },
  { id: 'gpt-4.1-mini', nome: 'gpt-4.1-mini' },
  { id: 'gpt-4o-mini', nome: 'gpt-4o-mini' }
];
const MODELO_PADRAO = { anthropic: 'claude-opus-5-5', openai: 'gpt-5-mini', gemini: 'gemini-2.5-flash' };

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MARCADOR_WHATSAPP = /\[\[WHATSAPP\]\]\s*([\s\S]*)$/;

// ---------------------------------------------------------------- chaves

const CAMPO_CHAVE = { anthropic: 'anthropicApiKey', openai: 'openaiApiKey', gemini: 'geminiApiKey' };

// Chave usada para uma empresa: SÓ a dela — a de "IAs e chaves" ou, se não tiver, a que
// ela pôs numa IA da ordem (mesma IA). Nunca a de outra empresa nem a do servidor.
// formato de chave de cada IA (uma senha preenchida sozinha pelo navegador não passa)
function formatoDeChave(provedor, k) {
  const v = String(k || '');
  // Google: "AIza…" (antigas) ou "AQ.…" (formato novo); o que importa é ser comprida e sem espaço
  if (provedor === 'gemini') return /^[\w.-]{30,}$/.test(v);
  if (provedor === 'anthropic') return /^sk-ant-[\w-]{20,}$/.test(v);
  return /^sk-[\w-]{20,}$/.test(v);
}

function chaveDaEmpresa(provedor, empresa) {
  const propria = (empresa?.chavesIa || {})[CAMPO_CHAVE[provedor]];
  if (propria) return propria;
  const daOrdem = (Array.isArray(empresa?.motoresIa) ? empresa.motoresIa : []).find((m) => normalizarProvedor(m?.provedor) === provedor && formatoDeChave(provedor, m?.chave));
  return daOrdem?.chave || '';
}

function chavePadrao(provedor) {
  const salvas = estado.config || {};
  return salvas[CAMPO_CHAVE[provedor]] || config[CAMPO_CHAVE[provedor]] || '';
}

// Cada empresa usa SÓ as próprias chaves: a chave do servidor (Configurações/.env)
// não é usada por nenhuma empresa (o gasto de uma nunca cai na conta de outra).
function podeUsarChavePadrao(empresa) {
  return !empresa;
}

// 2ª chave do Gemini (opcional) só para as verificações do CRM: fotos, comprovantes, áudios,
// detector de agendamento, "Atualizar e conferir", aprendizado… As conversas com o cliente
// (resposta, follow-up, avisos) e o botão Testar ficam sempre na chave principal.
const TAREFAS_DE_RESPOSTA = new Set(['resposta', 'site', 'followup', 'evento', 'teste', 'outros']);
function chaveVerificacoes(empresa) {
  const k = (empresa?.chavesIa || {}).geminiApiKeyVerificacoes;
  return k && formatoDeChave('gemini', k) ? k : '';
}

function chave(provedor, empresa) {
  if (provedor === 'gemini') {
    const tarefa = tarefaAtual.getStore();
    const verif = chaveVerificacoes(empresa);
    if (verif && tarefa && !TAREFAS_DE_RESPOSTA.has(tarefa)) return verif;
  }
  return chaveDaEmpresa(provedor, empresa) || (podeUsarChavePadrao(empresa) ? chavePadrao(provedor) : '');
}

function provedoresConfigurados(empresa) {
  return Object.keys(PROVEDORES).filter((p) => Boolean(chave(p, empresa)));
}

function erroSemChave(provedor) {
  const erro = new Error(`A empresa ainda não cadastrou a chave do ${PROVEDORES[provedor].nome} (painel → empresa → IAs e chaves).`);
  erro.status = 503;
  return erro;
}

// um cliente por chave (cada empresa pode ter a sua)
const clientesAnthropic = new Map();
function clienteAnthropicPorChave(k) {
  if (!clientesAnthropic.has(k)) {
    if (clientesAnthropic.size > 200) clientesAnthropic.clear();
    // 1 nova tentativa só: se falhar, a IA reserva entra (mais rápido para o cliente)
    clientesAnthropic.set(k, new Anthropic({ apiKey: k, maxRetries: 1 }));
  }
  return clientesAnthropic.get(k);
}
function obterClienteAnthropic(empresa, chaveExplicita = '') {
  const k = chaveExplicita || chave('anthropic', empresa);
  if (!k) throw erroSemChave('anthropic');
  return clienteAnthropicPorChave(k);
}

// ---------------------------------------------------------------- modelos

function normalizarProvedor(p) {
  return p === 'gemini' || p === 'openai' ? p : 'anthropic';
}

function normalizarModelo(provedor, modelo) {
  const m = String(modelo || '').trim().replace(/^models\//, '');
  if (provedor === 'anthropic') return MODELOS_CLAUDE.some((x) => x.id === m) ? m : MODELO_PADRAO.anthropic;
  if (provedor === 'openai') return /^[a-z0-9][a-z0-9.\-:_]{1,80}$/i.test(m) ? m : MODELO_PADRAO.openai;
  return /^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(m) ? m : MODELO_PADRAO.gemini;
}

async function chamarGemini(empresa, caminho, opcoes = {}, chaveExplicita = '') {
  const k = chaveExplicita || chave('gemini', empresa);
  if (!k) throw erroSemChave('gemini');
  let res;
  const pedir = (naUrl) => fetch(`${GEMINI_BASE}/${caminho}${naUrl ? `${caminho.includes('?') ? '&' : '?'}key=${encodeURIComponent(k)}` : ''}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(naUrl ? {} : { 'x-goog-api-key': k }), ...(opcoes.headers || {}) },
    signal: AbortSignal.timeout(60000)
  });
  try {
    res = await pedir(false);
    // chave no formato novo do Google ("AQ.…") recusada no cabeçalho: tenta do outro jeito (na URL)
    if (!k.startsWith('AIza') && [401, 403, 404].includes(res.status)) {
      const outra = await pedir(true);
      if (outra.ok || outra.status !== res.status) res = outra;
    }
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

// Modelos de texto que a chave do Google pode usar (cache de 10 minutos por chave)
const cacheGemini = new Map();
async function listarModelosGemini(empresa, forcar, chaveExplicita = '') {
  const k = chaveExplicita || chave('gemini', empresa);
  const guardado = cacheGemini.get(k);
  if (!forcar && guardado && Date.now() - guardado.em < 10 * 60 * 1000) return guardado.lista;
  const dados = await chamarGemini(empresa, 'models?pageSize=1000', {}, k);
  const lista = (dados.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), nome: m.displayName || m.name }))
    .filter((m) => /gemini/i.test(m.id) && !/(embedding|tts|image|audio|live|vision)/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (cacheGemini.size > 200) cacheGemini.clear();
  cacheGemini.set(k, { em: Date.now(), lista });
  return lista;
}

// Modelos de chat que a chave da OpenAI pode usar
// Modelo do Gemini que ESTA chave tem. Conta nova do Google não tem os modelos antigos
// (ex.: gemini-2.5-flash): em vez de "modelo não encontrado", usa o equivalente que a chave
// tiver (Flash → o Flash mais novo; Pro → o Pro mais novo; Lite → o Lite mais novo).
const trocasGemini = new Map(); // `${chave}|${modelo pedido}` → modelo que a chave tem
const foraDoAr = new Map(); // `${chave}|${modelo}` → até quando evitar (Google sobrecarregado)
const aposentados = new Set(); // `${chave}|${modelo}`: "no longer available to new users"
const ultimoGemini = new Map(); // chave → modelo que respondeu por último
const semNivel = new Set(); // modelos que recusam o "pensar pouco" (thinkingLevel): vão sem ele
function versaoGemini(id) {
  const m = String(id).match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}
// modelos de texto parecidos com o pedido, do melhor para o pior (sem os que falharam)
async function candidatosGemini(empresa, k, desejado, evitar = []) {
  let lista = [];
  try { lista = await listarModelosGemini(empresa, false, k); } catch { return []; }
  const fora = (id) => evitar.includes(id) || aposentados.has(`${k}|${id}`) || (foraDoAr.get(`${k}|${id}`) || 0) > Date.now();
  const ids = lista.map((x) => x.id).filter((id) => !/transcribe|omni|robotics|customtools|computer-use|antigravity|research|gemma|nano|lyria/i.test(id));
  const tipo = /pro/i.test(desejado) ? 'pro' : /lite/i.test(desejado) ? 'lite' : 'flash';
  const doTipo = (id) => (tipo === 'pro' ? /pro/i.test(id) : /flash/i.test(id) && (tipo === 'lite') === /lite/i.test(id));
  const estavel = (id) => !/preview|exp|thinking|latest|-\d{2}-\d{2}|\d{3,}$/i.test(id);
  const ordem = (a, b) => versaoGemini(b) - versaoGemini(a) || a.length - b.length;
  const grupos = [
    ids.filter((id) => id === desejado),
    ids.filter((id) => doTipo(id) && estavel(id)).sort(ordem),
    ids.filter((id) => doTipo(id) && /latest/i.test(id)),
    ids.filter((id) => doTipo(id)).sort(ordem),
    ids.filter((id) => /flash/i.test(id) && estavel(id)).sort(ordem), // qualquer Flash estável (inclui Lite)
    ids.filter((id) => /flash/i.test(id) && /latest/i.test(id)) // último recurso: os "latest" (Lite costuma estar livre)
  ];
  return [...new Set(grupos.flat())].filter((id) => !fora(id));
}
async function modeloGeminiDaChave(empresa, k, desejado, evitar = []) {
  return (await candidatosGemini(empresa, k, desejado, evitar))[0] || null;
}
// Chama o Gemini com o modelo pedido; se o Google disser que ele não existe/aposentou (404)
// troca para o que o Google indica (ou o melhor da chave) e guarda a troca; se estiver
// sobrecarregado (503/500), tenta na hora o próximo modelo parecido (até 2), sem gravar nada.
async function comModeloGemini(empresa, k, desejado, fazer) {
  const chaveTroca = `${k}|${desejado}`;
  let atual = trocasGemini.get(chaveTroca) || desejado;
  // sobrecarregado há pouco: já começa pelo próximo
  if ((foraDoAr.get(`${k}|${atual}`) || 0) > Date.now()) {
    const ultimo = ultimoGemini.get(k);
    atual = ultimo && (foraDoAr.get(`${k}|${ultimo}`) || 0) <= Date.now() ? ultimo : (await candidatosGemini(empresa, k, desejado, [atual]))[0] || atual;
  }
  const tentados = [];
  let sobrecargas = 0;
  for (let volta = 0; volta < 7; volta++) {
    tentados.push(atual);
    try {
      const r = await fazer(atual);
      if (ultimoGemini.size > 500) ultimoGemini.clear();
      ultimoGemini.set(k, atual);
      return r;
    } catch (err) {
      const msg = String(err.message || '');
      if (err.status === 404) {
        aposentados.add(`${k}|${atual}`);
        const indicado = msg.match(/use models\/([\w.-]+)/i)?.[1];
        const lista = await candidatosGemini(empresa, k, desejado, tentados);
        const novo = indicado && !tentados.includes(indicado) && lista.includes(indicado) ? indicado : lista[0];
        if (!novo) throw err;
        console.error(`[ia ${empresa?.id || '-'}] Gemini: "${atual}" não está disponível nesta chave; usando "${novo}"`);
        if (trocasGemini.size > 500) trocasGemini.clear();
        trocasGemini.set(chaveTroca, novo);
        // a empresa passa a usar o modelo novo (aparece na tela Chave da IA)
        for (const m of Array.isArray(empresa?.motoresIa) ? empresa.motoresIa : []) if (normalizarProvedor(m.provedor) === 'gemini' && m.modelo === atual) { m.modelo = novo; require('./db').salvar(); }
        atual = novo;
        continue;
      }
      if ((err.status === 503 || err.status === 500 || /timeout|aborted|rede/i.test(msg)) && tentados.length < 5) {
        foraDoAr.set(`${k}|${atual}`, Date.now() + 2 * 60 * 1000);
        sobrecargas++;
        const lista = await candidatosGemini(empresa, k, desejado, tentados);
        // 2 Flash sobrecarregados seguidos: vai para um Lite (costuma estar livre quando o Flash lota)
        const proximo = sobrecargas >= 2 ? lista.find((id) => /lite/i.test(id)) || lista[0] : lista[0];
        if (!proximo) throw err;
        console.error(`[ia ${empresa?.id || '-'}] Gemini: "${atual}" sobrecarregado; tentando "${proximo}"`);
        atual = proximo;
        continue;
      }
      throw err;
    }
  }
  throw new Error('O Gemini não respondeu com nenhum modelo da chave.');
}

async function listarModelosOpenai(chaveOpenai) {
  const dados = await chamarOpenai(chaveOpenai, 'models', null, { metodo: 'GET', timeout: 20000 });
  return (dados.data || [])
    .map((m) => String(m.id || ''))
    .filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id) && !/(audio|realtime|tts|image|embedding|transcribe|search|instruct|moderation|codex|computer)/i.test(id))
    .sort()
    .map((id) => ({ id, nome: id }));
}

async function listarModelos(provedor, empresa) {
  if (provedor === 'openai') {
    const k = chave('openai', empresa);
    if (!k) return { modelos: MODELOS_OPENAI_SUGERIDOS, daChave: false };
    try {
      const lista = await listarModelosOpenai(k);
      return { modelos: lista.length ? lista : MODELOS_OPENAI_SUGERIDOS, daChave: lista.length > 0 };
    } catch (err) {
      return { modelos: MODELOS_OPENAI_SUGERIDOS, daChave: false, aviso: descreverErroIa(err) };
    }
  }
  if (provedor === 'gemini') {
    try {
      const lista = await listarModelosGemini(empresa);
      return { modelos: lista.length ? lista : MODELOS_GEMINI_SUGERIDOS, daChave: lista.length > 0 };
    } catch (err) {
      return { modelos: MODELOS_GEMINI_SUGERIDOS, daChave: false, aviso: descreverErroIa(err) };
    }
  }
  return { modelos: MODELOS_CLAUDE, daChave: false };
}

// Confere se a chave funciona sem gastar créditos (só lista modelos).
// `empresa` pode ser null para testar a chave padrão.
async function testarChave(provedor, empresa, chaveExplicita = '') {
  if (provedor === 'gemini') {
    let lista = [];
    let erroLista = null;
    try { lista = await listarModelosGemini(empresa, true, chaveExplicita); } catch (err) { erroLista = err; }
    // teste de verdade: o modelo que a empresa usa responde com esta chave (poucos tokens)
    const motor = (empresa?.motoresIa || []).find((m) => normalizarProvedor(m.provedor) === 'gemini');
    if (empresa && motor) {
      const k = chaveExplicita || chave('gemini', empresa);
      const modelo = (await modeloGeminiDaChave(empresa, k, normalizarModelo('gemini', motor.modelo))) || motor.modelo;
      await testarMotor(empresa, { provedor: 'gemini', modelo, chave: chaveExplicita || '' });
      const usado = ultimoGemini.get(k) || modelo;
      return `Chave do Gemini funcionando · o modelo ${usado} respondeu. A IA já pode atender.`;
    }
    if (erroLista) throw erroLista;
    return `Chave do Gemini funcionando (${lista.length} modelos de texto disponíveis).`;
  }
  if (provedor === 'openai') {
    const k = chaveExplicita || chave('openai', empresa);
    if (!k) throw erroSemChave('openai');
    const lista = await listarModelosOpenai(k);
    return `Chave do ChatGPT funcionando (${lista.length} modelos disponíveis).`;
  }
  await obterClienteAnthropic(empresa, chaveExplicita).models.list({ limit: 1 });
  return 'Chave do Claude funcionando.';
}

// Testa um motor de verdade (um pedido bem curto no modelo escolhido)
async function testarMotor(empresa, m) {
  const r = await comTarefa('teste', () => chamarMotor(empresa, m, { turnos: [{ role: 'user', content: 'Responda só: ok' }], maxTokens: 16, temperatura: 0 }));
  return r.texto;
}

// ---------------------------------------------------------------- prompt

// Monta o prompt de sistema de um canal ('site' ou 'whatsapp').
// `contexto` traz o que a IA pode usar além do texto: etapas do funil, etapa
// atual do lead e as mídias que ela pode mandar no WhatsApp.
function montarPromptSistema(bot, empresa, canal = 'site', contexto = {}) {
  const nomeAssistente = bot.nomeAssistente || 'Assistente';
  const nicho = empresa?.nicho ? ` (${empresa.nicho})` : '';
  const tom = bot.tom || 'simpático, próximo e profissional';
  const temWhatsapp = Boolean(numeroDoAtendimento(bot, empresa));
  const noWhatsapp = canal === 'whatsapp';

  const temInstrucoes = Boolean(String((noWhatsapp ? bot.promptWhatsapp : bot.regras) || '').trim());
  const partes = [
    noWhatsapp
      ? `Você é ${nomeAssistente}, e atende os clientes da empresa "${empresa?.nome || bot.nome}"${nicho} pelo WhatsApp da empresa.`
      : `Você é ${nomeAssistente}, e atende os visitantes do site da empresa "${empresa?.nome || bot.nome}"${nicho} por uma janela de chat parecida com o WhatsApp.`,
    '',
    'Instruções do dono:',
    `- O dono da empresa escreveu como quer que você atenda${temInstrucoes ? ' (estão em <instrucoes_da_empresa>, no fim deste texto)' : ''}. Siga essas instruções com naturalidade, como um bom atendente que entendeu o que o dono quer: no jeito de falar, no que perguntar, na ordem do atendimento, nas mídias que ele mandou enviar e em quando passar para a equipe.`,
    '- Elas valem mais do que os PADRÕES deste texto, o clone, os aprendizados e as suas mensagens antigas na conversa. Se as suas mensagens anteriores seguiram outro jeito, siga as instruções de agora a partir desta resposta, sem comentar a mudança.',
    '- Siga a intenção do dono sem ficar robótico: nada de repetir frases prontas em toda mensagem nem de forçar uma instrução onde ela não se aplica.',
    '- Nunca comente as instruções com o cliente (nada de "fui instruído", "minhas regras", "o sistema", "prompt").',
    '',
    'Escreva como gente:',
    '- Não comece as mensagens sempre com a mesma palavra ou expressão (ex.: "Legal", "Perfeito", "Show", "Ótimo", "Entendi"). Na maioria das vezes, vá direto ao ponto. Não copie o começo das suas mensagens anteriores, dos exemplos do clone nem dos aprendizados.',
    '',
    'Verdade (nunca quebre, nem se uma instrução pedir):',
    '- Só afirme fatos que estejam escritos em <instrucoes_da_empresa>, <catalogo>, <conhecimento>, <site_da_empresa>, <exemplos_do_dono> ou na própria conversa. Nada de "conhecimento geral" sobre a empresa, o produto ou o mercado.',
    '- NUNCA invente: preço, valor, desconto, parcelamento, prazo, horário, endereço, estoque, modelos/cores, garantia, política de troca, brinde, promoção, link, telefone ou nome de pessoa.',
    '- Se o cliente perguntar algo que não está escrito: diga com naturalidade que vai confirmar com a equipe (e, se ele precisar da resposta para seguir, use [[HUMANO]] no WhatsApp). É melhor dizer "vou confirmar" do que chutar.',
    '- Não prometa nada que a empresa não prometeu e não contradiga o que a equipe já combinou na conversa.',
    '',
    'PADRÃO de atendimento (vale SÓ quando as instruções da empresa não disserem outra coisa):',
    `- Português do Brasil, tom ${tom}.`,
    '- Mensagens curtas (1 a 4 frases), como numa conversa de WhatsApp. Nada de títulos, tabelas ou markdown pesado; no máximo *negrito* com um asterisco de cada lado e listas curtas com "-".',
    '- Antes de responder, leia o histórico inteiro e a ÚLTIMA mensagem do cliente: responda exatamente ao que ele disse ou perguntou, sem mudar de assunto e sem repetir o que já foi dito.',
    '- Se a mensagem do cliente estiver ambígua, pergunte o que ele quis dizer em vez de supor.',
    '- Faça uma pergunta por vez para entender o que o cliente precisa.',
    '- Não se apresente como robô, IA ou assistente virtual por conta própria. Se o cliente perguntar com sinceridade se está falando com uma pessoa, não minta: diga com naturalidade que é o atendimento automático da empresa e que uma pessoa da equipe pode assumir quando ele quiser.',
    '- Assuntos sem relação com a empresa: responda com educação que você só ajuda com assuntos da empresa.',
    '',
    'Ordem de prioridade quando uma coisa conflitar com outra:',
    '1) <instrucoes_da_empresa> (o que o dono mandou fazer) → 2) <catalogo> (serviços, produtos e preços) → 3) <conhecimento> (Sobre a empresa) → 4) o que a equipe combinou na conversa → 5) <site_da_empresa> → 6) <aprendizados> e clone → 7) os PADRÕES e dicas gerais deste texto.'
  ];

  if (noWhatsapp) {
    partes.push(
      '',
      'Continuidade do atendimento:',
      '- O histórico pode ter começado no chat do site da empresa (outra IA, a do site, atendeu antes). Você CONTINUA essa mesma conversa: não se apresente de novo do zero, não repita perguntas que o cliente já respondeu e retome de onde parou.',
      '- Mensagens marcadas como "(equipe)" foram escritas por uma pessoa da empresa. Respeite o que a equipe combinou.',
      '- Áudios do cliente chegam transcritos ("[áudio do cliente]: …") e fotos chegam descritas ("[foto do cliente]: …"): responda ao conteúdo normalmente, sem comentar que foi transcrito. Se vier só "[o cliente enviou um áudio]" sem texto, peça com educação para ele escrever.'
    );

    const midias = contexto.midias || [];
    if (midias.length) {
      const codigoVisivel = require('./midias').codigoVisivel;
      const TIPO = { image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'documento' };
      partes.push(
        '',
        '==================================================',
        'MÍDIAS DISPONÍVEIS (INTERNO)',
        '==================================================',
        'Você só consegue enviar uma mídia escrevendo o código dela. Regras:',
        '- Escreva o código na ÚLTIMA linha da resposta, sozinho, exatamente como está aqui. Mais de uma mídia: um código por linha, todos no fim.',
        '- Se você mencionar que vai mandar foto, vídeo ou áudio, o código é obrigatório na mesma resposta.',
        '- Quando as instruções do dono mandarem enviar uma mídia (o código aparece junto, ex.: "(mídia #MIDIA_X)"), envie essa mídia escrevendo o código na situação que ele descreveu. Isso vale mais do que o clone e os aprendizados.',
        '- Nunca escreva um código que não esteja nesta lista. O cliente pediu foto de um modelo, item, cor ou tamanho específico? Procure isso no "mostra" e no "quando enviar" de cada mídia e use o código dela; se nenhuma for disso, diga que não tem foto disso agora (sem código).',
        '- Nunca explique o código para o cliente.',
        '- Mídias marcadas como JÁ ENVIADA (em "Contexto desta conversa", no fim) não podem ser enviadas de novo — exceto as marcadas "pode repetir", e só se o cliente pedir.',
        ...(midias.some((m) => m.etapas?.length) ? ['- "só na etapa": a mídia só sai quando o lead estiver nessa etapa do funil.'] : []),
        ...(midias.some((m) => m.assuntos?.length) ? ['- "assunto": só mande quando estiver falando DAQUELE assunto; se ainda não sabe qual o cliente quer, pergunte antes.'] : []),
        '',
        'Lista:',
        ...midias.map((m) =>
          [
            `- ${m.numero ? `#MIDIA_${m.numero}` : codigoVisivel(m.codigo)}`,
            m.album ? `álbum com ${m.quantidade} arquivos` : TIPO[m.tipo] || 'arquivo',
            m.nome ? `mostra: ${m.nome}` : '',
            `quando enviar: ${m.quando || 'quando ajudar o cliente'}`,
            m.etapas?.length ? `só na etapa: ${m.etapas.join(' ou ')}` : '',
            m.assuntos?.length ? `assunto: ${m.assuntos.join(' ou ')}` : '',
            m.servicos?.length ? `serviço: ${m.servicos.join(' / ')}` : '',
            m.umaVez === false ? 'pode repetir' : ''
          ]
            .filter(Boolean)
            .join(' | ')
        )
      );
    }
    partes.push(
      '',
      'Follow-up (retomar a conversa depois):',
      '- Quando o cliente pedir para falar depois ("me chama amanhã", "vou ver com minha esposa e te aviso", "semana que vem eu vejo") ou quando fizer sentido lembrar ele mais tarde, combine com naturalidade e escreva numa linha separada: [[RETOMAR: quando | sobre o quê | mensagem que será enviada na hora]].',
      '- "quando" pode ser: 2h, 30min, 1d, 3d ou dd/mm/aaaa hh:mm (horário de Brasília). Ex.: [[RETOMAR: 1d | saber se conversou com a esposa | Oi! Conseguiu conversar com sua esposa sobre o orçamento? 😊]]. A mensagem é curta, natural, no tom da conversa, e só usa informação verdadeira.',
      '- Na hora marcada você mesmo escreve a mensagem de retomada. Se o cliente responder antes, o follow-up é cancelado sozinho. Use no máximo um por vez.',
      '',
      'Passar para uma pessoa da equipe:',
      '- Quando o cliente pedir para falar com uma pessoa, quando for fechar negócio/agendar e as instruções mandarem passar para a equipe, ou quando você não souber resolver, avise que vai chamar alguém da equipe e escreva na última linha, sozinho: #PAUSAR. Depois disso você para de responder e a equipe assume.',
      '',
      'Avisos internos da plataforma:',
      '- Mensagens que chegam só com um código entre colchetes, como [CLIENTE_ENVIOU_FOTO], [SEM_RESPOSTA], [CHECAR_VIDEO] ou [FOLLOWUP_1], são avisos internos do sistema: o cliente NÃO escreveu isso e nunca vê. Responda ao cliente de acordo com a situação (ex.: [SEM_RESPOSTA] = ele parou de responder; [CHECAR_VIDEO] = pergunte com naturalidade se conseguiu ver o vídeo; [FOLLOWUP_1] = primeira retomada da conversa). Nunca cite o aviso.',
      '- Se não houver nada útil para dizer ao cliente, responda só: #NADA'
    );
  } else {
    if (temWhatsapp) {
      partes.push(
        '',
        'Passagem para o WhatsApp (lá outra IA continua o atendimento com todo o histórico):',
        '- Quando o cliente quiser fechar, agendar, pedir orçamento personalizado, falar com uma pessoa, ou quando você não souber responder, convide-o a continuar no WhatsApp.',
        '- Nesses casos, termine a sua resposta com uma linha separada exatamente neste formato:',
        '[[WHATSAPP]] <mensagem que o cliente vai enviar pelo WhatsApp, em primeira pessoa, resumindo o que ele quer e os dados que ele já passou>',
        '- Exemplo: [[WHATSAPP]] Olá! Quero o orçamento do serviço que vi no site. Moro no centro.',
        '- Use essa linha no máximo uma vez por resposta e só quando fizer sentido; o site transforma ela num botão "Continuar no WhatsApp".'
      );
    }
  }

  const links = contexto.links || [];
  if (links.length) {
    partes.push(
      '',
      'Links que você pode mandar (copie o endereço exatamente como está, sozinho numa linha):',
      ...links.map((l) => `- ${l.nome}: ${l.url}${l.descricao ? ` — quando usar: ${l.descricao}` : ''}`)
    );
  }

  // Técnica de vendas: conduzir para o próximo passo sem ser insistente
  partes.push(
    '',
    'PADRÃO — como vender bem, sem ser chato (as instruções da empresa mandam mais que isto):',
    `- Seu objetivo é levar o cliente ao próximo passo${bot.objetivo?.trim() ? `: ${bot.objetivo.trim()}` : ' (fechar, agendar ou pedir o orçamento)'}. Toda resposta termina com uma pergunta simples ou um próximo passo claro.`,
    '- Entenda a necessidade antes de falar de preço. Depois mostre o benefício para ELE (resultado, economia, praticidade), não só características.',
    '- Objeção de preço: reforce o valor, compare com o custo de não resolver e ofereça as formas de pagamento cadastradas. Objeção de tempo/dúvida: facilite (horários, garantia, prova social) e proponha um passo pequeno.',
    '- Quando o cliente mostrar interesse, proponha fechar ou agendar na hora, com opções concretas (ex.: "prefere terça ou quinta?").',
    '- Crie urgência só com informação verdadeira que estiver em "Sobre a empresa" (vagas, promoção, prazo). Nunca invente desconto, prazo ou brinde.',
    '- Se o cliente sumir ou disser "vou pensar", responda com leveza, tire a última dúvida e deixe a porta aberta.'
  );
  if (bot.oferta?.trim()) partes.push(`- Oferta/diferenciais para usar na conversa: ${bot.oferta.trim()}`);

  const etapas = contexto.etapas || [];
  if (etapas.length) {
    partes.push(
      '',
      'Etapas do funil de atendimento (onde o lead está):',
      ...etapas.map((e) => { const s = require('./leads').significadoEtapa(e); return `- ${e}${s ? ` (${s})` : ''}`; }),
      '- A etapa atual do lead está em "Contexto desta conversa", no fim.',
      '- Quando o atendimento avançar (ou o cliente desistir), mova o lead escrevendo numa linha separada: [[ETAPA: nome exato da etapa]]. Use só nomes desta lista e só quando a etapa realmente mudar.'
    );
  }

  const etiquetas = contexto.etiquetas || [];
  if (etiquetas.length) {
    partes.push(
      '',
      'Etiquetas que você pode colocar no lead (para a equipe se organizar):',
      ...etiquetas.map((e) => `- ${e.nome}`),
      '- Para marcar, escreva numa linha separada: [[ETIQUETA: nome exato]]. Só use nomes desta lista e só quando tiver certeza (ex.: o cliente mostrou muito interesse).'
    );
  }

  partes.push(
    '',
    'Registrar vendas e agendamentos (a equipe vê um aviso na conversa e a venda vai para o Faturamento):',
    '- A data e a hora de agora estão em "Contexto desta conversa", no fim. Use para transformar "amanhã", "sábado" etc. em data.',
    '- Quando o cliente CONFIRMAR a compra (fechou o pedido e combinou o pagamento, ou avisou que pagou), escreva numa linha separada: [[VENDA: valor | o que ele comprou]] — ex.: [[VENDA: 350,00 | o produto ou serviço que ele comprou]]. Sem valor certo, deixe o valor vazio: [[VENDA: | o que ele comprou]].',
    '- Quando o cliente CONFIRMAR um dia e horário (visita, serviço, consulta, instalação, entrega), escreva numa linha separada: [[AGENDAMENTO: dd/mm/aaaa hh:mm | o que foi agendado]] — ex.: [[AGENDAMENTO: 04/10/2026 09:00 | o serviço agendado]].',
    '- Quando o cliente DESMARCAR ou cancelar um agendamento já registrado (sem marcar outro), escreva numa linha separada: [[DESMARCAR]]. Se ele trocar de dia/horário, use [[AGENDAMENTO: …]] com o horário novo (o antigo sai sozinho).',
    '- Só marque o que foi confirmado pelo cliente (horário apenas sugerido ou "vou ver" não conta) e não marque de novo o que já está registrado (veja "Contexto desta conversa"). Remarcou? Marque o novo horário.',
    '- Pergunta sobre disponibilidade NÃO é agendamento: "atende hoje?", "tem horário amanhã?", "consegue sábado?" e um "sim" para isso não marcam nada. Só marque quando ficar combinado um DIA e um HORÁRIO certos.',
    ...(empresa?.agendaExigeEndereco !== false ? ['- Antes de marcar [[AGENDAMENTO]], você precisa do ENDEREÇO completo do cliente (rua, número e bairro, ou a localização do WhatsApp). Se ainda não tiver (veja "Contexto desta conversa"), peça o endereço e só marque depois que ele mandar.'] : []),
    '',
    'Localização do cliente (a equipe vê como etiqueta 📍 na conversa):',
    '- Quando o cliente disser onde mora ou onde está (cidade, bairro, região), escreva numa linha separada: [[LOCAL: bairro/cidade - UF]] — ex.: [[LOCAL: Quitandinha, Petrópolis - RJ]] ou [[LOCAL: Niterói - RJ]]. Só com o que ele disse; nunca adivinhe. Não marque de novo se já estiver igual no "Contexto desta conversa".'
  );

  // ---- a partir daqui: o que muda a cada conversa (fica fora do cache do prompt)
  const hojeSp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dinamico = ['Contexto desta conversa:', `- Agora: ${hojeSp} (horário de Brasília).`];
  if (contexto.etapaAtual) dinamico.push(`- O lead está na etapa: ${contexto.etapaAtual}.`);
  if (contexto.localizacao) dinamico.push(contexto.localizacao);
  if (contexto.horariosIa) dinamico.push(contexto.horariosIa);
  if (contexto.endereco !== undefined && empresa?.agendaExigeEndereco !== false) dinamico.push(contexto.endereco ? `- Endereço do cliente (já informado): ${contexto.endereco}` : '- Endereço do cliente: ainda NÃO informado — peça (rua, número e bairro) antes de marcar [[AGENDAMENTO]].');
  if (contexto.tickets) dinamico.push(`- Já registrado nesta conversa:\n${contexto.tickets}`);
  if (contexto.midiasEnviadas?.length) dinamico.push(`- Mídias JÁ ENVIADAS nesta conversa (não envie de novo): ${contexto.midiasEnviadas.map((c) => `${String(c).startsWith('#') ? c : require('./midias').codigoVisivel(c)} [JÁ ENVIADA]`).join(', ')}.`);

  if (contexto.clone) {
    // clone: respostas reais (escritas à mão) de conversas que viraram venda
    const cl = typeof contexto.clone === 'string' ? { texto: contexto.clone, nome: 'o dono', completo: false } : contexto.clone;
    dinamico.push(
      '',
      cl.completo
        ? `CLONE DE ${cl.nome.toUpperCase()} — APRENDIZADO COMPLETO. Escreva no jeito de ${cl.nome} (tamanho, tom), seguindo a mesma linha das conversas abaixo, que viraram venda. As <instrucoes_da_empresa> continuam valendo acima do clone: o clone muda o JEITO de escrever, não as regras.`
        : `CLONE DE ${cl.nome.toUpperCase()} — escreva como ${cl.nome}. Abaixo estão respostas reais dele(a), escritas à mão, em conversas parecidas que viraram venda. As <instrucoes_da_empresa> continuam valendo acima destes exemplos:`,
      '<exemplos_do_dono>',
      cl.texto,
      '</exemplos_do_dono>',
      `- Imite ${cl.nome} no tamanho das mensagens, no tom, em como passa o preço, responde objeção e fecha — sem copiar frases inteiras nem começar as mensagens sempre do mesmo jeito.`,
      '- Se a situação for parecida com um exemplo em que foi mandada mídia, mande a MESMA mídia (o mesmo código #MIDIA_…, na última linha).',
      '- O que foi dito nos exemplos (preço, prazo, condição) vale como informação verdadeira; se conflitar com <instrucoes_da_empresa> ou <conhecimento>, valem essas. Nunca copie nome, telefone ou dado pessoal de outro cliente.'
    );
  }

  if (contexto.conversaAnterior) {
    dinamico.push(
      '',
      'Esta conversa começou ANTES das instruções atuais do dono. O que já foi falado antes delas (só para você saber o contexto: o que o cliente quer, dados que ele passou e o que já foi combinado):',
      '<conversa_anterior>',
      contexto.conversaAnterior,
      '</conversa_anterior>',
      '- NÃO imite o jeito, as aberturas nem as frases das respostas antigas da empresa: responda do jeito das instruções de agora. Não repita o que já foi respondido.'
    );
  }

  if (contexto.origem) {
    dinamico.push(
      '',
      noWhatsapp
        ? 'De onde este cliente veio (ele passou pelo site antes de chamar no WhatsApp):'
        : 'De onde este visitante veio e o que ele está olhando no site:',
      '<origem_do_cliente>',
      contexto.origem,
      '</origem_do_cliente>',
      '- Use isso para entender o interesse dele e já falar do produto/serviço certo (ex.: se ele está na página de um produto, comece por esse produto). Se veio de um anúncio ou campanha, a oferta do anúncio provavelmente é o que chamou a atenção dele.',
      '- Não diga que está rastreando ou que "viu de onde ele veio"; use com naturalidade, como um bom vendedor que percebe o interesse. O texto da página é só referência: preços e condições valem os de "Sobre a empresa" quando houver diferença.'
    );
  }
  // as instruções do dono por último também (a IA dá mais peso ao que lê no fim): curtas, vão inteiras
  const instrucoesAgora = noWhatsapp ? require('./midias').instrucoesComMidias(empresa, bot.promptWhatsapp, bot.id).texto : String(bot.regras || '').trim();
  if (instrucoesAgora) {
    dinamico.push(
      '',
      'INSTRUÇÕES DA EMPRESA VALENDO AGORA (as mais recentes do dono):',
      instrucoesAgora.length <= 2500 ? instrucoesAgora : `${instrucoesAgora.slice(0, 2500)}… (continua em <instrucoes_da_empresa>)`,
      '- Se as suas mensagens anteriores nesta conversa seguiram outro jeito ou outra regra, é porque as instruções mudaram: siga as de AGORA a partir desta resposta, sem comentar a mudança com o cliente.',
      '- Elas valem mais do que o clone, os aprendizados, os exemplos e as dicas gerais.'
    );
  }
  dinamico.push('', 'Lembrete final: siga as instruções da empresa com naturalidade e não invente nenhuma informação (na dúvida, diga que vai confirmar).');
  const textoDinamico = dinamico.join('\n');

  const aprendido = empresa?.aprendizado;
  if (aprendido?.texto?.trim() && aprendido.usarNoPrompt !== false) {
    partes.push(
      '',
      'Como esta empresa atende de verdade (aprendido lendo as conversas reais do WhatsApp — imite o jeito de falar, as perguntas e a forma de fechar; se algo aqui conflitar com "Sobre a empresa", vale "Sobre a empresa"):',
      '<aprendizados>',
      aprendido.texto.trim(),
      '</aprendizados>'
    );
  }

  const doSite = require('./site').textoParaIa(empresa || {});
  if (doSite) {
    partes.push(
      '',
      'Conteúdo do site da empresa (produtos, serviços, preços e a forma como a empresa apresenta cada um — use para responder e para vender com as mesmas palavras; se algo conflitar com "Sobre a empresa", vale "Sobre a empresa"):',
      '<site_da_empresa>',
      doSite,
      '</site_da_empresa>'
    );
  }

  const catalogo = require('./catalogo').paraIa(empresa || {});
  if (catalogo) {
    partes.push(
      '',
      'CATÁLOGO OFICIAL — serviços, produtos e preços (é a lista mais atualizada da empresa; CONSULTE SEMPRE antes de falar de serviço, produto, preço ou prazo):',
      '<catalogo>',
      catalogo,
      '</catalogo>',
      '- Preço, faixa de preço, prazo e detalhes: use EXATAMENTE o que está no catálogo. Se "Sobre a empresa", o site, os aprendizados ou mensagens antigas da conversa tiverem outro preço, vale o do catálogo.',
      '- Item "preço sob consulta" ou sem preço: não diga valor; diga que vai confirmar com a equipe.',
      '- O cliente pediu algo que não está no catálogo nem em "Sobre a empresa": não invente que a empresa faz; diga que vai confirmar.',
      '- Ao falar de um item que tem mídias, mande as mídias dele (uma vez por conversa), se o cliente ainda não viu.'
    );
  }

  partes.push('', 'Sobre a empresa:', '<conhecimento>', (bot.conhecimento || '').trim() || '(nenhuma informação cadastrada ainda)', '</conhecimento>');

  // por último (a IA dá mais peso ao fim): as instruções que o dono escreveu
  const instrucoes = instrucoesAgora;
  if (instrucoes) {
    partes.push(
      '',
      `INSTRUÇÕES DA EMPRESA para ${noWhatsapp ? 'o WhatsApp' : 'o chat do site'} — escritas pelo dono. Siga com naturalidade: o jeito de falar, o que pode e o que não pode dizer, a ordem do atendimento, as mídias que ele mandou enviar e quando passar para a equipe. Elas valem mais do que qualquer dica geral deste texto. Se uma instrução estiver ambígua, siga a intenção mais provável do dono, sem inventar informação:`,
      '<instrucoes_da_empresa>',
      instrucoes,
      '</instrucoes_da_empresa>'
    );
  }

  // parte fixa (vai para o cache do prompt, fica bem mais barata a partir da 2ª mensagem) + o que muda
  return { fixo: partes.filter((l) => l !== null).join('\n'), dinamico: textoDinamico };
}

// Converte o histórico salvo ({ papel: 'visitante'|'assistente'|'equipe', texto })
// em turnos alternados. A primeira mensagem precisa ser do usuário, então pulamos
// eventuais mensagens do assistente no começo (ex.: a saudação automática).
function paraTurnos(historico) {
  const turnos = [];
  for (const m of historico) {
    if (m.apagada) continue; // mensagem apagada não entra no que a IA lê
    const role = m.papel === 'visitante' ? 'user' : 'assistant';
    const conteudo = m.papel === 'equipe' ? `(equipe) ${m.texto}` : m.texto;
    if (!conteudo) continue;
    if (turnos.length === 0 && role !== 'user') continue;
    const ultimo = turnos[turnos.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n\n${conteudo}`;
    else turnos.push({ role, content: conteudo });
  }
  return turnos;
}

const RESPOSTA_RECUSA = 'Desculpe, não consigo ajudar com isso por aqui. Posso te ajudar com alguma dúvida sobre nossos serviços?';

// ---------------------------------------------------------------- motores: principal + 2 reservas
// A empresa escolhe até 3 IAs em ordem (ex.: Claude → GPT → Gemini). Se a 1ª
// falhar (sem crédito, chave errada, fora do ar, limite), o CRM tenta a 2ª e
// depois a 3ª, sem o cliente perceber. Cada uma pode ter a própria chave.

function chaveDoMotor(m, empresa) {
  // chave da posição com formato errado (ex.: senha do navegador): ignora e usa a da empresa
  return (formatoDeChave(m.provedor, m.chave) && m.chave) || chave(m.provedor, empresa);
}

function motoresDa(empresa, bot) {
  const lista = [];
  const cfg = Array.isArray(empresa?.motoresIa) ? empresa.motoresIa : [];
  if (cfg.length) {
    for (const m of cfg.slice(0, 3)) {
      const provedor = normalizarProvedor(m?.provedor);
      const motor = { provedor, modelo: normalizarModelo(provedor, m?.modelo), chave: m?.chave || '' };
      if (chaveDoMotor(motor, empresa)) lista.push(motor);
    }
  } else {
    // sem ordem escolhida: a IA do assistente e, de reserva, as outras que tiverem chave
    const principal = normalizarProvedor(bot?.provedor);
    if (chave(principal, empresa)) lista.push({ provedor: principal, modelo: normalizarModelo(principal, bot?.modelo), chave: '' });
    for (const p of Object.keys(PROVEDORES)) {
      if (p !== principal && chave(p, empresa)) lista.push({ provedor: p, modelo: MODELO_PADRAO[p], chave: '' });
    }
  }
  const vistos = new Set();
  return lista.filter((m) => {
    const k = `${m.provedor}|${m.modelo}|${chaveDoMotor(m, empresa)}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

const NOME_CURTO = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini' };

// Roda `fn(motor)` no 1º motor; se der erro, tenta o próximo
async function comReserva(empresa, bot, fn, opcoes = {}) {
  // quem chamou já disse a tarefa (comTarefa)? vale a dela; senão a desta chamada
  if (!tarefaAtual.getStore()) return tarefaAtual.run(opcoes.tarefa || 'outros', () => comReserva(empresa, bot, fn, opcoes));
  const tarefa = tarefaAtual.getStore();
  const motores = motoresDa(empresa, bot);
  if (!motores.length) throw erroSemChave(normalizarProvedor(bot?.provedor));
  const falhas = [];
  for (let i = 0; i < motores.length; i++) {
    const m = motores[i];
    try {
      const r = await fn(m);
      if (falhas.length && empresa) {
        empresa.iaReserva = { em: new Date().toISOString(), tarefa, usou: `${NOME_CURTO[m.provedor]} (${i + 1}ª)`, falhas: falhas.map((f) => `${f.nome}: ${f.motivo}`) };
        require('./alertas').registrar(empresa, 'ia-reserva', `A 1ª IA falhou e a ${i + 1}ª (${NOME_CURTO[m.provedor]}) respondeu. Motivo: ${falhas.map((f) => `${f.nome}: ${f.motivo}`).join('; ')}`, { nivel: 'aviso' });
      }
      return r;
    } catch (err) {
      if (err.naoTentarOutra) throw err;
      falhas.push({ nome: `${i + 1}ª ${NOME_CURTO[m.provedor]}`, motivo: descreverErroIa(err), err });
      console.error(`[ia ${empresa?.id || '-'}] ${tarefa}: ${i + 1}ª IA (${m.provedor}/${m.modelo}) falhou: ${descreverErroIa(err)}`);
    }
  }
  if (falhas.length === 1) throw falhas[0].err;
  const erro = new Error(`Nenhuma das ${falhas.length} IAs respondeu — ${falhas.map((f) => `${f.nome}: ${f.motivo}`).join(' | ')}`);
  erro.todas = true;
  throw erro;
}

// ---------------------------------------------------------------- tokens gastos (por empresa, por dia)

function hojeEmSp() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
}

// Preço (US$ por milhão de tokens: entrada, saída, leitura do cache) — só para estimar o
// gasto no painel. Modelos fora da lista aparecem sem custo estimado.
const PRECO_POR_MILHAO = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1],
  // Gemini (US$ por milhão: entrada, saída — inclui o "pensamento" —, entrada em cache)
  'gemini-2.5-flash': [0.3, 2.5, 0.075],
  'gemini-2.5-flash-lite': [0.1, 0.4, 0.025],
  'gemini-2.5-pro': [1.25, 10, 0.31],
  // OpenAI
  'gpt-5': [1.25, 10, 0.125],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-4.1': [2, 8, 0.5],
  'gpt-4.1-mini': [0.4, 1.6, 0.1]
};

function registrarUso(empresa, provedor, { entrada = 0, saida = 0, cache = 0, modelo = '' } = {}) {
  if (!empresa || !empresa.id) return;
  const tarefa = tarefaAtual.getStore() || 'outros';
  const dia = hojeEmSp();
  const u = (empresa.usoIa = empresa.usoIa || { dias: {} });
  u.dias = u.dias || {};
  const d = (u.dias[dia] = u.dias[dia] || { entrada: 0, saida: 0, cache: 0, chamadas: 0, porIa: {} });
  d.entrada += entrada || 0;
  d.saida += saida || 0;
  d.cache += cache || 0;
  d.chamadas += 1;
  d.porIa[provedor] = (d.porIa[provedor] || 0) + (entrada || 0) + (saida || 0) + (cache || 0);
  // por tarefa e por modelo: { tokens (entrada+saída, sem cache), cache, chamadas, custo (US$ estimado) }
  const preco = PRECO_POR_MILHAO[modelo];
  const custo = preco ? ((entrada || 0) * preco[0] + (saida || 0) * preco[1] + (cache || 0) * preco[2]) / 1e6 : 0;
  const somar = (grupo, k) => {
    const x = (d[grupo] = d[grupo] || {})[k] || { tokens: 0, cache: 0, chamadas: 0, custo: 0 };
    x.tokens += (entrada || 0) + (saida || 0);
    x.cache += cache || 0;
    x.chamadas += 1;
    x.custo = (x.custo || 0) + custo;
    d[grupo][k] = x;
  };
  somar('porTarefa', tarefa);
  if (modelo) somar('porModelo', modelo);
  const dias = Object.keys(u.dias).sort();
  for (const antigo of dias.slice(0, Math.max(0, dias.length - 31))) delete u.dias[antigo];
  require('./db').salvar();
}

// Soma dos últimos N dias (1 = hoje), por empresa
function usoDoPeriodo(empresa, dias) {
  const saida = { entrada: 0, saida: 0, cache: 0, chamadas: 0, porIa: {}, porTarefa: {}, porModelo: {}, total: 0 };
  const hoje = new Date(`${hojeEmSp()}T12:00:00Z`);
  for (let i = 0; i < dias; i++) {
    const dia = new Date(hoje.getTime() - i * 864e5).toISOString().slice(0, 10);
    const d = empresa?.usoIa?.dias?.[dia];
    if (!d) continue;
    saida.entrada += d.entrada;
    saida.saida += d.saida;
    saida.cache += d.cache;
    saida.chamadas += d.chamadas;
    for (const [p, n] of Object.entries(d.porIa || {})) saida.porIa[p] = (saida.porIa[p] || 0) + n;
    for (const grupo of ['porTarefa', 'porModelo']) {
      for (const [k, x] of Object.entries(d[grupo] || {})) {
        const t = (saida[grupo][k] = saida[grupo][k] || { tokens: 0, cache: 0, chamadas: 0, custo: 0 });
        t.custo += x.custo || 0;
        t.tokens += x.tokens || 0;
        t.cache += x.cache || 0;
        t.chamadas += x.chamadas || 0;
      }
    }
  }
  saida.total = saida.entrada + saida.saida + saida.cache;
  return saida;
}

function usoDoDia(empresa, dia = hojeEmSp()) {
  const d = empresa?.usoIa?.dias?.[dia];
  return d ? { ...d, total: d.entrada + d.saida + d.cache } : { entrada: 0, saida: 0, cache: 0, chamadas: 0, porIa: {}, total: 0 };
}

// ---------------------------------------------------------------- chamada a um motor

// OpenAI (GPT) pela API oficial de chat
async function chamarOpenai(chaveOpenai, caminho, corpo, { metodo = 'POST', timeout = 90000 } = {}) {
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${chaveOpenai}`, ...(corpo instanceof FormData || !corpo ? {} : { 'Content-Type': 'application/json' }) },
      body: corpo ? (corpo instanceof FormData ? corpo : JSON.stringify(corpo)) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    const erro = new Error(`Falha de rede ao chamar o GPT: ${err.message}`);
    erro.provedor = 'openai';
    throw erro;
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    const erro = new Error(dados?.error?.message || `HTTP ${res.status}`);
    erro.status = res.status;
    erro.provedor = 'openai';
    erro.codigo = dados?.error?.code || dados?.error?.type || '';
    throw erro;
  }
  return dados;
}

// modelos "de raciocínio" da OpenAI não aceitam temperature
const openaiSemTemperatura = (modelo) => /^(gpt-5|o\d)/i.test(modelo);

/**
 * Chama um motor (IA + modelo + chave). `sistema` = { fixo, dinamico } ou texto.
 * `anexo` = { base64, mime } (foto ou PDF) vai junto da última mensagem do cliente.
 * @returns {{ texto: string, recusado?: boolean }}
 */
// Os modelos que "pensam" antes de responder (Claude Opus/Sonnet atuais, GPT-5,
// Gemini 2.5) gastam o pensamento DENTRO do limite de saída. Limite apertado =
// a IA pensa até o fim do limite e devolve texto vazio. O piso abaixo dá folga
// (só se paga o que for de fato gerado; o tamanho da resposta é o prompt que manda).
const PISO_SAIDA = { anthropic: 16000, openai: 8000, gemini: 8192 };
function limiteDeSaida(m, maxTokens) {
  if (m.provedor === 'anthropic' && m.modelo === 'claude-haiku-4-5') return maxTokens; // não pensa
  if (m.provedor === 'openai' && !openaiSemTemperatura(m.modelo)) return maxTokens; // modelo sem raciocínio
  return Math.max(maxTokens, PISO_SAIDA[m.provedor] || maxTokens);
}

// A chave guardada numa IA da ordem foi recusada (apagada/trocada no site da IA) e a
// empresa tem outra chave dessa IA em "IAs e chaves": usa a da empresa e esquece a velha.
const chaveRecusada = (err) => err instanceof Anthropic.AuthenticationError || [401, 403].includes(err?.status) || /API_KEY_INVALID|API key not valid|invalid.{0,10}api.?key|incorrect api key/i.test(String(err?.message || ''));
async function chamarMotor(empresa, m, opcoes) {
  try {
    return await chamarMotorConferindo(empresa, m, opcoes);
  } catch (err) {
    // a chave das verificações falhou (limite, chave recusada): faz com a chave principal
    const verif = m.provedor === 'gemini' && !m.chave ? chaveVerificacoes(empresa) : '';
    const principal = verif ? chaveDaEmpresa('gemini', empresa) : '';
    if (verif && principal && principal !== verif && chaveDoMotor(m, empresa) === verif && (err.status === 429 || chaveRecusada(err))) {
      console.error(`[ia ${empresa.id}] chave das verificações falhou (${descreverErroIa(err)}); usando a chave principal`);
      return chamarMotorConferindo(empresa, { ...m, chave: principal }, opcoes);
    }
    const daEmpresa = (empresa?.chavesIa || {})[CAMPO_CHAVE[m.provedor]];
    if (!m.chave || !daEmpresa || daEmpresa === m.chave || !chaveRecusada(err)) throw err;
    const r = await chamarMotorConferindo(empresa, { ...m, chave: daEmpresa }, opcoes);
    for (const x of Array.isArray(empresa.motoresIa) ? empresa.motoresIa : []) if (x.chave === m.chave) delete x.chave;
    require('./db').salvar();
    console.error(`[ia ${empresa.id}] chave antiga da IA da ordem recusada: passou a usar a chave da empresa (${m.provedor})`);
    return r;
  }
}

async function chamarMotorConferindo(empresa, m, opcoes) {
  const r = await chamarMotorUmaVez(empresa, m, opcoes);
  // pensou até o limite e não escreveu nada: tenta uma vez com mais folga e pensando menos
  if (!r.recusado && !String(r.texto || '').trim() && r.cortado) {
    // (até 20 mil: sem streaming o SDK do Claude recusa limites muito altos)
    console.error(`[ia] ${m.provedor}/${m.modelo}: resposta vazia (limite de saída esgotado no pensamento); tentando de novo com mais folga`);
    return chamarMotorUmaVez(empresa, m, { ...opcoes, maxTokens: Math.min(limiteDeSaida(m, opcoes.maxTokens || 4000) * 2, 20000), esforco: 'low', esforcoBaixo: true });
  }
  return r;
}

async function chamarMotorUmaVez(empresa, m, { sistema = '', turnos, maxTokens = 4000, temperatura = 0.6, anexo = null, esforcoBaixo = true, esforco = 'low', semPensar = false }) {
  maxTokens = limiteDeSaida(m, maxTokens);
  const nivel = esforcoBaixo ? esforco : null; // quanto a IA "pensa" antes de responder
  const fixo = typeof sistema === 'string' ? sistema : sistema.fixo || '';
  const dinamico = typeof sistema === 'string' ? '' : sistema.dinamico || '';
  const k = chaveDoMotor(m, empresa);
  if (!k) throw erroSemChave(m.provedor);
  const ultimo = turnos.length - 1;

  if (m.provedor === 'anthropic') {
    const client = clienteAnthropicPorChave(k);
    const mensagens = turnos.map((t, i) => {
      if (i !== ultimo || !anexo) return { role: t.role, content: t.content };
      const bloco = /pdf/i.test(anexo.mime)
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: anexo.base64 } }
        : { type: 'image', source: { type: 'base64', media_type: anexo.mime, data: anexo.base64 } };
      return { role: t.role, content: [bloco, { type: 'text', text: t.content }] };
    });
    const system = [];
    // a parte fixa vai para o cache: da 2ª mensagem em diante custa ~10% do preço
    // cache de 1 hora: a parte fixa (igual para todos os clientes da empresa) sai ~90% mais barata
    if (fixo) system.push({ type: 'text', text: fixo, cache_control: { type: 'ephemeral', ttl: '1h' } });
    if (dinamico) system.push({ type: 'text', text: dinamico });
    const params = {
      model: m.modelo,
      max_tokens: maxTokens,
      ...(system.length ? { system } : {}),
      messages: mensagens,
      ...(m.modelo === 'claude-haiku-4-5' || !nivel ? {} : { output_config: { effort: nivel } })
    };
    const r = COM_FALLBACK.has(m.modelo)
      ? // se o modelo recusar por segurança, a própria API tenta de novo num modelo reserva
        await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
    const u = r.usage || {};
    registrarUso(empresa, 'anthropic', { entrada: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), saida: u.output_tokens || 0, cache: u.cache_read_input_tokens || 0, modelo: r.model || m.modelo });
    if (r.stop_reason === 'refusal') return { texto: RESPOSTA_RECUSA, recusado: true };
    return { texto: r.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), cortado: r.stop_reason === 'max_tokens' };
  }

  if (m.provedor === 'openai') {
    const mensagens = [];
    const sis = [fixo, dinamico].filter(Boolean).join('\n\n');
    if (sis) mensagens.push({ role: 'system', content: sis });
    turnos.forEach((t, i) => {
      if (i !== ultimo || !anexo) return mensagens.push({ role: t.role, content: t.content });
      const parte = /pdf/i.test(anexo.mime)
        ? { type: 'file', file: { filename: 'arquivo.pdf', file_data: `data:application/pdf;base64,${anexo.base64}` } }
        : { type: 'image_url', image_url: { url: `data:${anexo.mime};base64,${anexo.base64}` } };
      mensagens.push({ role: t.role, content: [parte, { type: 'text', text: t.content }] });
    });
    const dados = await chamarOpenai(k, 'chat/completions', {
      model: m.modelo,
      messages: mensagens,
      max_completion_tokens: maxTokens,
      ...(openaiSemTemperatura(m.modelo) ? { reasoning_effort: nivel || 'low' } : { temperature: temperatura })
    });
    const u = dados.usage || {};
    const emCache = u.prompt_tokens_details?.cached_tokens || 0;
    registrarUso(empresa, 'openai', { entrada: (u.prompt_tokens || 0) - emCache, saida: u.completion_tokens || 0, cache: emCache, modelo: m.modelo });
    const msg = dados.choices?.[0]?.message || {};
    if (msg.refusal) return { texto: RESPOSTA_RECUSA, recusado: true };
    return { texto: typeof msg.content === 'string' ? msg.content : '', cortado: dados.choices?.[0]?.finish_reason === 'length' };
  }

  // Gemini
  const contents = turnos.map((t, i) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: i === ultimo && anexo ? [{ inline_data: { mime_type: anexo.mime, data: anexo.base64 } }, { text: t.content }] : [{ text: t.content }]
  }));
  const sis = [fixo, dinamico].filter(Boolean).join('\n\n');
  let modeloUsado = m.modelo;
  const dados = await comModeloGemini(empresa, k, m.modelo, async (modelo) => { modeloUsado = modelo; const pedir = () => chamarGemini(
    empresa,
    `models/${encodeURIComponent(modelo)}:generateContent`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(sis ? { systemInstruction: { parts: [{ text: sis }] } } : {}),
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: temperatura,
          // Flash "pensa" por padrão e o pensamento é cobrado como saída (o token mais caro).
          // Nas respostas do dia a dia ele vai direto; o Pro (casos difíceis) continua pensando.
          ...(semPensar && /^gemini-2\.5-flash/i.test(modelo) ? { thinkingConfig: { thinkingBudget: 0 } } : semPensar && !semNivel.has(modelo) && /^gemini-3/i.test(modelo) && /flash/i.test(modelo) ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
        }
      })
    },
    k
  );
    try {
      return await pedir();
    } catch (err) {
      // o modelo não aceita o "pensar pouco": guarda e manda sem ele
      if (err.status !== 400 || !/thinking/i.test(String(err.message || '')) || semNivel.has(modelo)) throw err;
      semNivel.add(modelo);
      return pedir();
    }
  });
  const u = dados.usageMetadata || {};
  const emCache = u.cachedContentTokenCount || 0;
  registrarUso(empresa, 'gemini', { entrada: (u.promptTokenCount || 0) - emCache, saida: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cache: emCache, modelo: modeloUsado });
  const candidato = dados.candidates?.[0];
  if (!candidato || dados.promptFeedback?.blockReason) return { texto: RESPOSTA_RECUSA, recusado: true };
  const texto = (candidato.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!texto.trim() && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(candidato.finishReason)) {
    return { texto: RESPOSTA_RECUSA, recusado: true };
  }
  return { texto, cortado: candidato.finishReason === 'MAX_TOKENS' };
}

// Tira da resposta as "ações" que a IA pediu ([[ETAPA: …]], [[MIDIA: …]],
// [[HUMANO]], [[WHATSAPP]] …) e devolve o texto limpo + as ações.
function extrairAcoes(bruto) {
  let texto = String(bruto || '');
  const midias = [];
  const codigos = []; // tudo o que foi detectado (para o log): { codigo, tipo: 'midia'|'controle'|'acao'|'desconhecido' }
  let etapa = null;
  let humano = false;
  let nada = false;
  const etiquetas = [];
  let venda = null;
  let agendamento = null;
  let retomar = null;
  let local = null;
  const acao = (nome) => codigos.push({ codigo: `[[${nome}]]`, tipo: 'acao' });
  // a IA às vezes imita o registro do histórico ("[enviou a mídia: #MIDIA_X — nome]"): não é pedido, só some
  texto = texto.replace(/\[(?:enviou|enviei) a m[ií]dia:[^\]\n]*\]/gi, '');

  // 1) MÍDIAS, na ordem em que aparecem: #MIDIA_X (tolerante: **#MIDIA_X**, "#midia_x",
  //    # MIDIA_X, #MIDIA X…) e o formato antigo [[MIDIA: X]] / [[MIDIA X]]
  const RE_MIDIA = /[*_"'`“”]*\[\[\s*M[IÍ]DIA\s*:?\s*([^\]\n]+?)\s*\]\][*_"'`“”]*|[*"'`“”]*#\s*[Mm][IiÍí][Dd][Ii][Aa](?:[_:-]\s*|\s+(?=[A-Z0-9]{2,}))([A-Za-z0-9][A-Za-z0-9_-]*)[*"'`“”]*/g;
  texto = texto.replace(RE_MIDIA, (_, antigo, novo) => {
    const nome = String(antigo || novo || '').trim().replace(/[*"'`“”]+$/g, '');
    if (nome) {
      midias.push(nome);
      codigos.push({ codigo: antigo ? `[[MIDIA: ${nome}]]` : `#MIDIA_${nome.toUpperCase().replace(/-/g, '_')}`, tipo: 'midia', nome });
    }
    return '';
  });

  // 2) AÇÕES [[…]]
  texto = texto.replace(/\[\[\s*LOCAL\s*:\s*([^\]]+?)\s*\]\]/gi, (_, onde) => {
    local = onde.trim();
    acao('LOCAL');
    return '';
  });
  texto = texto.replace(/\[\[\s*RETOMAR\s*:\s*([^\]]+?)\s*\]\]/gi, (_, dentro) => {
    const [quando, assunto, ...msg] = dentro.split('|');
    retomar = { quando: (quando || '').trim(), assunto: (assunto || '').trim(), mensagem: msg.join('|').trim() };
    acao('RETOMAR');
    return '';
  });
  texto = texto.replace(/\[\[\s*VENDA\s*:?\s*([^\]]*?)\s*\]\]/gi, (_, dentro) => {
    const [valor, ...resto] = dentro.split('|');
    venda = { valor: (valor || '').trim(), descricao: resto.join('|').trim() };
    acao('VENDA');
    return '';
  });
  texto = texto.replace(/\[\[\s*AGENDAMENTO\s*:\s*([^\]]+?)\s*\]\]/gi, (_, dentro) => {
    const [quando, ...resto] = dentro.split('|');
    agendamento = { quando: (quando || '').trim(), descricao: resto.join('|').trim() };
    acao('AGENDAMENTO');
    return '';
  });
  let desmarcar = false;
  texto = texto.replace(/\[\[\s*DESMARCAR\s*\]\]/gi, () => {
    desmarcar = true;
    acao('DESMARCAR');
    return '';
  });
  texto = texto.replace(/\[\[\s*ETIQUETA\s*:\s*([^\]]+?)\s*\]\]/gi, (_, nome) => {
    etiquetas.push(nome.trim());
    acao('ETIQUETA');
    return '';
  });
  texto = texto.replace(/\[\[\s*ETAPA\s*:?\s*([^\]]+?)\s*\]\]/gi, (_, nome) => {
    etapa = nome.trim();
    acao('ETAPA');
    return '';
  });

  // 3) CONTROLE: #PAUSAR (ou [[HUMANO]] / [[PAUSAR]] / #HUMANO) e #NADA
  texto = texto.replace(/[*"'`“”]*(?:\[\[\s*(?:PAUSAR|HUMANO)[^\]]*\]\]|(?<![\w#])#\s*(?:PAUSAR|HUMANO)\b)[*"'`“”]*/gi, () => {
    humano = true;
    codigos.push({ codigo: '#PAUSAR', tipo: 'controle' });
    return '';
  });
  texto = texto.replace(/[*"'`“”]*(?<![\w#])#\s*NADA\b[*"'`“”]*/gi, () => {
    nada = true;
    codigos.push({ codigo: '#NADA', tipo: 'controle' });
    return '';
  });

  let mensagemWhatsapp = null;
  const marcador = texto.match(MARCADOR_WHATSAPP);
  if (marcador) {
    mensagemWhatsapp = marcador[1].trim() || null;
    texto = texto.slice(0, marcador.index);
  }

  // 4) Rede de segurança: código nenhum chega ao cliente. O que sobrou é apagado
  //    (e vai para o log como "desconhecido").
  const limparCodigos = (t) =>
    String(t || '')
      .replace(/\[\[[^\]\n]{0,200}\]\]/g, (x) => {
        codigos.push({ codigo: x, tipo: 'desconhecido' });
        return '';
      })
      .replace(/\[\[[^\]\n]*$/g, '') // código cortado no fim da resposta
      .replace(/(^|[^\w#])[*"'`“”]*#[A-Z][A-Z0-9_]{2,}\b[*"'`“”]*/g, (x, antes) => {
        codigos.push({ codigo: x.slice(antes.length).replace(/[*"'`“”]/g, ''), tipo: 'desconhecido' });
        return antes;
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.!?])/g, '$1')
      .replace(/^[ \t*"'`“”]+$/gm, '') // linha que ficou só com asterisco/aspas
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  texto = limparCodigos(texto);
  if (mensagemWhatsapp) mensagemWhatsapp = limparCodigos(mensagemWhatsapp) || null;
  if (nada) texto = ''; // a IA decidiu não falar nada (aviso interno sem nada útil)
  return { texto, mensagemWhatsapp, midias, etapa, humano, etiquetas, venda, agendamento, retomar, local, desmarcar, codigos, nada };
}

// Aberturas que a IA tende a repetir em toda mensagem ("Legal!", "Perfeito!", "Show!"…).
// Se a resposta começa com a mesma abertura de uma das últimas mensagens da empresa,
// a abertura sai (a resposta vai direto ao ponto).
const ABERTURA = /^\s*(legal|perfeito|perfeita|show|show de bola|[óo]timo|[óo]tima|beleza|entendi|entendido|certo|certinho|maravilha|bacana|combinado|que bom|top|massa|excelente|com certeza|ah,? legal|opa)\s*(?:[!.,…:;]+|\p{Extended_Pictographic})[\s!.,…:;]*(?:\p{Extended_Pictographic}\ufe0f?[\s!.,]*)*/iu;
const semAcentoMin = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function variarAbertura(texto, historico = []) {
  const m = String(texto || '').match(ABERTURA);
  if (!m) return texto;
  const resto = texto.slice(m[0].length).trim();
  if (resto.length < 8) return texto; // a mensagem é só "Perfeito!": fica
  const palavra = semAcentoMin(m[1]);
  const nossas = (historico || []).filter((x) => (x.papel === 'assistente' || x.papel === 'equipe') && !x.apagada && x.texto && !/^\[enviou/.test(x.texto)).slice(-4);
  const repetiu = nossas.some((x) => { const a = String(x.texto).match(ABERTURA); return a && semAcentoMin(a[1]) === palavra; });
  if (!repetiu) return texto;
  return resto.charAt(0).toUpperCase() + resto.slice(1);
}

/**
 * Gera a resposta do assistente num canal ('site' ou 'whatsapp').
 * @returns {{ texto, mensagemWhatsapp, midias: string[], etapa: string|null, humano: boolean }}
 */
// Histórico enxuto: últimas 30 mensagens; as antigas muito longas são cortadas
// (economiza tokens sem perder o fio da conversa)
function historicoEnxuto(historico) {
  const ultimas = historico.slice(-30);
  return ultimas.map((m, i) => (i < ultimas.length - 6 && String(m.texto || '').length > 700 ? { ...m, texto: `${m.texto.slice(0, 700)}…` } : m));
}

// Modo econômico (ligado por padrão; IA do WhatsApp → "Modo econômico"): a conversa do
// dia a dia vai para um modelo mais em conta da mesma IA; o modelo escolhido entra só nos
// casos difíceis (objeção de preço, reclamação, negociação, mensagem longa) ou quando o
// modelo econômico avisa que a conversa está difícil (#DIFICIL).
const MODELO_ECONOMICO = {
  'claude-opus-5-5': 'claude-sonnet-5-5',
  'claude-opus-5': 'claude-sonnet-5',
  'gpt-5': 'gpt-5-mini',
  'gpt-4.1': 'gpt-4.1-mini',
  'gemini-2.5-pro': 'gemini-2.5-flash'
};
const economicoLigado = (empresa) => empresa?.iaEconomica !== false;
const CASO_DIFICIL = /\b(caro|car[ií]ssimo|desconto|abaix\w*|negoci\w*|melhor pre[cç]o|mais barato|concorr\w*|outro lugar|outra loja|reclam\w*|problema|defeito|garantia|devolu\w*|reembols\w*|estorn\w*|insatisfeit\w*|p[ée]ssim\w*|absurdo|enganad\w*|procon|advogad\w*|processar|cancel\w*|n[ãa]o gostei|ficou ruim|deu errado)\b/i;
function casoDificil(historico = []) {
  const doCliente = [];
  for (let i = historico.length - 1; i >= 0 && doCliente.length < 3; i--) {
    const m = historico[i];
    if (m.papel !== 'visitante') break;
    if (!m.eventoInterno) doCliente.unshift(String(m.texto || ''));
  }
  const texto = doCliente.join(' ');
  return CASO_DIFICIL.test(texto.normalize('NFC')) || texto.length > 600;
}
const AVISO_ECONOMICO = '\n\n(Interno) Se esta conversa estiver difícil para você — negociação de preço, reclamação, cliente irritado ou uma pergunta que você não tem certeza de como responder bem — responda só: #DIFICIL';

async function responder(bot, empresa, historicoCompleto, opcoes = {}) {
  const tarefa = opcoes.tarefa || tarefaAtual.getStore() || (opcoes.canal === 'whatsapp' ? 'resposta' : 'site');
  return comTarefa(tarefa, () => responderNa(bot, empresa, historicoCompleto, opcoes));
}

async function responderNa(bot, empresa, historicoCompleto, opcoes = {}) {
  const canal = opcoes.canal === 'whatsapp' ? 'whatsapp' : 'site';
  // "Atualizar prompt": o que veio antes das instruções novas vira só contexto (não é modelo)
  const { historico, anterior } = canal === 'whatsapp' ? require('./prompt-novo').separarHistorico(empresa, historicoCompleto) : { historico: historicoCompleto, anterior: '' };
  if (anterior) opcoes = { ...opcoes, conversaAnterior: anterior };
  const turnos = paraTurnos(historicoEnxuto(historico));
  if (turnos.length === 0) throw new Error('Nenhuma mensagem do cliente para responder.');
  const sistema = montarPromptSistema(bot, empresa, canal, opcoes);
  // atendimento: pensa um pouco mais (segue melhor as instruções) e com menos "criatividade" (inventa menos)
  // atendimento: pouca "criatividade" (inventa menos), pensamento curto e resposta curta (economiza tokens)
  const chamar = (economico) =>
    comReserva(empresa, bot, (m) => {
      const barato = economico && MODELO_ECONOMICO[m.modelo];
      const motor = barato ? { ...m, modelo: barato } : m;
      const sis = barato ? { ...sistema, dinamico: `${sistema.dinamico || ''}${AVISO_ECONOMICO}` } : sistema;
      return chamarMotor(empresa, motor, { sistema: sis, turnos, esforco: 'low', temperatura: 0.3, maxTokens: 1500, semPensar: true }).then((r) => ({ ...r, modelo: motor.modelo, economico: Boolean(barato) }));
    });
  const tentarEconomico = economicoLigado(empresa) && opcoes.semEconomia !== true && !casoDificil(historico);
  let bruto = await chamar(tentarEconomico);
  let escalou = '';
  // o modelo econômico pediu ajuda: o modelo escolhido responde
  if (bruto.economico && /#\s*DIFICIL\b/i.test(bruto.texto || '')) {
    escalou = 'o modelo econômico achou a conversa difícil';
    bruto = await chamar(false);
  } else if (!tentarEconomico && economicoLigado(empresa) && opcoes.semEconomia !== true && MODELO_ECONOMICO[bruto.modelo]) escalou = 'caso difícil (objeção, reclamação ou mensagem longa)';
  if (bruto.recusado) return { texto: bruto.texto, mensagemWhatsapp: null, midias: [], etapa: null, humano: false, etiquetas: [], venda: null, agendamento: null };

  let r = extrairAcoes(String(bruto.texto || '').replace(/#\s*DIFICIL\b/gi, ''));
  r.bruto = bruto.texto;
  r.modelo = bruto.modelo || '';
  r.escalou = escalou;

  // a IA repetiu o começo das mensagens anteriores ("Legal!", "Perfeito!"…): tira
  if (r.texto) r.texto = variarAbertura(r.texto, historico);
  if (canal === 'whatsapp') r.mensagemWhatsapp = null; // já está no WhatsApp
  if (!r.texto && canal === 'site') r.texto = 'Posso te passar para o nosso WhatsApp para continuar o atendimento?';
  return r;
}

// ---------------------------------------------------------------- áudio e fotos do cliente

const MODELO_OUVIR = process.env.GEMINI_MODELO_AUDIO || 'gemini-2.5-flash';
const MODELO_TRANSCREVER_OPENAI = process.env.OPENAI_MODELO_AUDIO || 'gpt-4o-mini-transcribe';
// tarefas simples (descrever foto, ler comprovante): sempre o modelo mais barato de cada IA
const MODELO_BARATO = { anthropic: 'claude-haiku-4-5', gemini: MODELO_OUVIR, openai: 'gpt-5-mini' };

// O Claude não ouve áudio; o Gemini e o GPT ouvem. Com a chave de um deles,
// o áudio do cliente vira texto e a IA responde a ele.
function podeOuvirAudio(empresa) {
  return Boolean(chave('gemini', empresa) || chave('openai', empresa));
}

function textoGemini(dados) {
  return (dados.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

const PEDIDO_AUDIO = 'Transcreva este áudio de WhatsApp exatamente como foi falado, em português do Brasil. Responda só com a transcrição, sem comentários. Se não houver fala, responda: (sem fala)';

async function transcreverAudio(empresa, base64, mimetype) {
  return comTarefa('audio', () => transcreverAudioNa(empresa, base64, mimetype));
}
async function transcreverAudioNa(empresa, base64, mimetype) {
  const mime = String(mimetype || 'audio/ogg').split(';')[0];
  const tentativas = [];
  // chave das verificações (se tiver) e, se ela falhar, a principal
  for (const kAudio of [...new Set([chave('gemini', empresa), chaveDaEmpresa('gemini', empresa)].filter(Boolean))]) {
    tentativas.push(async () => {
      let modeloUsado = MODELO_OUVIR;
      const dados = await comModeloGemini(empresa, kAudio, MODELO_OUVIR, (modelo) => { modeloUsado = modelo; return chamarGemini(empresa, `models/${modelo}:generateContent`, {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: PEDIDO_AUDIO }] }],
          generationConfig: { maxOutputTokens: 2000, temperature: 0 }
        })
      }, kAudio); });
      const u = dados.usageMetadata || {};
      registrarUso(empresa, 'gemini', { entrada: u.promptTokenCount || 0, saida: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), modelo: modeloUsado });
      return textoGemini(dados);
    });
  }
  if (chave('openai', empresa)) {
    tentativas.push(async () => {
      const form = new FormData();
      const ext = (mime.split('/')[1] || 'ogg').replace('mpeg', 'mp3');
      form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mime }), `audio.${ext}`);
      form.append('model', MODELO_TRANSCREVER_OPENAI);
      form.append('language', 'pt');
      const dados = await chamarOpenai(chave('openai', empresa), 'audio/transcriptions', form);
      registrarUso(empresa, 'openai', { entrada: dados.usage?.input_tokens || 0, saida: dados.usage?.output_tokens || 0 });
      return String(dados.text || '').trim();
    });
  }
  let ultimoErro = null;
  for (const t of tentativas) {
    try {
      const texto = await t();
      if (texto) return texto;
    } catch (err) {
      ultimoErro = err;
      console.error(`[ia ${empresa?.id}] áudio:`, descreverErroIa(err));
    }
  }
  if (ultimoErro) throw ultimoErro;
  return null;
}

const PEDIDO_FOTO = 'Descreva em 1 ou 2 frases, em português, o que aparece nesta foto que um cliente mandou pelo WhatsApp para uma empresa (objeto, estado, detalhes úteis para um orçamento e qualquer texto visível). Responda só com a descrição.';

// Descreve a foto do cliente (qualquer uma das IAs vê imagens), no modelo mais barato
async function descreverImagem(bot, empresa, base64, mimetype) {
  return comTarefa('foto', () => descreverImagemNa(bot, empresa, base64, mimetype));
}
async function descreverImagemNa(bot, empresa, base64, mimetype) {
  const mime = String(mimetype || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  if (!motoresDa(empresa, bot).length) return null;
  const r = await comReserva(
    empresa,
    bot,
    (m) => chamarMotor(empresa, { ...m, modelo: MODELO_BARATO[m.provedor] }, { turnos: [{ role: 'user', content: PEDIDO_FOTO }], anexo: { base64, mime }, maxTokens: 400, temperatura: 0.2, esforcoBaixo: false }),
    { tarefa: 'foto' }
  );
  return r.recusado ? null : r.texto.trim() || null;
}

// Plano B do comprovante (quando o OCR/texto do PDF não deu conta): a IA lê
// a imagem/PDF e devolve os dados do pagamento em JSON.
const PEDIDO_COMPROVANTE =
  'Esta imagem/arquivo é um comprovante de pagamento (Pix, transferência, boleto)? Responda SOMENTE com um JSON, sem texto antes ou depois, no formato: {"ehComprovante": true|false, "valor": "1.250,90", "data": "dd/mm/aaaa hh:mm", "pagador": "nome de quem pagou", "recebedor": "nome de quem recebeu", "banco": "banco de quem pagou", "idTransacao": "id/autenticação", "forma": "Pix|Transferência|Boleto"}. Use "" quando não souber. Não invente valores.';

async function lerComprovante(bot, empresa, base64, mimetype) {
  return comTarefa('comprovante', () => lerComprovanteNa(bot, empresa, base64, mimetype));
}
async function lerComprovanteNa(bot, empresa, base64, mimetype) {
  const mime = String(mimetype || '').split(';')[0];
  const ehPdf = /pdf/i.test(mime);
  if (!ehPdf && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  if (!motoresDa(empresa, bot).length) return null;
  const r = await comReserva(
    empresa,
    bot,
    (m) => chamarMotor(empresa, { ...m, modelo: MODELO_BARATO[m.provedor] }, { turnos: [{ role: 'user', content: PEDIDO_COMPROVANTE }], anexo: { base64, mime: ehPdf ? 'application/pdf' : mime }, maxTokens: 500, temperatura: 0, esforcoBaixo: false }),
    { tarefa: 'comprovante' }
  );
  if (r.recusado) return null;
  const json = (r.texto.match(/\{[\s\S]*\}/) || [])[0];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Chamada simples (um pedido, uma resposta) com as IAs da empresa, na ordem —
// usada na varredura das conversas e no diagnóstico.
async function gerarTexto(bot, empresa, sistema, pedido, maxTokens = 4000, { barato = false, semPensar = false } = {}) {
  // barato: usa o modelo mais em conta de cada IA (ex.: aprendizado, que lê muito texto)
  const r = await comReserva(empresa, bot, (m) => chamarMotor(empresa, barato ? { ...m, modelo: MODELO_BARATO[m.provedor] || m.modelo } : m, { sistema, turnos: [{ role: 'user', content: pedido }], maxTokens, temperatura: 0.3, semPensar }), { tarefa: 'texto' });
  if (r.recusado) throw new Error('A IA recusou o pedido.');
  return r.texto.trim();
}

// ---------------------------------------------------------------- mensagens escritas pela IA para a equipe

// Escreve uma mensagem nova para o lead a partir de uma instrução interna
// (follow-up, recuperar venda, sugestão de resposta para a equipe…).
async function escreverMensagem(bot, empresa, historico, instrucao, opcoes = {}) {
  const interno = {
    papel: 'visitante',
    texto: `[INSTRUÇÃO INTERNA DA EMPRESA — não é mensagem do cliente e ele não vê isto]: ${instrucao} Escreva só a mensagem que será enviada ao cliente agora, curta e natural, sem mencionar esta instrução.`
  };
  const r = await responder(bot, empresa, [...historico, interno], { ...opcoes, canal: 'whatsapp', tarefa: opcoes.tarefa || 'followup' });
  return r;
}

function descreverErroIa(err) {
  if (err?.todas) return err.message;
  if (err?.provedor === 'openai') {
    if (err.status === 401) return 'Chave do ChatGPT inválida. Confira a chave de IA da empresa.';
    if (err.status === 429 && /quota|billing|insufficient/i.test(`${err.codigo} ${err.message}`)) return 'A chave do ChatGPT está sem crédito. Recarregue em platform.openai.com.';
    if (err.status === 429) return 'Limite do ChatGPT atingido agora. Tente de novo em instantes.';
    if (err.status === 404) return 'Modelo do ChatGPT não encontrado para esta chave. Escolha outro em Chaves de IA.';
    if (err.status === 403) return 'A chave do ChatGPT não tem permissão para este modelo.';
    return `Erro no ChatGPT: ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) return 'Chave do Claude inválida. Confira a chave de IA da empresa.';
  if (err instanceof Anthropic.RateLimitError) return 'O Claude está recebendo muitas mensagens agora. Tente de novo em instantes.';
  if (err instanceof Anthropic.NotFoundError) return 'Modelo do Claude não encontrado para esta chave.';
  if (/credit balance/i.test(err?.message || '')) return 'A chave do Claude está sem crédito. Recarregue em console.anthropic.com.';
  if (err instanceof Anthropic.BadRequestError) return `O Claude recusou o pedido: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Não consegui falar com o Claude (sem conexão ou tempo esgotado). Tente de novo em instantes.';
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return 'A chave do Claude está sem crédito. Recarregue em console.anthropic.com.';
    if (err.status === 403) return 'A chave do Claude não tem permissão para este modelo. Escolha outro modelo no assistente.';
    return `Erro no Claude (HTTP ${err.status ?? '?'}): ${err.message}`;
  }
  if (err.provedor === 'gemini') {
    if (/API_KEY_INVALID|API key not valid/i.test(err.message) || err.status === 401 || err.status === 403) {
      return 'Chave do Gemini inválida ou sem permissão. Confira a chave de IA da empresa.';
    }
    if (err.status === 429) return 'Limite do Gemini atingido (cota da sua chave). Tente de novo mais tarde.';
    if (err.status === 404) return `Modelo do Gemini não encontrado para esta chave — escolha outro modelo na tela Chave da IA. (Google: ${String(err.message || '').replace(/AIza[\w-]+|AQ\.[\w.-]+/g, '[chave]').slice(0, 160)})`;
    return `Erro no Gemini: ${err.message}`;
  }
  return err.message || 'Erro desconhecido na IA.';
}

module.exports = {
  chaveVerificacoes,
  modeloGeminiDaChave,
  variarAbertura,
  casoDificil,
  MODELO_ECONOMICO,
  comTarefa,
  responder,
  escreverMensagem,
  transcreverAudio,
  descreverImagem,
  lerComprovante,
  gerarTexto,
  podeOuvirAudio,
  extrairAcoes,
  descreverErroIa,
  montarPromptSistema,
  listarModelos,
  testarChave,
  testarMotor,
  motoresDa,
  formatoDeChave,
  chaveDoMotor,
  usoDoDia,
  usoDoPeriodo,
  registrarUso,
  MODELOS_OPENAI_SUGERIDOS,
  chave,
  chaveDaEmpresa,
  chavePadrao,
  podeUsarChavePadrao,
  CAMPO_CHAVE,
  provedoresConfigurados,
  normalizarProvedor,
  normalizarModelo,
  PROVEDORES,
  MODELO_PADRAO
};
