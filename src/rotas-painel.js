// Rotas do painel (exigem login).
//  - admin: vê e gerencia tudo (empresas, usuários, assistentes, conversas)
//  - empresa: vê e edita só os assistentes e conversas da própria empresa

const express = require('express');
const config = require('./config');
const { versao } = require('./versao');
const { estado, salvar, novoId, agora } = require('./db');
const auth = require('./auth');
const ia = require('./ia');
const leads = require('./leads');
const whatsapp = require('./whatsapp');
const midias = require('./midias');
const { linkWhatsapp, listaDominios, numeroWhatsapp, texto, inteiro, hoje, criarLimitador } = require('./util');

const router = express.Router();
const limiteLogin = criarLimitador(10, 15 * 60 * 1000);

// Toda escrita do painel precisa vir como JSON: junto com o cookie SameSite=Lax,
// isso impede que outro site dispare ações em nome de quem está logado.
router.use((req, res, next) => {
  const upload = req.method === 'POST' && /\/midias$/.test(req.path) && req.is('application/octet-stream');
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json') && !upload) {
    return res.status(415).json({ erro: 'Envie os dados como JSON.' });
  }
  next();
});

// ---------------------------------------------------------------- login

router.post('/auth/login', (req, res) => {
  if (!limiteLogin(req.ip)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
  }
  const email = texto(req.body?.email, 200).toLowerCase();
  const senha = String(req.body?.senha || '');
  const usuario = estado.usuarios.find((u) => u.email === email && u.ativo !== false);
  if (!usuario || !auth.conferirSenha(senha, usuario.senhaHash)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }
  auth.criarSessao(res, usuario);
  res.json({ usuario: auth.usuarioPublico(usuario) });
});

router.post('/auth/sair', (req, res) => {
  auth.encerrarSessao(req, res);
  res.json({ ok: true });
});

router.use(auth.exigirLogin);

router.get('/auth/eu', (req, res) => {
  const empresa = estado.empresas.find((e) => e.id === req.usuario.empresaId);
  res.json({
    usuario: auth.usuarioPublico(req.usuario),
    empresa: empresa ? { id: empresa.id, nome: empresa.nome } : null,
    // "configurado" aqui = existe chave PADRÃO (opcional); cada empresa tem a sua
    provedores: Object.entries(ia.PROVEDORES).map(([id, p]) => ({ id, nome: p.nome, configurado: Boolean(ia.chavePadrao(id)) })),
    urlPublica: config.urlPublica || `${req.protocol}://${req.get('host')}${config.basePath}`,
    versao
  });
});

