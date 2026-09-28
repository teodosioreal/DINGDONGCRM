# DingDong CRM — assistentes de IA para sites (chat estilo WhatsApp)

Painel em `https://odingdong.tech/crm` onde você cadastra empresas, configura
a IA de cada uma (**Claude** ou **Gemini**) e pega **um código por empresa**
para colar uma vez no cabeçalho ou rodapé de qualquer site (Lovable,
WordPress, Wix, HTML…). No site aparece um botão verde
de WhatsApp; ao clicar, abre uma janela de conversa estilo WhatsApp onde a IA
tira as dúvidas do visitante e, quando ele quer fechar, passa para o WhatsApp
de verdade da empresa com a mensagem já escrita.

É um app separado: roda numa porta própria da VPS e o Nginx só encaminha o
caminho `/crm`. O resto do domínio `odingdong.tech` não é tocado.

## O que tem

- **Login** com e-mail e senha (sessão por cookie, senha com hash scrypt).
- **Configurações**: chave do Claude e/ou do Gemini, com botão de testar. Fica
  só no servidor (nunca vai para o site do cliente).
- **Empresas**: nome, nicho, WhatsApp, sites. Ao criar, o **assistente
  principal** já nasce junto e o painel mostra o **código da empresa**.
- **Assistentes** (um principal + outros opcionais por empresa): IA que
  responde (Claude ou Gemini) e modelo — a lista de modelos do Gemini vem da
  própria chave do Google —, nome e foto no chat, cor, boas-vindas,
  balão de chamada, tom de voz, **base de conhecimento** (serviços, preços,
  dúvidas comuns), regras extras, número de WhatsApp, sites autorizados,
  modelo de IA e limites de uso. Tem um **chat de teste** ao lado do formulário.
- **Conversas**: histórico de tudo o que os visitantes perguntaram e quem
  clicou em "Continuar no WhatsApp" (lead).
- **Usuários**: administrador (vê tudo) ou usuário de empresa (vê e edita só
  os assistentes e conversas da própria empresa).
- **Widget** (`chat.js`): não depende de framework, fica isolado do visual do
  site (Shadow DOM), funciona no celular em tela cheia, lembra a conversa por
  24h e dispara o evento `Lead` do Meta Pixel se o site tiver o pixel.

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

1. **Configurações** → cole a chave do Claude e/ou do Gemini (uma vez só).
2. **Empresas** → nova empresa (nome, nicho, WhatsApp com DDD e o site).
   O painel já mostra o código da empresa.
3. **Configurar IA** → escolha Claude ou Gemini, preencha *"Tudo o que o
   assistente precisa saber"* e teste no chat ao lado até ficar bom.
4. Cole o **código da empresa** uma vez no cabeçalho (`<head>`) ou no rodapé:

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
cobrada por uso na sua conta da Anthropic ou do Google.

- **Claude:** padrão **Opus 5** com esforço baixo (respostas rápidas); dá para
  trocar para **Sonnet 5** ou **Haiku 4.5**, que custam menos.
- **Gemini:** o painel lista os modelos que a sua chave pode usar
  (ex.: `gemini-2.5-flash`, bom custo-benefício para atendimento). O "limite de mensagens por dia" de cada
assistente é o teto de gasto: ao chegar nele, o chat passa o visitante direto
para o WhatsApp.

## Variáveis do `.env`

| Variável | Para que serve |
|---|---|
| `PORT` / `HOST` | Porta interna (padrão 3100, só em 127.0.0.1) |
| `BASE_PATH` | Caminho no domínio (padrão `/crm`) |
| `PUBLIC_URL` | Endereço público, usado no código de incorporação |
| `ANTHROPIC_API_KEY` | Chave do Claude (opcional — também dá pelo painel) |
| `GEMINI_API_KEY` | Chave do Gemini (opcional — também dá pelo painel) |
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
