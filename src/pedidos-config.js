// pedidos-config.js — configurações que o dono pediu para deixar prontas na empresa dele.
// Cada pedido roda UMA vez (fica anotado em estado.config.pedidosAplicados) quando o CRM
// sobe; nada é apagado: o que muda guarda antes uma cópia do que existia.
const { estado, salvar, agora } = require('./db');

const PEDIDOS = [
  // 17/10: follow-up da Madara Volantes puxando agendamento (pedido do dono no chat)
  { id: 'fup-modelo-agenda-2026-10-17', empresaId: 'emp_2bb32fe7c84e097b', fazer: (e) => require('./followup').aplicarModeloAgendar(e) },
  // 18/10: na Madara o prompt ainda mandava a mídia antiga do aro (#MIDIA_22 "aro 206", desativada);
  // a atual é a #MIDIA_54 — o prompt passa a citar a nova (pedido do dono no chat)
  { id: 'prompt-troca-midia-22-54-2026-10-18', empresaId: 'emp_2bb32fe7c84e097b', fazer: (e) => trocarCodigoNoPrompt(e, 22, 54) },
  // 18/10 (todas as empresas): revezamento com uma das mídias "a configurar" passa a funcionar —
  // ela fica ativa com as informações da outra (a que você desligou de propósito continua desligada)
  { id: 'revezamento-pronto-2026-10-18', empresaId: '*', fazer: (e) => require('./midias').ajustarRevezamentos(e) || null }
];

// Troca, nas instruções do WhatsApp da empresa, o código de uma mídia antiga pelo da nova. Só se a
// antiga não está ativa e a nova está. Guarda o prompt de antes no próprio assistente.
function trocarCodigoNoPrompt(empresa, numeroVelho, numeroNovo) {
  const midias = require('./midias');
  const todas = midias.midiasDa(empresa);
  const velha = todas.find((m) => m.numero === numeroVelho);
  const nova = todas.find((m) => m.numero === numeroNovo);
  if (!nova || !midias.prontaParaIa(nova) || (velha && midias.prontaParaIa(velha))) return null;
  const re = new RegExp(`#MIDIA_${numeroVelho}(?![0-9A-Z_])`, 'g');
  let trocas = 0;
  for (const bot of estado.bots.filter((b) => b.empresaId === empresa.id)) {
    const antes = String(bot.promptWhatsapp || '');
    const depois = antes.replace(re, () => { trocas++; return `#MIDIA_${numeroNovo}`; });
    if (depois === antes) continue;
    bot.promptWhatsappAntesDeTrocar = { em: agora(), texto: antes };
    bot.promptWhatsapp = depois;
  }
  if (trocas) salvar();
  console.log(`[pedidos-config] prompt: #MIDIA_${numeroVelho} → #MIDIA_${numeroNovo} em ${trocas} lugar(es)`);
  return trocas ? { trocas } : null;
}

function aplicar() {
  estado.config = estado.config || {};
  const feitos = (estado.config.pedidosAplicados = estado.config.pedidosAplicados || {});
  for (const p of PEDIDOS) {
    if (feitos[p.id]) continue;
    // '*': em todas as empresas
    const empresas = p.empresaId === '*' ? estado.empresas : estado.empresas.filter((e) => e.id === p.empresaId);
    if (!empresas.length) continue;
    try {
      let ok = false;
      for (const empresa of empresas) if (p.fazer(empresa)) ok = true;
      feitos[p.id] = { em: agora(), ok };
      salvar();
      console.log(`[pedidos-config] ${p.id}: ${ok ? 'aplicado' : 'nada para mudar'}`);
    } catch (err) {
      console.error(`[pedidos-config] ${p.id}:`, err.message);
    }
  }
}

module.exports = { aplicar, PEDIDOS, trocarCodigoNoPrompt };
