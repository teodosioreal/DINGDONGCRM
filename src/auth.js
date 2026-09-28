const crypto = require('crypto');
const config = require('./config');
const { estado, salvar, salvarAgora, novoId, agora } = require('./db');

const COOKIE = 'crm_sessao';

function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, sal, 64).toString('hex');
  return `${sal}:${hash}`;
}

function conferirSenha(senha, guardado) {
  const [sal, hash] = String(guardado || '').split(':');
  if (!sal || !hash) return false;
  const calculado = crypto.scryptSync(String(senha), sal, 64);
  const esperado = Buffer.from(hash, 'hex');
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

function lerCookies(req) {
  const saida = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    saida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return saida;
}

function opcoesCookie(maxAgeSeg) {
  return [
    `Path=${config.basePath || '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    config.cookieSeguro ? 'Secure' : '',
    `Max-Age=${maxAgeSeg}`
  ]
    .filter(Boolean)
    .join('; ');
}

function criarSessao(res, usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = config.diasSessao * 24 * 60 * 60;
  estado.sessoes.push({
    token,
    usuarioId: usuario.id,
    expiraEm: new Date(Date.now() + maxAge * 1000).toISOString()
  });
  salvar();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${opcoesCookie(maxAge)}`);
}

function encerrarSessao(req, res) {
  const token = lerCookies(req)[COOKIE];
  const i = estado.sessoes.findIndex((s) => s.token === token);
  if (i >= 0) {
    estado.sessoes.splice(i, 1);
    salvar();
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; ${opcoesCookie(0)}`);
}

function usuarioDaRequisicao(req) {
  const token = lerCookies(req)[COOKIE];
  if (!token) return null;
  const sessao = estado.sessoes.find((s) => s.token === token);
  if (!sessao || sessao.expiraEm < agora()) return null;
  const usuario = estado.usuarios.find((u) => u.id === sessao.usuarioId && u.ativo !== false);
  return usuario || null;
}

// Middleware: exige login. Coloca o usuário em req.usuario.
function exigirLogin(req, res, next) {
  const usuario = usuarioDaRequisicao(req);
  if (!usuario) return res.status(401).json({ erro: 'Faça login para continuar.' });
  req.usuario = usuario;
  next();
}

function exigirAdmin(req, res, next) {
  if (req.usuario?.papel !== 'admin') {
    return res.status(403).json({ erro: 'Apenas administradores podem fazer isso.' });
  }
  next();
}

function usuarioPublico(u) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email,
    papel: u.papel,
    empresaId: u.empresaId || null,
    ativo: u.ativo !== false,
    criadoEm: u.criadoEm
  };
}

// Na primeira execução (sem nenhum usuário), cria o administrador a partir do
// .env. Se ADMIN_EMAIL/ADMIN_SENHA não estiverem definidos, gera uma senha
// aleatória e mostra no console uma única vez.
function garantirAdmin() {
  if (estado.usuarios.length > 0) return;
  const email = config.adminEmail || 'admin@odingdong.tech';
  const senha = config.adminSenha || crypto.randomBytes(9).toString('base64url');
  estado.usuarios.push({
    id: novoId('usr'),
    nome: 'Administrador',
    email,
    senhaHash: hashSenha(senha),
    papel: 'admin',
    empresaId: null,
    ativo: true,
    criadoEm: agora()
  });
  salvarAgora();
  console.log(`Administrador criado: ${email}`);
  if (!config.adminSenha) console.log(`Senha gerada (troque depois do primeiro login): ${senha}`);
}

// Remove sessões vencidas de tempos em tempos
setInterval(() => {
  const t = agora();
  const antes = estado.sessoes.length;
  for (let i = estado.sessoes.length - 1; i >= 0; i--) {
    if (estado.sessoes[i].expiraEm < t) estado.sessoes.splice(i, 1);
  }
  if (estado.sessoes.length !== antes) salvar();
}, 60 * 60 * 1000).unref();

module.exports = {
  hashSenha,
  conferirSenha,
  criarSessao,
  encerrarSessao,
  exigirLogin,
  exigirAdmin,
  usuarioPublico,
  garantirAdmin
};
