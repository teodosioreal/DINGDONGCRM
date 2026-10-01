// clone.js — "Modo clone": a IA aprende com as respostas MANUAIS do dono/equipe
// e passa a responder (e mandar mídia) do mesmo jeito.
//
// - Cada mensagem manual (painel, celular, resposta rápida, mídia da biblioteca,
//   arquivo anexado) vira um EXEMPLO: o que o cliente tinha dito + como você respondeu.
// - Arquivo que você manda (foto, vídeo, PDF) entra na biblioteca como mídia
//   "aprendida do clone", pronta para a IA mandar na mesma situação (sem duplicar).
// - Na hora de responder, o CRM escolhe por CÓDIGO (sem IA, sem gastar tokens) os
//   exemplos mais parecidos com o que o cliente acabou de dizer e mostra para a IA
//   imitar: tamanho, tom, emojis, como passa preço, como fecha, que mídia manda.
// - Liga/desliga em IA do WhatsApp. Exemplos ruins podem ser apagados.

const crypto = require('crypto');
const { estado, salvar, novoId, agora } = require('./db');

const MAX_EXEMPLOS = 300;
const NO_PROMPT = 8; // exemplos por resposta (economiza tokens)
const JUNTAR_MS = 3 * 60 * 1000; // mensagens seguidas suas viram um exemplo só

function configDa(empresa) {
  empresa.clone = empresa.clone || { ativo: false, exemplos: [] };
  if (!Array.isArray(empresa.clone.exemplos)) empresa.clone.exemplos = [];
  return empresa.clone;
}

const ativo = (empresa) => configDa(empresa).ativo === true;

const PARADAS = new Set('a o os as um uma de da do das dos e é eu voce vc vcs que pra para por com sem no na nos nas em me te se ja já mais muito tem ter tá ta to tô sim nao não ok oi ola olá bom boa dia tarde noite tudo bem obrigado obrigada'.split(' '));
const palavras = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && !PARADAS.has(p))
    .map((p) => p.replace(/(s|es|inho|inha)$/, '')); // "volantes" ≈ "volante"

// O que o cliente disse e que a equipe está respondendo agora
function contextoDoCliente(lead) {
  const msgs = (lead.mensagens || []).filter((m) => !m.apagada);
  const doCliente = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.papel === 'visitante') doCliente.unshift(m.texto || '');
    else if (doCliente.length) break; // acha o bloco de mensagens do cliente logo antes da resposta
  }
  return doCliente.slice(-3).join(' / ').slice(0, 500);
}

