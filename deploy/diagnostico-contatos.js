// Diagnóstico ANÔNIMO dos contatos (roda no deploy, só lê o banco, não muda nada).
// Mostra o formato dos números e das fotos de perfil sem expor nenhum telefone:
// os dígitos do meio aparecem como "•".
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
if (!fs.existsSync(arquivo)) {
  console.log('      (sem banco ainda)');
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const mascara = (s) => {
  const d = String(s || '').replace(/\D/g, '');
  if (!d) return '(vazio)';
  return `${d.slice(0, 4)}${'•'.repeat(Math.max(0, d.length - 6))}${d.slice(-2)} [${d.length} díg.]`;
};
const tipoJid = (j) => (!j ? 'sem jid' : /@s\.whatsapp\.net$/.test(j) ? 'número' : /@lid$/.test(j) ? 'LID (escondido)' : `outro (${String(j).split('@')[1] || '?'})`);
const conta = (lista, f) => lista.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});

const sondas = [];
db.empresas.forEach((e, i) => {
  const ls = (db.conversas || []).filter((c) => c.empresaId === e.id && c.mensagens?.length);
  if (!ls.length) return;
  console.log(`      Empresa ${i + 1}: ${ls.length} conversa(s)`);
  console.log(`        tipo do contato: ${JSON.stringify(conta(ls, (c) => tipoJid(c.whatsappJid)))}`);
  // mesmo cliente em mais de uma conversa? (pelo número sem o 9 e pelo nome do WhatsApp)
  const chave = (c) => { let d = String(/@s\.whatsapp\.net$/.test(c.whatsappJid || '') ? c.whatsappJid : c.telefone || '').split('@')[0].replace(/\D/g, ''); if (/^55\d{2}9\d{8}$/.test(d)) d = d.slice(0, 4) + d.slice(5); return d.length >= 10 ? d : ''; };
  const porNumero = conta(ls.filter(chave), chave);
  const porNome = conta(ls.filter((c) => c.nome), (c) => c.nome.trim().toLowerCase());
  console.log(`        ligações LID→número conhecidas: ${Object.keys(e.mapaLid || {}).length} · mesmo número em 2+ conversas: ${Object.values(porNumero).filter((n) => n > 1).length} · mesmo nome em 2+ conversas: ${Object.values(porNome).filter((n) => n > 1).length}`);
  const fmt = (c) => {
    const d = String(c.telefone || '').replace(/\D/g, '');
    if (!d) return 'sem telefone';
    if (/^55\d{2}9\d{8}$/.test(d)) return 'BR celular 13 díg. (ok)';
    if (/^55\d{2}[6-9]\d{7}$/.test(d)) return 'BR celular sem o 9 (ok, mostra com 9)';
    if (/^55\d{2}[2-5]\d{7}$/.test(d)) return 'BR fixo (ok)';
    if (/^\d{10,11}$/.test(d)) return 'sem o 55';
    return `estranho (${d.length} díg.)`;
  };
  console.log(`        formato do telefone: ${JSON.stringify(conta(ls, fmt))}`);
  const jidVsTel = ls.filter((c) => /@s\.whatsapp\.net$/.test(c.whatsappJid || '') && c.telefone && c.whatsappJid.split('@')[0] !== String(c.telefone).replace(/\D/g, ''));
  if (jidVsTel.length) console.log(`        jid ≠ telefone: ${jidVsTel.length} (ex.: jid ${mascara(jidVsTel[0].whatsappJid)} / tel ${mascara(jidVsTel[0].telefone)})`);
  const estranhos = ls.filter((c) => /estranho|sem o 55|sem telefone/.test(fmt(c))).slice(0, 12);
  for (const c of estranhos) {
    console.log(`        · ${fmt(c)} | tel ${mascara(c.telefone)} | jid ${tipoJid(c.whatsappJid)} ${mascara(c.whatsappJid)} | nome ${c.nome ? 'sim' : 'não'} | origem ${c.origem || '?'} | ${c.mensagens.length} msg`);
  }
  const foto = (c) => (c.fotoPerfil?.em && !c.fotoPerfil.semFoto ? 'com foto' : c.fotoPerfil?.semFoto ? 'sem foto (privacidade)' : c.fotoPerfil?.erro ? `erro: ${String(c.fotoPerfil.erro).replace(/\d{6,}/g, '#').slice(0, 70)}` : c.fotoPerfil ? 'outro' : 'nunca buscada');
  console.log(`        fotos: ${JSON.stringify(conta(ls, foto))}`);
  const umLid = ls.find((c) => /@lid$/.test(c.whatsappJid || ''));
  if (umLid && e.whatsappConfig?.instancia && e.whatsappConfig?.apiKey) sondas.push({ i, e, lid: umLid.whatsappJid });
  const s = e.whatsappConfig?.sincronia;
  if (s) console.log(`        última busca de mensagens: ${s.em} (${s.motivo}) importadas ${s.importadas}${s.erro ? ` ERRO ${s.erro}` : ''}`);
  // aviso de agendamento: está ligado? para qual número (final)? os últimos foram enviados?
  const av = e.avisoAgendamento || {};
  const conectado = String(e.whatsappConfig?.perfil?.numero || '').replace(/\D/g, '');
  const num = String(av.numero || '').replace(/\D/g, '');
  const mesmo = (a, b) => a && b && a.replace(/^(55\d{2})9(\d{8})$/, '$1$2') === b.replace(/^(55\d{2})9(\d{8})$/, '$1$2');
  console.log(`        aviso de agendamento: ${av.ativo ? 'LIGADO' : 'desligado'} · número ${num ? `final ${num.slice(-4)} (${num.length} díg.)` : 'nenhum'}${mesmo(num, conectado) ? ' · É O MESMO NÚMERO DO WHATSAPP CONECTADO' : ''} · perceber sozinho: ${e.agendaAutomatica === false ? 'desligado' : 'ligado'}`);
  const ags = ls.flatMap((c) => (c.agendamentos || []).map((a) => ({ ...a, lead: c.id }))).sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  console.log(`        agendamentos: ${ags.length} · por quem: ${JSON.stringify(conta(ags, (a) => a.por || '?'))} · situação: ${JSON.stringify(conta(ags, (a) => a.status || '?'))}`);
  for (const a of ags.slice(0, 6)) console.log(`        · criado ${a.criadoEm} por ${a.por}${a.detectadoPor ? `/${a.detectadoPor}` : ''} · ${a.status} · aviso: ${a.avisoStatus || (a.avisoEm ? 'na fila' : 'não disparado')}${a.avisoErro ? ` ERRO ${String(a.avisoErro).replace(/\d{6,}/g, '#').slice(0, 120)}` : ''}`);
});

