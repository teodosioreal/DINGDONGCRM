// aviso-agendamento.js — quando um agendamento é CONFIRMADO (pela IA, pela equipe
// no painel ou combinado na conversa do WhatsApp), o CRM manda uma mensagem para
// um número cadastrado (ex.: do técnico ou do dono) com o resumo do serviço:
// cliente, telefone com link wa.me, quando, serviço, item do cliente (carro, aparelho…), endereço,
// preço e outras informações importantes da conversa. Liga/desliga na IA do WhatsApp.

const { estado, salvar, agora } = require('./db');

const ESPERA_MS = Number(process.env.AVISO_AGENDAMENTO_ESPERA_MS) || 8000; // deixa a conversa assentar (preço, endereço…)

function configDa(empresa) {
  if (!empresa.avisoAgendamento || typeof empresa.avisoAgendamento !== 'object') empresa.avisoAgendamento = { ativo: false, numero: '' };
  return empresa.avisoAgendamento;
}

function salvarConfig(empresa, b = {}) {
  const c = configDa(empresa);
  const estavaLigado = c.ativo === true;
  if (b.numero !== undefined) {
    const n = require('./util').numeroWhatsapp(b.numero);
    if (b.numero && n.length < 10) throw Object.assign(new Error('Número inválido. Use DDD + número.'), { status: 400 });
    c.numero = n;
    // salvou um número: o aviso liga junto (antes ficava salvo e desligado, e nada chegava)
    if (n && b.ativo === undefined) c.ativo = true;
  }
  if (b.ativo !== undefined) c.ativo = b.ativo === true;
  if (c.ativo && !c.numero) throw Object.assign(new Error('Cadastre o número que vai receber o aviso.'), { status: 400 });
  salvar();
  // acabou de ligar: manda o aviso dos agendamentos que já estavam marcados (os próximos) e ficaram sem aviso
  let pendentes = 0;
  if (c.ativo && !estavaLigado) {
    const lista = estado.conversas
      .filter((l) => l.empresaId === empresa.id)
      .flatMap((l) => (l.agendamentos || []).filter((a) => a.status === 'agendado' && !a.avisoEm && a.quando && new Date(a.quando).getTime() > Date.now()).map((a) => [l, a]))
      .sort((x, y) => String(x[1].quando).localeCompare(String(y[1].quando)))
      .slice(0, 10);
    lista.forEach(([l, a], i) => {
      a.avisoEm = agora();
      setTimeout(() => enviar(empresa.id, l.id, a.id).catch(() => {}), ESPERA_MS + i * 4000).unref?.();
    });
    pendentes = lista.length;
    if (pendentes) salvar();
  }
  return { ...c, pendentes };
}

const sem = (t) => String(t || '').trim();

// Número do cliente para o aviso (nunca o id escondido do WhatsApp)
function telefoneDoCliente(lead) {
  const jid = String(lead.whatsappJid || '');
  const d = /@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0] : String(lead.telefone || '').replace(/\D/g, '');
  return d.length >= 10 ? d : '';
}

function telefoneBonito(d) {
  const m = String(d).match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}

