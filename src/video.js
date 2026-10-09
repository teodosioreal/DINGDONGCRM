// video.js — deixa todo vídeo da biblioteca pronto para o WhatsApp.
//
// QUALIDADE ALTA E TOCANDO LISO NO CELULAR DO CLIENTE. O WhatsApp só toca na conversa MP4
// com vídeo H.264 (e áudio AAC). Ao subir um vídeo, o CRM confere (em segundo plano, um por vez):
//   - MP4 H.264 "leve de tocar" (até 1080p, até 30 quadros/s constantes, peso razoável) → fica
//     exatamente como está (zero perda);
//   - H.264 leve em outro "envelope" (.mov, .mkv, .m4v) → só troca o envelope para .mp4;
//   - o resto (HEVC/VP9, 60 quadros/s, ritmo de quadros irregular do celular, 4K, peso muito
//     alto) → converte para H.264 com qualidade alta (CRF 19), quadros CONSTANTES (até 30/s),
//     até 1080p e um teto de peso — vídeo pesado/irregular demais é o que fica "tremido",
//     travando como internet fraca no celular. O teto também mantém o arquivo abaixo de ~95 MB
//     para ir como vídeo (não como arquivo).
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
const FPS_MAX = 30; // o WhatsApp toca liso até 30 quadros por segundo
const KBPS_MAX = 8000; // teto do vídeo (8 Mbps em 1080p30 já é qualidade de sobra no celular)
const MB_ALVO = 95; // abaixo dos 100 MB do WhatsApp para ir como vídeo
const PADRAO = 2; // versão das regras: vídeos conferidos com regras antigas são revistos ao ligar
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
  const linhaVideo = (saida.match(/Stream #\S+.*?Video:[^\n]*/) || [''])[0];
  const fps = Number((linhaVideo.match(/([\d.]+)\s*fps/) || [])[1]) || 0;
  const tbr = Number((linhaVideo.match(/([\d.]+k?)\s*tbr/) || [])[1]?.replace('k', '000')) || 0;
  return {
    fps,
    // ritmo de quadros irregular (celular): fps médio diferente do "tbr" ou fps quebrado estranho
    irregular: Boolean(fps && tbr && Math.abs(fps - tbr) > 0.5),
    kbps: Number((linhaVideo.match(/(\d+)\s*kb\/s/) || [])[1]) || Number((saida.match(/bitrate:\s*(\d+)\s*kb\/s/) || [])[1]) || 0,
    perfil: ((linhaVideo.match(/h264\s*\(([^)]+)\)/i) || [])[1] || '').toLowerCase(),
    pixel: (linhaVideo.match(/\b(yuv\w+|nv12|gray)\b/) || [])[1] || '',
    duracao: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    video: v ? v[1].toLowerCase() : '',
    largura: v ? Number(v[2]) : 0,
    altura: v ? Number(v[3]) : 0,
    audio: a ? a[1].toLowerCase() : '',
    container: (saida.match(/Input #0,\s*([^,]+)/) || [])[1] || ''
  };
}

// O vídeo H.264 é "leve de tocar" no celular? (senão trava/treme no WhatsApp)
function leveDeTocar(info) {
  return (
    info.video === 'h264' &&
    Math.max(info.largura, info.altura) <= LADO_MAX &&
    (!info.fps || info.fps <= FPS_MAX + 0.5) &&
    !info.irregular &&
    (!info.kbps || info.kbps <= KBPS_MAX * 1.25) &&
    (!info.pixel || info.pixel === 'yuv420p' || info.pixel === 'yuvj420p') &&
    !/10|422|444/.test(info.perfil)
  );
}

// Já está no formato que o WhatsApp toca liso?
function jaCompativel(midia, info) {
  return midia.mimetype === 'video/mp4' && leveDeTocar(info) && (!info.audio || info.audio === 'aac');
}

// O que fazer com o vídeo, sempre perdendo o mínimo possível
function plano(info) {
  const videoOk = leveDeTocar(info);
  const audioOk = !info.audio || info.audio === 'aac';
  if (videoOk && audioOk) return 'envelope'; // só troca .mov/.mkv por .mp4, sem recomprimir
  if (videoOk) return 'audio'; // vídeo intacto, só o áudio vira AAC
  return 'converter';
}

// teto do vídeo: até 8 Mbps, menos se for longo (para caber em ~95 MB e ir como vídeo)
function kbpsDoVideo(info) {
  const porTamanho = info.duracao > 0 ? Math.floor((MB_ALVO * 8 * 1024) / info.duracao) - 200 : KBPS_MAX;
  return Math.max(1500, Math.min(KBPS_MAX, porTamanho));
}

function argsConversao(entrada, saida, info) {
  const p = plano(info);
  const audio = info.audio ? (p === 'envelope' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000']) : ['-an'];
  const fpsAlvo = Math.min(FPS_MAX, Math.round(info.fps) || FPS_MAX);
  const kbps = kbpsDoVideo(info);
  const filtros = [
    // mesma resolução; só reduz se passar de 1080p (medidas pares, exigência do H.264)
    ...(Math.max(info.largura, info.altura) > LADO_MAX ? [`scale='if(gte(iw,ih),${LADO_MAX},-2)':'if(gte(iw,ih),-2,${LADO_MAX})'`] : ['scale=trunc(iw/2)*2:trunc(ih/2)*2']),
    `fps=${fpsAlvo}`, // quadros CONSTANTES (o ritmo irregular do celular é o que "treme")
    'format=yuv420p'
  ];
  const video =
    p === 'converter'
      ? [
          '-vf', filtros.join(','),
          '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level:v', '4.1',
          '-crf', '19', '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
          '-g', String(fpsAlvo * 2), '-keyint_min', String(fpsAlvo), '-sc_threshold', '0'
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
      midia.videoPadrao = PADRAO;
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
      videoPadrao: PADRAO,
      convertido: { de: antes.mimetype, tamanhoAntes: antes.tamanho, em: agora(), segundos: Math.round((Date.now() - inicio) / 1000), como: plano(info), antes: { fps: info.fps, irregular: info.irregular, kbps: info.kbps, largura: info.largura, altura: info.altura, codec: info.video } }
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
  if (disponivel() && !midia.videoOk) {
    midia.processando = true; // vídeo novo: some da IA até conferir (o que já tocava continua valendo na revisão)
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
  // (também revê os conferidos com as regras antigas: vídeo pesado/irregular que travava no celular)
  for (const e of estado.empresas) for (const m of midias.midiasDa(e)) if (m.tipo === 'video' && (m.processando || m.videoOk === undefined || (m.videoOk && m.videoPadrao !== PADRAO))) enfileirar(m);
}

function situacao() {
  return { ffmpeg: disponivel(), naFila: fila.length, convertendo: rodando };
}

module.exports = {
  argsConversao,
  examinar,
  leveDeTocar, disponivel, enfileirar, revisarPendentes, preparar, situacao, examinar, LIMITE_WHATSAPP };
