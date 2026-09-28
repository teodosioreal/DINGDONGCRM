# DingDong CRM — IA no site + IA no WhatsApp, com funil de leads

Painel em `https://odingdong.tech/crm` para acompanhar **em que etapa cada lead
está**, com duas IAs trabalhando juntas no atendimento de cada empresa:

1. **IA do site** — um botão verde no site abre um chat estilo WhatsApp. A IA
   tira as dúvidas, qualifica o visitante e, quando ele quer avançar, oferece
   continuar no WhatsApp com a mensagem já escrita (com um código, ex.
   `#K7P2QX`).
2. **IA do WhatsApp** — responde no número da empresa. Quem veio do site chega
   com o código, e a IA **continua de onde a IA do site parou**, com todo o
   histórico. Ela segue as instruções da empresa, **envia mídias** (fotos,
   vídeos, PDFs, áudios), **move o lead de etapa** e **chama uma pessoa da
   equipe** quando precisa. Se alguém da equipe responder (pelo celular ou pelo
   painel), a IA para naquele lead.

Cada empresa cadastra a **própria chave de IA** (Claude ou Gemini) e cola **um
código** no cabeçalho ou rodapé do site (Lovable, WordPress, Wix, HTML…).

É um app separado: roda numa porta própria da VPS e o Nginx só encaminha o
caminho `/crm`. O resto do domínio `odingdong.tech` não é tocado.

## O que tem

O visual segue o do painel DingDong (menu lateral, tons de cinza, modo escuro
no botão do canto). Dentro de cada empresa o menu mostra:

- **Painel** — leads dos últimos 7 dias, quantos chegaram no WhatsApp, quantos
  estão esperando a equipe, o funil por etapa e um passo a passo do que falta
  configurar.
- **Leads** — quadro por etapa (Novo → Conversando no site → No WhatsApp →
  Qualificado → Proposta / agendamento → Fechado / Perdido; dá para editar as
  etapas). Abrindo um lead: a conversa inteira (site + WhatsApp, marcando quem
  escreveu: cliente, IA ou equipe), a etapa, o histórico de etapas (quem mudou:
  IA do site, IA do WhatsApp ou equipe), anotações, **pausar/devolver para a
  IA** e **responder pelo WhatsApp** direto do painel.
- **Assistente IA** — qual IA responde (Claude ou Gemini) e o modelo; nome,
  foto, cor e boas-vindas do chat; **tudo o que a IA precisa saber** (comum às
  duas IAs); **instruções da IA do site** e **instruções da IA do WhatsApp**;
  sites autorizados. O **chat de teste** simula as duas IAs e mostra as ações
  que ela tomaria (enviar mídia, mudar etapa, chamar a equipe).
- **WhatsApp** — conexão com a Evolution API da empresa (endereço, instância,
  API key), ver conexão, **QR code** para conectar o número, **ligar o webhook
  automaticamente** e ligar/desligar a IA no WhatsApp.
- **Mídias** — fotos, vídeos, PDFs e áudios (até 16 MB) que a IA do WhatsApp
  pode enviar. O nome e a descrição dizem para a IA quando usar cada um.
- **Chave de IA** — a chave do Gemini e/ou do Claude **da empresa** (o custo
  cai na conta dela). Fica só no servidor; o painel mostra só os 4 últimos
  caracteres.
- **Instalar no site** — o código da empresa e onde colar em cada plataforma.

Para o administrador: **Empresas**, **Usuários** (admin ou usuário de empresa,
que só vê a própria empresa) e **Chave padrão (opcional)** — usada só pelas
empresas que ainda não têm chave própria.

### Como as duas IAs se conversam

- O "conhecimento" (serviços, preços, dúvidas) é o mesmo para as duas; cada
  uma tem as **suas instruções** (o site conduz e qualifica; o WhatsApp
  continua, manda mídia, agenda e passa para a equipe).
- A IA do site termina com o botão "Continuar no WhatsApp". A mensagem leva o
  código do atendimento; quando ela chega no WhatsApp, o CRM junta as duas
  conversas no **mesmo lead** e move para "No WhatsApp".
- A IA do WhatsApp recebe o histórico inteiro e é instruída a **não recomeçar**
  a conversa: retoma de onde parou.
- As IAs podem pedir ações escrevendo marcações que o cliente nunca vê:
  `[[ETAPA: Qualificado]]` (move o lead), `[[MIDIA: Tabela de preços]]` (envia
  a mídia com esse nome) e `[[HUMANO]]` (avisa a equipe e para de responder).
- Mensagens seguidas do cliente viram **uma resposta só** (a IA espera uns
  segundos ele parar de digitar).
