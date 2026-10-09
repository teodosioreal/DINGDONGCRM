// Vídeos da biblioteca (só formato, sem conteúdo): codec, quadros/s, peso, resolução e se toca liso no WhatsApp.
const fs = require('fs');
const path = require('path');
const os = require('os');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-diag-video-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
process.env.CRM_DB_PATH = copia;
process.env.SINCRONIA = 'nao';
(async () => {
  const { estado } = require('../src/db');
  const midias = require('../src/midias');
  const video = require('../src/video');
  for (const [n, e] of estado.empresas.entries()) {
    const vids = midias.midiasDa(e).filter((m) => m.tipo === 'video').slice(-8);
    if (!vids.length) continue;
    console.log(`  Empresa ${n + 1}: ${vids.length} vídeo(s) (últimos)`);
    for (const m of vids) {
      const arq = midias.caminhoDoArquivo(m);
      let info = null;
      try { if (fs.existsSync(arq)) info = await video.examinar(arq); } catch { /* sem ffmpeg */ }
      const conv = m.convertido ? ` · convertido (${m.convertido.como}${m.convertido.antes ? `; antes: ${m.convertido.antes.codec} ${m.convertido.antes.largura}x${m.convertido.antes.altura} ${m.convertido.antes.fps}fps ${m.convertido.antes.kbps}kb/s${m.convertido.antes.irregular ? ' irregular' : ''}` : ''})` : '';
      console.log(`    #MIDIA_${m.numero || '?'} · ${(m.tamanho / 1048576).toFixed(1)} MB · ${info ? `${info.video} ${info.perfil || ''} ${info.largura}x${info.altura} ${info.fps}fps ${info.kbps}kb/s ${info.duracao.toFixed(0)}s · ${video.leveDeTocar(info) ? 'TOCA LISO' : 'PESADO/IRREGULAR'}` : 'sem leitura'} · ${m.processando ? 'convertendo' : m.videoOk ? 'pronto' : 'não pronto'} · regras v${m.videoPadrao || 1}${conv}`);
    }
  }
  fs.rmSync(pasta, { recursive: true, force: true });
})();
