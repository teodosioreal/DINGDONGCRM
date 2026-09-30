// lixeira.js — conversas apagadas pelo painel vão para a Lixeira.
//
// A conversa sai de estado.conversas e vai para estado.lixeira: some das
// Conversas, do funil, das automações, dos disparos e da IA. Fica 30 dias
// podendo ser restaurada; depois é apagada de vez (com fotos, áudios e anexos).
// As vendas do cliente continuam no Faturamento.
// O WhatsApp do celular não é mexido (a Evolution não apaga conversa do celular).
// Se o cliente mandar mensagem de novo, começa uma conversa nova — como no WhatsApp.

const { estado, salvar, agora } = require('./db');

const DIAS = 30;

function itens() {
  estado.lixeira = Array.isArray(estado.lixeira) ? estado.lixeira : [];
  return estado.lixeira;
}

function moverParaLixeira(lead, por = '') {
  const i = estado.conversas.indexOf(lead);
  if (i < 0) return false;
  require('./whatsapp').cancelarResposta(lead.id);
  // mensagens agendadas (follow-ups) não saem mais — nem se restaurar depois
  for (const a of lead.agendadas || []) {
    if (a.status === 'pendente') {
      a.status = 'cancelada';
      a.motivo = 'conversa apagada';
    }
  }
  estado.conversas.splice(i, 1);
  lead.naLixeira = { em: agora(), por };
  itens().unshift(lead);
  salvar();
  return true;
}

function acharNaLixeira(id) {
  return itens().find((c) => c.id === id) || null;
}

// O cliente escreveu de novo enquanto a conversa estava na lixeira (nasceu uma
// conversa nova com o mesmo número): ao restaurar, as duas viram uma só.
function juntarConversaNova(lead) {
  if (!lead.whatsappJid) return null;
  const nova = estado.conversas.find((c) => c.empresaId === lead.empresaId && c.whatsappJid === lead.whatsappJid && c.id !== lead.id);
  if (!nova) return null;
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
  lead.mensagens = [...(lead.mensagens || []), ...(nova.mensagens || [])].sort((a, b) => (a.em < b.em ? -1 : 1));
  lead.agendadas = [...(lead.agendadas || []), ...(nova.agendadas || [])];
  lead.agendamentos = [...(lead.agendamentos || []), ...(nova.agendamentos || [])];
  lead.etiquetas = [...new Set([...(lead.etiquetas || []), ...(nova.etiquetas || [])])];
  lead.naoLidas = (lead.naoLidas || 0) + (nova.naoLidas || 0);
  lead.etapa = nova.etapa || lead.etapa; // a situação atual é a da conversa nova
  lead.etapaHistorico = [...(lead.etapaHistorico || []), ...(nova.etapaHistorico || [])];
  lead.nome = lead.nome || nova.nome;
  if (nova.fotoPerfil) lead.fotoPerfil = nova.fotoPerfil;
  lead.iaPausada = nova.iaPausada;
  lead.iaPausadaMotivo = nova.iaPausadaMotivo;
  lead.arquivado = nova.arquivado;
  lead.atualizadoEm = nova.atualizadoEm > lead.atualizadoEm ? nova.atualizadoEm : lead.atualizadoEm;
  for (const v of estado.vendas || []) {
    if (v.leadId === nova.id) v.leadId = lead.id;
    if (v.anexo?.leadId === nova.id) v.anexo = { ...v.anexo, leadId: lead.id };
  }
  require('./whatsapp').cancelarResposta(nova.id);
  estado.conversas.splice(estado.conversas.indexOf(nova), 1);
  return nova;
}

function restaurar(lead) {
  const i = itens().indexOf(lead);
  if (i < 0) return false;
  itens().splice(i, 1);
  delete lead.naLixeira;
  const juntou = juntarConversaNova(lead);
  estado.conversas.push(lead);
  salvar();
  return { juntou: Boolean(juntou) };
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

function apagarDeVez(lead) {
  const i = itens().indexOf(lead);
  if (i < 0) return false;
  itens().splice(i, 1);
  preservarComprovantes(lead);
  require('./midias').apagarAnexosDoLead(lead.id); // anexos e foto de perfil
  salvar();
  return true;
}

function daEmpresa(empresaId) {
  return itens().filter((c) => c.empresaId === empresaId);
}

function esvaziar(empresaId) {
  const lista = daEmpresa(empresaId);
  for (const c of lista) {
    preservarComprovantes(c);
    require('./midias').apagarAnexosDoLead(c.id);
  }
  estado.lixeira = itens().filter((c) => c.empresaId !== empresaId);
  salvar();
  return lista.length;
}

function diasRestantes(lead) {
  const passou = (Date.now() - new Date(lead.naLixeira?.em || Date.now()).getTime()) / 86400000;
  return Math.max(0, Math.ceil(DIAS - passou));
}

// Apaga de vez o que está na lixeira há mais de 30 dias
function limparVencidos() {
  const vencidos = itens().filter((c) => diasRestantes(c) <= 0);
  for (const c of vencidos) apagarDeVez(c);
  return vencidos.length;
}

let timer = null;
function iniciar() {
  if (timer) return;
  setTimeout(limparVencidos, 30000).unref?.();
  timer = setInterval(limparVencidos, 12 * 3600 * 1000);
  timer.unref?.();
}

module.exports = { moverParaLixeira, acharNaLixeira, restaurar, apagarDeVez, daEmpresa, esvaziar, diasRestantes, limparVencidos, iniciar, DIAS };
