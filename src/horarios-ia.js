// horarios-ia.js — horários que a IA pode agendar (aba Agendamentos).
//
// Você cadastra os dias e horários livres. Com isso ligado, a IA só marca o cliente num
// desses horários; sem horário livre (ou cliente fora das localidades escolhidas) ela não
// agenda e continua atendendo normalmente. Um horário fica ocupado quando já tem
// agendamento ativo nele (da IA, da equipe ou marcado à mão) — nunca dois no mesmo horário.
// O código confere ANTES de a resposta sair: horário errado → a IA reescreve uma vez.

const { salvar, novoId, estado } = require('./db');

const DURACAO_PADRAO = 60; // minutos que cada horário ocupa
const ANTECEDENCIA_MS = 30 * 60 * 1000; // não oferece horário que começa em menos de 30 min
const MAX_PARA_IA = 30;

function configDa(empresa) {
  const c = empresa.horariosIa && typeof empresa.horariosIa === 'object' ? empresa.horariosIa : {};
  return {
    ativo: c.ativo === true,
    localidades: String(c.localidades || ''),
    duracao: Math.min(600, Math.max(10, Number(c.duracao) || DURACAO_PADRAO)),
    vagas: Array.isArray(c.vagas) ? c.vagas : []
  };
}

function guardar(empresa, b = {}) {
  const c = configDa(empresa);
  if (b.ativo !== undefined) c.ativo = b.ativo === true;
  if (b.localidades !== undefined) c.localidades = String(b.localidades || '').slice(0, 1000);
  if (b.duracao !== undefined) c.duracao = Math.min(600, Math.max(10, Number(b.duracao) || DURACAO_PADRAO));
  // horários que já passaram há mais de 1 dia saem da lista
  const corte = Date.now() - 86400000;
  c.vagas = c.vagas.filter((v) => new Date(v.quando).getTime() > corte);
  empresa.horariosIa = c;
  salvar();
  return c;
}

function adicionar(empresa, quandoIso) {
  const t = new Date(quandoIso).getTime();
  if (!quandoIso || Number.isNaN(t)) throw Object.assign(new Error('Escolha o dia e o horário.'), { status: 400 });
  if (t < Date.now()) throw Object.assign(new Error('Esse horário já passou.'), { status: 400 });
  const c = configDa(empresa);
  const iso = new Date(t).toISOString();
  if (c.vagas.some((v) => v.quando === iso)) throw Object.assign(new Error('Esse horário já está na lista.'), { status: 400 });
  c.vagas.push({ id: novoId('vag'), quando: iso });
  c.vagas.sort((a, b) => a.quando.localeCompare(b.quando));
  return guardar(Object.assign(empresa, { horariosIa: c }));
}

function remover(empresa, id) {
  const c = configDa(empresa);
  c.vagas = c.vagas.filter((v) => v.id !== id);
  return guardar(Object.assign(empresa, { horariosIa: c }));
}

// agendamentos ativos com dia/hora desta empresa (de todas as conversas)
function ocupados(empresa) {
  const lista = [];
  for (const l of estado.conversas) {
    if (l.empresaId !== empresa.id) continue;
    for (const a of l.agendamentos || []) if (a.status === 'agendado' && a.quando) lista.push({ t: new Date(a.quando).getTime(), leadId: l.id, nome: l.nome || '' });
  }
  return lista;
}

// quem está nesse horário (outro cliente), ou null. ignorarLead: o próprio cliente (remarcação)
function conflito(empresa, iso, ignorarLead = null) {
  const t = new Date(iso).getTime();
  const dur = configDa(empresa).duracao * 60000;
  return ocupados(empresa).find((o) => o.leadId !== ignorarLead && Math.abs(o.t - t) < dur) || null;
}

