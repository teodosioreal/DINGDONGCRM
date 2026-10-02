// obediencia.js — conferência automática das respostas da IA contra as
// instruções do dono, ANTES de mandar para o cliente. Pega o que dá para
// conferir com certeza (sem gastar IA):
//   - "não se apresente como assistente virtual / IA / robô / bot…"
//   - palavras ou frases proibidas entre aspas: não use "querido", nunca diga "promoção"
// Se a resposta quebrar uma dessas regras, a IA reescreve uma vez com o aviso
// do que quebrou; se ainda assim quebrar, as frases proibidas são tiradas.

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// jeitos de a IA se apresentar como máquina
const IDENTIDADE = /\b(assistente|atendente|secretari[ao]) (virtual|digital|automatic[oa]|de ia|inteligente)\b|\b(sou|e|aqui e|falando com) (um|uma|o|a)? ?(ia|inteligencia artificial|robo|robozinho|bot|chatbot|assistente|atendimento automatico|sistema automatico)\b|\binteligencia artificial\b|\bchatbot\b/;

const NEGA = '(nao|nunca|jamais|evite|proibido|sem)';

function regrasDe(instrucoes) {
  const t = sem(instrucoes);
  const regras = [];
  // "não se apresente como assistente virtual", "nunca diga que é um robô/IA", "não fale que é bot"
  const reIdent = new RegExp(`${NEGA}[^.\\n;]{0,60}(apresent|diga|dizer|fal[ae]r?|mencion|revel|cit|assum|identifi|chame|chamar)[^.\\n;]{0,60}(assistente|atendente virtual|\\bia\\b|inteligencia artificial|robo|\\bbot\\b|chatbot|virtual|automatic)`);
  const m = t.match(reIdent);
  if (m) regras.push({ tipo: 'identidade', texto: trechoOriginal(instrucoes, m.index, m[0].length), testar: (r) => IDENTIDADE.test(sem(r)) });
  // palavras/frases proibidas entre aspas: não use "X" nem "Y", nunca diga 'Z', proibido falar “W”
  const vistos = new Set();
  let pos = 0;
  for (const frase of t.split(/[.\n;!]/)) {
    const ini = t.indexOf(frase, pos);
    pos = ini + frase.length;
    if (!new RegExp(`(^|\\s)${NEGA}\\b`).test(frase)) continue;
    for (const x of frase.matchAll(/["'“”‘’]([^"'“”‘’\n]{2,40})["'“”‘’]/g)) {
      const termo = x[1].trim();
      if (termo.length < 2 || vistos.has(termo)) continue;
      vistos.add(termo);
      const re = new RegExp(`(^|[^a-z0-9])${termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
      regras.push({ tipo: 'termo', termo, texto: trechoOriginal(instrucoes, ini, frase.length), testar: (r) => re.test(sem(r)) });
    }
  }
  return regras.slice(0, 12);
}

// mesmo trecho no texto original (com acentos), para mostrar na correção
function trechoOriginal(original, ini, tam) {
  return String(original).slice(ini, ini + tam).trim();
}

// O cliente perguntou se está falando com robô/pessoa? Aí a IA pode responder com sinceridade.
function perguntouSeEhRobo(ultimaDoCliente) {
  return /(robo|\bbot\b|\bia\b|inteligencia artificial|maquina|humano|pessoa de verdade|pessoa real|atendente real|e automatico|resposta automatica|gravad)/.test(sem(ultimaDoCliente)) && /\?|e voce|voce e|ta falando|to falando|estou falando|falando com/.test(sem(ultimaDoCliente));
}

function violacoes(resposta, regras, ultimaDoCliente = '') {
  const liberarIdentidade = perguntouSeEhRobo(ultimaDoCliente);
  return regras.filter((r) => !(r.tipo === 'identidade' && liberarIdentidade) && r.testar(resposta));
}

// Último recurso: tira as frases que quebram a regra (se sobrar algo)
function limpar(resposta, quebradas) {
  const frases = String(resposta).split(/(?<=[.!?])\s+|\n/);
  const boas = frases.filter((f) => !quebradas.some((r) => r.testar(f)));
  const texto = boas.join(' ').replace(/\s{2,}/g, ' ').trim();
  return texto.length >= 2 ? texto : resposta;
}

module.exports = { regrasDe, violacoes, limpar, perguntouSeEhRobo };
