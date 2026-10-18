// temperatura.js — chance de venda de cada cliente, SEM IA (só regras sobre a conversa).
//
// Soma pontos pelos sinais de quem está perto de fechar e tira pelos de quem esfriou:
//   🔥 quente (6+ pontos) · 🌤️ morno (3 a 5) · ❄️ frio (até 2)
// Quem já agendou ou comprou não entra (já fechou). Serve para marcar o cliente no painel e
// para o follow-up mandar uma sequência só para os quentes (ex.: puxar o agendamento).

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SINAIS = [
  // [pontos, motivo, regra sobre o texto do cliente]
  [3, 'perguntou de horário/dia', /\b(horario|horarios|agenda|agendar|marcar|amanha|hoje|sabado|domingo|segunda|terca|quarta|quinta|sexta|que dia|qual dia|disponivel|vaga|quando (voce|vc|vcs|voces|pode|da)|essa semana|semana que vem)\b/],
  [2, 'perguntou preço/forma de pagamento', /\b(quanto|valor|preco|custa|pix|cartao|parcel|a vista|desconto|orcamento)\b/],
  [2, 'demonstrou que quer', /\b(quero|gostei|fechado|fechar|bora|vamos|pode ser|top|perfeito|show|beleza|combinado|manda|tenho interesse|me interessei)\b/],
  [-2, 'disse que vai pensar/depois', /\b(vou pensar|vou ver|depois eu|mais tarde eu|outra hora|agora nao|sem dinheiro|ta caro|muito caro|achei caro|caro demais|deixa pra (la|depois))\b/]
];

function calcular(empresa, lead, agoraMs = Date.now()) {
  const msgs = (lead?.mensagens || []).filter((m) => !m.apagada);
  const doCliente = msgs.filter((m) => m.papel === 'visitante');
  if (!doCliente.length) return { nivel: 'frio', pontos: 0, motivos: [] };
  // já fechou: agendou (ativo) ou comprou — não é "chance", é cliente
  if ((lead.agendamentos || []).some((a) => a.status === 'agendado')) return { nivel: 'fechou', pontos: 0, motivos: ['já agendou'] };
  try {
    if (require('./comprovantes').jaVendeu(empresa, lead)) return { nivel: 'fechou', pontos: 0, motivos: ['já comprou'] };
  } catch { /* sem dados de venda */ }
  const texto = sem(doCliente.slice(-25).map((m) => m.texto || '').join(' \n '));
  let pontos = 0;
  const motivos = [];
  const somar = (p, motivo) => { pontos += p; motivos.push(`${p > 0 ? '+' : ''}${p} ${motivo}`); };
  for (const [p, motivo, re] of SINAIS) if (re.test(texto)) somar(p, motivo);
  // falou de um serviço/produto do catálogo da empresa
  try {
    const itens = require('./catalogo').itensDa(empresa).filter((x) => x.ativo !== false && x.nome);
    if (itens.some((x) => sem(x.nome).split(/\s+/).filter((w) => w.length >= 4).some((w) => texto.includes(w)))) somar(1, 'falou de um serviço/produto');
  } catch { /* sem catálogo */ }
  // mandou endereço/bairro (pronto para receber)
  try {
    if (require('./endereco').enderecoDo(lead)) somar(2, 'mandou o endereço');
  } catch { /* segue */ }
  // mandou foto (do item, do carro, do lugar…)
  if (doCliente.some((m) => m.anexo?.tipo === 'image' || m.tipo === 'image' || /^\[(foto|imagem)/i.test(m.texto || ''))) somar(1, 'mandou foto');
  // conversa de verdade (não só um "oi")
  if (doCliente.length >= 4) somar(1, 'respondeu várias vezes');
  // veio de anúncio ou do botão do site (já chegou querendo)
  const chegada = `${lead.origemSite?.chegada?.url || ''} ${lead.origemSite?.primeira?.url || ''}`;
  if (/[?&](fbclid|gclid)=/.test(chegada) || lead.anuncioId) somar(1, 'veio de anúncio');
  // esfriou: dias sem o cliente falar
  const dias = (agoraMs - new Date(doCliente[doCliente.length - 1].em || 0).getTime()) / 86400000;
  if (dias > 14) somar(-3, `sem falar há ${Math.floor(dias)} dias`);
  else if (dias > 5) somar(-1, `sem falar há ${Math.floor(dias)} dias`);
  // cancelou um agendamento: ainda tem interesse, mas é menos certo
  if ((lead.agendamentos || []).some((a) => a.status === 'cancelado')) somar(-1, 'cancelou um agendamento');
  const nivel = pontos >= 6 ? 'quente' : pontos >= 3 ? 'morno' : 'frio';
  return { nivel, pontos, motivos };
}

const ROTULO = { quente: '🔥 Quente', morno: '🌤️ Morno', frio: '❄️ Frio', fechou: '✅ Fechou' };

// para listas do painel: { nivel, pontos, rotulo, motivos }
function paraPainel(empresa, lead) {
  const t = calcular(empresa, lead);
  return { ...t, rotulo: ROTULO[t.nivel] };
}

// o cliente passa no filtro "Para quem" do follow-up? (todos | quente | morno = morno ou quente)
function passa(empresa, lead, filtro) {
  if (!filtro || filtro === 'todos') return true;
  const n = calcular(empresa, lead).nivel;
  return filtro === 'quente' ? n === 'quente' : filtro === 'morno' ? n === 'quente' || n === 'morno' : true;
}

module.exports = { calcular, paraPainel, passa, ROTULO };
