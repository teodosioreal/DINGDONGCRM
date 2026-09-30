// video.js — deixa todo vídeo da biblioteca pronto para o WhatsApp.
//
// O WhatsApp só toca direito MP4 com vídeo H.264 e áudio AAC. Vídeo de iPhone
// (.mov / HEVC), .webm, .mkv, .avi ou um MP4 muito pesado chegam ao cliente
// como "arquivo" ou nem saem. Por isso, ao subir um vídeo, o CRM confere o
// formato e, se precisar, converte sozinho (em segundo plano, um por vez) para
// MP4 H.264 até 720p e ~15 MB, com início rápido (faststart). Enquanto converte,
// a mídia aparece como "convertendo…" e a IA ainda não a usa.
//
// Usa o ffmpeg do sistema (ou FFMPEG_PATH, ou o pacote ffmpeg-static). Sem
// ffmpeg, o vídeo continua na categoria Vídeos e é enviado como está; se o
// WhatsApp recusar, vai como arquivo (documento) para o cliente receber mesmo assim.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { estado, salvar, agora } = require('./db');

const LIMITE_WHATSAPP = 16 * 1024 * 1024; // acima disso muitos celulares recebem como arquivo
const ALVO_BYTES = 15 * 1024 * 1024;
const LARGURA_MAX = 1280;
const TEMPO_MAX_MS = 20 * 60 * 1000;

let caminhoFfmpeg; // undefined = ainda não procurou; null = não tem
function ffmpeg() {
  if (caminhoFfmpeg !== undefined) return caminhoFfmpeg;
  const candidatos = [process.env.FFMPEG_PATH, 'ffmpeg'];
  try {
    candidatos.push(require('ffmpeg-static')); // opcional
  } catch {
    /* não instalado */
  }
  caminhoFfmpeg = null;
  for (const c of candidatos.filter(Boolean)) {
    try {
      if (spawnSync(c, ['-version'], { timeout: 10000 }).status === 0) {
        caminhoFfmpeg = c;
        break;
      }
    } catch {
      /* tenta o próximo */
    }
  }
  return caminhoFfmpeg;
}

function disponivel() {
  return Boolean(ffmpeg());
}

function rodar(args, { tempo = TEMPO_MAX_MS } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let saida = '';
    p.stderr.on('data', (d) => {
      saida += d;
      if (saida.length > 200000) saida = saida.slice(-100000);
    });
    const t = setTimeout(() => p.kill('SIGKILL'), tempo);
    p.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    p.on('close', (codigo) => {
      clearTimeout(t);
      resolve({ codigo, saida });
    });
  });
}

