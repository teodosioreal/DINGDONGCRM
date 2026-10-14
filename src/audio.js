// audio.js — áudios da biblioteca de mídias (os que a IA manda na conversa).
// Ao subir um áudio: lê a duração (ffmpeg) e, se a empresa tiver chave que ouve áudio
// (Gemini ou GPT), transcreve sozinho o que ele fala — a IA usa isso para saber o
// conteúdo e não repetir por escrito. O dono pode corrigir o texto no painel.

const fs = require('fs');
const { salvar } = require('./db');

const rodando = new Set();

async function preparar(empresa, midia, { forcarTranscricao = false } = {}) {
  if (!midia || midia.tipo !== 'audio' || rodando.has(midia.id)) return midia;
  rodando.add(midia.id);
  try {
    const midias = require('./midias');
    const arquivo = midias.caminhoDoArquivo(midia);
    // duração (para o "gravando áudio…" ter o tempo certo)
    if (!midia.duracao) {
      try {
        const video = require('./video');
        if (video.disponivel()) {
          const info = await video.examinar(arquivo);
          if (info.duracao > 0) midia.duracao = Math.round(info.duracao);
        }
      } catch (err) {
        console.error(`[audio ${midia.id}] duração:`, err.message);
      }
    }
    // o que o áudio fala (só preenche sozinho se ainda estiver vazio)
    const ia = require('./ia');
    if ((forcarTranscricao || !String(midia.fala || '').trim()) && ia.podeOuvirAudio(empresa)) {
      const tamanho = fs.statSync(arquivo).size;
      if (tamanho <= 20 * 1024 * 1024) {
        const texto = await ia.transcreverAudio(empresa, fs.readFileSync(arquivo).toString('base64'), midia.mimetype);
        if (texto && !/^\(sem fala\)$/i.test(texto.trim())) {
          midia.fala = texto.trim().slice(0, 2000);
          midia.falaAuto = true;
        }
      }
    }
    salvar();
  } catch (err) {
    console.error(`[audio ${midia.id}]`, err.message);
    if (forcarTranscricao) throw err;
  } finally {
    rodando.delete(midia.id);
  }
  return midia;
}

// Quanto tempo o cliente vê "gravando áudio…" antes do áudio chegar: perto da duração
// (como se a pessoa estivesse gravando), sem segurar a conversa por muito tempo.
function tempoGravando(midia) {
  const s = Number(midia?.duracao) || 8;
  return Math.min(20000, Math.max(2500, Math.round(s * 1000 * 0.8)));
}

module.exports = { preparar, tempoGravando };
