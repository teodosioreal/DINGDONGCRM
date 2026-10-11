// Meta Ads (anônimo, só números e sim/não): configuração, se os leads do site chegam com o
// código do atendimento e o clique do anúncio (fbclid), e como o site abre o WhatsApp.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const sn = (v) => (v ? 'sim' : 'não');
const DIAS = 14;
const desde = new Date(Date.now() - DIAS * 864e5).toISOString();
const fb = (u) => /[?&]fbclid=/.test(String(u || ''));
(async () => {
  for (const [n, e] of (db.empresas || []).entries()) {
    const m = e.metaAds || {};
    if (!m.pixelId && !m.token && !m.ativo) continue;
    const vendas = (db.vendas || []).filter((v) => v.empresaId === e.id);
    console.log(`  Empresa ${n + 1}: Meta ligada ${sn(m.ativo)} · Pixel ${sn(m.pixelId)} · token ${sn(m.token)} · CÓDIGO DE TESTE PREENCHIDO ${sn(m.codigoTeste)} · todas as vendas ${sn(m.todasVendas !== false)} · vendas enviadas: ${vendas.filter((v) => v.metaAds?.enviadoEm && !v.metaAds.teste).length} reais, ${vendas.filter((v) => v.metaAds?.enviadoEm && v.metaAds.teste).length} como teste · com erro ${vendas.filter((v) => v.metaAds?.erro).length} · a Meta confirmou recebimento: ${vendas.filter((v) => v.metaAds?.recebidos > 0).length} · enviadas SEM o clique (modo antigo 'todas'): ${vendas.filter((v) => v.metaAds?.enviadoEm && !v.metaAds?.dados?.clique && !(db.conversas || []).some((l) => l.id === v.leadId && fb(l.origemSite?.chegada?.url))).length}`);
    const leads = (db.conversas || []).filter((l) => l.empresaId === e.id && (l.criadoEm || '') >= desde);
    const primeira = (l) => String(((l.mensagens || []).find((x) => x.papel === 'visitante' && x.texto) || {}).texto || '');
    const doSite = leads.filter((l) => /Localidade:|Tenho interesse|Meu carro:/i.test(primeira(l)));
    const comCodigo = doSite.filter((l) => /#[A-Z2-9]{6}\b/.test(primeira(l)));
    const comOrigem = doSite.filter((l) => l.origemSite?.chegada);
    const comFb = leads.filter((l) => fb(l.origemSite?.chegada?.url) || fb(l.origemSite?.primeira?.url));
    console.log(`      leads ${DIAS} dias: ${leads.length} · com pré-mensagem do site: ${doSite.length} · desses com código #atendimento: ${comCodigo.length} · com origem do site gravada: ${comOrigem.length} · leads com clique de anúncio (fbclid): ${comFb.length}`);
    const vis = Object.values(db.visitas || {}).filter((v) => v.empresaId === e.id);
    console.log(`      cliques no WhatsApp do site guardados (esperando a mensagem chegar): ${vis.length} · com fbclid: ${vis.filter((v) => fb(v.rastro?.chegada?.url)).length}`);
    const conf = vendas.filter((v) => v.status === 'confirmada' && (v.confirmadaEm || v.criadoEm || '') >= desde);
    const daCampanha = conf.filter((v) => comFb.some((l) => l.id === v.leadId));
    console.log(`      vendas confirmadas ${DIAS} dias: ${conf.length} · de clientes com clique de anúncio: ${daCampanha.length}`);
    // o site: tem o nosso chat.js? como abre o WhatsApp?
    const bots = (db.bots || []).filter((b) => b.empresaId === e.id);
    const dominios = [...new Set(bots.flatMap((b) => b.dominios || []))].slice(0, 2);
    for (const [i, d] of dominios.entries()) {
      try {
        const r = await fetch(`https://${d}/`, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (diagnostico CRM)' } });
        const html = await r.text();
        const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((x) => x[1]);
        let js = '';
        for (const s of scripts.slice(0, 8)) {
          try { const u = new URL(s, `https://${d}/`); if (u.host !== d) continue; js += await (await fetch(u, { signal: AbortSignal.timeout(15000) })).text(); } catch { /* pula */ }
        }
        const tudo = html + js;
        console.log(`      site ${i + 1}: HTTP ${r.status} · nosso chat.js no site: ${sn(/\/chat\.js/.test(html) && /data-bot|crm/i.test(html))} · Pixel da Meta (fbq): ${sn(/fbq\(|connect\.facebook\.net/.test(tudo))} · links wa.me no HTML: ${(html.match(/wa\.me\/|api\.whatsapp\.com\/send/g) || []).length} · WhatsApp montado no JavaScript: ${sn(/wa\.me|api\.whatsapp\.com/.test(js))} · abre com window.open: ${sn(/window\.open\(/.test(js))} · abre com location.href: ${sn(/location\.href\s*=|location\.assign\(/.test(js))} · site React/SPA: ${sn(/id=["']root["']|__next|vite/i.test(html))}`);
      } catch (err) {
        console.log(`      site ${i + 1}: não consegui abrir (${String(err.message).slice(0, 60)})`);
      }
    }
  }
})();
