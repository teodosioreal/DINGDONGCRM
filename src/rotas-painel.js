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
const origem = require('./origem');
const siteEmpresa = require('./site');
const tickets = require('./tickets');
const fotosClientes = require('./fotos-clientes');
const lixeira = require('./lixeira');
const localizacao = require('./localizacao');
const alertas = require('./alertas');
const backup = require('./backup');
const midias = require('./midias');
const disparos = require('./disparos');
const automacoes = require('./automacoes');
const comprovantes = require('./comprovantes');
const aprendizado = require('./aprendizado');
const fs = require('fs');
const path = require('path');
const { linkWhatsapp, numeroDoAtendimento, listaDominios, numeroWhatsapp, texto, inteiro, hoje, criarLimitador, tipoDeArquivoSeguro } = require('./util');

const router = express.Router();
const limiteLogin = criarLimitador(10, 15 * 60 * 1000);
// por e-mail, contando só senha errada: segura quem troca de IP para adivinhar a senha
const falhasLogin = new Map();
const JANELA_FALHAS = 15 * 60 * 1000;
const falhasRecentes = (email) => (falhasLogin.get(email) || []).filter((t) => Date.now() - t < JANELA_FALHAS);

// Toda escrita do painel precisa vir como JSON: junto com o cookie SameSite=Lax,
// isso impede que outro site dispare ações em nome de quem está logado.
router.use((req, res, next) => {
  const upload = req.method === 'POST' && /\/(midias|arquivo|logo|comprovante|parte)$/.test(req.path) && req.is('application/octet-stream');
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
  const senha = String(req.body?.senha || '').slice(0, 500); // senha gigante não trava o servidor no scrypt
  if (falhasRecentes(email).length >= 8) {
    return res.status(429).json({ erro: 'Muitas senhas erradas nesta conta. Espere 15 minutos e tente de novo.' });
  }
  const usuario = estado.usuarios.find((u) => u.email === email && u.ativo !== false);
  if (!usuario || !auth.conferirSenha(senha, usuario.senhaHash)) {
    if (falhasLogin.size > 5000) falhasLogin.clear(); // não cresce sem fim
    falhasLogin.set(email, [...falhasRecentes(email), Date.now()]);
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }
  falhasLogin.delete(email);
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
    totalLeads: conversas.length,
    automaticas7d: conversas.reduce((n, c) => n + c.mensagens.filter((m) => (m.automacaoId || m.followupPasso) && m.em >= seteDias).length, 0),
    recuperados7d: conversas.filter((c) => c.ultimaAutomacaoEm && c.ultimaAutomacaoEm >= seteDias && c.mensagens.some((m) => m.papel === 'visitante' && m.em > c.ultimaAutomacaoEm)).length,
    disparosAtivos: estado.disparos.filter((d) => ids.has(d.empresaId) && ['enviando', 'agendado'].includes(d.status)).length,
    porEtapa,
    // de onde vieram os leads dos últimos 30 dias (anúncio, Google, Instagram…)
    porFonte: (() => {
      const trinta = new Date(Date.now() - 30 * 864e5).toISOString();
      const cont = {};
      for (const c of conversas) {
        if (c.criadoEm < trinta) continue;
        const f = c.origemSite?.classificacao?.fonte || (c.origem === 'whatsapp' ? 'Direto no WhatsApp' : c.origem === 'manual' ? 'Cadastro manual' : 'Site (sem informação)');
        cont[f] = (cont[f] || 0) + 1;
      }
      return Object.entries(cont).map(([fonte, n]) => ({ fonte, n })).sort((a, b) => b.n - a.n).slice(0, 8);
    })(),
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
    ativa: body.ativa !== false,
    ...(body.usarChavePadrao !== undefined ? { usarChavePadrao: body.usarChavePadrao === true } : {})
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
    const padrao = ia.podeUsarChavePadrao(e) ? ia.chavePadrao(provedor) : '';
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
function situacaoWhatsapp(e, req) {
  const c = whatsapp.configDa(e);
  return {
    sessao: c.instancia,
    apiKeyFinal: mascarar(c.apiKey),
    iaAtiva: c.iaAtiva,
    configurado: whatsapp.configurado(e),
    perfil: c.perfil,
    criadaPeloCrm: c.criadaPeloCrm,
    modoTeste: Boolean(e.whatsappConfig?.modoTeste),
    numerosTeste: e.whatsappConfig?.numerosTeste || '',
    velocidade: whatsapp.VELOCIDADES[e.whatsappConfig?.velocidade] ? e.whatsappConfig.velocidade : 'humanizado',
    esperaPrimeiraSeg: Number(e.whatsappConfig?.esperaPrimeiraSeg) || 0,
    iaAposManual: e.whatsappConfig?.iaAposManual === true,
    naoAtropelar: e.whatsappConfig?.naoAtropelar !== false,
    sincronia: e.whatsappConfig?.sincronia || null,
    clone: (({ ativo, total, midiasAprendidas }) => ({ ativo, total, midiasAprendidas }))(require('./clone').resumo(e)),
    whatsappAvisos: e.whatsappAvisos || '',
    // o CRM consegue criar a conexão sozinho (tem a chave global da Evolution)
    podeCriar: whatsapp.podeCriarInstancia(),
    // endereço da Evolution: só o admin vê/troca (a empresa só usa Session ID + API Key)
    ...(req && ehAdmin(req) ? { evolutionUrl: c.evolutionUrl, evolutionUrlPropria: e.whatsappConfig?.evolutionUrl || '' } : {})
  };
}

// O que precisa de atenção (sem IA: só regras) + ✓ de cada configuração do menu.
// status: 'ok' (configurado), 'atencao' (falta algo) ou 'off' (desligado de propósito)
function situacaoConfig(e, principal) {
  const temChave = Object.keys(ia.PROVEDORES).some((p) => ia.chave(p, e));
  const motores = ia.motoresDa(e, principal);
  const zap = whatsapp.configDa(e);
  const conectado = whatsapp.configurado(e);
  const desconectado = conectado && zap.perfil?.estado && zap.perfil.estado !== 'open';
  const conhecimento = String(principal?.conhecimento || '');
  const sobreIncompleto = conhecimento.trim().length < 200 || /\.\.\./.test(conhecimento);
  const aConfigurar = midias.midiasDa(e).filter((m) => m.pronta === false).length;
  const regras = automacoes.automacoesDa(e).filter((r) => r.ativa);
  const site = siteEmpresa.resumo(e);
  const siteIlegivel = site.links.length && site.paginas.length && site.paginas.every((p) => p.poucoTexto) && !site.copia;
  const dicas = [];
  const add = (nivel, texto, sub) => dicas.push({ nivel, texto, sub });
  if (e.ativa === false) add('erro', 'A empresa está pausada: a IA e as automações não respondem ninguém.', '');
  if (!temChave) add('erro', 'Nenhuma IA tem chave. Cadastre pelo menos uma em IAs e chaves.', 'chave');
  else if (motores.length < 2) add('dica', 'Cadastre uma 2ª IA de reserva: se a principal ficar sem crédito, a reserva responde na hora.', 'chave');
  if (zap.iaAtiva && !conectado) add('aviso', 'Conecte o WhatsApp para a IA atender por lá.', 'whatsapp');
  if (desconectado) add('erro', 'O WhatsApp está desconectado. Gere o QR code e conecte de novo.', 'whatsapp');
  if (e.whatsappConfig?.modoTeste) add('aviso', 'Modo teste ligado: a IA só responde os números de teste.', 'whatsapp');
  if (sobreIncompleto) add('aviso', 'Complete "Sobre a empresa" (preços, serviços, horários): quanto mais informação, melhor a IA vende.', 'ia');
  if (aConfigurar) add('aviso', `${aConfigurar} mídia(s) esperando configuração — a IA ainda não usa.`, 'midias');
  if (regras.some((r) => r.receita === 'avaliacao') && !principal?.linkAvaliacao) add('erro', 'A automação de avaliação está ligada, mas falta o link do Google.', 'automacoes');
  if (regras.some((r) => r.receita === 'comentario') && !principal?.linkAnuncio) add('erro', 'A automação de comentário no anúncio está ligada, mas falta o link do anúncio.', 'automacoes');
  if (siteIlegivel) add('aviso', 'O CRM não conseguiu ler o texto do seu site só com o link: cole a copy em Aprendizados → Seu site.', 'aprendizado');
  if (conectado && !e.whatsappAvisos) add('dica', 'Cadastre um WhatsApp para receber avisos quando algo der errado.', 'whatsapp');
  const status = {
    ia: sobreIncompleto ? 'atencao' : 'ok',
    aprendizado: siteIlegivel ? 'atencao' : e.aprendizado?.texto || site.caracteresNaIa || (e.anuncios || []).length ? 'ok' : 'off',
    site: principal && principal.ativo !== false ? 'ok' : 'off',
    whatsapp: !zap.iaAtiva ? 'off' : !conectado || desconectado ? 'atencao' : 'ok',
    midias: aConfigurar ? 'atencao' : midias.midiasDa(e).length ? 'ok' : 'off',
    catalogo: require('./catalogo').resumo(e).ativos ? 'ok' : 'off',
    organizar: 'ok',
    chave: temChave ? 'ok' : 'atencao'
  };
  return { dicas, status };
}

// As 3 IAs em ordem (sem devolver as chaves)
function resumoMotores(e) {
  const lista = Array.isArray(e.motoresIa) ? e.motoresIa : [];
  return lista.map((m, i) => ({
    ordem: i + 1,
    provedor: ia.normalizarProvedor(m.provedor),
    modelo: ia.normalizarModelo(ia.normalizarProvedor(m.provedor), m.modelo),
    chavePropria: Boolean(m.chave),
    chaveFinal: mascarar(m.chave),
    temChave: Boolean(m.chave || ia.chave(ia.normalizarProvedor(m.provedor), e))
  }));
}

function principalDa(e) {
  const bots = estado.bots.filter((b) => b.empresaId === e.id);
  return bots.find((b) => b.principal) || bots[0] || null;
}

// Empresa como o painel vê: sem as chaves de IA nem segredos
function empresaComExtras(e, req) {
  const bots = estado.bots.filter((b) => b.empresaId === e.id);
  const principal = principalDa(e);
  const { chavesIa, whatsappConfig, conversoes, midias: _m, motoresIa, usoIa, ...resto } = e;
  const idsEmpresa = new Set([e.id]);
  return {
    ...resto,
    motores: resumoMotores(e),
    usoHoje: ia.usoDoDia(e),
    uso7d: ia.usoDoPeriodo(e, 7),
    uso30d: ia.usoDoPeriodo(e, 30),
    ...situacaoConfig(e, principal),
    midiasAConfigurar: midias.midiasDa(e).filter((m) => m.pronta === false).length,
    alertasNaoLidos: alertas.naoLidos(idsEmpresa),
    etapas: leads.etapasDa(e),
    etiquetas: leads.etiquetasDa(e),
    links: midias.linksDa(e),
    drivePastas: midias.pastasDa(e),
    respostasRapidas: e.respostasRapidas || [],
    atalhosNoCelular: e.atalhosNoCelular !== false,
    naoLidas: estado.conversas.reduce((n, c) => n + (c.empresaId === e.id ? c.naoLidas || 0 : 0), 0),
    followupAtivo: e.followup?.ativo === true,
    logoUrl: e.logo ? `${config.urlPublica}/logo/${e.id}?v=${encodeURIComponent(e.logo.v)}` : '',
    faturamentoMes: comprovantes.resumo(e).mes,
    leads7d: estado.conversas.filter((c) => c.empresaId === e.id && c.criadoEm >= new Date(Date.now() - 7 * 864e5).toISOString()).length,
    ouveAudio: ia.podeOuvirAudio(e),
    // número salvo no cadastro ("whatsapp" abaixo é a situação da conexão)
    whatsappNumero: e.whatsapp || '',
    // as duas IAs ligam/desligam separadas
    canais: { site: Boolean(principal && principal.ativo !== false), whatsapp: whatsapp.configDa(e).iaAtiva },
    whatsapp: situacaoWhatsapp(e, req),
    totalMidias: midias.midiasDa(e).length,
    totalCatalogo: require('./catalogo').resumo(e).ativos,
    agendaHoje: estado.conversas.reduce((n, c) => n + (c.empresaId === e.id ? (c.agendamentos || []).filter((a) => a.status === 'agendado' && a.quando && new Date(a.quando).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) === new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })).length : 0), 0),
    chatNoSite: estado.conversas.some((c) => c.empresaId === e.id && c.origem === 'site'), // o código já está no site
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
  res.json(estado.empresas.filter((e) => podeVerEmpresa(req, e.id)).map((e) => empresaComExtras(e, req)));
});

router.get('/empresas/:id', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (empresa) res.json(empresaComExtras(empresa, req));
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
  res.json(empresaComExtras(empresa, req));
});

// Ordem das IAs: principal + até 2 reservas. Cada uma pode ter a própria
// chave (ex.: duas contas do Claude) ou usar a chave da empresa para aquela IA.
router.put('/empresas/:id/motores', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const antigos = Array.isArray(empresa.motoresIa) ? empresa.motoresIa : [];
  const lista = [];
  for (const [i, m] of (Array.isArray(req.body?.motores) ? req.body.motores : []).slice(0, 3).entries()) {
    if (!m || !m.provedor) continue;
    const provedor = ia.normalizarProvedor(m.provedor);
    const novo = { provedor, modelo: ia.normalizarModelo(provedor, m.modelo) };
    const chaveNova = texto(m.chave, 300);
    // chave vazia = mantém a chave própria que já estava nesta posição (se for a mesma IA)
    if (chaveNova) novo.chave = chaveNova;
    else if (!m.removerChave && antigos[i]?.chave && ia.normalizarProvedor(antigos[i].provedor) === provedor) novo.chave = antigos[i].chave;
    lista.push(novo);
  }
  empresa.motoresIa = lista;
  // o assistente acompanha a IA principal (o que a tela do assistente mostra)
  if (lista[0]) for (const b of estado.bots.filter((x) => x.empresaId === empresa.id)) Object.assign(b, { provedor: lista[0].provedor, modelo: lista[0].modelo });
  salvar();
  res.json(empresaComExtras(empresa, req));
});

// Testa uma posição de verdade (um pedido bem curto no modelo escolhido)
router.post('/empresas/:id/motores/testar', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const m = (empresa.motoresIa || [])[Number(req.body?.indice) || 0];
  if (!m) return res.status(400).json({ erro: 'Escolha a IA desta posição e salve antes de testar.' });
  const motor = { provedor: ia.normalizarProvedor(m.provedor), modelo: ia.normalizarModelo(ia.normalizarProvedor(m.provedor), m.modelo), chave: m.chave || '' };
  try {
    await ia.testarMotor(empresa, motor);
    res.json({ ok: true, mensagem: `${ia.PROVEDORES[motor.provedor].nome} · ${motor.modelo} respondeu. Funcionando!` });
  } catch (err) {
    res.status(400).json({ erro: ia.descreverErroIa(err) });
  }
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
  empresa.funilV2 = true; // funil escolhido pela empresa: a troca automática não mexe mais
  // leads em etapas que deixaram de existir vão para a primeira
  for (const c of estado.conversas) if (c.empresaId === empresa.id && !unicas.includes(c.etapa)) c.etapa = unicas[0];
  salvar();
  res.json(empresaComExtras(empresa, req));
});

// ---------------------------------------------------------------- WhatsApp da empresa

router.get('/empresas/:id/whatsapp', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(situacaoWhatsapp(empresa, req));
});

