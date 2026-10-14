# Passar o CRM de `odingdong.tech/crm` para `odingdong.tech`

O CRM passa a ser o único projeto do domínio. Os outros projetos **saem do
domínio, mas nada é apagado**: os arquivos continuam na VPS e o código
continua no GitHub. Os endereços antigos com `/crm` (código do chat colado nos
sites e webhooks do WhatsApp) **continuam funcionando**.

Tudo abaixo é feito no terminal da VPS (SSH). Cada passo tem como desfazer.

## 0. Diagnóstico (não muda nada)

```bash
bash /opt/dingdong-crm/deploy/diagnostico-dominio.sh
```

Mande o resultado para o Claude. Ele confere quais blocos `location` são de
outros projetos e monta a configuração final.

## 1. Cópia de segurança do Nginx

```bash
ARQ=$(sudo grep -rlI "odingdong.tech" /etc/nginx/sites-enabled | head -n 1)
ARQ=$(readlink -f "$ARQ"); echo "$ARQ"
sudo cp "$ARQ" "$ARQ.bak-$(date +%F)"
```

## 2. Trocar os blocos do domínio

Abra o arquivo (`sudo nano "$ARQ"`). Dentro do `server { ... }` que tem
`listen 443`:

- **apague** os blocos `location` dos outros projetos e o `location /crm/`
  antigo (e o `location = /crm`);
- **cole** no lugar o conteúdo de `/opt/dingdong-crm/deploy/nginx-crm-raiz.conf`.

Não mexa nas linhas `ssl_certificate`, `listen` e `server_name`.

Depois:

```bash
sudo nginx -t                    # só siga se aparecer "syntax is ok"
sudo systemctl reload nginx
```

## 3. Avisar o CRM que ele está na raiz

No `/opt/dingdong-crm/.env`, deixe assim:

```
BASE_PATH=
PUBLIC_URL=https://odingdong.tech
```

E reinicie só o CRM:

```bash
pm2 restart dingdong-crm --update-env
```

## 4. Testar

- `https://odingdong.tech` → abre o login/painel do CRM
- `https://odingdong.tech/crm` → vai sozinho para `https://odingdong.tech`
- `https://odingdong.tech/crm/chat.js` → mostra o código do chat (sites antigos)
- Mande uma mensagem de teste no WhatsApp da Madara e veja se chega no painel

Na primeira vez, todo mundo precisa entrar de novo (o login muda de endereço).

## 5. (Opcional) Desligar os outros projetos sem apagar

Para eles não ficarem gastando memória da VPS:

```bash
pm2 stop NOME_DO_PROJETO     # para; os arquivos ficam onde estão
pm2 save                     # lembra disso quando a VPS reiniciar
```

Para religar um dia: `pm2 start NOME_DO_PROJETO && pm2 save`.

## Desfazer tudo

```bash
sudo cp "$ARQ.bak-AAAA-MM-DD" "$ARQ" && sudo nginx -t && sudo systemctl reload nginx
```

E no `.env` volte `BASE_PATH=/crm` e `PUBLIC_URL=https://odingdong.tech/crm`,
depois `pm2 restart dingdong-crm --update-env`.
