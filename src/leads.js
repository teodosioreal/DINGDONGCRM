// leads.js — cada atendimento é um lead que passa pelas etapas do funil.
// O mesmo lead junta as mensagens do chat do site e do WhatsApp: quando o
// visitante sai do site para o WhatsApp, a mensagem leva um código
// (#ABC123) que liga as duas conversas, e a IA do WhatsApp continua de onde
// a IA do site parou.

const crypto = require('crypto');
const { estado, salvar, novoId, agora } = require('./db');

const ETAPAS_PADRAO = ['Lead novo', 'Convertendo', 'Agendou', 'Vendi', 'Não fechou'];

// O que cada etapa padrão quer dizer (vai para a IA saber quando mover o lead)
const SIGNIFICADO_ETAPA = {
  'lead novo': 'acabou de chegar, ainda não conversou de verdade',
  convertendo: 'está conversando, tirando dúvidas, vendo preço ou negociando',
  agendou: 'marcou dia e horário do serviço/atendimento',
  vendi: 'comprou ou pagou',
  'nao fechou': 'desistiu, sumiu de vez ou disse que não quer'
};
function significadoEtapa(nome) {
  return SIGNIFICADO_ETAPA[String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()] || '';
}

// Funil antigo (7 etapas) → funil novo (5 etapas)
const ETAPAS_ANTIGAS = {
  Novo: 'Lead novo',
  'Conversando no site': 'Convertendo',
  'No WhatsApp': 'Convertendo',
  Qualificado: 'Convertendo',
  'Proposta / agendamento': 'Convertendo',
  Fechado: 'Vendi',
  Perdido: 'Não fechou'
};

const MAX_LEADS_GUARDADOS = 20000;
const MAX_MENSAGENS_POR_LEAD = 400;

function etapasDa(empresa) {
  const lista = (empresa?.etapas || []).map((e) => String(e).trim()).filter(Boolean);
  return lista.length ? lista : ETAPAS_PADRAO.slice();
}

// Acha a etapa pelo nome sem ligar para maiúsculas/acentos (a IA às vezes varia)
function acharEtapa(empresa, nome) {
  const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const alvo = limpar(nome);
  return etapasDa(empresa).find((e) => limpar(e) === alvo) || null;
}

function novoCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const codigo = Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('');
    if (!estado.conversas.some((c) => c.codigo === codigo)) return codigo;
  }
}

function criarLead({ empresa, bot, canal, visitanteId, pagina, nome, telefone, whatsappJid }) {
  const etapas = etapasDa(empresa);
  const lead = {
    id: novoId('cv'),
    empresaId: empresa.id,
    botId: bot?.id || null,
    codigo: novoCodigo(),
    origem: canal,
    etapa:
      canal === 'whatsapp'
        ? acharEtapa(empresa, 'No WhatsApp') || etapas[0]
        : canal === 'manual'
          ? etapas[0]
          : acharEtapa(empresa, 'Conversando no site') || etapas[0],
    etapaHistorico: [],
    nome: nome || '',
    telefone: telefone || '',
    whatsappJid: whatsappJid || '',
    visitanteId: visitanteId || '',
    pagina: pagina || '',
    mensagens: [],
    etiquetas: [],
    iaPausada: false,
    criadoEm: agora(),
    atualizadoEm: agora()
  };
  estado.conversas.push(lead);
  if (estado.conversas.length > MAX_LEADS_GUARDADOS) estado.conversas.splice(0, estado.conversas.length - MAX_LEADS_GUARDADOS);
  salvar();
  return lead;
}

// ---------------------------------------------------------------- id das mensagens
// Cada mensagem ganha um id (para apagar pelo painel). As que saíram pelo
// WhatsApp também guardam o id do WhatsApp (wids), para "apagar para todos".
// O envio registra o id aqui e a mensagem salva logo depois pega esse id.
const pendentesPorNumero = new Map(); // número → [{ id, em }]
const chaveNumero = (s) => String(s || '').split('@')[0].replace(/\D/g, '');

