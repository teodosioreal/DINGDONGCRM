// agenda-modo.js — tipo de atendimento dos agendamentos da empresa (aba Agendamentos):
//   presencial: visita, instalação, loja, consultório (pede endereço se a regra estiver ligada)
//   online: videochamada, ligação, reunião, entrega digital (nunca pede endereço; manda o link)
//   ambos: a IA pergunta/entende qual é e marca cada agendamento com o tipo dele
// Cada agendamento guarda modo ('presencial' | 'online') e, se online, o link da reunião.

const MODOS = ['presencial', 'online', 'ambos'];

function modoDa(empresa) {
  return MODOS.includes(empresa?.agendaModo) ? empresa.agendaModo : 'presencial';
}

function linkDa(empresa) {
  return String(empresa?.agendaLink || '').trim();
}

// "reunião online", "chamada de vídeo", "pelo Meet", "ligação"… = online
const ONLINE = /\b(online|on-line|remot[oa]|v[ií]deo ?chamada|chamada de v[ií]deo|videoconfer[eê]ncia|google meet|meet|zoom|teams|liga[çc][aã]o|me liga|telefonema|call|reuni[aã]o virtual|pelo whats(app)?|digital)\b/i;
const pareceOnline = (t) => ONLINE.test(String(t || ''));

// o tipo de UM agendamento: o que veio escrito (IA/equipe), senão pelo tipo da empresa e pelo texto
function modoDoAgendamento(empresa, { modo, descricao } = {}) {
  const daEmpresa = modoDa(empresa);
  if (daEmpresa !== 'ambos') return daEmpresa;
  if (modo === 'online' || modo === 'presencial') return modo;
  if (/^\s*(online|v[ií]deo|liga[çc][aã]o|remoto|digital)/i.test(String(modo || ''))) return 'online';
  return pareceOnline(descricao) ? 'online' : 'presencial';
}

// link http(s) válido (ou vazio)
function limparLink(v) {
  const t = String(v || '').trim().slice(0, 300);
  return /^https?:\/\/\S+$/i.test(t) ? t : '';
}

module.exports = { MODOS, modoDa, linkDa, pareceOnline, modoDoAgendamento, limparLink };
