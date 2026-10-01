// fotos-clientes.js — foto de perfil do WhatsApp de cada cliente no CRM.
//
// A Evolution devolve o link da foto (/chat/fetchProfilePictureUrl), mas esse
// link do WhatsApp expira em poucos dias. Por isso o CRM baixa a foto e guarda
// junto com os anexos do lead (fora da pasta pública: só o painel, com login,
// abre). Atualiza a cada 7 dias; se o cliente não tem foto (ou esconde pela
// privacidade), tenta de novo em 3 dias. Uma busca por vez, com intervalo,
// para não parecer robô para o WhatsApp.

const fs = require('fs');
const path = require('path');
const { estado, salvar, agora } = require('./db');

const RENOVAR_MS = 7 * 24 * 3600 * 1000;
const SEM_FOTO_MS = 3 * 24 * 3600 * 1000;
const ERRO_MS = 6 * 3600 * 1000; // falhou (servidor fora, limite): tenta de novo em 6 h
const INTERVALO_MS = Number(process.env.FOTOS_INTERVALO_MS) || 2500;
const MAX_BYTES = 3 * 1024 * 1024;
const POR_VARREDURA = 150;

const pastaDoLead = (leadId) => require('./midias').pastaAnexosDoLead(leadId);
const caminhoDaFoto = (lead) => path.join(pastaDoLead(lead.id), 'perfil.jpg');

function temFoto(lead) {
  return Boolean(lead.fotoPerfil?.em && !lead.fotoPerfil.semFoto);
}

// Número de verdade do cliente (nunca o id interno "@lid" do WhatsApp)
function numeroDoLead(lead) {
  if (/@s\.whatsapp\.net$/.test(lead.whatsappJid || '')) return lead.whatsappJid.split('@')[0];
  const tel = String(lead.telefone || '').replace(/\D/g, '');
  return lead.whatsappJid && tel.length >= 12 ? tel : '';
}

function precisaBuscar(lead) {
  if (!numeroDoLead(lead)) return false;
  const f = lead.fotoPerfil;
  if (!f?.buscadaEm) return true;
  const idade = Date.now() - new Date(f.buscadaEm).getTime();
  return idade > (f.erro && !f.em ? ERRO_MS : f.semFoto ? SEM_FOTO_MS : RENOVAR_MS);
}

async function baixar(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tipo = res.headers.get('content-type') || '';
  if (!/^image\//i.test(tipo)) throw new Error(`não é imagem (${tipo || 'sem tipo'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('foto vazia ou grande demais');
  return buf;
}

// Busca agora (usado pela fila e pelo botão "Atualizar foto")
async function buscar(lead) {
  const whatsapp = require('./whatsapp');
  const empresa = estado.empresas.find((e) => e.id === lead.empresaId);
  const numero = numeroDoLead(lead);
  if (!empresa || !whatsapp.configurado(empresa) || !numero) return { ok: false, motivo: 'sem WhatsApp' };
  try {
    const r = await whatsapp.evolution(empresa, 'POST', '/chat/fetchProfilePictureUrl/{instancia}', { number: numero });
    const url = r?.profilePictureUrl || r?.profilePicUrl || '';
    if (!url) {
      lead.fotoPerfil = { semFoto: true, buscadaEm: agora() };
      fs.rmSync(caminhoDaFoto(lead), { force: true });
      salvar();
      return { ok: true, temFoto: false };
    }
    const buf = await baixar(url);
    fs.mkdirSync(pastaDoLead(lead.id), { recursive: true });
    const tmp = `${caminhoDaFoto(lead)}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, caminhoDaFoto(lead));
    lead.fotoPerfil = { em: agora(), buscadaEm: agora(), tamanho: buf.length };
    salvar();
    return { ok: true, temFoto: true };
  } catch (err) {
    // falha momentânea: mantém a foto antiga (se houver) e tenta mais tarde
    lead.fotoPerfil = { ...(lead.fotoPerfil || {}), buscadaEm: agora(), erro: String(err.message).slice(0, 120) };
    salvar();
    return { ok: false, motivo: err.message };
  }
}

// ---------------------------------------------------------------- fila
const fila = [];
let rodando = false;

function agendar(lead) {
  if (!lead || fila.includes(lead.id) || !precisaBuscar(lead)) return;
  fila.push(lead.id);
  proximo();
}

async function proximo() {
  if (rodando) return;
  rodando = true;
  try {
    while (fila.length) {
      const lead = estado.conversas.find((c) => c.id === fila[0]);
      fila.shift();
      if (lead && precisaBuscar(lead)) {
        await buscar(lead);
        await new Promise((r) => setTimeout(r, INTERVALO_MS));
      }
    }
  } finally {
    rodando = false;
  }
}

// Clientes que conversaram nos últimos 60 dias e ainda não têm foto (ou está velha)
function varrer() {
  const limite = Date.now() - 60 * 24 * 3600 * 1000;
  estado.conversas
    .filter((c) => c.whatsappJid && new Date(c.atualizadoEm).getTime() > limite && precisaBuscar(c))
    .sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1))
    .slice(0, POR_VARREDURA)
    .forEach(agendar);
}

let timer = null;
function iniciar() {
  if (timer || process.env.FOTOS_CLIENTES === 'nao') return;
  setTimeout(varrer, 20000).unref?.();
  timer = setInterval(varrer, 6 * 3600 * 1000);
  timer.unref?.();
}

// Endereço para o painel (muda quando a foto muda, para o navegador não usar a velha)
function urlDaFoto(lead) {
  return temFoto(lead) ? `api/leads/${encodeURIComponent(lead.id)}/foto?v=${encodeURIComponent(lead.fotoPerfil.em)}` : '';
}

module.exports = { agendar, buscar, varrer, iniciar, urlDaFoto, caminhoDaFoto, temFoto };
