const path = require('path');
const express = require('express');
const config = require('./src/config');
// blindagem: se o banco sumiu, volta o backup mais novo ANTES de o app ler
require('./src/backup').restaurarSeSumiu();
const { garantirAdmin } = require('./src/auth');
const { salvarAgora } = require('./src/db');
const rotasPublicas = require('./src/rotas-publicas');
const rotasPainel = require('./src/rotas-painel');
const { migrarLeads } = require('./src/leads');
const midias = require('./src/midias');
const { tipoDeArquivoSeguro } = require('./src/util');
const disparos = require('./src/disparos');
const automacoes = require('./src/automacoes');

garantirAdmin();
migrarLeads();
require('./src/comprovantes').arrumarVendidosAgendados(); // venda recente + ainda "agendado" → lugar certo
require('./src/detector-agenda').revisarRecentes(); // agendamentos combinados enquanto o CRM estava fora

const app = express();
app.disable('x-powered-by');
// Atrás do Nginx: usa o IP real do visitante (X-Forwarded-For) e o protocolo https
app.set('trust proxy', 'loopback');

// Cabeçalhos de segurança em tudo (o widget do site é um <script>, não usa iframe)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // ninguém coloca o painel dentro de outro site (clickjacking)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // só HTTPS por 180 dias
  next();
});

const base = express.Router();
const pastaPublica = path.join(__dirname, 'public');

// webhook do WhatsApp: o histórico que chega ao reconectar pode ser grande
base.use('/api/public/whatsapp', express.json({ limit: '25mb' }));
base.use(express.json({ limit: '200kb' }));

// Widget que os sites incluem: <script src=".../crm/chat.js" data-bot="...">
base.get('/chat.js', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(pastaPublica, 'chat.js'));
});