router.put('/auth/senha', (req, res) => {
  const atual = String(req.body?.senhaAtual || '');
  const nova = String(req.body?.senhaNova || '');
  if (!auth.conferirSenha(atual, req.usuario.senhaHash)) return res.status(400).json({ erro: 'Senha atual incorreta.' });
  if (nova.length < 8) return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  req.usuario.senhaHash = auth.hashSenha(nova);
  salvar();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- permissões

const ehAdmin = (req) => req.usuario.papel === 'admin';
const podeVerEmpresa = (req, empresaId) => ehAdmin(req) || req.usuario.empresaId === empresaId;

function acharBot(req, res) {
  const bot = estado.bots.find((b) => b.id === req.params.id);
  if (!bot || !podeVerEmpresa(req, bot.empresaId)) {
    res.status(404).json({ erro: 'Assistente não encontrado.' });
    return null;
  }
  return bot;
}

// ---------------------------------------------------------------- resumo

router.get('/resumo', (req, res) => {
  const empresasVisiveis = estado.empresas
    .filter((e) => podeVerEmpresa(req, e.id))
    .filter((e) => !req.query.empresaId || e.id === req.query.empresaId);
  const ids = new Set(empresasVisiveis.map((e) => e.id));
  const bots = estado.bots.filter((b) => ids.has(b.empresaId));
  const conversas = estado.conversas.filter((c) => ids.has(c.empresaId));
  const seteDias = new Date(Date.now() - 7 * 864e5).toISOString();
  const recentes = conversas.filter((c) => c.criadoEm >= seteDias);
  const porEtapa = {};
  for (const c of conversas) porEtapa[c.etapa] = (porEtapa[c.etapa] || 0) + 1;
  res.json({
    empresas: empresasVisiveis.length,
    assistentes: bots.length,
    leads7d: recentes.length,
    noWhatsapp7d: recentes.filter((c) => c.whatsappJid).length,
    aguardandoEquipe: conversas.filter((c) => c.precisaHumano).length,
    porEtapa,
    mensagensHoje: bots.reduce((s, b) => s + (estado.uso[b.id]?.data === hoje() ? estado.uso[b.id].mensagens : 0), 0)
  });
});

// ---------------------------------------------------------------- empresas

function dadosEmpresa(body) {
  return {
    nome: texto(body.nome, 120),
    nicho: texto(body.nicho, 120),
    whatsapp: numeroWhatsapp(body.whatsapp),
    responsavel: texto(body.responsavel, 120),
    observacoes: texto(body.observacoes, 2000),
    ativa: body.ativa !== false
  };
}

function mascarar(k) {
  return k ? `••••${k.slice(-4)}` : '';
}

// Situação das chaves de IA de uma empresa — NUNCA devolve a chave em si
function situacaoChavesEmpresa(e) {
  const saida = {};
  for (const provedor of Object.keys(ia.PROVEDORES)) {
    const propria = ia.chaveDaEmpresa(provedor, e);
    const padrao = ia.chavePadrao(provedor);
    saida[provedor] = {
      propria: Boolean(propria),
      final: mascarar(propria),
      usaPadrao: !propria && Boolean(padrao),
      funciona: Boolean(propria || padrao)
    };
  }
  return saida;
}

// Situação do WhatsApp — sem devolver a API key nem o segredo do webhook
function situacaoWhatsapp(e) {
  const c = whatsapp.configDa(e);
  return {
    evolutionUrl: c.evolutionUrl,
    instancia: c.instancia,
    apiKeyFinal: mascarar(c.apiKey),
    iaAtiva: c.iaAtiva,
    configurado: whatsapp.configurado(e)
  };
}

// Empresa como o painel vê: sem as chaves de IA nem segredos
function empresaComExtras(e) {
  const bots = estado.bots.filter((b) => b.empresaId === e.id);
  const principal = bots.find((b) => b.principal) || bots[0];
  const { chavesIa, whatsappConfig, conversoes, midias: _m, ...resto } = e;
  return {
    ...resto,
    etapas: leads.etapasDa(e),
    whatsapp: situacaoWhatsapp(e),
    totalMidias: midias.midiasDa(e).length,
    chaves: situacaoChavesEmpresa(e),
    assistentes: bots.length,
    principalBotId: principal?.id || null
  };
}

function acharEmpresa(req, res) {
  const empresa = estado.empresas.find((e) => e.id === req.params.id);
  if (!empresa || !podeVerEmpresa(req, empresa.id)) {
    res.status(404).json({ erro: 'Empresa não encontrada.' });
    return null;
  }
  return empresa;
}

router.get('/empresas', (req, res) => {
  res.json(estado.empresas.filter((e) => podeVerEmpresa(req, e.id)).map(empresaComExtras));
});

router.get('/empresas/:id', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (empresa) res.json(empresaComExtras(empresa));
});

// Chaves de IA da empresa (a própria empresa ou o admin podem cadastrar)
router.put('/empresas/:id/chaves', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  empresa.chavesIa = empresa.chavesIa || {};
  for (const [provedor, campo] of Object.entries(ia.CAMPO_CHAVE)) {
    const valor = texto(req.body?.[campo], 300);
    if (valor) empresa.chavesIa[campo] = valor;
    if ((req.body?.remover || []).includes(provedor)) delete empresa.chavesIa[campo];
  }
  salvar();
  res.json(empresaComExtras(empresa));
});

