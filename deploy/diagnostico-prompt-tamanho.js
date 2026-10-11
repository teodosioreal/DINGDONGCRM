// Tamanho das instruções da IA do WhatsApp (só números e sim/não — o repositório é público:
// nunca mostra o texto do prompt nem conversas). Confere o salvo e o que foi para a IA
// nas últimas respostas (registrado no log do painel).
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(process.env.CRM_DB_PATH, 'utf8'));
const sn = (v) => (v ? 'sim' : 'não');
for (const [n, e] of (db.empresas || []).entries()) {
  const bots = (db.bots || []).filter((b) => b.empresaId === e.id && String(b.promptWhatsapp || '').trim());
  for (const [i, b] of bots.entries()) {
    const p = String(b.promptWhatsapp || '').trim();
    const fim = p.slice(-600);
    console.log(`  Empresa ${n + 1} · assistente ${i + 1}: salvo ${p.length} caracteres · seção FOTOS PRONTAS POR CARRO: ${sn(/FOTOS PRONTAS POR CARRO/i.test(p))} · "Carro fora da tabela" no fim: ${sn(/carro fora da tabela/i.test(fim))} · fala de couro: ${sn(/couro/i.test(p))}`);
  }
  const logs = (db.logRespostas || []).filter((l) => l.empresaId === e.id && l.prompt).slice(-3);
  for (const l of logs) {
    console.log(`      resposta ${String(l.em).slice(0, 16)}: salvo ${l.prompt.salvo} · enviado à IA ${l.prompt.enviado} · inteiro: ${sn(l.prompt.inteiro)} · histórico cortado: ${l.prompt.historicoCortado || 0} · fim recebido tem "Carro fora da tabela": ${sn(/carro fora da tabela/i.test(l.prompt.final || ''))}`);
  }
}
