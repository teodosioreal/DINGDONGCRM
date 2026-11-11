// Mensagens que chegaram no WhatsApp × mensagens que entraram no CRM (anônimo: só horários,
// tipo e se entrou; nunca texto nem número). Também mostra o webhook de cada empresa
// (se aponta para este CRM, se está ligado e se tem os eventos de mensagem).
// Serve para saber se a Evolution está recebendo e o CRM não (webhook) ou se a própria
// Evolution parou de receber (conexão "aberta" mas parada).
const fs = require('fs');

const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const urlPublica = String(process.env.PUBLIC_URL || db.config?.urlPublica || '').replace(/\/+$/, '');
const hora = (s) => new Date(s * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function chamar(base, chave, metodo, caminho, corpo) {
  const r = await fetch(`${base}${caminho}`, { method: metodo, headers: { apikey: chave, 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20000) });
  return { status: r.status, j: await r.json().catch(() => null) };
}

(async () => {
  const agora = Date.now() / 1000;
  console.log(`      agora ${hora(agora)}`);
  for (const [n, e] of (db.empresas || []).entries()) {
    const c = e.whatsappConfig || {};
    if (!c.instancia) continue;
    const base = String(c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const inst = encodeURIComponent(c.instancia);
    try {
      const w = await chamar(base, c.apiKey, 'GET', `/webhook/find/${inst}`);
      const wh = w.j?.webhook || w.j || {};
      const ev = (wh.events || []).map((x) => String(x).toUpperCase());
      const nosso = wh.url ? (urlPublica && wh.url.startsWith(`${urlPublica}/api/public/whatsapp/${e.id}/`) ? 'deste CRM' : 'OUTRO endereço') : 'NENHUM';
      if (wh.url && nosso !== 'deste CRM') {
        // por que não bate (sem mostrar o endereço nem o segredo): protocolo, host, caminho
        let a = null, b = null;
        try { a = new URL(wh.url); b = new URL(urlPublica || 'http://x'); } catch {}
        const forma = (u) => (u ? u.pathname.split('/').map((p) => (p.length > 14 ? '<código>' : p)).join('/') : '?');
        console.log(`        webhook × CRM: protocolo ${a?.protocol || '?'} × ${b?.protocol || '?'} · mesmo host ${a && b && a.host === b.host ? 'sim' : 'NÃO'} · caminho do webhook ${forma(a)} · caminho do CRM ${forma(b)} · tem o id desta empresa ${wh.url.includes(e.id) ? 'sim' : 'NÃO'} · tem o segredo desta empresa ${c.segredo && wh.url.includes(c.segredo) ? 'sim' : 'NÃO'}`);
      }
      console.log(`      Empresa ${n + 1}: webhook HTTP ${w.status} · ${nosso} · ligado ${wh.enabled !== false ? 'sim' : 'NÃO'} · MESSAGES_UPSERT ${ev.includes('MESSAGES_UPSERT') ? 'sim' : 'NÃO'} · eventos ${ev.length}`);
      const cs = await chamar(base, c.apiKey, 'GET', `/instance/connectionState/${inst}`);
      console.log(`        conexão: HTTP ${cs.status} · ${cs.j?.instance?.state || cs.j?.state || '?'}`);
      const r = await chamar(base, c.apiKey, 'POST', `/chat/findMessages/${inst}`, { where: { key: { fromMe: false } }, page: 1, offset: 40 });
      const lista = (r.j?.messages?.records || r.j?.records || (Array.isArray(r.j) ? r.j : [])).filter((m) => !String(m.key?.remoteJid || '').endsWith('@g.us') && !String(m.key?.remoteJid || '').includes('broadcast'));
      lista.sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp));
      const wids = new Set();
      for (const l of db.conversas || []) if (l.empresaId === e.id) for (const m of l.mensagens || []) { if (m.wid) wids.add(m.wid); for (const x of m.wids || []) wids.add(x); }
      const recentes = lista.slice(0, 12);
      const faltam = recentes.filter((m) => !wids.has(m.key?.id)).length;
      console.log(`        Evolution: findMessages HTTP ${r.status} · últimas ${recentes.length} recebidas (fora grupos) · NÃO estão no CRM: ${faltam}`);
      for (const m of recentes) console.log(`          ${hora(Number(m.messageTimestamp))} · ${m.messageType || '?'} · ${wids.has(m.key?.id) ? 'no CRM' : 'FALTA NO CRM'}`);
      if (recentes[0]) console.log(`        última que a Evolution recebeu: há ${Math.round((agora - Number(recentes[0].messageTimestamp)) / 60)} min`);
    } catch (err) {
      console.log(`      Empresa ${n + 1}: erro ${String(err.message).replace(/\d{6,}/g, '[núm]')}`);
    }
  }
})();
