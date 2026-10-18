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
  { id: 'revezamento-pronto-2026-10-18', empresaId: '*', fazer: (e) => require('./midias').ajustarRevezamentos(e) || null },
  // 18/10: o dono quer o follow-up antigo (com vídeos) de volta, para ligar/desligar quando quiser
  { id: 'fup-antigo-de-volta-2026-10-18', empresaId: 'emp_2bb32fe7c84e097b', fazer: (e) => require('./followup').restaurarFollowupAntigo(e) },
  // 18/10 (todas): mídias escolhidas no follow-up/automações que estavam "a configurar" voltam a sair
  // por lá (com a regra nova, "a configurar" não sairia mais) — viram "só no follow-up" se não têm descrição
  { id: 'midias-do-fup-prontas-2026-10-18', empresaId: '*', fazer: (e) => require('./followup').prepararMidiasEscolhidas(e) || null },
  // 18/10 (todas): o dono pediu para tirar as etiquetas antigas que vieram do WhatsApp e deixar só as
  // criadas no CRM (cópia em empresa.etiquetasApagadas; quem tinha etiqueta de venda segue "já comprou")
  { id: 'tirar-etiquetas-do-zap-2026-10-18', empresaId: '*', fazer: (e) => tirarEtiquetasDoZap(e) }
];

function tirarEtiquetasDoZap(empresa) {
  const leads = require('./leads');
  const ids = leads.etiquetasDa(empresa).filter((t) => t.zapId).map((t) => t.id);
  const r = ids.length ? leads.apagarEtiquetas(empresa, ids, { motivo: 'importadas do WhatsApp' }) : null;
  if (r) console.log(`[pedidos-config] ${empresa.id}: ${r.etiquetas.length} etiqueta(s) do WhatsApp tirada(s) de ${Object.keys(r.marcados).length} cliente(s)${r.desligadas.length ? ` · desligado: ${r.desligadas.join(', ')}` : ''}`);
  return r;
}

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