// Guarda um exemplo de resposta manual
function registrar(empresa, lead, { texto = '', midias = [] } = {}) {
  if (!ativo(empresa)) return null;
  const t = String(texto || '').trim();
  const cods = midias.filter(Boolean);
  if (!t && !cods.length) return null;
  if (/^\[(enviou|o cliente)/i.test(t) && !cods.length) return null; // só "[enviou um arquivo]" sem mídia aprendida
  const cfg = configDa(empresa);
  const ultimo = cfg.exemplos[cfg.exemplos.length - 1];
  // várias mensagens seguidas suas para o mesmo cliente = uma resposta só
  if (ultimo && ultimo.leadId === lead.id && Date.now() - new Date(ultimo.ultimaEm || ultimo.em).getTime() < JUNTAR_MS) {
    if (t && !/^\[enviou/i.test(t)) ultimo.resposta = [ultimo.resposta, t].filter(Boolean).join('\n').slice(0, 1200);
    ultimo.midias = [...new Set([...(ultimo.midias || []), ...cods])].slice(0, 6);
    ultimo.ultimaEm = agora();
    salvar();
    return ultimo;
  }
  const ex = {
    id: novoId('cln'),
    leadId: lead.id,
    cliente: contextoDoCliente(lead) || '(você puxou a conversa)',
    resposta: /^\[enviou/i.test(t) ? '' : t.slice(0, 1200),
    midias: cods.slice(0, 6),
    etapa: lead.etapa || '',
    em: agora(),
    ultimaEm: agora()
  };
  cfg.exemplos.push(ex);
  if (cfg.exemplos.length > MAX_EXEMPLOS) cfg.exemplos.splice(0, cfg.exemplos.length - MAX_EXEMPLOS);
  salvar();
  return ex;
}

// Arquivo que você mandou → mídia da biblioteca (pronta para a IA mandar igual). Devolve o código.
function aprenderArquivo(empresa, lead, { buffer, nome, mimetype }) {
  if (!ativo(empresa) || !buffer?.length) return null;
  const midias = require('./midias');
  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  const ja = midias.midiasDa(empresa).find((m) => m.hash === hash);
  if (ja) return ja.codigo;
  const contexto = contextoDoCliente(lead);
  try {
    const m = midias.salvarMidia(empresa, {
      buffer,
      nomeArquivo: nome || 'arquivo',
      nome: `Clone · ${String(nome || 'arquivo').replace(/\.[^.]+$/, '')}`.slice(0, 80),
      descricao: contexto ? `quando o cliente disser algo como: "${contexto.slice(0, 200)}"` : 'quando fizer sentido na conversa (você mandou isso à mão)',
      mimetypeInformado: mimetype,
      extra: { hash, aprendidaDoClone: true, pronta: true }
    });
    return m.codigo;
  } catch (err) {
    console.error('[clone] não guardei o arquivo:', err.message);
    return null;
  }
}

// Arquivo que você mandou na conversa (já salvo na pasta dela) → aprende arquivo + resposta
function aprenderAnexo(empresa, lead, anexo, legenda = '') {
  if (!ativo(empresa) || !anexo?.arquivo || !['image', 'video', 'document'].includes(anexo.tipo)) return registrar(empresa, lead, { texto: legenda });
  const caminho = require('./midias').caminhoAnexo(lead.id, anexo.arquivo);
  let codigo = null;
  try {
    if (caminho) codigo = aprenderArquivo(empresa, lead, { buffer: require('fs').readFileSync(caminho), nome: anexo.nome || anexo.arquivo, mimetype: anexo.mimetype });
  } catch {
    /* arquivo sumiu: fica só o texto */
  }
  return registrar(empresa, lead, { texto: legenda, midias: codigo ? [codigo] : [] });
}

// Os exemplos mais parecidos com o que o cliente acabou de dizer (sem IA)
function relevantes(empresa, lead) {
  const cfg = configDa(empresa);
  if (!cfg.exemplos.length) return [];
  const agoraCliente = new Set(palavras(contextoDoCliente(lead) || (lead.mensagens || []).slice(-3).map((m) => m.texto).join(' ')));
  const pontuados = cfg.exemplos.map((ex, i) => {
    const pal = palavras(ex.cliente);
    let comum = 0;
    for (const p of new Set(pal)) if (agoraCliente.has(p)) comum++;
    const sim = comum / Math.max(1, Math.sqrt(agoraCliente.size * new Set(pal).size || 1));
    return { ex, nota: sim + (ex.etapa && ex.etapa === lead.etapa ? 0.05 : 0) + (i / cfg.exemplos.length) * 0.02 };
  });
  const parecidos = pontuados.filter((p) => p.nota > 0.08).sort((a, b) => b.nota - a.nota).slice(0, NO_PROMPT - 3).map((p) => p.ex);
  const recentes = cfg.exemplos.slice(-6).reverse();
  const escolhidos = [...parecidos];
  for (const r of recentes) if (escolhidos.length < NO_PROMPT && !escolhidos.includes(r)) escolhidos.push(r);
  return escolhidos;
}

// Bloco para o prompt da IA
function paraIa(empresa, lead) {
  if (!ativo(empresa)) return '';
  const lista = relevantes(empresa, lead);
  if (!lista.length) return '';
  const codigosValidos = new Set(require('./midias').paraIa(empresa).map((m) => m.codigo));
  return lista
    .map((ex, i) => {
      const midias = (ex.midias || []).filter((c) => codigosValidos.has(c));
      return `Exemplo ${i + 1}\nCliente: ${ex.cliente}\nDono respondeu: ${ex.resposta || '(só mandou mídia)'}${midias.length ? `\nE mandou: ${midias.map((c) => `[[MIDIA: ${c}]]`).join(' ')}` : ''}`;
    })
    .join('\n\n');
}

function resumo(empresa) {
  const cfg = configDa(empresa);
  return {
    ativo: cfg.ativo === true,
    total: cfg.exemplos.length,
    midiasAprendidas: require('./midias').midiasDa(empresa).filter((m) => m.aprendidaDoClone).length,
    exemplos: cfg.exemplos.slice(-60).reverse()
  };
}

function apagarExemplo(empresa, id) {
  const cfg = configDa(empresa);
  const antes = cfg.exemplos.length;
  cfg.exemplos = cfg.exemplos.filter((e) => e.id !== id);
  salvar();
  return antes !== cfg.exemplos.length;
}

function limpar(empresa) {
  configDa(empresa).exemplos = [];
  salvar();
}

function ligar(empresa, sim) {
  configDa(empresa).ativo = sim === true;
  salvar();
}

module.exports = { aprenderAnexo, ativo, registrar, aprenderArquivo, relevantes, paraIa, resumo, apagarExemplo, limpar, ligar, contextoDoCliente };
