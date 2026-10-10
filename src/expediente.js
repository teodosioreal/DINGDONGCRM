// expediente.js — horários da empresa (Brasília), por empresa, só código (sem IA).
//
//   • Envios automáticos (follow-up e automações): padrão 8h–20h. Fora dele nada sai;
//     no follow-up a contagem PAUSA quando fecha e continua quando abre (passos de
//     menos de 1 dia). Passos de 1 dia ou mais contam dias corridos e, se caírem
//     fora do horário, saem quando abrir.
//   • Horário da IA responder (desligado por padrão): mensagem que chega fora dele
//     fica esperando e a IA responde quando o horário abrir (alguns por minuto).

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

let timer = null;
function iniciar() {
  if (timer) return;
  timer = setInterval(verificar, Number(process.env.EXPEDIENTE_MS) || MIN);
  timer.unref?.();
}

// painel: lê e salva
function paraPainel(empresa) {
  const e = janelaEnvio(empresa);
  const c = configIa(empresa);
  return {
    envio: { inicio: textoDe(e.inicio), fim: textoDe(e.fim) },
    ia: { ativo: c.ativo, inicio: textoDe(c.inicio), fim: textoDe(c.fim), esperando: estado.conversas.filter((l) => l.empresaId === empresa.id && l.iaEsperaHorario).length }
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

module.exports = { minutosDe, janelaEnvio, configIa, dentro, proximaAbertura, somarNoHorario, vencimento, iaNoHorario, descreverIa, esperarHorario, verificar, iniciar, paraPainel, salvarPainel };