// Liga/desliga a IA do WhatsApp; o admin pode apontar uma Evolution própria
router.put('/empresas/:id/whatsapp', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  empresa.whatsappConfig = empresa.whatsappConfig || {};
  if (b.iaAtiva !== undefined) empresa.whatsappConfig.iaAtiva = b.iaAtiva !== false;
  if (b.modoTeste !== undefined) empresa.whatsappConfig.modoTeste = b.modoTeste === true;
  if (b.iaAposManual !== undefined) empresa.whatsappConfig.iaAposManual = b.iaAposManual === true;
  if (b.naoAtropelar !== undefined) empresa.whatsappConfig.naoAtropelar = b.naoAtropelar !== false;
  if (b.numerosTeste !== undefined) {
    const lista = String(b.numerosTeste || '').split(/[,;\n]+/).map((n) => numeroWhatsapp(n)).filter((n) => n.length >= 10);
    if (b.modoTeste === true && !lista.length) return res.status(400).json({ erro: 'Informe pelo menos um número de teste (com DDD).' });
    empresa.whatsappConfig.numerosTeste = [...new Set(lista)].slice(0, 20).join(', ');
  }
  if (b.velocidade !== undefined && whatsapp.VELOCIDADES[b.velocidade]) empresa.whatsappConfig.velocidade = b.velocidade;
  if (b.esperaPrimeiraSeg !== undefined) empresa.whatsappConfig.esperaPrimeiraSeg = inteiro(b.esperaPrimeiraSeg, 0, 0, 3600);
  if (b.whatsappAvisos !== undefined) {
    const n = numeroWhatsapp(b.whatsappAvisos);
    if (b.whatsappAvisos && n.length < 10) return res.status(400).json({ erro: 'Número para avisos inválido (use DDD).' });
    empresa.whatsappAvisos = n;
  }
  if (ehAdmin(req) && b.evolutionUrl !== undefined) {
    const url = texto(b.evolutionUrl, 300).replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ erro: 'O endereço da Evolution API precisa começar com https://' });
    empresa.whatsappConfig.evolutionUrl = url;
  }
  salvar();
  res.json(situacaoWhatsapp(empresa, req));
});

function erroWhatsapp(res, err) {
  if (err.status === 409) return res.status(409).json({ erro: err.message, webhookAtual: err.webhookAtual, precisaConfirmar: true });
  res.status(err.status && err.status < 500 ? 400 : 502).json({ erro: err.message });
}

router.post('/empresas/:id/whatsapp/:acao', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  try {
    switch (req.params.acao) {
      case 'conectar':
        return res.json(await whatsapp.conectar(empresa, { sessionId: texto(b.sessionId, 120), apiKey: texto(b.apiKey, 300), forcar: b.forcar === true }));
      case 'criar':
        return res.json(await whatsapp.criarInstancia(empresa));
      case 'pareamento':
        return res.json(await whatsapp.codigoPareamento(empresa, texto(b.telefone, 30)));
      case 'sincronizar': {
        // busca na Evolution as mensagens que não chegaram (1, 7 ou 30 dias)
        const dias = [1, 7, 30].includes(Number(b.dias)) ? Number(b.dias) : 7;
        if (!whatsapp.configurado(empresa)) return res.status(400).json({ erro: 'Conecte o WhatsApp primeiro.' });
        const r = await require('./sincronizar').sincronizarEmpresa(empresa, { dias, motivo: 'botão' });
        if (r?.emAndamento) return res.status(409).json({ erro: 'Já estou buscando as mensagens. Aguarde um pouco.' });
        if (r?.erro) return res.status(502).json({ erro: `Não consegui buscar no WhatsApp: ${r.erro}` });
        return res.json(r);
      }
      case 'sair-numero':
        await whatsapp.sairDoNumero(empresa);
        return res.json({ ok: true });
      case 'devolver-ia': {
        // devolve para a IA todas as conversas pausadas (a IA volta a responder)
        let n = 0;
        for (const l of estado.conversas) {
          if (l.empresaId === empresa.id && l.iaPausada) {
            l.iaPausada = false;
            l.iaPausadaMotivo = '';
            l.precisaHumano = false;
            n++;
          }
        }
        salvar();
        return res.json({ ok: true, devolvidas: n });
      }
      case 'reativar-empresa': {
        // tira a pausa da empresa e responde quem ficou sem resposta por causa dela (últimas 24h)
        if (!ehAdmin(req)) return res.status(403).json({ erro: 'Só o administrador pode reativar a empresa.' });
        empresa.ativa = true;
        empresa.atualizadoEm = agora();
        const limite = Date.now() - 24 * 60 * 60 * 1000;
        let n = 0;
        for (const l of estado.conversas) {
          const st = l.iaStatus;
          const ultima = l.mensagens?.[l.mensagens.length - 1];
          if (l.empresaId === empresa.id && st?.motivo === whatsapp.MOTIVO_EMPRESA_PAUSADA && new Date(st.em).getTime() > limite && ultima?.papel === 'visitante') {
            whatsapp.agendarResposta(empresa, l);
            n++;
          }
        }
        salvar();
        return res.json({ ok: true, respondendo: n });
      }
      case 'diagnostico':
        return res.json(await whatsapp.diagnostico(empresa));
      case 'situacao':
        return res.json(await whatsapp.situacao(empresa));
      case 'qrcode':
        return res.json(await whatsapp.qrCode(empresa));
      case 'webhook':
        return res.json({ ok: true, webhook: await whatsapp.configurarWebhook(empresa, { forcar: b.forcar === true }) });
      case 'desconectar':
        await whatsapp.desconectar(empresa);
        return res.json(situacaoWhatsapp(empresa, req));
      default:
        return res.status(404).json({ erro: 'Ação desconhecida.' });
    }
  } catch (err) {
    erroWhatsapp(res, err);
  }
});

// Canais: IA do site e IA do WhatsApp, cada uma liga/desliga sozinha
router.put('/empresas/:id/canais', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  if (b.site !== undefined) {
    const principal = principalDa(empresa);
    if (principal) principal.ativo = b.site === true;
  }
  if (b.whatsapp !== undefined) {
    empresa.whatsappConfig = empresa.whatsappConfig || {};
    empresa.whatsappConfig.iaAtiva = b.whatsapp === true;
  }
  salvar();
  res.json(empresaComExtras(empresa, req));
});

// Etiquetas: só as do WhatsApp Business (criar, renomear e apagar é no celular)
router.put('/empresas/:id/etiquetas', (req, res) => {
  if (!acharEmpresa(req, res)) return;
  res.status(400).json({ erro: 'As etiquetas vêm do WhatsApp Business: crie, renomeie ou apague no celular que elas mudam aqui.' });
});

// ---------------------------------------------------------------- disparos em massa

function acharDisparo(req, res) {
  const d = estado.disparos.find((x) => x.id === req.params.disparoId && x.empresaId === req.params.id);
  if (!d || !podeVerEmpresa(req, d.empresaId)) {
    res.status(404).json({ erro: 'Disparo não encontrado.' });
    return null;
  }
  return d;
}

router.get('/empresas/:id/disparos', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(
    estado.disparos
      .filter((d) => d.empresaId === empresa.id)
      .sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))
      .map(disparos.resumo)
  );
});

// Prévia: quantos vão receber e como fica a mensagem para o primeiro
router.post('/empresas/:id/disparos/previa', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const r = disparos.destinatariosPara(empresa, req.body?.filtro);
  const primeiro = r.destinatarios[0] && estado.conversas.find((c) => c.id === r.destinatarios[0].leadId);
  res.json({
    total: r.destinatarios.length,
    semNumero: r.semNumero,
    sairam: r.sairam,
    nomes: r.destinatarios.slice(0, 8).map((x) => x.nome || `+${x.destino}`),
    exemplo: req.body?.mensagem
      ? disparos.montarMensagem(texto(req.body.mensagem, 3000), primeiro || { nome: 'Maria Silva' }, empresa) +
        (req.body?.rodapeSair !== false ? `\n\n${disparos.RODAPE_SAIR}` : '')
      : ''
  });
});

