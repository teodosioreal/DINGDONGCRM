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

function salvarMidia(empresa, { buffer, nomeArquivo, nome, descricao, mimetypeInformado, extra = {} }) {
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
    criadoEm: agora(),
    ...extra
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

const limpar = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// A IA escreve [[MIDIA: nome]]; acha pelo nome sem ligar para maiúsculas/acentos
function acharPorNome(empresa, nome) {
  const alvo = limpar(nome);
  return midiasDa(empresa).find((m) => !m.pastaId && limpar(m.nome) === alvo) || null;
}

// Nome de uma mídia OU de um álbum (pasta do Google Drive) → lista de arquivos
const MAX_POR_ALBUM = 10;
function acharParaEnviar(empresa, nome) {
  const avulsa = acharPorNome(empresa, nome);
  if (avulsa) return [avulsa];
  const alvo = limpar(nome);
  const pasta = pastasDa(empresa).find((p) => limpar(p.nome) === alvo);
  if (!pasta) return [];
  return midiasDa(empresa).filter((m) => m.pastaId === pasta.id).slice(0, MAX_POR_ALBUM);
}

// O que a IA vê: mídias avulsas + cada pasta do Drive como um álbum
function paraIa(empresa) {
  const avulsas = midiasDa(empresa)
    .filter((m) => !m.pastaId)
    .map((m) => ({ nome: m.nome, descricao: m.descricao }));
  const albuns = pastasDa(empresa)
    .map((p) => ({ nome: p.nome, descricao: p.descricao, album: true, quantidade: midiasDa(empresa).filter((m) => m.pastaId === p.id).length }))
    .filter((a) => a.quantidade > 0);
  return [...avulsas, ...albuns];
}

// ---------------------------------------------------------------- links

function linksDa(empresa) {
  return Array.isArray(empresa.links) ? empresa.links : [];
}

// ---------------------------------------------------------------- Google Drive (pastas públicas)
// A empresa cola o link de uma pasta compartilhada ("qualquer pessoa com o
// link"). O CRM lista os arquivos, baixa as fotos/vídeos/PDFs e mantém a pasta
// sincronizada. Cada pasta vira um "álbum" que a IA pode mandar pelo nome.

const DRIVE = (process.env.DRIVE_BASE_URL || 'https://drive.google.com').replace(/\/+$/, '');
const DRIVE_API = (process.env.DRIVE_API_URL || 'https://www.googleapis.com/drive/v3').replace(/\/+$/, '');
const DRIVE_MAX_ARQUIVOS = 60;

function pastasDa(empresa) {
  return Array.isArray(empresa.drivePastas) ? empresa.drivePastas : [];
}

function idDaPasta(link) {
  const t = String(link || '').trim();
  const m = t.match(/\/folders\/([\w-]{10,})/) || t.match(/[?&]id=([\w-]{10,})/) || t.match(/^([\w-]{20,})$/);
  return m ? m[1] : '';
}

function desescapar(t) {
  return String(t)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// Lista os arquivos da pasta pela página pública do Drive (sem chave)
async function listarPastaPublica(pastaId) {
  const res = await fetch(`${DRIVE}/embeddedfolderview?id=${encodeURIComponent(pastaId)}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw Object.assign(new Error(`O Google Drive respondeu ${res.status}.`), { status: 502 });
  const html = await res.text();
  const titulo = desescapar((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').replace(/\s*-\s*Google Drive\s*$/i, '');
  const arquivos = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]*)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    if (/\/folders\//.test(m[2])) continue; // subpastas ficam de fora
    arquivos.push({ id: m[1], nome: desescapar(m[3]) });
  }
  return { titulo, arquivos };
}

// Plano B: API do Drive com a chave do Google da empresa (se a API estiver ativa)
async function listarPastaApi(pastaId, chaveGoogle) {
  const q = encodeURIComponent(`'${pastaId}' in parents and trashed = false`);
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,mimeType)&pageSize=200&key=${encodeURIComponent(chaveGoogle)}`, {
    signal: AbortSignal.timeout(30000)
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados?.error?.message || `HTTP ${res.status}`);
  return {
    titulo: '',
    arquivos: (dados.files || []).filter((f) => f.mimeType !== 'application/vnd.google-apps.folder').map((f) => ({ id: f.id, nome: f.name }))
  };
}

async function baixarDoDrive(arquivoId) {
  const res = await fetch(`${DRIVE}/uc?export=download&id=${encodeURIComponent(arquivoId)}`, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  const tipo = res.headers.get('content-type') || '';
  if (!res.ok || /text\/html/i.test(tipo)) throw new Error('arquivo não público ou grande demais');
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, tipo: tipo.split(';')[0] };
}

const EXT_ACEITAS = /\.(jpe?g|png|webp|gif|mp4|3gp|mp3|ogg|opus|m4a|aac|pdf)$/i;

// Adiciona ou sincroniza uma pasta. Retorna o resumo do que mudou.
async function sincronizarPasta(empresa, { link, nome, descricao, pastaExistente, chaveGoogle }) {
  const pastaId = pastaExistente?.driveId || idDaPasta(link);
  if (!pastaId) throw Object.assign(new Error('Link de pasta do Google Drive inválido. Copie o link da pasta (drive.google.com/drive/folders/…).'), { status: 400 });
  let lista;
  try {
    lista = await listarPastaPublica(pastaId);
    if (!lista.arquivos.length && chaveGoogle) lista = await listarPastaApi(pastaId, chaveGoogle).catch(() => lista);
  } catch (err) {
    if (!chaveGoogle) throw Object.assign(new Error(`Não consegui abrir a pasta do Drive (${err.message}). Confira se ela está compartilhada como "Qualquer pessoa com o link".`), { status: 400 });
    lista = await listarPastaApi(pastaId, chaveGoogle);
  }
  if (!lista.arquivos.length) {
    throw Object.assign(new Error('A pasta está vazia ou não está pública. No Drive: botão direito na pasta → Compartilhar → "Qualquer pessoa com o link".'), { status: 400 });
  }
  empresa.drivePastas = pastasDa(empresa);
  let pasta = pastaExistente;
  if (!pasta) {
    pasta = {
      id: crypto.randomBytes(8).toString('hex'),
      driveId: pastaId,
      nome: String(nome || lista.titulo || 'Fotos do Drive').trim().slice(0, 80),
      descricao: String(descricao || '').trim().slice(0, 300),
      criadoEm: agora()
    };
    empresa.drivePastas.push(pasta);
  }
  const noDrive = lista.arquivos.filter((a) => EXT_ACEITAS.test(a.nome)).slice(0, DRIVE_MAX_ARQUIVOS);
  const idsNoDrive = new Set(noDrive.map((a) => a.id));
  let adicionados = 0;
  let removidos = 0;
  const falhas = [];
  // saíram do Drive → saem do CRM
  for (const m of midiasDa(empresa).filter((x) => x.pastaId === pasta.id && !idsNoDrive.has(x.driveId))) {
    apagarMidia(empresa, m.id);
    removidos++;
  }
  const jaTem = new Set(midiasDa(empresa).filter((x) => x.pastaId === pasta.id).map((x) => x.driveId));
  for (const a of noDrive) {
    if (jaTem.has(a.id)) continue;
    try {
      const { buffer, tipo } = await baixarDoDrive(a.id);
      salvarMidia(empresa, {
        buffer,
        nomeArquivo: a.nome,
        nome: `${pasta.nome} · ${path.parse(a.nome).name}`.slice(0, 80),
        descricao: '',
        mimetypeInformado: tipo,
        extra: { pastaId: pasta.id, driveId: a.id, origem: 'drive' }
      });
      adicionados++;
    } catch (err) {
      falhas.push(`${a.nome}: ${err.message}`);
    }
  }
  pasta.ultimaSincronia = agora();
  pasta.total = midiasDa(empresa).filter((x) => x.pastaId === pasta.id).length;
  pasta.falhas = falhas.slice(0, 10);
  salvar();
  return { pasta, adicionados, removidos, falhas };
}

function apagarPasta(empresa, pastaId) {
  for (const m of midiasDa(empresa).filter((x) => x.pastaId === pastaId)) apagarMidia(empresa, m.id);
  empresa.drivePastas = pastasDa(empresa).filter((p) => p.id !== pastaId);
  salvar();
}

// ---------------------------------------------------------------- anexos das conversas
// Arquivos que o cliente mandou (ou a equipe mandou pelo painel). Ficam fora
// da pasta pública: só o painel (com login) consegue abrir.

function pastaAnexos(leadId) {
  return path.join(config.midiasDir, 'conversas', String(leadId).replace(/[^\w-]/g, ''));
}

const EXT_DO_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'application/pdf': '.pdf'
};

function salvarAnexo(leadId, buffer, mimetype, nomeOriginal) {
  const mime = String(mimetype || '').split(';')[0].trim() || 'application/octet-stream';
  const ext = EXT_DO_MIME[mime] || path.extname(String(nomeOriginal || '')).toLowerCase().replace(/[^.\w]/g, '').slice(0, 6) || '.bin';
  const arquivo = `${crypto.randomBytes(10).toString('hex')}${ext}`;
  fs.mkdirSync(pastaAnexos(leadId), { recursive: true });
  fs.writeFileSync(path.join(pastaAnexos(leadId), arquivo), buffer);
  return { arquivo, mimetype: mime, tipo: TIPOS[mime] || (mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document'), nome: String(nomeOriginal || '').slice(0, 120), tamanho: buffer.length };
}

function caminhoAnexo(leadId, arquivo) {
  if (!/^[a-f0-9]{20}\.[\w]{1,6}$/.test(String(arquivo))) return null;
  return path.join(pastaAnexos(leadId), arquivo);
}

function apagarAnexosDoLead(leadId) {
  try {
    fs.rmSync(pastaAnexos(leadId), { recursive: true, force: true });
  } catch {
    /* ignora */
  }
}

module.exports = {
  TAMANHO_MAXIMO,
  TIPOS,
  acharParaEnviar,
  paraIa,
  linksDa,
  pastasDa,
  idDaPasta,
  sincronizarPasta,
  apagarPasta,
  salvarAnexo,
  caminhoAnexo,
  apagarAnexosDoLead,
  mimeDe,
  midiasDa,
  salvarMidia,
  apagarMidia,
  apagarTodasDa,
  caminhoDoArquivo,
  urlPublica,
  acharPorId,
  acharPorNome
};
