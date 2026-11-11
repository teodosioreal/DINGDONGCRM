// mensagens-agendamento.js — botão "📅 Puxar agendamento" da conversa.
//
// Mensagens prontas que a equipe manda com um clique para levar o cliente a marcar
// (perguntar o dia, oferecer horários, pedir o endereço, confirmar, retomar…).
// Cada empresa tem a sua lista (empresa.mensagensAgendamento); enquanto ela não
// salvar nenhuma, aparecem as sugestões abaixo, que dá para editar.
// No texto dá para usar {nome} (primeiro nome do cliente), {saudacao} (bom dia /
// boa tarde / boa noite) e {empresa} — o painel troca antes de mandar.

const MAX = 30;

const SUGESTOES = [
  { id: 'ag-dia', titulo: 'Perguntar o melhor dia', texto: '{saudacao}, {nome}! Vamos deixar agendado?\nQual o melhor dia e horário pra você?' },
  { id: 'ag-horarios', titulo: 'Oferecer horários', texto: 'Tenho horário amanhã de manhã ou à tarde.\nQual fica melhor pra você?' },
  { id: 'ag-endereco', titulo: 'Pedir o endereço', texto: 'Perfeito!\nMe passa o endereço completo (rua, número e bairro), por favor?' },
  { id: 'ag-confirmar', titulo: 'Confirmar o agendamento', texto: 'Agendado, {nome}!\nQualquer imprevisto é só me avisar por aqui.' },
  { id: 'ag-retomar', titulo: 'Retomar quem sumiu', texto: '{saudacao}, {nome}! Ainda quer agendar?\nConsigo te encaixar essa semana.' }
];

const limpar = (t, max) => String(t ?? '').replace(/\r/g, '').trim().slice(0, max);

// A lista da empresa (ou as sugestões, se ela ainda não salvou nenhuma)
function daEmpresa(empresa) {
  return Array.isArray(empresa?.mensagensAgendamento) ? empresa.mensagensAgendamento : SUGESTOES.map((x) => ({ ...x, midia: '' }));
}

// O que veio do painel → lista guardada. `resolverMidia(pedido)` devolve o código da mídia (ou '').
function normalizar(lista, resolverMidia, novoId) {
  return (Array.isArray(lista) ? lista : [])
    .map((x) => ({
      id: limpar(x?.id, 40) || novoId('ag'),
      titulo: limpar(x?.titulo, 60),
      texto: limpar(x?.texto, 2000),
      midia: x?.midia ? resolverMidia(limpar(x.midia, 120)) : ''
    }))
    .filter((x) => x.texto || x.midia)
    .map((x) => ({ ...x, titulo: x.titulo || x.texto.split('\n')[0].slice(0, 40) || 'Mensagem' }))
    .slice(0, MAX);
}

module.exports = { SUGESTOES, daEmpresa, normalizar, MAX };
