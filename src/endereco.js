// endereco.js — o cliente já passou o endereço? (só código, sem IA)
//
// Com "Só agendar com endereço" ligado (padrão; aba Agendamentos), nenhum agendamento
// automático (IA, detector da conversa) é criado sem o endereço do cliente na conversa.
// Vale como endereço: localização compartilhada no WhatsApp, CEP, ou rua/avenida/estrada…
// com número — escrito pelo CLIENTE, ou na própria mensagem/descrição que confirma o
// agendamento (ex.: a equipe escreve "agendado sábado 9h na Rua X, 120").
// Endereço que a empresa manda em outras mensagens (ex.: o da loja) não conta.

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const LOGRADOURO = /\b(rua|r\.|av\.?|avenida|travessa|tv\.|estrada|estr\.|rodovia|rod\.|alameda|al\.|praca|largo|servidao|ladeira|beco|vila|condominio|cond\.|loteamento|residencial|conjunto|quadra|qd\.?)\s+[a-z0-9]/;
const NUMERO = /(\b(n|no|n°|nº|num|numero)\.?\s*\d{1,5}\b|,\s*\d{1,5}\b|\b\d{1,5}\s*(,|-|\/|casa|apto?|apartamento|bloco|fundos|lote)|\s\d{1,5}\s*$)/;
const CEP = /\b\d{5}-?\d{3}\b/;
const LOCALIZACAO = /\[o cliente enviou uma localiza/;

function ehEndereco(texto) {
  const t = sem(texto);
  if (!t) return false;
  if (LOCALIZACAO.test(t) || CEP.test(t)) return true;
  // "Endereço: …" / "Local: …" com número, "nº 45", "bairro X, 120", link do Google Maps
  if (/\b(endereco|local|localizacao)\s*:\s*[^\n]*?\b\d{1,5}\b(?!\s*(h|hs|hrs|horas|:\d|\/))/.test(t)) return true;
  if (/\b(n|no|n°|nº|numero)\.?\s*\d{1,5}\b/.test(t) && /\b(rua|av|avenida|estrada|bairro|travessa|condominio|casa|apto|lote|quadra)\b/.test(t)) return true;
  if (/maps\.(google|app\.goo)|goo\.gl\/maps|maps\.app\.goo\.gl/.test(t)) return true;
  // rua + número na mesma mensagem (ex.: "Rua das Flores 120", "Av. Brasil, 45 - Centro")
  return LOGRADOURO.test(t) && (NUMERO.test(t) || /\b(km|lote|casa)\s*\d+/.test(t));
}

// o endereço que provou (curto) ou ''
function enderecoDo(lead, extras = []) {
  for (const x of extras) if (ehEndereco(x)) return String(x).replace(/\s+/g, ' ').trim().slice(0, 140);
  const msgs = (lead?.mensagens || []).filter((m) => !m.apagada && m.texto && m.papel === 'visitante').slice(-80);
  for (let i = msgs.length - 1; i >= 0; i--) if (ehEndereco(msgs[i].texto)) return String(msgs[i].texto).replace(/\s+/g, ' ').trim().slice(0, 140);
  return '';
}

const exige = (empresa) => empresa?.agendaExigeEndereco !== false;

// pode agendar sozinho? (sem a regra ligada, sempre pode)
function podeAgendar(empresa, lead, extras = []) {
  return !exige(empresa) || Boolean(enderecoDo(lead, extras));
}

module.exports = { ehEndereco, enderecoDo, exige, podeAgendar };
