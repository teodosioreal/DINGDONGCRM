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
no botão do canto e em "Modo escuro" no menu). Pensado para o **próprio empresário configurar**: cada tela
explica em balões o que fazer, e os campos têm um "?" com a explicação.

Dentro de cada empresa:

- **Início** — os dois atendentes (**IA do site** e **IA do WhatsApp**), cada
  um com o seu botão liga/desliga: dá para usar os dois juntos ou só um. Mais
  os **primeiros passos** (com barra de progresso), os números da semana e o
  funil.
- **Leads** — quadro por etapa (arraste o cartão para mudar de etapa) ou lista
  com seleção em massa (mover etapa, colocar etiqueta, apagar, **disparar para
  os selecionados**). Filtro por etiqueta e busca. **Adicionar** um contato ou
  **importar vários** (colar "Nome, telefone" de uma planilha). Abrindo um
  lead: a conversa inteira (site + WhatsApp), etapa, etiquetas, anotações,
  pausar/devolver para a IA, responder pelo WhatsApp e "não enviar disparos".
- **Disparos em massa** — em 3 passos: quem recebe (etapas, etiquetas,
  origem, ou os leads selecionados na lista), a mensagem (com `{nome}`,
  variações `{Oi|Olá}` e mídia opcional, com prévia no estilo WhatsApp) e
  quando enviar (agora ou agendado). Acompanhamento ao vivo: enviados, erros,
  quem respondeu; pausar, continuar e cancelar.
- **Configurar**
  - **Sobre a empresa** — o que as duas IAs sabem (serviços, preços,
    dúvidas), o nome do atendente, o jeito de falar e (avançado) Claude ou
    Gemini e o modelo. Chat de teste como IA do site ou do WhatsApp.
  - **IA do site** — o código para colar no site (com o passo a passo de
    cada plataforma), instruções da IA do site, boas-vindas, aparência,
    número do WhatsApp e sites autorizados. Chat de teste.
  - **IA do WhatsApp** — **Gerar QR code**: o CRM cria a conexão na nossa
    Evolution API e o cliente só escaneia com o celular. Mostra foto, nome,
    número e se está online. Instruções da IA do WhatsApp e chat de teste.
  - **Mídias** — fotos, vídeos, PDFs e áudios (até 16 MB) que a IA do WhatsApp
    envia e que podem ir nos disparos.
  - **Etiquetas e etapas** — criar/renomear/colorir etiquetas; criar,
    renomear e reordenar as etapas do funil.
  - **Chave de IA** — a chave do Gemini e/ou do Claude da empresa, com o
    passo a passo para conseguir.

Para o administrador: **Visão geral**, **Empresas**, **Usuários** (admin ou
usuário de empresa, que só vê a própria empresa) e **Configurações do
sistema** (endereço da Evolution API e chave de IA padrão opcional).

### Conectar o WhatsApp (Evolution API)

Igual ao DingDong Tracking: **o CRM cria a conexão sozinho na nossa Evolution
API**.

1. A **chave global** da Evolution (`AUTHENTICATION_API_KEY` do servidor — a
   mesma `EVOLUTION_API_KEY` do tracker) vem sozinha: no deploy, se o `.env`
   do CRM não tiver, o script **lê** (sem alterar) o `.env` do DingDong
   Tracking (`/var/www/dingdong/.env`) e copia a chave e o endereço. Também
   dá para colar em **Configurações do sistema** ou direto na tela do
   WhatsApp (admin). O CRM confere a chave antes de salvar.
2. Na tela **IA do WhatsApp**, o cliente clica em **Gerar QR code**. O CRM
   cria a instância `crm-<nome-da-empresa>-<id>` (`POST /instance/create`), já
   com o webhook do CRM, e mostra o QR code — que se renova sozinho. Sem
   câmera? "Conectar com o número" gera o código de 8 letras.
3. A tela percebe sozinha quando o celular conecta e mostra foto, nome e
   número. Cada empresa guarda só o token da própria instância (a chave global
   fica só nas configurações do servidor).

