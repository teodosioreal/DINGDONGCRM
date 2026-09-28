// db.js — "banco" em arquivo JSON, no mesmo espírito do painel de ofertas:
// sem dependências nativas, fácil de fazer backup (é só copiar data.json).
//
// A gravação é atômica (escreve num arquivo temporário e renomeia), então uma
// queda no meio da escrita não corrompe o banco.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');

function estadoInicial() {
  return {
    usuarios: [],
    sessoes: [],
    empresas: [],
    bots: [],
    conversas: [],
    // disparos em massa pelo WhatsApp (campanhas)
    disparos: [],
    // chaves de IA cadastradas pelo painel: { anthropicApiKey, geminiApiKey }
    config: {},
    // uso diário por assistente: { [botId]: { data: 'AAAA-MM-DD', mensagens: n } }
    uso: {}
  };
}

function carregar() {
  if (!fs.existsSync(dbPath)) return estadoInicial();
  try {
    const dados = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return { ...estadoInicial(), ...dados };
  } catch (err) {
    const copia = `${dbPath}.corrompido-${Date.now()}`;
    fs.copyFileSync(dbPath, copia);
    console.error(`Aviso: data.json ilegível (${err.message}). Cópia salva em ${copia}; começando vazio.`);
    return estadoInicial();
  }
}

const estado = carregar();

let agendado = null;
function salvar() {
  // agrupa várias escritas seguidas numa só gravação em disco
  if (agendado) return;
  agendado = setImmediate(() => {
    agendado = null;
    const tmp = `${dbPath}.tmp`;
    // só o dono do processo lê: o arquivo guarda senhas (hash) e chaves de API
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, dbPath);
  });
}

function salvarAgora() {
  if (agendado) {
    clearImmediate(agendado);
    agendado = null;
  }
  const tmp = `${dbPath}.tmp`;
  // só o dono do processo lê: o arquivo guarda senhas (hash) e chaves de API
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dbPath);
}

function novoId(prefixo) {
  return `${prefixo}_${crypto.randomBytes(8).toString('hex')}`;
}

function agora() {
  return new Date().toISOString();
}

module.exports = { estado, salvar, salvarAgora, novoId, agora };