// Miniatura de um vídeo da biblioteca (o painel mostra; feita uma vez pelo ffmpeg)
base.get('/capa/:id', async (req, res) => {
  const midia = midias.acharPorId(req.params.id);
  if (!midia || midia.tipo !== 'video') return res.sendStatus(404);
  const arq = await require('./src/video').capa(midia).catch(() => null);
  if (!arq) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('jpg').sendFile(arq, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Mídias da empresa num endereço público (o WhatsApp baixa daqui para enviar)
base.get('/midia/:id/:arquivo', (req, res) => {
  const midia = midias.acharPorId(req.params.id);
  if (!midia) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  tipoDeArquivoSeguro(res, midia.mimetype, midia.arquivo);
  res.sendFile(midias.caminhoDoArquivo(midia), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Anexo da conversa por link temporário (só o WhatsApp usa, para baixar o arquivo original)
base.get('/anexo/:token/:nome', (req, res) => {
  const a = midias.arquivoDoLink(req.params.token);
  if (!a) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'private, no-store');
  tipoDeArquivoSeguro(res, a.mimetype, req.params.nome);
  res.sendFile(a.caminho, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Logo da empresa (aparece no painel e, se o assistente não tiver foto, no chat do site)
base.get('/logo/:empresaId', (req, res) => {
  const { estado } = require('./src/db');
  const empresa = estado.empresas.find((e) => e.id === req.params.empresaId);
  if (!empresa?.logo) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  tipoDeArquivoSeguro(res, empresa.logo.mimetype, empresa.logo.arquivo);
  res.sendFile(path.join(config.midiasDir, 'logos', empresa.logo.arquivo), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

base.use('/api/public', rotasPublicas);
base.use('/api', rotasPainel);

base.get('/', (req, res) => res.sendFile(path.join(pastaPublica, 'index.html')));
base.get('/login', (req, res) => res.sendFile(path.join(pastaPublica, 'login.html')));
// Termos de Uso e Política de Privacidade (o responsável e o contato vêm do .env)
const paginaLegal = (arquivo, titulo) => (req, res) => {
  const fs = require('fs');
  const pasta = path.join(pastaPublica, 'legal');
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const emailContato = config.emailContato || (config.emailRemetente.match(/<([^>]+)>/)?.[1] ?? config.emailRemetente);
  const contato = emailContato ? `<a href="mailto:${esc(emailContato)}">${esc(emailContato)}</a>` : 'pelo e-mail de suporte informado no painel';
  const mudou = fs.statSync(path.join(pasta, arquivo)).mtime;
  const conteudo = fs.readFileSync(path.join(pasta, arquivo), 'utf8').replaceAll('{{RESPONSAVEL}}', esc(config.responsavelLegal || 'DingDong')).replaceAll('{{CONTATO}}', contato);
  const html = fs.readFileSync(path.join(pasta, '_moldura.html'), 'utf8').replace('{{TITULO}}', titulo).replace('{{DATA}}', mudou.toLocaleDateString('pt-BR')).replace('{{CONTEUDO}}', () => conteudo);
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.type('html').send(html);
};
base.get('/termos', paginaLegal('termos.html', 'Termos de Uso'));
base.get('/privacidade', paginaLegal('privacidade.html', 'Política de Privacidade'));
base.use('/legal', (req, res) => res.sendStatus(404)); // os modelos só saem por /termos e /privacidade
base.use(express.static(pastaPublica, { index: false }));

base.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

if (config.basePath) {
  // /crm -> /crm/ (o Express 5 trata as duas iguais nas rotas, então confere o caminho exato)
  app.use((req, res, next) => {
    if (req.path === config.basePath) {
      const query = req.originalUrl.slice(req.path.length);
      return res.redirect(301, `${config.basePath}/${query}`);
    }
    next();
  });
  app.use(config.basePath, base);
} else {
  app.use(base);
}

app.use((err, req, res, next) => {
  console.error(err);
  if (!err.status || err.status >= 500) require('./src/alertas').registrar(null, 'sistema', `Erro interno em ${req.method} ${req.path}: ${err.message}`);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ erro: status === 500 ? 'Erro interno.' : err.message });
});

const servidor = app.listen(config.port, config.host, () => {
  console.log(`CRM rodando em http://${config.host}:${config.port}${config.basePath}/`);
  disparos.retomarAoIniciar();
  automacoes.iniciar();
  require('./src/alertas').iniciar();
  require('./src/backup').iniciar();
  require('./src/fotos-clientes').iniciar();
  require('./src/lixeira').iniciar();
  require('./src/sincronizar').iniciar();
  require('./src/varredura-vendas').iniciar(); // de hora em hora: vendas pela frase da equipe e comprovantes que ficaram para trás (sem gastar IA)
  require('./src/gastos').iniciar(); // grupo de gastos do WhatsApp: busca o que não chegou pelo webhook
  require('./src/ia-desligada').iniciar();
  require('./src/whatsapp').iniciarConferenciaEntregas(); // tiques de entrega: confere na Evolution o que ficou "aguardando" // quem já comprou (e quem agendou, por padrão): IA desligada até ligar à mão
  require('./src/eventos-ia').iniciar(); // avisos internos para a IA: [SEM_RESPOSTA], [CHECAR_VIDEO], [FOLLOWUP_1] (tempos por empresa)
  require('./src/expediente').iniciar(); // horário da IA responder e fila de quem esperou a IA (fora do horário / sem crédito)
  require('./src/meta-ads').iniciar(); // vendas de quem veio de anúncio do Facebook/Instagram → Meta Ads (API de Conversões)
  // uma vez (pedido do dono): imagens "a configurar" da Madara Volantes sem texto de quando enviar
  // ganham o texto-modelo — ele só troca o nome do carro e o revestimento. Continuam "a configurar".
  try {
    const { estado: est, salvar: gravar } = require('./src/db');
    est.config = est.config || {};
    if (!est.config.modeloMidiasMadara1) {
      const MODELO = 'Quando o carro do cliente for o INSIRA AQUI. Seguir o script do prompt principal, mas enviar essa imagem na conversa num momento propício. O revestimento da foto é um INSIRA AQUI.';
      let n = 0;
      for (const e of est.empresas.filter((x) => /madara/i.test(x.nome || ''))) {
        for (const m of require('./src/midias').midiasDa(e)) {
          if (m.tipo === 'image' && m.pronta === false && !String(m.descricao || '').trim()) {
            m.descricao = MODELO;
            n++;
          }
        }
      }
      est.config.modeloMidiasMadara1 = new Date().toISOString();
      gravar();
      console.log(`[midias] texto-modelo colocado em ${n} imagem(ns) "a configurar" da Madara`);
    }
  } catch (err) {
    console.error('[midias] texto-modelo:', err.message);
  }
  // mesmo cliente em duas conversas (número com/sem 9, id escondido): junta ao ligar e a cada 20 min
  const revisarDuplicadas = () => {
    for (const e of require('./src/db').estado.empresas) {
      try {
        const n = require('./src/identidade').repararDuplicadas(e);
        if (n) console.log(`[identidade ${e.id}] ${n} conversa(s) duplicada(s) juntada(s)`);
      } catch (err) {
        console.error('[identidade]', err.message);
      }
    }
  };
  setTimeout(revisarDuplicadas, 5000).unref?.();
  setInterval(revisarDuplicadas, 20 * 60 * 1000).unref?.();
  try {
    // localização: tira a antiga pelo DDD e lê das conversas
    require('./src/localizacao').revisarTodas(require('./src/db').estado);
  } catch (err) {
    console.error('[localizacao]', err.message);
  }
  // configurações que o dono pediu para deixar prontas (cada uma roda uma vez só)
  try {
    require('./src/pedidos-config').aplicar();
  } catch (err) {
    console.error('[pedidos-config]', err.message);
  }
  // vídeos que ficaram no meio da conversão (ou ainda não conferidos) voltam para a fila
  setTimeout(() => {
    try {
      require('./src/video').revisarPendentes();
    } catch (err) {
      console.error('[video]', err.message);
    }
  }, 8000).unref?.();
  // webhooks antigos: passam a avisar também quando uma conversa é apagada no celular
  // (e, nas instâncias já em uso que ainda não tinham, liga o histórico
  // completo -- mensagens, contatos e etiquetas do WhatsApp Business -- e dá
  // uma cutucada no socket pra resincronizar mais rápido, sem apagar sessão
  // nem pedir QR de novo)
  setTimeout(async () => {
    const { estado } = require('./src/db');
    const whatsapp = require('./src/whatsapp');
    for (const e of estado.empresas) {
      if (!whatsapp.configurado(e)) continue;
      await whatsapp.revisarWebhook(e).then((mudou) => mudou && console.log(`[webhook ${e.id}] eventos atualizados`)).catch((err) => console.error(`[webhook ${e.id}]`, err.message));
      await whatsapp.garantirSemLeituraAutomatica(e); // mensagem só fica lida quando alguém abre a conversa
      // a IA ia responder alguém quando o CRM reiniciou (deploy): responde agora
      try { require('./src/sincronizar').retomarRespostasPendentes(e); } catch (err) { console.error(`[whatsapp ${e.id}] retomar respostas:`, err.message); }
      // pedido do dono (09/10): a IA PARA quando a equipe manda mensagem manual. Corrige uma vez a
      // opção "IA continua depois da mensagem manual" que estava ligada; depois vale o que ele escolher na tela
      if (e.whatsappConfig.iaAposManual === true && !e.whatsappConfig.iaAposManualRevisadoEm) {
        e.whatsappConfig.iaAposManual = false;
        e.whatsappConfig.iaAposManualRevisadoEm = new Date().toISOString();
        require('./src/db').salvar();
        console.log(`[whatsapp ${e.id}] "IA continua depois da mensagem manual" estava ligada: desliguei (a IA para quando a equipe responde)`);
      }
      const ligouAgora = await whatsapp.garantirSyncFullHistory(e).catch(() => false);
      // reinicia o socket NO MÁXIMO UMA VEZ por número: se a Evolution não guardar a
      // opção, reiniciar a cada deploy derrubava o WhatsApp à toa
      if (ligouAgora && !e.whatsappConfig.socketReiniciadoEm) {
        e.whatsappConfig.socketReiniciadoEm = new Date().toISOString();
        require('./src/db').salvar();
        console.log(`[whatsapp ${e.id}] syncFullHistory ligado (instância já em uso) -- reiniciando o socket uma vez pra resincronizar`);
        await whatsapp.reiniciarSocket(e);
      }
    }
    whatsapp.recuperarAnexosRecentes(); // comprovantes de mensagens que chegaram durante uma queda
  }, 15000).unref();
  // (pastas do Google Drive: não sincroniza mais — enviar pelo Drive saiu do CRM; as fotos que já vieram ficam)
  if (!require('./src/ia').provedoresConfigurados().length) {
    console.log('Aviso: nenhuma chave de IA configurada — cadastre a do Claude ou do Gemini em Configurações.');
  }
});

function desligar() {
  salvarAgora();
  servidor.close(() => process.exit(0));
}
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);

// erro não tratado: registra no painel em vez de derrubar o app em silêncio
process.on('unhandledRejection', (motivo) => {
  console.error('[sistema] promessa sem tratamento:', motivo);
  require('./src/alertas').registrar(null, 'sistema', `Erro não tratado: ${motivo?.message || motivo}`);
});