// Sonda: para um contato com número escondido, qual caminho da Evolution devolve o número?
(async () => {
  for (const { i, e, lid } of sondas) {
    const base = (e.whatsappConfig.evolutionUrl || process.env.EVOLUTION_API_URL || 'https://api.evolutiondingdong.online').replace(/\/+$/, '');
    const chamar = async (caminho, corpo) => {
      try {
        const r = await fetch(`${base}${caminho.replace('{i}', encodeURIComponent(e.whatsappConfig.instancia))}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: e.whatsappConfig.apiKey }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000) });
        return { status: r.status, j: await r.json().catch(() => null) };
      } catch (err) {
        return { status: 0, erro: err.message };
      }
    };
    const tel = (v) => (/@s\.whatsapp\.net$/.test(String(v || '')) ? mascara(v) : null);
    const n = await chamar('/chat/whatsappNumbers/{i}', { numbers: [lid] });
    const nRes = Array.isArray(n.j) ? n.j.map((x) => tel(x.jid) || tel(x.remoteJidAlt)).find(Boolean) : null;
    const m = await chamar('/chat/findMessages/{i}', { where: { key: { remoteJid: lid } }, page: 1, offset: 20 });
    const regs = m.j?.messages?.records || [];
    const campos = [...new Set(regs.flatMap((x) => Object.keys(x.key || {})))].join(',');
    const mRes = regs.map((x) => tel(x.key?.remoteJidAlt) || tel(x.key?.senderPn) || tel(x.key?.participantAlt)).find(Boolean);
    const c = await chamar('/chat/findContacts/{i}', { where: { remoteJid: lid } });
    const cCampos = Array.isArray(c.j) && c.j[0] ? Object.keys(c.j[0]).join(',') : '';
    const f = await chamar('/chat/fetchProfilePictureUrl/{i}', { number: lid });
    console.log(`      Sonda (empresa ${i + 1}, contato com número escondido):`);
    console.log(`        whatsappNumbers: HTTP ${n.status} → número ${nRes || 'não veio'}`);
    console.log(`        findMessages: HTTP ${m.status}, ${regs.length} msg, campos da chave: [${campos}] → número ${mRes || 'não veio'}`);
    console.log(`        findContacts: HTTP ${c.status}, campos: [${cCampos}]`);
    console.log(`        foto pelo id escondido: HTTP ${f.status} → ${f.j?.profilePictureUrl ? 'TEM foto' : 'sem foto'}`);
    // o número da empresa é WhatsApp Business? (só Business tem etiquetas)
    const dono = String(e.whatsappConfig?.perfil?.numero || '').replace(/\D/g, '');
    if (dono) {
      const bp = await chamar('/chat/fetchBusinessProfile/{i}', { number: dono });
      const campos = bp.j && typeof bp.j === 'object' ? Object.keys(bp.j).filter((k) => bp.j[k]) : [];
      console.log(`        perfil comercial do número da empresa: HTTP ${bp.status} → ${campos.length ? 'WhatsApp Business (' + campos.slice(0, 6).join(',') + ')' : 'sem perfil comercial (WhatsApp comum?)'}`);
    }
    // etiquetas do WhatsApp Business (só nomes e quantidade; nada de cliente)
    try {
      const r = await fetch(`${base}/label/findLabels/${encodeURIComponent(e.whatsappConfig.instancia)}`, { headers: { apikey: e.whatsappConfig.apiKey }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => null);
      console.log(`        etiquetas (findLabels): HTTP ${r.status} → ${Array.isArray(j) ? `${j.length}: ${j.map((x) => x.name).join(', ')}` : 'formato desconhecido'}`);
      const ch = await chamar('/chat/findChats/{i}', {});
      const comLabels = Array.isArray(ch.j) ? ch.j.filter((x) => Array.isArray(x.labels) && x.labels.length).length : 0;
      console.log(`        findChats: HTTP ${ch.status}, ${Array.isArray(ch.j) ? ch.j.length : 0} conversas, ${comLabels} com etiquetas, campo labels ${Array.isArray(ch.j) && ch.j[0] && 'labels' in ch.j[0] ? 'existe' : 'não existe'}`);
    } catch (err) {
      console.log(`        etiquetas: erro ${err.message}`);
    }
    const etq = e.etiquetasZap;
    if (etq) console.log(`        CRM: etiquetas do zap ${Object.keys(etq.labels || {}).length}, lidas em ${etq.carregadoEm || 'nunca'}${etq.erro ? `, aviso: ${etq.erro}` : ''}`);
  }
})();