function registrarEnvioWhatsapp(destino, wid) {
  const k = chaveNumero(destino);
  if (!k || !wid) return;
  const lista = (pendentesPorNumero.get(k) || []).filter((x) => Date.now() - x.em < 2 * 60 * 1000);
  lista.push({ id: wid, em: Date.now() });
  pendentesPorNumero.set(k, lista);
  if (pendentesPorNumero.size > 2000) pendentesPorNumero.delete(pendentesPorNumero.keys().next().value);
}

function tirarEnviosPendentes(lead) {
  const k = chaveNumero(lead.whatsappJid) || chaveNumero(lead.telefone);
  if (!k) return [];
  for (const [chave, lista] of pendentesPorNumero) {
    const mesmo = chave === k || (chave.length >= 10 && k.length >= 10 && (chave.endsWith(k) || k.endsWith(chave)));
    if (!mesmo) continue;
    pendentesPorNumero.delete(chave);
    return lista.filter((x) => Date.now() - x.em < 2 * 60 * 1000).map((x) => x.id);
  }
  return [];
}

// Mensagens antigas (sem id) ganham um na primeira vez que o painel abre a conversa
function garantirIdsDasMensagens(lead) {
  let mudou = false;
  for (const m of lead.mensagens || []) {
    if (!m.id) {
      m.id = novoId('msg');
      mudou = true;
    }
  }
  if (mudou) salvar();
}

// A IA só escreve para quem está na aba Conversas e já mandou mensagem (ela
// "leu" o cliente). Contato importado/cadastrado à mão, sem conversa, ou
// conversa apagada: a IA nunca manda nada (só a equipe, à mão ou por disparo).
function iaPodeFalarCom(lead) {
  return Boolean(lead && estado.conversas.includes(lead) && !naListaNegra(null, lead) && (lead.mensagens || []).some((m) => m.papel === 'visitante'));
}

// ---------------------------------------------------------------- lista negra
// Número na lista negra não recebe NADA: nem IA, nem automação, follow-up,
// disparo ou mensagem da equipe. Fica guardado na empresa (vale mesmo se a
// conversa for apagada e o cliente escrever de novo). As mensagens dele ainda
// aparecem em Conversas, só que ninguém responde.
function chaveListaNegra(x) {
  const s = String(x || '').trim();
  if (/@lid$/.test(s)) return s;
  let d = s.split('@')[0].replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') d = d.slice(0, 4) + d.slice(5); // com ou sem o 9 é o mesmo celular
  return d.length >= 10 ? d : '';
}
const chavesDoLead = (lead) => [...new Set([lead?.whatsappJid, lead?.telefone].map(chaveListaNegra).filter(Boolean))];

function listaNegraDa(empresa) {
  if (!Array.isArray(empresa.listaNegra)) empresa.listaNegra = [];
  return empresa.listaNegra;
}

// aceita um lead ou um número/jid (empresa pode ser null quando é lead)
function naListaNegra(empresa, alvo) {
  const ehLead = alvo && typeof alvo === 'object';
  const emp = empresa || (ehLead && estado.empresas.find((e) => e.id === alvo.empresaId));
  if (!emp || !Array.isArray(emp.listaNegra) || !emp.listaNegra.length) return false;
  const chaves = ehLead ? chavesDoLead(alvo) : [chaveListaNegra(alvo)].filter(Boolean);
  return emp.listaNegra.some((b) => (ehLead && b.leadId === alvo.id) || b.chaves.some((k) => chaves.includes(k)));
}

function porNaListaNegra(empresa, lead, por = '', motivo = '') {
  const lista = listaNegraDa(empresa);
  if (naListaNegra(empresa, lead)) return false;
  lista.push({ id: novoId('ln'), leadId: lead.id, chaves: chavesDoLead(lead), nome: lead.nome || '', telefone: lead.telefone || '', motivo: String(motivo || '').slice(0, 200), por, em: agora() });
  lead.listaNegra = true;
  // cancela o que estava programado para ele
  for (const a of lead.agendadas || []) if (a.status === 'pendente') Object.assign(a, { status: 'cancelada', motivo: 'cliente na lista negra' });
  salvar();
  return true;
}

