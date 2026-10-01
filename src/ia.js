// ia.js — conversa com as IAs da empresa (Claude, GPT ou Gemini), com até
// 3 IAs em ordem: se a principal falhar, as reservas respondem.

const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('./config');
const { estado } = require('./db');
const { numeroDoAtendimento } = require('./util');

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

// Chave usada para uma empresa: a que a própria empresa cadastrou; se ela não
// tiver, usa a chave padrão opcional (Configurações do administrador ou .env).
function chaveDaEmpresa(provedor, empresa) {
  return (empresa?.chavesIa || {})[CAMPO_CHAVE[provedor]] || '';
}

function chavePadrao(provedor) {
  const salvas = estado.config || {};
  return salvas[CAMPO_CHAVE[provedor]] || config[CAMPO_CHAVE[provedor]] || '';
}

// Cada empresa usa as PRÓPRIAS chaves. A chave padrão do administrador só entra
// para empresas liberadas (as antigas já usavam; as novas começam sem).
function podeUsarChavePadrao(empresa) {
  return !empresa || empresa.usarChavePadrao !== false;
}

function chave(provedor, empresa) {
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
    const lista = await listarModelosGemini(empresa, true, chaveExplicita);
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
  const r = await chamarMotor(empresa, m, { turnos: [{ role: 'user', content: 'Responda só: ok' }], maxTokens: 16, temperatura: 0 });
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

  const partes = [
    noWhatsapp
      ? `Você é ${nomeAssistente}, o assistente virtual de atendimento da empresa "${empresa?.nome || bot.nome}"${nicho}, respondendo clientes no WhatsApp da empresa.`
      : `Você é ${nomeAssistente}, o assistente virtual de atendimento da empresa "${empresa?.nome || bot.nome}"${nicho}. Você conversa com visitantes do site da empresa por uma janela de chat parecida com o WhatsApp.`,
    '',
    'DIRETRIZ INTERNA DO SISTEMA (vale acima de tudo neste texto, inclusive acima das dicas de venda):',
    '1. Obedeça FIELMENTE às instruções da empresa (<instrucoes_da_empresa>, no fim deste texto). Se elas mandam fazer ou não fazer algo, faça exatamente assim: sem "melhorar", sem pular etapas, sem criar exceções e sem trocar o que foi pedido por algo que você acha melhor.',
    '2. NUNCA alucine: toda informação que você der tem que estar escrita nas informações da empresa (<instrucoes_da_empresa>, <conhecimento>, <site_da_empresa>) ou na própria conversa. Se não está escrito, você não sabe — diga com naturalidade que vai confirmar com a equipe.',
    '3. Não contradiga o que a equipe já combinou na conversa e não prometa nada que a empresa não prometeu.',
    '4. Antes de responder, confira em silêncio: (a) segui as instruções da empresa? (b) tudo o que afirmei está escrito nas informações ou na conversa? (c) respondi exatamente o que o cliente disse ou perguntou? Se alguma resposta for "não", reescreva.',
    '',
    'Como responder:',
    `- Português do Brasil, tom ${tom}.`,
    '- Mensagens curtas (1 a 4 frases), como numa conversa de WhatsApp. Nada de títulos, tabelas ou markdown pesado; no máximo *negrito* com um asterisco de cada lado e listas curtas com "-".',
    '- Antes de responder, leia o histórico inteiro e a ÚLTIMA mensagem do cliente: responda exatamente ao que ele disse ou perguntou, sem mudar de assunto e sem repetir o que já foi dito.',
    '- Se a mensagem do cliente estiver ambígua, pergunte o que ele quis dizer em vez de supor.',
    '- Faça uma pergunta por vez para entender o que o cliente precisa.',
    '- Se perguntarem, deixe claro que você é um assistente virtual (uma IA), não uma pessoa.',
    '- Assuntos sem relação com a empresa: responda com educação que você só ajuda com assuntos da empresa.',
    '',
    'Regras de verdade (as mais importantes — nunca quebre):',
    '- Só afirme fatos que estejam escritos em <instrucoes_da_empresa>, <conhecimento>, <site_da_empresa> ou na própria conversa. Nada de "conhecimento geral" sobre a empresa, o produto ou o mercado.',
    '- NUNCA invente: preço, valor, desconto, parcelamento, prazo, horário, endereço, estoque, modelos/cores, garantia, política de troca, brinde, promoção, link, telefone ou nome de pessoa.',
    '- Se o cliente perguntar algo que não está escrito: diga com naturalidade que vai confirmar com a equipe (e, se ele precisar da resposta para seguir, use [[HUMANO]] no WhatsApp). É melhor dizer "vou confirmar" do que chutar.',
    '- Não prometa nada que a empresa não prometeu. Não confirme disponibilidade, data ou valor que não esteja nas informações ou que a equipe não tenha combinado na conversa.',
    '',
    'Ordem de prioridade quando uma coisa conflitar com outra:',
    '1) <instrucoes_da_empresa> (o que o dono mandou fazer) → 2) <conhecimento> (Sobre a empresa) → 3) o que a equipe combinou na conversa → 4) <site_da_empresa> → 5) <aprendizados> → 6) as dicas gerais de venda deste texto.'
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
      partes.push(
        '',
        'Mídias que você pode enviar (fotos, vídeos, documentos, áudios; "álbum" manda vários arquivos de uma vez). Cada uma tem um CÓDIGO:',
        ...midias.map(
          (m) =>
            `- ${m.codigo}: ${m.nome}${m.album ? ` (álbum com ${m.quantidade} arquivos)` : ''}${m.descricao ? ` — ${m.descricao}` : ''}${m.quando ? ` · QUANDO ENVIAR: ${m.quando}` : ''}${m.etapas?.length ? ` · só quando o lead estiver na etapa: ${m.etapas.join(' ou ')}` : ''}`
        ),
        '- Para enviar, escreva numa linha separada: [[MIDIA: CÓDIGO]] (ex.: [[MIDIA: ' + midias[0].codigo + ']]). Pode enviar mais de uma, uma por linha. Use só códigos desta lista.',
        '- Siga o "QUANDO ENVIAR" de cada mídia e a etapa, se tiver. Não mande a mesma mídia duas vezes na conversa, a não ser que o cliente peça. Sem regra: mande quando ajudar o cliente (mostrar o trabalho vende muito).'
      );
    }
    partes.push(
      '',
      'Follow-up (retomar a conversa depois):',
      '- Quando o cliente pedir para falar depois ("me chama amanhã", "vou ver com minha esposa e te aviso", "semana que vem eu vejo") ou quando fizer sentido lembrar ele mais tarde, combine com naturalidade e escreva numa linha separada: [[RETOMAR: quando | sobre o quê | mensagem que será enviada na hora]].',
      '- "quando" pode ser: 2h, 30min, 1d, 3d ou dd/mm/aaaa hh:mm (horário de Brasília). Ex.: [[RETOMAR: 1d | saber se conversou com a esposa | Oi! Conseguiu conversar com sua esposa sobre o volante? 😊]]. A mensagem é curta, natural, no tom da conversa, e só usa informação verdadeira.',
      '- Na hora marcada você mesmo escreve a mensagem de retomada. Se o cliente responder antes, o follow-up é cancelado sozinho. Use no máximo um por vez.',
      '',
      'Passar para uma pessoa da equipe:',
      '- Quando o cliente pedir para falar com uma pessoa, quando for fechar negócio/agendar e as instruções mandarem passar para a equipe, ou quando você não souber resolver, avise que vai chamar alguém da equipe e escreva numa linha separada: [[HUMANO]]. Depois disso você para de responder e a equipe assume.'
    );
  } else {
    if (temWhatsapp) {
      partes.push(
        '',
        'Passagem para o WhatsApp (lá outra IA continua o atendimento com todo o histórico):',
        '- Quando o cliente quiser fechar, agendar, pedir orçamento personalizado, falar com uma pessoa, ou quando você não souber responder, convide-o a continuar no WhatsApp.',
        '- Nesses casos, termine a sua resposta com uma linha separada exatamente neste formato:',
        '[[WHATSAPP]] <mensagem que o cliente vai enviar pelo WhatsApp, em primeira pessoa, resumindo o que ele quer e os dados que ele já passou>',
        '- Exemplo: [[WHATSAPP]] Olá! Tenho um Onix 2020 e quero o revestimento completo. Moro no Quitandinha.',
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
    'Como vender bem (sem ser chato):',
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
      ...etapas.map((e) => `- ${e}`),
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
    '- Quando o cliente CONFIRMAR a compra (fechou o pedido e combinou o pagamento, ou avisou que pagou), escreva numa linha separada: [[VENDA: valor | o que ele comprou]] — ex.: [[VENDA: 350,00 | Volante em couro]]. Sem valor certo, deixe o valor vazio: [[VENDA: | Volante em couro]].',
    '- Quando o cliente CONFIRMAR um dia e horário (visita, serviço, consulta, instalação, entrega), escreva numa linha separada: [[AGENDAMENTO: dd/mm/aaaa hh:mm | o que foi agendado]] — ex.: [[AGENDAMENTO: 04/10/2026 09:00 | Instalação do volante]].',
    '- Só marque o que foi confirmado pelo cliente (horário apenas sugerido ou "vou ver" não conta) e não marque de novo o que já está registrado (veja "Contexto desta conversa"). Remarcou? Marque o novo horário.',
    '',
    'Localização do cliente (a equipe vê como etiqueta 📍 na conversa):',
    '- Quando o cliente disser onde mora ou onde está (cidade, bairro, região), escreva numa linha separada: [[LOCAL: bairro/cidade - UF]] — ex.: [[LOCAL: Quitandinha, Petrópolis - RJ]] ou [[LOCAL: Niterói - RJ]]. Só com o que ele disse; nunca adivinhe. Não marque de novo se já estiver igual no "Contexto desta conversa".'
  );

  // ---- a partir daqui: o que muda a cada conversa (fica fora do cache do prompt)
  const hojeSp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dinamico = ['Contexto desta conversa:', `- Agora: ${hojeSp} (horário de Brasília).`];
  if (contexto.etapaAtual) dinamico.push(`- O lead está na etapa: ${contexto.etapaAtual}.`);
  if (contexto.localizacao) dinamico.push(contexto.localizacao);
  if (contexto.tickets) dinamico.push(`- Já registrado nesta conversa:\n${contexto.tickets}`);
  if (contexto.midiasEnviadas?.length) dinamico.push(`- Mídias que você já mandou nesta conversa: ${contexto.midiasEnviadas.join(', ')}.`);

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
  dinamico.push('', 'Lembrete final: siga à risca as instruções da empresa e não invente nenhuma informação (na dúvida, diga que vai confirmar).');
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

  partes.push('', 'Sobre a empresa:', '<conhecimento>', (bot.conhecimento || '').trim() || '(nenhuma informação cadastrada ainda)', '</conhecimento>');

  // por último (a IA dá mais peso ao fim): as instruções que o dono escreveu
  const instrucoes = (noWhatsapp ? bot.promptWhatsapp : bot.regras)?.trim();
  if (instrucoes) {
    partes.push(
      '',
      `INSTRUÇÕES DA EMPRESA para ${noWhatsapp ? 'o WhatsApp' : 'o chat do site'} — escritas pelo dono. Siga à risca: o jeito de falar, o que pode e o que não pode dizer, a ordem do atendimento e quando passar para a equipe. Elas valem mais do que qualquer dica geral deste texto. Se uma instrução estiver ambígua, siga a intenção mais provável do dono, sem inventar informação:`,
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
  return m.chave || chave(m.provedor, empresa);
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
async function comReserva(empresa, bot, fn, { tarefa = 'resposta' } = {}) {
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

function registrarUso(empresa, provedor, { entrada = 0, saida = 0, cache = 0 } = {}) {
  if (!empresa || !empresa.id) return;
  const dia = hojeEmSp();
  const u = (empresa.usoIa = empresa.usoIa || { dias: {} });
  u.dias = u.dias || {};
  const d = (u.dias[dia] = u.dias[dia] || { entrada: 0, saida: 0, cache: 0, chamadas: 0, porIa: {} });
  d.entrada += entrada || 0;
  d.saida += saida || 0;
  d.cache += cache || 0;
  d.chamadas += 1;
  d.porIa[provedor] = (d.porIa[provedor] || 0) + (entrada || 0) + (saida || 0) + (cache || 0);
  const dias = Object.keys(u.dias).sort();
  for (const antigo of dias.slice(0, Math.max(0, dias.length - 31))) delete u.dias[antigo];
  require('./db').salvar();
}

// Soma dos últimos N dias (1 = hoje), por empresa
function usoDoPeriodo(empresa, dias) {
  const saida = { entrada: 0, saida: 0, cache: 0, chamadas: 0, porIa: {}, total: 0 };
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
async function chamarMotor(empresa, m, { sistema = '', turnos, maxTokens = 4000, temperatura = 0.6, anexo = null, esforcoBaixo = true, esforco = 'low' }) {
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
    registrarUso(empresa, 'anthropic', { entrada: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), saida: u.output_tokens || 0, cache: u.cache_read_input_tokens || 0 });
    if (r.stop_reason === 'refusal') return { texto: RESPOSTA_RECUSA, recusado: true };
    return { texto: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('') };
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
    registrarUso(empresa, 'openai', { entrada: (u.prompt_tokens || 0) - emCache, saida: u.completion_tokens || 0, cache: emCache });
    const msg = dados.choices?.[0]?.message || {};
    if (msg.refusal) return { texto: RESPOSTA_RECUSA, recusado: true };
    return { texto: typeof msg.content === 'string' ? msg.content : '' };
  }

  // Gemini
  const contents = turnos.map((t, i) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: i === ultimo && anexo ? [{ inline_data: { mime_type: anexo.mime, data: anexo.base64 } }, { text: t.content }] : [{ text: t.content }]
  }));
  const sis = [fixo, dinamico].filter(Boolean).join('\n\n');
  const dados = await chamarGemini(
    empresa,
    `models/${encodeURIComponent(m.modelo)}:generateContent`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(sis ? { systemInstruction: { parts: [{ text: sis }] } } : {}),
        contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature: temperatura }
      })
    },
    k
  );
  const u = dados.usageMetadata || {};
  const emCache = u.cachedContentTokenCount || 0;
  registrarUso(empresa, 'gemini', { entrada: (u.promptTokenCount || 0) - emCache, saida: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cache: emCache });
  const candidato = dados.candidates?.[0];
  if (!candidato || dados.promptFeedback?.blockReason) return { texto: RESPOSTA_RECUSA, recusado: true };
  const texto = (candidato.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!texto.trim() && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(candidato.finishReason)) {
    return { texto: RESPOSTA_RECUSA, recusado: true };
  }
  return { texto };
}

