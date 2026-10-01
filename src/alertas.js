// alertas.js — o CRM vigia a si mesmo e avisa quando algo dá errado.
//
// Cada problema (IA sem crédito, WhatsApp desconectado, mídia que não saiu,
// automação com erro…) vira um alerta no painel (sininho). Se a empresa
// cadastrar um "WhatsApp para avisos", os erros também chegam lá, no máximo
// um por tipo a cada 30 minutos, para não virar spam.

const { estado, salvar, novoId, agora } = require('./db');

const MAX_ALERTAS = 400;
const JUNTAR_MS = 15 * 60 * 1000; // o mesmo problema em 15 min vira um alerta só (com contador)
const ZAP_A_CADA_MS = 30 * 60 * 1000;
const enviadosZap = new Map(); // empresaId|tipo → quando

// Dica sem IA para cada tipo de problema (o que fazer para resolver)
const DICAS = {
  'ia-erro': 'Abra IA do WhatsApp → "Verificar agora". Se for crédito ou chave, confira em Chaves de IA e cadastre uma IA reserva.',
  'ia-reserva': 'A IA principal falhou e a reserva respondeu. Confira a chave/crédito da principal em Chaves de IA.',
  'whatsapp-envio': 'O WhatsApp não enviou. Veja se o celular está conectado em IA do WhatsApp.',
  'whatsapp-desconectado': 'O celular da empresa saiu do CRM. Em IA do WhatsApp, gere o QR code e conecte de novo.',
  'midia': 'Uma mídia não foi enviada. Confira em Mídias se o arquivo ainda existe e se o código está certo.',
  automacao: 'Uma automação deu erro. Veja em Máquina de vendas se o link (avaliação/anúncio) está salvo.',
  site: 'O CRM não conseguiu ler o site. Confira o link em Aprendizados → Seu site ou cole a copy.',
  aprendizado: 'A varredura das conversas falhou. Tente "Varrer agora" de novo mais tarde.',
  comprovante: 'Um comprovante não pôde ser lido. Registre a venda à mão em Faturamento se precisar.',
  sistema: 'Erro interno do CRM. Se repetir, avise o suporte com o horário.',
  humano: 'O cliente pediu para falar com uma pessoa. Responda em Conversas (a IA ficou pausada nele).',
  backup: 'O backup automático falhou. Confira o espaço em disco da VPS.'
};

function registrar(empresa, tipo, mensagem, { nivel = 'erro', leadId = null } = {}) {
  try {
    estado.alertas = Array.isArray(estado.alertas) ? estado.alertas : [];
    const empresaId = empresa?.id || null;
    const texto = String(mensagem || '').slice(0, 500);
    const recente = estado.alertas.find((a) => a.empresaId === empresaId && a.tipo === tipo && !a.resolvido && Date.now() - new Date(a.ultimoEm).getTime() < JUNTAR_MS);
    if (recente) {
      recente.vezes += 1;
      recente.ultimoEm = agora();
      recente.mensagem = texto;
      recente.lido = false;
    } else {
      estado.alertas.unshift({ id: novoId('alr'), empresaId, tipo, nivel, mensagem: texto, dica: DICAS[tipo] || '', leadId, vezes: 1, criadoEm: agora(), ultimoEm: agora(), lido: false, resolvido: false });
      if (estado.alertas.length > MAX_ALERTAS) estado.alertas.length = MAX_ALERTAS;
    }
    salvar();
    if (nivel === 'erro' && empresa) avisarNoWhatsapp(empresa, tipo, texto);
  } catch (err) {
    console.error('[alertas] não consegui registrar:', err.message);
  }
}

function avisarNoWhatsapp(empresa, tipo, texto) {
  const numero = String(empresa.whatsappAvisos || '').replace(/\D/g, '');
  if (numero.length < 10) return;
  const chave = `${empresa.id}|${tipo}`;
  if (Date.now() - (enviadosZap.get(chave) || 0) < ZAP_A_CADA_MS) return;
  enviadosZap.set(chave, Date.now());
  const whatsapp = require('./whatsapp');
  if (!whatsapp.configurado(empresa)) return;
  const msg = `⚠️ *Aviso do DingDong CRM — ${empresa.nome}*\n\n${texto}\n\n💡 ${DICAS[tipo] || 'Abra o painel para ver os detalhes.'}`;
  whatsapp.enviarTexto(empresa, `${numero}@s.whatsapp.net`, msg, { digitando: false }).catch((err) => console.error('[alertas] aviso no WhatsApp falhou:', err.message));
}

function listar(empresaIds, { todos = false } = {}) {
  const lista = (estado.alertas || []).filter((a) => (a.empresaId ? empresaIds.has(a.empresaId) : todos));
  return lista.slice(0, 100);
}

function naoLidos(empresaIds, { todos = false } = {}) {
  return (estado.alertas || []).filter((a) => !a.lido && !a.resolvido && (a.empresaId ? empresaIds.has(a.empresaId) : todos)).length;
}

function marcarLidos(empresaIds, { todos = false } = {}) {
  for (const a of estado.alertas || []) if (a.empresaId ? empresaIds.has(a.empresaId) : todos) a.lido = true;
  salvar();
}

function resolver(id) {
  const a = (estado.alertas || []).find((x) => x.id === id);
  if (a) {
    a.resolvido = true;
    a.lido = true;
    salvar();
  }
  return a;
}

// ---------------------------------------------------------------- vigia periódico

let timer = null;
async function vigiar() {
  const whatsapp = require('./whatsapp');
  for (const empresa of estado.empresas) {
    if (empresa.ativa === false || !whatsapp.configurado(empresa)) continue;
    try {
      const s = await whatsapp.situacao(empresa);
      const conectado = s?.estado === 'open' || s?.conectado === true;
      if (!conectado) registrar(empresa, 'whatsapp-desconectado', `O WhatsApp da empresa está desconectado (${s?.estado || 'sem resposta'}). A IA não recebe nem responde mensagens.`);
    } catch (err) {
      registrar(empresa, 'whatsapp-desconectado', `Não consegui falar com o servidor do WhatsApp: ${err.message}`, { nivel: 'aviso' });
    }
  }
}

function iniciar() {
  if (timer || process.env.ALERTAS_VIGIA === 'nao') return;
  timer = setInterval(() => vigiar().catch((err) => console.error('[alertas] vigia:', err.message)), Number(process.env.ALERTAS_VIGIA_MS) || 15 * 60 * 1000);
  timer.unref?.();
}

module.exports = { registrar, listar, naoLidos, marcarLidos, resolver, iniciar, vigiar, DICAS };
