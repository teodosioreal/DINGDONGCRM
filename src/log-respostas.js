// log-respostas.js — um registro por resposta da IA no WhatsApp: o texto bruto
// que a IA escreveu, os códigos detectados, as mídias (enviada / já enviada /
// não existe / erro), o retorno da Evolution API e os erros. O painel mostra os
// últimos e destaca os que deram problema. Guarda só os mais recentes por empresa.

const { estado, salvar, novoId, agora } = require('./db');

const MAX_POR_EMPRESA = Number(process.env.LOG_RESPOSTAS_MAX) || 200;
const corta = (t, n) => (t == null ? t : String(t).slice(0, n));

function registrar(empresa, lead, dados = {}) {
  estado.logRespostas = estado.logRespostas || [];
  const midias = (dados.midias || []).map((m) => ({ ...m, motivo: corta(m.motivo, 300) }));
  const erros = [...(dados.erros || [])];
  for (const m of midias) {
    if (m.status === 'nao-existe') erros.push(`Código ${m.codigo} não existe no cadastro desta empresa.`);
    if (m.status === 'erro') erros.push(`A mídia ${m.codigo} falhou ao enviar: ${m.motivo}`);
    if (m.status === 'inativa') erros.push(`A mídia ${m.codigo} está desativada.`);
  }
  const entrada = {
    id: novoId('log'),
    empresaId: empresa.id,
    leadId: lead?.id || null,
    cliente: lead?.nome || (lead?.telefone ? `+${lead.telefone}` : ''),
    em: agora(),
    origem: dados.origem || 'resposta', // resposta | evento:SEM_RESPOSTA | teste…
    situacao: dados.situacao || 'enviada', // enviada | descartada | pausada | erro | nada
    bruto: corta(dados.bruto, 4000),
    textoEnviado: corta(dados.textoEnviado, 2000),
    codigos: (dados.codigos || []).slice(0, 30),
    midias,
    evolutionTexto: dados.evolutionTexto || null,
    pausou: Boolean(dados.pausou),
    avisos: (dados.avisos || []).map((a) => corta(a, 300)),
    erros: erros.map((e) => corta(e, 400))
  };
  estado.logRespostas.push(entrada);
  // só os últimos N por empresa
  const daEmpresa = estado.logRespostas.filter((l) => l.empresaId === empresa.id);
  if (daEmpresa.length > MAX_POR_EMPRESA) {
    const fora = new Set(daEmpresa.slice(0, daEmpresa.length - MAX_POR_EMPRESA).map((l) => l.id));
    estado.logRespostas = estado.logRespostas.filter((l) => !fora.has(l.id));
  }
  salvar();
  if (entrada.erros.length) console.error(`[log-ia ${empresa.id} ${lead?.id || ''}] ${entrada.erros.join(' | ')}`);
  return entrada;
}

function listar(empresa, { soErros = false, leadId = '', limite = 50 } = {}) {
  return (estado.logRespostas || [])
    .filter((l) => l.empresaId === empresa.id && (!soErros || l.erros.length || l.avisos.length) && (!leadId || l.leadId === leadId))
    .slice(-Math.min(200, Math.max(1, limite)))
    .reverse();
}

function apagarDaEmpresa(empresaId) {
  estado.logRespostas = (estado.logRespostas || []).filter((l) => l.empresaId !== empresaId);
}

// A IA disse que ia mandar foto/vídeo/áudio mas não escreveu nenhum código?
const PROMETEU_MIDIA = /\b(vou|vou te|te|já te|ja te|segue|seguem|olha|olhe|veja|confira|mando|mandarei|enviarei|enviando|mandando|vou enviar|vou mandar)\b[^.!?\n]{0,40}\b(foto|fotos|v[ií]deo|v[ií]deos|[áa]udio|[áa]udios|imagem|imagens|cat[áa]logo|tabela|pdf|arquivo)\b/i;
function prometeuMidiaSemCodigo(texto, midias) {
  return !(midias || []).length && PROMETEU_MIDIA.test(String(texto || ''));
}

module.exports = { registrar, listar, apagarDaEmpresa, prometeuMidiaSemCodigo };
