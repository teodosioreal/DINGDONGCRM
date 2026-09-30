// backup.js — blindagem dos dados: configurações, conversas, vendas e mídias.
//
// - Ao ligar e depois a cada 6 horas: cópia compactada do banco (data.json),
//   guardando as dos últimos 30 dias.
// - Uma vez por dia: "foto" da pasta de mídias com links físicos (não ocupa
//   espaço extra; se um arquivo for apagado da pasta, continua no backup).
//   Guarda os últimos 14 dias.
// - Se o banco sumir, o CRM volta sozinho o backup mais novo ao ligar.
// O deploy também faz uma cópia do banco antes de cada atualização.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('./config');

const dbPath = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const PASTA = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
const DIAS_BANCO = 30;
const DIAS_MIDIAS = 14;

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function garantirPasta(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function backupDoBanco(motivo = 'auto') {
  if (!fs.existsSync(dbPath)) return null;
  garantirPasta(path.join(PASTA, 'banco'));
  const destino = path.join(PASTA, 'banco', `data-${carimbo()}-${motivo}.json.gz`);
  fs.writeFileSync(destino, zlib.gzipSync(fs.readFileSync(dbPath)), { mode: 0o600 });
  limpar(path.join(PASTA, 'banco'), DIAS_BANCO);
  return destino;
}

// Cópia da pasta de mídias com links físicos: rápida e sem gastar disco
function fotoDasMidias() {
  const origem = config.midiasDir;
  if (!fs.existsSync(origem)) return null;
  const hoje = new Date().toISOString().slice(0, 10);
  const destino = path.join(PASTA, 'midias', hoje);
  if (fs.existsSync(destino)) return destino; // já fez hoje
  garantirPasta(destino);
  let arquivos = 0;
  const copiar = (de, para) => {
    for (const nome of fs.readdirSync(de)) {
      const a = path.join(de, nome);
      const b = path.join(para, nome);
      const st = fs.statSync(a);
      if (st.isDirectory()) {
        garantirPasta(b);
        copiar(a, b);
      } else {
        try {
          fs.linkSync(a, b);
        } catch {
          fs.copyFileSync(a, b); // outro disco: copia de verdade
        }
        arquivos++;
      }
    }
  };
  copiar(origem, destino);
  limpar(path.join(PASTA, 'midias'), DIAS_MIDIAS);
  return { destino, arquivos };
}

function limpar(pasta, dias) {
  const limite = Date.now() - dias * 24 * 3600 * 1000;
  for (const nome of fs.readdirSync(pasta)) {
    const p = path.join(pasta, nome);
    try {
      if (fs.statSync(p).mtimeMs < limite) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* segue */
    }
  }
}

// Banco sumiu (ou ficou vazio)? Volta o backup mais novo antes de o app ler.
function restaurarSeSumiu() {
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 2) return null;
  const pasta = path.join(PASTA, 'banco');
  if (!fs.existsSync(pasta)) return null;
  const ultimo = fs.readdirSync(pasta).filter((n) => n.endsWith('.json.gz')).sort().pop();
  if (!ultimo) return null;
  fs.writeFileSync(dbPath, zlib.gunzipSync(fs.readFileSync(path.join(pasta, ultimo))), { mode: 0o600 });
  console.error(`[backup] o banco tinha sumido: restaurei ${ultimo}`);
  return ultimo;
}

function resumo() {
  const ler = (sub) => {
    const p = path.join(PASTA, sub);
    return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
  };
  const banco = ler('banco');
  const midias = ler('midias');
  return { pasta: PASTA, ultimoBanco: banco[banco.length - 1] || null, copiasBanco: banco.length, ultimaFotoMidias: midias[midias.length - 1] || null, fotosMidias: midias.length };
}

let timer = null;
function iniciar() {
  if (timer) return;
  const rodar = (motivo) => {
    try {
      backupDoBanco(motivo);
      fotoDasMidias();
    } catch (err) {
      console.error('[backup]', err.message);
      require('./alertas').registrar(null, 'backup', `O backup automático falhou: ${err.message}`);
    }
  };
  setTimeout(() => rodar('ao-ligar'), 5000).unref?.();
  timer = setInterval(() => rodar('auto'), 6 * 3600 * 1000);
  timer.unref?.();
}

module.exports = { backupDoBanco, fotoDasMidias, restaurarSeSumiu, resumo, iniciar, PASTA };