function tirarDaListaNegra(empresa, { leadId, id } = {}) {
  const lead = leadId && estado.conversas.find((c) => c.id === leadId);
  const antes = listaNegraDa(empresa).length;
  empresa.listaNegra = listaNegraDa(empresa).filter((b) => !(b.id === id || (leadId && b.leadId === leadId) || (lead && b.chaves.some((k) => chavesDoLead(lead).includes(k)))));
  for (const c of estado.conversas) if (c.empresaId === empresa.id && c.listaNegra && !naListaNegra(empresa, c)) delete c.listaNegra;
  salvar();
  return antes !== empresa.listaNegra.length;
}

function adicionarMensagem(lead, msg) {
  const saiuPeloWhatsapp = msg.canal === 'whatsapp' && msg.papel !== 'visitante' && !msg.wid && !msg.wids;
  const wids = saiuPeloWhatsapp ? tirarEnviosPendentes(lead) : [];
  lead.mensagens.push({ id: novoId('msg'), em: agora(), ...msg, ...(wids.length ? { wids } : {}) });
  if (lead.mensagens.length > MAX_MENSAGENS_POR_LEAD) lead.mensagens.splice(0, lead.mensagens.length - MAX_MENSAGENS_POR_LEAD);
  lead.atualizadoEm = agora();
}

// Muda a etapa (se for uma etapa válida da empresa). `por`: 'ia-site', 'ia-whatsapp', 'equipe', 'sistema'.
function moverEtapa(lead, empresa, nomeEtapa, por) {
  const etapa = acharEtapa(empresa, nomeEtapa);
  if (!etapa || etapa === lead.etapa) return false;
  lead.etapaHistorico = lead.etapaHistorico || [];
  lead.etapaHistorico.push({ de: lead.etapa, para: etapa, por, em: agora() });
  lead.etapa = etapa;
  lead.atualizadoEm = agora();
  // a EQUIPE moveu para a etapa de venda ("Vendi", "Fechado"…): sai do agendado e ganha a etiqueta
  // de venda; tirou de lá (sem venda registrada): volta como estava. (Pix, botão e IA vendem pelo
  // registro de venda, que já troca as etiquetas.)
  if (por === 'equipe') {
    const comprovantes = require('./comprovantes');
    const antes = lead.etapaHistorico[lead.etapaHistorico.length - 1]?.de || '';
    const temVenda = lead.vendaConcluidaManual || (estado.vendas || []).some((v) => v.leadId === lead.id && v.status !== 'cancelada');
    if (comprovantes.ehEtapaDeVenda(etapa)) comprovantes.marcarVendido(empresa, lead);
    else if (antes && comprovantes.ehEtapaDeVenda(antes) && !temVenda) comprovantes.desfazerVendido(empresa, lead);
  }
  return true;
}

// Etapas "de entrada": enquanto o lead estiver nelas, chegar no WhatsApp o
// move para "No WhatsApp". Etapas mais avançadas não voltam para trás.
function aoChegarNoWhatsapp(lead, empresa) {
  const etapas = etapasDa(empresa);
  const noZap = acharEtapa(empresa, 'No WhatsApp');
  if (!noZap) return;
  const posAtual = etapas.indexOf(lead.etapa);
  const posZap = etapas.indexOf(noZap);
  if (posAtual === -1 || posAtual < posZap) moverEtapa(lead, empresa, noZap, 'sistema');
}

// Funil padrão: o cliente mandou a 2ª mensagem → sai da 1ª etapa ("Lead novo")
// e vai para "Convertendo". Só anda para frente e só se a etapa existir.
function aoConversar(lead, empresa) {
  const etapas = etapasDa(empresa);
  const convertendo = acharEtapa(empresa, 'Convertendo');
  if (!convertendo || lead.etapa !== etapas[0] || etapas.indexOf(convertendo) <= 0) return false;
  const doCliente = (lead.mensagens || []).filter((m) => m.papel === 'visitante').length;
  return doCliente >= 2 ? moverEtapa(lead, empresa, convertendo, 'sistema') : false;
}

