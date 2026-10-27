// Instâncias na nossa Evolution API (anônimo: sem chaves e sem números). Para cada instância:
// estado da conexão, último motivo de desconexão e qual empresa do CRM usa.
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : {};
const url = String(db.config?.evolutionUrl || process.env.EVOLUTION_API_URL || 'https://api.evolutiondingdong.online').replace(/\/+$/, '');
const chave = String(db.config?.evolutionApiKey || process.env.EVOLUTION_API_KEY || '').trim();
const hora = (v) => (v ? new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
const semNumero = (s) => String(s ?? '').replace(/\d{6,}/g, '[núm]');

(async () => {
  console.log(`      servidor: ${url} · chave global ${chave ? 'sim' : 'NÃO'}`);
  if (!chave) return;
  let lista;
  try {
    const r = await fetch(`${url}/instance/fetchInstances`, { headers: { apikey: chave }, signal: AbortSignal.timeout(15000) });
    console.log(`      fetchInstances: HTTP ${r.status}`);
    lista = await r.json();
  } catch (err) {
    console.log(`      não respondeu: ${semNumero(err.message)}`);
    return;
  }
  const itens = Array.isArray(lista) ? lista : [];
  const empresas = db.empresas || [];
  console.log(`      instâncias: ${itens.length}`);
  for (const bruto of itens) {
    const i = bruto.instance || bruto;
    const nome = i.name || i.instanceName || '';
    const idx = empresas.findIndex((e) => e.whatsappConfig?.instancia && [nome, i.id, i.instanceId].includes(e.whatsappConfig.instancia));
    const daNome = empresas.findIndex((e) => nome.endsWith(String(e.id || '').slice(-6)));
    const uso = idx >= 0 ? `usada pela empresa ${idx + 1}${/lead/i.test(empresas[idx].nome || '') ? ' (LEADS)' : ''}` : daNome >= 0 ? `criada para a empresa ${daNome + 1}${/lead/i.test(empresas[daNome].nome || '') ? ' (LEADS)' : ''}, mas a empresa NÃO está ligada a ela` : 'nenhuma empresa do CRM';
    const c = i._count || {};
    console.log(`        ${semNumero(nome)}: ${i.connectionStatus || i.status || i.state || '?'} · ${uso} · número ${i.ownerJid || i.owner || i.number ? 'sim' : 'não'} · desconectou ${hora(i.disconnectionAt)}${i.disconnectionReasonCode ? ` (código ${i.disconnectionReasonCode})` : ''}${i.disconnectionObject ? ` ${semNumero(String(typeof i.disconnectionObject === 'string' ? i.disconnectionObject : JSON.stringify(i.disconnectionObject))).slice(0, 120)}` : ''} · atualizada ${hora(i.updatedAt)} · mensagens ${c.Message ?? '-'} · contatos ${c.Contact ?? '-'}`);
  }
  // empresas que dizem ter instância mas ela não existe mais na Evolution
  for (const [n, e] of empresas.entries()) {
    const inst = e.whatsappConfig?.instancia;
    if (inst && !itens.some((b) => [(b.instance || b).name, (b.instance || b).instanceName, (b.instance || b).id].includes(inst))) console.log(`        empresa ${n + 1}: aponta para uma instância que NÃO existe na Evolution`);
    if (!inst && /lead/i.test(e.nome || '')) console.log(`        empresa ${n + 1} (LEADS): sem instância no CRM (desconectada)`);
  }
})();
