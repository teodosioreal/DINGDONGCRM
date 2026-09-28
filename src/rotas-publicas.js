// Rotas usadas pelo widget (chat.js) dentro dos sites dos clientes.
// Não exigem login; a proteção é: assistente ativo, domínio autorizado e limites de uso.

const express = require('express');
const { estado, salvar, novoId, agora } = require('./db');
const ia = require('./ia');
const { linkWhatsapp, dominioPermitido, hostDe, texto, hoje, criarLimitador } = require('./util');

const router = express.Router();

const limitePorIp = criarLimitador(12, 60 * 1000); // 12 mensagens/minuto por IP
const MAX_CONVERSAS_GUARDADAS = 5000;

function cors(req, res, next) {
  const origem = req.headers.origin;
  if (origem) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

router.use(cors);

function carregarBot(req, res, botId) {
  const bot = estado.bots.find((b) => b.id === botId);
  const empresa = bot && estado.empresas.find((e) => e.id === bot.empresaId);
  if (!bot || !empresa || bot.ativo === false || empresa.ativa === false) {
    res.status(404).json({ erro: 'Assistente não encontrado ou desativado.' });
    return null;
  }
  const origem = req.headers.origin || req.headers.referer || '';
  if (!dominioPermitido(bot, origem)) {
    res.status(403).json({ erro: 'Este site não está autorizado a usar este assistente.' });
    return null;
  }
  return { bot, empresa };
}

function numeroWhatsapp(bot, empresa) {
  return bot.whatsapp || empresa.whatsapp || '';
}

// Configuração visual que o widget precisa para se desenhar
function enviarConfig(res, bot, empresa) {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    id: bot.id,
    nomeAssistente: bot.nomeAssistente || empresa.nome,
    avatarUrl: bot.avatarUrl || '',
    cor: bot.cor || '#008069',
    boasVindas: bot.boasVindas || `Olá! Sou o assistente virtual da ${empresa.nome}. Como posso ajudar?`,
    chamada: bot.chamada || '',
    whatsappUrl: linkWhatsapp(numeroWhatsapp(bot, empresa), bot.mensagemWhatsappPadrao || ''),
    posicao: bot.posicao === 'esquerda' ? 'esquerda' : 'direita',
    // Conversões ao ir para o WhatsApp (ligadas por padrão)
    conversoes: {
      metaLead: empresa.conversoes?.metaLead !== false,
      metaPixelId: empresa.conversoes?.metaPixelId || '',
      googleLead: empresa.conversoes?.googleLead !== false,
      googleSendTo: empresa.conversoes?.googleSendTo || '',
      valor: Number(empresa.conversoes?.valor) || 0,
      moeda: 'BRL'
    }
  });
}

router.get('/bots/:botId', (req, res) => {
  const achado = carregarBot(req, res, req.params.botId);
  if (achado) enviarConfig(res, achado.bot, achado.empresa);
});

// "Código da empresa": um único script por empresa. Escolhe o assistente ativo
// ligado ao domínio do site; se nenhum tiver o domínio cadastrado, usa o
// assistente principal (desde que ele aceite este site).
router.get('/empresas/:empresaId', (req, res) => {
  const empresa = estado.empresas.find((e) => e.id === req.params.empresaId);
  if (!empresa || empresa.ativa === false) return res.status(404).json({ erro: 'Empresa não encontrada ou pausada.' });
  const origem = req.headers.origin || req.headers.referer || '';
  const host = hostDe(origem);
  const ativos = estado.bots.filter((b) => b.empresaId === empresa.id && b.ativo !== false);
  const doDominio = host && ativos.find((b) => (b.dominios || []).length > 0 && dominioPermitido(b, origem));
  const principal = ativos.find((b) => b.principal) || ativos[0];
  const bot = doDominio || (principal && dominioPermitido(principal, origem) ? principal : null);
  if (!bot) {
    return res.status(ativos.length ? 403 : 404).json({
      erro: ativos.length ? 'Este site não está autorizado para esta empresa.' : 'Esta empresa não tem assistente ativo.'
    });
  }
  enviarConfig(res, bot, empresa);
});

