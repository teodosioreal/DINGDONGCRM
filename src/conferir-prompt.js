// conferir-prompt.js — botão "Atualizar e conferir" das instruções da IA.
// Prova que a IA está lendo as instruções SALVAS agora e confere se obedece:
//   1. monta o prompt de verdade (o mesmo do atendimento) e confere que o texto
//      salvo está lá dentro;
//   2. a IA transforma as instruções em regras que dá para testar e cria
//      mensagens de cliente que testam essas regras;
//   3. a IA de atendimento responde essas mensagens (igual a um cliente real);
//   4. um "fiscal" compara cada resposta com cada regra: obedeceu ou não, e por quê.
// Nada é gravado em conversa nenhuma e nada é enviado para cliente.

const ia = require('./ia');
const leads = require('./leads');
const midias = require('./midias');

const MAX_REGRAS = 6;
const MAX_TESTES = 3;

// Economia: clicar de novo sem ter mudado nada (instruções, mídias, IA escolhida)
// devolve o último resultado em vez de gastar IA outra vez (guardado só na memória).
const VALE_MS = 12 * 3600 * 1000;
const ultimos = new Map();
function assinatura(bot, empresa, canal, instrucoes) {
  const motores = (ia.motoresDa ? ia.motoresDa(empresa, bot) : []).map((m) => `${m.provedor}|${m.modelo}`);
  const lista = midias.paraIa(empresa).map((x) => [x.codigo, x.numero, x.nome, x.descricao]);
  return require('crypto').createHash('sha256').update(JSON.stringify([bot.id, canal, instrucoes, motores, lista, empresa.iaEconomica])).digest('hex');
}

