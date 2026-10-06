// ia-desligada.js — cliente que já comprou (e, por padrão, quem agendou) não gasta IA.
//
// A IA fica DESLIGADA nessa conversa (aparece como pausada no chat) e não volta sozinha:
// só quando você liga de novo à mão. Também não recebe follow-up (nem o de pós-venda) nem
// automações — só os pedidos de avaliação no Google e de comentário no anúncio continuam.
// Agendou: desligada por padrão; dá para deixar a IA atender quem agendou em IA do WhatsApp.
// Comprou de novo DEPOIS de você ligar à mão: desliga de novo.

const { salvar, agora } = require('./db');

// automações que continuam para quem comprou/agendou
const RECEITAS_LIBERADAS = new Set(['avaliacao', 'comentario']);

const iaComAgendados = (empresa) => empresa?.iaComAgendados === true;
// ramos em que o cliente compra de novo sempre (loja, restaurante, salão…): a IA segue com quem já comprou
const iaComCompradores = (empresa) => empresa?.iaComCompradores === true;

// { por: 'venda' | 'agenda', texto } ou null
function motivo(empresa, lead) {
  if (!empresa || !lead) return null;
  if (require('./entre-empresas').leadDeOutraEmpresa(empresa, lead)) return { por: 'empresa', texto: 'Este número é de outra empresa do CRM: a IA não conversa com ele.' };
  const manual = lead.iaLigadaManualEm || '';
  const venda = !iaComCompradores(empresa) && require('./comprovantes').jaVendeu(empresa, lead);
  if (venda && (!manual || (venda.em && String(venda.em) > manual))) return { por: 'venda', texto: `Cliente já comprou (${venda.por}): IA desligada. Ligue de novo se quiser.` };
  if (!manual && !iaComAgendados(empresa) && require('./followup').jaAgendou(empresa, lead)) return { por: 'agenda', texto: 'Cliente agendou: IA desligada. Ligue de novo se quiser.' };
  return null;
}

// Confere e, se for o caso, desliga a IA nesta conversa (fica salvo). Devolve o motivo ou null.
function conferir(empresa, lead) {
  const m = motivo(empresa, lead);
  if (!m) return null;
  if (!lead.iaPausada || lead.iaDesligadaPor !== m.por) {
    lead.iaPausada = true;
    lead.iaPausadaMotivo = m.texto;
    lead.iaDesligadaPor = m.por;
    lead.iaDesligadaEm = agora();
    require('./whatsapp').cancelarResposta(lead.id);
    // follow-ups que a IA tinha combinado com o cliente não saem
    for (const a of lead.agendadas || []) {
      if (a.status === 'pendente' && (a.modo === 'ia' || a.criadoPor === 'IA')) {
        a.status = 'cancelada';
        a.motivo = m.por === 'venda' ? 'o cliente já comprou' : 'o cliente agendou';
      }
    }
    salvar();
  }
  return m;
}

// Você ligou a IA à mão nesta conversa: vale até uma venda nova
function ligadaAMao(lead) {
  lead.iaLigadaManualEm = agora();
  delete lead.iaDesligadaPor;
  delete lead.iaDesligadaEm;
}

// Ao ligar o servidor e a cada 10 min: desliga nas conversas de quem comprou/agendou
// (assim o chat já mostra "IA desligada" antes de o cliente escrever)
function varrer() {
  const { estado } = require('./db');
  let n = 0;
  for (const empresa of estado.empresas || []) {
    try { require('./tickets').finalizarPassados(empresa); } catch (err) { console.error('[agenda] passados:', err.message); }
    for (const lead of estado.conversas) {
      if (lead.empresaId !== empresa.id || lead.iaDesligadaPor === 'venda') continue;
      const antes = lead.iaPausada;
      const antesPor = lead.iaDesligadaPor;
      if (conferir(empresa, lead) && (!antes || antesPor !== lead.iaDesligadaPor)) n++;
    }
  }
  if (n) console.log(`[ia-desligada] IA desligada em ${n} conversa(s) de quem comprou/agendou`);
  return n;
}

function iniciar() {
  setTimeout(() => { try { varrer(); } catch (err) { console.error('[ia-desligada]', err.message); } }, 20 * 1000).unref?.();
  setInterval(() => { try { varrer(); } catch (err) { console.error('[ia-desligada]', err.message); } }, 10 * 60 * 1000).unref?.();
}

module.exports = { motivo, conferir, ligadaAMao, varrer, iniciar, RECEITAS_LIBERADAS, iaComAgendados, iaComCompradores };
