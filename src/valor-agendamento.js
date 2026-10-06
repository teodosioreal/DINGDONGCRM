// valor-agendamento.js — quanto vai entrar com cada agendamento, SEM IA (só código).
//
// Ordem: 1) o valor que a equipe digitou no cartão; 2) um preço escrito na descrição do
// agendamento; 3) o último preço combinado na conversa até o horário marcado. Se a mensagem
// tiver várias opções (ex.: "aro R$ 250 · completo R$ 450"), vale a que o cliente escolheu
// (as palavras dele depois do preço); sem escolha clara, fica a menor e o cartão avisa.
// Parcela ("12x de R$ 40"), sinal/entrada, frete e desconto não contam como preço do serviço.

const comprovantes = require('./comprovantes');

const DINHEIRO = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)|\b(\d{2,3}(?:\.\d{3})*(?:,\d{1,2})?|\d{2,6})\s*(?:reais|real|conto|contos|pila)\b/gi;
const NAO_E_PRECO = /\b\d+\s*x\b|\bparcel|\bsinal\b|\bentrada\b|\bfrete\b|\bdesconto\b|\bde volta\b|\btroco\b|\bjuros\b|\btaxa\b/i;
const VAZIAS = new Set('para pelo pela mais menos esse essa este esta isso aqui fica ficaria valor preco preço reais real fazer faço fazemos voce você vocês voces quero queria pode sobre como qual quanto quantos tambem também muito muita com sem por que porque entao então ainda depois antes hoje amanha amanhã cliente obrigado obrigada beleza certo fechado fechou perfeito ótimo otimo sim não nao tudo bom boa dia tarde noite'.split(' '));
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palavras = (s) => new Set(semAcento(s).split(/[^a-z0-9]+/).filter((p) => p.length >= 4 && !VAZIAS.has(p) && !/^\d+$/.test(p)));

// preços de um texto, linha a linha: [{ valor, linha }]
function precosDe(texto) {
  const lista = [];
  for (const linha of String(texto || '').split(/\n+/)) {
    if (NAO_E_PRECO.test(linha)) continue;
    DINHEIRO.lastIndex = 0;
    let m;
    while ((m = DINHEIRO.exec(linha))) {
      const n = comprovantes.paraNumero(m[1] || m[2]);
      if (Number.isFinite(n) && n >= 10 && n <= 1000000) lista.push({ valor: n, linha });
    }
  }
  return lista;
}

const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function daConversa(lead, ag) {
  const limite = ag.quando ? new Date(ag.quando).getTime() : Date.now();
  const msgs = (lead.mensagens || []).filter((m) => !m.apagada && !m.eventoInterno && ['visitante', 'assistente', 'equipe'].includes(m.papel) && m.texto && new Date(m.em).getTime() <= limite);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const precos = precosDe(msgs[i].texto);
    if (!precos.length) continue;
    const valores = [...new Set(precos.map((p) => p.valor))];
    if (valores.length === 1) return { valor: valores[0], origem: 'conversa', trecho: precos[0].linha.trim().slice(0, 140) };
    // várias opções: a que o cliente escolheu depois (palavras da linha do preço nas mensagens dele)
    const depois = msgs.slice(i + 1).filter((m) => m.papel === 'visitante').map((m) => m.texto).join(' ');
    const doCliente = palavras(depois);
    let melhor = null;
    let pontos = 0;
    let empate = false;
    for (const p of precos) {
      const n = [...palavras(p.linha)].filter((w) => doCliente.has(w)).length;
      if (n > pontos) { melhor = p; pontos = n; empate = false; } else if (n && n === pontos && p.valor !== melhor.valor) empate = true;
    }
    if (melhor && !empate) return { valor: melhor.valor, origem: 'conversa', trecho: melhor.linha.trim().slice(0, 140) };
    // "total" na linha resolve; senão a menor (previsão conservadora) e avisa
    const total = precos.find((p) => /\btotal\b/i.test(p.linha));
    if (total) return { valor: total.valor, origem: 'conversa', trecho: total.linha.trim().slice(0, 140) };
    const menor = precos.reduce((a, b) => (b.valor < a.valor ? b : a));
    return { valor: menor.valor, origem: 'conversa', incerto: true, trecho: `várias opções na conversa (${valores.slice(0, 4).map(brl).join(', ')}) — usei a menor` };
  }
  return null;
}

// { valor, origem: 'manual' | 'descricao' | 'conversa', incerto?, trecho? } ou { valor: null }
function valorDo(lead, ag) {
  if (Number.isFinite(ag.valor) && ag.valor > 0) return { valor: ag.valor, origem: 'manual' };
  const daDescricao = precosDe(ag.descricao);
  if (daDescricao.length) return { valor: daDescricao[daDescricao.length - 1].valor, origem: 'descricao' };
  return daConversa(lead, ag) || { valor: null };
}

module.exports = { valorDo, precosDe };