router.post('/empresas/:id/chaves/testar', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json({ ok: true, mensagem: await ia.testarChave(ia.normalizarProvedor(req.body?.provedor), empresa) });
  } catch (err) {
    res.status(400).json({ erro: ia.descreverErroIa(err) });
  }
});

// Etapas do funil da empresa (uma por linha no painel)
router.put('/empresas/:id/etapas', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const lista = (Array.isArray(req.body?.etapas) ? req.body.etapas : String(req.body?.etapas || '').split('\n'))
    .map((x) => texto(x, 60))
    .filter(Boolean);
  const unicas = [...new Set(lista)].slice(0, 20);
  if (unicas.length < 2) return res.status(400).json({ erro: 'Cadastre pelo menos 2 etapas.' });
  empresa.etapas = unicas;
  // leads em etapas que deixaram de existir vão para a primeira
  for (const c of estado.conversas) if (c.empresaId === empresa.id && !unicas.includes(c.etapa)) c.etapa = unicas[0];
  salvar();
  res.json(empresaComExtras(empresa));
});

// ---------------------------------------------------------------- WhatsApp da empresa

router.get('/empresas/:id/whatsapp', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ ...situacaoWhatsapp(empresa), webhook: whatsapp.urlWebhook(empresa) });
});

router.put('/empresas/:id/whatsapp', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  const atual = empresa.whatsappConfig || {};
  const url = texto(b.evolutionUrl, 300).replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ erro: 'O endereço da Evolution API precisa começar com https://' });
  empresa.whatsappConfig = {
    ...atual,
    evolutionUrl: url,
    instancia: texto(b.instancia, 100),
    apiKey: texto(b.apiKey, 300) || atual.apiKey || '',
    iaAtiva: b.iaAtiva !== false
  };
  whatsapp.garantirSegredo(empresa);
  salvar();
  res.json({ ...situacaoWhatsapp(empresa), webhook: whatsapp.urlWebhook(empresa) });
});

router.post('/empresas/:id/whatsapp/:acao', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    if (req.params.acao === 'status') return res.json({ estado: await whatsapp.estadoConexao(empresa) });
    if (req.params.acao === 'qrcode') return res.json(await whatsapp.qrCode(empresa));
    if (req.params.acao === 'webhook') return res.json({ ok: true, webhook: await whatsapp.configurarWebhook(empresa) });
    res.status(404).json({ erro: 'Ação desconhecida.' });
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------- mídias da empresa

router.get('/empresas/:id/midias', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(midias.midiasDa(empresa).map((m) => ({ ...m, url: midias.urlPublica(m) })));
});