function lerJson(t) {
  const m = String(t || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('a IA não devolveu o formato esperado');
  return JSON.parse(m[0]);
}

const curto = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function contextoDoAtendimento(empresa, canal, mensagem) {
  const ctx = { canal, etapas: leads.etapasDa(empresa), etapaAtual: leads.etapasDa(empresa)[0], etiquetas: leads.etiquetasDa(empresa) };
  if (canal === 'whatsapp') {
    ctx.midias = midias.paraIa(empresa);
    ctx.links = midias.linksDa(empresa);
    // o clone também entra, como no atendimento de verdade
    const falso = { id: 'conferir', empresaId: empresa.id, etapa: ctx.etapaAtual, mensagens: [{ papel: 'visitante', texto: mensagem }] };
    try { ctx.clone = require('./clone').paraIa(empresa, falso); } catch { /* sem clone */ }
  } else {
    ctx.midias = midias.paraIa(empresa);
    ctx.links = midias.linksDa(empresa);
  }
  return ctx;
}

async function conferir(bot, empresa, canal = 'whatsapp') {
  return ia.comTarefa('conferir-prompt', () => conferirNa(bot, empresa, canal));
}

async function conferirNa(bot, empresa, canal) {
  const instrucoes = String((canal === 'whatsapp' ? bot.promptWhatsapp : bot.regras) || '').trim();
  if (!instrucoes) throw Object.assign(new Error('Escreva e salve as instruções primeiro.'), { status: 400 });

  // 1. o prompt de verdade tem as instruções salvas?
  const prompt = ia.montarPromptSistema(bot, empresa, canal, contextoDoAtendimento(empresa, canal, 'oi'));
  const lendo = prompt.fixo.includes(instrucoes) && prompt.dinamico.includes(instrucoes.slice(0, 200));
  const chave = assinatura(bot, empresa, canal, instrucoes);
  const guardado = ultimos.get(`${empresa.id}|${bot.id}|${canal}`);
  if (guardado && guardado.chave === chave && Date.now() - guardado.em < VALE_MS) {
    return { ...guardado.r, lendo, repetido: true, resumo: `(Nada mudou desde a última conferência — mostrando o mesmo resultado, sem gastar IA.) ${guardado.r.resumo || ''}`.trim() };
  }

  // 2. regras testáveis + mensagens de cliente que testam as regras
  const plano = lerJson(
    await ia.gerarTexto(
      bot,
      empresa,
      'Você prepara um teste de obediência para um atendente virtual. Responda SOMENTE com JSON, sem texto antes ou depois.',
      `Instruções que o dono da empresa escreveu para o atendente (${canal === 'whatsapp' ? 'WhatsApp' : 'chat do site'}):\n<instrucoes>\n${instrucoes}\n</instrucoes>\n\n` +
        `Faça: (a) até ${MAX_REGRAS} regras curtas e concretas tiradas dessas instruções, que dá para conferir lendo uma resposta (ex.: "Pergunta o que o cliente precisa antes de passar preço"); ` +
        `(b) ${MAX_TESTES} mensagens curtas e realistas de um cliente chegando agora, cada uma pensada para testar uma ou mais regras (escreva como cliente de verdade escreve no WhatsApp).\n` +
        'JSON: {"regras": ["..."], "mensagens": ["..."]}',
      1200,
      { barato: true, semPensar: true }
    )
  );
  const regras = (Array.isArray(plano.regras) ? plano.regras : []).map((r) => curto(r, 200)).filter(Boolean).slice(0, MAX_REGRAS);
  const mensagens = (Array.isArray(plano.mensagens) ? plano.mensagens : []).map((m) => curto(m, 300)).filter(Boolean).slice(0, MAX_TESTES);
  if (!regras.length || !mensagens.length) throw new Error('Não consegui montar o teste a partir das instruções. Tente de novo.');

  // 3. a IA de atendimento responde (o mesmo caminho do atendimento real)
  const conversas = await Promise.all(
    mensagens.map(async (cliente) => {
      try {
        const r = await ia.responder(bot, empresa, [{ papel: 'visitante', texto: cliente }], contextoDoAtendimento(empresa, canal, cliente));
        const extras = [r.humano ? 'chamou a equipe' : '', r.etapa ? `moveu para "${r.etapa}"` : '', r.midias?.length ? `mandou mídia ${r.midias.join(', ')}` : ''].filter(Boolean);
        return { cliente, ia: curto(r.texto, 1200), acoes: extras };
      } catch (err) {
        return { cliente, ia: '', erro: ia.descreverErroIa ? ia.descreverErroIa(err) : err.message };
      }
    })
  );
  const respondidas = conversas.filter((c) => c.ia);
  if (!respondidas.length) throw new Error(conversas[0]?.erro || 'A IA não respondeu o teste.');

  // 4. o fiscal: cada regra foi obedecida?
  const transcricao = respondidas.map((c, i) => `Teste ${i + 1}\nCliente: ${c.cliente}\nAtendente: ${c.ia}${c.acoes.length ? `\n(ações do atendente: ${c.acoes.join('; ')})` : ''}`).join('\n\n');
  const fiscal = lerJson(
    await ia.gerarTexto(
      bot,
      empresa,
      'Você é um fiscal rigoroso e justo. Confere se um atendente virtual obedeceu às instruções do dono. Responda SOMENTE com JSON.',
      `Instruções do dono:\n<instrucoes>\n${instrucoes}\n</instrucoes>\n\nRegras a conferir:\n${regras.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nConversas de teste (primeira resposta do atendente):\n${transcricao}\n\n` +
        'Para cada regra diga: "sim" (obedeceu em todos os testes em que a regra se aplicava), "nao" (desobedeceu em algum) ou "nao_testada" (nenhum teste deu chance de aplicar). Explique em uma frase curta, citando o teste. ' +
        'Depois, uma frase de resumo e, se houver desobediência, uma sugestão curta de como reescrever a instrução para ficar mais clara.\n' +
        'JSON: {"regras": [{"n": 1, "resultado": "sim|nao|nao_testada", "porque": "..."}], "resumo": "...", "sugestao": "..."}',
      1500,
      { barato: true, semPensar: true }
    )
  );
  const porN = new Map((Array.isArray(fiscal.regras) ? fiscal.regras : []).map((r) => [Number(r.n), r]));
  const resultado = regras.map((regra, i) => {
    const f = porN.get(i + 1) || {};
    const r = ['sim', 'nao', 'nao_testada'].includes(f.resultado) ? f.resultado : 'nao_testada';
    return { regra, resultado: r, porque: curto(f.porque, 300) };
  });
  const obedeceu = resultado.filter((r) => r.resultado === 'sim').length;
  const desobedeceu = resultado.filter((r) => r.resultado === 'nao').length;
  const r = {
    canal,
    lendo,
    instrucoesSalvasEm: bot.atualizadoEm || null,
    caracteres: instrucoes.length,
    regras: resultado,
    conversas,
    nota: desobedeceu ? 'atencao' : 'ok',
    placar: `${obedeceu} de ${resultado.length} regras obedecidas${desobedeceu ? ` · ${desobedeceu} desobedecida(s)` : ''}`,
    resumo: curto(fiscal.resumo, 400),
    sugestao: desobedeceu ? curto(fiscal.sugestao, 500) : ''
  };
  ultimos.set(`${empresa.id}|${bot.id}|${canal}`, { chave, em: Date.now(), r });
  return r;
}

module.exports = { conferir };
