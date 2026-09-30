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

function restaurar(lead) {
  const i = itens().indexOf(lead);
  if (i < 0) return false;
  itens().splice(i, 1);
  delete lead.naLixeira;
  estado.conversas.push(lead);
  salvar();
  return true;
}

function apagarDeVez(lead) {
  const i = itens().indexOf(lead);
  if (i < 0) return false;
  itens().splice(i, 1);
  require('./midias').apagarAnexosDoLead(lead.id); // anexos e foto de perfil
  salvar();
  return true;
}

function daEmpresa(empresaId) {
  return itens().filter((c) => c.empresaId === empresaId);
}

function esvaziar(empresaId) {
  const lista = daEmpresa(empresaId);
  for (const c of lista) require('./midias').apagarAnexosDoLead(c.id);
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