// Tira da resposta as "ações" que a IA pediu ([[ETAPA: …]], [[MIDIA: …]],
// [[HUMANO]], [[WHATSAPP]] …) e devolve o texto limpo + as ações.
function extrairAcoes(bruto) {
  let texto = String(bruto || '');
  const midias = [];
  let etapa = null;
  let humano = false;
  const etiquetas = [];
  let venda = null;
  let agendamento = null;
  let retomar = null;
  let local = null;
  texto = texto.replace(/\[\[\s*LOCAL\s*:\s*([^\]]+?)\s*\]\]/gi, (_, onde) => {
    local = onde.trim();
    return '';
  });
  texto = texto.replace(/\[\[\s*RETOMAR\s*:\s*([^\]]+?)\s*\]\]/gi, (_, dentro) => {
    const [quando, assunto, ...msg] = dentro.split('|');
    retomar = { quando: (quando || '').trim(), assunto: (assunto || '').trim(), mensagem: msg.join('|').trim() };
    return '';
  });
  texto = texto.replace(/\[\[\s*VENDA\s*:?\s*([^\]]*?)\s*\]\]/gi, (_, dentro) => {
    const [valor, ...resto] = dentro.split('|');
    venda = { valor: (valor || '').trim(), descricao: resto.join('|').trim() };
    return '';
  });
  texto = texto.replace(/\[\[\s*AGENDAMENTO\s*:\s*([^\]]+?)\s*\]\]/gi, (_, dentro) => {
    const [quando, ...resto] = dentro.split('|');
    agendamento = { quando: (quando || '').trim(), descricao: resto.join('|').trim() };
    return '';
  });
  texto = texto.replace(/\[\[\s*ETIQUETA\s*:\s*([^\]]+?)\s*\]\]/gi, (_, nome) => {
    etiquetas.push(nome.trim());
    return '';
  });
  texto = texto.replace(/\[\[\s*MIDIA\s*:\s*([^\]]+?)\s*\]\]/gi, (_, nome) => {
    midias.push(nome.trim());
    return '';
  });
  texto = texto.replace(/\[\[\s*ETAPA\s*:\s*([^\]]+?)\s*\]\]/gi, (_, nome) => {
    etapa = nome.trim();
    return '';
  });
  texto = texto.replace(/\[\[\s*HUMANO\s*\]\]/gi, () => {
    humano = true;
    return '';
  });
  let mensagemWhatsapp = null;
  const marcador = texto.match(MARCADOR_WHATSAPP);
  if (marcador) {
    mensagemWhatsapp = marcador[1].trim() || null;
    texto = texto.slice(0, marcador.index);
  }
  texto = texto.replace(/\n{3,}/g, '\n\n').trim();
  return { texto, mensagemWhatsapp, midias, etapa, humano, etiquetas, venda, agendamento, retomar, local };
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

