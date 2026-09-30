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
const disparos = require('./src/disparos');
const automacoes = require('./src/automacoes');

garantirAdmin();
migrarLeads();

const app = express();
app.disable('x-powered-by');
// Atrás do Nginx: usa o IP real do visitante (X-Forwarded-For) e o protocolo https
app.set('trust proxy', 'loopback');

const base = express.Router();
const pastaPublica = path.join(__dirname, 'public');

base.use(express.json({ limit: '200kb' }));

// Widget que os sites incluem: <script src=".../crm/chat.js" data-bot="...">
base.get('/chat.js', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(pastaPublica, 'chat.js'));
});

// Mídias da empresa num endereço público (o WhatsApp baixa daqui para enviar)
base.get('/midia/:id/:arquivo', (req, res) => {
  const midia = midias.acharPorId(req.params.id);
  if (!midia) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type(midia.mimetype);
  res.sendFile(midias.caminhoDoArquivo(midia), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Logo da empresa (aparece no painel e, se o assistente não tiver foto, no chat do site)
base.get('/logo/:empresaId', (req, res) => {
  const { estado } = require('./src/db');
  const empresa = estado.empresas.find((e) => e.id === req.params.empresaId);
  if (!empresa?.logo) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type(empresa.logo.mimetype);
  res.sendFile(path.join(config.midiasDir, 'logos', empresa.logo.arquivo), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

base.use('/api/public', rotasPublicas);
base.use('/api', rotasPainel);

base.get('/', (req, res) => res.sendFile(path.join(pastaPublica, 'index.html')));
base.get('/login', (req, res) => res.sendFile(path.join(pastaPublica, 'login.html')));
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
  // vídeos que ficaram no meio da conversão (ou ainda não conferidos) voltam para a fila
  setTimeout(() => {
    try {
      require('./src/video').revisarPendentes();
    } catch (err) {
      console.error('[video]', err.message);
    }
  }, 8000).unref?.();
  // webhooks antigos: passam a avisar também quando uma conversa é apagada no celular
  setTimeout(async () => {
    const { estado } = require('./src/db');
    const whatsapp = require('./src/whatsapp');
    for (const e of estado.empresas) {
      if (!whatsapp.configurado(e)) continue;
      await whatsapp.revisarWebhook(e).then((mudou) => mudou && console.log(`[webhook ${e.id}] eventos atualizados`)).catch((err) => console.error(`[webhook ${e.id}]`, err.message));
    }
  }, 15000).unref();
  // pastas do Google Drive: sincroniza sozinho a cada 6 horas
  setInterval(async () => {
    const { estado } = require('./src/db');
    const ia = require('./src/ia');
    for (const e of estado.empresas) {
      for (const pasta of midias.pastasDa(e)) {
        await midias.sincronizarPasta(e, { pastaExistente: pasta, chaveGoogle: ia.chave('gemini', e) }).catch((err) => console.error(`[drive ${e.id}]`, err.message));
      }
    }
  }, 6 * 60 * 60 * 1000).unref();
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