Outras ações: **Trocar de número** (desconecta o aparelho e gera QR novo) e
**Remover conexão** (apaga a instância criada pelo CRM). O cliente nunca
precisa digitar Session ID nem API Key.

### Disparos em massa: cuidados contra bloqueio

- Só para quem já é lead da empresa (ou foi importado por ela).
- Uma mensagem por vez, com intervalo sorteado (15–35 s, 30–75 s ou
  1–2,5 min), "digitando…" antes de cada uma e variações de texto.
- Por padrão só em horário comercial (8h–20h, horário de Brasília).
- Rodapé "responda SAIR" (opcional): quem responde SAIR/PARAR não recebe mais
  disparos e ganha uma confirmação. Dá para marcar isso à mão no lead.
- Se a conexão cair, o disparo **pausa sozinho** sem perder a fila; se o app
  reiniciar, continua de onde parou.
- Quem responde cai no atendimento normal: a IA do WhatsApp continua a conversa.

### Máquina de vendas no WhatsApp

- **A IA ouve áudios e entende fotos.** Áudio do cliente é transcrito pelo
  Gemini (basta a empresa ter a chave do Gemini — o Claude não recebe áudio) e
  a IA responde ao que foi falado; foto é descrita pela IA da empresa (Claude
  ou Gemini). O áudio/foto original fica na conversa, com a transcrição.
- **A IA já vem com técnica de venda:** entende a necessidade, mostra o
  benefício, contorna objeção, propõe o próximo passo e fecha — sem inventar
  preço, desconto ou prazo. Em *Sobre a empresa* ficam o **objetivo** (ex.:
  agendar) e a **oferta/diferenciais**.
- **Mídias e links:** fotos/vídeos/PDFs do computador, **pastas do Google
  Drive** (pasta pública vira um álbum que a IA manda de uma vez; sincroniza
  sozinha a cada 6 h ou no botão) e **links** (catálogo, mapa, agenda…) que a
  IA manda quando fizer sentido.
- **Conversas** (estilo WhatsApp Web): lista com não lidas e "esperando você",
  chat com fotos, áudios (player + transcrição) e PDFs; mandar texto, arquivo
  do computador, mídia/álbum da biblioteca; **respostas prontas** (digite
  `/atalho`); **✨ Sugerir com IA** (a IA escreve, você revisa); **agendar
  mensagem**; ligar/desligar a IA e mudar a etapa sem sair do chat.
- **Automações** (Máquina de vendas), com receitas prontas de um clique:
  recuperar quem parou de responder (a IA retoma, até 2x), **pedir avaliação
  no Google** 2 dias depois de fechar (link do Google Meu Negócio), reativar
  quem desistiu, pós-venda e chamar para comprar de novo. Dá para criar a sua:
  "cliente não responde há X horas" ou "X dias depois de entrar na etapa Y",
  filtros por etapa/etiqueta, mensagem pronta (com `{nome}`, `{empresa}`,
  `{link_avaliacao}`) ou escrita pela IA. Ninguém recebe duas vezes, quem
  pediu SAIR fica de fora, só age até 3 dias depois do critério (ligar uma
  automação não dispara para leads antigos) e, por padrão, só das 8h às 20h.

### Respostas rápidas com mídia (também no celular)

- Atalhos como `/preco` e `/catalogo` que mandam **texto + foto, PDF ou álbum**
  cadastrado. Na aba Conversas: digite `/` e escolha (a mídia vai junto).
- **No WhatsApp do celular:** a equipe digita só `/preco` na conversa do
  cliente; o CRM apaga esse `/preco` e manda no lugar o texto e a mídia.
  Pode ser desligado.

### Aprendizados da IA (varredura das conversas)

- Todo dia às **8h** (horário de Brasília) ou no botão **Varrer agora**, a
  IA lê as conversas do WhatsApp (histórico da Evolution API) e mantém um
  **arquivo de aprendizados**: jeito de falar do dono/equipe, perguntas,
  preços e condições passados, objeções e respostas, como fecha, perguntas
  frequentes e o que evitar — sem dados pessoais dos clientes.
