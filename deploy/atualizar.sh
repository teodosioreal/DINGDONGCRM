#!/usr/bin/env bash
# Atualiza o DingDong CRM já instalado na VPS. Chamado pelo GitHub Actions a
# cada push na main (.github/workflows/deploy.yml), mas também dá para rodar
# à mão:  GITHUB_TOKEN=seu_token bash /opt/dingdong-crm/deploy/atualizar.sh
#
# Mexe SÓ na pasta do CRM e SÓ no processo "dingdong-crm" do pm2.
# Se o app não responder depois de atualizar, volta sozinho para a versão
# anterior. Qualquer situação inesperada: para sem mudar nada.
set -euo pipefail

PASTA="${PASTA:-/opt/dingdong-crm}"
BRANCH="${BRANCH:-main}"
NOME_PM2="dingdong-crm"
# só para testes: busca de outro endereço em vez do origin
REPO_URL="${REPO_URL:-}"

pare() { echo "!! $*"; echo "!! Parei aqui, sem mexer em mais nada."; exit 1; }

# autenticação só para o git abaixo (o repositório é privado; não grava o token)
GIT_AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  GIT_AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')")
fi

echo "==> Conferindo a instalação em $PASTA"
[ -d "$PASTA/.git" ] && [ -f "$PASTA/server.js" ] \
  || pare "Não achei o CRM instalado em $PASTA. Rode o instalador (deploy/instalar.sh) primeiro."
git -C "$PASTA" remote get-url origin | grep -qi "teodosioreal/dingdongcrm" \
  || pare "A pasta $PASTA não é do repositório DINGDONGCRM. Não vou mexer nela."
if [ -n "$(git -C "$PASTA" status --porcelain --untracked-files=no)" ]; then
  pare "Há arquivos modificados à mão em $PASTA. Não vou sobrescrever. Veja com: git -C $PASTA status"
fi
command -v pm2 >/dev/null || pare "pm2 não encontrado."
pm2 describe "$NOME_PM2" >/dev/null 2>&1 || pare "O processo \"$NOME_PM2\" não está no pm2. Rode o instalador primeiro."
PASTA_DO_PROCESSO="$(pm2 jlist 2>/dev/null | node -e '
  let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
    const p = JSON.parse(t.slice(t.indexOf("["))).find((x) => x.name === process.argv[1]);
    process.stdout.write((p && p.pm2_env && p.pm2_env.pm_cwd) || "");
  });' "$NOME_PM2" || true)"
[ "$(realpath -m "$PASTA_DO_PROCESSO")" = "$(realpath -m "$PASTA")" ] \
  || pare "O processo \"$NOME_PM2\" roda de outra pasta (${PASTA_DO_PROCESSO:-desconhecida}). Não vou mexer nele."

cd "$PASTA"
ANTES="$(git rev-parse HEAD)"

echo "==> Baixando a versão nova (branch $BRANCH)"
git "${GIT_AUTH[@]}" fetch -q "${REPO_URL:-origin}" "$BRANCH"
NOVA="$(git rev-parse FETCH_HEAD)"
if [ "$NOVA" = "$ANTES" ]; then
  echo "==> Já está na versão mais nova ($(git log -1 --format='%h %s'))."
  exit 0
fi
git merge -q --ff-only FETCH_HEAD \
  || pare "A versão da VPS divergiu do GitHub (alguém fez commit direto na VPS?). Não vou forçar."

instalar_dependencias() {
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
}

if ! git diff --quiet "$ANTES" HEAD -- package.json package-lock.json; then
  echo "==> Dependências mudaram: instalando"
  instalar_dependencias
fi

PORTA="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
BASE="$(grep -E '^BASE_PATH=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
URL_TESTE="http://127.0.0.1:${PORTA:-3100}${BASE:-/crm}/login"

responde() {
  for _ in $(seq 1 15); do
    sleep 1
    curl -fs -o /dev/null "$URL_TESTE" && return 0
  done
  return 1
}

echo "==> Reiniciando só o \"$NOME_PM2\""
pm2 restart "$NOME_PM2" --update-env >/dev/null
if responde; then
  pm2 save >/dev/null
  echo "==> Atualizado: $(git log -1 --format='%h %s')"
  exit 0
fi

echo "!! A versão nova não respondeu em $URL_TESTE. Voltando para a anterior…"
git reset -q --hard "$ANTES"
if ! git diff --quiet "$NOVA" "$ANTES" -- package.json package-lock.json; then instalar_dependencias; fi
pm2 restart "$NOME_PM2" --update-env >/dev/null
if responde; then
  echo "!! Voltei para $(git log -1 --format='%h %s'), que está no ar. Veja o erro da versão nova com: pm2 logs $NOME_PM2"
else
  echo "!! Nem a versão anterior respondeu. Veja: pm2 logs $NOME_PM2"
fi
exit 1