router.post('/empresas/:id/disparos', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.status(201).json(disparos.resumo(disparos.criar(empresa, req.body || {}, req.usuario)));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.get('/empresas/:id/disparos/:disparoId', (req, res) => {
  const d = acharDisparo(req, res);
  if (!d) return;
  res.json({ ...disparos.resumo(d), destinatarios: d.destinatarios.map(({ destino, ...x }) => ({ ...x, numero: /^\d+$/.test(destino) ? `+${destino}` : '' })) });
});

router.post('/empresas/:id/disparos/:disparoId/:acao', (req, res) => {
  const d = acharDisparo(req, res);
  if (!d) return;
  const acoes = { pausar: disparos.pausar, retomar: disparos.retomar, cancelar: disparos.cancelar };
  if (!acoes[req.params.acao]) return res.status(404).json({ erro: 'Ação desconhecida.' });
  try {
    acoes[req.params.acao](d);
    res.json(disparos.resumo(d));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.delete('/empresas/:id/disparos/:disparoId', (req, res) => {
  const d = acharDisparo(req, res);
  if (!d) return;
  try {
    disparos.apagar(d);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------- mídias da empresa

router.get('/empresas/:id/midias', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(midias.midiasDa(empresa).map((m) => ({ ...m, url: midias.urlPublica(m), codigoVisivel: midias.codigoVisivel(m.codigo) })));
});

// Mídia pelo link de um arquivo do Google Drive (vira link direto, o CRM baixa e guarda)
router.post('/empresas/:id/midias/link', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  try {
    const extra = { pronta: b.ativa !== false && Boolean(texto(b.descricao, 300)), legenda: texto(b.legenda, 1000), umaVezPorConversa: b.umaVezPorConversa !== false };
    if (b.codigo) extra.codigo = b.codigo;
    const midia = await midias.salvarMidiaDoLink(empresa, { link: texto(b.link, 1000), nome: texto(b.nome, 80), descricao: texto(b.descricao, 300), extra });
    res.status(201).json({ ...midia, url: midias.urlPublica(midia), codigoVisivel: midias.codigoVisivel(midia.codigo) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/empresas/:id/midias', express.raw({ type: 'application/octet-stream', limit: midias.TAMANHO_MAXIMO + 1024 }), (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const descricao = texto(req.query.descricao, 300);
    const midia = midias.salvarMidia(empresa, {
      buffer: req.body,
      nomeArquivo: texto(req.query.arquivo, 200),
      nome: texto(req.query.nome, 80),
      descricao,
      mimetypeInformado: texto(req.query.tipo, 100),
      // código escolhido (ex.: o que o prompt cita) — já entra ativa se tiver "quando enviar"
      extra: req.query.codigo ? { codigo: texto(req.query.codigo, 60), pronta: Boolean(descricao) } : {}
    });
    if (midias.midiasDa(empresa).filter((m) => m.nome.toLowerCase() === midia.nome.toLowerCase()).length > 1) {
      midias.apagarMidia(empresa, midia.id);
      return res.status(400).json({ erro: `Já existe uma mídia chamada "${midia.nome}". Use outro nome.` });
    }
    res.status(201).json({ ...midia, url: midias.urlPublica(midia), codigoVisivel: midias.codigoVisivel(midia.codigo) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.put('/empresas/:id/midias/:midiaId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const midia = midias.midiasDa(empresa).find((m) => m.id === req.params.midiaId);
  if (!midia) return res.status(404).json({ erro: 'Mídia não encontrada.' });
  const b = req.body || {};
  try {
    if (b.nome !== undefined) {
      const nome = texto(b.nome, 80);
      if (!nome) return res.status(400).json({ erro: 'Dê um nome para a mídia.' });
      midia.nome = nome;
    }
    if (b.codigo !== undefined && midias.codigoDaEntrada(b.codigo) !== midia.codigo) midia.codigo = midias.validarCodigo(empresa, b.codigo, midia.id);
    if (b.descricao !== undefined) midia.descricao = texto(b.descricao, 300);
    if (b.legenda !== undefined) midia.legenda = texto(b.legenda, 1000);
    if (b.umaVezPorConversa !== undefined) midia.umaVezPorConversa = b.umaVezPorConversa !== false;
    if (b.etapas !== undefined) midia.etapas = midias.listaEtapas(b.etapas);
    if (b.albumId !== undefined) midia.albumId = midias.albunsDa(empresa).some((a) => a.id === b.albumId) ? b.albumId : null;
    if (b.pronta !== undefined) midia.pronta = b.pronta === true;
    if (b.assuntos !== undefined) midia.assuntos = midias.listaAssuntos(empresa, b.assuntos);
    if (b.soFollowup !== undefined) midia.soFollowup = b.soFollowup === true;
  } catch (err) {
    return res.status(err.status || 400).json({ erro: err.message });
  }
  salvar();
  res.json({ ...midia, url: midias.urlPublica(midia), codigoVisivel: midias.codigoVisivel(midia.codigo) });
});

// Várias de uma vez: marcar prontas / a configurar, pôr num álbum, apagar
router.post('/empresas/:id/midias/lote', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String));
  const alvo = midias.midiasDa(empresa).filter((m) => ids.has(m.id));
  if (!alvo.length) return res.status(400).json({ erro: 'Selecione pelo menos uma mídia.' });
  const acao = String(req.body?.acao || '');
  if (acao === 'apagar') for (const m of alvo) midias.apagarMidia(empresa, m.id);
  else if (acao === 'pronta' || acao === 'aConfigurar') for (const m of alvo) m.pronta = acao === 'pronta';
  else if (acao === 'album') {
    const albumId = midias.albunsDa(empresa).some((a) => a.id === req.body?.albumId) ? req.body.albumId : null;
    for (const m of alvo) m.albumId = albumId;
  } else if (acao === 'etapas') for (const m of alvo) m.etapas = midias.listaEtapas(req.body?.etapas);
  else if (acao === 'assuntos') for (const m of alvo) m.assuntos = midias.listaAssuntos(empresa, req.body?.assuntos);
  else if (acao === 'soFollowup' || acao === 'naConversa') for (const m of alvo) m.soFollowup = acao === 'soFollowup';
  else return res.status(400).json({ erro: 'Ação inválida.' });
  salvar();
  res.json({ ok: true, alteradas: alvo.length });
});

// Envio em pedaços (arquivos grandes, vários de uma vez)
router.post('/empresas/:id/midias/envio', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json(midias.iniciarEnvio(empresa, { arquivo: texto(req.body?.arquivo, 200), tamanho: req.body?.tamanho, tipo: texto(req.body?.tipo, 100) }));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/empresas/:id/midias/envio/:envioId/parte', express.raw({ type: 'application/octet-stream', limit: 1024 * 1024 }), (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json(midias.receberPedaco(empresa, req.params.envioId, req.query.pos, req.body || Buffer.alloc(0)));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/empresas/:id/midias/envio/:envioId/concluir', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const b = req.body || {};
    const m = midias.concluirEnvio(empresa, req.params.envioId, { nome: texto(b.nome, 80), descricao: texto(b.descricao, 300), codigo: b.codigo ? texto(b.codigo, 40) : '', pronta: b.pronta === true, etapas: b.etapas });
    res.status(201).json({ ...m, url: midias.urlPublica(m), codigoVisivel: midias.codigoVisivel(m.codigo) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// Assuntos das mídias (cada empresa cria os seus: "Completo", "Arco", "Corte", "Coloração"...)
router.get('/empresas/:id/assuntos-midia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ assuntos: midias.assuntosDa(empresa) });
});

router.put('/empresas/:id/assuntos-midia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ assuntos: midias.salvarAssuntos(empresa, req.body?.assuntos) });
});

// ---------------------------------------------------------------- álbuns (mídias enviadas juntas)

router.get('/empresas/:id/albuns', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const todas = midias.midiasDa(empresa);
  res.json(midias.albunsDa(empresa).map((a) => ({ ...a, quantidade: todas.filter((m) => m.albumId === a.id).length })));
});

function dadosAlbum(empresa, b, atual = null) {
  const nome = texto(b.nome, 80);
  if (!nome) throw Object.assign(new Error('Dê um nome para o álbum.'), { status: 400 });
  const codigo = b.codigo ? (atual && midias.codigoDaEntrada(b.codigo) === atual.codigo ? atual.codigo : midias.validarCodigo(empresa, b.codigo, atual?.id)) : atual?.codigo || midias.novoCodigo(empresa, nome);
  return {
    nome,
    codigo,
    descricao: texto(b.descricao, 300),
    etapas: midias.listaEtapas(b.etapas),
    assuntos: b.assuntos !== undefined ? midias.listaAssuntos(empresa, b.assuntos) : atual?.assuntos || [],
    soFollowup: b.soFollowup !== undefined ? b.soFollowup === true : atual?.soFollowup === true
  };
}

router.post('/empresas/:id/albuns', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const album = { id: novoId('alb'), ...dadosAlbum(empresa, req.body || {}), criadoEm: agora() };
    empresa.albuns = [...midias.albunsDa(empresa), album];
    for (const id of Array.isArray(req.body?.midias) ? req.body.midias : []) {
      const m = midias.midiasDa(empresa).find((x) => x.id === id);
      if (m) m.albumId = album.id;
    }
    salvar();
    res.status(201).json(album);
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.put('/empresas/:id/albuns/:albumId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const album = midias.albunsDa(empresa).find((a) => a.id === req.params.albumId);
  if (!album) return res.status(404).json({ erro: 'Álbum não encontrado.' });
  try {
    Object.assign(album, dadosAlbum(empresa, req.body || {}, album));
    salvar();
    res.json(album);
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.delete('/empresas/:id/albuns/:albumId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  empresa.albuns = midias.albunsDa(empresa).filter((a) => a.id !== req.params.albumId);
  for (const m of midias.midiasDa(empresa)) if (m.albumId === req.params.albumId) m.albumId = null; // as mídias continuam
  salvar();
  res.json({ ok: true });
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
  // empresa nova: usa só as próprias chaves de IA (o admin pode liberar a padrão)
  const empresa = { id: novoId('emp'), usarChavePadrao: false, etapas: leads.ETAPAS_PADRAO.slice(), ...dados, funilV2: true, chavesIa: {}, criadoEm: agora() };
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
    boasVindas: `Olá! 👋 Seja bem-vindo(a) à ${empresa.nome}. Como posso te ajudar?`,
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
  res.status(201).json(empresaComExtras(empresa, req));
});

router.put('/empresas/:id', auth.exigirAdmin, (req, res) => {
  const empresa = estado.empresas.find((e) => e.id === req.params.id);
  if (!empresa) return res.status(404).json({ erro: 'Empresa não encontrada.' });
  const dados = dadosEmpresa(req.body || {});
  if (!dados.nome) return res.status(400).json({ erro: 'Informe o nome da empresa.' });
  Object.assign(empresa, dados, { atualizadoEm: agora() });
  salvar();
  res.json(empresaComExtras(empresa, req));
});

router.delete('/empresas/:id', auth.exigirAdmin, (req, res) => {
  const i = estado.empresas.findIndex((e) => e.id === req.params.id);
  if (i < 0) return res.status(404).json({ erro: 'Empresa não encontrada.' });
  const id = estado.empresas[i].id;
  midias.apagarTodasDa(estado.empresas[i]);
  disparos.apagarTodosDa(id);
  apagarLogo(estado.empresas[i]);
  estado.vendas = (estado.vendas || []).filter((v) => v.empresaId !== id);
  estado.gastos = (estado.gastos || []).filter((g) => g.empresaId !== id);
  require('./log-respostas').apagarDaEmpresa(id);
  estado.empresas.splice(i, 1);
  const botsRemovidos = new Set(estado.bots.filter((b) => b.empresaId === id).map((b) => b.id));
  estado.bots = estado.bots.filter((b) => b.empresaId !== id);
  estado.conversas = estado.conversas.filter((c) => c.empresaId !== id);
  lixeira.esvaziar(id);
  for (const botId of botsRemovidos) delete estado.uso[botId];
  const usuariosRemovidos = new Set(estado.usuarios.filter((u) => u.empresaId === id).map((u) => u.id));
  estado.usuarios = estado.usuarios.filter((u) => u.empresaId !== id);
  estado.sessoes = estado.sessoes.filter((s) => !usuariosRemovidos.has(s.usuarioId));
  salvar();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- assistentes

const CAMPOS_SO_ADMIN = ['limiteDiario', 'limiteConversa', 'empresaId'];

// `base` = assistente atual: campos que não vieram no formulário ficam como estão
// (cada tela do painel manda só os campos dela)
function dadosBot(body, req, base = null) {
  const provedor = ia.normalizarProvedor(body.provedor ?? base?.provedor);
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
    objetivo: texto(body.objetivo, 300),
    oferta: texto(body.oferta, 1000),
    linkAvaliacao: /^https?:\/\//i.test(String(body.linkAvaliacao || '').trim()) ? texto(body.linkAvaliacao, 500) : '',
    linkAnuncio: /^https?:\/\//i.test(String(body.linkAnuncio || '').trim()) ? texto(body.linkAnuncio, 500) : '',
    whatsapp: numeroWhatsapp(body.whatsapp),
    mensagemWhatsappPadrao: texto(body.mensagemWhatsappPadrao, 300),
    dominios: listaDominios(body.dominios),
    lerPaginaDoSite: body.lerPaginaDoSite !== false,
    ativo: body.ativo !== false,
    principal: body.principal === true,
    // cada empresa paga a própria IA, então ela mesma escolhe provedor e modelo
    provedor,
    modelo: ia.normalizarModelo(provedor, body.modelo ?? base?.modelo)
  };
  if (ehAdmin(req)) {
    dados.empresaId = String(body.empresaId || base?.empresaId || '');
    dados.limiteDiario = inteiro(body.limiteDiario, base?.limiteDiario || 500, 1, 100000);
    dados.limiteConversa = inteiro(body.limiteConversa, base?.limiteConversa || 40, 1, 500);
  }
  if (base) {
    for (const k of Object.keys(dados)) {
      if (!(k in body) && !(k === 'modelo' && 'provedor' in body)) delete dados[k];
    }
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
  const obediencia = require('./obediencia');
  // regras que o CRM confere sozinho antes de mandar (o painel mostra ao lado das instruções)
  const conferidas = (t) => obediencia.regrasDe(t || '').map((r) => (r.tipo === 'identidade' ? 'Não se apresentar como assistente virtual, IA ou robô' : `Não usar "${r.termo}"`));
  return { ...bot, empresaNome: empresa?.nome || '—', mensagensHoje: uso, regrasConferidas: { site: conferidas(bot.regras), whatsapp: conferidas(bot.promptWhatsapp) } };
}

// Guarda cada versão das instruções (site e WhatsApp): quando mudou, quem mudou e o texto
function registrarMudancaInstrucoes(bot, dados, req) {
  const quem = req.usuario?.nome || req.usuario?.email || '';
  for (const [campo, canal] of [['regras', 'site'], ['promptWhatsapp', 'whatsapp']]) {
    if (!(campo in dados) || String(dados[campo] || '') === String(bot[campo] || '')) continue;
    bot.instrucoesEditadas = bot.instrucoesEditadas || {};
    bot.instrucoesEditadas[canal] = { em: agora(), por: quem, caracteres: String(dados[campo] || '').length };
    const hist = (bot.historicoInstrucoes = bot.historicoInstrucoes || []);
    if (bot[campo]) hist.unshift({ canal, texto: String(bot[campo]).slice(0, 20000), ate: agora(), por: quem }); // a versão que saiu
    const doCanal = hist.filter((h) => h.canal === canal);
    if (doCanal.length > 10) bot.historicoInstrucoes = hist.filter((h) => h.canal !== canal || doCanal.indexOf(h) < 10);
    // conferência antiga não vale para o texto novo
    if (bot.ultimaConferencia?.[canal]) bot.ultimaConferencia[canal].antiga = true;
  }
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
  const dados = dadosBot(req.body || {}, req, bot);
  if ('nome' in dados && !dados.nome) return res.status(400).json({ erro: 'Dê um nome para o assistente.' });
  if (!ehAdmin(req)) for (const c of CAMPOS_SO_ADMIN) delete dados[c];
  else if (dados.empresaId && !estado.empresas.some((e) => e.id === dados.empresaId)) return res.status(400).json({ erro: 'Escolha a empresa.' });
  const empresaAntes = bot.empresaId;
  registrarMudancaInstrucoes(bot, dados, req);
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

// O que o envio faria com cada código (modo teste: nada sai pelo WhatsApp)
function planejarMidias(empresa, nomes, enviadas = new Set()) {
  const lista = [];
  for (const nome of nomes || []) {
    const pedido = midias.resolverPedido(empresa, nome);
    if (!pedido.alvo) {
      lista.push({ codigo: String(nome).startsWith('#') ? String(nome) : `#MIDIA_${String(nome).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, status: 'nao-existe', motivo: 'não existe no cadastro desta empresa' });
      continue;
    }
    const prontas = pedido.itens.filter((m) => midias.prontaParaIa(m));
    if (!prontas.length) {
      lista.push({ codigo: midias.codigoVisivel(pedido.alvo.codigo), nome: pedido.alvo.nome, status: 'inativa', motivo: 'mídia desativada' });
      continue;
    }
    if (pedido.alvo.soFollowup) {
      lista.push({ codigo: midias.codigoVisivel(pedido.alvo.codigo), nome: pedido.alvo.nome, status: 'pulada', motivo: 'é só do follow-up' });
      continue;
    }
    for (const m of prontas) {
      const ja = m.umaVezPorConversa !== false && enviadas.has(m.codigo);
      lista.push({
        codigo: midias.codigoVisivel(m.codigo),
        nome: m.nome,
        tipo: m.tipo,
        url: midias.urlPublica(m),
        legenda: m.tipo === 'audio' ? '' : m.legenda || '',
        endpoint: m.tipo === 'audio' ? 'sendWhatsAppAudio' : `sendMedia (${m.tipo})`,
        status: ja ? 'ja-enviada' : 'enviaria',
        motivo: ja ? 'já enviada nesta conversa (uma vez por conversa)' : pedido.etapas?.length ? `só sai se o lead estiver na etapa ${pedido.etapas.join('/')}` : ''
      });
    }
  }
  return lista;
}

// Códigos de mídia citados no prompt da empresa (e os que não existem no cadastro)
router.get('/empresas/:id/midias/prompt', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ ...midias.avisosDoPrompt(empresa), pendencias: midias.pendenciasDoPrompt(empresa) });
});

// Conectar a mídia citada no prompt: coloca o código certo no texto do prompt
// (ou ativa a mídia, se ela existe mas estava desativada)
router.post('/empresas/:id/midias/prompt/conectar', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const pend = midias.pendenciasDoPrompt(empresa).find((x) => x.id === String(req.body?.id || ''));
  if (!pend) return res.status(404).json({ erro: 'Este aviso já foi resolvido (ou o prompt mudou). Recarregue a página.' });
  try {
    if (pend.tipo === 'desativada') {
      const alvo = midias.resolverPedido(empresa, pend.codigo);
      for (const m of alvo.itens) m.pronta = true;
      salvar();
      return res.json({ ok: true, ativou: pend.codigo });
    }
    const escolhida = midias.resolverPedido(empresa, String(req.body?.codigo || '')).alvo;
    if (!escolhida?.codigo) return res.status(400).json({ erro: 'Escolha uma mídia da lista.' });
    const r = midias.conectarNoPrompt(empresa, pend, escolhida.codigo);
    registrarMudancaInstrucoes(r.bot, { [r.campo]: r.textoNovo }, req);
    r.bot[r.campo] = r.textoNovo;
    // a mídia estava desativada: conectar no prompt já ativa (com o trecho como "quando enviar", se faltar)
    for (const m of midias.resolverPedido(empresa, escolhida.codigo).itens) {
      if (!m.descricao && !m.albumId && !m.pastaId) m.descricao = pend.trecho.slice(0, 300);
      if (m.pronta === false && (m.descricao || m.albumId || m.pastaId)) m.pronta = true;
    }
    salvar();
    res.json({ ok: true, trecho: r.novoTrecho, codigo: midias.codigoVisivel(escolhida.codigo) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// "Não é mídia": some o aviso deste trecho
router.post('/empresas/:id/midias/prompt/ignorar', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const id = String(req.body?.id || '').slice(0, 20);
  if (!id) return res.status(400).json({ erro: 'Aviso inválido.' });
  empresa.mencoesIgnoradas = [...new Set([...(empresa.mencoesIgnoradas || []), id])].slice(-300);
  salvar();
  res.json({ ok: true });
});

// Log das respostas da IA (texto bruto, códigos, mídias, Evolution, erros)
router.get('/empresas/:id/logs-ia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(require('./log-respostas').listar(empresa, { soErros: req.query.soErros === '1', leadId: texto(req.query.leadId, 60), limite: Number(req.query.limite) || 50 }));
});

// Eventos internos para a IA ([SEM_RESPOSTA], [CHECAR_VIDEO]…): tempos por empresa
router.get('/empresas/:id/eventos-ia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(require('./eventos-ia').configDa(empresa));
});
router.put('/empresas/:id/eventos-ia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json(require('./eventos-ia').salvarConfig(empresa, req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// Conversa de teste no painel: usa a configuração que está no formulário (mesmo
// sem salvar) e não grava nada.
router.post('/bots/:id/testar', async (req, res) => {
  const salvo = acharBot(req, res);
  if (!salvo) return;
  // usarSalvo: modo teste aberto fora da tela das instruções (ex.: Mídias) — usa o que está salvo
  const rascunho = req.body?.usarSalvo ? { ...salvo } : { ...salvo, ...dadosBot(req.body?.bot || {}, req, salvo) };
  if (!ehAdmin(req)) for (const c of CAMPOS_SO_ADMIN) rascunho[c] = salvo[c];
  const empresa = estado.empresas.find((e) => e.id === rascunho.empresaId) || estado.empresas.find((e) => e.id === salvo.empresaId);
  const historico = (Array.isArray(req.body?.mensagens) ? req.body.mensagens : [])
    .slice(-30)
    .map((m) => ({ papel: m.papel === 'visitante' ? 'visitante' : 'assistente', texto: texto(m.texto, 2000) }))
    .filter((m) => m.texto);
  const canal = req.body?.canal === 'whatsapp' ? 'whatsapp' : 'site';
  try {
    // modo teste: mídias já "enviadas" nesta conversa de teste e um evento interno opcional
    const enviadasNoTeste = (Array.isArray(req.body?.midiasEnviadas) ? req.body.midiasEnviadas : []).map((c) => midias.codigoDaEntrada(c)).filter(Boolean);
    const evento = canal === 'whatsapp' && /^[A-Z][A-Z0-9_]{2,30}$/.test(String(req.body?.evento || '')) ? req.body.evento : '';
    const hist = canal === 'whatsapp' ? require('./eventos-ia').historicoParaIa(empresa, historico, evento) : historico;
    const r = await ia.responder(rascunho, empresa, hist, {
      canal,
      etapas: leads.etapasDa(empresa),
      midias: midias.paraIa(empresa),
      midiasEnviadas: enviadasNoTeste,
      links: midias.linksDa(empresa),
      etiquetas: leads.etiquetasDa(empresa)
    });
    res.json({
      resposta: r.texto,
      whatsappUrl: r.mensagemWhatsapp ? linkWhatsapp(numeroDoAtendimento(rascunho, empresa), r.mensagemWhatsapp) : null,
      midias: r.midias,
      etapa: r.etapa,
      etiquetas: r.etiquetas,
      humano: r.humano,
      // detalhes do modo teste: o que a IA escreveu de verdade e o que o sistema faria
      bruto: r.bruto || '',
      codigos: r.codigos || [],
      midiasPlanejadas: planejarMidias(empresa, r.midias, new Set(enviadasNoTeste)),
      avisos: require('./log-respostas').prometeuMidiaSemCodigo(r.texto, r.midias) ? ['A IA disse que ia mandar foto/vídeo/áudio, mas não escreveu nenhum código de mídia.'] : [],
      nada: Boolean(r.nada)
    });
  } catch (err) {
    res.status(err.status === 503 ? 503 : 502).json({ erro: ia.descreverErroIa(err) });
  }
});

// ---------------------------------------------------------------- serviços e preços (catálogo)
const catalogo = require('./catalogo');
router.get('/empresas/:id/catalogo', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ itens: catalogo.itensDa(empresa), ...catalogo.resumo(empresa) });
});
router.post('/empresas/:id/catalogo', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try { res.json(catalogo.criar(empresa, req.body || {})); } catch (err) { res.status(err.status || 500).json({ erro: err.message }); }
});
router.put('/empresas/:id/catalogo/:item', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try { res.json(catalogo.atualizar(empresa, req.params.item, req.body || {})); } catch (err) { res.status(err.status || 500).json({ erro: err.message }); }
});
router.delete('/empresas/:id/catalogo/:item', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (!catalogo.apagar(empresa, req.params.item)) return res.status(404).json({ erro: 'Item não encontrado.' });
  res.json({ ok: true });
});
// lê "Sobre a empresa" e sugere itens (a equipe confere e escolhe antes de salvar)
router.post('/empresas/:id/catalogo/sugerir', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json({ itens: await catalogo.sugerirDoTexto(empresa, whatsapp.botDoWhatsapp(empresa)) });
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.status ? err.message : `Não deu para ler agora: ${ia.descreverErroIa(err)}` });
  }
});

// Botão "Atualizar e conferir": testa se a IA lê e obedece as instruções salvas
router.post('/bots/:id/conferir', async (req, res) => {
  const bot = acharBot(req, res);
  if (!bot) return;
  const empresa = estado.empresas.find((e) => e.id === bot.empresaId);
  if (!empresa) return res.status(400).json({ erro: 'Este assistente não tem empresa.' });
  try {
    const canal = req.body?.canal === 'site' ? 'site' : 'whatsapp';
    const r = await require('./conferir-prompt').conferir(bot, empresa, canal);
    bot.ultimaConferencia = { ...(bot.ultimaConferencia || {}), [canal]: { em: agora(), placar: r.placar, nota: r.nota, lendo: r.lendo } };
    salvar();
    res.json(r);
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.status ? err.message : `Não deu para testar agora: ${ia.descreverErroIa ? ia.descreverErroIa(err) : err.message}` });
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
    fotoUrl: fotosClientes.urlDaFoto(c),
    local: localizacao.paraPainel(c),
    origem: c.origem || 'site',
    canais,
    noWhatsapp: Boolean(c.whatsappJid),
    podeReceber: Boolean(whatsapp.destinoDoLead(c)),
    etiquetas: c.etiquetas || [],
    naoDisparar: Boolean(c.naoDisparar),
    listaNegra: leads.naListaNegra(null, c),
    iaStatus: c.iaStatus || null,
    arquivado: Boolean(c.arquivado),
    arquivadoPor: c.arquivadoPor || '',
    fonte: c.origemSite?.classificacao?.fonte || '',
    destaque: tickets.destaqueDoLead(c),
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
    .filter((c) => !req.query.etiqueta || (c.etiquetas || []).includes(req.query.etiqueta))
    .filter((c) => !req.query.origem || (c.origem || 'site') === req.query.origem)
    .filter((c) => !busca || [c.nome, c.telefone, c.codigo, ...c.mensagens.map((m) => m.texto)].join(' ').toLowerCase().includes(busca))
    .sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1))
    .slice(0, 1000)
    .map(resumoLead);
  res.json(lista);
});

// Lead cadastrado à mão ou importado (lista "Nome, telefone" — um por linha)
router.post('/empresas/:id/leads', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  const etapa = leads.acharEtapa(empresa, b.etapa) || leads.etapasDa(empresa)[0];
  const validas = new Set(leads.etiquetasDa(empresa).map((t) => t.id));
  const etiquetas = (Array.isArray(b.etiquetas) ? b.etiquetas : []).map(String).filter((id) => validas.has(id));
  const linhas = Array.isArray(b.contatos) ? b.contatos : [{ nome: b.nome, telefone: b.telefone }];
  const existentes = new Set(
    estado.conversas.filter((c) => c.empresaId === empresa.id).map((c) => (c.whatsappJid ? c.whatsappJid.split('@')[0] : c.telefone)).filter(Boolean)
  );
  let criados = 0;
  let repetidos = 0;
  let invalidos = 0;
  for (const l of linhas.slice(0, 5000)) {
    const telefone = numeroWhatsapp(l?.telefone);
    if (telefone.length < 10) {
      invalidos++;
      continue;
    }
    if (existentes.has(telefone)) {
      repetidos++;
      continue;
    }
    existentes.add(telefone);
    const lead = leads.criarLead({ empresa, bot: principalDa(empresa), canal: 'manual', nome: texto(l?.nome, 120), telefone });
    lead.etapa = etapa;
    lead.etiquetas = etiquetas.slice();
    criados++;
  }
  salvar();
  if (!criados && linhas.length === 1) {
    return res.status(400).json({ erro: repetidos ? 'Já existe um lead com esse telefone.' : 'Telefone inválido. Use DDD + número.' });
  }
  res.status(201).json({ criados, repetidos, invalidos });
});

// Ações em vários leads de uma vez (mover etapa, etiquetar, apagar)
router.post('/empresas/:id/leads/lote', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
  const alvo = estado.conversas.filter((c) => c.empresaId === empresa.id && ids.has(c.id));
  if (!alvo.length) return res.status(400).json({ erro: 'Selecione pelo menos um lead.' });
  const validas = new Set(leads.etiquetasDa(empresa).map((t) => t.id));
  if (b.apagar === true) {
    for (const c of alvo) lixeira.moverParaLixeira(c, req.usuario?.email || ''); // restaurável por 30 dias
  } else {
    for (const c of alvo) {
      if (b.etapa) leads.moverEtapa(c, empresa, b.etapa, 'equipe');
      const antes = c.etiquetas || [];
      if (b.adicionarEtiqueta && validas.has(b.adicionarEtiqueta)) c.etiquetas = [...new Set([...(c.etiquetas || []), b.adicionarEtiqueta])];
      if (b.removerEtiqueta) c.etiquetas = (c.etiquetas || []).filter((t) => t !== b.removerEtiqueta);
      etiquetaAgendadoMudou(empresa, c, antes);
      c.atualizadoEm = agora();
    }
  }
  salvar();
  res.json({ ok: true, alterados: alvo.length });
});

router.get('/leads/:id', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const bot = estado.bots.find((b) => b.id === c.botId);
  leads.garantirIdsDasMensagens(c);
  const { whatsappJid, origemSite, ...resto } = c;
  res.json({
    ...resto,
    mensagens: c.mensagens.map((m) => (whatsapp.podeApagarParaTodos(m) ? { ...m, apagaParaTodos: true } : m)),
    fotoUrl: fotosClientes.urlDaFoto(c),
    local: localizacao.paraPainel(c),
    origemSite: origem.resumoOrigem(c, empresa),
    pedidos: automacoes.pedidosFeitos(c, empresa),
    temLinkAvaliacao: Boolean(whatsapp.botDoWhatsapp(empresa)?.linkAvaliacao),
    temLinkAnuncio: Boolean(whatsapp.botDoWhatsapp(empresa)?.linkAnuncio),
    posVenda: automacoes.posVenda(empresa, c),
    ultimaVenda: (() => { const v = (estado.vendas || []).filter((x) => x.leadId === c.id && x.status !== 'cancelada').pop(); return v ? { id: v.id, valor: v.valor, status: v.status, data: v.data, descricao: v.descricao || '' } : null; })(),
    tickets: tickets.ticketsDoLead(c),
    proximosEnvios: automacoes.proximosEnvios(c, empresa),
    anunciosEmpresa: origem.anunciosDa(empresa).map((a) => ({ id: a.id, nome: a.nome })),
    etiquetas: c.etiquetas || [],
    listaNegra: leads.naListaNegra(empresa, c),
    vendaConcluida: c.vendaConcluidaManual === true || /fechad|ganh|vendi/i.test(c.etapa || '') || (estado.vendas || []).some((v) => v.leadId === c.id && v.status !== 'cancelada'),
    temVendaRegistrada: (estado.vendas || []).some((v) => v.leadId === c.id && v.status !== 'cancelada'),
    erroEtiquetaZap: c.erroEtiquetaZap || null,
    sugestaoMidia: require('./sugestao-midia').paraPainel(empresa, c),
    noWhatsapp: Boolean(whatsappJid),
    podeReceber: Boolean(whatsapp.destinoDoLead(c)),
    botNome: bot?.nome || '—',
    etapas: leads.etapasDa(empresa),
    etiquetasEmpresa: leads.etiquetasDa(empresa)
  });
});

// Etiqueta "Agendado" colocada/tirada pelo CRM: entra/sai de Agendamentos (igual ao celular)
function etiquetaAgendadoMudou(empresa, c, antes) {
  const agenda = require('./detector-agenda');
  const ids = new Set(leads.etiquetasDa(empresa).filter((t) => agenda.ehEtiquetaAgendado(t.nome)).map((t) => t.id));
  if (!ids.size) return;
  const tinha = antes.some((id) => ids.has(id));
  const tem = (c.etiquetas || []).some((id) => ids.has(id));
  if (tem && !tinha) agenda.pelaEtiqueta(empresa, c).catch((err) => console.error('[agenda] etiqueta:', err.message));
  if (tinha && !tem) agenda.etiquetaTirada(empresa, c);
}

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
  if (b.localizacao !== undefined) {
    // vazio = volta a usar o DDD do telefone
    if (texto(b.localizacao, 60)) localizacao.definir(c, b.localizacao, 'equipe');
    else {
      // vazio = volta a ler da conversa
      delete c.localizacao;
      localizacao.lerConversa(c);
    }
  }
  if (b.telefone !== undefined && !c.whatsappJid) c.telefone = numeroWhatsapp(b.telefone);
  if (Array.isArray(b.etiquetas)) {
    const validas = new Set(leads.etiquetasDa(empresa).map((t) => t.id));
    const antes = c.etiquetas || [];
    c.etiquetas = [...new Set(b.etiquetas.map(String))].filter((id) => validas.has(id));
    etiquetaAgendadoMudou(empresa, c, antes);
  }
  if (b.naoDisparar !== undefined) c.naoDisparar = b.naoDisparar === true;
  if (b.origemManual !== undefined) c.origemManual = texto(b.origemManual, 300);
  if (b.anuncioId !== undefined) {
    const a = origem.anunciosDa(empresa).find((x) => x.id === b.anuncioId);
    c.anuncioId = a ? a.id : null;
    c.anuncioPor = 'equipe'; // escolhido à mão: o CRM não troca mais sozinho
  }
  // follow-up automático deste cliente: liga/desliga (vale até ligar de novo)
  if (b.followupLigado !== undefined) require('./followup').ligarParaLead(c, b.followupLigado === true);
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

// Arquivar a conversa (no CRM e no WhatsApp do celular)
router.post('/leads/:id/arquivar', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const arquivar = req.body?.arquivar !== false;
  c.arquivado = arquivar;
  c.arquivadoPor = arquivar ? `arquivada no CRM (${req.usuario.email})` : '';
  c.arquivadoEm = arquivar ? agora() : null;
  salvar();
  let noCelular = false;
  try {
    noCelular = await whatsapp.arquivarNoWhatsapp(empresa, c, arquivar);
  } catch (err) {
    console.error(`[arquivar ${c.id}]`, err.message);
  }
  res.json({ ok: true, arquivado: arquivar, noCelular });
});

// Não mandar esta automação para este cliente (botão no cronômetro)
router.post('/leads/:id/pular-automacao', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  // passo do follow-up: para a sequência deste cliente (recomeça se ele responder)
  if (String(req.body?.regraId || '').startsWith('fup')) {
    if (!require('./followup').pular(empresa, c, req.usuario.email)) return res.status(404).json({ erro: 'Nenhum follow-up na fila para este cliente.' });
    return res.json({ ok: true });
  }
  const regra = automacoes.automacoesDa(empresa).find((r) => r.id === req.body?.regraId);
  if (!regra) return res.status(404).json({ erro: 'Automação não encontrada.' });
  const h = c.automacoes?.[regra.id] || { enviados: 0 };
  c.automacoes = { ...(c.automacoes || {}), [regra.id]: { ...h, enviados: regra.maxPorLead, puladoEm: agora(), puladoPor: req.usuario.email } };
  salvar();
  res.json({ ok: true });
});

// Pedir avaliação do Google / comentário no anúncio à mão (botão na conversa)
router.post('/leads/:id/pedido', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  try {
    const r = await automacoes.enviarPedidoManual(empresa, c, String(req.body?.tipo || ''), { forcar: req.body?.forcar === true, usuario: req.usuario.email });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.message, jaEnviadoEm: err.jaEnviadoEm });
  }
});

// Agenda da empresa: todos os agendamentos (próximos, passados e cancelados) de forma simples
router.get('/empresas/:id/agendamentos', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  comprovantes.concluirVendidos(empresa); // teve venda → sai de "Próximos" (todas as conversas do cliente)
  const agora_ = Date.now();
  const lista = [];
  for (const c of estado.conversas) {
    if (c.empresaId !== empresa.id) continue;
    for (const a of c.agendamentos || []) {
      const t = a.quando ? new Date(a.quando).getTime() : null;
      const grupo = a.status === 'concluido' ? 'passados' : a.status !== 'agendado' ? 'cancelados' : t !== null && t < agora_ - 2 * 3600 * 1000 ? 'passados' : 'proximos';
      lista.push({
        id: a.id, leadId: c.id, nome: c.nome || '', telefone: c.telefone || '', etapa: c.etapa, foto: fotosClientes.urlDaFoto(c) || '',
        quando: a.quando, quandoTexto: a.quandoTexto || '', descricao: a.descricao || '', status: a.status, por: a.por, detectadoPor: a.detectadoPor || '',
        avisoStatus: a.avisoStatus || (a.avisoEm ? 'fila' : ''), avisoErro: a.avisoErro || '', motivoCancelamento: a.motivoCancelamento || '', grupo, criadoEm: a.criadoEm
      });
    }
  }
  const ord = (x) => x.quando || x.criadoEm || '';
  const resumo = {
    hoje: lista.filter((x) => x.grupo === 'proximos' && x.quando && new Date(x.quando).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) === new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })).length,
    semana: lista.filter((x) => x.grupo === 'proximos' && x.quando && new Date(x.quando).getTime() < agora_ + 7 * 86400000).length,
    proximos: lista.filter((x) => x.grupo === 'proximos').length
  };
  res.json({
    resumo,
    proximos: lista.filter((x) => x.grupo === 'proximos').sort((a, b) => ord(a).localeCompare(ord(b))),
    passados: lista.filter((x) => x.grupo === 'passados').sort((a, b) => ord(b).localeCompare(ord(a))).slice(0, 200),
    cancelados: lista.filter((x) => x.grupo === 'cancelados').sort((a, b) => ord(b).localeCompare(ord(a))).slice(0, 200)
  });
});

// Agendamento marcado pela equipe (aparece como aviso na conversa)
router.post('/leads/:id/agendamentos', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  if (!tickets.quandoDe(req.body?.quando)) return res.status(400).json({ erro: 'Escolha o dia e o horário.' });
  const r = tickets.registrarAgendamento(empresa, c, { quando: req.body.quando, descricao: texto(req.body?.descricao, 200), por: 'equipe' });
  res.status(201).json(r.agendamento);
});

router.delete('/leads/:id/agendamentos/:agId', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  if (!tickets.cancelarAgendamento(c, req.params.agId, { por: 'equipe', motivo: texto(req.body?.motivo, 200) || 'cancelado pela equipe' })) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  res.json({ ok: true });
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
    manterIa(c, caixinha(req.body?.manterIa));
    res.json(resumoLead(c));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ erro: err.message });
  }
});

// Apagar conversa/lead: vai para a Lixeira (30 dias para restaurar)
router.delete('/leads/:id', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  lixeira.moverParaLixeira(c, req.usuario?.email || '');
  res.json({ ok: true, lixeira: true, dias: lixeira.DIAS });
});

// ---------------------------------------------------------------- lixeira
function acharNaLixeira(req, res) {
  const c = lixeira.acharNaLixeira(req.params.id);
  if (!c || !podeVerEmpresa(req, c.empresaId)) {
    res.status(404).json({ erro: 'Conversa não está na lixeira.' });
    return null;
  }
  return c;
}

router.get('/empresas/:id/lixeira', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(
    lixeira.daEmpresa(empresa.id).map((c) => ({
      ...resumoLead(c),
      ultimaEm: c.mensagens[c.mensagens.length - 1]?.em || c.atualizadoEm,
      apagadaEm: c.naLixeira?.em,
      apagadaPor: c.naLixeira?.por || '',
      diasRestantes: lixeira.diasRestantes(c)
    }))
  );
});

router.post('/lixeira/:id/restaurar', (req, res) => {
  const c = acharNaLixeira(req, res);
  if (!c) return;
  const r = lixeira.restaurar(c);
  res.json({ ...resumoLead(c), juntou: Boolean(r?.juntou) });
});

router.delete('/lixeira/:id', (req, res) => {
  const c = acharNaLixeira(req, res);
  if (!c) return;
  lixeira.apagarDeVez(c);
  res.json({ ok: true });
});

router.delete('/empresas/:id/lixeira', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ apagadas: lixeira.esvaziar(empresa.id) });
});


// Caixinha "Deixar a IA continuar" da mensagem manual: marcada = IA segue; desmarcada = IA para.
// Sem a caixinha (ex.: app antigo), vale o padrão da empresa (IA do WhatsApp → mensagem manual).
function manterIa(lead, manter) {
  if (manter === undefined) return;
  if (manter) {
    lead.iaPausada = false;
    lead.iaPausadaMotivo = '';
    lead.precisaHumano = false;
  } else {
    lead.iaPausada = true;
    lead.iaPausadaMotivo = lead.iaPausadaMotivo || 'A equipe respondeu pelo painel';
    whatsapp.cancelarResposta(lead.id);
  }
  salvar();
}
const caixinha = (v) => (v === undefined || v === null || v === '' ? undefined : v === true || v === '1' || v === 'true');

// ---------------------------------------------------------------- conversas (estilo WhatsApp Web)

router.get('/empresas/:id/conversas', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const busca = String(req.query.busca || '').trim().toLowerCase();
  const filtro = String(req.query.filtro || 'todas');
  // venda concluída (comprovante, IA ou equipe) ou lead em "Fechado": vai para "Vendas concluídas"
  const comVenda = new Set((estado.vendas || []).filter((v) => v.empresaId === empresa.id && v.status !== 'cancelada' && v.leadId).map((v) => v.leadId));
  const fechado = (c) => comVenda.has(c.id) || c.vendaConcluidaManual === true || /fechad|ganh|vendi/i.test(c.etapa || '');
  const etiqueta = String(req.query.etiqueta || '');
  const bloqueado = (c) => leads.naListaNegra(empresa, c);
  const lista = estado.conversas
    .filter((c) => c.empresaId === empresa.id && c.mensagens.length)
    .filter((c) => (filtro === 'arquivadas' ? c.arquivado : !c.arquivado))
    // lista negra: só aparece no filtro 🚫
    .filter((c) => (filtro === 'listaNegra' ? bloqueado(c) : !bloqueado(c)))
    // filtrando por etiqueta (ex.: Agendado) mostra também as vendas concluídas
    .filter((c) => !etiqueta || (c.etiquetas || []).includes(etiqueta))
    .filter((c) => filtro !== 'todas' || etiqueta || !fechado(c))
    .filter((c) => filtro !== 'vendas' || fechado(c))
    .filter((c) => filtro !== 'naoLidas' || c.naoLidas > 0)
    .filter((c) => filtro !== 'equipe' || c.precisaHumano)
    .filter((c) => filtro !== 'iaAtiva' || !c.iaPausada)
    .filter((c) => filtro !== 'iaPausada' || c.iaPausada)
    .filter((c) => filtro !== 'whatsapp' || c.whatsappJid)
    .filter((c) => !busca || [c.nome, c.telefone, c.codigo, ...c.mensagens.slice(-30).map((m) => m.texto)].join(' ').toLowerCase().includes(busca))
    .map((c) => ({ ...resumoLead(c), naoLidas: c.naoLidas || 0, ultimaEm: c.mensagens[c.mensagens.length - 1]?.em || c.atualizadoEm, proximoEnvio: automacoes.proximosEnvios(c, empresa)[0] || null }))
    .sort((a, b) => (a.ultimaEm < b.ultimaEm ? 1 : -1))
    .slice(0, 300);
  res.json(lista);
});

router.post('/leads/:id/lido', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  if (c.naoLidas) {
    c.naoLidas = 0;
    salvar();
  }
  res.json({ ok: true });
});

// Apagar uma mensagem: só do CRM, ou para todos (some também do WhatsApp do cliente)
router.delete('/leads/:id/mensagens/:msgId', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  try {
    await whatsapp.apagarMensagem(empresa, c, req.params.msgId, { paraTodos: req.body?.paraTodos === true });
    res.json(resumoLead(c));
  } catch (err) {
    res.status(err.status && err.status < 500 ? err.status : 502).json({ erro: err.message });
  }
});

// Transcrever um áudio / descrever uma foto na hora (quando a IA não fez sozinha para economizar)
router.post('/leads/:id/anexos/:arquivo/entender', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const msg = c.mensagens.find((m) => m.anexo?.arquivo === req.params.arquivo);
  const caminho = midias.caminhoAnexo(c.id, req.params.arquivo);
  if (!msg || !caminho || !require('fs').existsSync(caminho)) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  const base64 = require('fs').readFileSync(caminho).toString('base64');
  try {
    if (msg.anexo.tipo === 'audio') {
      const t = await ia.transcreverAudio(empresa, base64, msg.anexo.mimetype);
      if (!t) return res.status(400).json({ erro: 'Não consegui transcrever (precisa de uma chave do Gemini ou do ChatGPT em IAs e chaves).' });
      msg.anexo.transcricao = t;
    } else if (msg.anexo.tipo === 'image') {
      msg.anexo.descricao = await ia.descreverImagem(whatsapp.botDoWhatsapp(empresa), empresa, base64, msg.anexo.mimetype);
    } else return res.status(400).json({ erro: 'Só dá para transcrever áudio ou descrever foto.' });
    c.atualizadoEm = agora();
    salvar();
    res.json({ ok: true, anexo: msg.anexo });
  } catch (err) {
    res.status(502).json({ erro: ia.descreverErroIa(err) });
  }
});

// ---------------------------------------------------------------- follow-up
// ---------------------------------------------------------------- aviso de agendamento
router.get('/empresas/:id/aviso-agendamento', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ ...require('./aviso-agendamento').configDa(empresa), automatica: empresa.agendaAutomatica !== false });
});

router.put('/empresas/:id/aviso-agendamento', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    // perceber agendamentos sozinho na conversa (código + IA)
    if (req.body?.automatica !== undefined) { empresa.agendaAutomatica = req.body.automatica === true; salvar(); }
    const c = req.body?.ativo !== undefined || req.body?.numero !== undefined ? require('./aviso-agendamento').salvarConfig(empresa, req.body || {}) : require('./aviso-agendamento').configDa(empresa);
    res.json({ ...c, automatica: empresa.agendaAutomatica !== false });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/empresas/:id/aviso-agendamento/testar', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    await require('./aviso-agendamento').testar(empresa);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------- lista negra
router.get('/empresas/:id/lista-negra', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(leads.listaNegraDa(empresa).slice().reverse());
});

// por número (sem precisar ter conversa)
router.post('/empresas/:id/lista-negra', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const chave = leads.chaveListaNegra(numeroWhatsapp(req.body?.numero) || req.body?.numero);
  if (!chave) return res.status(400).json({ erro: 'Número inválido. Use DDD + número.' });
  const lead = estado.conversas.find((c) => c.empresaId === empresa.id && [c.whatsappJid, c.telefone].map(leads.chaveListaNegra).includes(chave));
  if (lead) leads.porNaListaNegra(empresa, lead, req.usuario.email, texto(req.body?.motivo, 200));
  else if (!leads.naListaNegra(empresa, chave)) {
    leads.listaNegraDa(empresa).push({ id: novoId('ln'), leadId: null, chaves: [chave], nome: texto(req.body?.nome, 80), telefone: chave, motivo: texto(req.body?.motivo, 200), por: req.usuario.email, em: agora() });
    salvar();
  }
  res.status(201).json(leads.listaNegraDa(empresa).slice().reverse());
});

router.delete('/empresas/:id/lista-negra/:itemId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  leads.tirarDaListaNegra(empresa, { id: req.params.itemId });
  res.json(leads.listaNegraDa(empresa).slice().reverse());
});

// Mover à mão para "Vendas concluídas" (e desfazer)
router.post('/leads/:id/venda-concluida', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const etapaFechado = leads.etapasDa(empresa).find((e) => /fechad|ganh|vendi/i.test(e.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  let venda = null;
  const pedidos = {};
  if (req.body?.concluida !== false) {
    const etapaAntes = c.etapa; // para o "desfazer" (a venda abaixo já pode mover a etapa)
    // a equipe informou o valor: a venda já entra no Faturamento (igual à venda automática)
    const valor = req.body?.valor !== undefined && req.body?.valor !== '' ? require('./catalogo').lerPreco(req.body.valor) : null;
    if (req.body?.valor !== undefined && req.body?.valor !== '' && !(valor > 0)) return res.status(400).json({ erro: 'Informe o valor da venda (ex.: 350,00).' });
    if (valor > 0) {
      const FORMAS = ['Pix', 'Dinheiro', 'Cartão', 'Boleto', 'Transferência', 'Outro'];
      venda = tickets.registrarVenda(empresa, c, { valor, descricao: texto(req.body?.descricao, 200), por: 'equipe', forma: FORMAS.includes(req.body?.forma) ? req.body.forma : 'Pix' }).venda;
      venda.registradaPor = req.usuario.email;
    }
    c.vendaConcluidaManual = true;
    c.vendaConcluidaEm = agora();
    c.vendaConcluidaPor = req.usuario.email;
    // guarda a etapa de antes (para "desfazer") ANTES de mover
    if (etapaFechado && etapaAntes !== etapaFechado && !c.etapaAntesDaVenda) c.etapaAntesDaVenda = etapaAntes;
    if (etapaFechado && c.etapa !== etapaFechado) leads.moverEtapa(c, empresa, etapaFechado, 'equipe');
    comprovantes.aoVender(empresa, c); // sai de "agendado": etiqueta do WhatsApp e agenda
    // pedidos pós-venda: mandar agora, deixar a automação mandar ou não mandar
    for (const tipo of ['avaliacao', 'comentario']) {
      const quer = req.body?.pedidos?.[tipo];
      if (quer === 'agora') {
        try {
          await automacoes.enviarPedidoManual(empresa, c, tipo, { usuario: req.usuario.email });
          pedidos[tipo] = 'enviado';
        } catch (err) {
          pedidos[tipo] = `não enviado: ${err.message}`;
        }
      } else if (quer === 'nao') {
        automacoes.naoMandarPedido(empresa, c, tipo, req.usuario.email);
        pedidos[tipo] = 'não vai mandar';
      } else if (quer === 'auto') pedidos[tipo] = 'automação';
    }
  } else {
    if ((estado.vendas || []).some((v) => v.leadId === c.id && v.status !== 'cancelada')) {
      return res.status(400).json({ erro: 'Este cliente tem uma venda registrada. Para tirar daqui, cancele a venda em Faturamento.' });
    }
    delete c.vendaConcluidaManual;
    delete c.vendaConcluidaEm;
    if (c.etapaAntesDaVenda && /fechad|ganh|vendi/i.test((c.etapa || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) leads.moverEtapa(c, empresa, c.etapaAntesDaVenda, 'equipe');
    delete c.etapaAntesDaVenda;
  }
  c.atualizadoEm = agora();
  salvar();
  res.json({ ok: true, vendaConcluida: c.vendaConcluidaManual === true, venda: venda ? { id: venda.id, valor: venda.valor, status: venda.status } : null, pedidos });
});

router.post('/leads/:id/lista-negra', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  leads.porNaListaNegra(empresa, c, req.usuario.email, texto(req.body?.motivo, 200));
  res.json({ ok: true, listaNegra: true });
});

router.delete('/leads/:id/lista-negra', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  leads.tirarDaListaNegra(empresa, { leadId: c.id });
  res.json({ ok: true, listaNegra: leads.naListaNegra(empresa, c) });
});

// ---------------------------------------------------------------- etiquetas do WhatsApp Business
router.get('/empresas/:id/etiquetas-zap', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(require('./etiquetas-zap').resumo(empresa));
});

router.post('/empresas/:id/etiquetas-zap/carregar', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (!whatsapp.configurado(empresa)) return res.status(400).json({ erro: 'Conecte o WhatsApp primeiro.' });
  res.json(await require('./etiquetas-zap').carregar(empresa));
});

router.put('/empresas/:id/etiquetas-zap', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  require('./etiquetas-zap').ligar(empresa, req.body?.ativo === true);
  res.json(require('./etiquetas-zap').resumo(empresa));
});

router.get('/empresas/:id/followup', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ ...require('./followup').paraPainel(empresa), etapas: leads.etapasDa(empresa) });
});

// 📤 Enviar follow-up de teste para um número
router.post('/empresas/:id/followup/teste', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json(await require('./followup').testar(empresa, req.body || {}));
  } catch (err) {
    res.status(err.status || 502).json({ erro: `Não enviei: ${err.message}` });
  }
});

router.put('/empresas/:id/followup', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    require('./followup').salvarConfig(empresa, req.body || {});
    res.json({ ...require('./followup').paraPainel(empresa), etapas: leads.etapasDa(empresa) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------- modo clone
router.get('/empresas/:id/clone', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(require('./clone').resumo(empresa));
});

router.put('/empresas/:id/clone', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  require('./clone').configurar(empresa, req.body || {});
  res.json(require('./clone').resumo(empresa));
});

// arquivo com tudo o que o clone aprendeu
router.get('/empresas/:id/clone/arquivo', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.attachment(`clone-${String(require('./clone').resumo(empresa).nome || 'aprendizado').replace(/[^\w-]+/g, '-').toLowerCase()}.txt`);
  res.type('text/plain; charset=utf-8').send(require('./clone').arquivo(empresa));
});

router.delete('/empresas/:id/clone/exemplos/:exId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  require('./clone').apagarExemplo(empresa, req.params.exId);
  res.json(require('./clone').resumo(empresa));
});

router.delete('/empresas/:id/clone/exemplos', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  require('./clone').limpar(empresa);
  res.json(require('./clone').resumo(empresa));
});

// Foto de perfil do WhatsApp do cliente — só com login
router.get('/leads/:id/foto', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  if (!fotosClientes.temFoto(c)) return res.sendStatus(404);
  res.type('image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=604800'); // o endereço muda quando a foto muda
  res.sendFile(fotosClientes.caminhoDaFoto(c), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Buscar a foto de novo agora (botão no perfil do lead)
router.post('/leads/:id/foto/atualizar', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  if (!c.whatsappJid) return res.status(400).json({ erro: 'Este lead ainda não conversou pelo WhatsApp.' });
  const r = await fotosClientes.buscar(c);
  if (!r.ok) return res.status(502).json({ erro: `Não consegui buscar a foto: ${r.motivo}` });
  res.json({ temFoto: r.temFoto, fotoUrl: fotosClientes.urlDaFoto(c) });
});

// Arquivo que o cliente mandou (ou a equipe) — só com login
router.get('/leads/:id/anexos/:arquivo', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const caminho = midias.caminhoAnexo(c.id, req.params.arquivo);
  const msg = c.mensagens.find((m) => m.anexo?.arquivo === req.params.arquivo);
  if (!caminho || !msg) return res.sendStatus(404);
  tipoDeArquivoSeguro(res, msg.anexo.mimetype, msg.anexo.nome || msg.anexo.arquivo);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(caminho, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Equipe manda foto/vídeo/áudio/PDF do computador
router.post('/leads/:id/arquivo', express.raw({ type: 'application/octet-stream', limit: midias.TAMANHO_MAXIMO + 1024 }), async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const destino = whatsapp.destinoDoLead(c);
  if (!destino) return res.status(400).json({ erro: 'Este lead não tem WhatsApp.' });
  if (!req.body?.length) return res.status(400).json({ erro: 'Arquivo vazio.' });
  const nome = texto(req.query.nome, 120) || 'arquivo';
  const mimetype = midias.mimeDe(nome, texto(req.query.tipo, 100));
  const legenda = texto(req.query.legenda, 1000);
  try {
    await whatsapp.enviarArquivo(empresa, destino, { buffer: req.body, mimetype, nome, legenda });
    const anexo = midias.salvarAnexo(c.id, req.body, mimetype, nome);
    require('./clone').aprenderAnexo(empresa, c, anexo, legenda);
    const { tipo } = anexo;
    const NOME_TIPO = { image: 'uma foto', audio: 'um áudio', video: 'um vídeo', document: 'um arquivo' };
    leads.adicionarMensagem(c, { papel: 'equipe', canal: 'whatsapp', texto: legenda || `[enviou ${NOME_TIPO[tipo]}]`, anexo });
    whatsapp.pausarPorMensagemManual(empresa, c, 'A equipe respondeu pelo painel');
    manterIa(c, caixinha(req.query.manterIa));
    res.json(resumoLead(c));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ erro: err.message });
  }
});

// Arquivo grande da conversa (até 200 MB, qualidade original): sobe em pedaços
// pelas rotas de envio da empresa e aqui é concluído e mandado pelo WhatsApp
router.post('/leads/:id/arquivo/envio', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  if (!whatsapp.destinoDoLead(c)) return res.status(400).json({ erro: 'Este lead não tem WhatsApp.' });
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  try {
    const b = req.body || {};
    res.json({ ...midias.iniciarEnvio(empresa, { arquivo: texto(b.arquivo, 200), tamanho: b.tamanho, tipo: texto(b.tipo, 100) }), empresaId: empresa.id });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/leads/:id/arquivo/envio/:envioId/concluir', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const destino = whatsapp.destinoDoLead(c);
  if (!destino) return res.status(400).json({ erro: 'Este lead não tem WhatsApp.' });
  const legenda = texto(req.body?.legenda, 1000);
  let anexo;
  try {
    anexo = midias.concluirAnexo(empresa, req.params.envioId, c.id);
  } catch (err) {
    return res.status(err.status || 500).json({ erro: err.message });
  }
  // a mensagem aparece na hora como "enviando…"; arquivo grande pode levar minutos
  // para o WhatsApp baixar e mandar, então o envio segue em segundo plano
  const NOME_TIPO = { image: 'uma foto', audio: 'um áudio', video: 'um vídeo', document: 'um arquivo' };
  leads.adicionarMensagem(c, { papel: 'equipe', canal: 'whatsapp', texto: legenda || `[enviou ${NOME_TIPO[anexo.tipo] || 'um arquivo'}]`, anexo, envio: 'enviando', wids: [] });
  const msg = c.mensagens[c.mensagens.length - 1];
  whatsapp.pausarPorMensagemManual(empresa, c, 'A equipe respondeu pelo painel');
  manterIa(c, caixinha(req.body?.manterIa));
  salvar();
  res.status(202).json(resumoLead(c));
  try {
    const { tipo, wid } = await whatsapp.enviarAnexoPorUrl(empresa, destino, c.id, anexo, anexo.tipo === 'audio' ? '' : legenda);
    msg.envio = 'ok';
    require('./clone').aprenderAnexo(empresa, c, anexo, legenda);
    if (wid) msg.wids = [wid];
    if (tipo === 'document' && anexo.tipo !== 'document') msg.comoArquivo = true;
  } catch (err) {
    msg.envio = 'erro';
    msg.erroEnvio = String(err.message).slice(0, 200);
    require('./alertas').registrar(empresa, 'whatsapp-envio', `O arquivo "${anexo.nome}" não foi enviado: ${err.message}`, { leadId: c.id });
  }
  c.atualizadoEm = agora();
  salvar();
});

// 🔄 Reiniciar aprendizado da conversa: a IA esquece o que leu até aqui e começa do zero
// (o histórico continua aparecendo para a equipe). { desfazer: true } volta a ler tudo.
router.post('/leads/:id/reiniciar-aprendizado', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  if (req.body?.desfazer === true) {
    delete c.iaReiniciadaEm;
    delete c.iaReiniciadaPor;
  } else {
    c.iaReiniciadaEm = agora();
    c.iaReiniciadaPor = req.usuario.email;
    delete c.agendaConferidaAte; // o detector de agendamento relê do zero
    delete c.sugestaoMidia;
    c.sugestaoMidiaConferidaAte = c.iaReiniciadaEm;
    const aprendizado = require('./aprendizado');
    for (const jid of [c.whatsappJid, c.lidJid].filter(Boolean)) aprendizado.esquecerConversa(empresa, jid);
  }
  salvar();
  res.json({ ok: true, iaReiniciadaEm: c.iaReiniciadaEm || null });
});

// Sugestão de mídia na conversa: dispensar uma (codigo) ou todas
router.post('/leads/:id/sugestao-midia/dispensar', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  require('./sugestao-midia').dispensar(c, texto(req.body?.codigo, 60));
  res.json({ ok: true });
});

// Liga/desliga a sugestão de mídia da empresa
router.get('/empresas/:id/sugestao-midia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json({ ativo: require('./sugestao-midia').configDa(empresa).ativo !== false });
});
router.put('/empresas/:id/sugestao-midia', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  res.json(require('./sugestao-midia').ligar(empresa, req.body?.ativo === true));
});

// Equipe manda uma mídia (ou álbum) da biblioteca
router.post('/leads/:id/midia', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  if (!whatsapp.destinoDoLead(c)) return res.status(400).json({ erro: 'Este lead não tem WhatsApp.' });
  const nome = texto(req.body?.nome, 120);
  if (!midias.acharParaEnviar(empresa, nome).length) return res.status(404).json({ erro: 'Mídia não encontrada.' });
  const r = await whatsapp.enviarMidiasPedidas(empresa, c, [nome], 'equipe');
  if (r.enviadas) require('./clone').registrar(empresa, c, { midias: [midias.resolverPedido(empresa, nome).alvo?.codigo] });
  if (r.enviadas) require('./sugestao-midia').enviada(c, midias.resolverPedido(empresa, nome).alvo?.codigo);
  salvar();
  if (r.falhas.length && !r.enviadas) return res.status(502).json({ erro: `Não foi enviada. ${r.falhas.join(' · ')}` });
  res.json({ ...resumoLead(c), avisoEnvio: r.falhas.length ? `Algumas não foram: ${r.falhas.join(' · ')}` : '' });
});

// O que a IA precisa saber para sugerir a próxima mensagem certa: quem falou
// por último, o que o cliente disse, há quanto tempo e as anotações da equipe
function instrucaoDeSugestao(lead, conversa, pedido) {
  const ultima = conversa[conversa.length - 1];
  const ultimaDoCliente = [...conversa].reverse().find((m) => m.papel === 'visitante');
  const horas = (Date.now() - new Date(ultima.em).getTime()) / 3600e3;
  const quando = horas < 1 ? 'agora há pouco' : horas < 24 ? `há ${Math.round(horas)} h` : `há ${Math.round(horas / 24)} dia(s)`;
  const linhas = ['Tarefa: sugerir a PRÓXIMA mensagem que a equipe vai mandar a este cliente. Leia a conversa inteira acima antes de escrever.'];
  if (ultima.papel === 'visitante') {
    linhas.push(`A última mensagem é do CLIENTE (${quando}): "${ultima.texto.slice(0, 600)}". Responda diretamente a ela — o que ele perguntou, pediu ou objetou — sem mudar de assunto.`);
  } else {
    linhas.push(`A última mensagem foi NOSSA (${quando}) e o cliente ainda não respondeu. Sugira um retorno curto e gentil que retome exatamente o último assunto${ultimaDoCliente ? ` (o que o cliente tinha dito por último: "${ultimaDoCliente.texto.slice(0, 300)}")` : ''}, sem repetir a mensagem anterior.`);
  }
  if (lead.anotacoes?.trim()) linhas.push(`Anotações internas da equipe sobre este cliente (não cite ao cliente): ${lead.anotacoes.trim().slice(0, 800)}`);
  linhas.push('Leve em conta o que já foi combinado, perguntado e respondido (não repita perguntas já respondidas). Se fizer sentido, conduza para o próximo passo da venda, mas sem ignorar o que o cliente disse. Use só informações que estão na conversa ou nas informações da empresa.');
  if (pedido) linhas.push(`Pedido da equipe para esta sugestão: ${pedido}`);
  return linhas.join(' ');
}

// A IA sugere a próxima mensagem (a equipe revisa antes de enviar)
router.post('/leads/:id/sugerir', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const bot = whatsapp.botDoWhatsapp(empresa);
  if (!bot) return res.status(400).json({ erro: 'A empresa não tem assistente.' });
  const pedido = texto(req.body?.pedido, 500);
  const conversa = leads.historicoParaIa(c).filter((m) => !m.apagada && m.texto);
  if (!conversa.length) return res.status(400).json({ erro: 'Ainda não há conversa com este cliente para a IA ler.' });
  const contexto = async () => ({
    etapas: leads.etapasDa(empresa),
    etapaAtual: c.etapa,
    links: midias.linksDa(empresa),
    midias: midias.paraIa(empresa),
    tickets: tickets.paraIa(c),
    localizacao: localizacao.paraIa(c),
    origem: await origem.contextoParaIa(c, bot, 'whatsapp', empresa).catch(() => '')
  });
  const resultado = await sugerirMensagem(empresa, bot, c, conversa, pedido, contexto);
  if (resultado.texto) return res.json(resultado);
  res.status(502).json({ erro: resultado.erro });
});

// 1º jeito: a IA de atendimento escreve (com mídias, etapas, instruções do dono);
// 2º: de novo, pedindo texto puro; 3º (reserva): um pedido simples, só com a
// conversa em texto, que funciona mesmo quando o atendimento completo falha.
async function sugerirMensagem(empresa, bot, c, conversa, pedido, contexto) {
  let ultimoErro = null;
  const MARCADORES = ' Você está escrevendo uma SUGESTÃO para a equipe revisar: escreva só o texto da mensagem para o cliente; não use marcadores [[...]] (nada de HUMANO, RETOMAR, ETAPA) e não deixe vazio.';
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const instrucao = instrucaoDeSugestao(c, conversa, pedido) + MARCADORES + (tentativa ? ' IMPORTANTE: a tentativa anterior veio vazia — escreva a mensagem agora.' : '');
      const r = await ia.escreverMensagem(bot, empresa, leads.historicoParaIa(c), instrucao, await contexto());
      const sugestao = limparSugestao(r.texto);
      if (sugestao) return { texto: sugestao, midias: r.midias || [], via: 'atendimento' };
      console.error(`[sugerir ${c.id}] tentativa ${tentativa + 1}: a IA devolveu texto vazio`);
    } catch (err) {
      ultimoErro = err;
      console.error(`[sugerir ${c.id}] tentativa ${tentativa + 1} falhou: ${err?.status || ''} ${String(err?.message || err).slice(0, 300)}`);
      if (err?.status && err.status < 500 && err.status !== 429 && err.status !== 400) break; // chave inválida, sem crédito: não adianta repetir
    }
  }
  try {
    const linhas = conversa.slice(-25).map((m) => `${m.papel === 'visitante' ? 'Cliente' : m.papel === 'equipe' ? 'Equipe' : 'Empresa'}: ${String(m.texto).slice(0, 600)}`);
    const instrucoes = String(bot.promptWhatsapp || '').trim();
    const sistema = `Você escreve mensagens de WhatsApp para a equipe da empresa "${empresa.nome}" mandar a um cliente. Responda SOMENTE com o texto da mensagem, em português do Brasil, curto e natural, sem aspas, sem explicação e sem inventar preço, prazo ou dado que não esteja na conversa ou nas informações abaixo.${instrucoes ? `\n\nInstruções do dono (obedeça):\n${instrucoes.slice(0, 3000)}` : ''}\n\nInformações da empresa:\n${String(bot.conhecimento || '').slice(0, 6000)}${require('./catalogo').paraIa(empresa) ? `\n\nServiços, produtos e preços OFICIAIS (valem acima de qualquer outro preço):\n${require('./catalogo').paraIa(empresa).replace(/\[\[MIDIA: [^\]]+\]\]/g, '').slice(0, 6000)}` : ''}`;
    const texto = limparSugestao(await ia.gerarTexto(bot, empresa, sistema, `Conversa:\n${linhas.join('\n')}\n\n${instrucaoDeSugestao(c, conversa, pedido)}`, 800));
    if (texto) return { texto, midias: [], via: 'reserva' };
  } catch (err) {
    ultimoErro = err;
    console.error(`[sugerir ${c.id}] reserva falhou: ${err?.status || ''} ${String(err?.message || err).slice(0, 300)}`);
  }
  return { erro: ultimoErro ? ia.descreverErroIa(ultimoErro) : 'A IA não conseguiu escrever uma sugestão agora. Tente de novo.' };
}

// Tira o que a IA às vezes põe em volta: "Sugestão:", aspas, marcadores que sobraram
function limparSugestao(t) {
  return String(t || '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/^\s*(sugest[aã]o( de mensagem)?|mensagem( sugerida)?|resposta)\s*:\s*/i, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim();
}

router.post('/leads/:id/agendar', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  try {
    res.status(201).json(automacoes.agendarMensagem(c, req.body || {}, req.usuario));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.delete('/leads/:id/agendadas/:agendadaId', (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const a = (c.agendadas || []).find((x) => x.id === req.params.agendadaId);
  if (!a || a.status !== 'pendente') return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  a.status = 'cancelada';
  salvar();
  res.json({ ok: true });
});


// Equipe usa uma resposta pronta (texto + mídia) na conversa
router.post('/leads/:id/resposta-rapida', async (req, res) => {
  const c = acharLead(req, res);
  if (!c) return;
  const empresa = estado.empresas.find((e) => e.id === c.empresaId);
  const resposta = (empresa.respostasRapidas || []).find((r) => r.id === req.body?.id);
  if (!resposta) return res.status(404).json({ erro: 'Resposta pronta não encontrada.' });
  if (!whatsapp.destinoDoLead(c)) return res.status(400).json({ erro: 'Este lead não tem WhatsApp.' });
  try {
    await whatsapp.enviarRespostaRapida(empresa, c, { ...resposta, texto: req.body?.texto !== undefined ? texto(req.body.texto, 4000) : resposta.texto });
    whatsapp.pausarPorMensagemManual(empresa, c, 'A equipe respondeu pelo painel');
    manterIa(c, caixinha(req.body?.manterIa));
    res.json(resumoLead(c));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------- site da empresa (conhecimento da IA)

router.get('/empresas/:id/site', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (empresa) res.json(siteEmpresa.resumo(empresa));
});

router.put('/empresas/:id/site', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const b = req.body || {};
    siteEmpresa.guardar(empresa, { links: b.links, seguirLinks: b.seguirLinks, copia: b.copia, usar: b.usar });
    res.json(siteEmpresa.resumo(empresa));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// Lê o site agora (em segundo plano; o painel acompanha pelo GET)
router.post('/empresas/:id/site/ler', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (!siteEmpresa.siteDa(empresa).links.length) return res.status(400).json({ erro: 'Cole pelo menos um link do seu site e salve.' });
  siteEmpresa.lerSite(empresa, { motivo: `manual (${req.usuario.email})` }).catch((err) => console.error(`[site ${empresa.id}]`, err.message));
  setTimeout(() => res.status(202).json(siteEmpresa.resumo(empresa)), 50);
});

// ---------------------------------------------------------------- anúncios e campanhas

function resumoAnuncios(empresa) {
  const trinta = new Date(Date.now() - 30 * 864e5).toISOString();
  const daEmpresa = estado.conversas.filter((c) => c.empresaId === empresa.id);
  const lista = origem.anunciosDa(empresa).map((a) => ({
    ...a,
    leads30d: daEmpresa.filter((c) => c.anuncioId === a.id && c.criadoEm >= trinta).length
  }));
  // anúncios de clique para WhatsApp que chegaram e ainda não estão cadastrados
  const conhecidos = new Set();
  const detectados = [];
  for (const c of [...daEmpresa].sort((x, y) => (x.criadoEm < y.criadoEm ? 1 : -1))) {
    const ad = c.origemSite?.anuncioMeta;
    if (!ad || c.anuncioId) continue;
    const chave = ad.id || ad.titulo || ad.url;
    if (!chave || conhecidos.has(chave)) continue;
    conhecidos.add(chave);
    detectados.push({ titulo: ad.titulo, texto: ad.texto, url: ad.url, id: ad.id, leads: daEmpresa.filter((x) => (x.origemSite?.anuncioMeta?.id || x.origemSite?.anuncioMeta?.titulo || x.origemSite?.anuncioMeta?.url) === chave).length });
    if (detectados.length >= 10) break;
  }
  // campanhas UTM que chegaram e ainda não estão cadastradas
  const campanhas = {};
  for (const c of daEmpresa) {
    const nome = c.origemSite?.chegada?.utm?.campaign;
    if (nome && !c.anuncioId) campanhas[nome] = (campanhas[nome] || 0) + 1;
  }
  return {
    anuncios: lista,
    detectados,
    campanhas: Object.entries(campanhas).map(([nome, leads]) => ({ nome, leads })).sort((a, b) => b.leads - a.leads).slice(0, 10)
  };
}

router.get('/empresas/:id/anuncios', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (empresa) res.json(resumoAnuncios(empresa));
});

router.put('/empresas/:id/anuncios', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    empresa.anuncios = origem.normalizarAnuncios(req.body?.anuncios, origem.anunciosDa(empresa));
    const ids = new Set(empresa.anuncios.map((a) => a.id));
    // leads recentes sem anúncio são conferidos de novo com as palavras novas
    const trinta = new Date(Date.now() - 30 * 864e5).toISOString();
    for (const c of estado.conversas) {
      if (c.empresaId !== empresa.id) continue;
      if (c.anuncioId && !ids.has(c.anuncioId)) {
        c.anuncioId = null;
        c.anuncioPor = null;
      }
      if (!c.anuncioId && c.criadoEm >= trinta) origem.aplicarAnuncio(empresa, c);
    }
    salvar();
    res.json(resumoAnuncios(empresa));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------- aprendizados (varredura das conversas)

router.get('/empresas/:id/aprendizado', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (empresa) res.json(aprendizado.resumo(empresa));
});

router.put('/empresas/:id/aprendizado', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  const mudancas = {};
  if (b.texto !== undefined) mudancas.texto = texto(b.texto, 20000);
  if (b.diario !== undefined) mudancas.diario = b.diario === true;
  if (b.usarNoPrompt !== undefined) mudancas.usarNoPrompt = b.usarNoPrompt === true;
  if (b.somenteVendas !== undefined) mudancas.somenteVendas = b.somenteVendas === true;
  aprendizado.guardar(empresa, mudancas);
  res.json(aprendizado.resumo(empresa));
});

router.post('/empresas/:id/aprendizado/varrer', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (aprendizado.progresso(empresa)) return res.status(409).json({ erro: 'Já existe uma varredura em andamento.' });
  if (!whatsapp.configurado(empresa)) return res.status(400).json({ erro: 'Conecte o WhatsApp primeiro.' });
  // roda em segundo plano; o painel acompanha pelo GET
  aprendizado.varrer(empresa, { motivo: `manual (${req.usuario.email})` }).catch((err) => console.error(`[aprendizado ${empresa.id}]`, err.message));
  res.status(202).json(aprendizado.resumo(empresa));
});

router.post('/empresas/:id/aprendizado/zerar', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    aprendizado.zerar(empresa);
    res.json(aprendizado.resumo(empresa));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.get('/empresas/:id/aprendizado/arquivo', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const nome = `aprendizados-${String(empresa.nome).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').toLowerCase()}.txt`;
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.type('text/plain; charset=utf-8').send(aprendizado.configDa(empresa).texto || '(ainda vazio — faça a primeira varredura)');
});

// ---------------------------------------------------------------- respostas rápidas, links e Google Drive

router.put('/empresas/:id/respostas', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const lista = (Array.isArray(req.body?.respostas) ? req.body.respostas : [])
    .map((r) => ({
      id: texto(r?.id, 40) || novoId('rr'),
      atalho: texto(r?.atalho, 30).replace(/^\/+/, '').replace(/\s+/g, '-').toLowerCase(),
      texto: texto(r?.texto, 2000),
      midia: texto(r?.midia, 120),
      quando: texto(r?.quando, 200)
    }))
    // guarda a mídia pelo CÓDIGO (se renomear a mídia, a resposta continua certa)
    .map((r) => {
      const achado = r.midia ? midias.resolverPedido(empresa, r.midia) : null;
      return { ...r, midia: achado?.itens.length ? achado.alvo.codigo || r.midia : '' };
    })
    .filter((r) => r.atalho && (r.texto || r.midia))
    .slice(0, 100);
  const repetido = lista.find((r, i) => lista.findIndex((x) => x.atalho === r.atalho) !== i);
  if (repetido) return res.status(400).json({ erro: `O atalho /${repetido.atalho} está repetido.` });
  empresa.respostasRapidas = lista;
  if (req.body?.atalhosNoCelular !== undefined) empresa.atalhosNoCelular = req.body.atalhosNoCelular === true;
  salvar();
  res.json(lista);
});

router.put('/empresas/:id/links', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const lista = [];
  for (const l of (Array.isArray(req.body?.links) ? req.body.links : []).slice(0, 50)) {
    const nome = texto(l?.nome, 80);
    let url = texto(l?.url, 500);
    if (!nome && !url) continue;
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ erro: `Link inválido: ${url || nome}` });
    }
    if (!nome) return res.status(400).json({ erro: `Dê um nome para o link ${url}.` });
    lista.push({ id: texto(l?.id, 40) || novoId('lnk'), nome, url, descricao: texto(l?.descricao, 300) });
  }
  empresa.links = lista;
  salvar();
  res.json(lista);
});

router.post('/empresas/:id/drive', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  const driveId = midias.idDaPasta(b.link);
  if (midias.pastasDa(empresa).some((p) => p.driveId === driveId)) return res.status(400).json({ erro: 'Esta pasta já está conectada. Use "Sincronizar".' });
  try {
    res.status(201).json(await midias.sincronizarPasta(empresa, { link: b.link, nome: texto(b.nome, 80), descricao: texto(b.descricao, 300), chaveGoogle: ia.chave('gemini', empresa) }));
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.message });
  }
});

router.post('/empresas/:id/drive/:pastaId/sincronizar', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const pasta = midias.pastasDa(empresa).find((p) => p.id === req.params.pastaId);
  if (!pasta) return res.status(404).json({ erro: 'Pasta não encontrada.' });
  try {
    res.json(await midias.sincronizarPasta(empresa, { pastaExistente: pasta, chaveGoogle: ia.chave('gemini', empresa) }));
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.message });
  }
});

router.put('/empresas/:id/drive/:pastaId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const pasta = midias.pastasDa(empresa).find((p) => p.id === req.params.pastaId);
  if (!pasta) return res.status(404).json({ erro: 'Pasta não encontrada.' });
  const nome = texto(req.body?.nome, 80);
  if (!nome) return res.status(400).json({ erro: 'Dê um nome para o álbum.' });
  try {
    if (req.body?.codigo !== undefined && midias.codigoDaEntrada(req.body.codigo) !== pasta.codigo) pasta.codigo = midias.validarCodigo(empresa, req.body.codigo, pasta.id);
  } catch (err) {
    return res.status(err.status || 400).json({ erro: err.message });
  }
  pasta.nome = nome;
  pasta.descricao = texto(req.body?.descricao, 300);
  if (req.body?.etapas !== undefined) pasta.etapas = midias.listaEtapas(req.body.etapas);
  salvar();
  res.json(pasta);
});

router.delete('/empresas/:id/drive/:pastaId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  midias.apagarPasta(empresa, req.params.pastaId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- automações (máquina de vendas)

router.get('/empresas/:id/automacoes', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const regras = automacoes.automacoesDa(empresa);
  res.json({
    regras: regras.map((r) => automacoes.resumo(r, empresa)),
    receitas: Object.entries(automacoes.RECEITAS).map(([id, f]) => {
      const r = f(empresa);
      return { id, nome: r.nome, explicacao: r.explicacao, jaTem: regras.some((x) => x.receita === id) };
    }),
    linkAvaliacao: whatsapp.botDoWhatsapp(empresa)?.linkAvaliacao || '',
    linkAnuncio: whatsapp.botDoWhatsapp(empresa)?.linkAnuncio || '',
    whatsappConectado: whatsapp.configurado(empresa),
    horarioAutomatico: automacoes.horarioAutomatico(empresa)
  });
});

router.post('/empresas/:id/automacoes', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    if (req.body?.receita) return res.status(201).json(automacoes.resumo(automacoes.criarDeReceita(empresa, String(req.body.receita)), empresa));
    const regra = { id: novoId('aut'), ...automacoes.normalizarRegra(empresa, req.body || {}), criadoEm: agora() };
    empresa.automacoes = [...automacoes.automacoesDa(empresa), regra];
    salvar();
    res.status(201).json(automacoes.resumo(regra, empresa));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.put('/empresas/:id/automacoes/:regraId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const i = automacoes.automacoesDa(empresa).findIndex((r) => r.id === req.params.regraId);
  if (i < 0) return res.status(404).json({ erro: 'Automação não encontrada.' });
  try {
    empresa.automacoes[i] = automacoes.normalizarRegra(empresa, req.body || {}, empresa.automacoes[i]);
    salvar();
    res.json(automacoes.resumo(empresa.automacoes[i], empresa));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.delete('/empresas/:id/automacoes/:regraId', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  empresa.automacoes = automacoes.automacoesDa(empresa).filter((r) => r.id !== req.params.regraId);
  salvar();
  res.json({ ok: true });
});


// ---------------------------------------------------------------- logo da empresa

const LOGO_MIMES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
function pastaLogos() {
  return path.join(config.midiasDir, 'logos');
}
function apagarLogo(empresa) {
  if (!empresa?.logo) return;
  try {
    fs.unlinkSync(path.join(pastaLogos(), empresa.logo.arquivo));
  } catch {
    /* já não existia */
  }
  delete empresa.logo;
}

router.post('/empresas/:id/logo', express.raw({ type: 'application/octet-stream', limit: 3 * 1024 * 1024 }), (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const mime = texto(req.query.tipo, 60).toLowerCase();
  if (!LOGO_MIMES[mime]) return res.status(400).json({ erro: 'Envie uma imagem PNG, JPG ou WEBP.' });
  if (!req.body?.length) return res.status(400).json({ erro: 'Imagem vazia.' });
  apagarLogo(empresa);
  fs.mkdirSync(pastaLogos(), { recursive: true });
  const arquivo = `${empresa.id}${LOGO_MIMES[mime]}`;
  fs.writeFileSync(path.join(pastaLogos(), arquivo), req.body);
  empresa.logo = { arquivo, mimetype: mime, v: Date.now().toString(36) };
  salvar();
  res.json(empresaComExtras(empresa, req));
});

router.delete('/empresas/:id/logo', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  apagarLogo(empresa);
  salvar();
  res.json(empresaComExtras(empresa, req));
});

// ---------------------------------------------------------------- faturamento (vendas)

function vendaPublica(v) {
  const lead = v.leadId ? estado.conversas.find((c) => c.id === v.leadId) : null;
  const { hash, ...resto } = v;
  return {
    ...resto,
    cliente: v.cliente || lead?.nome || '',
    leadNome: lead ? lead.nome || (lead.telefone ? `+${lead.telefone}` : 'Lead') : '',
    comprovanteUrl: v.anexo ? `api/empresas/${v.empresaId}/vendas/${v.id}/comprovante` : ''
  };
}

function acharVenda(req, res) {
  const v = (estado.vendas || []).find((x) => x.id === req.params.vendaId && x.empresaId === req.params.id);
  if (!v || !podeVerEmpresa(req, v.empresaId)) {
    res.status(404).json({ erro: 'Venda não encontrada.' });
    return null;
  }
  return v;
}

router.get('/empresas/:id/faturamento', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : '';
  const lista = comprovantes
    .vendasDa(empresa)
    .filter((v) => !mes || new Date(new Date(v.data).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7) === mes)
    .sort((a, b) => (a.data < b.data ? 1 : -1))
    .slice(0, 1000)
    .map(vendaPublica);
  res.json({ resumo: comprovantes.resumo(empresa), vendas: lista, config: comprovantes.configDa(empresa) });
});

// Procurar vendas agora (a mesma varredura de hora em hora, sem IA)
router.post('/empresas/:id/varredura-vendas', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const r = await require('./varredura-vendas').varrer();
  if (r.emAndamento) return res.status(409).json({ erro: 'Já estou procurando. Aguarde um pouco.' });
  res.json(r);
});

router.put('/empresas/:id/faturamento/config', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  empresa.faturamento = {
    ...(empresa.faturamento || {}),
    ...(b.ativo !== undefined ? { ativo: b.ativo === true } : {}),
    ...(b.usarIa !== undefined ? { usarIa: b.usarIa === true } : {}),
    ...(b.moverParaFechado !== undefined ? { moverParaFechado: b.moverParaFechado === true } : {}),
    ...(b.recebedores !== undefined ? { recebedores: texto(b.recebedores, 500) } : {}),
    ...(b.vendaPorFrase !== undefined ? { vendaPorFrase: b.vendaPorFrase === true } : {}),
    ...(b.frasesVenda !== undefined ? { frasesVenda: texto(b.frasesVenda, 500) } : {})
  };
  salvar();
  res.json(comprovantes.configDa(empresa));
});

function dadosVenda(b) {
  const valor = comprovantes.paraNumero(String(b.valor ?? '').replace('R$', '')) ?? Number(b.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw Object.assign(new Error('Informe o valor da venda.'), { status: 400 });
  const data = b.data ? new Date(b.data) : new Date();
  if (Number.isNaN(data.getTime())) throw Object.assign(new Error('Data inválida.'), { status: 400 });
  return {
    valor: Math.round(valor * 100) / 100,
    data: data.toISOString(),
    forma: ['Pix', 'Dinheiro', 'Cartão', 'Boleto', 'Transferência', 'Outro'].includes(b.forma) ? b.forma : 'Pix',
    cliente: texto(b.cliente, 120),
    descricao: texto(b.descricao, 300)
  };
}

// Venda lançada à mão pela equipe
router.post('/empresas/:id/vendas', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const d = dadosVenda(req.body || {});
    const lead = req.body?.leadId ? estado.conversas.find((c) => c.id === req.body.leadId && c.empresaId === empresa.id) : null;
    const { venda } = comprovantes.registrar(empresa, lead, { ...d, pagador: d.cliente }, { origem: 'manual', lidoPor: 'manual', descricao: d.descricao });
    venda.cliente = d.cliente || venda.cliente;
    salvar();
    res.status(201).json(vendaPublica(venda));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

// Comprovante enviado pelo painel (ex.: chegou por outro lugar)
router.post('/empresas/:id/vendas/comprovante', express.raw({ type: 'application/octet-stream', limit: midias.TAMANHO_MAXIMO + 1024 }), async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (!req.body?.length) return res.status(400).json({ erro: 'Arquivo vazio.' });
  const nome = texto(req.query.nome, 120) || 'comprovante';
  const mimetype = midias.mimeDe(nome, texto(req.query.tipo, 100));
  const lead = req.query.leadId ? estado.conversas.find((c) => c.id === req.query.leadId && c.empresaId === empresa.id) : null;
  const anexo = midias.salvarAnexo(`vendas-${empresa.id}`, req.body, mimetype, nome);
  const bot = whatsapp.botDoWhatsapp(empresa);
  const r = await comprovantes
    .processarArquivo({ ...empresa, faturamento: { ...(empresa.faturamento || {}), ativo: true } }, lead, {
      buffer: req.body,
      mimetype,
      anexo: null,
      lerComIa: () => ia.lerComprovante(bot, empresa, req.body.toString('base64'), mimetype)
    })
    .catch((err) => ({ erro: err.message }));
  if (!r || r.erro) return res.status(400).json({ erro: r?.erro || 'Não consegui ler este comprovante. Lance a venda à mão.' });
  // empresa "clonada" acima só para forçar a leitura: corrige o id e guarda o arquivo
  r.venda.empresaId = empresa.id;
  r.venda.origem = 'painel';
  r.venda.anexo = { leadId: null, arquivo: anexo.arquivo, mimetype: anexo.mimetype };
  salvar();
  res.status(201).json({ ...vendaPublica(r.venda), repetida: /já tinha sido registrado/.test(r.texto) });
});

router.get('/empresas/:id/vendas/:vendaId/comprovante', (req, res) => {
  const v = acharVenda(req, res);
  if (!v) return;
  // comprovante mandado no WhatsApp fica na pasta da conversa (mesmo com ela na lixeira)
  const caminho = v.anexo ? midias.caminhoAnexo(v.anexo.leadId || `vendas-${v.empresaId}`, v.anexo.arquivo) : null;
  if (!caminho) return res.sendStatus(404);
  tipoDeArquivoSeguro(res, v.anexo.mimetype, v.anexo.nome || v.anexo.arquivo);
  res.sendFile(caminho, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

router.put('/empresas/:id/vendas/:vendaId', (req, res) => {
  const v = acharVenda(req, res);
  if (!v) return;
  const empresa = estado.empresas.find((e) => e.id === v.empresaId);
  const b = req.body || {};
  try {
    if (b.valor !== undefined || b.data !== undefined) {
      const d = dadosVenda({ valor: b.valor ?? v.valor, data: b.data ?? v.data, forma: b.forma ?? v.forma, cliente: b.cliente ?? v.cliente, descricao: b.descricao ?? v.descricao });
      Object.assign(v, d);
    } else {
      if (b.cliente !== undefined) v.cliente = texto(b.cliente, 120);
      if (b.descricao !== undefined) v.descricao = texto(b.descricao, 300);
    }
    if (['confirmada', 'conferir', 'cancelada'].includes(b.status) && b.status !== v.status) {
      if (b.status === 'confirmada' && v.status !== 'confirmada') v.confirmadaEm = agora();
      v.status = b.status;
      v.statusPor = req.usuario.email;
      const lead = v.leadId && estado.conversas.find((c) => c.id === v.leadId);
      if (b.status === 'confirmada' && lead) comprovantes.aoVender(empresa, lead);
    }
    salvar();
    res.json(vendaPublica(v));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.delete('/empresas/:id/vendas/:vendaId', (req, res) => {
  const v = acharVenda(req, res);
  if (!v) return;
  estado.vendas = estado.vendas.filter((x) => x.id !== v.id);
  salvar();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- gastos (grupo do WhatsApp)

const gastos = require('./gastos');

function gastoPublico(g) {
  const { hash, ...resto } = g;
  return { ...resto, comprovanteUrl: g.anexo ? `api/empresas/${g.empresaId}/gastos/${g.id}/comprovante` : '' };
}

function dadosGasto(b, empresa) {
  const valor = comprovantes.paraNumero(String(b.valor ?? '').replace('R$', '')) ?? Number(b.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw Object.assign(new Error('Informe o valor do gasto.'), { status: 400 });
  const data = b.data ? new Date(b.data) : new Date();
  if (Number.isNaN(data.getTime())) throw Object.assign(new Error('Data inválida.'), { status: 400 });
  const categoria = texto(b.categoria, 60) || 'Outros';
  return { valor: Math.round(valor * 100) / 100, data: data.toISOString(), categoria, descricao: texto(b.descricao, 200) };
}

router.get('/empresas/:id/gastos', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : gastos.mesDe(new Date().toISOString());
  const lista = gastos
    .gastosDa(empresa)
    .filter((g) => gastos.mesDe(g.data) === mes)
    .sort((a, b) => (a.data < b.data ? 1 : -1))
    .map(gastoPublico);
  res.json({ resumo: gastos.resumo(empresa, mes), gastos: lista, config: gastos.configDa(empresa), whatsappConectado: whatsapp.configurado(empresa) });
});

router.get('/empresas/:id/gastos/grupos', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  if (!whatsapp.configurado(empresa)) return res.status(400).json({ erro: 'Conecte o WhatsApp da empresa primeiro.' });
  try {
    res.json(await gastos.listarGrupos(empresa));
  } catch (err) {
    res.status(502).json({ erro: `Não consegui buscar os grupos do WhatsApp: ${err.message}` });
  }
});

router.put('/empresas/:id/gastos/config', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  const b = req.body || {};
  try {
    if (b.grupoJid !== undefined) await gastos.conectarGrupo(empresa, { grupoJid: texto(b.grupoJid, 120), grupoNome: texto(b.grupoNome, 100) });
    const atual = empresa.gastos || {};
    if (b.responderNoGrupo !== undefined) atual.responderNoGrupo = b.responderNoGrupo !== false;
    if (b.usarIa !== undefined) atual.usarIa = b.usarIa !== false;
    if (Array.isArray(b.categorias)) {
      const vistas = new Set();
      const lista = b.categorias
        .map((c) => ({ nome: texto(c?.nome, 40), palavras: texto(c?.palavras, 400) }))
        .filter((c) => c.nome && !vistas.has(c.nome.toLowerCase()) && vistas.add(c.nome.toLowerCase()))
        .slice(0, 40);
      if (!lista.some((c) => c.nome === 'Outros')) lista.push({ nome: 'Outros', palavras: '' });
      atual.categorias = lista;
    }
    empresa.gastos = atual;
    salvar();
    res.json(gastos.configDa(empresa));
  } catch (err) {
    res.status(err.status || 502).json({ erro: err.message });
  }
});

// Buscar agora as mensagens do grupo que não chegaram
router.post('/empresas/:id/gastos/buscar', async (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    res.json({ achados: await gastos.buscarNoGrupo(empresa) });
  } catch (err) {
    res.status(502).json({ erro: `Não consegui ler o grupo: ${err.message}` });
  }
});

router.post('/empresas/:id/gastos', (req, res) => {
  const empresa = acharEmpresa(req, res);
  if (!empresa) return;
  try {
    const g = gastos.registrar(empresa, dadosGasto(req.body || {}, empresa), { origem: 'manual', autor: req.usuario.email });
    res.status(201).json(gastoPublico(g));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

function acharGasto(req, res) {
  const g = (estado.gastos || []).find((x) => x.id === req.params.gastoId && x.empresaId === req.params.id);
  if (!g || !podeVerEmpresa(req, g.empresaId)) {
    res.status(404).json({ erro: 'Gasto não encontrado.' });
    return null;
  }
  return g;
}

router.put('/empresas/:id/gastos/:gastoId', (req, res) => {
  const g = acharGasto(req, res);
  if (!g) return;
  const b = req.body || {};
  try {
    Object.assign(g, dadosGasto({ valor: b.valor ?? g.valor, data: b.data ?? g.data, categoria: b.categoria ?? g.categoria, descricao: b.descricao ?? g.descricao }));
    salvar();
    res.json(gastoPublico(g));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.delete('/empresas/:id/gastos/:gastoId', (req, res) => {
  const g = acharGasto(req, res);
  if (!g) return;
  estado.gastos = estado.gastos.filter((x) => x.id !== g.id);
  salvar();
  res.json({ ok: true });
});

router.get('/empresas/:id/gastos/:gastoId/comprovante', (req, res) => {
  const g = acharGasto(req, res);
  if (!g) return;
  const caminho = g.anexo ? midias.caminhoAnexo(`gastos-${g.empresaId}`, g.anexo.arquivo) : null;
  if (!caminho) return res.sendStatus(404);
  tipoDeArquivoSeguro(res, g.anexo.mimetype, g.anexo.arquivo);
  res.sendFile(caminho, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
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
  return {
    anthropic: item('anthropicApiKey', 'anthropicApiKey'),
    gemini: item('geminiApiKey', 'geminiApiKey'),
    openai: item('openaiApiKey', 'openaiApiKey'),
    evolutionUrl: whatsapp.evolutionUrlGlobal(),
    evolutionUrlDoPainel: Boolean(salvas.evolutionUrl),
    evolutionChave: item('evolutionApiKey', 'evolutionApiKey')
  };
}

router.get('/config', auth.exigirAdmin, (req, res) => res.json(situacaoChaves()));

router.put('/config', auth.exigirAdmin, async (req, res) => {
  estado.config = estado.config || {};
  const campos = ia.CAMPO_CHAVE;
  for (const [provedor, campo] of Object.entries(campos)) {
    const valor = texto(req.body?.[campo], 300);
    if (valor) estado.config[campo] = valor;
    if ((req.body?.remover || []).includes(provedor)) delete estado.config[campo];
  }
  const chaveEvo = texto(req.body?.evolutionApiKey, 300);
  if (chaveEvo) {
    const urlNova = texto(req.body?.evolutionUrl, 300).replace(/\/+$/, '') || whatsapp.evolutionUrlGlobal();
    try {
      await whatsapp.testarChaveGlobal(chaveEvo, urlNova);
    } catch (err) {
      return res.status(400).json({ erro: err.message });
    }
    estado.config.evolutionApiKey = chaveEvo;
  }
  if ((req.body?.remover || []).includes('evolution')) delete estado.config.evolutionApiKey;
  if (req.body?.evolutionUrl !== undefined) {
    const url = texto(req.body.evolutionUrl, 300).replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ erro: 'O endereço precisa começar com https://' });
    if (url) estado.config.evolutionUrl = url;
    else delete estado.config.evolutionUrl;
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

// ---------------------------------------------------------------- alertas (o CRM avisa quando algo dá errado)

function idsVisiveis(req) {
  return new Set(estado.empresas.filter((e) => podeVerEmpresa(req, e.id)).map((e) => e.id));
}

router.get('/alertas', (req, res) => {
  const ids = idsVisiveis(req);
  const soEmpresa = String(req.query.empresaId || '');
  const filtro = soEmpresa && ids.has(soEmpresa) ? new Set([soEmpresa]) : ids;
  const lista = alertas.listar(filtro, { todos: ehAdmin(req) && !soEmpresa }).map((a) => ({ ...a, empresaNome: estado.empresas.find((e) => e.id === a.empresaId)?.nome || 'Sistema' }));
  res.json({ alertas: lista, naoLidos: alertas.naoLidos(filtro, { todos: ehAdmin(req) && !soEmpresa }), backup: ehAdmin(req) ? backup.resumo() : null });
});

router.post('/alertas/lidos', (req, res) => {
  alertas.marcarLidos(idsVisiveis(req), { todos: ehAdmin(req) });
  res.json({ ok: true });
});

router.post('/alertas/:alertaId/resolver', (req, res) => {
  const a = (estado.alertas || []).find((x) => x.id === req.params.alertaId);
  if (!a || (a.empresaId ? !podeVerEmpresa(req, a.empresaId) : !ehAdmin(req))) return res.status(404).json({ erro: 'Alerta não encontrado.' });
  alertas.resolver(a.id);
  res.json({ ok: true });
});

// Backup na hora (admin) — além dos automáticos
router.post('/backup', auth.exigirAdmin, (req, res) => {
  try {
    const arquivo = backup.backupDoBanco('manual');
    backup.fotoDasMidias();
    res.json({ ok: true, arquivo: require('path').basename(arquivo || ''), ...backup.resumo() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
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
module.exports.sugerirMensagem = sugerirMensagem;
module.exports.instrucaoDeSugestao = instrucaoDeSugestao;
