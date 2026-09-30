// ia.js — conversa com a IA escolhida em cada assistente (Claude ou Gemini).

const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('./config');
const { estado } = require('./db');
const { numeroDoAtendimento } = require('./util');

const PROVEDORES = {
  anthropic: { nome: 'Claude (Anthropic)' },
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
const MODELO_PADRAO = { anthropic: 'claude-opus-5-5', gemini: 'gemini-2.5-flash' };

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const MARCADOR_WHATSAPP = /\[\[WHATSAPP\]\]\s*([\s\S]*)$/;

// ---------------------------------------------------------------- chaves

const CAMPO_CHAVE = { anthropic: 'anthropicApiKey', gemini: 'geminiApiKey' };

// Chave usada para uma empresa: a que a própria empresa cadastrou; se ela não
// tiver, usa a chave padrão opcional (Configurações do administrador ou .env).
function chaveDaEmpresa(provedor, empresa) {
  return (empresa?.chavesIa || {})[CAMPO_CHAVE[provedor]] || '';
}

function chavePadrao(provedor) {
  const salvas = estado.config || {};
  return salvas[CAMPO_CHAVE[provedor]] || config[CAMPO_CHAVE[provedor]] || '';
}

function chave(provedor, empresa) {
  return chaveDaEmpresa(provedor, empresa) || chavePadrao(provedor);
}

function provedoresConfigurados(empresa) {
  return Object.keys(PROVEDORES).filter((p) => Boolean(chave(p, empresa)));
}

function erroSemChave(provedor) {
  const erro = new Error(`A empresa ainda não cadastrou a chave do ${PROVEDORES[provedor].nome} (painel → empresa → Chave de IA).`);
  erro.status = 503;
  return erro;
}

// um cliente por chave (cada empresa pode ter a sua)
const clientesAnthropic = new Map();
function obterClienteAnthropic(empresa) {
  const k = chave('anthropic', empresa);
  if (!k) throw erroSemChave('anthropic');
  if (!clientesAnthropic.has(k)) {
    if (clientesAnthropic.size > 200) clientesAnthropic.clear();
    clientesAnthropic.set(k, new Anthropic({ apiKey: k, maxRetries: 2 }));
  }
  return clientesAnthropic.get(k);
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

async function chamarGemini(empresa, caminho, opcoes = {}) {
  const k = chave('gemini', empresa);
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
async function listarModelosGemini(empresa, forcar) {
  const k = chave('gemini', empresa);
  const guardado = cacheGemini.get(k);
  if (!forcar && guardado && Date.now() - guardado.em < 10 * 60 * 1000) return guardado.lista;
  const dados = await chamarGemini(empresa, 'models?pageSize=1000');
  const lista = (dados.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), nome: m.displayName || m.name }))
    .filter((m) => /gemini/i.test(m.id) && !/(embedding|tts|image|audio|live|vision)/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (cacheGemini.size > 200) cacheGemini.clear();
  cacheGemini.set(k, { em: Date.now(), lista });
  return lista;
}

async function listarModelos(provedor, empresa) {
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
async function testarChave(provedor, empresa) {
  if (provedor === 'gemini') {
    const lista = await listarModelosGemini(empresa, true);
    return `Chave do Gemini funcionando (${lista.length} modelos de texto disponíveis).`;
  }
  await obterClienteAnthropic(empresa).models.list({ limit: 1 });
  return 'Chave do Claude funcionando.';
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
    'Como responder:',
    `- Português do Brasil, tom ${tom}.`,
    '- Mensagens curtas (1 a 4 frases), como numa conversa de WhatsApp. Nada de títulos, tabelas ou markdown pesado; no máximo *negrito* com um asterisco de cada lado e listas curtas com "-".',
    '- Use apenas as informações da seção "Sobre a empresa". Se a resposta não estiver lá (preço, prazo, disponibilidade, qualquer detalhe), não invente: diga que vai confirmar com a equipe.',
    '- Faça uma pergunta por vez para entender o que o cliente precisa.',
    '- Se perguntarem, deixe claro que você é um assistente virtual (uma IA), não uma pessoa.',
    '- Assuntos sem relação com a empresa: responda com educação que você só ajuda com assuntos da empresa.'
  ];

  if (noWhatsapp) {
    partes.push(
      '',
      'Continuidade do atendimento:',
      '- O histórico pode ter começado no chat do site da empresa (outra IA, a do site, atendeu antes). Você CONTINUA essa mesma conversa: não se apresente de novo do zero, não repita perguntas que o cliente já respondeu e retome de onde parou.',
      '- Mensagens marcadas como "(equipe)" foram escritas por uma pessoa da empresa. Respeite o que a equipe combinou.',
      '- Áudios do cliente chegam transcritos ("[áudio do cliente]: …") e fotos chegam descritas ("[foto do cliente]: …"): responda ao conteúdo normalmente, sem comentar que foi transcrito. Se vier só "[o cliente enviou um áudio]" sem texto, peça com educação para ele escrever.'
    );
    if (bot.promptWhatsapp?.trim()) partes.push('', 'Instruções da empresa para o WhatsApp:', bot.promptWhatsapp.trim());

    const midias = contexto.midias || [];
    if (midias.length) {
      partes.push(
        '',
        'Mídias que você pode enviar (fotos, vídeos, documentos, áudios; "álbum" manda várias fotos de uma vez):',
        ...midias.map((m) => `- ${m.nome}${m.album ? ` (álbum com ${m.quantidade} arquivos)` : ''}${m.descricao ? `: ${m.descricao}` : ''}`),
        '- Para enviar uma delas, escreva numa linha separada: [[MIDIA: nome exato]]. Pode enviar mais de uma (uma por linha). Só use nomes desta lista e só quando ajudar o cliente. Mostrar fotos do trabalho vende muito: ofereça quando o cliente demonstrar interesse.'
      );
    }
    partes.push(
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
    if (bot.regras?.trim()) partes.push('', 'Instruções da empresa para o chat do site:', bot.regras.trim());
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
      contexto.etapaAtual ? `- O lead está agora na etapa: ${contexto.etapaAtual}.` : '',
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

  const hojeSp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  partes.push(
    '',
    'Registrar vendas e agendamentos (a equipe vê um aviso na conversa e a venda vai para o Faturamento):',
    `- Hoje é ${hojeSp} (horário de Brasília). Use isso para transformar "amanhã", "sábado" etc. em data.`,
    '- Quando o cliente CONFIRMAR a compra (fechou o pedido e combinou o pagamento, ou avisou que pagou), escreva numa linha separada: [[VENDA: valor | o que ele comprou]] — ex.: [[VENDA: 350,00 | Volante em couro]]. Sem valor certo, deixe o valor vazio: [[VENDA: | Volante em couro]].',
    '- Quando o cliente CONFIRMAR um dia e horário (visita, serviço, consulta, instalação, entrega), escreva numa linha separada: [[AGENDAMENTO: dd/mm/aaaa hh:mm | o que foi agendado]] — ex.: [[AGENDAMENTO: 04/10/2026 09:00 | Instalação do volante]].',
    '- Só marque o que foi confirmado pelo cliente (horário apenas sugerido ou "vou ver" não conta) e não marque de novo o que já está registrado abaixo. Remarcou? Marque o novo horário.',
    contexto.tickets ? `Já registrado nesta conversa:\n${contexto.tickets}` : ''
  );

  if (contexto.origem) {
    partes.push(
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

  return partes.filter((l) => l !== null).join('\n');
}

// Converte o histórico salvo ({ papel: 'visitante'|'assistente'|'equipe', texto })
// em turnos alternados. A primeira mensagem precisa ser do usuário, então pulamos
// eventuais mensagens do assistente no começo (ex.: a saudação automática).
function paraTurnos(historico) {
  const turnos = [];
  for (const m of historico) {
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

// ---------------------------------------------------------------- provedores

async function responderClaude(empresa, bot, sistema, turnos) {
  const client = obterClienteAnthropic(empresa);
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
    COM_FALLBACK.has(modelo)
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

async function responderGemini(empresa, bot, sistema, turnos) {
  const modelo = normalizarModelo('gemini', bot.modelo);
  const dados = await chamarGemini(empresa, `models/${encodeURIComponent(modelo)}:generateContent`, {
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
  return { texto, mensagemWhatsapp, midias, etapa, humano, etiquetas, venda, agendamento };
}

/**
 * Gera a resposta do assistente num canal ('site' ou 'whatsapp').
 * @returns {{ texto, mensagemWhatsapp, midias: string[], etapa: string|null, humano: boolean }}
 */
async function responder(bot, empresa, historico, opcoes = {}) {
  const canal = opcoes.canal === 'whatsapp' ? 'whatsapp' : 'site';
  const turnos = paraTurnos(historico.slice(-40));
  if (turnos.length === 0) throw new Error('Nenhuma mensagem do cliente para responder.');
  const sistema = montarPromptSistema(bot, empresa, canal, opcoes);
  const provedor = normalizarProvedor(bot.provedor);

  const bruto = provedor === 'gemini' ? await responderGemini(empresa, bot, sistema, turnos) : await responderClaude(empresa, bot, sistema, turnos);
  if (bruto.recusado) return { texto: bruto.texto, mensagemWhatsapp: null, midias: [], etapa: null, humano: false, etiquetas: [], venda: null, agendamento: null };

  const r = extrairAcoes(bruto.texto);
  if (canal === 'whatsapp') r.mensagemWhatsapp = null; // já está no WhatsApp
  if (!r.texto && canal === 'site') r.texto = 'Posso te passar para o nosso WhatsApp para continuar o atendimento?';
  return r;
}

// ---------------------------------------------------------------- áudio e fotos do cliente

const MODELO_OUVIR = process.env.GEMINI_MODELO_AUDIO || 'gemini-2.5-flash';

// A IA do Claude não ouve áudio; o Gemini ouve. Com a chave do Gemini da
// empresa (ou a padrão), o áudio do cliente vira texto e a IA responde a ele.
function podeOuvirAudio(empresa) {
  return Boolean(chave('gemini', empresa));
}

function textoGemini(dados) {
  return (dados.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

async function transcreverAudio(empresa, base64, mimetype) {
  if (!podeOuvirAudio(empresa)) return null;
  const dados = await chamarGemini(empresa, `models/${MODELO_OUVIR}:generateContent`, {
    method: 'POST',
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: String(mimetype || 'audio/ogg').split(';')[0], data: base64 } },
            { text: 'Transcreva este áudio de WhatsApp exatamente como foi falado, em português do Brasil. Responda só com a transcrição, sem comentários. Se não houver fala, responda: (sem fala)' }
          ]
        }
      ],
      generationConfig: { maxOutputTokens: 2000, temperature: 0 }
    })
  });
  return textoGemini(dados) || null;
}

const PEDIDO_FOTO = 'Descreva em 1 ou 2 frases, em português, o que aparece nesta foto que um cliente mandou pelo WhatsApp para uma empresa (objeto, estado, detalhes úteis para um orçamento e qualquer texto visível). Responda só com a descrição.';

// Descreve a foto do cliente com a IA da empresa (Claude ou Gemini veem imagens)
async function descreverImagem(bot, empresa, base64, mimetype) {
  const mime = String(mimetype || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  const provedor = chave(normalizarProvedor(bot?.provedor), empresa) ? normalizarProvedor(bot?.provedor) : provedoresConfigurados(empresa)[0];
  if (!provedor) return null;
  if (provedor === 'gemini') {
    const dados = await chamarGemini(empresa, `models/${MODELO_OUVIR}:generateContent`, {
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: PEDIDO_FOTO }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.2 }
      })
    });
    return textoGemini(dados) || null;
  }
  const client = obterClienteAnthropic(empresa);
  const r = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          { type: 'text', text: PEDIDO_FOTO }
        ]
      }
    ]
  });
  if (r.stop_reason === 'refusal') return null;
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
}