// lista para a tela: cada horário com livre/ocupado
function situacao(empresa) {
  const c = configDa(empresa);
  const agora_ = Date.now();
  return {
    ativo: c.ativo,
    localidades: c.localidades,
    duracao: c.duracao,
    vagas: c.vagas
      .filter((v) => new Date(v.quando).getTime() > agora_ - 2 * 3600 * 1000)
      .map((v) => {
        const o = conflito(empresa, v.quando);
        return { id: v.id, quando: v.quando, livre: !o, passou: new Date(v.quando).getTime() < agora_, ocupadoPor: o ? { leadId: o.leadId, nome: o.nome } : null };
      })
  };
}

// horários livres para este cliente (o horário que ele mesmo já tem conta como livre para ele)
function livres(empresa, lead) {
  const c = configDa(empresa);
  const limite = Date.now() + ANTECEDENCIA_MS;
  return c.vagas.filter((v) => new Date(v.quando).getTime() >= limite && !conflito(empresa, v.quando, lead?.id));
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const listaLocalidades = (empresa) => configDa(empresa).localidades.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

// o cliente é de uma das localidades? (sem localidades = todos; sem saber onde ele está = ainda não)
function localPermitido(empresa, textoLocal) {
  const locs = listaLocalidades(empresa);
  if (!locs.length) return true;
  const t = semAcento(textoLocal);
  if (!t) return false;
  return locs.some((l) => t.includes(semAcento(l)));
}

const formatar = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const formatarCodigo = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
};

// Texto para o "Contexto desta conversa" da IA (vazio quando desligado)
function paraIa(empresa, lead) {
  const c = configDa(empresa);
  if (!c.ativo) return '';
  const locs = listaLocalidades(empresa);
  const linhas = ['- Agenda: você SÓ pode marcar ([[AGENDAMENTO]]) num destes horários livres. Nunca invente outro, nunca marque dois clientes no mesmo horário.'];
  if (locs.length) {
    const onde = lead?.localizacao?.texto || '';
    linhas.push(`- Só agende clientes de: ${locs.join(', ')}. ${onde ? `Este cliente disse que está em: ${onde}.` : 'Ainda não se sabe onde o cliente está: pergunte antes de oferecer horário.'} Cliente de outro lugar: não agende, continue o atendimento normal.`);
  }
  const lista = livres(empresa, lead).slice(0, MAX_PARA_IA);
  if (!lista.length) linhas.push('- Não há horário livre agora: não agende nem prometa horário; continue o atendimento normal (a equipe combina o horário depois).');
  else linhas.push(`- Horários livres (use exatamente no formato do código): ${lista.map((v) => `${formatar(v.quando)} → [[AGENDAMENTO: ${formatarCodigo(v.quando)} | …]]`).join('; ')}.`);
  return linhas.join('\n');
}

// Confere o [[AGENDAMENTO]] que a IA escreveu. null = pode; senão o motivo (para ela reescrever)
function validar(empresa, lead, r) {
  const c = configDa(empresa);
  if (!c.ativo || !r?.agendamento) return null;
  const iso = require('./tickets').quandoDe(r.agendamento.quando);
  if (!iso) return 'você marcou um agendamento sem dia e horário certos';
  if (!localPermitido(empresa, r.local || lead.localizacao?.texto)) {
    return listaLocalidades(empresa).length && !(r.local || lead.localizacao?.texto)
      ? 'você marcou sem saber onde o cliente está — pergunte a cidade/bairro antes'
      : `o cliente não é de uma das localidades atendidas (${listaLocalidades(empresa).join(', ')}) — não agende`;
  }
  const vaga = c.vagas.find((v) => Math.abs(new Date(v.quando).getTime() - new Date(iso).getTime()) < 60000);
  if (!vaga) return `o horário ${formatar(iso)} não está na lista de horários livres`;
  const o = conflito(empresa, vaga.quando, lead.id);
  if (o) return `o horário ${formatar(iso)} acabou de ser ocupado por outro cliente`;
  return null;
}

module.exports = { configDa, guardar, adicionar, remover, situacao, livres, conflito, localPermitido, paraIa, validar, formatar };
