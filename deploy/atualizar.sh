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
  echo "    Rede (por que abre no 4G e não no Wi-Fi, só leitura):"
  timeout 90 bash deploy/diagnostico-rede.sh "$(ler_env PUBLIC_URL .env | sed -E 's#^https?://##; s#/.*##')" 2>&1 | head -n 30 || true
  echo "    Contatos (anônimo, só leitura):"
  CRM_DB_PATH="$(ler_env CRM_DB_PATH .env)" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 60 node deploy/diagnostico-contatos.js 2>&1 | head -n 80 || true
  # etiquetas do WhatsApp Business: copia (só leitura) as marcações dos números DO CRM para o CRM importar
  DB_CRM="$(ler_env CRM_DB_PATH .env || true)"; DB_CRM="${DB_CRM:-$PASTA/data.json}"
  INSTANCIAS="$(CRM_DB_PATH="$DB_CRM" node -e 'try { const d = JSON.parse(require("fs").readFileSync(process.env.CRM_DB_PATH, "utf8")); process.stdout.write((d.empresas || []).map((e) => e.whatsappConfig && e.whatsappConfig.instancia).filter(Boolean).join(",")); } catch {}' 2>/dev/null || true)"
  echo "    Instâncias do WhatsApp no CRM: ${INSTANCIAS:-nenhuma}"
  EXPORTAR="$(dirname "$DB_CRM")/etiquetas-evolution.json" INSTANCIAS="$INSTANCIAS" timeout 60 bash deploy/evolution-etiquetas.sh 2>&1 | head -n 60 || true
  echo "    Últimas 30 h (conexão, fotos/comprovantes, vendas, etiquetas — anônimo, só leitura):"
  CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 90 node deploy/diagnostico-hoje.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 90 || true
  echo "    Mídias citadas no prompt e fila do follow-up (cópia do banco, só contagens):"
  CRM_DB_PATH_ORIGINAL="$DB_CRM" timeout 60 node deploy/diagnostico-prompt-midias.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 20 || true
  echo "    Chaves de IA por empresa (só a origem; nunca a chave):"
  # teste ao vivo de cada chave (gasta 1 pedido de cada): só quando deploy/testar-chaves.pedido existe
  [ -f deploy/testar-chaves.pedido ] && TESTAR_CHAVES=sim || TESTAR_CHAVES=nao
  CRM_DB_PATH="$DB_CRM" TESTAR_CHAVES="$TESTAR_CHAVES" ANTHROPIC_API_KEY="$(ler_env ANTHROPIC_API_KEY .env)" GEMINI_API_KEY="$(ler_env GEMINI_API_KEY .env)" OPENAI_API_KEY="$(ler_env OPENAI_API_KEY .env)" timeout 120 node deploy/diagnostico-chaves.js 2>&1 | head -n 80 || true
  echo "    Configuração do WhatsApp na Evolution (só os interruptores):"
  CRM_DB_PATH="$DB_CRM" EVOLUTION_API_URL="$(ler_env EVOLUTION_API_URL .env)" timeout 40 node deploy/diagnostico-config-zap.js 2>&1 | head -n 10 || true
  echo "    Vídeos da biblioteca (formato e se toca liso no WhatsApp):"
  CRM_DB_PATH_ORIGINAL="$DB_CRM" MIDIAS_DIR="$(ler_env MIDIAS_DIR .env)" timeout 90 node deploy/diagnostico-videos.js 2>&1 | head -n 30 || true
  echo "    Mídias e simulação de conversas (cópia do banco, nada é enviado):"
  # a simulação usa a IA de verdade (gasta tokens): só roda quando o arquivo deploy/simular.pedido existe
  [ -f deploy/simular.pedido ] && SIMULAR_IA=sim || SIMULAR_IA=nao
  CRM_DB_PATH_ORIGINAL="$DB_CRM" SIMULAR_IA="$SIMULAR_IA" MIDIAS_DIR="$(ler_env MIDIAS_DIR .env)" PUBLIC_URL="$(ler_env PUBLIC_URL .env)" timeout 420 node deploy/simular-midias.js 2>&1 | sed -u -E 's/[0-9]{10,}/[núm]/g' | head -n 120 || true
  EVO_C="$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '/evolution-api|evolution_api/ {print $1; exit}')"
  if [ -n "$EVO_C" ]; then
    echo "    Etiquetas na Evolution por dia (10 dias, instâncias do CRM; só contagens):"
    docker logs "$EVO_C" --since 240h 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep -F "crm-madara" | grep -iE 'label' \
      | grep -oE '(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [0-9]{2}' | sort | uniq -c | sed 's/^/       /' || true
    echo "    Sincronização do celular / chaves (10 dias, erros e avisos, sem números):"
    docker logs "$EVO_C" --since 240h 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep -iE 'app.?state|sync key|key not found|failed to (sync|decode|find)|resync|server_sync|appStateSync' \
      | sed -E 's/[0-9]{6,}/[núm]/g; s/^.*(INFO|WARN|ERROR|VERBOSE|DEBUG|LOG)/\1/' | cut -c1-160 | sort | uniq -c | sort -rn | head -12 | sed 's/^/       /' || true
    echo "    Nível de log da Evolution: $(docker inspect "$EVO_C" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E '^LOG_(LEVEL|BAILEYS)=' | tr '\n' ' ')"
  fi
  echo "    Alertas das últimas 24 h (anônimo; os de nível erro vão pro WhatsApp de avisos):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-alertas.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 70 || true
  echo "    Erros de entrega do WhatsApp (48 h, sem texto):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-entrega.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 40 || true
  echo "    Vendas criadas sozinhas (7 dias, sem texto):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-vendas-auto.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 50 || true
  echo "    Gasto de IA (hoje e ontem, só números):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-gasto.js 2>&1 | head -n 40 || true
  echo "    Últimas conversas com mensagem de cliente (por que a IA respondeu ou não; anônimo):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-ultimo.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 20 || true
  echo "    Meta Ads (anônimo: configuração, código do atendimento, fbclid e o site):"
  CRM_DB_PATH="$DB_CRM" timeout 90 node deploy/diagnostico-meta.js 2>&1 | head -n 40 || true
  echo "    Agendamentos e funil (28 dias, só contagens e tempos):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-agenda.js 2>&1 | sed -E 's/[0-9]{10,}/[núm]/g' | head -n 40 || true
  echo "    Tamanho do prompt da IA (salvo × enviado, só números):"
  CRM_DB_PATH="$DB_CRM" timeout 30 node deploy/diagnostico-prompt-tamanho.js 2>&1 | head -n 30 || true
  echo "    Log do app (conexão, comprovantes, etiquetas):"
  pm2 logs "$NOME_PM2" --out --lines 1500 --nostream --raw 2>/dev/null \
    | grep -iE "whatsapp|sincron|comprovante|etiquet|syncFull|restart|webhook|conex|fila-ia|horario-ia|\[ia " \
    | sed -E 's/[0-9]{8,}/[núm]/g' | tail -n 50 | sed 's/^/      /' || true
  echo "    Últimos erros do app (números escondidos):"
  pm2 logs "$NOME_PM2" --err --lines 40 --nostream --raw 2>/dev/null \
    | sed -E 's/[0-9]{8,}/[núm]/g' | tail -n 40 | sed 's/^/      /' || true
}

