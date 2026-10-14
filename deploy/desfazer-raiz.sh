#!/usr/bin/env bash
# Volta o Nginx e o .env para como estavam antes do aplicar-raiz.sh:
#   bash /opt/dingdong-crm/deploy/desfazer-raiz.sh /root/backup-raiz-AAAA-MM-DD-HHMMSS
set -euo pipefail
BKP="${1:-}"
[ -n "$BKP" ] && [ -f "$BKP/caminho-nginx.txt" ] || { echo "Informe a pasta do backup (ex.: /root/backup-raiz-2026-10-14-120000)"; ls -d /root/backup-raiz-* 2>/dev/null; exit 1; }
ARQ="$(cat "$BKP/caminho-nginx.txt")"
cp -a "$BKP/nginx-$(basename "$ARQ")" "$ARQ"
cp -a "$BKP/env" /opt/dingdong-crm/.env
nginx -t && systemctl reload nginx
pm2 restart dingdong-crm --update-env
echo "Voltou como era: CRM em https://odingdong.tech/crm e o projeto da porta 3000 na raiz."
