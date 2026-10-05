// lixeira.js — apagar conversa (de vez) e juntar conversas do mesmo cliente.
//
// Apagar uma conversa no painel apaga DE VEZ: mensagens, fotos, áudios, anexos,
// agendamentos e follow-ups dela. Não existe mais lixeira. As vendas continuam no
// Faturamento (o comprovante vai para a pasta de vendas).
// Fica só uma marca "apagada em" por número/id do WhatsApp: a busca de mensagens na
// Evolution nunca traz de volta o que veio ANTES de apagar. Se o cliente mandar
// mensagem depois, começa uma conversa nova, do zero — a IA não lembra de nada.
// O WhatsApp do celular não é mexido.

const { estado, salvar, agora } = require('./db');

const MAX_MARCAS = 20000;

// chaves de um cliente: o jid do WhatsApp, o id escondido (LID) e o número (sem o 9)
function chavesDo(lead) {
  const identidade = require('./identidade');
  const jids = [lead.whatsappJid, lead.lidJid, ...(lead.jidsAlternativos || [])].filter(Boolean);
  const fones = [lead.telefone, ...jids.filter((j) => /@s\.whatsapp\.net$/.test(j))].map((n) => identidade.chaveFone(n)).filter(Boolean);
  return [...new Set([...jids, ...fones.map((f) => `fone:${f}`)])];
}

// Quando a conversa deste endereço (jid, LID ou número) foi apagada — ou null
function apagadaEm(empresa, endereco) {
  const marcas = empresa?.conversasApagadas;
  if (!marcas || !endereco) return null;
  const ch = require('./identidade').chaveFone(endereco);
  return marcas[endereco] || (ch && marcas[`fone:${ch}`]) || null;
}

// Esta mensagem é de antes de a conversa ser apagada? (então não volta para o CRM)
function mensagemApagada(empresa, msg, emMs, ...extras) {
  if (!empresa?.conversasApagadas) return false;
  const k = msg?.key || {};
  for (const end of [k.remoteJid, k.remoteJidAlt, k.senderPn, k.senderLid, k.participantAlt, msg?.senderPn, ...extras].filter(Boolean)) {
    const em = apagadaEm(empresa, String(end));
    if (em && emMs <= new Date(em).getTime()) return true;
  }
  return false;
}

// Apaga a conversa de vez (o que aconteceu antes dela não volta)
function apagarConversa(lead, por = '') {
  const i = estado.conversas.indexOf(lead);
  if (i < 0) return false;
  const empresa = estado.empresas.find((e) => e.id === lead.empresaId);
  require('./whatsapp').cancelarResposta(lead.id);
  estado.conversas.splice(i, 1);
  marcarApagada(empresa, lead, agora(), por);
  preservarComprovantes(lead);
  require('./midias').apagarAnexosDoLead(lead.id); // anexos e foto de perfil
  salvar();
  return true;
}

function marcarApagada(empresa, lead, em, por = '') {
  if (!empresa) return;
  const marcas = (empresa.conversasApagadas = empresa.conversasApagadas || {});
  for (const ch of chavesDo(lead)) marcas[ch] = em;
  const chaves = Object.keys(marcas);
  if (chaves.length > MAX_MARCAS) for (const k of chaves.sort((x, y) => String(marcas[x]).localeCompare(String(marcas[y]))).slice(0, chaves.length - MAX_MARCAS)) delete marcas[k];
  // o aprendizado diário também não relê o que veio antes de apagar
  const apr = empresa.aprendizado;
  if (apr) {
    apr.checkpoints = apr.checkpoints || {};
    for (const j of [lead.whatsappJid, lead.lidJid].filter(Boolean)) {
      apr.checkpoints[j] = Math.floor(new Date(em).getTime() / 1000);
      if (apr.concluidas) delete apr.concluidas[j];
    }
  }
  void por;
}

