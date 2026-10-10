// expediente.js — horários da empresa (Brasília), por empresa, só código (sem IA).
//
//   • Envios automáticos (follow-up e automações): padrão 8h–20h. Fora dele nada sai;
//     no follow-up a contagem PAUSA quando fecha e continua quando abre (passos de
//     menos de 1 dia). Passos de 1 dia ou mais contam dias corridos e, se caírem
//     fora do horário, saem quando abrir.
//   • Horário da IA responder (desligado por padrão): mensagem que chega fora dele
//     fica esperando e a IA responde quando o horário abrir (alguns por minuto).
//   • IA sem crédito/limite (chave grátis acabou, limite por minuto, Google fora): o
//     cliente fica esperando; a cada 5 min o CRM testa com UM cliente (recusa não gasta)
//     e, quando volta, responde a fila aos poucos com [RESPOSTA_ATRASADA] (a IA pede
//     desculpas pela demora). Mais de 24 h sem resposta: não responde sozinha, avisa a equipe.

const { estado, salvar, agora } = require('./db');

const MIN = 60 * 1000;
const DIA_MIN = 24 * 60;
const FUSO_MS = 3 * 3600 * 1000; // Brasília = UTC-3

// "08:30" → 510 (minutos do dia); inválido → null
function minutosDe(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi)) return null;
  return h * 60 + mi;
}
const textoDe = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function janela(c, padraoInicio, padraoFim) {
  const inicio = minutosDe(c?.inicio) ?? padraoInicio;
  const fim = minutosDe(c?.fim) ?? padraoFim;
  return inicio === fim ? { inicio: padraoInicio, fim: padraoFim } : { inicio, fim };
}

// envios automáticos: liga/desliga continua em automacoes.horarioAutomatico
function janelaEnvio(empresa) {
  return janela(empresa?.horarioEnvio, 8 * 60, 20 * 60);
}

function configIa(empresa) {
  const c = empresa?.expedienteIa || {};
  return { ativo: c.ativo === true, ...janela(c, 8 * 60, 20 * 60) };
}

