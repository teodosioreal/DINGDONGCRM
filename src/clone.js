// clone.js — o CLONE: a IA aprende com as respostas MANUAIS que deram VENDA e
// passa a responder (e mandar mídia) igual a quem respondeu.
//
// - Lê direto das conversas que viraram venda (venda confirmada ou etapa de
//   fechado): cada resposta escrita à mão (painel, celular, resposta rápida,
//   mídia da biblioteca, arquivo) vira um EXEMPLO "o cliente disse → você respondeu".
//   Nada é copiado à parte e nada gasta IA: é só leitura das conversas.
// - Com 10 conversas vendidas o aprendizado fica COMPLETO e, com "Responder igual
//   ao operador" ligado, a IA segue 100% a linha de quem respondeu.
// - Arquivos mandados à mão entram na biblioteca como mídia "aprendida do clone"
//   (sem duplicar), para a IA mandar a mesma coisa na mesma situação.
// - Na hora de responder, os exemplos mais parecidos com o que o cliente acabou de
//   dizer são escolhidos por CÓDIGO (sem IA) e vão para a IA imitar.
// - Dá para nomear o clone, ligar/desligar, baixar o arquivo e tirar exemplos ruins.

const crypto = require('crypto');
const { estado, salvar } = require('./db');

const META = 10; // conversas vendidas para o aprendizado ficar completo
const NO_PROMPT = 8; // exemplos por resposta (economiza tokens)
const NO_PROMPT_COMPLETO = 12;
const JANELA_MS = 3 * 60 * 1000; // mensagens seguidas suas = uma resposta só

function configDa(empresa) {
  const c = (empresa.clone = empresa.clone || {});
  if (c.ativo === undefined) c.ativo = false;
  if (c.responder === undefined) c.responder = c.ativo === true; // quem já usava o modo clone continua respondendo
  if (!Array.isArray(c.ignorados)) c.ignorados = [];
  delete c.exemplos; // formato antigo (cópia de toda resposta): agora vem das conversas vendidas
  return c;
}

const ativo = (empresa) => configDa(empresa).ativo === true;
const nomeDo = (empresa) => configDa(empresa).nome || 'o dono';

const PARADAS = new Set('a o os as um uma de da do das dos e é eu voce vc vcs que pra para por com sem no na nos nas em me te se ja já mais muito tem ter tá ta to tô sim nao não ok oi ola olá bom boa dia tarde noite tudo bem obrigado obrigada'.split(' '));
const palavras = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && !PARADAS.has(p))
    .map((p) => p.replace(/(s|es|inho|inha)$/, ''));

// Mensagem escrita à mão pela equipe (não conta disparo, automação nem aviso do sistema)
const ehManual = (m) => m.papel === 'equipe' && !m.apagada && !m.disparoId && !m.automacaoId && !m.agendadaId && (m.texto || m.midiaCodigo || m.anexo);

