// cadastro.js — códigos de 6 dígitos por e-mail (criar conta e recuperar senha).
// Ficam só na memória: valem 10 minutos, aceitam 5 tentativas e o mesmo e-mail
// recebe no máximo 1 código por minuto e 5 por hora.

const crypto = require('crypto');

const VALIDADE = 10 * 60 * 1000;
const TENTATIVAS = 5;
const ESPERA_REENVIO = 60 * 1000;
const POR_HORA = 5;

const pendentes = new Map(); // `${motivo}:${email}` → { hash, expira, tentativas, dados }
const envios = new Map(); // `${motivo}:${email}` → [horários dos envios]

const hash = (cod) => crypto.createHash('sha256').update(String(cod)).digest('hex');

setInterval(() => {
  const t = Date.now();
  for (const [k, p] of pendentes) if (p.expira < t) pendentes.delete(k);
  for (const [k, l] of envios) {
    const vivos = l.filter((x) => t - x < 60 * 60 * 1000);
    if (vivos.length) envios.set(k, vivos);
    else envios.delete(k);
  }
}, 5 * 60 * 1000).unref();

// Gera um código novo (troca o anterior). Erro com status 429 se pediu demais.
function gerar(motivo, email, dados = null) {
  const t = Date.now();
  const lista = (envios.get(`${motivo}:${email}`) || []).filter((x) => t - x < 60 * 60 * 1000);
  if (lista.length && t - lista[lista.length - 1] < ESPERA_REENVIO) {
    const s = Math.ceil((ESPERA_REENVIO - (t - lista[lista.length - 1])) / 1000);
    throw Object.assign(new Error(`Espere ${s} segundos para pedir outro código.`), { status: 429 });
  }
  if (lista.length >= POR_HORA) throw Object.assign(new Error('Muitos códigos pedidos para este e-mail. Tente de novo daqui a 1 hora.'), { status: 429 });
  const cod = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const anterior = pendentes.get(`${motivo}:${email}`);
  pendentes.set(`${motivo}:${email}`, { hash: hash(cod), expira: t + VALIDADE, tentativas: 0, dados: dados ?? anterior?.dados ?? null });
  envios.set(`${motivo}:${email}`, [...lista, t]);
  return cod;
}

// Confere o código. Devolve os dados guardados ou lança erro com a explicação.
function conferir(motivo, email, cod) {
  const chave = `${motivo}:${email}`;
  const p = pendentes.get(chave);
  if (!p || p.expira < Date.now()) {
    pendentes.delete(chave);
    throw Object.assign(new Error('Código vencido. Peça um novo.'), { status: 400 });
  }
  if (p.tentativas >= TENTATIVAS) throw Object.assign(new Error('Muitas tentativas erradas. Peça um novo código.'), { status: 429 });
  const certo = Buffer.from(p.hash, 'hex');
  const dado = Buffer.from(hash(String(cod || '').replace(/\D/g, '')), 'hex');
  if (!crypto.timingSafeEqual(certo, dado)) {
    p.tentativas++;
    const restam = TENTATIVAS - p.tentativas;
    throw Object.assign(new Error(restam ? `Código incorreto. Você ainda tem ${restam} tentativa${restam > 1 ? 's' : ''}.` : 'Código incorreto. Peça um novo código.'), { status: 400 });
  }
  pendentes.delete(chave);
  return p.dados;
}

const temPendente = (motivo, email) => {
  const p = pendentes.get(`${motivo}:${email}`);
  return Boolean(p && p.expira > Date.now());
};

module.exports = { gerar, conferir, temPendente };
