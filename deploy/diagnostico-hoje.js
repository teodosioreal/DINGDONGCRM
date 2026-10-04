// Diagnóstico das últimas 30 h (só leitura, anônimo): conexão do WhatsApp,
// fotos/PDFs dos clientes, comprovantes, vendas e etiquetas. Não grava nada no
// banco do CRM e não muda nada na Evolution (só consulta). Nunca mostra números
// de telefone, nomes de clientes nem chaves.
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const desde = Date.now() - 30 * 3600 * 1000;
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// código que a Evolution manda em connection.update (data.statusReason) quando cai
const MOTIVOS = { 401: 'sessão encerrada pelo WhatsApp (precisa QR novo)', 403: 'bloqueado (forbidden)', 408: 'perda de conexão (rede)', 411: 'excedeu aparelhos vinculados', 428: 'conexão encerrada', 440: 'outro aparelho assumiu', 500: 'sessão corrompida (precisa QR novo)', 503: 'servidor do WhatsApp indisponível', 515: 'reinício interno (normal)' };

async function evo(e, metodo, caminho) {
  const c = e.whatsappConfig;
  const base = (c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}${caminho.replace('{i}', encodeURIComponent(c.instancia))}`, { method: metodo, headers: { apikey: c.apiKey }, signal: AbortSignal.timeout(15000) });
    return { status: r.status, j: await r.json().catch(() => null) };
  } catch (err) {
    return { status: err.message };
  }
}

(async () => {
  const empresas = (db.empresas || []).filter((e) => e.whatsappConfig?.instancia);
  for (const [n, e] of empresas.entries()) {
    const c = e.whatsappConfig;
    console.log(`    Empresa ${n + 1} (${c.instancia}):`);
    const st = await evo(e, 'GET', '/instance/connectionState/{i}');
    const cfg = await evo(e, 'GET', '/settings/find/{i}');
    const s = cfg.j?.settings || cfg.j || {};
    const motivo = c.perfil?.motivoFechou;
    console.log(`      conexão agora: ${st.j?.instance?.state || st.j?.state || `HTTP ${st.status}`} · CRM viu por último: ${c.perfil?.estado || '?'} em ${hora(c.perfil?.conferidoEm)}${c.perfil?.estado === 'close' && motivo !== undefined ? ` (motivo: ${MOTIVOS[Number(motivo)] || `código ${motivo}`})` : ''} · último aviso da Evolution: ${hora(c.ultimoWebhookEm)} (${c.ultimoEvento || '?'})`);
    console.log(`      syncFullHistory na Evolution: ${s.syncFullHistory === undefined ? 'não informado' : s.syncFullHistory} · socket reiniciado pelo CRM: ${c.socketReiniciadoEm ? hora(c.socketReiniciadoEm) : 'nunca marcado'}`);
    if (c.sincronia) console.log(`      última busca de mensagens: ${hora(c.sincronia.em)} (${c.sincronia.motivo}) · ${c.sincronia.importadas || 0} recuperada(s)${c.sincronia.erro ? ` · erro: ${c.sincronia.erro}` : ''}`);
    // mensagens dos clientes nas últimas 30 h
    const leads = (db.conversas || []).filter((l) => l.empresaId === e.id);
    const msgs = leads.flatMap((l) => (l.mensagens || []).filter((m) => m.papel === 'visitante' && new Date(m.em).getTime() > desde).map((m) => ({ ...m, lead: l })));
    const midia = msgs.filter((m) => /^\[o cliente enviou (uma imagem|um documento)\]/.test(m.texto || '') || m.anexo);
    console.log(`      mensagens de clientes (30 h): ${msgs.length} · ao vivo: ${msgs.filter((m) => !m.importada).length} · recuperadas depois de queda: ${msgs.filter((m) => m.importada).length}`);
    console.log(`      fotos/PDFs de clientes: ${midia.length} · com arquivo baixado: ${midia.filter((m) => m.anexo).length} · viraram venda: ${midia.filter((m) => m.anexo?.vendaId).length} · recuperadas sem arquivo: ${midia.filter((m) => m.importada && !m.anexo).length}`);
    for (const m of midia.slice(-12)) {
      const t = String(m.texto || '').replace(/\d{6,}/g, '[núm]').slice(0, 90);
      console.log(`        ${hora(m.em)} ${m.importada ? 'recuperada' : 'ao vivo'} · ${m.anexo ? `arquivo ${m.anexo.tipo || ''} ${m.anexo.mimetype || ''}${m.anexo.vendaId ? ' · VENDA' : ''}` : 'SEM arquivo'} · "${t}"`);
    }
    // vendas
    const vendas = (db.vendas || []).filter((v) => v.empresaId === e.id && new Date(v.criadoEm || v.data).getTime() > desde);
    const f = e.faturamento || {};
    console.log(`      faturamento: ${f.ativo === false ? 'DESLIGADO' : 'ligado'} · ler com IA: ${f.usarIa === false ? 'não' : 'sim'} · recebedores cadastrados: ${String(f.recebedores || '').trim() ? 'sim' : 'não'}`);
    console.log(`      vendas (30 h): ${vendas.length}${vendas.length ? ' → ' + vendas.map((v) => `${v.status}/${v.origem || '?'}/${v.lidoPor || '?'}${v.motivoConferir ? ` (${String(v.motivoConferir).slice(0, 50)})` : ''}`).join(' · ') : ''}`);
    // etiquetas
    const z = e.etiquetasZap || {};
    const tags = e.etiquetas || [];
    const usos = (id) => leads.filter((l) => (l.etiquetas || []).includes(id)).length;
    console.log(`      etiquetas: sincronia ${z.ativo === false ? 'DESLIGADA' : 'ligada'} · no celular: ${Object.keys(z.labels || {}).length} · última etiqueta recebida: ${hora(z.ultimoEventoEm)} · última leitura: ${hora(z.carregadoEm)}${z.erro ? ` · ${z.erro}` : ''}`);
    console.log(`      etiquetas no CRM: ${tags.map((t) => `${t.nome}${t.zapId ? '' : '(só CRM)'}=${usos(t.id)}`).join(', ') || 'nenhuma'}`);
    const agendado = tags.find((t) => /^agendad/.test(sem(t.nome)));
    if (agendado) {
      const comVenda = leads.filter((l) => (l.etiquetas || []).includes(agendado.id) && (db.vendas || []).some((v) => v.leadId === l.id && v.status !== 'cancelada'));
      console.log(`      com "Agendado" e venda registrada (deveriam ter trocado): ${comVenda.length}`);
    }
    const errosZap = leads.filter((l) => l.erroEtiquetaZap && new Date(l.erroEtiquetaZap.em).getTime() > desde);
    if (errosZap.length) console.log(`      erros ao marcar etiqueta no celular (30 h): ${errosZap.length} · ex.: ${String(errosZap[0].erroEtiquetaZap.msg).slice(0, 120)}`);
  }
})().catch((err) => console.log('    erro:', err.message));
