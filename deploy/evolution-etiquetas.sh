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

# ---------- banco da Evolution (só leitura): etiquetas por número conectado
PG="$(docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null | grep -i evolution | grep -i postgres | head -1 | cut -d'|' -f1)"
if [ -n "$PG" ]; then
  echo "    banco ($PG), só leitura:"
  docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" -At -F " | " -c "
    SELECT i.name, i.\"connectionStatus\", CASE WHEN i.\"businessId\" IS NULL THEN '"'"'sem businessId'"'"' ELSE '"'"'business'"'"' END,
      (SELECT count(*) FROM \"Label\" l WHERE l.\"instanceId\" = i.id) AS etiquetas,
      (SELECT count(*) FROM \"Chat\" c WHERE c.\"instanceId\" = i.id) AS conversas,
      (SELECT count(*) FROM \"Chat\" c WHERE c.\"instanceId\" = i.id AND c.labels IS NOT NULL AND jsonb_array_length(c.labels) > 0) AS conversas_com_etiqueta
    FROM \"Instance\" i ORDER BY i.name;"' 2>&1 | sed 's/^/       instância: /' | head -20
fi
if [ -n "$CONTAINER" ]; then
  for c in $CONTAINER; do
    echo "    avisos de etiqueta no log da Evolution (48 h): $(docker logs "$c" --since 48h 2>&1 | grep -ciE 'labels? ?(edit|association)|LABELS_' || true)"
  done
fi

if [ "$APLICAR" != "1" ]; then
  echo "    (só olhei; nada foi mudado)"
  exit 0
fi
echo "    APLICAR ainda não implementado nesta versão: nada foi mudado."
