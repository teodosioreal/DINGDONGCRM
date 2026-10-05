// entre-empresas.js — duas empresas do CRM nunca conversam entre si.
//
// Se o WhatsApp de uma empresa do CRM escreve para outra (teste, engano, indicação…), a IA
// de uma responderia a IA da outra sem parar. Mensagem que vem do número de outra empresa
// do CRM é ignorada (não vira conversa) e a IA, o follow-up e as automações não mandam
// nada para esses números.

const { estado } = require('./db');

const digitos = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
// compara sem o 55 e sem o 9 extra do celular
const chave = (s) => {
  let d = digitos(s);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3);
  return d;
};

function numerosDa(e) {
  const c = e.whatsappConfig || {};
  return [c.perfil?.numero, c.numeroProprio].map(chave).filter((x) => x.length >= 8);
}

// Números (chaves) das OUTRAS empresas do CRM
function numerosDasOutras(empresa) {
  const s = new Set();
  for (const e of estado.empresas || []) if (e.id !== empresa?.id) for (const n of numerosDa(e)) s.add(n);
  return s;
}

// O webhook traz o número do próprio WhatsApp da empresa (sender): guarda para as outras reconhecerem
function aprenderNumeroProprio(empresa, corpo) {
  const n = digitos(corpo?.sender || '');
  if (n.length < 10 || !empresa.whatsappConfig || empresa.whatsappConfig.numeroProprio === n) return false;
  empresa.whatsappConfig.numeroProprio = n;
  return true;
}

// A mensagem veio do número de outra empresa do CRM?
function mensagemDeOutraEmpresa(empresa, msg) {
  const outras = numerosDasOutras(empresa);
  if (!outras.size) return false;
  const k = msg?.key || {};
  return [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participant, msg?.senderPn].some((j) => j && !/@lid$/.test(j) && outras.has(chave(j)));
}

// Esta conversa é com outra empresa do CRM?
function leadDeOutraEmpresa(empresa, lead) {
  const outras = numerosDasOutras(empresa);
  if (!outras.size || !lead) return false;
  return [lead.telefone, lead.whatsappJid].some((j) => j && !/@lid$/.test(j) && outras.has(chave(j)));
}

module.exports = { aprenderNumeroProprio, mensagemDeOutraEmpresa, leadDeOutraEmpresa, chave };
