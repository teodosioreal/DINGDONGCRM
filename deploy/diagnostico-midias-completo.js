// Diagnóstico completo das mídias (só leitura, anônimo): cadastro (arquivo no disco, link
// público, vídeo convertido, pronta), o que o prompt cita, o que a IA pediu nas últimas 48 h
// e o que aconteceu com cada mídia que saiu (Evolution + confirmação do WhatsApp).
// Mostra só códigos/tipos/contagens: nunca nomes de clientes, números, textos ou chaves.
const fs = require('fs');
const path = require('path');

const original = process.env.CRM_DB_PATH_ORIGINAL;
const os = require('os');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-diag-midias-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(original, copia);
fs.chmodSync(copia, 0o600);
process.env.CRM_DB_PATH = copia;
process.env.SINCRONIA = 'nao';

const desde = Date.now() - 48 * 3600 * 1000;
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const mb = (b) => `${((b || 0) / 1048576).toFixed(1)} MB`;
const limpo = (t) => String(t || '').replace(/\d{6,}/g, '[núm]').replace(/https?:\/\/\S+/g, '[link]').slice(0, 140);

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
  const { estado } = require('../src/db');
  const midias = require('../src/midias');
  const publico = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  for (const [n, e] of estado.empresas.entries()) {
    if (!e.whatsappConfig?.instancia) continue;
    const todas = midias.midiasDa(e);
    console.log(`  Empresa ${n + 1}: ${todas.length} mídias · álbuns ${midias.albunsDa(e).length} · pastas do Drive ${midias.pastasDa(e).length}`);
    // A) cadastro
    const problemas = {};
    const conta = (k) => (problemas[k] = (problemas[k] || 0) + 1);
    for (const m of todas) {
      const naoSalva = !fs.existsSync(midias.caminhoDoArquivo(m));
      let link = '';
      if (publico && !naoSalva) link = await fetch(`${publico}/midia/${m.id}/${encodeURIComponent(m.arquivo)}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) }).then((r) => r.status).catch((err) => err.message);
      const pronta = midias.prontaParaIa(m);
      const vid = m.tipo === 'video' ? (m.processando ? 'convertendo' : m.erroVideo ? `erro: ${limpo(m.erroVideo)}` : m.videoOk ? 'ok p/ WhatsApp' : m.convertido ? 'convertido' : 'sem conferência') : '';
      const marcas = [];
      if (naoSalva) { marcas.push('ARQUIVO NÃO EXISTE NO DISCO'); conta('arquivo sumiu'); }
      if (link && link !== 200) { marcas.push(`link público HTTP ${link}`); conta('link quebrado'); }
      if (m.pronta === false) conta('a configurar');
      if (!String(m.descricao || '').trim()) conta('sem "quando enviar"');
      if (m.tipo === 'video' && m.tamanho > 16 * 1048576) conta('vídeo > 16 MB');
      console.log(`    ${midias.codigoVisivel(m.codigo)} · ${m.tipo} ${m.mimetype || '?'} ${mb(m.tamanho)}${vid ? ` · vídeo ${vid}` : ''} · ${pronta ? 'pronta p/ IA' : m.pronta === false ? 'a configurar' : 'não pronta'}${m.soFollowup ? ' · só follow-up' : ''}${m.etapas?.length ? ` · só etapas ${m.etapas.length}` : ''}${m.assuntos?.length ? ` · assuntos ${m.assuntos.length}` : ''}${m.albumId ? ' · em álbum' : ''}${m.pastaId ? ' · do Drive' : ''}${m.umaVezPorConversa === false ? ' · repete' : ''}${marcas.length ? ` · ⚠️ ${marcas.join(' · ')}` : ''}`);
    }
    console.log(`    resumo do cadastro: ${JSON.stringify(problemas)}`);
    // B) prompt
    const av = midias.avisosDoPrompt(e);
    const naIa = new Set(midias.paraIa(e).map((x) => midias.codigoVisivel(x.codigo)));
    console.log(`    prompt cita: ${av.citados.map((c) => `${c.codigo} ${c.existe ? (naIa.has(c.codigo) ? '(IA enxerga)' : '(existe, mas a IA NÃO enxerga)') : '(NÃO EXISTE)'}`).join(' · ') || 'nada'}`);
    console.log(`    a IA enxerga ${naIa.size} mídia(s)/álbum(ns): ${[...naIa].join(' ')}`);
    // C) o que a IA pediu (48 h)
    const logs = (estado.logRespostas || []).filter((l) => l.empresaId === e.id && new Date(l.em).getTime() > desde);
    const porStatus = {};
    const motivos = {};
    let prometeu = 0;
    for (const l of logs) {
      for (const it of l.midias || []) {
        const k = `${it.codigo} → ${it.status}`;
        porStatus[k] = (porStatus[k] || 0) + 1;
        if (it.status !== 'enviada' && it.motivo) motivos[`${it.status}: ${limpo(it.motivo)}`] = (motivos[`${it.status}: ${limpo(it.motivo)}`] || 0) + 1;
      }
      if ((l.avisos || []).some((a) => /sem escrever o código|não escreveu nenhum código/.test(a))) prometeu++;
    }
    console.log(`    respostas da IA (48 h): ${logs.length} · prometeu mídia sem código: ${prometeu}`);
    for (const [k, v] of Object.entries(porStatus)) console.log(`      ${k}: ${v}x`);
    for (const [k, v] of Object.entries(motivos).slice(0, 12)) console.log(`      motivo ${k} (${v}x)`);
    // D) mídias que saíram (48 h) e a confirmação do WhatsApp
    const saidas = [];
    for (const c of estado.conversas) {
      if (c.empresaId !== e.id) continue;
      for (const m of c.mensagens || []) if (m.papel !== 'visitante' && m.canal === 'whatsapp' && (m.midiaId || m.anexo) && new Date(m.em).getTime() > desde) saidas.push({ c, m });
    }
    saidas.sort((a, b) => String(a.m.em).localeCompare(String(b.m.em)));
    const porEntrega = {};
    for (const { m } of saidas) porEntrega[m.entrega || 'sem status'] = (porEntrega[m.entrega || 'sem status'] || 0) + 1;
    console.log(`    mídias que saíram (48 h): ${saidas.length} · confirmação no CRM: ${JSON.stringify(porEntrega)}`);
    for (const { c, m } of saidas.slice(-15)) {
      const ids = [m.wid, ...(m.wids || [])].filter(Boolean);
      let zap = 'sem id da Evolution';
      if (ids.length) {
        const r = await evo(e, 'POST', '/chat/findMessages/{i}', { where: { key: { id: ids[0] } } });
        const x = (r.j?.messages?.records || [])[0];
        zap = x ? `na Evolution: ${x.messageType} status ${x.status || (x.MessageUpdate || []).slice(-1)[0]?.status || '?'} · destino ${String(x.key?.remoteJid || '').endsWith('@lid') ? 'lid' : 'número'}` : `não achada (HTTP ${r.status})`;
      }
      const cod = m.midiaCodigo ? midias.codigoVisivel(m.midiaCodigo) : m.anexo ? `arquivo ${m.anexo.tipo}` : '?';
      console.log(`      ${hora(m.em)} ${m.papel} · ${cod} · CRM=${m.entrega || 'sem status'}${m.envio ? `/${m.envio}` : ''} · ${zap} · conversa ${c.whatsappJid ? 'número' : 'só lid'}${c.lidJid ? '+lid' : ''}`);
    }
  }
  fs.rmSync(pasta, { recursive: true, force: true });
})().catch((err) => console.log('    erro no diagnóstico:', err.message));
