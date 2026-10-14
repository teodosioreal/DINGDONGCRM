# Passar o CRM de `odingdong.tech/crm` para `odingdong.tech`

O CRM passa a ser o único projeto do domínio. O projeto que hoje abre na raiz
(porta 3000) **sai do domínio, mas nada é apagado nem desligado**: os arquivos
continuam na VPS e o código continua no GitHub. Os endereços antigos com `/crm`
(código do chat colado nos sites e webhooks do WhatsApp) **continuam
funcionando**.

Não muda: outros domínios do mesmo arquivo do Nginx (ex.: `avaliacao.privefeet.pro`),
o bloco da porta 80, a Evolution API e os outros programas do pm2/docker.

## 1. Rodar (na VPS, como root)

```bash
bash /opt/dingdong-crm/deploy/aplicar-raiz.sh
```

O script:

1. guarda cópias do Nginx e do `.env` em `/root/backup-raiz-DATA` (fora da
   pasta do Nginx, para o Nginx não ler a cópia junto);
2. troca só os `location` do bloco HTTPS do `odingdong.tech` pelo conteúdo de
   `deploy/nginx-crm-raiz.conf`;
3. roda `nginx -t`;
4. muda no `.env`: `BASE_PATH=` e `PUBLIC_URL=https://odingdong.tech`;
5. recarrega o Nginx, reinicia só o CRM e testa `/`, `/login`, `/crm`,
   `/crm/chat.js`, `/api/...` e `/termos`.

Se qualquer teste falhar, **ele volta tudo sozinho** e avisa.

## 2. Conferir

- `https://odingdong.tech` → abre o login/painel do CRM
- `https://odingdong.tech/crm` → vai sozinho para `https://odingdong.tech`
- Mande uma mensagem de teste no WhatsApp da Madara e veja se chega no painel

Na primeira vez, todo mundo precisa entrar de novo (o login muda de endereço).

## Desfazer

O script mostra no final o comando certo, algo como:

```bash
bash /opt/dingdong-crm/deploy/desfazer-raiz.sh /root/backup-raiz-AAAA-MM-DD-HHMMSS
```

## (Opcional) O projeto da porta 3000

Ele continua rodando na VPS, só não abre mais pelo domínio. Se um dia quiser
desligar para economizar memória, sem apagar nada: descubra o programa com
`ss -ltnp | grep :3000` e pare só ele. Para religar, é só iniciar de novo.