router.post('/empresas/:id/midias', express.raw({ type: 'application/octet-stream', limit: midias.TAMANHO_MAXIMO + 1024 }), (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const midia = midias.salvarMidia(empresa, {
      buffer: req.body,
      nomeArquivo: texto(req.query.arquivo, 200),
      nome: texto(req.query.nome, 80),
      descricao: texto(req.query.descricao, 300),
      mimetypeInformado: texto(req.query.tipo, 100)
    });
    if (midias.midiasDa(empresa).filter((m) => m.nome.toLowerCase() === midia.nome.toLowerCase()).length > 1) {
      midias.apagarMidia(empresa, midia.id);
      return res.status(400).json({ erro: `Já existe uma mídia chamada "${midia.nome}". Use outro nome.` });
    }
    res.status(201).json({ ...midia, url: midias.urlPublica(midia) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.put('/empresas/:id/midias/:midiaId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const midia = midias.midiasDa(empresa).find((m) => m.id === req.params.midiaId);
  if (!midia) return res.status(404).json({ erro: 'Mídia não encontrada.' });
  const nome = texto(req.body?.nome, 80);
  if (!nome) return res.status(400).json({ erro: 'Dê um nome para a mídia.' });
  if (midias.midiasDa(empresa).some((m) => m.id !== midia.id && m.nome.toLowerCase() === nome.toLowerCase())) {
    return res.status(400).json({ erro: `Já existe uma mídia chamada "${nome}".` });
  }
  midia.nome = nome;
  midia.descricao = texto(req.body?.descricao, 300);
  salvar();
  res.json({ ...midia, url: midias.urlPublica(midia) });
});

router.delete('/empresas/:id/midias/:midiaId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (!midias.apagarMidia(empresa, req.params.midiaId)) return res.status(404).json({ erro: 'Mídia não encontrada.' });
  res.json({ ok: true });
});

// Provedor usado por padrão em assistentes novos: o primeiro que tem chave
function provedorPadrao(empresa) {
  return ia.provedoresConfigurados(empresa)[0] || 'anthropic';
}

router.post('/empresas', auth.exigirAdmin, (req, res) => {
  const dados = dadosEmpresa(req.body || {});
  if (!dados.nome) return res.status(400).json({ erro: 'Informe o nome da empresa.' });
  const empresa = { id: novoId('emp'), ...dados, chavesIa: {}, criadoEm: agora() };
  estado.empresas.push(empresa);

  // Já cria o assistente principal, para o código da empresa funcionar de cara
  const provedor = provedorPadrao(empresa);
  estado.bots.push({
    id: novoId('bot'),
    empresaId: empresa.id,
    principal: true,
    nome: 'Assistente principal',
    nomeAssistente: empresa.nome,
    cor: '#008069',
    posicao: 'direita',
    boasVindas: `Olá! 👋 Sou o assistente virtual da ${empresa.nome}. Como posso te ajudar?`,
    chamada: '',
    tom: '',
    conhecimento: empresa.nicho ? `Ramo: ${empresa.nicho}\n` : '',
    regras: '',
    whatsapp: '',
    mensagemWhatsappPadrao: 'Olá! Vim pelo site.',
    dominios: listaDominios(req.body?.sites),
    ativo: true,
    provedor,
    modelo: ia.MODELO_PADRAO[provedor],
    limiteDiario: 500,
    limiteConversa: 40,
    criadoEm: agora()
  });
  salvar();
  res.status(201).json(empresaComExtras(empresa));
});

router.put('/empresas/:id', auth.exigirAdmin, (req, res) => {
  const empresa = estado.empresas.find((e) => e.id === req.params.id);
  if (!empresa) return res.status(404).json({ erro: 'Empresa não encontrada.' });
  const dados = dadosEmpresa(req.body || {});
  if (!dados.nome) return res.status(400).json({ erro: 'Informe o nome da empresa.' });
  Object.assign(empresa, dados, { atualizadoEm: agora() });
  salvar();
  res.json(empresaComExtras(empresa));
});

router.delete('/empresas/:id', auth.exigirAdmin, (req, res) => {
  const i = estado.empresas.findIndex((e) => e.id === req.params.id);
  if (i < 0) return res.status(404).json({ erro: 'Empresa não encontrada.' });
  const id = estado.empresas[i].id;
  midias.apagarTodasDa(estado.empresas[i]);
  estado.empresas.splice(i, 1);
  const botsRemovidos = new Set(estado.bots.filter((b) => b.empresaId === id).map((b) => b.id));
  estado.bots = estado.bots.filter((b) => b.empresaId !== id);
  estado.conversas = estado.conversas.filter((c) => c.empresaId !== id);
  for (const botId of botsRemovidos) delete estado.uso[botId];
  const usuariosRemovidos = new Set(estado.usuarios.filter((u) => u.empresaId === id).map((u) => u.id));
  estado.usuarios = estado.usuarios.filter((u) => u.empresaId !== id);
  estado.sessoes = estado.sessoes.filter((s) => !usuariosRemovidos.has(s.usuarioId));
  salvar();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- assistentes

const CAMPOS_SO_ADMIN = ['limiteDiario', 'limiteConversa', 'empresaId'];

function dadosBot(body, req) {
  const dados = {
    nome: texto(body.nome, 120),
    nomeAssistente: texto(body.nomeAssistente, 60),
    avatarUrl: texto(body.avatarUrl, 500),
    cor: /^#[0-9a-f]{6}$/i.test(body.cor || '') ? body.cor : '#008069',
    posicao: body.posicao === 'esquerda' ? 'esquerda' : 'direita',
    boasVindas: texto(body.boasVindas, 500),
    chamada: texto(body.chamada, 120),
    tom: texto(body.tom, 200),
    conhecimento: texto(body.conhecimento, 30000),
    regras: texto(body.regras, 5000),
    promptWhatsapp: texto(body.promptWhatsapp, 5000),
    whatsapp: numeroWhatsapp(body.whatsapp),
    mensagemWhatsappPadrao: texto(body.mensagemWhatsappPadrao, 300),
    dominios: listaDominios(body.dominios),
    ativo: body.ativo !== false,
    principal: body.principal === true,
    // cada empresa paga a própria IA, então ela mesma escolhe provedor e modelo
    provedor: ia.normalizarProvedor(body.provedor),
    modelo: ia.normalizarModelo(ia.normalizarProvedor(body.provedor), body.modelo)
  };
  if (ehAdmin(req)) {
    dados.empresaId = String(body.empresaId || '');
    dados.limiteDiario = inteiro(body.limiteDiario, 500, 1, 100000);
    dados.limiteConversa = inteiro(body.limiteConversa, 40, 1, 500);
  }
  return dados;
}

// Cada empresa tem um assistente principal (é ele que o "código da empresa" usa
// quando nenhum outro assistente está ligado ao domínio do site).
function ajustarPrincipal(bot, empresaAnterior) {
  if (bot.principal) {
    for (const b of estado.bots) if (b.empresaId === bot.empresaId && b.id !== bot.id) b.principal = false;
  }
  for (const empresaId of new Set([bot.empresaId, empresaAnterior].filter(Boolean))) {
    const daEmpresa = estado.bots.filter((b) => b.empresaId === empresaId);
    if (daEmpresa.length && !daEmpresa.some((b) => b.principal)) daEmpresa[0].principal = true;
  }
}

function botComExtras(bot) {
  const empresa = estado.empresas.find((e) => e.id === bot.empresaId);
  const uso = estado.uso[bot.id]?.data === hoje() ? estado.uso[bot.id].mensagens : 0;
  return { ...bot, empresaNome: empresa?.nome || '—', mensagensHoje: uso };
}

router.get('/bots', (req, res) => {
  const lista = estado.bots
    .filter((b) => podeVerEmpresa(req, b.empresaId))
    .filter((b) => !req.query.empresaId || b.empresaId === req.query.empresaId)
    .map(botComExtras);
  res.json(lista);
});

router.get('/bots/:id', (req, res) => {
  const bot = acharBot(req, res);
  if (bot) res.json(botComExtras(bot));
});

router.post('/bots', (req, res) => {
  const dados = dadosBot(req.body || {}, req);
  if (!ehAdmin(req)) dados.empresaId = req.usuario.empresaId;
  if (!estado.empresas.some((e) => e.id === dados.empresaId)) return res.status(400).json({ erro: 'Escolha a empresa.' });
  if (!dados.nome) return res.status(400).json({ erro: 'Dê um nome para o assistente.' });
  const provedor = provedorPadrao(estado.empresas.find((e) => e.id === dados.empresaId));
  const bot = {
    id: novoId('bot'),
    provedor,
    modelo: ia.MODELO_PADRAO[provedor],
    limiteDiario: 500,
    limiteConversa: 40,
    ...dados,
    criadoEm: agora()
  };
  if (!estado.bots.some((b) => b.empresaId === bot.empresaId)) bot.principal = true;
  estado.bots.push(bot);
  ajustarPrincipal(bot);
  salvar();
  res.status(201).json(botComExtras(bot));
});

router.put('/bots/:id', (req, res) => {
  const bot = acharBot(req, res);
  if (!bot) return;
  const dados = dadosBot(req.body || {}, req);
  if (!dados.nome) return res.status(400).json({ erro: 'Dê um nome para o assistente.' });
  if (!ehAdmin(req)) for (const c of CAMPOS_SO_ADMIN) delete dados[c];
  else if (!estado.empresas.some((e) => e.id === dados.empresaId)) return res.status(400).json({ erro: 'Escolha a empresa.' });
  const empresaAntes = bot.empresaId;
  Object.assign(bot, dados, { atualizadoEm: agora() });
  ajustarPrincipal(bot, empresaAntes);
  // conversas antigas acompanham a empresa do assistente
  for (const c of estado.conversas) if (c.botId === bot.id) c.empresaId = bot.empresaId;
  salvar();
  res.json(botComExtras(bot));
});

router.delete('/bots/:id', (req, res) => {
  const bot = acharBot(req, res);
  if (!bot) return;
  estado.bots = estado.bots.filter((b) => b.id !== bot.id);
  const restantes = estado.bots.filter((b) => b.empresaId === bot.empresaId);
  if (restantes.length && !restantes.some((b) => b.principal)) restantes[0].principal = true;
  estado.conversas = estado.conversas.filter((c) => c.botId !== bot.id);
  delete estado.uso[bot.id];
  salvar();
  res.json({ ok: true });
});

// Conversa de teste no painel: usa a configuração que está no formulário (mesmo
// sem salvar) e não grava nada.
router.post('/bots/:id/testar', async (req, res) => {
  const salvo = acharBot(req, res);
  if (!salvo) return;
  const rascunho = { ...salvo, ...dadosBot(req.body?.bot || {}, req) };
  if (!ehAdmin(req)) for (const c of CAMPOS_SO_ADMIN) rascunho[c] = salvo[c];
  const empresa = estado.empresas.find((e) => e.id === rascunho.empresaId) || estado.empresas.find((e) => e.id === salvo.empresaId);
  const historico = (Array.isArray(req.body?.mensagens) ? req.body.mensagens : [])
    .slice(-30)
    .map((m) => ({ papel: m.papel === 'visitante' ? 'visitante' : 'assistente', texto: texto(m.texto, 2000) }))
    .filter((m) => m.texto);
  const canal = req.body?.canal === 'whatsapp' ? 'whatsapp' : 'site';
  try {
    const r = await ia.responder(rascunho, empresa, historico, {
      canal,
      etapas: leads.etapasDa(empresa),
      midias: midias.midiasDa(empresa)
    });
    res.json({
      resposta: r.texto,
      whatsappUrl: r.mensagemWhatsapp ? linkWhatsapp(rascunho.whatsapp || empresa?.whatsapp, r.mensagemWhatsapp) : null,
      midias: r.midias,
      etapa: r.etapa,
      humano: r.humano
    });
  } catch (err) {
    res.status(err.status === 503 ? 503 : 502).json({ erro: ia.descreverErroIa(err) });
  }
});

// ---------------------------------------------------------------- leads

function resumoLead(c) {
  const ultima = [...c.mensagens].reverse().find((m) => m.texto);
  const canais = [...new Set(c.mensagens.map((m) => m.canal || 'site'))];
  return {
    id: c.id,
    codigo: c.codigo,
    etapa: c.etapa,
    nome: c.nome || '',
    telefone: c.telefone || '',
    origem: c.origem || 'site',
    canais,
    noWhatsapp: Boolean(c.whatsappJid),
    iaPausada: Boolean(c.iaPausada),
    precisaHumano: Boolean(c.precisaHumano),
    mensagens: c.mensagens.length,
    ultimaMensagem: ultima ? { texto: ultima.texto.slice(0, 140), papel: ultima.papel, canal: ultima.canal || 'site' } : null,
    criadoEm: c.criadoEm,
    atualizadoEm: c.atualizadoEm
  };
}

function acharLead(req, res) {
  const c = estado.conversas.find((x) => x.id === req.params.id);
  if (!c || !podeVerEmpresa(req, c.empresaId)) {
    res.status(404).json({ erro: 'Lead não encontrado.' });
    return null;
  }
  return c;
}

router.get('/leads', (req, res) => {
  const busca = String(req.query.busca || '').trim().toLowerCase();
  const lista = estado.conversas
    .filter((c) => podeVerEmpresa(req, c.empresaId))
    .filter((c) => !req.query.empresaId || c.empresaId === req.query.empresaId)
    .filter((c) => !req.query.etapa || c.etapa === req.query.etapa)
    .filter((c) => !busca || [c.nome, c.telefone, c.codigo, ...c.mensagens.map((m) => m.texto)].join(' ').toLowerCase().includes(busca))
    .sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1))
    .slice(0, 1000)
    .map(resumoLead);
  res.json(lista);
});

router.get('/leads/:id', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const bot = estado.bots.find((b) => b.id === c.botId);
  const { whatsappJid, ...resto } = c;
  res.json({ ...resto, noWhatsapp: Boolean(whatsappJid), botNome: bot?.nome || '—', etapas: leads.etapasDa(empresa) });
});

// Equipe muda etapa, nome ou liga/desliga a IA naquele lead
router.put('/leads/:id', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const b = req.body || {};
  if (b.etapa !== undefined && !leads.moverEtapa(c, empresa, b.etapa, 'equipe') && !leads.acharEtapa(empresa, b.etapa)) {
    return res.status(400).json({ erro: 'Etapa inválida.' });
  }
  if (b.nome !== undefined) c.nome = texto(b.nome, 120);
  if (b.anotacoes !== undefined) c.anotacoes = texto(b.anotacoes, 5000);
  if (b.iaPausada !== undefined) {
    c.iaPausada = b.iaPausada === true;
    c.iaPausadaMotivo = c.iaPausada ? 'Pausada pela equipe no painel' : '';
    if (!c.iaPausada) c.precisaHumano = false;
    if (c.iaPausada) whatsapp.cancelarResposta(c.id);
  }
  c.atualizadoEm = agora();
  salvar();
  res.json(resumoLead(c));
});