- Quem chega direto no WhatsApp (sem passar pelo site) vira um lead novo, já
  em "No WhatsApp".

### Widget (`chat.js`)

Não depende de framework, fica isolado do visual do site (Shadow DOM) e lembra
a conversa por 24h. No **celular** a janela ocupa cerca de 70% da altura da tela
— grande o bastante para conversar, sem cobrir o site inteiro — e o botão verde
continua visível embaixo para fechar.

Proteções: o assistente só aparece nos **sites autorizados**, limite de 12
mensagens/minuto por IP, limite de mensagens por conversa e **por dia** (para
controlar o custo da IA), e o visitante sempre vê que está falando com um
assistente virtual.

## Instalar na VPS

O instalador foi feito para **não tocar em nada que já existe** na VPS:
usa uma pasta só dele (`/opt/dingdong-crm`), um processo só dele no pm2
(`dingdong-crm`) e uma porta livre (3100). Não instala nem atualiza o Node do
sistema e não mexe no Nginx. Se encontrar qualquer conflito (pasta de outro
projeto, porta ocupada, processo com o mesmo nome), ele **para e explica**
sem alterar nada.

Pré-requisitos: Node.js 18+ já instalado, `git`, e um token do GitHub só de
leitura (o repositório é privado): GitHub → Settings → Developer settings →
Fine-grained tokens → acesso só a `DINGDONGCRM`, permissão *Contents: Read-only*.

```bash
export GITHUB_TOKEN=github_pat_xxx
curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
  https://raw.githubusercontent.com/teodosioreal/DINGDONGCRM/main/deploy/instalar.sh | bash
```

Ele pergunta o e-mail e a senha do administrador, sobe o app e confere se
está respondendo. Opções: `PASTA=/outro/lugar` e `PORTA=3150` antes do `bash`.

**Nginx (manual, uma vez):** faça backup do arquivo do site
(`sudo cp ARQUIVO ARQUIVO.bak`), confira que ele ainda não tem `location /crm`,
cole o conteúdo de [`deploy/nginx-crm.conf`](deploy/nginx-crm.conf) **dentro**
do `server { ... }` que tem `listen 443`, e só recarregue se o teste passar:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

O bloco já permite envios de até 20 MB (as mídias do WhatsApp). Se você colou
a versão antiga (com `client_max_body_size 1m`), troque para `20m`.

Acesse `https://odingdong.tech/crm`, entre com o e-mail/senha que você
digitou e troque a senha em **Minha conta**. Para o app voltar sozinho após
reiniciar a VPS: `pm2 startup` (uma vez).

### Atualizar depois: automático a cada push

