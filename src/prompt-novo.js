// prompt-novo.js — botão "Atualizar prompt" da IA do WhatsApp.
//
// Salva as instruções e, a partir dali, a IA segue SÓ o prompt novo:
//   - o clone (respostas do dono como modelo) e os aprendizados saem do prompt da IA.
//     Nada é apagado: fica guardado como estava e dá para voltar com um clique;
//   - nas conversas que já estavam em andamento, o que foi dito antes do prompt novo
//     vira só contexto ("o que já foi falado"), e não exemplo: a IA não imita mais as
//     respostas antigas (ex.: começar toda mensagem com "Legal").

const { salvar, agora } = require('./db');

function situacao(empresa) {
  const p = empresa?.promptNovo;
  if (!p?.em) return null;
  return { em: p.em, por: p.por || '', vezes: p.vezes || 1, guardado: { ...(p.guardado || {}) } };
}

// Liga o "só o prompt novo" (guardando como o clone e os aprendizados estavam)
function aplicar(empresa, quem = '') {
  const clone = require('./clone');
  const aprendizado = require('./aprendizado');
  const antes = empresa.promptNovo;
  const cl = clone.resumo(empresa);
  // o que estava ligado ANTES do primeiro "Atualizar prompt" (para o "voltar")
  const guardado = antes?.guardado || {
    cloneResponder: cl.responder === true,
    aprendizadosNoPrompt: aprendizado.configDa(empresa).usarNoPrompt !== false,
    em: agora()
  };
  if (cl.responder) clone.configurar(empresa, { responder: false });
  if (aprendizado.configDa(empresa).usarNoPrompt !== false) aprendizado.guardar(empresa, { usarNoPrompt: false });
  empresa.promptNovo = { em: agora(), por: quem, vezes: (antes?.vezes || 0) + 1, guardado };
  salvar();
  return situacao(empresa);
}

// Volta o clone e os aprendizados como estavam (e a IA volta a ler as conversas inteiras)
function voltar(empresa) {
  const p = empresa.promptNovo;
  if (!p) return null;
  const g = p.guardado || {};
  if (g.cloneResponder) require('./clone').configurar(empresa, { responder: true });
  if (g.aprendizadosNoPrompt) require('./aprendizado').guardar(empresa, { usarNoPrompt: true });
  delete empresa.promptNovo;
  salvar();
  return { cloneResponder: Boolean(g.cloneResponder), aprendizadosNoPrompt: Boolean(g.aprendizadosNoPrompt) };
}

const curto = (t, n) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Histórico que a IA lê: o que veio depois do prompt novo continua como conversa; o que
// veio antes vira um resumo em texto (contexto, não modelo). Mensagens do cliente que
// ainda estavam sem resposta na hora do corte continuam na conversa.
// Devolve { historico, anterior } (anterior = '' quando não há corte).
function separarHistorico(empresa, historico = []) {
  const corte = empresa?.promptNovo?.em;
  if (!corte || !historico.length) return { historico, anterior: '' };
  const novo = (m) => !m.em || String(m.em) >= corte; // sem data = criada agora (aviso interno, teste)
  let i = historico.findIndex(novo);
  if (i === -1) i = historico.length;
  while (i > 0 && historico[i - 1].papel === 'visitante') i--;
  if (i === 0) return { historico, anterior: '' };
  const depois = historico.slice(i);
  if (!depois.some((m) => m.papel === 'visitante')) return { historico, anterior: '' };
  const QUEM = { visitante: 'Cliente', assistente: 'Empresa', equipe: 'Equipe' };
  const linhas = historico
    .slice(0, i)
    .filter((m) => !m.apagada && m.texto && QUEM[m.papel])
    .slice(-20)
    .map((m) => `${QUEM[m.papel]}: ${curto(m.texto, 300)}`);
  return { historico: depois, anterior: linhas.join('\n') };
}

module.exports = { situacao, aplicar, voltar, separarHistorico };
