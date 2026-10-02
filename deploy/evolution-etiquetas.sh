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
  # acha o banco/esquema que tem a tabela "Label" (o nome do banco vem da configuração da Evolution)
  for BD in $(docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d postgres -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate"' 2>/dev/null); do
    ESQ=$(docker exec -e BD="$BD" "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$BD" -At -c "SELECT table_schema FROM information_schema.tables WHERE table_name = '"'"'Label'"'"' LIMIT 1"' 2>/dev/null)
    [ -n "$ESQ" ] || continue
    echo "       banco=$BD esquema=$ESQ"
    docker exec -e BD="$BD" -e ESQ="$ESQ" -e INST="${INSTANCIAS:-}" "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$BD" -At -F " | " -c "
      SET search_path TO \"$ESQ\";
      SELECT i.name, i.\"connectionStatus\", CASE WHEN i.\"businessId\" IS NULL THEN '"'"'sem businessId'"'"' ELSE '"'"'business'"'"' END,
        (SELECT count(*) FROM \"Label\" l WHERE l.\"instanceId\" = i.id) AS etiquetas,
        (SELECT string_agg(l.name, '"'"', '"'"') FROM \"Label\" l WHERE l.\"instanceId\" = i.id) AS nomes,
        (SELECT count(*) FROM \"Chat\" c WHERE c.\"instanceId\" = i.id) AS conversas,
        (SELECT count(*) FROM \"Chat\" c WHERE c.\"instanceId\" = i.id AND c.labels IS NOT NULL AND jsonb_typeof(c.labels) = '"'"'array'"'"' AND jsonb_array_length(c.labels) > 0) AS conversas_com_etiqueta
      FROM \"Instance\" i WHERE i.name = ANY(string_to_array('"'"'$INST'"'"', '"'"','"'"')) ORDER BY i.name;"' 2>&1 | grep -v '^SET$' | sed -E 's/[0-9]{8,}/[núm]/g; s/^/       instância (do CRM): /' | head -20
    # números ligados por instâncias criadas pelo CRM (nome crm-…): qual celular é qual (só os 4 últimos dígitos)
    docker exec -e BD="$BD" -e ESQ="$ESQ" "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$BD" -At -F " | " -c "
      SET search_path TO \"$ESQ\";
      SELECT i.name, i.\"connectionStatus\", '"'"'final '"'"' || right(split_part(coalesce(i.\"ownerJid\", '"'"''"'"'), '"'"'@'"'"', 1), 4),
        (SELECT count(*) FROM \"Label\" l WHERE l.\"instanceId\" = i.id) AS etiquetas,
        (SELECT max(l.\"updatedAt\") FROM \"Label\" l WHERE l.\"instanceId\" = i.id) AS ultima_etiqueta
      FROM \"Instance\" i WHERE i.name LIKE '"'"'crm-%'"'"' ORDER BY i.name;"' 2>&1 | grep -v '^SET$' | sed 's/^/       instância crm-*: /' | head -10
  done
fi
# ---------- cópia das etiquetas dos números DO CRM para o CRM importar (só leitura na Evolution)
# EXPORTAR=<arquivo> e INSTANCIAS=<nomes separados por vírgula> (vêm do atualizar.sh)
if [ -n "${EXPORTAR:-}" ] && [ -n "${INSTANCIAS:-}" ] && [ -n "$PG" ]; then
  if ! printf '%s' "$INSTANCIAS" | grep -qE '^[A-Za-z0-9_.,-]+$'; then
    echo "    exportar: nomes de instância estranhos, pulei"
  else
    for BD in $(docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d postgres -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate"' 2>/dev/null); do
      ESQ=$(docker exec -e BD="$BD" "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$BD" -At -c "SELECT table_schema FROM information_schema.tables WHERE table_name = '"'"'Label'"'"' LIMIT 1"' 2>/dev/null)
      [ -n "$ESQ" ] || continue
      TMP="$EXPORTAR.tmp"
      if docker exec -i -e BD="$BD" -e ESQ="$ESQ" -e INST="$INSTANCIAS" "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$BD" -At -v ON_ERROR_STOP=1 -v inst="$INST" -v esq="$ESQ"' \
          < "$(dirname "$0")/evolution-export.sql" 2>/dev/null | grep -v '^SET$' > "$TMP" && [ -s "$TMP" ]; then
        chmod 600 "$TMP" && mv "$TMP" "$EXPORTAR"
        echo "    exportar: etiquetas e ligações LID→número dos números do CRM copiadas ($(wc -c < "$EXPORTAR") bytes; $(grep -o '"lid"' "$EXPORTAR" | wc -l) ligações)"
      else
        rm -f "$TMP"; echo "    exportar: não consegui ler (nada mudou)"
      fi
      break
    done
  fi
fi

if [ -n "$CONTAINER" ]; then
  for c in $CONTAINER; do
    echo "    avisos de etiqueta no log da Evolution (48 h): $(docker logs "$c" --since 48h 2>&1 | grep -ciE 'labels? ?(edit|association)|LABELS_' || true)"
    docker logs "$c" --since 48h 2>&1 | grep -iE 'labels? ?(edit|association)|LABELS_' | grep -F "$(printf '%s' "${INSTANCIAS:-@@}" | tr ',' '\n')" | sed -E 's/[0-9]{8,}/[núm]/g; s/\x1b\[[0-9;]*m//g' | cut -c1-220 | sort | uniq -c | sort -rn | head -8 | sed 's/^/       /'
  done
fi

# sincronização de etiquetas/listas do celular (app state) dos números do CRM: erros e avisos
if [ -n "$CONTAINER" ] && [ -n "${INSTANCIAS:-}" ]; then
  for c in $CONTAINER; do
    for inst in $(printf '%s' "$INSTANCIAS" | tr ',' ' '); do
      echo "    sincronização do celular ($inst, 7 dias):"
      docker logs "$c" --since 168h 2>&1 | grep -F "$inst" | grep -iE 'app ?state|resync|syncd|sync state|patch|label|critical_|regular_|mutation|appStateSync|connection|qrcode|logout' \
        | sed -E 's/[0-9]{8,}/[núm]/g; s/\x1b\[[0-9;]*m//g; s/^.*(INFO|WARN|ERROR|VERBOSE|DEBUG)/\1/' | cut -c1-170 | sort | uniq -c | sort -rn | head -12 | sed 's/^/       /'
    done
  done
fi

if [ "$APLICAR" != "1" ]; then
  echo "    (só olhei; nada foi mudado)"
  exit 0
fi
echo "    APLICAR ainda não implementado nesta versão: nada foi mudado."
