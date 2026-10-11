// Confere as mídias e SIMULA conversas com o prompt real numa CÓPIA do banco.
// Nada é enviado a ninguém e o banco de verdade não muda. Mostra só códigos e qual mídia iria
// (nunca o texto das respostas nem do prompt). Usa a IA de verdade (poucas chamadas, tarefa "teste").
const fs = require('fs');
const path = require('path');
const os = require('os');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sim-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(process.env.CRM_DB_PATH_ORIGINAL, copia);
fs.chmodSync(copia, 0o600);
Object.assign(process.env, { CRM_DB_PATH: copia, SINCRONIA: 'nao', EVENTOS_IA: 'nao', ETIQUETAS_ZAP: 'nao' });
const curto = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
(async () => {
  const { estado } = require('../src/db');
  const midias = require('../src/midias');
  const ia = require('../src/ia');
  const wa = require('../src/whatsapp');
  for (const [n, e] of estado.empresas.entries()) {
    if (!e.whatsappConfig?.instancia) continue;
    const bot = wa.botDoWhatsapp(e);
    const todas = midias.midiasDa(e).filter((m) => !m.pastaId);
    const cod = (m) => `#MIDIA_${m.numero || '?'}`;
    console.log(`  Empresa ${n + 1}: ${todas.length} mídias`);
    for (const m of todas) {
      const par = m.revezar ? todas.filter((x) => x !== m && x.revezar === m.revezar).map(cod).join(',') : '';
      console.log(`    ${cod(m)} · ${m.tipo} · "${curto(m.nome, 40)}" · ${midias.prontaParaIa(m) ? 'ATIVA' : 'a configurar'}${m.umaVezPorConversa === false ? ' · repete' : ''}${par ? ` · 🔁 reveza com ${par}` : ''} · quando: "${curto(m.descricao, 60)}"`);
    }
    // o que o prompt cita
    const av = midias.avisosDoPrompt(e);
    const problemas = av.citados.filter((c) => !c.existe).map((c) => `${c.codigo} NÃO EXISTE`);
    for (const c of av.citados.filter((x) => x.existe)) {
      const m = midias.resolverPedido(e, c.codigo).alvo;
      if (m && m.pronta === false) problemas.push(`${c.codigo} está "a configurar" (vale porque o prompt cita, mas fica fora do revezamento)`);
      if (m?.revezar) for (const x of todas.filter((y) => y !== m && y.revezar === m.revezar && !midias.prontaParaIa(y))) problemas.push(`${cod(x)} reveza com ${c.codigo} mas NÃO está ativa → fica fora do revezamento`);
    }
    console.log(`    prompt cita: ${av.citados.map((c) => c.codigo).join(' ')}`);
    console.log(`    problemas: ${problemas.length ? problemas.join(' · ') : 'nenhum'}`);
    console.log(`    próximo da vez no revezamento: ${JSON.stringify(e.revezamento || {})}`);
    // simulação (gasta tokens): só quando pedida (arquivo deploy/simular.pedido)
    if (!bot || process.env.SIMULAR_IA !== 'sim') { console.log('    simulação com a IA: desligada (só roda quando pedida)'); continue; }
    const contexto = () => ({ canal: 'whatsapp', tarefa: 'teste', midias: midias.paraIa(e), links: midias.linksDa(e), etapas: require('../src/leads').etapasDa(e), etapaAtual: require('../src/leads').etapasDa(e)[0] });
    // cenários (pré-mensagens do site e mensagens soltas) — cada resposta é conferida com as regras do
    // prompt da empresa; no log vão só códigos e "ok/atenção", nunca o texto
    const SITE_C = (carro, cidade) => `Olá! Tenho interesse no Revestimento Completo (Sintético). Meu carro: ${carro}. Localidade: ${cidade}`;
    const SITE_A = (carro, cidade) => `Olá! Tenho interesse no Revestimento no Aro. Meu carro: ${carro}. Localidade: ${cidade}`;
    // espera: { midias: [...códigos que DEVEM ir] , semMidia, pausar, pergunta (termina com pergunta), naoPergunta, tem: [regex], naoTem: [regex] }
    const clientes = [
      { nome: '1 site completo · Onix 2020 · Petrópolis', msgs: [[SITE_C('Onix 2020', 'Petrópolis'), { midias: ['#MIDIA_20'], pergunta: true }], ['show, gostei', { semMidia: true, pergunta: true, tem: [/foto/i] }]] },
      { nome: '2 site aro · Fiesta · Miguel Pereira', msgs: [[SITE_A('Fiesta', 'Miguel Pereira'), { midias: ['#MIDIA_22'], pergunta: true }]] },
      { nome: '3 site completo · cidade NÃO atendida (Rio)', msgs: [[SITE_C('HB20', 'Rio de Janeiro'), { semMidia: true, tem: [/Petr[óo]polis/, /Vassouras/] }]] },
      { nome: '4 sem pré-mensagem · pergunta preço', msgs: [['oi, quanto custa pra reformar o volante?', { semMidia: true, pergunta: true, tem: [/cidade/i] }], ['Paty do Alferes', { semMidia: true, pergunta: true, tem: [/carro|modelo/i] }], ['é um Corolla', { midias: ['#MIDIA_20'], tem: [/250/] }]] },
      { nome: '5 couro legítimo', msgs: [['Boa tarde, vocês fazem em couro legítimo? sou de Petrópolis', { midias: ['#MIDIA_11', '#MIDIA_10'], tem: [/liso/i] }]] },
      { nome: '6 instalação de capa do cliente', msgs: [['já comprei a capa de volante, vocês só instalam? moro em Vassouras', { semMidia: true, tem: [/180/] }]] },
      { nome: '7 pede atendente', msgs: [[SITE_C('Versa', 'Petrópolis'), { midias: ['#MIDIA_20'] }], ['quero falar com um atendente', { semMidia: true, pausar: true, tem: [/já te chamo/i] }]] },
      { nome: '8 pergunta se é robô', msgs: [[SITE_C('Kia Sportage', 'Vassouras'), { midias: ['#MIDIA_20'] }], ['vc é robô?', { pausar: false, tem: [/autom[áa]tico/i] }]] },
      { nome: '9 completo · achou caro', msgs: [[SITE_C('Cerato', 'Petrópolis'), { midias: ['#MIDIA_20'] }], ['achei caro', { midias: ['#MIDIA_22'], tem: [/150/] }]] },
      { nome: '10 completo · diferença pro aro', msgs: [[SITE_C('Onix 2023', 'Paulo de Frontin'), { midias: ['#MIDIA_20'] }], ['qual a diferença pro aro?', { midias: ['#MIDIA_12'], pergunta: true }]] },
      { nome: '11 completo · pede foto no carro (fora da tabela)', msgs: [[SITE_C('Gol', 'Petrópolis'), { midias: ['#MIDIA_20'] }], ['tem foto de um gol que vcs fizeram?', { semMidia: true }]] },
      { nome: '12 completo · pede foto no carro (na tabela)', msgs: [[SITE_C('Renegade', 'Petrópolis'), { midias: ['#MIDIA_20'] }], ['tem foto de um renegade?', { midias: ['#MIDIA_13'] }]] }
    ];
    const SEM_CODIGO = (l) => !/^#\s*(MIDIA|PAUSAR|ETAPA|ETIQUETA|NADA|HUMANO)/i.test(l.trim());
    let totalOk = 0;
    let totalAtencao = 0;
    for (const c of clientes) {
      const recebidas = new Set();
      const historico = [];
      const linhas = [];
      for (const [texto, espera] of c.msgs) {
        historico.push({ papel: 'visitante', canal: 'whatsapp', texto, em: new Date().toISOString() });
        let r;
        await new Promise((ok) => setTimeout(ok, 8000)); // chave grátis tem limite por minuto: espaça as chamadas
        try { r = await ia.responder(bot, e, historico, contexto()); } catch (err) { linhas.push(`ERRO da IA: ${curto(ia.descreverErroIa(err), 100)}`); totalAtencao++; break; }
        const pedidas = (r.midias || []).map((x) => (String(x).startsWith('#') ? x : `#MIDIA_${x}`));
        const iriam = [];
        const codigosQueIriam = [];
        for (const p of r.midias || []) {
          const ped = midias.resolverPedido(e, p);
          if (!ped.alvo) { iriam.push(`${p}→não existe`); continue; }
          let alvo = ped.alvo;
          if (ped.itens.length === 1 && alvo.revezar) alvo = midias.escolherRevezando(e, alvo, (m) => recebidas.has(m.id));
          if (recebidas.has(alvo.id) && alvo.umaVezPorConversa !== false) { iriam.push(`${cod(alvo)} (já recebeu, não repete)`); continue; }
          recebidas.add(alvo.id);
          for (const k of [cod(ped.alvo), cod(alvo)]) if (!codigosQueIriam.includes(k)) codigosQueIriam.push(k);
          iriam.push(alvo === ped.alvo ? cod(alvo) : `${cod(alvo)} (🔁 revezamento)`);
        }
        const textoIa = String(r.texto || '');
        const linhasTexto = textoIa.split('\n').map((x) => x.trim()).filter(Boolean).filter(SEM_CODIGO);
        // duas frases na mesma linha (fora a 1ª, onde o cumprimento pode vir junto)
        const grudadas = linhasTexto.filter((l, i) => i > 0 && /[.!?]\s+[A-ZÀ-Ú]/.test(l)).length;
        const falhas = [];
        if (linhasTexto.length > 3) falhas.push(`${linhasTexto.length} linhas (máx. 3)`);
        if (grudadas) falhas.push(`${grudadas} linha(s) com 2 frases`);
        for (const m of espera.midias || []) if (!codigosQueIriam.includes(m)) falhas.push(`devia mandar ${m}`);
        if (espera.midias) for (const m of codigosQueIriam) if (!espera.midias.includes(m) && !iriam.some((x) => x.includes(`${m} (🔁`))) falhas.push(`mandou ${m} a mais`);
        if (espera.semMidia && codigosQueIriam.length) falhas.push(`mandou mídia sem precisar (${codigosQueIriam.join(' ')})`);
        if (espera.pausar === true && !r.humano) falhas.push('não pausou (#PAUSAR)');
        if (espera.pausar === false && r.humano) falhas.push('pausou sem precisar');
        const ultima = linhasTexto[linhasTexto.length - 1] || '';
        if (espera.pergunta && !/\?\s*$/.test(ultima)) falhas.push('não terminou com pergunta');
        for (const re of espera.tem || []) if (!re.test(textoIa)) falhas.push(`faltou falar "${re.source.replace(/\[[^\]]*\]/g, '·').replace(/[\\()^$]/g, '').split('|')[0]}"`);
        if (/[\u{1F300}-\u{1FAFF}]/u.test(textoIa)) falhas.push('usou emoji');
        if (falhas.length) totalAtencao++; else totalOk++;
        linhas.push(`${falhas.length ? '⚠️ ATENÇÃO' : '✓ ok'} · msg ${historico.filter((h) => h.papel === 'visitante').length} → ${linhasTexto.length} linha(s) · pediu ${pedidas.join(' ') || 'nenhuma mídia'} · iria: ${iriam.join(' ') || '-'}${r.humano ? ' · #PAUSAR' : ''}${falhas.length ? ` · ${falhas.join('; ')}` : ''}`);
        historico.push({ papel: 'assistente', canal: 'whatsapp', texto: textoIa, em: new Date().toISOString() });
      }
      console.log(`    Cenário ${c.nome}:`);
      for (const l of linhas) console.log(`      ${l}`);
    }
    console.log(`    RESULTADO: ${totalOk} resposta(s) ok · ${totalAtencao} com atenção`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // deixa a cópia terminar de salvar antes de apagar
  fs.rmSync(pasta, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => console.log('    erro na simulação:', err.message));