// Equipe responde pelo painel (vai pelo WhatsApp; a IA para neste lead)
router.post('/leads/:id/mensagem', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const msg = texto(req.body?.texto, 4000);
  if (!msg) return res.status(400).json({ erro: 'Escreva a mensagem.' });
  try {
    await whatsapp.enviarPelaEquipe(empresa, c, msg);
    res.json(resumoLead(c));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ erro: err.message });
  }
});

router.delete('/leads/:id', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  whatsapp.cancelarResposta(c.id);
  estado.conversas = estado.conversas.filter((x) => x.id !== c.id);
  salvar();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- chaves de IA (só admin)

function situacaoChaves() {
  const salvas = estado.config || {};
  const item = (campoPainel, campoEnv) => {
    const doPainel = salvas[campoPainel] || '';
    const doEnv = config[campoEnv] || '';
    return {
      configurada: Boolean(doPainel || doEnv),
      origem: doPainel ? 'painel' : doEnv ? 'arquivo .env' : null,
      final: mascarar(doPainel || doEnv)
    };
  };
  return { anthropic: item('anthropicApiKey', 'anthropicApiKey'), gemini: item('geminiApiKey', 'geminiApiKey') };
}

router.get('/config', auth.exigirAdmin, (req, res) => res.json(situacaoChaves()));

router.put('/config', auth.exigirAdmin, (req, res) => {
  estado.config = estado.config || {};
  const campos = { anthropic: 'anthropicApiKey', gemini: 'geminiApiKey' };
  for (const [provedor, campo] of Object.entries(campos)) {
    const valor = texto(req.body?.[campo], 300);
    if (valor) estado.config[campo] = valor;
    if ((req.body?.remover || []).includes(provedor)) delete estado.config[campo];
  }
  salvar();
  res.json(situacaoChaves());
});

router.post('/config/testar', auth.exigirAdmin, async (req, res) => {
  const provedor = ia.normalizarProvedor(req.body?.provedor);
  try {
    res.json({ ok: true, mensagem: await ia.testarChave(provedor, null) });
  } catch (err) {
    res.status(400).json({ erro: ia.descreverErroIa(err) });
  }
});

router.get('/ia/modelos', async (req, res) => {
  const empresaId = String(req.query.empresaId || '');
  const empresa = empresaId && podeVerEmpresa(req, empresaId) ? estado.empresas.find((e) => e.id === empresaId) : null;
  res.json(await ia.listarModelos(ia.normalizarProvedor(req.query.provedor), empresa));
});

// ---------------------------------------------------------------- usuários (só admin)

router.get('/usuarios', auth.exigirAdmin, (req, res) => {
  res.json(
    estado.usuarios.map((u) => ({
      ...auth.usuarioPublico(u),
      empresaNome: estado.empresas.find((e) => e.id === u.empresaId)?.nome || null
    }))
  );
});

function validarUsuario(body, existente) {
  const dados = {
    nome: texto(body.nome, 120),
    email: texto(body.email, 200).toLowerCase(),
    papel: body.papel === 'admin' ? 'admin' : 'empresa',
    empresaId: body.papel === 'admin' ? null : String(body.empresaId || ''),
    ativo: body.ativo !== false
  };
  if (!dados.nome) return { erro: 'Informe o nome.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) return { erro: 'E-mail inválido.' };
  if (estado.usuarios.some((u) => u.email === dados.email && u.id !== existente?.id)) return { erro: 'Já existe um usuário com esse e-mail.' };
  if (dados.papel === 'empresa' && !estado.empresas.some((e) => e.id === dados.empresaId)) return { erro: 'Escolha a empresa do usuário.' };
  const senha = String(body.senha || '');
  if (!existente && senha.length < 8) return { erro: 'A senha precisa ter pelo menos 8 caracteres.' };
  if (existente && senha && senha.length < 8) return { erro: 'A senha precisa ter pelo menos 8 caracteres.' };
  return { dados, senha };
}

router.post('/usuarios', auth.exigirAdmin, (req, res) => {
  const v = validarUsuario(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const usuario = { id: novoId('usr'), ...v.dados, senhaHash: auth.hashSenha(v.senha), criadoEm: agora() };
  estado.usuarios.push(usuario);
  salvar();
  res.status(201).json(auth.usuarioPublico(usuario));
});

router.put('/usuarios/:id', auth.exigirAdmin, (req, res) => {
  const usuario = estado.usuarios.find((u) => u.id === req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  const v = validarUsuario(req.body || {}, usuario);
  if (v.erro) return res.status(400).json({ erro: v.erro });
  if (usuario.id === req.usuario.id && (v.dados.papel !== 'admin' || !v.dados.ativo)) {
    return res.status(400).json({ erro: 'Você não pode tirar o seu próprio acesso de administrador.' });
  }
  Object.assign(usuario, v.dados);
  if (v.senha) usuario.senhaHash = auth.hashSenha(v.senha);
  if (v.senha || !usuario.ativo) estado.sessoes = estado.sessoes.filter((s) => s.usuarioId !== usuario.id || usuario.id === req.usuario.id);
  salvar();
  res.json(auth.usuarioPublico(usuario));
});

router.delete('/usuarios/:id', auth.exigirAdmin, (req, res) => {
  if (req.params.id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode excluir o seu próprio usuário.' });
  const antes = estado.usuarios.length;
  estado.usuarios = estado.usuarios.filter((u) => u.id !== req.params.id);
  if (estado.usuarios.length === antes) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  estado.sessoes = estado.sessoes.filter((s) => s.usuarioId !== req.params.id);
  salvar();
  res.json({ ok: true });
});

module.exports = router;
