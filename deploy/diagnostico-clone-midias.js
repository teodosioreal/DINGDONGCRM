// Mídias que o Clone guardou e o que a IA mandou de mídia (3 dias) — só códigos, nomes de
// arquivo e contagens (sem cliente, telefone ou texto de conversa)
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const ms = (x) => new Date(x || 0).getTime();
const corte = Date.now() - 3 * 864e5;
for (const [n, e] of (db.empresas || []).entries()) {
  const midias = e.midias || [];
  const c = e.clone || {};
  const doClone = midias.filter((m) => m.aprendidaDoClone);
  const envios = {};
  for (const l of (db.conversas || []).filter((x) => x.empresaId === e.id)) {
    for (const m of l.mensagens || []) {
      if (!m.midiaCodigo || ms(m.em) < corte || !/enviou a mídia/.test(m.texto || '')) continue;
      const k = `${m.midiaCodigo}|${m.papel}`;
      envios[k] = (envios[k] || 0) + 1;
    }
  }
  if (!doClone.length && !Object.keys(envios).length) continue;
  console.log(`  Empresa ${n + 1}: Clone ${c.ativo ? 'aprendendo' : 'desligado'}${c.responder ? ' e ATENDENDO' : ''} · mídias guardadas pelo Clone: ${doClone.length} · arquivos apagados lembrados: ${(e.midiasApagadasHash || []).length}`);
  for (const m of doClone.slice(-15)) console.log(`      clone: #MIDIA_${m.numero || '?'} · ${m.tipo} · "${String(m.nome || '').slice(0, 45)}" · criada ${String(m.criadoEm || '').slice(0, 10)} · ${m.pronta === false ? 'a configurar' : 'pronta'}${m.donoConfirmou ? ' · você ativou' : ''} · quando: "${String(m.descricao || '').replace(/\d{4,}/g, '#').slice(0, 60)}"`);
  const linhas = Object.entries(envios).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, v] of linhas) {
    const [cod, papel] = k.split('|');
    const m = midias.find((x) => x.codigo === cod);
    console.log(`      enviada (3 dias): ${m ? `#MIDIA_${m.numero || '?'} "${String(m.nome || '').slice(0, 40)}"${m.aprendidaDoClone ? ' 🧬 CÓPIA DO CLONE' : ''}${m.albumId ? ' (álbum)' : ''}` : `${cod} (NÃO EXISTE MAIS)`} · por ${papel === 'assistente' ? 'IA/sistema' : papel} · ${v}x`);
  }
}
