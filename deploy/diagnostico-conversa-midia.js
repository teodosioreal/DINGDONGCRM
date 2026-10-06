// Diagnóstico de UMA conversa (pelo final do número, em DIAG_FINAL): o que a IA escreveu de
// código e o que aconteceu com cada mídia nas últimas respostas. Anônimo e só leitura: nunca
// mostra o texto da conversa nem o número completo — só códigos, status e motivos.
const fs = require('fs');
const os = require('os');
const path = require('path');

const original = process.env.CRM_DB_PATH_ORIGINAL;
const final = String(process.env.DIAG_FINAL || '').replace(/\D/g, '');
if (!final) process.exit(0);
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-diag-conv-'));
const copia = path.join(pasta, 'data.json');
fs.copyFileSync(original, copia);
fs.chmodSync(copia, 0o600);
process.env.CRM_DB_PATH = copia;
process.env.SINCRONIA = 'nao';
const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const FALA_MIDIA = /\b(foto|imagem|v[ií]deo|segue|mando|enviei|mandei|olha|veja|confira)\b/i;

try {
  const { estado } = require('../src/db');
  const midias = require('../src/midias');
  for (const [n, e] of estado.empresas.entries()) {
    const leads = estado.conversas.filter((c) => c.empresaId === e.id && [c.telefone, c.whatsappJid].some((x) => String(x || '').split('@')[0].replace(/\D/g, '').endsWith(final)));
    for (const l of leads) {
      console.log(`  Empresa ${n + 1} · conversa final ${final}: ${l.mensagens.length} mensagens · IA ${l.iaPausada ? `PAUSADA (${l.iaDesligadaPor || 'equipe'})` : 'ligada'} · etapa "${l.etapa}" · mídias já enviadas: ${Object.keys(l.midiasEnviadas || {}).map((c) => midias.numeroDoCodigo(e, c)).join(' ') || 'nenhuma'}`);
      const logs = (estado.logRespostas || []).filter((x) => x.leadId === l.id).slice(-8);
      for (const g of logs) {
        const escritos = String(g.bruto || '').match(/[#\[]{1,2}\s*M[IÍ]DIA[^\s\]]*\]?\]?/gi) || [];
        const linhas = String(g.bruto || '').split('\n').filter((x) => x.trim()).length;
        console.log(`    ${hora(g.em)} ${g.origem} · ${g.situacao} · modelo ${g.modelo || '?'} · ${linhas} linha(s) · códigos escritos: ${escritos.join(' ') || 'NENHUM'} · texto fala de foto/vídeo: ${FALA_MIDIA.test(String(g.textoEnviado || g.bruto || '')) ? 'sim' : 'não'}`);
        for (const it of g.midias || []) console.log(`      mídia ${it.codigo} → ${it.status}${it.motivo ? ` (${String(it.motivo).slice(0, 120)})` : ''}`);
        for (const a of g.avisos || []) console.log(`      aviso: ${String(a).replace(/\d{6,}/g, '[núm]').slice(0, 160)}`);
        for (const x of g.erros || []) console.log(`      erro: ${String(x).replace(/\d{6,}/g, '[núm]').slice(0, 160)}`);
      }
    }
    // a imagem de diferença (ARCO/COMPLETO e DIFERENÇAS): como está no cadastro e se a IA enxerga
    const pode = new Set(midias.paraIa(e).map((x) => x.codigo));
    for (const m of midias.midiasDa(e).filter((x) => /arco|diferen/i.test(`${x.nome} ${x.codigo}`))) {
      console.log(`    cadastro ${midias.codigoNumerico(m)} "${String(m.nome).slice(0, 40)}" · ${m.pronta === false ? 'a configurar' : 'pronta'} · descrição ${m.descricao ? `${m.descricao.length} letras` : 'VAZIA'} · uma vez por conversa: ${m.umaVezPorConversa !== false ? 'sim' : 'não'} · a IA enxerga: ${pode.has(m.codigo) ? 'SIM' : 'NÃO'}`);
    }
    const av = midias.avisosDoPrompt(e);
    console.log(`    prompt cita: ${av.citados.map((c) => `${c.codigo}${c.existe ? '' : ' (NÃO EXISTE)'}`).join(' · ') || 'nenhuma mídia'}`);
  }
} catch (err) {
  console.log('    erro no diagnóstico:', err.message);
}
fs.rmSync(pasta, { recursive: true, force: true });
