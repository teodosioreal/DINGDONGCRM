// midias.js — biblioteca de mídias de cada empresa (fotos, vídeos, PDFs,
// áudios) que a IA do WhatsApp pode enviar. Os arquivos ficam em disco e são
// servidos num endereço público com id aleatório, porque o WhatsApp (Evolution
// API) precisa baixar o arquivo por URL para enviar.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { estado, salvar, agora } = require('./db');

const TAMANHO_MAXIMO = 16 * 1024 * 1024; // limite do WhatsApp para a maioria das mídias

const TIPOS = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'application/pdf': 'document'
};

const EXTENSOES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function garantirPasta() {
  fs.mkdirSync(config.midiasDir, { recursive: true });
}

function nomeArquivoSeguro(nome) {
  const base = path.basename(String(nome || 'arquivo'))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'arquivo';
}

function mimeDe(nomeArquivo, informado) {
  const ext = path.extname(nomeArquivo).toLowerCase();
  if (EXTENSOES[ext]) return EXTENSOES[ext];
  if (informado && informado !== 'application/octet-stream') return informado;
  return 'application/octet-stream';
}

function midiasDa(empresa) {
  return empresa.midias || [];
}

function salvarMidia(empresa, { buffer, nomeArquivo, nome, descricao, mimetypeInformado }) {
  if (!buffer?.length) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });
  if (buffer.length > TAMANHO_MAXIMO) throw Object.assign(new Error('Arquivo maior que 16 MB (limite do WhatsApp).'), { status: 413 });
  const arquivo = nomeArquivoSeguro(nomeArquivo);
  const mimetype = mimeDe(arquivo, mimetypeInformado);
  const id = crypto.randomBytes(12).toString('hex');
  garantirPasta();
  fs.writeFileSync(path.join(config.midiasDir, `${id}${path.extname(arquivo).toLowerCase()}`), buffer);
  const midia = {
    id,
    nome: String(nome || path.parse(arquivo).name).trim().slice(0, 80),
    descricao: String(descricao || '').trim().slice(0, 300),
    arquivo,
    mimetype,
    tipo: TIPOS[mimetype] || 'document',
    tamanho: buffer.length,
    criadoEm: agora()
  };
  empresa.midias = midiasDa(empresa);
  empresa.midias.push(midia);
  salvar();
  return midia;
}

function caminhoDoArquivo(midia) {
  return path.join(config.midiasDir, `${midia.id}${path.extname(midia.arquivo).toLowerCase()}`);
}

function apagarMidia(empresa, midiaId) {
  const i = midiasDa(empresa).findIndex((m) => m.id === midiaId);
  if (i < 0) return false;
  const [midia] = empresa.midias.splice(i, 1);
  try {
    fs.unlinkSync(caminhoDoArquivo(midia));
  } catch {
    /* já não existia */
  }
  salvar();
  return true;
}

function apagarTodasDa(empresa) {
  for (const m of midiasDa(empresa)) {
    try {
      fs.unlinkSync(caminhoDoArquivo(m));
    } catch {
      /* ignora */
    }
  }
}

// Endereço público do arquivo (o WhatsApp baixa daqui)
function urlPublica(midia) {
  return `${config.urlPublica}/midia/${midia.id}/${encodeURIComponent(midia.arquivo)}`;
}

function acharPorId(id) {
  for (const e of estado.empresas) {
    const m = midiasDa(e).find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

// A IA escreve [[MIDIA: nome]]; acha pelo nome sem ligar para maiúsculas/acentos
function acharPorNome(empresa, nome) {
  const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const alvo = limpar(nome);
  return midiasDa(empresa).find((m) => limpar(m.nome) === alvo) || null;
}

module.exports = {
  TAMANHO_MAXIMO,
  midiasDa,
  salvarMidia,
  apagarMidia,
  apagarTodasDa,
  caminhoDoArquivo,
  urlPublica,
  acharPorId,
  acharPorNome
};