- Lê o histórico **uma vez** e depois **só mensagens novas** (guarda até onde
  leu em cada conversa). Conversa com **venda concluída** (lead em "Fechado"
  ou venda confirmada) é lida uma última vez e depois não é mais lida.
  Grupos ficam de fora. Primeira leitura muito grande continua na próxima.
- As IAs do site e do WhatsApp usam o arquivo para atender cada vez mais
  parecido com a empresa. Dá para ler, corrigir, baixar (.txt), desligar ou
  recomeçar do zero.

### Faturamento (vendas pelos comprovantes do Pix)

- Quando o cliente manda o **comprovante do Pix** (print ou PDF) no WhatsApp,
  o CRM lê valor, data, quem pagou, quem recebeu e o ID da transação e
  registra a venda no **Faturamento** da empresa. O lead vai para "Fechado",
  ganha a etiqueta "Cliente" e a IA agradece.
- **Lê sem IA** (não gasta crédito): PDF pelo texto do arquivo e foto por
  reconhecimento de texto (OCR) rodando no próprio servidor (tesseract.js com
  português embutido, sem internet). Só se não der para ler a IA tenta — e
  isso pode ser desligado.
- **Anti-fraude:** cadastre quem recebe (nome, CNPJ/CPF, chave Pix).
  Comprovante para outra pessoa, com data antiga ou lido pela IA fica
  "A conferir"; comprovante repetido não conta duas vezes.
- Painel com hoje / 7 dias / mês (vs. mês anterior) / ticket médio, gráfico de
  30 dias, lista com confirmar/cancelar/editar, "Ler comprovante" pelo
  computador e "Lançar venda" à mão (dinheiro, cartão…).

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
  `[[ETAPA: Qualificado]]` (move o lead), `[[ETIQUETA: Quente]]` (coloca a
  etiqueta), `[[MIDIA: Tabela de preços]]` (envia a mídia com esse nome) e
  `[[HUMANO]]` (avisa a equipe e para de responder).
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

1. **Empresas** → nova empresa. Crie um **usuário de empresa** para o dono
   (Usuários) — ele entra direto na empresa dele.
2. No **Início** da empresa, siga os **primeiros passos**: chave de IA → sobre
   a empresa → colar o código no site → conectar o WhatsApp (Session ID + API
   Key) → mídias (opcional).
3. Ligue ou desligue a **IA do site** e a **IA do WhatsApp** no Início (ou no
   topo da página de cada uma).

O código do site (colado uma vez no `<head>` ou no rodapé) não muda nunca:

```html
<script src="https://odingdong.tech/crm/chat.js" data-empresa="emp_xxxxxxxx" async></script>
```

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
| `EVOLUTION_API_KEY` | Chave global da Evolution: o CRM cria as conexões sozinho (também dá para colar no painel) |
| `EVOLUTION_API_URL` | Endereço da Evolution API onde ficam as instâncias (padrão `https://api.evolutiondingdong.online`; também dá para trocar no painel) |
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
src/leads.js           → leads, etapas, etiquetas e o código que liga site ↔ WhatsApp
src/whatsapp.js        → Evolution API: conectar (Session ID + API Key), webhook, IA respondendo, mídias
src/disparos.js        → disparos em massa (fila, intervalos, horário comercial, SAIR)
src/automacoes.js      → máquina de vendas (receitas, critérios, envio) e mensagens agendadas
src/comprovantes.js    → leitura de comprovantes (PDF/OCR sem IA, IA como plano B) e faturamento
src/aprendizado.js     → varredura diária das conversas e arquivo de aprendizados da IA
src/midias.js          → mídias, links, álbuns do Google Drive e anexos das conversas
src/rotas-painel.js    → API do painel (empresas, assistentes, leads, WhatsApp, mídias, usuários)
src/rotas-publicas.js  → API do widget (config, chat) e webhook do WhatsApp
public/                → painel (HTML/CSS/JS puro) e o widget chat.js
deploy/                → instalador, atualizador, bloco do Nginx e config do pm2
.github/workflows/     → deploy automático na VPS a cada push na main
```
