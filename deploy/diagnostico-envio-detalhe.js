// Detalhe das últimas mensagens que a empresa mandou para UMA conversa (DIAG_FINAL = final do
// número): para cada texto/mídia, o que a Evolution guardou — tipo, se o arquivo foi para o
// WhatsApp (url/directPath/mediaKey), tamanho, mimetype e a lista de status. Sem texto, sem número.
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const final = process.env.DIAG_FINAL === 'TODAS' ? 'TODAS' : String(process.env.DIAG_FINAL || '').replace(/\D/g, '');
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
async function evo(e, caminho, corpo) {
  const c = e.whatsappConfig;
  const base = (c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}${caminho.replace('{i}', encodeURIComponent(c.instancia))}`, { method: 'POST', headers: { apikey: c.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000) });
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}
(async () => {
  for (const [n, e] of (db.empresas || []).entries()) {
    if (!e.whatsappConfig?.instancia) continue;
    const leads = (db.conversas || []).filter((c) => c.empresaId === e.id && (final === 'TODAS' ? (c.mensagens || []).some((m) => m.papel !== 'visitante' && (m.midiaId || m.anexo) && Date.now() - new Date(m.em).getTime() < 48 * 3600 * 1000) : [c.telefone, c.whatsappJid].some((x) => String(x || '').split('@')[0].replace(/\D/g, '').endsWith(final))));
    for (const l of leads) {
      console.log(`  Empresa ${n + 1} · conversa ${final === 'TODAS' ? '' : `final ${final} `}· destino ${String(l.whatsappJid || '').endsWith('@lid') ? 'lid' : 'número'} · tem lid: ${l.lidJid ? 'sim' : 'não'}`);
      const saidas = (l.mensagens || []).filter((m) => m.papel !== 'visitante' && (final !== 'TODAS' || ((m.midiaId || m.anexo) && Date.now() - new Date(m.em).getTime() < 48 * 3600 * 1000))).slice(-12);
      for (const m of saidas) {
        const ids = [m.wid, ...(m.wids || [])].filter(Boolean);
        const cad = m.midiaId ? (e.midias || []).find((x) => x.id === m.midiaId) : null;
        const tipoCrm = m.midiaId ? `mídia biblioteca #${cad?.numero || '?'} (cadastro: arquivo termina em "${(String(cad?.arquivo || '').match(/\.[a-z0-9]{1,5}$/i) || ['(sem extensão)'])[0]}", tipo ${cad?.mimetype || '?'})` : m.anexo ? `anexo ${m.anexo.tipo}` : 'texto';
        if (!ids.length) { console.log(`    ${hora(m.em)} ${m.papel} · ${tipoCrm} · CRM=${m.entrega || '-'} · SEM ID da Evolution (não foi registrada como enviada)`); continue; }
        const r = await evo(e, '/chat/findMessages/{i}', { where: { key: { id: ids[0] } } });
        const x = (r?.messages?.records || [])[0];
        if (!x) { console.log(`    ${hora(m.em)} ${m.papel} · ${tipoCrm} · CRM=${m.entrega || '-'} · NÃO ACHADA na Evolution`); continue; }
        const corpo = x.message || {};
        const midia = corpo.imageMessage || corpo.videoMessage || corpo.documentMessage || corpo.audioMessage || null;
        const st = (x.MessageUpdate || []).map((u) => u.status).join('>') || x.status || '?';
        const extra = midia ? ` · nome do arquivo termina em: "${(String(midia.fileName || '').match(/\.[a-z0-9]{1,5}$/i) || ['(sem extensão)'])[0]}" · arquivo: url ${midia.url ? 'sim' : 'NÃO'} · directPath ${midia.directPath ? 'sim' : 'NÃO'} · mediaKey ${midia.mediaKey ? 'sim' : 'NÃO'} · ${midia.mimetype || '?'} · ${Math.round(Number(midia.fileLength?.low ?? midia.fileLength ?? 0) / 1024)} KB` : '';
        console.log(`    ${hora(m.em)} ${m.papel} · ${tipoCrm} · CRM=${m.entrega || '-'} · Evolution: ${x.messageType} · para ${String(x.key?.remoteJid || '').endsWith('@lid') ? 'lid' : 'número'} · status ${st}${extra}`);
      }
    }
  }
})();