// Exemplos de UMA conversa: blocos de respostas manuais + o que o cliente tinha dito antes
function exemplosDaConversa(lead) {
  const msgs = (lead.mensagens || []).filter((m) => !m.apagada);
  const saida = [];
  let atual = null;
  let doCliente = [];
  for (const m of msgs) {
    if (m.papel === 'visitante') {
      if (atual) {
        saida.push(atual);
        atual = null;
        doCliente = [];
      }
      if (m.texto) doCliente.push(m.texto);
      continue;
    }
    if (!ehManual(m)) {
      if (atual) {
        saida.push(atual);
        atual = null;
      }
      continue;
    }
    const texto = /^\[(enviou|o cliente)/i.test(m.texto || '') ? '' : String(m.texto || '').trim();
    const midia = m.midiaCodigo || m.anexo?.midiaCodigo || '';
    if (atual && new Date(m.em) - new Date(atual.ultimaEm) < JANELA_MS) {
      if (texto) atual.resposta = [atual.resposta, texto].filter(Boolean).join('\n').slice(0, 1200);
      if (midia && !atual.midias.includes(midia)) atual.midias.push(midia);
      atual.ultimaEm = m.em;
    } else {
      if (atual) saida.push(atual);
      atual = { id: m.id, leadId: lead.id, cliente: doCliente.slice(-3).join(' / ').slice(0, 500) || '(você puxou a conversa)', resposta: texto.slice(0, 1200), midias: midia ? [midia] : [], etapa: lead.etapa || '', em: m.em, ultimaEm: m.em };
    }
  }
  if (atual) saida.push(atual);
  return saida.filter((e) => e.resposta || e.midias.length);
}

// Todos os exemplos (só conversas que deram venda), com cache curto
const cache = new Map();
function exemplos(empresa) {
  const marca = `${estado.conversas.length}|${(estado.vendas || []).length}|${estado.conversas.reduce((n, c) => (c.empresaId === empresa.id ? n + (c.mensagens?.length || 0) : n), 0)}|${configDa(empresa).ignorados.length}`;
  const c = cache.get(empresa.id);
  if (c && c.marca === marca && Date.now() - c.em < 60 * 1000) return c.dados;
  const { vendaConcluida } = require('./aprendizado');
  const ignorados = new Set(configDa(empresa).ignorados);
  const conversas = [];
  const lista = [];
  for (const lead of estado.conversas.filter((x) => x.empresaId === empresa.id && vendaConcluida(empresa, x))) {
    const ex = exemplosDaConversa(lead).filter((e) => !ignorados.has(e.id));
    if (!ex.length) continue;
    conversas.push(lead.id);
    lista.push(...ex);
  }
  lista.sort((a, b) => (a.em < b.em ? -1 : 1));
  const dados = { lista, conversas };
  cache.set(empresa.id, { marca, em: Date.now(), dados });
  return dados;
}

function progresso(empresa) {
  const { lista, conversas } = exemplos(empresa);
  return { conversas: conversas.length, meta: META, completo: conversas.length >= META, total: lista.length };
}

// Mensagens antigas (formato de antes): não fazem nada — os exemplos vêm das conversas vendidas
function registrar() {
  return null;
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

// Arquivo que você mandou na conversa → guarda na biblioteca e marca no anexo (vira exemplo se a conversa vender)
function aprenderAnexo(empresa, lead, anexo) {
  if (!ativo(empresa) || !anexo?.arquivo || !['image', 'video', 'document'].includes(anexo.tipo)) return null;
  const caminho = require('./midias').caminhoAnexo(lead.id, anexo.arquivo);
  try {
    const codigo = caminho ? aprenderArquivo(empresa, lead, { buffer: require('fs').readFileSync(caminho), nome: anexo.nome || anexo.arquivo, mimetype: anexo.mimetype }) : null;
    if (codigo) {
      anexo.midiaCodigo = codigo;
      salvar();
    }
    return codigo;
  } catch {
    return null; // arquivo sumiu
  }
}

// O que o cliente disse e que a equipe está respondendo agora
function contextoDoCliente(lead) {
  const msgs = (lead.mensagens || []).filter((m) => !m.apagada);
  const doCliente = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.papel === 'visitante') doCliente.unshift(m.texto || '');
    else if (doCliente.length) break;
  }
  return doCliente.slice(-3).join(' / ').slice(0, 500);
}

// Os exemplos mais parecidos com o que o cliente acabou de dizer (sem IA)
function relevantes(empresa, lead, quantos = NO_PROMPT) {
  const { lista } = exemplos(empresa);
  if (!lista.length) return [];
  const agoraCliente = new Set(palavras(contextoDoCliente(lead) || (lead.mensagens || []).slice(-3).map((m) => m.texto).join(' ')));
  const pontuados = lista
    .filter((ex) => ex.leadId !== lead.id) // não usa a própria conversa como modelo
    .map((ex, i) => {
      const pal = new Set(palavras(ex.cliente));
      let comum = 0;
      for (const p of pal) if (agoraCliente.has(p)) comum++;
      const sim = comum / Math.max(1, Math.sqrt(agoraCliente.size * pal.size || 1));
      return { ex, nota: sim + (ex.etapa && ex.etapa === lead.etapa ? 0.05 : 0) + (i / lista.length) * 0.02 };
    });
  const parecidos = pontuados.filter((p) => p.nota > 0.08).sort((a, b) => b.nota - a.nota).slice(0, quantos - 3).map((p) => p.ex);
  const escolhidos = [...parecidos];
  for (const r of pontuados.map((p) => p.ex).reverse()) if (escolhidos.length < quantos && !escolhidos.includes(r)) escolhidos.push(r);
  return escolhidos;
}

