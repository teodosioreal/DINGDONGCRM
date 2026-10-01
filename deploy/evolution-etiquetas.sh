#!/usr/bin/env bash
# Etiquetas do WhatsApp Business na Evolution API (servidor que o CRM e o
# DingDong Tracking usam). Por padrão SÓ OLHA: mostra onde a Evolution está
# instalada e as opções DATABASE_SAVE_* (true/false). Nunca mostra chaves,
# senhas nem o endereço do banco.
#
# Com APLICAR=1 liga DATABASE_SAVE_DATA_LABELS=true (a Evolution passa a
# guardar as etiquetas e o CRM consegue lê-las), fazendo backup do arquivo de
# configuração antes e reiniciando só a Evolution. Se algo não bater com o
# esperado, não mexe em nada.
set -uo pipefail

APLICAR="${APLICAR:-0}"
SEGURAS='^(DATABASE_(ENABLED|PROVIDER|SAVE_[A-Z_]+|DELETE_[A-Z_]+)|SERVER_TYPE|CACHE_(REDIS|LOCAL)_ENABLED)='
echo "==> Evolution API: etiquetas (APLICAR=$APLICAR)"

# ---------- Docker
CONTAINER=""
if command -v docker >/dev/null 2>&1; then
  mapfile -t linhas < <(docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | grep -i 'evolution' || true)
  for l in "${linhas[@]}"; do echo "    docker: $l"; done
  for l in "${linhas[@]}"; do
    nome="${l%%|*}"; imagem="$(echo "$l" | cut -d'|' -f2)"
    # o container da API (não o banco/redis do mesmo projeto)
    if echo "$imagem" | grep -qiE 'evolution-api|evoapicloud|atendai'; then CONTAINER="${CONTAINER:+$CONTAINER }$nome"; fi
  done
  for c in $CONTAINER; do
    echo "    -- $c"
    docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E "$SEGURAS" | sed 's/^/       env: /'
    docker inspect "$c" --format '       compose: projeto={{index .Config.Labels "com.docker.compose.project"}} pasta={{index .Config.Labels "com.docker.compose.project.working_dir"}} arquivos={{index .Config.Labels "com.docker.compose.project.config_files"}} serviço={{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null
    docker inspect "$c" --format '       env_file: {{range .HostConfig.Binds}}{{.}} {{end}}' 2>/dev/null | head -c 300; echo
  done
else
  echo "    docker: não instalado"
fi

# ---------- pm2 (instalação sem Docker)
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | node -e '
    let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
      try {
        for (const p of JSON.parse(t.slice(t.indexOf("[")))) {
          const cwd = (p.pm2_env && p.pm2_env.pm_cwd) || "";
          if (/evolution/i.test(p.name + " " + cwd)) console.log(`    pm2: ${p.name} | ${cwd} | ${p.pm2_env.status}`);
        }
      } catch {}
    });' || true
fi

# ---------- arquivos .env da Evolution (só as opções seguras)
for f in /opt/evolution*/.env /opt/evolution*/*/.env /root/evolution*/.env /root/evolution*/*/.env /home/*/evolution*/.env /var/www/evolution*/.env /srv/evolution*/.env; do
  [ -f "$f" ] || continue
  echo "    arquivo: $f"
  grep -E "$SEGURAS" "$f" | sed 's/^/       /'
done

if [ "$APLICAR" != "1" ]; then
  echo "    (só olhei; nada foi mudado)"
  exit 0
fi
echo "    APLICAR ainda não implementado nesta versão: nada foi mudado."
