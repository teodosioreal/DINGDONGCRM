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
# segredos e banco legíveis só pelo dono do processo
[ -f .env ] && chmod 600 .env
[ -f data.json ] && chmod 600 data.json

echo "==> Baixando a versão nova (branch $BRANCH)"
ler_env() { grep -E "^$1=" "$2" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }
# Diagnóstico (só do CRM): aparece no log do GitHub Actions
diagnostico() {
  set +e +o pipefail # só informa: nada aqui derruba um deploy que já deu certo
  echo "==> Diagnóstico do CRM"
  echo "    PUBLIC_URL=$(ler_env PUBLIC_URL .env)"
  echo "    Contatos (anônimo, só leitura):"
  CRM_DB_PATH="$(ler_env CRM_DB_PATH .env)" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 60 node deploy/diagnostico-contatos.js 2>&1 | head -n 80 || true
  # etiquetas do WhatsApp Business: copia (só leitura) as marcações dos números DO CRM para o CRM importar
  DB_CRM="$(ler_env CRM_DB_PATH .env || true)"; DB_CRM="${DB_CRM:-$PASTA/data.json}"
  INSTANCIAS="$(CRM_DB_PATH="$DB_CRM" node -e 'try { const d = JSON.parse(require("fs").readFileSync(process.env.CRM_DB_PATH, "utf8")); process.stdout.write((d.empresas || []).map((e) => e.whatsappConfig && e.whatsappConfig.instancia).filter(Boolean).join(",")); } catch {}' 2>/dev/null || true)"
  echo "    Instâncias do WhatsApp no CRM: ${INSTANCIAS:-nenhuma}"
  # teste pedido pelo dono (uma vez): reinicia só a instância do CRM e compara as etiquetas
  MARCA_SUSTO="$(dirname "$DB_CRM")/.susto-etiquetas-1"
  if [ -n "$INSTANCIAS" ] && [ ! -f "$MARCA_SUSTO" ]; then
    echo "    Reiniciando só a instância do CRM na Evolution (teste das etiquetas):"
    touch "$MARCA_SUSTO"
    CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 150 node deploy/susto-etiquetas.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 30 || true
  fi
  EXPORTAR="$(dirname "$DB_CRM")/etiquetas-evolution.json" INSTANCIAS="$INSTANCIAS" timeout 60 bash deploy/evolution-etiquetas.sh 2>&1 | head -n 60 || true
  echo "    Últimas 30 h (conexão, fotos/comprovantes, vendas, etiquetas — anônimo, só leitura):"
  CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 90 node deploy/diagnostico-hoje.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 90 || true
  echo "    Mídias citadas no prompt e fila do follow-up (cópia do banco, só contagens):"
  CRM_DB_PATH_ORIGINAL="$DB_CRM" timeout 60 node deploy/diagnostico-prompt-midias.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 20 || true
  echo "    Detalhe do envio para uma conversa (o que a Evolution guardou; sem texto):"
  CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" DIAG_FINAL="TODAS" timeout 120 node deploy/diagnostico-envio-detalhe.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 60 || true
  EVO_C="$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '/evolution-api|evolution_api/ {print $1; exit}')"
  if [ -n "$EVO_C" ]; then
    echo "    Erros de envio de mídia na Evolution (6 h, instância do CRM):"
    docker logs "$EVO_C" --since 6h 2>&1 | grep -F "crm-madara" | grep -iE 'error|erro|fail|media|upload|sendMedia|ENOENT|timeout' | grep -viE 'labels? association' | sed -E 's/[0-9]{8,}/[núm]/g; s/\x1b\[[0-9;]*m//g; s/https?:\/\/[^ ]+/[link]/g' | cut -c1-230 | tail -n 25 | sed 's/^/       /' || true
  fi
  echo "    Mídias: cadastro, prompt, pedidos da IA e envios (48 h, anônimo, cópia do banco):"
  CRM_DB_PATH_ORIGINAL="$DB_CRM" MIDIAS_DIR="$(ler_env MIDIAS_DIR .env)" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" PUBLIC_URL="$(ler_env PUBLIC_URL .env)" timeout 240 node deploy/diagnostico-midias-completo.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 120 || true
  echo "    Mídias enviadas nas últimas 12 h (anônimo, só leitura):"
  CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" PUBLIC_URL="$(ler_env PUBLIC_URL .env)" timeout 120 node deploy/diagnostico-envio-midia.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 40 || true
  echo "    Evolution × CRM (mensagens das últimas 24 h, anônimo, só leitura):"
  CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 120 node deploy/diagnostico-mensagens.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 60 || true
  echo "    Log do app (conexão, comprovantes, etiquetas):"
  pm2 logs "$NOME_PM2" --out --lines 1500 --nostream --raw 2>/dev/null \
    | grep -iE "whatsapp|sincron|comprovante|etiquet|syncFull|restart|webhook|conex" \
    | sed -E 's/[0-9]{8,}/[núm]/g' | tail -n 50 | sed 's/^/      /' || true
  echo "    Últimos erros do app (números escondidos):"
  pm2 logs "$NOME_PM2" --err --lines 40 --nostream --raw 2>/dev/null \
    | sed -E 's/[0-9]{8,}/[núm]/g' | tail -n 40 | sed 's/^/      /' || true
}

git "${GIT_AUTH[@]}" fetch -q "${REPO_URL:-origin}" "$BRANCH"
NOVA="$(git rev-parse FETCH_HEAD)"
if [ "$NOVA" = "$ANTES" ]; then
  echo "==> Já está na versão mais nova ($(git log -1 --format='%h %s'))."
  diagnostico
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
