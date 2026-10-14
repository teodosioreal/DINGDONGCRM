#!/usr/bin/env bash
# Passa o CRM de odingdong.tech/crm para odingdong.tech (raiz), na VPS:
#   bash /opt/dingdong-crm/deploy/aplicar-raiz.sh
#
# - Guarda cópias do Nginx e do .env em /root/backup-raiz-DATA (fora da pasta do Nginx)
# - Troca SÓ os "location" do server HTTPS do odingdong.tech (o projeto da
#   porta 3000 sai do domínio; outros domínios e a porta 80 não mudam)
# - Os endereços antigos /crm/... continuam funcionando (chat dos sites e WhatsApp)
# - Não apaga nem para nenhum outro projeto
# - Se o teste do Nginx ou do CRM falhar, volta tudo sozinho
set -euo pipefail

DOMINIO="odingdong.tech"
PASTA="/opt/dingdong-crm"
NOME_PM2="dingdong-crm"
pare() { echo "!! $*"; exit 1; }

[ "$(id -u)" = 0 ] || pare "Rode como root."
command -v nginx >/dev/null || pare "nginx não encontrado."
ARQ="$(grep -rlI "server_name[^;]*$DOMINIO" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -n 1 || true)"
[ -n "$ARQ" ] || pare "Não achei o arquivo do Nginx com $DOMINIO."
ARQ="$(readlink -f "$ARQ")"
[ -f "$PASTA/.env" ] || pare "Não achei $PASTA/.env."

BKP="/root/backup-raiz-$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$BKP" && chmod 700 "$BKP"
cp -a "$ARQ" "$BKP/nginx-$(basename "$ARQ")"
cp -a "$PASTA/.env" "$BKP/env"
echo "$ARQ" > "$BKP/caminho-nginx.txt"
echo "==> Cópias de segurança em $BKP"

voltar() {
  echo "!! Algo deu errado. Voltando como estava…"
  cp -a "$BKP/nginx-$(basename "$ARQ")" "$ARQ"
  cp -a "$BKP/env" "$PASTA/.env"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  pm2 restart "$NOME_PM2" --update-env >/dev/null
  echo "!! Voltou tudo como era. Nada foi perdido. Mande esta tela para o Claude."
  exit 1
}

echo "==> Trocando o bloco do $DOMINIO no Nginx ($ARQ)"
NOVO="$(mktemp)"
python3 "$PASTA/deploy/nginx-raiz.py" "$ARQ" "$PASTA/deploy/nginx-crm-raiz.conf" "$DOMINIO" > "$NOVO" || { rm -f "$NOVO"; pare "Não consegui montar a configuração nova. Nada foi mudado."; }
cat "$NOVO" > "$ARQ"
rm -f "$NOVO"
nginx -t || voltar

echo "==> Avisando o CRM que ele está na raiz (.env)"
mudar_env() { # troca ou acrescenta CHAVE=VALOR
  if grep -qE "^$1=" "$PASTA/.env"; then sed -i -E "s#^$1=.*#$1=$2#" "$PASTA/.env"; else printf '\n%s=%s\n' "$1" "$2" >> "$PASTA/.env"; fi
}
mudar_env BASE_PATH ""
mudar_env PUBLIC_URL "https://$DOMINIO"

systemctl reload nginx
pm2 restart "$NOME_PM2" --update-env >/dev/null
echo "==> Esperando o CRM subir…"

testar() { # caminho código_esperado
  local cod
  for _ in $(seq 1 15); do
    cod="$(curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMINIO:443:127.0.0.1" "https://$DOMINIO$1" || true)"
    [ "$cod" = "$2" ] && { echo "   ok  $1 → $cod"; return 0; }
    sleep 1
  done
  echo "   ERRO $1 → $cod (esperava $2)"
  return 1
}
testar /login 200 || voltar
testar / 200 || voltar
testar /crm 301 || voltar
testar /crm/login 301 || voltar
testar /crm/chat.js 200 || voltar
testar /chat.js 200 || voltar
testar /api/auth/opcoes 200 || voltar
testar /termos 200 || voltar

echo
echo "==> Pronto! O CRM agora abre em https://$DOMINIO"
echo "    Os endereços antigos /crm/... continuam funcionando."
echo "    O projeto da porta 3000 saiu do domínio, mas continua na VPS, sem nada apagado:"
(ss -ltnp 2>/dev/null | grep -E ':3000\s' | sed -E 's/.*users:\(\("([^"]+)".*/    programa na porta 3000: \1/') || true
echo
echo "    Para desfazer:  bash $PASTA/deploy/desfazer-raiz.sh $BKP"
