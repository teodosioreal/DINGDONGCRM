// Disparos que mandaram a mesma coisa duas vezes ou pausaram sozinhos (3 dias; anônimo: só
// horários, contagens e o caminho de cada cópia — nunca textos, nomes ou números).
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
const limpo = (s, n = 120) => String(s || '').replace(/\+?\d[\d\s()-]{7,}\d/g, '[núm]').replace(/\s+/g, ' ').slice(0, n);
const norm = (t) => String(t || '').split('\n[mídia:')[0].replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
const desde = new Date(Date.now() - 3 * 86400e3).toISOString();
const conversas = new Map((db.conversas || []).map((c) => [c.id, c]));
let algum = false;
for (const [n, e] of (db.empresas || []).entries()) {
  const ds = (db.disparos || []).filter((d) => d.empresaId === e.id && (d.criadoEm > desde || (d.destinatarios || []).some((x) => x.em > desde)));
  if (!ds.length) continue;
  algum = true;
  console.log(`  Empresa ${n + 1}: ${ds.length} disparo(s) com movimento em 3 dias`);
  for (const d of ds.slice(0, 8)) {
    const c = {};
    for (const x of d.destinatarios || []) c[x.status] = (c[x.status] || 0) + 1;
    let duplas = 0;
    const caminhos = {};
    const horarios = [];
    for (const x of d.destinatarios || []) {
      if (x.status !== 'enviado') continue;
      const l = conversas.get(x.leadId);
      if (!l) continue;
      const doDisparo = (l.mensagens || []).filter((m) => m.disparoId === d.id && !m.lembreteDisparo);
      const alvo = norm(doDisparo[0]?.texto);
      // cópias: outra mensagem do disparo, ou "da equipe" com o mesmo texto (eco que virou equipe), até 6 h depois
      const copias = (l.mensagens || []).filter((m) => m.papel !== 'visitante' && alvo && norm(m.texto) === alvo && Math.abs(Date.parse(m.em) - Date.parse(x.em)) < 6 * 3600e3);
      const reenvio = doDisparo.some((m) => m.reenvio);
      if (copias.length > 1 || reenvio) {
        duplas++;
        const k = reenvio ? 'reenvio pelo outro endereço' : copias.some((m) => !m.disparoId) ? 'eco do envio virou "mensagem da equipe" (resposta perdida / reinício)' : 'mandou duas vezes pelo disparo';
        caminhos[k] = (caminhos[k] || 0) + 1;
        horarios.push(hora(copias[0]?.em || x.em));
      }
    }
    console.log(`    disparo criado ${hora(d.criadoEm)} · ${d.status}${d.motivoPausa ? ` · motivo: ${limpo(d.motivoPausa)}` : ''} · ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (duplas) console.log(`      ⚠️ ${duplas} contato(s) com cópia: ${Object.entries(caminhos).map(([k, v]) => `${k} ${v}`).join(' · ')} · quando: ${horarios.slice(0, 8).join(', ')}`);
    const erros = {};
    for (const x of d.destinatarios || []) if (x.erro) erros[limpo(x.erro, 70)] = (erros[limpo(x.erro, 70)] || 0) + 1;
    if (Object.keys(erros).length) console.log(`      erros: ${Object.entries(erros).slice(0, 5).map(([k, v]) => `${v}× ${k}`).join(' | ')}`);
  }
}
if (!algum) console.log('  nenhum disparo com movimento em 3 dias');
