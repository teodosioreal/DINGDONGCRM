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

db.empresas.forEach((e, i) => {
  const ls = (db.conversas || []).filter((c) => c.empresaId === e.id && c.mensagens?.length);
  if (!ls.length) return;
  console.log(`      Empresa ${i + 1}: ${ls.length} conversa(s)`);
  console.log(`        tipo do contato: ${JSON.stringify(conta(ls, (c) => tipoJid(c.whatsappJid)))}`);
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
  const s = e.whatsappConfig?.sincronia;
  if (s) console.log(`        última busca de mensagens: ${s.em} (${s.motivo}) importadas ${s.importadas}${s.erro ? ` ERRO ${s.erro}` : ''}`);
});