// ---------------------------------------------------------------- etiquetas
// As etiquetas são SÓ as do WhatsApp Business: o CRM não cria etiqueta própria.
// Criou/renomeou/apagou no celular → aparece/muda/some aqui (etiquetas-zap.js).
// O lead guarda só os ids; a equipe e as IAs podem marcar (e o CRM marca no celular).

const CORES_ETIQUETA = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

function etiquetasDa(empresa) {
  if (!empresa) return [];
  if (!Array.isArray(empresa.etiquetas)) empresa.etiquetas = [];
  return empresa.etiquetas;
}

// Tira as etiquetas que não vieram do WhatsApp (as antigas "Quente", "Morno",
// "Frio", "Cliente", "Indeciso" e as criadas no painel) e desmarca dos leads.
function soEtiquetasDoZap() {
  let tiradas = 0;
  for (const empresa of estado.empresas) {
    const lista = etiquetasDa(empresa);
    const locais = new Set(lista.filter((t) => !t.zapId).map((t) => t.id));
    if (!locais.size) continue;
    empresa.etiquetas = lista.filter((t) => !locais.has(t.id));
    for (const c of estado.conversas) {
      if (c.empresaId !== empresa.id) continue;
      if (c.etiquetas?.some((id) => locais.has(id))) c.etiquetas = c.etiquetas.filter((id) => !locais.has(id));
      if (c.etiquetasZap?.some((id) => locais.has(id))) c.etiquetasZap = c.etiquetasZap.filter((id) => !locais.has(id));
    }
    for (const r of Array.isArray(empresa.automacoes) ? empresa.automacoes : []) if (r.filtro?.etiquetas?.length) r.filtro.etiquetas = r.filtro.etiquetas.filter((id) => !locais.has(id));
    tiradas += locais.size;
  }
  if (tiradas) {
    salvar();
    console.log(`[etiquetas] ${tiradas} etiqueta(s) do CRM removida(s): agora só as do WhatsApp`);
  }
  return tiradas;
}

// O que a IA lê desta conversa: depois de "Reiniciar aprendizado da conversa", só as
// mensagens a partir dali (o histórico continua aparecendo para a equipe)
function historicoParaIa(lead) {
  const desde = lead?.iaReiniciadaEm;
  const todas = lead?.mensagens || [];
  return desde ? todas.filter((m) => String(m.em || '') >= desde) : todas;
}

