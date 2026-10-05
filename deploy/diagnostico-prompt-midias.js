// Mídias citadas nas instruções da IA do WhatsApp (só contagens, anônimo): quantos
// trechos falam de mídia, quantos já têm código, quantos o CRM conecta sozinho e
// quantos ficam sem conexão. Roda numa CÓPIA do banco (nada é gravado no original)
// e nunca mostra o texto do prompt nem conversas.
const fs = require('fs');
const os = require('os');
const path = require('path');

const original = process.env.CRM_DB_PATH_ORIGINAL;
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-diag-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(original, copia);
fs.chmodSync(copia, 0o600);
process.env.CRM_DB_PATH = copia;
process.env.SINCRONIA = 'nao';

try {
  const { estado } = require('../src/db');
  const midias = require('../src/midias');
  for (const [n, e] of estado.empresas.entries()) {
    const bots = estado.bots.filter((b) => b.empresaId === e.id && String(b.promptWhatsapp || '').trim());
    if (!bots.length) continue;
    let escritos = 0;
    let conectadas = 0;
    for (const b of bots) {
      escritos += midias.codigosCitados(e, b.promptWhatsapp).filter((c) => c.existe).length;
      conectadas += midias.instrucoesComMidias(e, b.promptWhatsapp, b.id).conectadas.length;
    }
    const pend = midias.pendenciasDoPrompt(e).filter((p) => p.campo === 'promptWhatsapp');
    const naIa = midias.paraIa(e).length;
    const doPrompt = midias.codigosDoPrompt(e).size;
    console.log(`    Empresa ${n + 1}: códigos de mídia já escritos ${escritos} · conectadas sozinhas agora ${conectadas} · mídias do prompt liberadas para a IA ${doPrompt} · trechos sem conexão certa ${pend.length} · mídias que a IA enxerga ${naIa}`);
  }
} finally {
  fs.rmSync(pasta, { recursive: true, force: true });
}
process.exit(0);