// Plano B do comprovante (quando o OCR/texto do PDF não deu conta): a IA lê
// a imagem/PDF e devolve os dados do pagamento em JSON.
const PEDIDO_COMPROVANTE =
  'Esta imagem/arquivo é um comprovante de pagamento (Pix, transferência, boleto)? Responda SOMENTE com um JSON, sem texto antes ou depois, no formato: {"ehComprovante": true|false, "valor": "1.250,90", "data": "dd/mm/aaaa hh:mm", "pagador": "nome de quem pagou", "recebedor": "nome de quem recebeu", "banco": "banco de quem pagou", "idTransacao": "id/autenticação", "forma": "Pix|Transferência|Boleto"}. Use "" quando não souber. Não invente valores.';

async function lerComprovante(bot, empresa, base64, mimetype) {
  const mime = String(mimetype || '').split(';')[0];
  const ehPdf = /pdf/i.test(mime);
  if (!ehPdf && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  const provedor = chave(normalizarProvedor(bot?.provedor), empresa) ? normalizarProvedor(bot?.provedor) : provedoresConfigurados(empresa)[0];
  if (!provedor) return null;
  let bruto = '';
  if (provedor === 'gemini') {
    const dados = await chamarGemini(empresa, `models/${MODELO_OUVIR}:generateContent`, {
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: PEDIDO_COMPROVANTE }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0 }
      })
    });
    bruto = textoGemini(dados);
  } else {
    const r = await obterClienteAnthropic(empresa).messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            ehPdf
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
              : { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: PEDIDO_COMPROVANTE }
          ]
        }
      ]
    });
    if (r.stop_reason === 'refusal') return null;
    bruto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const json = (bruto.match(/\{[\s\S]*\}/) || [])[0];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Chamada simples (um pedido, uma resposta) com a IA da empresa — usada na
