// Teste do "✨ Sugerir com IA" na VPS (roda uma vez no deploy): usa uma CÓPIA do
// banco (nada do CRM de verdade é gravado) e tenta sugerir a próxima mensagem nas
// conversas mais recentes de cada empresa. Mostra só OK/erro e tamanhos — nunca
// o texto das conversas.
const fs = require('fs');
const os = require('os');
const path = require('path');

const original = process.env.CRM_DB_PATH_ORIGINAL || path.join(__dirname, '..', 'data.json');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-teste-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(original, copia);
fs.chmodSync(copia, 0o600);
process.env.CRM_DB_PATH = copia;
process.env.BACKUP_DIR = path.join(pasta, 'backups');
process.on('exit', () => fs.rmSync(pasta, { recursive: true, force: true }));

(async () => {
  const { estado } = require('../src/db');
  const rotas = require('../src/rotas-painel');
  const whatsapp = require('../src/whatsapp');
  const leads = require('../src/leads');
  const midias = require('../src/midias');
  for (const [n, empresa] of estado.empresas.entries()) {
    const bot = whatsapp.botDoWhatsapp(empresa);
    if (!bot) { console.log(`    Empresa ${n + 1}: sem assistente`); continue; }
    const conversas = estado.conversas
      .filter((c) => c.empresaId === empresa.id && (c.mensagens || []).some((m) => m.texto && !m.apagada))
      .sort((a, b) => String(b.atualizadoEm).localeCompare(String(a.atualizadoEm)))
      .slice(0, 3);
    for (const [i, c] of conversas.entries()) {
      const conversa = c.mensagens.filter((m) => !m.apagada && m.texto);
      const contexto = async () => ({ etapas: leads.etapasDa(empresa), etapaAtual: c.etapa, links: midias.linksDa(empresa), midias: midias.paraIa(empresa) });
      const t0 = Date.now();
      const r = await rotas.sugerirMensagem(empresa, bot, c, conversa, '', contexto);
      const ultima = conversa[conversa.length - 1];
      console.log(`    Empresa ${n + 1}, conversa ${i + 1} (${conversa.length} msg, última de ${ultima.papel}): ${r.texto ? `OK por ${r.via} (${r.texto.length} caracteres)` : `ERRO: ${r.erro}`} · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  }
})()
  .catch((err) => console.log('    erro no teste:', String(err.message).slice(0, 300)))
  .finally(() => process.exit(0));
