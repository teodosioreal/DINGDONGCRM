#!/usr/bin/env bash
# Instala (ou atualiza) o DingDong CRM na VPS — sem tocar em outros projetos.
#
# O repositório é privado, então precisa de um token do GitHub (só leitura):
#   export GITHUB_TOKEN=github_pat_xxx
#   curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#     https://raw.githubusercontent.com/teodosioreal/DINGDONGCRM/main/deploy/instalar.sh | bash
#
# O que este script FAZ:
#   - baixa o código numa pasta só dele (padrão /opt/dingdong-crm)
#   - instala as dependências dentro dessa pasta
#   - cria um processo no pm2 chamado "dingdong-crm" (só esse)
# O que ele NUNCA faz:
#   - não instala nem atualiza o Node.js do sistema
#   - não mexe no Nginx, em outras pastas, em outros processos do pm2
#   - não sobrescreve uma pasta que já existe e não é deste projeto
#   - não usa uma porta que já está ocupada
#   - não grava o token do GitHub no servidor
# Qualquer situação inesperada: ele PARA e explica, sem mudar nada.
set -euo pipefail

BRANCH="${BRANCH:-main}"
PASTA="${PASTA:-/opt/dingdong-crm}"
PORTA="${PORTA:-3100}"
NOME_PM2="dingdong-crm"
REPO="https://github.com/teodosioreal/DINGDONGCRM.git"

pare() { echo; echo "!! $*"; echo "!! Parei aqui, sem mexer em mais nada."; exit 1; }

# autenticação só para os comandos git abaixo (não grava o token no .git/config)
GIT_AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  GIT_AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')")
fi

echo "==> Conferindo o que já existe (nada é alterado nesta etapa)"

command -v git >/dev/null || pare "git não está instalado. Instale com: sudo apt-get install git"
command -v node >/dev/null || pare "Node.js não encontrado. Instale o Node 18+ (não instalo sozinho para não afetar outros apps)."
NODE_MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAIOR" -ge 18 ] || pare "Seu Node é $(node -v); o CRM precisa do 18+. Não atualizo sozinho para não quebrar outros apps."
echo "    Node $(node -v) ok"

INSTALACAO_NOVA=1
if [ -e "$PASTA" ]; then
  # só aceita continuar se a pasta for uma instalação anterior DESTE projeto
  if [ -d "$PASTA/.git" ] && git -C "$PASTA" remote get-url origin 2>/dev/null | grep -q "teodosioreal/DINGDONGCRM" && [ -f "$PASTA/server.js" ]; then
    INSTALACAO_NOVA=0
    echo "    $PASTA já é o CRM: vou só atualizar"
    if [ -n "$(git -C "$PASTA" status --porcelain --untracked-files=no)" ]; then
      pare "Há arquivos modificados à mão em $PASTA. Não vou sobrescrever. Veja com: git -C $PASTA status"
    fi
  else
    pare "A pasta $PASTA já existe e NÃO é deste projeto. Rode de novo com outra, ex.: PASTA=/opt/dingdong-crm2"
  fi
fi

APP_RODANDO=0
if command -v pm2 >/dev/null && pm2 describe "$NOME_PM2" >/dev/null 2>&1; then
  APP_RODANDO=1
  # o processo com esse nome precisa ser DESTA pasta; senão, é de outra coisa e não mexo
  PASTA_DO_PROCESSO="$(pm2 jlist 2>/dev/null | node -e '
    let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
      const p = JSON.parse(t.slice(t.indexOf("["))).find((x) => x.name === process.argv[1]);
      process.stdout.write((p && p.pm2_env && p.pm2_env.pm_cwd) || "");
    });' "$NOME_PM2" || true)"
  if [ "$INSTALACAO_NOVA" -eq 1 ] || [ "$(realpath -m "$PASTA_DO_PROCESSO")" != "$(realpath -m "$PASTA")" ]; then
    pare "Já existe um processo \"$NOME_PM2\" no pm2 rodando de outra pasta (${PASTA_DO_PROCESSO:-desconhecida}). Não vou mexer nele. Veja com: pm2 describe $NOME_PM2"
  fi
fi

# porta livre? (se o próprio CRM já está rodando nela, tudo bem)
if node -e '
  const s = require("net").createServer();
  s.once("error", () => process.exit(1));
  s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close(() => process.exit(0)));
' "$PORTA"; then
  echo "    Porta $PORTA livre"
elif [ "$APP_RODANDO" -eq 1 ]; then
  echo "    Porta $PORTA em uso pelo próprio CRM (será reiniciado)"