// varredura das conversas. Respeita o provedor/modelo escolhido pela empresa.
async function gerarTexto(bot, empresa, sistema, pedido, maxTokens = 4000) {
  const provedor = chave(normalizarProvedor(bot?.provedor), empresa) ? normalizarProvedor(bot?.provedor) : provedoresConfigurados(empresa)[0];
  if (!provedor) throw erroSemChave(normalizarProvedor(bot?.provedor));
  const turnos = [{ role: 'user', content: pedido }];
  const falso = { ...bot, provedor, modelo: provedor === normalizarProvedor(bot?.provedor) ? bot.modelo : MODELO_PADRAO[provedor] };
  if (provedor === 'gemini') {
    const modelo = normalizarModelo('gemini', falso.modelo);
    const dados = await chamarGemini(empresa, `models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST',
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents: [{ role: 'user', parts: [{ text: pedido }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 }
      })
    });
    return textoGemini(dados);
  }
  const client = obterClienteAnthropic(empresa);
  const modelo = normalizarModelo('anthropic', falso.modelo);
  const params = {
    model: modelo,
    max_tokens: maxTokens,
    system: sistema,
    messages: turnos,
    ...(modelo === 'claude-haiku-4-5' ? {} : { output_config: { effort: 'low' } })
  };
  const r = COM_FALLBACK.has(modelo)
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (r.stop_reason === 'refusal') throw new Error('A IA recusou o pedido.');
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
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
  chave,
  chaveDaEmpresa,
  chavePadrao,
  CAMPO_CHAVE,
  provedoresConfigurados,
  normalizarProvedor,
  normalizarModelo,
  PROVEDORES,
  MODELO_PADRAO
};