// Lê duração, codecs e tamanho da imagem pela saída do "ffmpeg -i"
async function examinar(arquivo) {
  const { saida } = await rodar(['-hide_banner', '-i', arquivo], { tempo: 60000 });
  const d = saida.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = saida.match(/Stream #\S+.*?Video:\s*([\w-]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  const a = saida.match(/Stream #\S+.*?Audio:\s*([\w-]+)/);
  return {
    duracao: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    video: v ? v[1].toLowerCase() : '',
    largura: v ? Number(v[2]) : 0,
    altura: v ? Number(v[3]) : 0,
    audio: a ? a[1].toLowerCase() : '',
    container: (saida.match(/Input #0,\s*([^,]+)/) || [])[1] || ''
  };
}

// Já está no formato que o WhatsApp toca?
function jaCompativel(midia, info) {
  return (
    midia.mimetype === 'video/mp4' &&
    info.video === 'h264' &&
    (!info.audio || info.audio === 'aac') &&
    midia.tamanho <= LIMITE_WHATSAPP &&
    Math.max(info.largura, info.altura) <= 1920
  );
}

function argsConversao(entrada, saida, info) {
  const audioKbps = info.audio ? 96 : 0;
  // bitrate para caber em ~15 MB (entre 350 kbps e 2,5 Mbps)
  let videoKbps = 2500;
  if (info.duracao > 0) videoKbps = Math.floor((ALVO_BYTES * 8) / info.duracao / 1000) - audioKbps;
  videoKbps = Math.max(350, Math.min(2500, videoKbps));
  return [
    '-hide_banner', '-y', '-i', entrada,
    '-map', '0:v:0', '-map', '0:a:0?',
    // até 1280 no lado maior, sem distorcer (medidas pares, exigência do H.264)
    '-vf', `scale='if(gte(iw,ih),min(${LARGURA_MAX},iw),-2)':'if(gte(iw,ih),-2,min(${LARGURA_MAX},ih))',format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
    // qualidade constante (não incha vídeo leve) com teto de bitrate (não passa de ~15 MB)
    '-crf', '23', '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
    ...(info.audio ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ac', '2'] : ['-an']),
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
    saida
  ];
}

function acharEmpresaDa(midiaId) {
  return estado.empresas.find((e) => (e.midias || []).some((m) => m.id === midiaId));
}

// Confere e, se precisar, converte. Nunca lança erro: registra na mídia.
async function preparar(midiaId) {
  const midias = require('./midias');
  const empresa = acharEmpresaDa(midiaId);
  const midia = empresa?.midias.find((m) => m.id === midiaId);
  if (!midia || midia.tipo !== 'video') return;
  if (!disponivel()) {
    delete midia.processando;
    midia.videoOk = midia.mimetype === 'video/mp4' && midia.tamanho <= LIMITE_WHATSAPP;
    if (!midia.videoOk) midia.avisoVideo = 'Este vídeo não é MP4 leve: o WhatsApp pode entregar como arquivo. Para tocar direto na conversa, exporte em MP4 720p.';
    salvar();
    return;
  }
  const origem = midias.caminhoDoArquivo(midia);
  const temp = path.join(path.dirname(origem), `.conv-${midia.id}.mp4`);
  try {
    const info = await examinar(origem);
    if (!info.video) throw new Error('não achei a imagem do vídeo (arquivo corrompido ou formato desconhecido)');
    midia.duracao = Math.round(info.duracao) || undefined;
    if (jaCompativel(midia, info)) {
      midia.videoOk = true;
      delete midia.processando;
      delete midia.erroVideo;
      delete midia.avisoVideo;
      salvar();
      return;
    }
    midia.processando = true;
    salvar();
    const inicio = Date.now();
    const r = await rodar(argsConversao(origem, temp, info));
    if (r.codigo !== 0 || !fs.existsSync(temp) || fs.statSync(temp).size < 1000) {
      const linha = r.saida.trim().split('\n').slice(-2).join(' ').slice(0, 200);
      throw new Error(`o ffmpeg não conseguiu converter (${linha || `código ${r.codigo}`})`);
    }
    // a mídia pode ter sido apagada enquanto convertia
    if (!(empresa.midias || []).includes(midia)) return fs.rmSync(temp, { force: true });
    const antes = { mimetype: midia.mimetype, tamanho: midia.tamanho, arquivo: midia.arquivo };
    const novoNome = `${path.parse(midia.arquivo).name}.mp4`;
    const destino = path.join(path.dirname(origem), `${midia.id}.mp4`);
    fs.renameSync(temp, destino);
    if (destino !== origem) fs.rmSync(origem, { force: true });
    Object.assign(midia, {
      arquivo: novoNome,
      mimetype: 'video/mp4',
      tamanho: fs.statSync(destino).size,
      videoOk: true,
      convertido: { de: antes.mimetype, tamanhoAntes: antes.tamanho, em: agora(), segundos: Math.round((Date.now() - inicio) / 1000) }
    });
    delete midia.processando;
    delete midia.erroVideo;
    delete midia.avisoVideo;
    salvar();
    console.log(`[video] ${midia.codigo}: ${antes.arquivo} (${(antes.tamanho / 1048576).toFixed(1)} MB) → MP4 ${(midia.tamanho / 1048576).toFixed(1)} MB`);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    delete midia.processando;
    midia.videoOk = false;
    midia.erroVideo = `Não consegui preparar o vídeo: ${err.message}`.slice(0, 300);
    salvar();
    console.error(`[video] ${midia.codigo}:`, err.message);
    require('./alertas').registrar(empresa, 'midia', `O vídeo "${midia.codigo || midia.nome}" não pôde ser convertido para o WhatsApp: ${err.message}. Ele será enviado como arquivo.`, { nivel: 'aviso' });
  }
}

// Fila: um vídeo por vez para não pesar a VPS
const fila = [];
let rodando = false;
function enfileirar(midia) {
  if (!midia || midia.tipo !== 'video' || fila.includes(midia.id)) return;
  if (disponivel()) {
    midia.processando = true; // já some da IA até conferir
    salvar();
  }
  fila.push(midia.id);
  proximo();
}

async function proximo() {
  if (rodando) return;
  rodando = true;
  try {
    while (fila.length) {
      const id = fila.shift();
      await preparar(id);
    }
  } finally {
    rodando = false;
  }
}

// Ao ligar: vídeos que ficaram no meio da conversão ou ainda não conferidos
function revisarPendentes() {
  const midias = require('./midias');
  for (const e of estado.empresas) for (const m of midias.midiasDa(e)) if (m.tipo === 'video' && (m.processando || m.videoOk === undefined)) enfileirar(m);
}

function situacao() {
  return { ffmpeg: disponivel(), naFila: fila.length, convertendo: rodando };
}

module.exports = { disponivel, enfileirar, revisarPendentes, preparar, situacao, examinar, LIMITE_WHATSAPP };
