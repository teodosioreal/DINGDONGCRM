#!/usr/bin/env bash
# Rede (só leitura): por que o CRM abre numa internet e não em outra? DNS (IPv4/IPv6), se o
# servidor atende por IPv6, firewall e IPs bloqueados (mascarados), limites do nginx.
# Não muda nada, não mexe em outros projetos.
DOMINIO="$1"
[ -z "$DOMINIO" ] && { echo "    (sem PUBLIC_URL)"; exit 0; }
mascara() { sed -E 's/([0-9]+\.[0-9]+)\.[0-9]+\.[0-9]+/\1.x.x/g; s/([0-9a-f]+:[0-9a-f]+):[0-9a-f:]+/\1:…/gi'; }
a4="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
# (::ffff:1.2.3.4 é o próprio IPv4 "traduzido": não é endereço IPv6 de verdade)
a6="$(getent ahostsv6 "$DOMINIO" 2>/dev/null | awk '{print $1}' | grep ':' | grep -vi '^::ffff:' | sort -u | tr '\n' ' ')"
meu4="$(curl -4 -s --max-time 8 https://api.ipify.org 2>/dev/null)"
meu6="$(curl -6 -s --max-time 8 https://api64.ipify.org 2>/dev/null)"
echo "    DNS de $DOMINIO: IPv4 ${a4:-nenhum} · IPv6 ${a6:-nenhum}"
echo "    IP deste servidor: IPv4 ${meu4:-?} · IPv6 ${meu6:-não tem}"
[ -n "$a4" ] && [ -n "$meu4" ] && { echo "$a4" | grep -qw "$meu4" && echo "    IPv4 do domínio aponta para este servidor: sim" || echo "    !! IPv4 do domínio NÃO aponta para este servidor"; }
if [ -n "$a6" ]; then
  if [ -z "$meu6" ]; then echo "    !! O domínio tem endereço IPv6, mas este servidor NÃO tem IPv6 — internet que prefere IPv6 (muito Wi-Fi) fica carregando"
  else echo "$a6" | grep -qi "$meu6" && echo "    IPv6 do domínio aponta para este servidor: sim" || echo "    !! IPv6 do domínio NÃO aponta para este servidor (internet com IPv6 vai para outro lugar)"; fi
  echo "    teste pelo IPv6: $(curl -6 -s -o /dev/null -w '%{http_code} em %{time_total}s' --max-time 15 "https://$DOMINIO/login" 2>/dev/null || echo 'SEM RESPOSTA')"
fi
echo "    teste pelo IPv4: $(curl -4 -s -o /dev/null -w '%{http_code} em %{time_total}s' --max-time 15 "https://$DOMINIO/login" 2>/dev/null || echo 'SEM RESPOSTA')"
echo "    nginx escuta em: $(ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' | sort -u | tr '\n' ' ')"
if command -v fail2ban-client >/dev/null 2>&1; then
  for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:\s*//p' | tr ',' ' '); do
    b="$(fail2ban-client status "$j" 2>/dev/null | sed -n 's/.*Banned IP list:\s*//p')"
    echo "    fail2ban [$j]: $(echo "$b" | wc -w) IP(s) bloqueado(s) $(echo "$b" | mascara | cut -c1-200)"
  done
else
  echo "    fail2ban: não instalado (ou sem permissão)"
fi
command -v ufw >/dev/null 2>&1 && echo "    firewall (ufw): $(ufw status 2>/dev/null | head -n 1)"
n="$(iptables -S 2>/dev/null | grep -c -- '-j DROP\|-j REJECT')"; echo "    regras de bloqueio no iptables: ${n:-sem permissão}"
iptables -S 2>/dev/null | grep -E -- '-j (DROP|REJECT)' | mascara | sed 's/^/      iptables: /' | head -n 10
command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -iE 'deny|reject|limit|443|80|Nginx' | mascara | sed 's/^/      ufw: /' | head -n 12
grep -rhsE 'limit_req|limit_conn|deny ' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sed 's/^ */      nginx: /' | sort -u | head -n 8
echo "    nginx bloqueou por limite (últimas linhas do log de erro):"
tail -n 3000 /var/log/nginx/error.log 2>/dev/null | grep -iE 'limiting requests|limiting connections|access forbidden' | tail -n 5 | mascara | sed 's/^/      /'
