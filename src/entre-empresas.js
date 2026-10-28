// entre-empresas.js — duas empresas do CRM nunca conversam entre si.
//
// Se o WhatsApp de uma empresa do CRM escreve para outra (teste, engano, indicação…), a IA
// de uma responderia a IA da outra sem parar. Mensagem que vem do número de outra empresa
// do CRM é ignorada (não vira conversa) e a IA, o follow-up e as automações não mandam
// nada para esses números.
// Exceção: 🧪 disparo de teste para o número de outra empresa sua — por 2 h a conversa do teste
// recebe as mensagens e a IA de quem testou responde. Do outro lado a IA continua bloqueada
// (só um lado fala sozinho), e não dá para abrir o teste ao contrário ao mesmo tempo.

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

// 🧪 teste liberado nesta conversa (até quando)?
const testeLiberado = (lead) => Boolean(lead?.testeLiberadoAte && lead.testeLiberadoAte > new Date().toISOString());

// mensagem de outra empresa do CRM que é a resposta de um teste liberado
function testeLiberadoDaMensagem(empresa, msg) {
  const identidade = require('./identidade');
  return identidade.conversasDoCliente(empresa, identidade.enderecos(msg)).some(testeLiberado);
}

// a empresa dona deste número (outra do CRM), ou null
function empresaDoNumero(empresa, numero) {
  const k = chave(numero);
  return (estado.empresas || []).find((e) => e.id !== empresa.id && numerosDa(e).includes(k)) || null;
}

// já existe um teste aberto AO CONTRÁRIO (a outra empresa testando com o número desta)?
function testeAoContrario(empresa, outra) {
  const meus = new Set(numerosDa(empresa));
  return estado.conversas.some((c) => c.empresaId === outra.id && testeLiberado(c) && [c.telefone, c.whatsappJid].some((j) => j && meus.has(chave(j))));
}

module.exports = { aprenderNumeroProprio, mensagemDeOutraEmpresa, leadDeOutraEmpresa, chave, testeLiberado, testeLiberadoDaMensagem, empresaDoNumero, testeAoContrario };