# Saúde do CRM AGORA (antes de atualizar): responde? em quanto tempo? memória, disco, banco.
# Se não responder em 20 s (travado), reinicia o processo dingdong-crm (só ele).
saude() {
  local porta base url pub t
  porta="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
  if grep -qE '^BASE_PATH=' .env 2>/dev/null; then
    base="$(grep -E '^BASE_PATH=' .env | tail -n 1 | cut -d= -f2- | tr -d '[:space:]"'"'"'' | sed -e 's#/*$##' -e 's#^/*#/#')"; [ "$base" = "/" ] && base=""
  else base="/crm"; fi
  url="http://127.0.0.1:${porta:-3100}${base}/login"
  echo "==> Saúde do CRM agora"
  pm2 jlist 2>/dev/null | node -e '
    let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
      const p = JSON.parse(t.slice(t.indexOf("["))).find((x) => x.name === process.argv[1]); if (!p) return console.log("    pm2: processo não encontrado");
      const e = p.pm2_env || {}, m = p.monit || {};
      console.log(`    pm2: ${e.status} · reinícios ${e.restart_time} · memória ${Math.round((m.memory || 0) / 1048576)} MB · CPU ${m.cpu}% · no ar há ${Math.round((Date.now() - e.pm_uptime) / 60000)} min`);
    });' "$NOME_PM2" || true
  t="$(curl -s -o /dev/null -w '%{http_code} em %{time_total}s' --max-time 20 "$url" || echo 'SEM RESPOSTA em 20 s')"
  echo "    resposta local (${base:-/}/login): $t"
  pub="$(ler_env PUBLIC_URL .env)"
  [ -n "$pub" ] && echo "    resposta pelo endereço público: $(curl -s -o /dev/null -w '%{http_code} em %{time_total}s' --max-time 20 "${pub%/}${base}/login" || echo 'SEM RESPOSTA em 20 s')"
  echo "    disco: $(df -h . | tail -n 1 | awk '{print $3" usados de "$2" ("$5" cheio), livres "$4}')"
  echo "    memória do servidor: $(free -m 2>/dev/null | awk '/^Mem/{print $3" MB usados de "$2" MB, livres "$7" MB"}') · carga: $(cut -d' ' -f1-3 /proc/loadavg)"
  [ -f data.json ] && echo "    banco (data.json): $(du -h data.json | cut -f1)"
  [ -d backups ] && echo "    cópias de segurança: $(du -sh backups 2>/dev/null | cut -f1) no total · $(ls backups/banco 2>/dev/null | wc -l) cópias de deploy ($(du -sh backups/banco 2>/dev/null | cut -f1))"
  [ -d midias ] && echo "    mídias: $(du -sh midias 2>/dev/null | cut -f1)"
  if ! curl -fs -o /dev/null --max-time 20 "$url"; then
    echo "!!  O CRM não respondeu em 20 s: reiniciando o processo $NOME_PM2 (só ele)"
    pm2 restart "$NOME_PM2" --update-env >/dev/null || true
    for _ in $(seq 1 20); do sleep 1; curl -fs -o /dev/null "$url" && break; done
    echo "    depois de reiniciar: $(curl -s -o /dev/null -w '%{http_code} em %{time_total}s' --max-time 20 "$url" || echo 'AINDA SEM RESPOSTA')"
    pm2 logs "$NOME_PM2" --err --lines 25 --nostream --raw 2>/dev/null | sed -E 's/[0-9]{8,}/[núm]/g' | tail -n 25 | sed 's/^/      erro: /' || true
  fi
}
saude || true

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
# BASE_PATH vazio = CRM na raiz do domínio; sem a linha no .env = /crm (igual ao src/config.js)
if grep -qE '^BASE_PATH=' .env 2>/dev/null; then
  BASE="$(grep -E '^BASE_PATH=' .env | tail -n 1 | cut -d= -f2- | tr -d '[:space:]"'"'"'' | sed -e 's#/*$##' -e 's#^/*#/#')"
  [ "$BASE" = "/" ] && BASE=""
else
  BASE="/crm"
fi
URL_TESTE="http://127.0.0.1:${PORTA:-3100}${BASE}/login"

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