// minuto do dia em Brasília
const minutoSp = (ms) => {
  const d = new Date(ms - FUSO_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

// aberta neste instante? (aceita janela que passa da meia-noite, ex.: 18:00–02:00)
function dentro(j, ms = Date.now()) {
  const m = minutoSp(ms);
  return j.inicio < j.fim ? m >= j.inicio && m < j.fim : m >= j.inicio || m < j.fim;
}

// próximo instante (a partir de ms, em minuto cheio) em que o minuto do dia vale `alvo`
function proximoMinuto(ms, alvo) {
  const base = Math.floor((ms - FUSO_MS) / MIN) * MIN; // relógio de Brasília em ms
  const meiaNoite = base - minutoSp(ms) * MIN;
  let t = meiaNoite + (alvo % DIA_MIN) * MIN;
  if (t <= base) t += DIA_MIN * MIN;
  return t + FUSO_MS;
}

// aberta agora → o próprio ms; fechada → quando abre
function proximaAbertura(j, ms) {
  return dentro(j, ms) ? ms : proximoMinuto(ms, j.inicio);
}

// soma `horas` contando só o tempo com o horário aberto (a contagem pausa quando fecha)
function somarNoHorario(j, desdeMs, horas) {
  let resta = Math.max(0, horas) * 3600 * 1000;
  let t = proximaAbertura(j, desdeMs);
  for (let i = 0; i < 400; i++) {
    const fecha = proximoMinuto(t, j.fim);
    if (t + resta < fecha) return t + resta;
    resta -= fecha - t;
    t = proximaAbertura(j, fecha);
  }
  return t + resta;
}

// quando o passo do follow-up vence, respeitando o horário dos envios
function vencimento(empresa, desdeMs, horas) {
  const j = janelaEnvio(empresa);
  if (horas < 24) return somarNoHorario(j, desdeMs, horas);
  return proximaAbertura(j, desdeMs + horas * 3600 * 1000);
}

// ---------------------------------------------------------------- IA fora do horário

// a IA pode responder agora? (horário da IA desligado → sempre)
function iaNoHorario(empresa, ms = Date.now()) {
  const c = configIa(empresa);
  return !c.ativo || dentro(c, ms);
}

const descreverIa = (empresa) => {
  const c = configIa(empresa);
  return `${textoDe(c.inicio)}–${textoDe(c.fim === DIA_MIN ? 0 : c.fim)}`;
};

// guarda o cliente para a IA responder quando abrir
function esperarHorario(lead) {
  if (!lead.iaEsperaHorario) lead.iaEsperaHorario = agora();
  salvar();
}

const POR_MINUTO = 3; // espaçado: não estoura o limite por minuto da chave de IA
let rodando = false;
function verificar() {
  if (rodando) return 0;
  rodando = true;
  let n = 0;
  try {
    const whatsapp = require('./whatsapp');
    for (const empresa of estado.empresas) {
      const esperando = estado.conversas.filter((l) => l.empresaId === empresa.id && l.iaEsperaHorario);
      if (!esperando.length || !iaNoHorario(empresa)) continue;
      // quem esperou mais responde primeiro
      esperando.sort((a, b) => (a.iaEsperaHorario < b.iaEsperaHorario ? -1 : 1));
      let daEmpresa = 0;
      for (const lead of esperando) {
        if (daEmpresa >= POR_MINUTO) break;
        delete lead.iaEsperaHorario;
        // a equipe já respondeu (ou o cliente não espera mais nada): não responde
        const msgs = (lead.mensagens || []).filter((m) => (m.texto || m.anexo) && !m.apagada && !m.eventoInterno);
        if (msgs[msgs.length - 1]?.papel !== 'visitante') continue;
        whatsapp.agendarResposta(empresa, lead);
        daEmpresa++;
        n++;
      }
      salvar();
    }
  } catch (err) {
    console.error('[horario-ia]', err.message);
  } finally {
    rodando = false;
  }
  if (n) console.log(`[horario-ia] ${n} cliente(s) que escreveram fora do horário: a IA vai responder agora`);
  return n;
}

// ---------------------------------------------------------------- IA sem crédito / limite

const TESTE_A_CADA_MS = Number(process.env.FILA_IA_TESTE_MS) || 5 * MIN;
const ESPERA_MAX_MS = 24 * 3600 * 1000;
const falhas = new Map(); // empresaId → quando a IA falhou por último (crédito/limite)
const avisadoEm = new Map(); // empresaId → último aviso no sininho (não repete toda hora)

// erro que passa sozinho (ou quando a chave for trocada)? 400 comum e recusa não entram
function vaiEsperar(err) {
  const lista = err?.todas && Array.isArray(err.falhas) ? err.falhas.map((f) => f.err) : [err];
  return lista.some((e) => {
    const st = Number(e?.status) || 0;
    return !st || st === 429 || st >= 500 || [401, 402, 403, 404].includes(st) || /API_KEY_INVALID|API key not valid|quota|exhausted|credit|billing|limite/i.test(String(e?.message || ''));
  });
}

// põe o cliente na fila "esperando a IA voltar"
function esperarIa(empresa, lead, motivo) {
  if (!lead.iaEsperaCota) lead.iaEsperaCota = agora();
  falhas.set(empresa.id, Date.now());
  const ultimoAviso = avisadoEm.get(empresa.id) || 0;
  if (Date.now() - ultimoAviso > 6 * 3600 * 1000) {
    avisadoEm.set(empresa.id, Date.now());
    require('./alertas').registrar(empresa, 'ia-erro', `A IA está sem crédito ou no limite (${String(motivo).slice(0, 160)}). Os clientes ficam esperando e a IA responde sozinha quando voltar.`, { nivel: 'aviso', leadId: lead.id });
  }
  salvar();
}

const esperandoIa = (empresaId) => estado.conversas.filter((l) => l.empresaId === empresaId && l.iaEsperaCota);

let rodandoCota = false;
async function verificarCota() {
  if (rodandoCota) return 0;
  rodandoCota = true;
  let n = 0;
  try {
    const whatsapp = require('./whatsapp');
    for (const empresa of estado.empresas) {
      const fila = esperandoIa(empresa.id).sort((a, b) => (a.iaEsperaCota < b.iaEsperaCota ? -1 : 1));
      if (!fila.length || !iaNoHorario(empresa)) continue;
      if (Date.now() - (falhas.get(empresa.id) || 0) < TESTE_A_CADA_MS) continue; // testa de 5 em 5 min
      let feitos = 0;
      let velhos = 0;
      for (const lead of fila) {
        if (feitos >= POR_MINUTO) break;
        const msgs = (lead.mensagens || []).filter((m) => (m.texto || m.anexo) && !m.apagada && !m.eventoInterno);
        const ultima = msgs[msgs.length - 1];
        // a equipe já respondeu, comprou/agendou, IA pausada…: sai da fila sem responder
        if (ultima?.papel !== 'visitante' || !whatsapp.iaVaiResponder(empresa, lead)) {
          delete lead.iaEsperaCota;
          continue;
        }
        if (Date.now() - new Date(ultima.em).getTime() > ESPERA_MAX_MS) {
          delete lead.iaEsperaCota;
          velhos++;
          continue;
        }
        const antes = falhas.get(empresa.id);
        await whatsapp.responderLead(empresa.id, lead.id, 0, { evento: 'RESPOSTA_ATRASADA' }).catch((err) => console.error(`[fila-ia ${lead.id}]`, err.message));
        if (falhas.get(empresa.id) !== antes) break; // ainda sem crédito: testa de novo daqui a 5 min
        delete lead.iaEsperaCota; // respondeu (ou não precisava mais)
        feitos++;
        n++;
      }
      if (velhos) require('./alertas').registrar(empresa, 'ia-erro', `${velhos} cliente(s) ficaram mais de 24 h sem resposta enquanto a IA estava sem crédito. A IA não responde sozinha tão tarde — confira em Conversas.`, { nivel: 'aviso' });
      salvar();
    }
  } catch (err) {
    console.error('[fila-ia]', err.message);
  } finally {
    rodandoCota = false;
  }
  if (n) console.log(`[fila-ia] a IA voltou: ${n} cliente(s) que ficaram sem resposta foram respondidos`);
  return n;
}

let timer = null;
function iniciar() {
  if (timer) return;
  timer = setInterval(() => {
    verificar();
    verificarCota().catch(() => {});
  }, Number(process.env.EXPEDIENTE_MS) || MIN);
  timer.unref?.();
}

// painel: lê e salva
function paraPainel(empresa) {
  const e = janelaEnvio(empresa);
  const c = configIa(empresa);
  return {
    envio: { inicio: textoDe(e.inicio), fim: textoDe(e.fim) },
    ia: { ativo: c.ativo, inicio: textoDe(c.inicio), fim: textoDe(c.fim), esperando: estado.conversas.filter((l) => l.empresaId === empresa.id && l.iaEsperaHorario).length, esperandoCredito: esperandoIa(empresa.id).length }
  };
}

function lerJanela(b, nome) {
  const inicio = minutosDe(b?.inicio);
  const fim = minutosDe(b?.fim);
  if (inicio === null || fim === null) throw Object.assign(new Error(`${nome}: use horas como 08:00 e 20:00.`), { status: 400 });
  if (inicio === fim) throw Object.assign(new Error(`${nome}: o começo e o fim não podem ser iguais.`), { status: 400 });
  return { inicio: textoDe(inicio), fim: textoDe(fim) };
}

function salvarPainel(empresa, b = {}) {
  if (b.envio) empresa.horarioEnvio = lerJanela(b.envio, 'Horário dos envios');
  if (b.ia) {
    const j = lerJanela(b.ia, 'Horário da IA');
    empresa.expedienteIa = { ativo: b.ia.ativo === true, ...j };
    // desligou: quem estava esperando é respondido no próximo minuto
  }
  salvar();
  return paraPainel(empresa);
}

module.exports = { vaiEsperar, esperarIa, verificarCota, minutosDe, janelaEnvio, configIa, dentro, proximaAbertura, somarNoHorario, vencimento, iaNoHorario, descreverIa, esperarHorario, verificar, iniciar, paraPainel, salvarPainel };
