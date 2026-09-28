// Utilidades compartilhadas entre as rotas.

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// Número de WhatsApp no formato internacional. Se vier só DDD + número
// (10 ou 11 dígitos) sem "+", assume Brasil e coloca o 55 na frente.
// Números de outros países: digite com "+" (ex.: +1 415 555 1234).
function numeroWhatsapp(v) {
  const bruto = String(v || '').trim();
  const n = soDigitos(bruto).slice(0, 15);
  if (!bruto.startsWith('+') && (n.length === 10 || n.length === 11)) return `55${n}`;
  return n;
}

// Recebe o número já normalizado (como fica salvo no banco)
function linkWhatsapp(numero, mensagem) {
  const n = soDigitos(numero);
  if (!n) return null;
  return `https://wa.me/${n}${mensagem ? `?text=${encodeURIComponent(mensagem)}` : ''}`;
}

// Número para onde o chat do site manda o cliente: o do assistente, o da
// empresa ou, se nenhum foi preenchido, o do WhatsApp conectado no CRM.
function numeroDoAtendimento(bot, empresa) {
  return bot?.whatsapp || empresa?.whatsapp || empresa?.whatsappConfig?.perfil?.numero || '';
}

// "https://www.Loja.com.br/x" -> "loja.com.br"
function hostDe(valor) {
  const v = String(valor || '').trim().toLowerCase();
  if (!v) return '';
  try {
    const url = new URL(v.includes('://') ? v : `https://${v}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function listaDominios(entrada) {
  const itens = Array.isArray(entrada) ? entrada : String(entrada || '').split(/[\s,;]+/);
  return [...new Set(itens.map(hostDe).filter(Boolean))];
}

// Aceita o domínio exato e seus subdomínios (petropolis.loja.com.br vale para loja.com.br).
function dominioPermitido(bot, origem) {
  const dominios = bot.dominios || [];
  if (dominios.length === 0) return true;
  const host = hostDe(origem);
  if (!host) return false;
  return dominios.some((d) => host === d || host.endsWith(`.${d}`));
}

function texto(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function inteiro(v, padrao, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

// Limitador simples em memória: no máximo `limite` eventos por `janelaMs` por chave.
function criarLimitador(limite, janelaMs) {
  const mapa = new Map();
  setInterval(() => {
    const corte = Date.now() - janelaMs;
    for (const [chave, lista] of mapa) {
      const vivos = lista.filter((t) => t > corte);
      if (vivos.length) mapa.set(chave, vivos);
      else mapa.delete(chave);
    }
  }, janelaMs).unref();
  return function permitir(chave) {
    const corte = Date.now() - janelaMs;
    const lista = (mapa.get(chave) || []).filter((t) => t > corte);
    if (lista.length >= limite) {
      mapa.set(chave, lista);
      return false;
    }
    lista.push(Date.now());
    mapa.set(chave, lista);
    return true;
  };
}

module.exports = {
  soDigitos,
  numeroWhatsapp,
  linkWhatsapp,
  numeroDoAtendimento,
  hostDe,
  listaDominios,
  dominioPermitido,
  texto,
  inteiro,
  hoje,
  criarLimitador
};