async function responder(bot, empresa, historico, opcoes = {}) {
  const canal = opcoes.canal === 'whatsapp' ? 'whatsapp' : 'site';
  const turnos = paraTurnos(historicoEnxuto(historico));
  if (turnos.length === 0) throw new Error('Nenhuma mensagem do cliente para responder.');
  const sistema = montarPromptSistema(bot, empresa, canal, opcoes);
  // atendimento: pensa um pouco mais (segue melhor as instruções) e com menos "criatividade" (inventa menos)
  // atendimento: pouca "criatividade" (inventa menos), pensamento curto e resposta curta (economiza tokens)
  const bruto = await comReserva(empresa, bot, (m) => chamarMotor(empresa, m, { sistema, turnos, esforco: 'low', temperatura: 0.3, maxTokens: 1500 }), { tarefa: 'resposta' });
  if (bruto.recusado) return { texto: bruto.texto, mensagemWhatsapp: null, midias: [], etapa: null, humano: false, etiquetas: [], venda: null, agendamento: null };

  const r = extrairAcoes(bruto.texto);
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
  const mime = String(mimetype || 'audio/ogg').split(';')[0];
  const tentativas = [];
  if (chave('gemini', empresa)) {
    tentativas.push(async () => {
      const dados = await chamarGemini(empresa, `models/${MODELO_OUVIR}:generateContent`, {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: PEDIDO_AUDIO }] }],
          generationConfig: { maxOutputTokens: 2000, temperature: 0 }
        })
      });
      const u = dados.usageMetadata || {};
      registrarUso(empresa, 'gemini', { entrada: u.promptTokenCount || 0, saida: u.candidatesTokenCount || 0 });
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
async function gerarTexto(bot, empresa, sistema, pedido, maxTokens = 4000, { barato = false } = {}) {
  // barato: usa o modelo mais em conta de cada IA (ex.: aprendizado, que lê muito texto)
  const r = await comReserva(empresa, bot, (m) => chamarMotor(empresa, barato ? { ...m, modelo: MODELO_BARATO[m.provedor] || m.modelo } : m, { sistema, turnos: [{ role: 'user', content: pedido }], maxTokens, temperatura: 0.3 }), { tarefa: 'texto' });
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
  const r = await responder(bot, empresa, [...historico, interno], { ...opcoes, canal: 'whatsapp' });
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
    if (err.status === 404) return 'Modelo do Gemini não encontrado para esta chave. Escolha outro no assistente.';
    return `Erro no Gemini: ${err.message}`;
  }
  return err.message || 'Erro desconhecido na IA.';
}

module.exports = {
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