function limparNome(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function aplicarEtiqueta(lead, empresa, nome) {
  const alvo = limparNome(nome);
  const etiqueta = etiquetasDa(empresa).find((e) => limparNome(e.nome) === alvo);
  if (!etiqueta) return false;
  lead.etiquetas = lead.etiquetas || [];
  if (lead.etiquetas.includes(etiqueta.id)) return false;
  lead.etiquetas.push(etiqueta.id);
  lead.atualizadoEm = agora();
  return true;
}

// Empresas com o funil antigo de 7 etapas passam para o funil padrão de 5
// (Lead novo, Convertendo, Agendou, Vendi, Não fechou). Etapas criadas pela
// empresa ficam (no fim). Leads, follow-up, automações e mídias acompanham.
function migrarFunilPadrao() {
  let mudou = false;
  for (const empresa of estado.empresas) {
    const atuais = (empresa.etapas || []).map((e) => String(e).trim()).filter(Boolean);
    if (!atuais.length || empresa.funilV2) continue;
    const antigas = atuais.filter((e) => ETAPAS_ANTIGAS[e]);
    if (antigas.length < 5) { empresa.funilV2 = true; mudou = true; continue; } // funil próprio: não mexe
    const extras = atuais.filter((e) => !ETAPAS_ANTIGAS[e] && !ETAPAS_PADRAO.includes(e));
    empresa.etapas = [...ETAPAS_PADRAO, ...extras];
    const agendou = (lead) => (lead.agendamentos || []).some((a) => a.status === 'agendado');
    const trocar = (nome, lead) => {
      if (lead && nome === 'Proposta / agendamento' && agendou(lead)) return 'Agendou';
      return ETAPAS_ANTIGAS[nome] || nome;
    };
    const lista = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => trocar(x)))] : v);
    for (const c of estado.conversas) {
      if (c.empresaId !== empresa.id) continue;
      if (c.etapa && ETAPAS_ANTIGAS[c.etapa]) c.etapa = trocar(c.etapa, c);
      else if (c.etapa && !empresa.etapas.includes(c.etapa)) c.etapa = empresa.etapas[0];
      if (c.etapaAntesDaVenda) c.etapaAntesDaVenda = trocar(c.etapaAntesDaVenda, c);
      // quem já tem agendamento ativo e ainda está antes de "Agendou" vai para lá
      if (agendou(c) && ['Lead novo', 'Convertendo'].includes(c.etapa)) c.etapa = 'Agendou';
    }
    if (empresa.followup && Array.isArray(empresa.followup.pararEtapas)) empresa.followup.pararEtapas = lista(empresa.followup.pararEtapas);
    for (const r of empresa.automacoes || []) {
      if (r.gatilho?.etapa) r.gatilho.etapa = trocar(r.gatilho.etapa);
      if (r.filtro?.etapas) r.filtro.etapas = lista(r.filtro.etapas);
    }
    for (const grupo of ['midias', 'albuns', 'drivePastas']) for (const m of empresa[grupo] || []) if (m.etapas) m.etapas = lista(m.etapas);
    empresa.funilV2 = true;
    mudou = true;
    console.log(`[funil] ${empresa.nome}: etapas trocadas para ${empresa.etapas.join(', ')}`);
  }
  if (mudou) salvar();
}

// Leads criados por versões antigas (antes do funil) ganham os campos novos
function migrarLeads() {
  migrarFunilPadrao();
  // boas-vindas padrão antiga ("Sou o assistente virtual da…") vira a nova; texto escrito pelo dono não é mexido
  for (const b of estado.bots || []) {
    const emp = estado.empresas.find((e) => e.id === b.empresaId);
    if (emp && b.boasVindas === `Olá! 👋 Sou o assistente virtual da ${emp.nome}. Como posso te ajudar?`) {
      b.boasVindas = `Olá! 👋 Seja bem-vindo(a) à ${emp.nome}. Como posso te ajudar?`;
      salvar();
    }
  }
  let mudou = false;
  for (const c of estado.conversas) {
    if (c.codigo && c.etapa) continue;
    const empresa = estado.empresas.find((e) => e.id === c.empresaId);
    if (!c.codigo) c.codigo = novoCodigo();
    if (!c.etapa) c.etapa = c.lead ? acharEtapa(empresa, 'No WhatsApp') || etapasDa(empresa)[0] : acharEtapa(empresa, 'Conversando no site') || etapasDa(empresa)[0];
    c.origem = c.origem || 'site';
    c.etapaHistorico = c.etapaHistorico || [];
    delete c.conversoes;
    for (const m of c.mensagens || []) m.canal = m.canal || 'site';
    mudou = true;
  }
  if (mudou) salvar();
}

module.exports = {
  ETAPAS_PADRAO,
  significadoEtapa,
  aoConversar,
  migrarFunilPadrao,
  CORES_ETIQUETA,
  etiquetasDa,
  historicoParaIa,
  soEtiquetasDoZap,
  aplicarEtiqueta,
  etapasDa,
  acharEtapa,
  criarLead,
  adicionarMensagem,
  iaPodeFalarCom,
  naListaNegra,
  porNaListaNegra,
  tirarDaListaNegra,
  listaNegraDa,
  chaveListaNegra,
  registrarEnvioWhatsapp,
  garantirIdsDasMensagens,
  moverEtapa,
  aoChegarNoWhatsapp,
  migrarLeads
};
