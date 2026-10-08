// tickets.js — avisos no meio da conversa: VENDA CONCLUÍDA e AGENDADO.
//
// A IA (site e WhatsApp) marca na resposta [[VENDA: ...]] quando o cliente
// confirma a compra e [[AGENDAMENTO: ...]] quando confirma dia e horário. A
// equipe também marca pelo painel, e comprovante de Pix vira venda sozinho.
// A venda vai para o Faturamento. A que a IA entendeu pela conversa (sem
// comprovante) entra como recebida em DINHEIRO, no valor combinado; se depois
// chegar o comprovante do Pix, ela vira Pix (não duplica). O agendamento fica no lead.

const { estado, salvar, novoId, agora } = require('./db');
const leads = require('./leads');
const comprovantes = require('./comprovantes');

const FUSO = '-03:00'; // horário de Brasília (sem horário de verão)

// "350", "R$ 1.250,90", "1250.9" → 1250.9 (ou null)
function valorDe(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  const n = comprovantes.paraNumero(String(v || '').replace(/[^\d.,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "04/10/2026 09:00", "4/10 9h", "2026-10-04T09:00" → ISO em Brasília (ou null)
function quandoDe(v, referencia = new Date()) {
  const s = String(v || '').trim();
  if (!s) return null;
  // data completa com fuso (ex.: 2026-10-03T12:00:00.000Z): já é o instante certo
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  const br = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\D+(\d{1,2})(?:[:h](\d{2})?)?)?/i);
  let ano, mes, dia, hora = 9, min = 0;
  if (iso) {
    [ano, mes, dia] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (iso[4]) [hora, min] = [Number(iso[4]), Number(iso[5])];
  } else if (br) {
    dia = Number(br[1]);
    mes = Number(br[2]);
    ano = br[3] ? Number(br[3].length === 2 ? `20${br[3]}` : br[3]) : referencia.getFullYear();
    if (br[4]) [hora, min] = [Number(br[4]), Number(br[5] || 0)];
    // sem ano e a data já passou: é do ano que vem
    if (!br[3] && new Date(`${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T23:59:00${FUSO}`) < referencia) ano++;
  } else return null;
  if (!(mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31 && hora >= 0 && hora <= 23 && min >= 0 && min <= 59)) return null;
  const d = new Date(`${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}:00${FUSO}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- agendamento lido na conversa (sem IA)
// "agendado para sábado às 9h", "fica marcado amanhã 14h", "te espero dia 05/10 às 15:30"
const RETORNO = /\b(te (chamo|chamar|chamamos|aviso|avisar|retorno|retornar|ligo|ligar|mando|mandar|procuro)|me (chama|chame|avisa|avise|liga|ligue|manda|mande)|entro em contato|falo com (voce|vc)|falamos|conversamos)\b/i;
const CONFIRMA = /\b(agendad[oa]s?|marcad[oa]s?|confirmad[oa]s?|reservad[oa]s?|combinad[oa]s?|agendei|marquei|confirmei|reservei|te (espero|esperamos|aguardo|aguardamos)|esperamos (voc[eê]|vc)|est[aá] (marcado|agendado|confirmado)|fica (marcado|agendado|combinado))\b/i;
const DIAS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Em Brasília: { ano, mes, dia, hora, min } de uma data
function partesSp(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d);
  const v = Object.fromEntries(f.map((p) => [p.type, p.value]));
  return { ano: Number(v.year), mes: Number(v.month), dia: Number(v.day), hora: Number(v.hour) % 24, min: Number(v.minute), semana: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(v.weekday) };
}

const isoSp = (ano, mes, dia, hora, min) => new Date(`${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}:00${FUSO}`);

// Acha dia e horário escritos em português. Devolve ISO (Brasília) ou null.
function quandoNoTexto(texto, referencia = new Date()) {
  const t = semAcento(texto);
  const hoje = partesSp(referencia);
  // horário: "9h", "9:30", "14hs", "às 15", "as 9 horas"
  const h = t.match(/\b(?:as|a partir das|pras|para as)\s+(\d{1,2})(?:[:h](\d{2}))?\b|\b(\d{1,2})(?::(\d{2})|\s*(?:h|hs|hrs|horas)(\d{2})?)\b/);
  const hora = h ? Number(h[1] ?? h[3]) : null;
  const min = h ? Number(h[2] ?? h[4] ?? h[5] ?? 0) : 0;
  if (hora !== null && (hora > 23 || min > 59)) return null;
  let alvo = null; // { ano, mes, dia }
  const dm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const diaN = t.match(/\bdia\s+(\d{1,2})\b/);
  const sem = t.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/);
  const base = (diasAMais) => {
    const d = new Date(isoSp(hoje.ano, hoje.mes, hoje.dia, 12, 0).getTime() + diasAMais * 86400000);
    const p = partesSp(d);
    return { ano: p.ano, mes: p.mes, dia: p.dia };
  };
  if (dm) {
    const ano = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : hoje.ano;
    alvo = { ano, mes: Number(dm[2]), dia: Number(dm[1]) };
    if (!dm[3] && isoSp(alvo.ano, alvo.mes, alvo.dia, 23, 59) < referencia) alvo.ano++;
  } else if (/\bdepois de amanha\b/.test(t)) alvo = base(2);
  else if (/\bamanha\b/.test(t)) alvo = base(1);
  else if (/\bhoje\b/.test(t)) alvo = base(0);
  else if (sem) {
    let mais = (DIAS[sem[1]] - hoje.semana + 7) % 7;
    if (mais === 0 && (hora === null || hora * 60 + min <= hoje.hora * 60 + hoje.min)) mais = 7; // mesmo dia da semana já passou: a próxima
    alvo = base(mais);
  } else if (diaN) {
    alvo = { ano: hoje.ano, mes: hoje.mes, dia: Number(diaN[1]) };
    if (isoSp(alvo.ano, alvo.mes, alvo.dia, 23, 59) < referencia) {
      alvo.mes++;
      if (alvo.mes > 12) { alvo.mes = 1; alvo.ano++; }
    }
  } else if (hora !== null) {
    alvo = base(0); // só o horário: hoje (se ainda não passou)
    if (isoSp(alvo.ano, alvo.mes, alvo.dia, hora, min) < referencia) return null;
  }
  if (!alvo || !(alvo.mes >= 1 && alvo.mes <= 12 && alvo.dia >= 1 && alvo.dia <= 31)) return null;
  const d = isoSp(alvo.ano, alvo.mes, alvo.dia, hora ?? 9, min);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Mensagem de quem confirma um horário (equipe no painel/celular, ou o cliente) → ticket AGENDADO
function agendamentoDaMensagem(empresa, lead, texto, por) {
  const t = String(texto || '');
  if (!CONFIRMA.test(semAcento(t)) && !CONFIRMA.test(t)) return null;
  // "combinado, amanhã te chamo" é retorno de contato, não horário marcado com o cliente
  if (RETORNO.test(semAcento(t)) && !/\b(agendad|marcad|reservad|horario|consulta|visita|atendimento|instalac|sessao)/i.test(semAcento(t))) return null;
  const quando = quandoNoTexto(t);
  if (!quando || new Date(quando).getTime() < Date.now() - 3600 * 1000) return null;
  const descricao = t.replace(/\s+/g, ' ').trim().slice(0, 120);
  // agenda da IA ligada: o que a IA escreve só vira agendamento pelo [[AGENDAMENTO]] conferido
  if (por === 'ia' && require('./horarios-ia').configDa(empresa).ativo) return null;
  return registrarAgendamento(empresa, lead, { quando, descricao, por });
}

function acharEtapaAgendamento(empresa) {
  return leads.etapasDa(empresa).find((e) => /agend/i.test(e)) || null;
}

// Venda entendida pela IA (ou marcada pela equipe no chat)
function registrarVenda(empresa, lead, { valor, descricao, por = 'ia', forma = 'Dinheiro' }) {
  const v = valorDe(valor);
  const desc = String(descricao || '').trim().slice(0, 200);
  // já tem venda deste cliente nas últimas 24h (ex.: comprovante): não duplica
  const recente = (estado.vendas || []).find(
    (x) => x.leadId === lead.id && x.status !== 'cancelada' && Date.now() - new Date(x.criadoEm).getTime() < 24 * 3600 * 1000
  );
  if (recente) {
    if (!recente.descricao && desc) recente.descricao = desc;
    if (!recente.valor && v) recente.valor = v;
    if (v && recente.status === 'conferir' && por !== 'ia') Object.assign(recente, { valor: v, status: 'confirmada', confirmadaEm: agora(), motivoConferir: '' }); // a equipe confirmou o valor
    comprovantes.aoVender(empresa, lead);
    lead.atualizadoEm = agora();
    salvar();
    return { venda: recente, nova: false };
  }
  const { venda } = comprovantes.registrar(
    empresa,
    lead,
    { valor: v || 0, forma, pagador: lead.nome || '' },
    { origem: por === 'ia' ? 'ia' : 'manual', lidoPor: por === 'ia' ? 'ia-conversa' : 'manual', descricao: desc }
  );
  if (por === 'ia') {
    // sem valor combinado: fica "a conferir" até alguém colocar o valor
    venda.status = v ? 'confirmada' : 'conferir';
    venda.confirmadaEm = v ? agora() : undefined;
    venda.motivoConferir = v ? '' : 'a IA entendeu a venda pela conversa — coloque o valor';
  }
  comprovantes.aoVender(empresa, lead); // vai para "Fechado" e ganha a etiqueta "Cliente"
  lead.atualizadoEm = agora();
  salvar();
  return { venda, nova: true };
}

function registrarAgendamento(empresa, lead, { quando, descricao, por = 'ia', semAviso = false }) {
  const iso = quandoDe(quando);
  const desc = String(descricao || '').trim().slice(0, 200);
  lead.agendamentos = Array.isArray(lead.agendamentos) ? lead.agendamentos : [];
  // o mesmo horário de novo (ou remarcação no mesmo dia): atualiza em vez de duplicar
  const mesmo = lead.agendamentos.find((a) => a.status === 'agendado' && ((iso && a.quando === iso) || (!iso && !a.quando && a.descricao === desc)));
  if (mesmo) {
    if (desc) mesmo.descricao = desc;
    salvar();
    return { agendamento: mesmo, novo: false };
  }
  const ag = { id: novoId('agd'), quando: iso, quandoTexto: iso ? '' : String(quando || '').slice(0, 80), descricao: desc, por, status: 'agendado', criadoEm: agora() };
  lead.agendamentos.push(ag);
  const etapa = acharEtapaAgendamento(empresa);
  if (etapa) {
    const etapas = leads.etapasDa(empresa);
    if (etapas.indexOf(lead.etapa) < etapas.indexOf(etapa)) leads.moverEtapa(lead, empresa, etapa, por === 'ia' ? 'ia-whatsapp' : 'equipe');
  }
  lead.atualizadoEm = agora();
  salvar();
  // aviso para o número cadastrado (técnico/dono), se estiver ligado
  if (!semAviso) require('./aviso-agendamento').agendamentoNovo(empresa, lead, ag);
  return { agendamento: ag, novo: true };
}

// Cancela (ou marca como remarcado). Sem outro agendamento ativo, o lead sai de
// "Agendou" e volta para a etapa de antes; quem recebeu o aviso é avisado também.
function cancelarAgendamento(lead, id, { por = 'equipe', motivo = '', remarcado = false, empresa = null } = {}) {
  const ag = (lead.agendamentos || []).find((a) => a.id === id);
  if (!ag) return null;
  if (ag.status !== 'agendado') return ag;
  ag.status = remarcado ? 'remarcado' : 'cancelado';
  ag.canceladoEm = agora();
  ag.canceladoPor = por;
  if (motivo) ag.motivoCancelamento = String(motivo).slice(0, 200);
  const emp = empresa || estado.empresas.find((e) => e.id === lead.empresaId);
  if (emp && !remarcado) {
    const etapa = acharEtapaAgendamento(emp);
    const outroAtivo = (lead.agendamentos || []).some((a) => a.status === 'agendado');
    if (etapa && lead.etapa === etapa && !outroAtivo) {
      const anterior = [...(lead.etapaHistorico || [])].reverse().find((h) => h.para === etapa)?.de;
      const etapas = leads.etapasDa(emp);
      let volta = anterior && etapas.includes(anterior) && etapas.indexOf(anterior) < etapas.indexOf(etapa) ? anterior : etapas[Math.max(0, etapas.indexOf(etapa) - 1)];
      // quem já combinou horário conversou: não volta para a 1ª etapa ("Lead novo"), fica na de antes de Agendou
      if (volta === etapas[0] && etapas.indexOf(etapa) > 1) volta = etapas[etapas.indexOf(etapa) - 1];
      leads.moverEtapa(lead, emp, volta, por === 'ia' ? 'ia-whatsapp' : por === 'detectado' ? 'sistema' : 'equipe');
    }
    require('./aviso-agendamento').agendamentoCancelado?.(emp, lead, ag);
  }
  lead.atualizadoEm = agora();
  salvar();
  return ag;
}

// Agendamento que já passou não fica "agendado" para sempre: 3 h depois do horário vira
// "realizado" (sai de Próximos); sem data ("data a combinar") parado há 7 dias também sai.
// Sem outro agendamento ativo, a etiqueta Agendado sai do cliente (aqui e no WhatsApp) e,
// se a cópia velha dela voltar (servidor/celular reconectando), sai de novo.
const PASSOU_MS = 3 * 3600 * 1000;
const SEM_DATA_DIAS = 7;
function finalizarPassados(empresa) {
  let n = 0;
  const agoraMs = Date.now();
  for (const lead of estado.conversas) {
    if (lead.empresaId !== empresa.id || !(lead.agendamentos || []).some((a) => a.status === 'agendado')) continue;
    let mudou = false;
    for (const a of lead.agendamentos) {
      if (a.status !== 'agendado') continue;
      const passou = a.quando ? agoraMs - new Date(a.quando).getTime() > PASSOU_MS : agoraMs - new Date(a.criadoEm || 0).getTime() > SEM_DATA_DIAS * 86400000;
      if (!passou) continue;
      a.status = 'realizado';
      a.realizadoEm = agora();
      if (!a.quando) a.semData = true;
      mudou = true;
      n++;
    }
    if (mudou && !lead.agendamentos.some((a) => a.status === 'agendado')) tirarEtiquetaAgendado(empresa, lead);
  }
  // já comprou e não tem agendamento ativo: a etiqueta Agendado que sobrou (velha) sai
  for (const lead of estado.conversas) {
    if (lead.empresaId !== empresa.id || !(lead.etiquetas || []).length || (lead.agendamentos || []).some((a) => a.status === 'agendado')) continue;
    const antes = lead.etiquetas.length;
    if (comprovantes.jaVendeu(empresa, lead)) tirarEtiquetaAgendado(empresa, lead);
    if (lead.etiquetas.length !== antes) n++;
  }
  if (n) salvar();
  return n;
}
function tirarEtiquetaAgendado(empresa, lead) {
  const ids = new Set(leads.etiquetasDa(empresa).filter((t) => /^agendad/.test(semAcento(t.nome).trim())).map((t) => t.id));
  const tiradas = (lead.etiquetas || []).filter((id) => ids.has(id));
  if (!tiradas.length) return;
  lead.tiradasPelaVenda = { ...(lead.tiradasPelaVenda || {}) }; // a cópia velha não volta (mesma proteção da venda)
  for (const id of tiradas) lead.tiradasPelaVenda[id] = agora();
  lead.etiquetas = lead.etiquetas.filter((id) => !ids.has(id));
}

// Tudo o que aparece como aviso na conversa, em ordem
function ticketsDoLead(lead) {
  const vendas = (estado.vendas || [])
    .filter((v) => v.leadId === lead.id && v.status !== 'cancelada')
    .map((v) => ({ id: v.id, tipo: 'venda', em: v.criadoEm, valor: v.valor, descricao: v.descricao || '', forma: v.forma, status: v.status, origem: v.origem, lidoPor: v.lidoPor }));
  const ags = (lead.agendamentos || []).map((a) => ({ id: a.id, tipo: 'agendamento', em: a.criadoEm, quando: a.quando, quandoTexto: a.quandoTexto, descricao: a.descricao, por: a.por, status: a.status, detectadoPor: a.detectadoPor || '', trecho: a.trecho || '', canceladoPor: a.canceladoPor || '', motivoCancelamento: a.motivoCancelamento || '' }));
  return [...vendas, ...ags].sort((a, b) => (a.em < b.em ? -1 : 1));
}

// Resumo curto para a lista de conversas: próximo agendamento ou última venda
function destaqueDoLead(lead) {
  const agora_ = Date.now();
  const proximo = (lead.agendamentos || [])
    .filter((a) => a.status === 'agendado' && a.quando && new Date(a.quando).getTime() > agora_ - 3600 * 1000)
    .sort((a, b) => (a.quando < b.quando ? -1 : 1))[0];
  if (proximo) return { tipo: 'agendamento', quando: proximo.quando };
  const venda = (estado.vendas || []).filter((v) => v.leadId === lead.id && v.status !== 'cancelada').sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))[0];
  if (venda) return { tipo: 'venda', valor: venda.valor };
  return null;
}

// Para a IA não marcar de novo o que já está marcado
function paraIa(lead) {
  const t = ticketsDoLead(lead);
  if (!t.length) return '';
  const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return t
    .map((x) =>
      x.tipo === 'venda'
        ? `- Venda já registrada${x.valor ? ` (${comprovantes.brl(x.valor)})` : ''}${x.descricao ? `: ${x.descricao}` : ''}.`
        : x.status === 'cancelado' || x.status === 'remarcado'
          ? `- Agendamento ${x.status === 'remarcado' ? 'trocado por outro horário' : 'cancelado'}: ${x.quando ? fmt(x.quando) : x.quandoTexto}.`
          : `- Agendamento já registrado: ${x.quando ? fmt(x.quando) : x.quandoTexto}${x.descricao ? ` — ${x.descricao}` : ''}.`
    )
    .join('\n');
}

// Aplica o que a IA marcou na resposta
function aplicarDaIa(empresa, lead, r) {
  const feitos = [];
  if (r?.desmarcar) {
    const ativo = (lead.agendamentos || []).filter((a) => a.status === 'agendado').sort((a, b) => String(a.quando).localeCompare(String(b.quando)))[0];
    if (ativo) feitos.push({ tipo: 'cancelamento', agendamento: cancelarAgendamento(lead, ativo.id, { por: 'ia', motivo: 'o cliente desmarcou na conversa', empresa }) });
  }
  if (r?.venda) feitos.push({ tipo: 'venda', ...registrarVenda(empresa, lead, { ...r.venda, por: 'ia' }) });
  // horário que já passou (a IA errou o dia): não marca nem avisa
  const iso = r?.agendamento ? quandoDe(r.agendamento.quando) : null;
  // agenda da IA ligada: nunca dois clientes no mesmo horário (outro pode ter pegado no meio tempo)
  const ocupado = r?.agendamento && iso && require('./horarios-ia').configDa(empresa).ativo ? require('./horarios-ia').conflito(empresa, iso, lead.id) : null;
  if (ocupado) {
    require('./alertas').registrar(empresa, 'agenda', `A IA combinou ${require('./horarios-ia').formatar(iso)} com um cliente, mas esse horário já está com outro cliente. Não foi agendado — combine outro horário com ele.`, { leadId: lead.id });
  } else if (r?.agendamento && !(lead.agendamentos || []).some((a) => a.status === 'agendado') && !require('./endereco').podeAgendar(empresa, lead, [r.agendamento.descricao])) {
    // última trava: a IA marcou sem o endereço do cliente → não registra (a conversa continua normal)
    require('./alertas').registrar(empresa, `agenda:${lead.id}`, `📍 A IA quis agendar ${lead.nome || 'um cliente'}, mas ele ainda não passou o endereço — não agendei.`, { nivel: 'info', leadId: lead.id });
  } else if (r?.agendamento && !(iso && new Date(iso).getTime() < Date.now() - 3600 * 1000)) {
    const antes = (lead.agendamentos || []).filter((a) => a.status === 'agendado');
    const novo = registrarAgendamento(empresa, lead, { ...r.agendamento, por: 'ia' });
    // trocou de dia/horário: o anterior vira "remarcado"
    if (novo.novo) for (const a of antes) if (a.id !== novo.agendamento.id) cancelarAgendamento(lead, a.id, { por: 'ia', motivo: 'remarcado', remarcado: true, empresa });
    feitos.push({ tipo: 'agendamento', ...novo });
  }
  return feitos;
}

module.exports = { finalizarPassados, quandoNoTexto, agendamentoDaMensagem, valorDe, quandoDe, registrarVenda, registrarAgendamento, cancelarAgendamento, ticketsDoLead, destaqueDoLead, paraIa, aplicarDaIa };
