// Diagnóstico das mídias que a equipe/IA mandou nas últimas 12 h (só leitura, anônimo):
// se a Evolution devolveu o id, se a mensagem existe no WhatsApp e o status dela, e se o
// link da mídia abre de fora. Nunca mostra números, nomes de clientes, textos nem chaves.
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const desde = Date.now() - 12 * 3600 * 1000;
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const limpo = (t) => String(t || '').replace(/\d{6,}/g, '[núm]').replace(/https?:\/\/\S+/g, '[link]').slice(0, 160);

async function evo(e, metodo, caminho, corpo) {
  const c = e.whatsappConfig;
  const base = (c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}${caminho.replace('{i}', encodeURIComponent(c.instancia))}`, { method: metodo, headers: { apikey: c.apiKey, 'content-type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(15000) });
    return { status: r.status, j: await r.json().catch(() => null) };
  } catch (err) {
    return { status: err.message };
  }
}

(async () => {
  const empresas = (db.empresas || []).filter((e) => e.whatsappConfig?.instancia);
  for (const [n, e] of empresas.entries()) {
    const conexao = await evo(e, 'GET', '/instance/connectionState/{i}');
    const wh = await evo(e, 'GET', '/webhook/find/{i}');
    const eventos = (wh.j?.events || wh.j?.webhook?.events || []).join(',');
    console.log(`  Empresa ${n + 1}: conexão agora = ${conexao.j?.instance?.state || conexao.j?.state || conexao.status} · webhook com MESSAGES_UPDATE: ${/MESSAGES_UPDATE/.test(eventos) ? 'sim' : 'não'} · confirmações recebidas desde: ${hora(e.whatsappConfig.statusEntregaEm)}`);
    const itens = [];
    for (const c of db.conversas || []) {
      if (c.empresaId !== e.id) continue;
      for (const m of c.mensagens || []) {
        if (m.papel === 'visitante' || m.canal !== 'whatsapp' || !(m.anexo || m.midiaId) || new Date(m.em).getTime() < desde) continue;
        itens.push({ c, m });
      }
    }
    itens.sort((a, b) => String(a.m.em).localeCompare(String(b.m.em)));
    console.log(`    Mídias enviadas nas últimas 12 h: ${itens.length}`);
    for (const { c, m } of itens.slice(-12)) {
      const ids = [m.wid, ...(m.wids || [])].filter(Boolean);
      let noZap = 'sem id da Evolution';
      if (ids.length) {
        const r = await evo(e, 'POST', '/chat/findMessages/{i}', { where: { key: { id: ids[0] } } });
        const reg = r.j?.messages?.records || (Array.isArray(r.j) ? r.j : []);
        const x = reg[0];
        noZap = x ? `existe na Evolution (${x.messageType || '?'}, status ${x.status || x.MessageUpdate?.slice?.(-1)?.[0]?.status || '?'})` : `não achada na Evolution (HTTP ${r.status})`;
      }
      const origem = m.midiaId ? `biblioteca (${(db.empresas.find((x) => x.id === e.id)?.midias || []).find((x) => x.id === m.midiaId)?.tipo || '?'})` : `arquivo do computador (${m.anexo?.tipo || '?'}, ${Math.round((m.anexo?.tamanho || 0) / 1024)} KB)`;
      console.log(`    - ${hora(m.em)} ${m.papel} · ${origem} · envio=${m.envio || 'ok'} · ${noZap}${m.erroEnvio ? ` · erro: ${limpo(m.erroEnvio)}` : ''}${c.lidJid && !c.whatsappJid ? ' · conversa só com id escondido (LID)' : ''}`);
    }
    // link público das mídias: a Evolution baixa por ele
    const publico = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const midia = (e.midias || []).filter((x) => x.arquivo).slice(-1)[0];
    if (publico && midia) {
      const r = await fetch(`${publico}/midia/${midia.id}/${encodeURIComponent(midia.arquivo)}`, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).then((x) => x.status).catch((err) => err.message);
      console.log(`    Link público de uma mídia da biblioteca abre de fora: HTTP ${r}`);
    } else console.log(`    Link público: ${publico ? 'sem mídia na biblioteca' : 'PUBLIC_URL não configurada'}`);
    const alertas = (db.alertas || []).filter((a) => a.empresaId === e.id && ['midia', 'whatsapp-envio'].includes(a.tipo) && new Date(a.ultimoEm).getTime() > desde);
    for (const a of alertas.slice(0, 6)) console.log(`    Alerta ${hora(a.ultimoEm)} (${a.vezes}x): ${limpo(a.mensagem)}`);
  }
})();