else
  pare "A porta $PORTA já está em uso por outro programa. Rode de novo com outra, ex.: PORTA=3150 (e troque 3100 no proxy_pass do Nginx)."
fi

echo "==> Baixando o código em $PASTA (branch $BRANCH)"
if [ "$INSTALACAO_NOVA" -eq 1 ]; then
  if ! mkdir "$PASTA" 2>/dev/null; then
    # cria SÓ a pasta do CRM com sudo e passa ela para o seu usuário (não mexe na pasta-mãe)
    sudo mkdir "$PASTA"
    sudo chown "$(id -u):$(id -g)" "$PASTA"
  fi
  git "${GIT_AUTH[@]}" clone -b "$BRANCH" "$REPO" "$PASTA" \
    || { rmdir "$PASTA" 2>/dev/null || true; pare "Não consegui baixar o repositório. Ele é privado: rode antes  export GITHUB_TOKEN=seu_token"; }
else
  git -C "$PASTA" "${GIT_AUTH[@]}" fetch origin "$BRANCH"
  git -C "$PASTA" checkout -q "$BRANCH"
  git -C "$PASTA" "${GIT_AUTH[@]}" pull --ff-only origin "$BRANCH"
fi
cd "$PASTA"

echo "==> Instalando dependências (só dentro de $PASTA)"
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  echo "==> Criando o .env (primeiro administrador do painel)"
  read -rp "E-mail do administrador: " ADMIN_EMAIL </dev/tty
  read -rsp "Senha do administrador (mín. 8 caracteres): " ADMIN_SENHA </dev/tty; echo
  [ "${#ADMIN_SENHA}" -ge 8 ] || pare "A senha precisa ter pelo menos 8 caracteres. Rode de novo."
  cp .env.example .env
  chmod 600 .env
  # node em vez de sed: a senha pode ter qualquer caractere
  ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_SENHA="$ADMIN_SENHA" PORTA="$PORTA" node -e '
    const fs = require("fs");
    const env = fs.readFileSync(".env", "utf8")
      .replace(/^PORT=.*$/m, () => "PORT=" + process.env.PORTA)
      .replace(/^ADMIN_EMAIL=.*$/m, () => "ADMIN_EMAIL=" + process.env.ADMIN_EMAIL)
      .replace(/^ADMIN_SENHA=.*$/m, () => "ADMIN_SENHA=" + process.env.ADMIN_SENHA);
    fs.writeFileSync(".env", env);'
else
  echo "==> .env já existe: mantido como está"
fi

echo "==> Subindo com pm2 (só o processo \"$NOME_PM2\")"
if ! command -v pm2 >/dev/null; then
  echo "    pm2 não encontrado; instalando só o pm2"
  npm install -g pm2 2>/dev/null || sudo npm install -g pm2
fi
if [ "$APP_RODANDO" -eq 1 ]; then
  pm2 restart "$NOME_PM2" --update-env
else
  pm2 start deploy/ecosystem.config.js
fi
pm2 save

PORTA_APP="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
sleep 2
curl -fsS -o /dev/null "http://127.0.0.1:${PORTA_APP:-3100}/crm/login" \
  || pare "O app não respondeu na porta ${PORTA_APP:-3100}. Veja os logs com: pm2 logs $NOME_PM2"
echo "==> App respondendo em http://127.0.0.1:${PORTA_APP:-3100}/crm/"

cat <<EOF

Pronto! Falta só o Nginx (uma vez, manual de propósito):
  1. Ache o arquivo do odingdong.tech:   sudo grep -rl "odingdong.tech" /etc/nginx/
  2. Backup antes de mexer:             sudo cp ARQUIVO ARQUIVO.bak
  3. Confira que ele ainda NÃO tem "location /crm" (se tiver, pare e me avise).
  4. Cole DENTRO do "server { ... }" que tem "listen 443" o conteúdo de:
       $PASTA/deploy/nginx-crm.conf
     (se usou outra porta, troque 3100 no proxy_pass)
  5. sudo nginx -t        <- só siga se aparecer "syntax is ok"
     sudo systemctl reload nginx
     Deu problema? Volte o backup: sudo cp ARQUIVO.bak ARQUIVO && sudo systemctl reload nginx
  6. Abra https://odingdong.tech/crm e entre com o e-mail/senha que você digitou.

Para o app voltar sozinho se a VPS reiniciar, rode uma vez:  pm2 startup  (e o comando que ele mostrar)
EOF
