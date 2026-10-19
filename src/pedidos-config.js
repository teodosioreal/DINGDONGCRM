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
  { id: 'tirar-etiquetas-do-zap-2026-10-18', empresaId: '*', fazer: (e) => tirarEtiquetasDoZap(e) },
  // 19/10: na Madara combinaram o DIA sem a hora exata e o CRM não lançou (só lançava com hora).
  // Agora lança como "horário a combinar": relê com a IA as conversas das últimas 24 h que ficaram
  { id: 'reler-agenda-sem-hora-2026-10-19', empresaId: 'emp_2bb32fe7c84e097b', fazer: (e) => relerAgendaSemHora(e) }
];

function relerAgendaSemHora(empresa) {
  const det = require('./detector-agenda');
  const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const DIA = /\b(hoje|amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana que vem|\d{1,2}\/\d{1,2}|dia \d{1,2})\b/;
  const CONFIRMA = /\b(pode ser|pode sim|fechado|fechou|combinado|confirmad\w*|confirmo|agendad\w*|marcad\w*|beleza|blz|perfeito|ta bom|certo|ok|sim)\b/;
  const limite = Date.now() - 24 * 3600e3;
  const lista = estado.conversas
    .filter((c) => c.empresaId === empresa.id && !(c.agendamentos || []).some((a) => a.status === 'agendado'))
    .filter((c) => (c.mensagens || []).some((m) => new Date(m.em || 0).getTime() > limite))
    .filter((c) => { const t = sem((c.mensagens || []).filter((m) => m.texto).slice(-8).map((m) => m.texto).join(' ')); return DIA.test(t) && CONFIRMA.test(t); })
    .slice(-10);
  lista.forEach((c, i) => {
    delete c.agendaConferidaAte;
    setTimeout(() => det.conferir(empresa.id, c.id).then((r) => r && console.log(`[pedidos-config] agenda relida: ${r.acao}`)).catch(() => {}), 90 * 1000 + i * 8000).unref?.();
  });
  console.log(`[pedidos-config] agenda sem hora: relendo ${lista.length} conversa(s)`);
  return lista.length ? { relidas: lista.length } : null;
}

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
