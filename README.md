# DingDong CRM — assistentes de IA para sites (chat estilo WhatsApp)

Painel em `https://odingdong.tech/crm` onde você cadastra empresas, cada uma
cadastra a **própria chave de IA** (**Claude** ou **Gemini**), e pega **um código por empresa**
para colar uma vez no cabeçalho ou rodapé de qualquer site (Lovable,
WordPress, Wix, HTML…). No site aparece um botão verde
de WhatsApp; ao clicar, abre uma janela de conversa estilo WhatsApp onde a IA
tira as dúvidas do visitante e, quando ele quer fechar, passa para o WhatsApp
de verdade da empresa com a mensagem já escrita — e nesse momento dispara o
**Lead no Meta Ads** e a **conversão no Google Ads** (ligado por padrão).

É um app separado: roda numa porta própria da VPS e o Nginx só encaminha o
caminho `/crm`. O resto do domínio `odingdong.tech` não é tocado.

## O que tem

O visual segue o do painel DingDong (menu lateral, tons de cinza, modo escuro
no botão do canto). Dentro de cada empresa o menu mostra:

- **Painel** — conversas e leads dos últimos 7 dias e um passo a passo do que
  falta configurar.
- **Assistente IA** — qual IA responde (Claude ou Gemini) e o modelo (a lista
  do Gemini vem da própria chave), nome e foto no chat, cor, boas-vindas,
  balão de chamada, tom de voz, **tudo o que a IA precisa saber** (serviços,
  preços, dúvidas comuns), regras extras, WhatsApp e sites autorizados. Tem um
  **chat de teste** ao lado do formulário.
- **Conversas** — tudo o que os visitantes perguntaram, quem foi pro WhatsApp
  e quais conversões foram disparadas (Meta / Google).
- **Chave de IA** — a chave do Gemini e/ou do Claude **da empresa** (o custo
  cai na conta dela). Fica só no servidor; o painel mostra só os 4 últimos
  caracteres.
- **Conversões (Meta / Google)** — veja abaixo.
- **Instalar no site** — o código da empresa e onde colar em cada plataforma.

Para o administrador: **Empresas**, **Usuários** (admin ou usuário de empresa,
que só vê a própria empresa) e **Chave padrão (opcional)** — usada só pelas
empresas que ainda não têm chave própria.

### Conversões quando o visitante vai para o WhatsApp

Quando o visitante clica em "Continuar no WhatsApp" (ou no ícone do WhatsApp no
topo do chat), o chat dispara no navegador dele, **uma vez por conversa**:

- **Meta Ads — evento `Lead`** (ligado por padrão). Usa o pixel que o site já
  tem; se a empresa cadastrar um Pixel ID, manda para esse pixel (e carrega o
  pixel oficial se o site não tiver nenhum).
- **Google Ads — conversão de Lead** (ligado por padrão). Com o rótulo
  `AW-XXXXXXXXX/YYYYYYY` cadastrado, dispara a conversão (e carrega o gtag se o
  site não tiver). Sem rótulo, manda o evento `generate_lead`, que dá para
  importar como conversão pelo GA4.
- **Google Tag Manager** — evento `dingdong_lead` no `dataLayer`.

O valor do lead (opcional) vai junto nas duas plataformas. Tudo é por
empresa, em **Conversões** no menu dela.

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

Acesse `https://odingdong.tech/crm`, entre com o e-mail/senha que você
digitou e troque a senha em **Minha conta**. Para o app voltar sozinho após
reiniciar a VPS: `pm2 startup` (uma vez).

### Atualizar depois

Rode o mesmo comando de instalação: ele detecta que já está instalado, baixa
a versão nova, mantém o `.env` e os dados, e reinicia só o `dingdong-crm`.

### Backup

Todos os dados ficam em `/opt/dingdong-crm/data.json` (incluindo as chaves de IA cadastradas
pelo painel — o arquivo é gravado com permissão 600, só o usuário do app lê).
Copie esse arquivo de vez em quando. Rode só **uma** instância do app —
o arquivo não suporta dois processos escrevendo ao mesmo tempo.

## Usar

1. **Empresas** → nova empresa (nome, nicho, WhatsApp com DDD e o site).
   O painel da empresa abre com o passo a passo.
2. **Chave de IA** → cole a chave do Gemini (aistudio.google.com/apikey) e/ou
   do Claude (console.anthropic.com) da empresa.
3. **Assistente IA** → escolha Gemini ou Claude, preencha *"Tudo o que a IA
   precisa saber"* e teste no chat ao lado até ficar bom.
4. **Conversões** → confira Meta e Google Ads (já vêm ligados; cadastre o
   Pixel ID e o rótulo do Google Ads se quiser mandar para contas específicas).
5. **Instalar no site** → cole o código uma vez no cabeçalho (`<head>`) ou no rodapé:

   ```html
   <script src="https://odingdong.tech/crm/chat.js" data-empresa="emp_xxxxxxxx" async></script>
   ```

   - **WordPress:** plugin "WPCode" → *Header & Footer* → Header ou Footer.
   - **Lovable:** peça no chat do Lovable "adicione este script em todas as
     páginas" e cole o código.
   - **Wix:** Configurações → Código personalizado → todas as páginas.
   - **HTML:** no `<head>` ou antes de `</body>`.
   - Opcional: `data-posicao="esquerda"` coloca o botão no canto esquerdo.

   Você pode mudar a IA, os textos e o modelo quando quiser pelo painel —
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
| `ADMIN_EMAIL` / `ADMIN_SENHA` | Primeiro administrador (criado só uma vez) |
| `COOKIE_SECURE` | `true` em produção (HTTPS); `false` só para testar em http |

## Estrutura

```
server.js              → Express montado em /crm
src/config.js          → lê o .env
src/db.js              → banco em JSON (data.json), gravação atômica
src/auth.js            → login, sessões, primeiro admin
src/ia.js              → monta o prompt do assistente e chama o Claude ou o Gemini
src/rotas-painel.js    → API do painel (empresas, assistentes, conversas, usuários)
src/rotas-publicas.js  → API do widget (config, chat, lead) com CORS e limites
public/                → painel (HTML/CSS/JS puro) e o widget chat.js
deploy/                → bloco do Nginx e config do pm2
```
