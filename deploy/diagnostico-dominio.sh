#!/usr/bin/env bash
# Mostra (só na sua tela, sem mudar nada) o que o domínio odingdong.tech atende
# hoje e quais programas rodam na VPS. Rode na VPS:
#   bash /opt/dingdong-crm/deploy/diagnostico-dominio.sh
# Copie o resultado e mande para o Claude (não aparece senha nem chave).
DOMINIO="${DOMINIO:-odingdong.tech}"

echo "===== Nginx: arquivos que atendem $DOMINIO ====="
for f in $(sudo grep -rlI "$DOMINIO" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null); do
  echo "--- $f  (arquivo real: $(readlink -f "$f"))"
  sudo grep -nE '^\s*(server_name|listen|location|proxy_pass|root|alias|return|try_files|include)\b|^\s*}' "$f" | grep -viE 'ssl_certificate|auth_basic_user_file|password|token|secret'
done

echo
echo "===== pm2: programas (nome | situação | pasta | porta) ====="
pm2 jlist 2>/dev/null | node -e '
  let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
    try {
      for (const p of JSON.parse(t.slice(t.indexOf("[")))) console.log([p.name, p.pm2_env?.status, p.pm2_env?.pm_cwd, "PORT=" + (p.pm2_env?.env?.PORT || p.pm2_env?.PORT || "?")].join("  |  "));
    } catch (e) { console.log("(pm2 não respondeu)"); }
  });' || echo "(sem pm2)"

echo
echo "===== docker (nome | imagem | portas) ====="
(sudo docker ps --format '{{.Names}}  |  {{.Image}}  |  {{.Ports}}' 2>/dev/null) || echo "(sem docker)"

echo
echo "===== pastas de sites ====="
ls -la /var/www 2>/dev/null
ls -la /opt 2>/dev/null
