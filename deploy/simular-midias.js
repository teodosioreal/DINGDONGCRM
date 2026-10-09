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
    // simulação
    if (!bot) continue;
    const contexto = () => ({ canal: 'whatsapp', tarefa: 'teste', midias: midias.paraIa(e), links: midias.linksDa(e), etapas: require('../src/leads').etapasDa(e), etapaAtual: require('../src/leads').etapasDa(e)[0] });
    const clientes = [
      { nome: 'Cliente 1 (site, completo)', msgs: ['Olá! Tenho interesse no Revestimento Completo (Sintético). Meu carro: Onix 2020. Localidade: Petrópolis', 'qual a diferença pro aro?'] },
      { nome: 'Cliente 2 (site, completo)', msgs: ['Olá! Tenho interesse no Revestimento Completo (Sintético). Meu carro: Corolla. Localidade: Petrópolis'] },
      { nome: 'Cliente 3 (site, completo)', msgs: ['Olá! Tenho interesse no Revestimento Completo (Sintético). Meu carro: Gol. Localidade: Vassouras'] },
      { nome: 'Cliente 4 (site, aro)', msgs: ['Olá! Tenho interesse no Revestimento no Aro. Meu carro: Fiesta. Localidade: Miguel Pereira'] },
      { nome: 'Cliente 5 (site, completo)', msgs: ['Olá! Tenho interesse no Revestimento Completo (Sintético). Meu carro: Cerato. Localidade: Petrópolis', 'achei caro'] }
    ];
    for (const c of clientes) {
      const recebidas = new Set();
      const historico = [];
      const linhas = [];
      for (const texto of c.msgs) {
        historico.push({ papel: 'visitante', canal: 'whatsapp', texto, em: new Date().toISOString() });
        let r;
        await new Promise((ok) => setTimeout(ok, 13000)); // chave grátis tem limite por minuto: espaça as chamadas
        try { r = await ia.responder(bot, e, historico, contexto()); } catch (err) { linhas.push(`ERRO da IA: ${curto(ia.descreverErroIa(err), 100)}`); break; }
        const pedidas = (r.midias || []).map((x) => (String(x).startsWith('#') ? x : `#MIDIA_${x}`));
        const iriam = [];
        for (const p of r.midias || []) {
          const ped = midias.resolverPedido(e, p);
          if (!ped.alvo) { iriam.push(`${p}→não existe`); continue; }
          let alvo = ped.alvo;
          if (ped.itens.length === 1 && alvo.revezar) alvo = midias.escolherRevezando(e, alvo, (m) => recebidas.has(m.id));
          if (recebidas.has(alvo.id) && alvo.umaVezPorConversa !== false) { iriam.push(`${cod(alvo)} (já recebeu, não repete)`); continue; }
          recebidas.add(alvo.id);
          iriam.push(alvo === ped.alvo ? cod(alvo) : `${cod(alvo)} (🔁 revezamento)`);
        }
        const nLinhas = String(r.texto || '').split('\n').filter((x) => x.trim()).length;
        linhas.push(`msg "${texto.length > 40 ? texto.slice(0, 40) + '…' : texto}" → IA: ${nLinhas} linha(s) de texto · pediu ${pedidas.join(' ') || 'nenhuma mídia'} · iria: ${iriam.join(' ') || '-'}${r.humano ? ' · #PAUSAR' : ''}`);
        historico.push({ papel: 'assistente', canal: 'whatsapp', texto: r.texto || '', em: new Date().toISOString() });
      }
      console.log(`    ${c.nome}:`);
      for (const l of linhas) console.log(`      ${l}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500)); // deixa a cópia terminar de salvar antes de apagar
  fs.rmSync(pasta, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => console.log('    erro na simulação:', err.message));