Depois de instalado, **todo `git push` na `main` deste repositório atualiza a
VPS sozinho** (GitHub Actions → [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
→ [`deploy/atualizar.sh`](deploy/atualizar.sh)). Ele:

- mexe **só** em `/opt/dingdong-crm` e reinicia **só** o processo `dingdong-crm`
  (outros apps do pm2 e outros sites da VPS não são tocados);
- instala dependências só quando o `package-lock.json` muda;
- mantém o `.env` e o `data.json` (dados) como estão;
- testa se o painel respondeu; **se a versão nova não subir, volta sozinho
  para a anterior** e o deploy fica vermelho no GitHub;
- para sem mexer em nada se achar arquivo editado à mão na VPS.

Para ligar (uma vez): em **GitHub → DINGDONGCRM → Settings → Secrets and
variables → Actions → New repository secret**, cadastre:

| Segredo | Valor |
|---|---|
| `VPS_HOST` | IP (ou domínio) da VPS |
| `VPS_USER` | usuário do SSH — o mesmo que rodou o instalador (ex.: `root`) |
| `VPS_SSH_KEY` | a chave **privada** cuja pública está em `~/.ssh/authorized_keys` da VPS |
| `VPS_PORT` | (opcional) porta do SSH, se não for 22 |

Podem ser os mesmos valores usados no rastreador — os segredos são de cada
repositório, então cadastrar aqui não muda nada lá. Para rodar sem um push
novo: **Actions → Deploy na VPS → Run workflow**.

Sem os segredos, dá para atualizar à mão na VPS:
`GITHUB_TOKEN=seu_token bash /opt/dingdong-crm/deploy/atualizar.sh`.

### Backup

Todos os dados ficam em `/opt/dingdong-crm/data.json` e as mídias em
`/opt/dingdong-crm/midias/` (incluindo as chaves de IA cadastradas
pelo painel — o arquivo é gravado com permissão 600, só o usuário do app lê).
Copie esse arquivo de vez em quando. Rode só **uma** instância do app —
o arquivo não suporta dois processos escrevendo ao mesmo tempo.

## Usar

1. **Empresas** → nova empresa (nome, nicho, WhatsApp com DDD e o site).
   O painel da empresa abre com o passo a passo.
2. **Chave de IA** → cole a chave do Gemini (aistudio.google.com/apikey) e/ou
   do Claude (console.anthropic.com) da empresa.
3. **Assistente IA** → escolha Gemini ou Claude, preencha *"Tudo o que a IA
   precisa saber"*, as **instruções da IA do site** e as **instruções da IA do
   WhatsApp**, e teste as duas no chat ao lado até ficar bom.
4. **WhatsApp** → endereço da Evolution API, nome da instância e API key →
   Salvar → **Conectar (QR code)** (escaneie com o celular da empresa) →
   **Ligar o webhook automaticamente**.
5. **Mídias** (opcional) → envie as fotos, vídeos, PDFs e áudios que a IA pode
   mandar, com um nome e quando usar.
6. **Instalar no site** → cole o código uma vez no cabeçalho (`<head>`) ou no rodapé:

   ```html
   <script src="https://odingdong.tech/crm/chat.js" data-empresa="emp_xxxxxxxx" async></script>
   ```

   - **WordPress:** plugin "WPCode" → *Header & Footer* → Header ou Footer.
   - **Lovable:** peça no chat do Lovable "adicione este script em todas as
     páginas" e cole o código.
   - **Wix:** Configurações → Código personalizado → todas as páginas.
   - **HTML:** no `<head>` ou antes de `</body>`.
   - Opcional: `data-posicao="esquerda"` coloca o botão no canto esquerdo.

   Você pode mudar as IAs, os textos e o modelo quando quiser pelo painel —
   o código no site continua o mesmo.

**Empresa com mais de um site:** crie outro assistente na mesma empresa e
cadastre o domínio dele em *Sites autorizados*. O mesmo código da empresa
mostra esse assistente naquele site e o principal nos demais. (Se precisar
fixar um assistente específico, use o código avançado com `data-bot`.)

## Custo da IA

Cada mensagem do visitante é uma chamada à IA escolhida no assistente,
cobrada por uso na conta da Anthropic ou do Google **da chave da empresa**.

- **Claude:** padrão **Opus 5** com esforço baixo (respostas rápidas); dá para
  trocar para **Sonnet 5** ou **Haiku 4.5**, que custam menos.
- **Gemini:** o painel lista os modelos que a sua chave pode usar
  (ex.: `gemini-2.5-flash`, bom custo-benefício para atendimento).

O "limite de mensagens por dia" de cada assistente (definido pelo
administrador) é o teto de gasto: ao chegar nele, o chat passa o visitante
direto para o WhatsApp.

## Variáveis do `.env`

| Variável | Para que serve |
|---|---|
| `PORT` / `HOST` | Porta interna (padrão 3100, só em 127.0.0.1) |
| `BASE_PATH` | Caminho no domínio (padrão `/crm`) |
| `PUBLIC_URL` | Endereço público, usado no código de incorporação |
| `ANTHROPIC_API_KEY` | Chave padrão do Claude (opcional — cada empresa cadastra a sua no painel) |
| `GEMINI_API_KEY` | Chave padrão do Gemini (opcional — cada empresa cadastra a sua no painel) |
| `EVOLUTION_API_URL` | Endereço da Evolution API sugerido nas empresas (opcional) |
| `WHATSAPP_ESPERA_MS` | Espera (ms) o cliente parar de digitar antes de a IA responder (padrão 6000) |
| `MIDIAS_DIR` | Pasta das mídias (padrão `midias/` dentro do app) |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | Primeiro administrador (criado só uma vez) |
| `COOKIE_SECURE` | `true` em produção (HTTPS); `false` só para testar em http |

## Estrutura

```
server.js              → Express montado em /crm
src/config.js          → lê o .env
src/db.js              → banco em JSON (data.json), gravação atômica
src/auth.js            → login, sessões, primeiro admin
src/ia.js              → prompts da IA do site e do WhatsApp; chama o Claude ou o Gemini
src/leads.js           → leads, etapas do funil e o código que liga site ↔ WhatsApp
src/whatsapp.js        → Evolution API: webhook, IA respondendo, mídias, pausa quando a equipe responde
src/midias.js          → biblioteca de mídias de cada empresa
src/rotas-painel.js    → API do painel (empresas, assistentes, leads, WhatsApp, mídias, usuários)
src/rotas-publicas.js  → API do widget (config, chat) e webhook do WhatsApp
public/                → painel (HTML/CSS/JS puro) e o widget chat.js
deploy/                → instalador, atualizador, bloco do Nginx e config do pm2
.github/workflows/     → deploy automático na VPS a cada push na main
```