// Junta a conversa `nova` dentro de `lead` (mensagens, anexos, etiquetas, vendas…)
// e tira a `nova` de Conversas. Usado ao restaurar da lixeira e ao corrigir
// conversas duplicadas do mesmo cliente.
function juntar(lead, nova, { manterEstado = false } = {}) {
  const fs = require('fs');
  const midias = require('./midias');
  // anexos (fotos, áudios…) da conversa nova vão para a pasta da restaurada
  const de = midias.pastaAnexosDoLead(nova.id);
  if (fs.existsSync(de)) {
    const para = midias.pastaAnexosDoLead(lead.id);
    fs.mkdirSync(para, { recursive: true });
    for (const arq of fs.readdirSync(de)) if (arq !== 'perfil.jpg') fs.renameSync(`${de}/${arq}`, `${para}/${arq}`);
    if (fs.existsSync(`${de}/perfil.jpg`)) fs.renameSync(`${de}/perfil.jpg`, `${para}/perfil.jpg`);
    fs.rmSync(de, { recursive: true, force: true });
  }
  // mesma mensagem nas duas (mesmo id do WhatsApp): fica uma só (a que chegou ao vivo)
  const todas = [...(lead.mensagens || []), ...(nova.mensagens || [])].sort((a, b) => (a.importada === b.importada ? 0 : a.importada ? 1 : -1));
  const vistos = new Set();
  lead.mensagens = todas
    .filter((m) => {
      const ids = [m.wid, ...(m.wids || [])].filter(Boolean);
      if (ids.some((i) => vistos.has(i))) return false;
      ids.forEach((i) => vistos.add(i));
      return true;
    })
    .sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : 0));
  lead.agendadas = [...(lead.agendadas || []), ...(nova.agendadas || [])];
  lead.agendamentos = [...(lead.agendamentos || []), ...(nova.agendamentos || [])];
  lead.etiquetas = [...new Set([...(lead.etiquetas || []), ...(nova.etiquetas || [])])];
  lead.naoLidas = (lead.naoLidas || 0) + (nova.naoLidas || 0);
  lead.etapaHistorico = [...(lead.etapaHistorico || []), ...(nova.etapaHistorico || [])];
  lead.nome = lead.nome || nova.nome;
  // dados do cliente que só a outra conversa tinha
  if (!lead.telefone && nova.telefone) lead.telefone = nova.telefone;
  const lidDe = (c) => c.lidJid || (/@lid$/.test(c.whatsappJid || '') ? c.whatsappJid : '');
  if (!lead.lidJid && lidDe(nova)) lead.lidJid = lidDe(nova);
  if (/@lid$/.test(lead.whatsappJid || '') && /@s\.whatsapp\.net$/.test(nova.whatsappJid || '')) lead.whatsappJid = nova.whatsappJid;
  if (nova.anotacoes && nova.anotacoes !== lead.anotacoes) lead.anotacoes = [lead.anotacoes, nova.anotacoes].filter(Boolean).join('\n');
  for (const k of ['origemSite', 'rastro', 'anuncioId', 'origemManual', 'email', 'codigo', 'localizacao']) if (lead[k] == null && nova[k] != null) lead[k] = nova[k];
  if (nova.listaNegra) lead.listaNegra = true;
  if (nova.naoDisparar) lead.naoDisparar = true;
  if (!manterEstado) {
    // restaurar da lixeira: a situação atual é a da conversa nova
    lead.etapa = nova.etapa || lead.etapa;
    if (nova.fotoPerfil) lead.fotoPerfil = nova.fotoPerfil;
    lead.iaPausada = nova.iaPausada;
    lead.iaPausadaMotivo = nova.iaPausadaMotivo;
    lead.arquivado = nova.arquivado;
  }
  lead.atualizadoEm = nova.atualizadoEm > lead.atualizadoEm ? nova.atualizadoEm : lead.atualizadoEm;
  for (const v of estado.vendas || []) {
    if (v.leadId === nova.id) v.leadId = lead.id;
    if (v.anexo?.leadId === nova.id) v.anexo = { ...v.anexo, leadId: lead.id };
  }
  require('./whatsapp').cancelarResposta(nova.id);
  estado.conversas.splice(estado.conversas.indexOf(nova), 1);
  return nova;
}

// Comprovantes de venda que vieram na conversa: antes de apagar os anexos, vão
// para a pasta de vendas da empresa (a venda continua no Faturamento com o comprovante)
function preservarComprovantes(lead) {
  const fs = require('fs');
  const midias = require('./midias');
  for (const v of estado.vendas || []) {
    if (v.anexo?.leadId !== lead.id) continue;
    const de = midias.caminhoAnexo(lead.id, v.anexo.arquivo);
    const pasta = midias.pastaAnexosDoLead(`vendas-${v.empresaId}`);
    try {
      if (de && fs.existsSync(de)) {
        fs.mkdirSync(pasta, { recursive: true });
        fs.copyFileSync(de, `${pasta}/${v.anexo.arquivo}`);
      }
      v.anexo = { ...v.anexo, leadId: null };
    } catch (err) {
      console.error('[lixeira] comprovante da venda', v.id, err.message);
    }
  }
}

// Conversas que ficaram na lixeira antiga: apagadas de vez (com a marca de quando foram apagadas)
function migrarLixeiraAntiga() {
  const antigas = Array.isArray(estado.lixeira) ? estado.lixeira : [];
  if (!antigas.length) {
    if (estado.lixeira) delete estado.lixeira;
    return 0;
  }
  for (const lead of antigas) {
    const empresa = estado.empresas.find((e) => e.id === lead.empresaId);
    marcarApagada(empresa, lead, lead.naLixeira?.em || agora());
    preservarComprovantes(lead);
    require('./midias').apagarAnexosDoLead(lead.id);
  }
  delete estado.lixeira;
  salvar();
  console.log(`[conversas] ${antigas.length} conversa(s) da lixeira antiga apagada(s) de vez`);
  return antigas.length;
}

// Empresa excluída: limpa as marcas dela (as conversas já saíram junto)
function esvaziar(empresaId) {
  const e = estado.empresas.find((x) => x.id === empresaId);
  if (e) delete e.conversasApagadas;
  return 0;
}

function iniciar() {
  setTimeout(migrarLixeiraAntiga, 15000).unref?.();
}

module.exports = { juntar, chavesDo, apagadaEm, mensagemApagada, apagarConversa, migrarLixeiraAntiga, esvaziar, iniciar };
