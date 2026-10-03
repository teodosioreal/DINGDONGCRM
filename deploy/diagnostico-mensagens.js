// Compara as mensagens das últimas 24 h na Evolution com as do CRM (só leitura,
// anônimo): quantas chegaram, quantas faltam, de que tipo e de que horário.
// Não grava nada e não muda nada na Evolution. Não mostra números nem textos.
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const HORAS = Number(process.env.DIAG_HORAS) || 24;
const hora = (s) => new Date(s * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const seg = (v) => (typeof v === 'number' ? v : Number(v?.low ?? v) || Math.floor(new Date(v).getTime() / 1000) || 0);
const conta = (lista, f) => lista.reduce((o, x) => ((o[f(x)] = (o[f(x)] || 0) + 1), o), {});

async function evo(e, corpo) {
  const c = e.whatsappConfig;
  const base = (c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/chat/findMessages/${encodeURIComponent(c.instancia)}`, { method: 'POST', headers: { apikey: c.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(30000) });
  return r.json();
}

(async () => {
  const desde = Date.now() / 1000 - HORAS * 3600;
  for (const [n, e] of (db.empresas || []).filter((x) => x.whatsappConfig?.instancia && x.whatsappConfig?.apiKey).entries()) {
    console.log(`    Empresa ${n + 1} (${e.whatsappConfig.instancia}) — últimas ${HORAS} h:`);
    const todas = [];
    try {
      for (let p = 1; p <= 40; p++) {
        const r = await evo(e, { where: { messageTimestamp: { gte: new Date(desde * 1000).toISOString(), lte: new Date(Date.now() + 60000).toISOString() } }, page: p, offset: 100 });
        const recs = r?.messages?.records || [];
        todas.push(...recs);
        if (recs.length < 100 || p >= (Number(r?.messages?.pages) || 0)) break;
      }
    } catch (err) {
      console.log(`      erro ao ler a Evolution: ${err.message}`);
      continue;
    }
    const tipoJid = (j) => (/@g\.us$/.test(j) ? 'grupo' : /status@broadcast/.test(j) ? 'status' : /@lid$/.test(j) ? 'lid' : /@s\.whatsapp\.net$/.test(j) ? 'número' : /@newsletter/.test(j) ? 'canal' : 'outro');
    const msgs = todas.filter((m) => seg(m.messageTimestamp) >= desde);
    console.log(`      na Evolution: ${msgs.length} · por destino: ${JSON.stringify(conta(msgs, (m) => tipoJid(m.key?.remoteJid)))}`);
    const conversa = msgs.filter((m) => ['lid', 'número'].includes(tipoJid(m.key?.remoteJid)));
    // ids que o CRM tem
    const wids = new Set();
    for (const l of (db.conversas || []).filter((c) => c.empresaId === e.id)) for (const m of l.mensagens || []) { if (m.wid) wids.add(m.wid); for (const w of m.wids || []) wids.add(w); }
    const lixo = new Set((db.lixeira || []).filter((c) => c.empresaId === e.id).flatMap((c) => (c.mensagens || []).map((m) => m.wid)).filter(Boolean));
    const ehCliente = (m) => !m.key?.fromMe;
    for (const [rotulo, lista] of [['dos clientes', conversa.filter(ehCliente)], ['da empresa (celular/IA)', conversa.filter((m) => !ehCliente(m))]]) {
      const falta = lista.filter((m) => !wids.has(m.key?.id) && !lixo.has(m.key?.id));
      console.log(`      mensagens ${rotulo}: ${lista.length} · no CRM: ${lista.length - falta.length} · FALTAM: ${falta.length}${falta.length ? ` → tipos ${JSON.stringify(conta(falta, (m) => m.messageType || '?'))}` : ''}`);
      if (rotulo === 'dos clientes' && falta.length) {
        const porHora = conta(falta, (m) => hora(seg(m.messageTimestamp)).slice(0, 9) + 'h');
        console.log(`        faltando por hora: ${JSON.stringify(porHora)}`);
        const conversasFaltando = new Set(falta.map((m) => m.key?.remoteJid)).size;
        console.log(`        em ${conversasFaltando} conversa(s) diferentes`);
      }
    }
    const midiaCliente = conversa.filter((m) => ehCliente(m) && /image|document/i.test(m.messageType || ''));
    console.log(`      fotos/PDFs dos clientes na Evolution: ${midiaCliente.length} · no CRM: ${midiaCliente.filter((m) => wids.has(m.key?.id)).length}`);
    for (const m of midiaCliente.filter((x) => !wids.has(x.key?.id)).slice(0, 15)) console.log(`        FALTA: ${hora(seg(m.messageTimestamp))} · ${m.messageType} · conversa ${tipoJid(m.key?.remoteJid)}`);
  }
})().catch((err) => console.log('    erro:', err.message));
