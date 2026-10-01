// video.js — deixa todo vídeo da biblioteca pronto para o WhatsApp.
//
// QUALIDADE MÁXIMA: o CRM nunca diminui o vídeo. O WhatsApp só toca na conversa
// MP4 com vídeo H.264 (e áudio AAC); o resto chega como "arquivo" ou nem sai.
// Ao subir um vídeo, o CRM confere (em segundo plano, um por vez):
//   - já é MP4 H.264 → fica exatamente como está (qualquer tamanho);
//   - H.264 em outro "envelope" (.mov do iPhone, .mkv, .m4v) → só troca o
//     envelope para .mp4, SEM recomprimir (zero perda);
//   - outro formato (HEVC, VP9…) → converte para H.264 quase sem perda (CRF 18),
//     na mesma resolução (só reduz se passar de 1080p, que o WhatsApp não mostra).
// Enquanto isso, a mídia aparece como "convertendo…" e a IA ainda não a usa.
//
// Usa o ffmpeg do sistema (ou FFMPEG_PATH, ou o pacote ffmpeg-static). Sem
// ffmpeg, o vídeo continua na categoria Vídeos e é enviado como está; se o
// WhatsApp recusar, vai como arquivo (documento) para o cliente receber mesmo assim.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { estado, salvar, agora } = require('./db');

// acima disso o WhatsApp não aceita como vídeo: vai como arquivo (mesma qualidade)
const LIMITE_WHATSAPP = 100 * 1024 * 1024;
const LADO_MAX = 1920; // 1080p
const TEMPO_MAX_MS = 60 * 60 * 1000;

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
  return midia.mimetype === 'video/mp4' && info.video === 'h264' && (!info.audio || info.audio === 'aac');
}

// O que fazer com o vídeo, sempre perdendo o mínimo possível
function plano(info) {
  const videoOk = info.video === 'h264';
  const audioOk = !info.audio || info.audio === 'aac';
  if (videoOk && audioOk) return 'envelope'; // só troca .mov/.mkv por .mp4, sem recomprimir
  if (videoOk) return 'audio'; // vídeo intacto, só o áudio vira AAC
  return 'converter';
}

function argsConversao(entrada, saida, info) {
  const p = plano(info);
  const audio = info.audio ? (p === 'envelope' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : ['-an'];
  const video =
    p === 'converter'
      ? [
          // mesma resolução; só reduz se passar de 1080p (medidas pares, exigência do H.264)
          ...(Math.max(info.largura, info.altura) > LADO_MAX
            ? ['-vf', `scale='if(gte(iw,ih),${LADO_MAX},-2)':'if(gte(iw,ih),-2,${LADO_MAX})',format=yuv420p`]
            : ['-vf', 'format=yuv420p']),
          '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-crf', '18'
        ]
      : ['-c:v', 'copy'];
  return ['-hide_banner', '-y', '-i', entrada, '-map', '0:v:0', '-map', '0:a:0?', ...video, ...audio, '-movflags', '+faststart', '-max_muxing_queue_size', '4096', saida];
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
    midia.videoOk = midia.mimetype === 'video/mp4';
    if (!midia.videoOk) midia.avisoVideo = 'Este vídeo não é MP4: o WhatsApp entrega como arquivo (na qualidade original). Para tocar direto na conversa, exporte em MP4.';
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
      convertido: { de: antes.mimetype, tamanhoAntes: antes.tamanho, em: agora(), segundos: Math.round((Date.now() - inicio) / 1000), como: plano(info) }
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
