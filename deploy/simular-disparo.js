// Simula clientes respondendo a um disparo da empresa LEADS e mede as respostas da IA de verdade,
// numa CÓPIA do banco (nada é enviado e o banco de verdade não muda). No log vão só NÚMEROS de
// cada resposta (balões, palavras, pergunta no fim, mídia, preço) e a mensagem de teste do
// cliente — nunca o texto da IA nem o prompt. Só roda quando existe deploy/simular-disparo.pedido.
const fs = require('fs');
const path = require('path');
const os = require('os');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-simdisp-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
fs.chmodSync(copia, 0o600);
Object.assign(process.env, { CRM_DB_PATH: copia, SINCRONIA: 'nao', EVENTOS_IA: 'nao', ETIQUETAS_ZAP: 'nao' });

const CENARIOS = [
  ['aceita e pede preço', ['sim, pode mandar', 'gostei, quanto fica?', 'pode me ligar amanhã de manhã']],
  ['pergunta o preço direto', ['quanto custa?']],
  ['já tem Instagram', ['já tenho instagram']],
  ['desconfia do contato', ['quem é você? como conseguiu meu número?']],
  ['acha caro', ['quanto custa?', 'tá caro']],
  ['vai pensar', ['manda aí', 'vou pensar']],
  ['sem interesse', ['não tenho interesse']],
  ['só "oi"', ['oi']],
  ['prazo e como funciona', ['como funciona? quanto tempo demora pra ficar pronto?']],
  ['já levou calote', ['boa tarde, então, a gente até pensou em fazer site mas o rapaz sumiu com o dinheiro, como sei que vcs são confiáveis?']],
  ['pergunta se é robô', ['vc é robô?']],
  ['áudio pedindo explicação', ['[áudio do cliente]: opa tudo bem, me explica melhor isso aí que eu tô dirigindo']]
];

const palavras = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
const frases = (t) => String(t || '').split(/[.!?]+(\s|$)/).filter((x) => x && x.trim().length > 2).length;

(async () => {
  const { estado } = require('../src/db');
  const ia = require('../src/ia');
  const wa = require('../src/whatsapp');
  const leads = require('../src/leads');
  const midias = require('../src/midias');
  const disparos = require('../src/disparos');
  const e = estado.empresas.find((x) => /lead/i.test(x.nome || '') && x.whatsappConfig?.instancia);
  if (!e) return console.log('    (empresa LEADS com WhatsApp não encontrada)');
  const bot = wa.botDoWhatsapp(e);
  if (!bot) return console.log('    (LEADS sem bot do WhatsApp)');
  const prompt = String(bot.promptWhatsapp || '');
  const ultimo = estado.disparos.filter((d) => d.empresaId === e.id).sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))[0];
  console.log(`    prompt do WhatsApp: ${prompt.length} letras · ${palavras(prompt)} palavras · ${prompt.split('\n').filter((l) => l.trim()).length} linhas · cita mídias ${(prompt.match(/#MIDIA_\w+/g) || []).length}x · fala de tamanho/curto ${/curt|tamanho|frase|linha|textão|resum/i.test(prompt) ? 'sim' : 'NÃO'}`);
  console.log(`    mídias ativas ${midias.paraIa(e).length} · último disparo ${ultimo ? `com ${ultimo.versoes?.length || 1} versão(ões) e roteiro ${ultimo.roteiro ? `${ultimo.roteiro.length} letras` : 'não'}` : 'nenhum (simulo um)'}`);

  // o disparo que o cliente "recebeu": o último de verdade, ou um de mentira só nesta cópia
  const disp = ultimo || { id: 'dsp_simulado', empresaId: e.id, nome: 'Simulação', mensagem: '{Oi|Olá}! Vi a {empresa_contato} no Google. Posso te mandar um exemplo de site?', destinatarios: [], status: 'concluido' };
  if (!ultimo) estado.disparos.push(disp);
  const textoDisparo = (disp.versoes?.[0]?.texto || disp.mensagem);
  const resumo = { respostas: 0, longas: 0, semPergunta: 0, balõesMax: 0, palavrasTotal: 0 };
  for (const [nome, falas] of CENARIOS) {
    const lead = leads.criarLead({ empresa: e, bot, canal: 'manual', nome: 'Guincho Exemplo', telefone: '5511900000000' });
    lead.prospeccao = { empresa: 'Guincho Exemplo', cidade: 'Cascavel', estado: 'PR', ramo: 'Serviço de reboque', nota: '4.8', avaliacoes: '35', temSite: 'nao' };
    leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: `${disparos.montarMensagem(textoDisparo, lead, e)}\n\n${disparos.RODAPE_SAIR}`, disparoId: disp.id });
    console.log(`    ▶ ${nome}${nome === CENARIOS[0][0] ? ` (clone nesta conversa: ${require('../src/clone').paraIa(e, lead) ? 'sim' : 'não'})` : ''}`);
    for (const fala of falas) {
      leads.adicionarMensagem(lead, { papel: 'visitante', canal: 'whatsapp', texto: fala });
      let r;
      try {
        r = await ia.responder(bot, e, leads.historicoParaIa(lead), {
          canal: 'whatsapp', tarefa: 'teste', disparo: disparos.paraIa(lead), clone: require('../src/clone').paraIa(e, lead),
          midias: midias.paraIa(e), links: midias.linksDa(e), etapas: leads.etapasDa(e), etapaAtual: lead.etapa, etiquetas: leads.etiquetasDa(e)
        });
      } catch (err) {
        console.log(`       cliente: "${fala}" → ERRO da IA: ${String(err.message).slice(0, 100)}`);
        continue;
      }
      const partes = wa.partesDaResposta(r);
      const textos = partes.filter((p) => p.tipo === 'texto').map((p) => p.texto);
      const mids = partes.filter((p) => p.tipo === 'midia').map((p) => p.codigo);
      const total = textos.reduce((s, t) => s + palavras(t), 0);
      const maior = Math.max(0, ...textos.map(palavras));
      const pergunta = /\?\s*\S{0,3}\s*$/.test(textos[textos.length - 1] || '');
      const longa = total > 45 || maior > 30 || textos.length > 3;
      resumo.respostas++; resumo.palavrasTotal += total; resumo.balõesMax = Math.max(resumo.balõesMax, textos.length);
      if (longa) resumo.longas++;
      if (!pergunta && !r.humano) resumo.semPergunta++;
      console.log(`       cliente: "${fala}" → IA: ${textos.length} balão(ões) · ${total} palavras (maior ${maior}) · ${textos.reduce((s, t) => s + frases(t), 0)} frases · ${pergunta ? 'termina com pergunta' : 'SEM pergunta no fim'}${mids.length ? ` · mídia ${mids.join(',')}` : ''}${textos.some((t) => /R\$\s?\d/.test(t)) ? ' · falou preço' : ''}${r.humano ? ' · chamou humano' : ''}${r.etapa ? ` · etapa→${r.etapa}` : ''}${longa ? ' · ⚠️ LONGA' : ''}`);
      leads.adicionarMensagem(lead, { papel: 'assistente', canal: 'whatsapp', texto: r.texto });
    }
  }
  console.log(`    RESUMO: ${resumo.respostas} respostas · média ${resumo.respostas ? Math.round(resumo.palavrasTotal / resumo.respostas) : 0} palavras · longas ${resumo.longas} · sem pergunta no fim ${resumo.semPergunta} · até ${resumo.balõesMax} balões numa resposta`);
  fs.rmSync(pasta, { recursive: true, force: true });
})().catch((err) => console.log(`    erro na simulação: ${String(err.message).slice(0, 160)}`));
