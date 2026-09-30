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

# blindagem: cópia do banco antes de qualquer mudança (as mídias e o banco
# ficam fora do git: a atualização nunca apaga nem sobrescreve esses arquivos)
if [ -f data.json ]; then
  mkdir -p backups/banco && chmod 700 backups
  gzip -c data.json > "backups/banco/data-$(date -u +%Y-%m-%dT%H-%M-%S)-antes-do-deploy.json.gz"
  chmod 600 backups/banco/*.json.gz 2>/dev/null || true
  echo "==> Backup do banco feito antes de atualizar"
fi

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

# Chave global da Evolution API (o CRM cria as conexões de WhatsApp sozinho,
# como o DingDong Tracking). Se o .env do CRM ainda não tem, copia do .env do
# tracker — só LÊ o arquivo do tracker, nunca altera nada nele.
ENV_TRACKER="${ENV_TRACKER:-/var/www/dingdong/.env}"
ler_env() { grep -E "^$1=" "$2" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }
if [ -f .env ] && [ -z "$(ler_env EVOLUTION_API_KEY .env)" ] && [ -r "$ENV_TRACKER" ]; then
  CHAVE_EVO="$(ler_env EVOLUTION_API_KEY "$ENV_TRACKER")"
  URL_EVO="$(ler_env EVOLUTION_API_URL "$ENV_TRACKER")"
  if [ -n "$CHAVE_EVO" ]; then
    [ -n "$(tail -c 1 .env)" ] && echo >> .env
    sed -i '/^EVOLUTION_API_KEY=[[:space:]]*$/d' .env
    printf 'EVOLUTION_API_KEY=%s\n' "$CHAVE_EVO" >> .env
    if [ -n "$URL_EVO" ] && [ -z "$(ler_env EVOLUTION_API_URL .env)" ]; then
      sed -i '/^EVOLUTION_API_URL=[[:space:]]*$/d' .env
      printf 'EVOLUTION_API_URL=%s\n' "$URL_EVO" >> .env
    fi
    echo "==> Chave global da Evolution copiada do .env do DingDong Tracking (só leitura)"
  else
    echo "==> Aviso: o .env do tracker não tem EVOLUTION_API_KEY; cole a chave no painel (Configurações do sistema)"
  fi
fi

# Data/hora do deploy, mostrada no painel ("Última atualização"). Gravada antes
# de reiniciar (o painel lê ao subir); se precisar voltar, volta a antiga junto.
VERSAO_ANTERIOR="$(cat .ultima-atualizacao 2>/dev/null || true)"
printf '{"em":"%s","commit":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse --short HEAD)" > .ultima-atualizacao

echo "==> Reiniciando só o \"$NOME_PM2\""
pm2 restart "$NOME_PM2" --update-env >/dev/null
# Diagnóstico (só do CRM): endereço público e os últimos erros do app, com os
# números de telefone escondidos. Aparece no log do GitHub Actions.
diagnostico() {
  echo "==> Diagnóstico do CRM"
  echo "    PUBLIC_URL=$(ler_env PUBLIC_URL .env)"
  echo "    Últimos erros do app (números escondidos):"
  pm2 logs "$NOME_PM2" --err --lines 40 --nostream --raw 2>/dev/null \
    | sed -E 's/[0-9]{8,}/[núm]/g' | tail -n 40 | sed 's/^/      /' || true
}

if responde; then
  pm2 save >/dev/null
  echo "==> Atualizado: $(git log -1 --format='%h %s')"
  diagnostico
  exit 0
fi

echo "!! A versão nova não respondeu em $URL_TESTE. Voltando para a anterior…"
git reset -q --hard "$ANTES"
if [ -n "$VERSAO_ANTERIOR" ]; then printf '%s\n' "$VERSAO_ANTERIOR" > .ultima-atualizacao; else rm -f .ultima-atualizacao; fi
if ! git diff --quiet "$NOVA" "$ANTES" -- package.json package-lock.json; then instalar_dependencias; fi
pm2 restart "$NOME_PM2" --update-env >/dev/null
if responde; then
  echo "!! Voltei para $(git log -1 --format='%h %s'), que está no ar. Veja o erro da versão nova com: pm2 logs $NOME_PM2"
else
  echo "!! Nem a versão anterior respondeu. Veja: pm2 logs $NOME_PM2"
fi
exit 1
