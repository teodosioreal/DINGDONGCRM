// Teste das etiquetas do WhatsApp Business (roda uma vez no deploy, pedido do dono):
// reinicia SÓ a instância de cada empresa do CRM na Evolution (o container e os
// outros sistemas não são tocados) e compara as etiquetas antes e depois.
// Lê o banco do CRM só para pegar endereço/instância/chave; não grava nada nele.
// Nunca mostra chaves nem números completos.
const fs = require('fs');
const path = require('path');

const arquivo = process.env.CRM_DB_PATH || path.join(__dirname, '..', 'data.json');
const db = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const ESPERA_DEPOIS_MS = Number(process.env.SUSTO_ESPERA_MS) || 45000;

async function chamar(e, metodo, caminho, corpo) {
  const c = e.whatsappConfig;
  const base = (c.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const r = await fetch(`${base}${caminho.replace('{i}', encodeURIComponent(c.instancia))}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', apikey: c.apiKey },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  let j = null;
  try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, j };
}

async function contar(e) {
  const l = await chamar(e, 'GET', '/label/findLabels/{i}').catch((err) => ({ status: err.message }));
  const c = await chamar(e, 'POST', '/chat/findChats/{i}', {}).catch((err) => ({ status: err.message }));
  const chats = Array.isArray(c.j) ? c.j : [];
  const comEtiqueta = chats.filter((x) => Array.isArray(x.labels) && x.labels.length).length;
  return `etiquetas=${Array.isArray(l.j) ? l.j.length : `HTTP ${l.status}`} · conversas=${chats.length} · conversas com etiqueta=${comEtiqueta}`;
}

async function estado(e) {
  const r = await chamar(e, 'GET', '/instance/connectionState/{i}').catch(() => null);
  return r?.j?.instance?.state || r?.j?.state || `HTTP ${r?.status}`;
}

(async () => {
  const empresas = (db.empresas || []).filter((e) => e.whatsappConfig?.instancia && e.whatsappConfig?.apiKey);
  if (!empresas.length) return console.log('    nenhuma empresa com WhatsApp');
  for (const [n, e] of empresas.entries()) {
    console.log(`    Empresa ${n + 1} (${e.whatsappConfig.instancia}):`);
    const w = await chamar(e, 'GET', '/webhook/find/{i}').catch(() => null);
    const wh = w?.j?.webhook || w?.j || {};
    const eventos = (wh.events || []).map(String);
    console.log(`      webhook: ligado=${wh.enabled !== false} · do CRM=${String(wh.url || '').includes('/api/public/whatsapp/')} · eventos de etiqueta=${['LABELS_EDIT', 'LABELS_ASSOCIATION'].filter((x) => eventos.includes(x)).join('+') || 'NENHUM'}`);
    console.log(`      antes: conexão=${await estado(e)} · ${await contar(e)}`);
    let r = await chamar(e, 'POST', '/instance/restart/{i}').catch((err) => ({ status: err.message }));
    if (r.status === 404 || r.status === 405) r = await chamar(e, 'PUT', '/instance/restart/{i}').catch((err) => ({ status: err.message }));
    console.log(`      reiniciar a instância: HTTP ${r.status}`);
    let st = '';
    for (let i = 0; i < 20; i++) {
      await espera(3000);
      st = await estado(e);
      if (st === 'open' && i > 1) break;
    }
    console.log(`      conexão depois: ${st}`);
    await espera(ESPERA_DEPOIS_MS);
    console.log(`      depois (${Math.round(ESPERA_DEPOIS_MS / 1000)} s): ${await contar(e)}`);
  }
})().catch((err) => console.log('    erro:', err.message));
