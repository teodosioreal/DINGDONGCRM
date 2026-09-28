// Versão que está rodando e quando ela foi colocada no ar, para o aviso
// "Última atualização" no painel.
//  - deploy/atualizar.sh e deploy/instalar.sh gravam .ultima-atualizacao
//    (data/hora do deploy e o commit) quando terminam com sucesso;
//  - sem esse arquivo, usa a data do último commit (git).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = path.join(RAIZ, '.ultima-atualizacao');

function doGit() {
  try {
    const [commit, data] = execFileSync('git', ['log', '-1', '--format=%h%n%cI'], { cwd: RAIZ, encoding: 'utf8', timeout: 3000 })
      .trim()
      .split('\n');
    return { em: data, commit };
  } catch {
    return null;
  }
}

function ler() {
  try {
    const d = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    if (d.em) return { em: d.em, commit: String(d.commit || '').slice(0, 7) };
  } catch {
    /* sem arquivo: cai no git */
  }
  return doGit();
}

// Lido uma vez ao subir: todo deploy reinicia o processo.
const versao = ler();

module.exports = { versao };
