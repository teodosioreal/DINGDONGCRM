// reconexao.js — quando o WhatsApp cai por um motivo recuperável (queda de
// rede, "restart exigido" do próprio WhatsApp etc.), espera um pouco e confere
// se voltou sozinha; se não voltar depois de algumas checagens, reinicia o
// socket (sem apagar sessão nem pedir QR novo). Backoff crescente (5s, 15s,
// 30s, 60s, depois de 60 em 60s) pra não virar flood de chamada na Evolution
// quando a internet fica instável e manda vários "close" seguidos.
//
// Motivo "sessão encerrada pelo WhatsApp" (loggedOut, conectou em outro
// aparelho, excedeu o limite de aparelhos vinculados) não entra aqui:
// reiniciar o socket não resolve, só escaneando o QR de novo — o aviso já
// fica no sininho (alertas.js).

const SEQUENCIA_BACKOFF_MS = (process.env.RECONEXAO_BACKOFF_MS || '5000,15000,30000,60000')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const TENTATIVAS_ATE_RESTART = Number(process.env.RECONEXAO_RESTART_APOS) || 4;
const MOTIVOS_SEM_VOLTA = new Set([401, 403, 411, 440]); // loggedOut, forbidden, multideviceMismatch, connectionReplaced

const emAcompanhamento = new Map(); // empresaId -> { tentativas, timer, restartTentado }

function parar(empresaId) {
  const a = emAcompanhamento.get(empresaId);
  if (a?.timer) clearTimeout(a.timer);
  emAcompanhamento.delete(empresaId);
}

function proximoIntervalo(tentativas) {
  return SEQUENCIA_BACKOFF_MS[Math.min(tentativas, SEQUENCIA_BACKOFF_MS.length - 1)];
}

async function checar(empresaId) {
  const acomp = emAcompanhamento.get(empresaId);
  if (!acomp) return; // já parou (voltou sozinha via webhook, ou a empresa sumiu)
  const whatsapp = require('./whatsapp');
  const { estado } = require('./db');
  const empresa = estado.empresas.find((e) => e.id === empresaId);
  if (!empresa || !whatsapp.configurado(empresa)) return parar(empresaId);

  let conectada = false;
  try {
    const r = await whatsapp.evolucao(empresa, 'GET', '/instance/connectionState/{instancia}');
    conectada = (r?.instance?.state || r?.state) === 'open';
  } catch (err) {
    console.error(`[reconexao ${empresaId}] checagem:`, err.message);
  }

  if (conectada) {
    console.log(`[reconexao ${empresaId}] voltou sozinha depois de ${acomp.tentativas + 1} checagem(ns).`);
    return parar(empresaId);
  }

  acomp.tentativas += 1;
  if (acomp.tentativas === TENTATIVAS_ATE_RESTART && !acomp.restartTentado) {
    acomp.restartTentado = true;
    console.log(`[reconexao ${empresaId}] ainda fora do ar após ${acomp.tentativas} checagens -- reiniciando o socket (sem apagar sessão).`);
    await whatsapp.reiniciarSocket(empresa);
  }
  acomp.timer = setTimeout(() => checar(empresaId), proximoIntervalo(acomp.tentativas));
  acomp.timer.unref?.();
  emAcompanhamento.set(empresaId, acomp);
}

// Chamado pelo webhook quando a conexão caiu (state=close, depois de ter
// estado "open"). Decide sozinho se vale a pena vigiar e tentar reconectar.
function registrarQueda(empresa, motivoCodigo) {
  if (MOTIVOS_SEM_VOLTA.has(Number(motivoCodigo))) return;
  if (emAcompanhamento.has(empresa.id)) return; // já tem um ciclo rodando pra essa empresa
  const acomp = { tentativas: 0, timer: null, restartTentado: false };
  acomp.timer = setTimeout(() => checar(empresa.id), SEQUENCIA_BACKOFF_MS[0]);
  acomp.timer.unref?.();
  emAcompanhamento.set(empresa.id, acomp);
  console.log(`[reconexao ${empresa.id}] conexão caiu (motivo ${motivoCodigo ?? '?'}) -- 1ª checagem em ${SEQUENCIA_BACKOFF_MS[0] / 1000}s.`);
}

// Chamado pelo webhook quando a conexão volta (state=open): encerra o acompanhamento.
function registrarVolta(empresa) {
  parar(empresa.id);
}

module.exports = { registrarQueda, registrarVolta };
