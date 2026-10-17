// pedidos-config.js — configurações que o dono pediu para deixar prontas na empresa dele.
// Cada pedido roda UMA vez (fica anotado em estado.config.pedidosAplicados) quando o CRM
// sobe; nada é apagado: o que muda guarda antes uma cópia do que existia.
const { estado, salvar, agora } = require('./db');

const PEDIDOS = [
  // 17/10: follow-up da Madara Volantes puxando agendamento (pedido do dono no chat)
  { id: 'fup-modelo-agenda-2026-10-17', empresaId: 'emp_2bb32fe7c84e097b', fazer: (e) => require('./followup').aplicarModeloAgendar(e) }
];

function aplicar() {
  estado.config = estado.config || {};
  const feitos = (estado.config.pedidosAplicados = estado.config.pedidosAplicados || {});
  for (const p of PEDIDOS) {
    if (feitos[p.id]) continue;
    const empresa = estado.empresas.find((e) => e.id === p.empresaId);
    if (!empresa) continue;
    try {
      const r = p.fazer(empresa);
      feitos[p.id] = { em: agora(), ok: Boolean(r) };
      salvar();
      console.log(`[pedidos-config] ${p.id}: ${r ? 'aplicado' : 'nada para mudar'}`);
    } catch (err) {
      console.error(`[pedidos-config] ${p.id}:`, err.message);
    }
  }
}

module.exports = { aplicar, PEDIDOS };