// Para o prompt da IA: { texto, nome, completo } (vazio se não for para responder igual)
function paraIa(empresa, lead) {
  const cfg = configDa(empresa);
  if (!cfg.ativo || !cfg.responder) return '';
  const p = progresso(empresa);
  const lista = relevantes(empresa, lead, p.completo ? NO_PROMPT_COMPLETO : NO_PROMPT);
  if (!lista.length) return '';
  const codigosValidos = new Set(require('./midias').paraIa(empresa).map((m) => m.codigo));
  const nome = nomeDo(empresa);
  const texto = lista
    .map((ex, i) => {
      const midias = (ex.midias || []).filter((c) => codigosValidos.has(c));
      return `Exemplo ${i + 1} (conversa que virou venda)\nCliente: ${ex.cliente}\n${nome} respondeu: ${ex.resposta || '(só mandou mídia)'}${midias.length ? `\nE mandou: ${midias.map((c) => `[[MIDIA: ${c}]]`).join(' ')}` : ''}`;
    })
    .join('\n\n');
  return { texto, nome, completo: p.completo };
}

// Arquivo para baixar: tudo o que o clone aprendeu
function arquivo(empresa) {
  const cfg = configDa(empresa);
  const p = progresso(empresa);
  const { lista } = exemplos(empresa);
  const linhas = [
    `CLONE: ${cfg.nome || '(sem nome)'}`,
    `Aprendizado: ${Math.min(p.conversas, META)}/${META} conversas que viraram venda${p.completo ? ' — COMPLETO' : ''} · ${p.total} respostas manuais`,
    `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
    ''
  ];
  for (const ex of lista) {
    linhas.push(`— ${new Date(ex.em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${ex.etapa ? ` · etapa ${ex.etapa}` : ''}`);
    linhas.push(`Cliente: ${ex.cliente}`);
    linhas.push(`${cfg.nome || 'Operador'}: ${ex.resposta || '(só mandou mídia)'}${ex.midias.length ? `\n[mídias: ${ex.midias.map((c) => `#${c}`).join(', ')}]` : ''}`);
    linhas.push('');
  }
  return linhas.join('\n');
}

function resumo(empresa) {
  const cfg = configDa(empresa);
  const p = progresso(empresa);
  return {
    ativo: cfg.ativo === true,
    responder: cfg.responder === true,
    nome: cfg.nome || '',
    ...p,
    midiasAprendidas: require('./midias').midiasDa(empresa).filter((m) => m.aprendidaDoClone).length,
    exemplos: exemplos(empresa).lista.slice(-60).reverse()
  };
}

function apagarExemplo(empresa, id) {
  const cfg = configDa(empresa);
  if (!cfg.ignorados.includes(id)) cfg.ignorados.push(id);
  salvar();
  return true;
}

function limpar(empresa) {
  // "recomeçar": ignora o que já existe; aprende só com as próximas vendas
  const cfg = configDa(empresa);
  cfg.ignorados = [...new Set([...cfg.ignorados, ...exemplos(empresa).lista.map((e) => e.id)])];
  salvar();
}

function configurar(empresa, b = {}) {
  const cfg = configDa(empresa);
  if (b.ativo !== undefined) cfg.ativo = b.ativo === true;
  if (b.responder !== undefined) cfg.responder = b.responder === true;
  if (b.nome !== undefined) cfg.nome = String(b.nome || '').trim().slice(0, 40);
  salvar();
}
const ligar = (empresa, sim) => configurar(empresa, { ativo: sim });

module.exports = { aprenderAnexo, ativo, registrar, aprenderArquivo, relevantes, paraIa, resumo, apagarExemplo, limpar, ligar, configurar, contextoDoCliente, arquivo, progresso, META };