function quandoBonito(ag) {
  if (!ag.quando) return ag.quandoTexto || 'a combinar';
  return new Date(ag.quando).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Lê a conversa e tira o que importa para quem vai executar o serviço (IA barata; sem IA, o básico)
async function resumoDaConversa(empresa, lead, ag) {
  const base = {
    servico: ag.descricao || '',
    endereco: require('./localizacao').paraPainel(lead)?.texto || '',
    preco: (() => {
      const v = (estado.vendas || []).filter((x) => x.leadId === lead.id && x.status !== 'cancelada').pop();
      return v?.valor ? `R$ ${Number(v.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '';
    })(),
    veiculo: '',
    outras: ''
  };
  const bot = require('./whatsapp').botDoWhatsapp(empresa);
  if (!bot) return base;
  const conversa = (lead.mensagens || [])
    .filter((m) => !m.apagada && m.texto)
    .slice(-40)
    .map((m) => `${m.papel === 'visitante' ? 'Cliente' : 'Empresa'}: ${String(m.texto).slice(0, 400)}`)
    .join('\n');
  try {
    const sistema =
      'Você extrai dados de um agendamento a partir de uma conversa de WhatsApp entre uma empresa e um cliente. Responda SOMENTE com um JSON, sem texto antes ou depois: {"servico": "o que vai ser feito/vendido", "veiculo": "o item do cliente ligado ao atendimento, se houver (ex.: carro/moto com marca, modelo, ano e cor; aparelho; modelo/tamanho do produto; pet) — vazio se não fizer sentido no ramo", "endereco": "endereço, bairro ou cidade do atendimento se houver", "preco": "preço combinado com R$ se houver", "outras": "outras informações úteis para quem vai atender (forma de pagamento, observações, pedidos especiais), curtas"}. Use "" quando não souber. Não invente nada que não esteja na conversa.';
    const pedido = `Agendamento: ${quandoBonito(ag)}${ag.descricao ? ` — ${ag.descricao}` : ''}\n\nConversa:\n${conversa}`;
    const t = await require('./ia').gerarTexto(bot, empresa, sistema, pedido, 600, { barato: true });
    const json = JSON.parse((t.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const r = { ...base };
    for (const k of ['servico', 'veiculo', 'endereco', 'preco', 'outras']) if (sem(json[k])) r[k] = sem(json[k]).slice(0, 300);
    return r;
  } catch (err) {
    console.error('[aviso-agendamento] resumo sem IA:', err.message);
    return base;
  }
}

// Data em destaque: "Sábado, 03/10" e "09:00" separados (lê-se de relance no celular)
function diaEHora(ag) {
  if (!ag.quando) return { dia: ag.quandoTexto || 'Data a combinar', hora: '' };
  const d = new Date(ag.quando);
  const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return { dia: dia.charAt(0).toUpperCase() + dia.slice(1), hora };
}

const LINHA = '━━━━━━━━━━━━━━━';

function montarAviso(empresa, lead, ag, r) {
  const tel = telefoneDoCliente(lead);
  const POR = { ia: 'pela IA', equipe: 'pela equipe', cliente: 'pelo cliente', detectado: 'na conversa (o CRM percebeu sozinho)', etiqueta: 'pela etiqueta Agendado do WhatsApp' };
  const { dia, hora } = diaEHora(ag);
  const blocoCliente = [
    `👤 *${lead.nome || 'Cliente sem nome'}*`,
    tel ? `📞 ${telefoneBonito(tel)}` : '📞 número oculto pelo WhatsApp (responda pelo CRM)',
    tel ? `💬 https://wa.me/${tel}` : ''
  ];
  const blocoServico = [
    r.servico ? `🔧 *Serviço:* ${r.servico}` : '',
    r.veiculo ? `📦 *Item do cliente:* ${r.veiculo}` : '',
    r.endereco ? `📍 *Endereço:* ${r.endereco}` : '',
    r.preco ? `💰 *Valor:* ${r.preco}` : ''
  ];
  const blocos = [
    [`📅 *NOVO AGENDAMENTO* · ${empresa.nome}`, LINHA, `🗓️ *${dia}*${hora ? `  ⏰ *${hora}*` : ''}`, LINHA],
    blocoCliente,
    blocoServico,
    r.outras ? [`📝 *Observações:* ${r.outras}`] : [],
    [LINHA, `✅ Agendado ${POR[ag.por] || 'pelo CRM'}`, `🔗 ${require('./config').urlPublica}/#/leads/${lead.id}`]
  ];
  return blocos.map((b) => b.filter(Boolean)).filter((b) => b.length).map((b) => b.join('\n')).join('\n\n').replace(new RegExp(`${LINHA}\n\n`, 'g'), `${LINHA}\n`);
}

// Chamado quando um agendamento novo é registrado (qualquer origem)
function agendamentoNovo(empresa, lead, ag) {
  const c = configDa(empresa);
  if (!c.ativo || !c.numero || !ag || ag.status !== 'agendado' || ag.avisoEm) return;
  ag.avisoEm = agora(); // marca já: nunca manda dois avisos do mesmo agendamento
  salvar();
  setTimeout(() => enviar(empresa.id, lead.id, ag.id).catch(() => {}), ESPERA_MS).unref?.();
}

async function enviar(empresaId, leadId, agId) {
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  const lead = estado.conversas.find((x) => x.id === leadId);
  const ag = lead?.agendamentos?.find((a) => a.id === agId);
  if (!empresa || !lead || !ag || ag.status !== 'agendado') return;
  const c = configDa(empresa);
  try {
    const r = await resumoDaConversa(empresa, lead, ag);
    const texto = montarAviso(empresa, lead, ag, r);
    await require('./whatsapp').enviarTexto(empresa, c.numero, texto);
    ag.avisoStatus = 'enviado';
    ag.avisoTexto = texto;
    delete ag.avisoErro;
  } catch (err) {
    ag.avisoStatus = 'erro';
    ag.avisoErro = String(err.message).slice(0, 200);
    require('./alertas').registrar(empresa, 'whatsapp', `O aviso do agendamento de ${lead.nome || 'um cliente'} não foi enviado para o número cadastrado: ${err.message}`, { leadId: lead.id });
  }
  salvar();
}

// Agendamento que já tinha sido avisado foi cancelado: avisa o mesmo número
function agendamentoCancelado(empresa, lead, ag) {
  const c = configDa(empresa);
  if (!c.ativo || !c.numero || !ag?.avisoEm || ag.avisoCanceladoEm) return;
  ag.avisoCanceladoEm = agora();
  salvar();
  const tel = telefoneDoCliente(lead);
  const { dia, hora } = diaEHora(ag);
  const texto = [
    `❌ *AGENDAMENTO CANCELADO* · ${empresa.nome}`,
    LINHA,
    `🗓️ ~${dia}${hora ? ` às ${hora}` : ''}~`,
    LINHA,
    `👤 *${lead.nome || 'Cliente sem nome'}*`,
    tel ? `📞 ${telefoneBonito(tel)}` : '',
    tel ? `💬 https://wa.me/${tel}` : '',
    ag.descricao ? `\n🔧 ${ag.descricao}` : '',
    ag.motivoCancelamento && !/^(remarcado|cancelado pela equipe)$/.test(ag.motivoCancelamento) ? `📝 *Motivo:* ${ag.motivoCancelamento}` : ''
  ].filter(Boolean).join('\n');
  require('./whatsapp').enviarTexto(empresa, c.numero, texto).catch((err) => console.error('[aviso-agendamento] cancelamento:', err.message));
}

// Botão "Mandar um teste"
async function testar(empresa) {
  const c = configDa(empresa);
  if (!c.numero) throw Object.assign(new Error('Cadastre o número primeiro.'), { status: 400 });
  const exemplo = montarAviso(
    empresa,
    { id: 'teste', nome: 'Cliente de exemplo', telefone: '5521999999999' },
    { quando: new Date(Date.now() + 864e5).toISOString(), por: 'ia' },
    { servico: require('./catalogo').itensDa(empresa).find((x) => x.ativo)?.nome || 'Serviço de exemplo', veiculo: '', endereco: 'Centro', preco: 'R$ 350,00', outras: 'Paga no Pix na hora' }
  );
  await require('./whatsapp').enviarTexto(empresa, c.numero, `🧪 *TESTE do aviso de agendamento*\n\n${exemplo}`);
  return true;
}

module.exports = { configDa, salvarConfig, agendamentoNovo, agendamentoCancelado, testar, montarAviso, enviar };
