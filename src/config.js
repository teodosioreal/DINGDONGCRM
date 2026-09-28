require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

// Caminho onde o painel fica publicado (ex.: https://odingdong.tech/crm).
// Sem barra no final. Deixe vazio ("") se o app for servido na raiz de um domínio.
function normalizarBase(valor) {
  const v = (valor ?? '/crm').trim();
  if (!v || v === '/') return '';
  return '/' + v.replace(/^\/+|\/+$/g, '');
}

module.exports = {
  port: Number(process.env.PORT) || 3100,
  // 127.0.0.1 = só o Nginx da própria VPS acessa (recomendado)
  host: process.env.HOST || '127.0.0.1',
  basePath: normalizarBase(process.env.BASE_PATH),
  // Endereço público completo, usado para montar o código de incorporação.
  // Ex.: https://odingdong.tech/crm
  urlPublica: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Chaves das IAs. Também dá para cadastrar pelo painel (Configurações), que tem prioridade.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // WhatsApp (Evolution API): endereço padrão sugerido nas empresas novas
  evolutionUrlPadrao: (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, ''),
  // espera o cliente parar de digitar antes de a IA responder no WhatsApp
  whatsappEsperaMs: Number(process.env.WHATSAPP_ESPERA_MS) || 6000,
  // arquivos de mídia enviados pela IA (fotos, vídeos, PDFs, áudios)
  midiasDir: process.env.MIDIAS_DIR || require('path').join(__dirname, '..', 'midias'),
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminSenha: process.env.ADMIN_SENHA || '',
  // true quando o site é acessado por HTTPS (produção atrás do Nginx)
  cookieSeguro: process.env.COOKIE_SECURE !== 'false',
  diasSessao: 7
};