router.post('/chat', async (req, res) => {
  const { botId, visitanteId, conversaId, pagina } = req.body || {};
  const mensagem = texto(req.body?.mensagem, 1000);
  if (!mensagem) return res.status(400).json({ erro: 'Mensagem vazia.' });

  const achado = carregarBot(req, res, String(botId || ''));
  if (!achado) return;
  const { bot, empresa } = achado;

  if (!limitePorIp(`${req.ip}|${bot.id}`)) {
    return res.status(429).json({ erro: 'Muitas mensagens em pouco tempo. Espere um minutinho e tente de novo.' });
  }

  const usoHoje = estado.uso[bot.id]?.data === hoje() ? estado.uso[bot.id] : { data: hoje(), mensagens: 0 };
  if (usoHoje.mensagens >= (bot.limiteDiario || 500)) {
    return res.status(429).json({
      erro: 'O atendimento automático está indisponível no momento.',
      whatsappUrl: linkWhatsapp(numeroWhatsapp(bot, empresa), bot.mensagemWhatsappPadrao || '')
    });
  }

  let conversa = conversaId && estado.conversas.find((c) => c.id === conversaId && c.botId === bot.id);
  if (!conversa) {
    conversa = {
      id: novoId('cv'),
      botId: bot.id,
      empresaId: empresa.id,
      visitanteId: texto(visitanteId, 64) || novoId('vis'),
      pagina: texto(pagina, 300),
      mensagens: [],
      lead: false,
      criadoEm: agora(),
      atualizadoEm: agora()
    };
    estado.conversas.push(conversa);
    if (estado.conversas.length > MAX_CONVERSAS_GUARDADAS) estado.conversas.splice(0, estado.conversas.length - MAX_CONVERSAS_GUARDADAS);
  }

  const doVisitante = conversa.mensagens.filter((m) => m.papel === 'visitante').length;
  if (doVisitante >= (bot.limiteConversa || 40)) {
    return res.status(429).json({
      erro: 'Esta conversa chegou ao limite. Continue com a equipe pelo WhatsApp.',
      whatsappUrl: linkWhatsapp(numeroWhatsapp(bot, empresa), bot.mensagemWhatsappPadrao || '')
    });
  }

  conversa.mensagens.push({ papel: 'visitante', texto: mensagem, em: agora() });
  conversa.atualizadoEm = agora();
  usoHoje.mensagens += 1;
  estado.uso[bot.id] = usoHoje;
  salvar();

  try {
    const resposta = await ia.responder(bot, empresa, conversa.mensagens);
    const whatsappUrl = resposta.mensagemWhatsapp
      ? linkWhatsapp(numeroWhatsapp(bot, empresa), resposta.mensagemWhatsapp)
      : null;
    conversa.mensagens.push({
      papel: 'assistente',
      texto: resposta.texto,
      whatsapp: resposta.mensagemWhatsapp || undefined,
      em: agora()
    });
    conversa.atualizadoEm = agora();
    salvar();
    res.json({ conversaId: conversa.id, visitanteId: conversa.visitanteId, resposta: resposta.texto, whatsappUrl });
  } catch (err) {
    console.error(`[chat ${bot.id}]`, ia.descreverErroIa(err));
    res.status(502).json({
      conversaId: conversa.id,
      erro: 'Não consegui responder agora. Você pode falar direto com a equipe pelo WhatsApp.',
      whatsappUrl: linkWhatsapp(numeroWhatsapp(bot, empresa), bot.mensagemWhatsappPadrao || '')
    });
  }
});

// O widget avisa quando o visitante clica em "Continuar no WhatsApp"
router.post('/lead', (req, res) => {
  const { botId, conversaId } = req.body || {};
  const achado = carregarBot(req, res, String(botId || ''));
  if (!achado) return;
  const conversa = estado.conversas.find((c) => c.id === conversaId && c.botId === achado.bot.id);
  if (conversa && !conversa.lead) {
    conversa.lead = true;
    conversa.leadEm = agora();
    // o que o widget conseguiu disparar no navegador do visitante
    conversa.conversoes = {
      meta: req.body?.meta === true,
      google: req.body?.google === true,
      gtm: req.body?.gtm === true
    };
    salvar();
  }
  res.json({ ok: true });
});

module.exports = router;
