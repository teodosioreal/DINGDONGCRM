// identidade.js — quem é este cliente? Um ÚNICO lugar decide.
//
// O mesmo cliente pode chegar ao CRM por "endereços" diferentes:
//   - o número de verdade: 5521988887777@s.whatsapp.net
//   - o mesmo número SEM o 9 (números antigos): 552188887777@s.whatsapp.net
//   - o id escondido do WhatsApp (LID): 123456789012345@lid
// Antes, cada mensagem procurava a conversa só pelo endereço exato; se a
// resposta chegava por outro, nascia uma conversa nova do mesmo cliente.
// Aqui todos os endereços conhecidos do cliente apontam para UMA conversa, e
// se já existirem duas, elas são juntadas (mensagens, agendamentos, vendas…).

const { estado, salvar } = require('./db');

const ehTelefone = (j) => /@s\.whatsapp\.net$/.test(String(j || ''));
const ehLid = (j) => /@lid$/.test(String(j || ''));
const digitos = (j) => String(j || '').split('@')[0].replace(/\D/g, '');

// Celular do Brasil com e sem o 9 depois do DDD é o mesmo número
function chaveFone(n) {
  let d = digitos(n);
  if (/^55\d{2}9\d{8}$/.test(d)) d = d.slice(0, 4) + d.slice(5);
  return d.length >= 10 ? d : '';
}

// Endereços que a mensagem traz (a Evolution 2.3+ manda o LID e o número juntos)
function enderecos(msg) {
  const k = msg?.key || {};
  const todos = [k.remoteJid, k.remoteJidAlt, k.senderPn, k.senderLid, k.participantAlt, msg?.senderPn, msg?.senderLid].filter(Boolean).map(String);
  return { fone: todos.find(ehTelefone) || null, lid: todos.find(ehLid) || null, bruto: String(k.remoteJid || '') };
}

function mapaDa(empresa) {
  if (!empresa.mapaLid || typeof empresa.mapaLid !== 'object') empresa.mapaLid = {};
  return empresa.mapaLid;
}

// Chave de telefone da conversa (pelo WhatsApp ligado ou pelo telefone que ela tem)
function chaveDaConversa(c) {
  return chaveFone(ehTelefone(c.whatsappJid) ? c.whatsappJid : '') || chaveFone(c.telefone);
}

// Todas as conversas (fora da lixeira) que são deste cliente
function conversasDoCliente(empresa, { fone, lid }) {
  const mapa = mapaDa(empresa);
  const chave = chaveFone(fone || (lid && mapa[lid]) || '');
  const lids = new Set([lid].filter(Boolean));
  if (chave) for (const [l, f] of Object.entries(mapa)) if (chaveFone(f) === chave) lids.add(l);
  return estado.conversas.filter(
    (c) => c.empresaId === empresa.id && ((lids.size && (lids.has(c.whatsappJid) || lids.has(c.lidJid))) || (chave && chaveDaConversa(c) === chave))
  );
}

// A conversa que fica: a com mais mensagens (empate: a mais antiga)
function principalDe(lista) {
  return [...lista].sort((a, b) => (b.mensagens?.length || 0) - (a.mensagens?.length || 0) || String(a.criadoEm).localeCompare(String(b.criadoEm)))[0];
}

function juntarTodas(lista, motivo) {
  if (lista.length < 2) return lista[0] || null;
  const principal = principalDe(lista);
  for (const outra of lista) {
    if (outra === principal || !estado.conversas.includes(outra)) continue;
    require('./lixeira').juntar(principal, outra, { manterEstado: true });
    console.log(`[identidade] conversa duplicada do mesmo cliente juntada (${motivo}): ${outra.id} → ${principal.id}`);
  }
  return principal;
}

// Atualiza os endereços guardados na conversa
function anotar(lead, { fone, lid, bruto }) {
  if (lid) lead.lidJid = lid;
  // o endereço que o WhatsApp está usando agora (número de verdade, se souber)
  if (ehTelefone(bruto)) lead.whatsappJid = bruto;
  else if (fone && (!lead.whatsappJid || ehLid(lead.whatsappJid))) lead.whatsappJid = fone;
  else if (!lead.whatsappJid) lead.whatsappJid = bruto;
  if (fone && !chaveFone(lead.telefone)) lead.telefone = digitos(fone);
}

// Para uma mensagem (recebida ou enviada pelo celular): a conversa do cliente, ou null
function acharCliente(empresa, msg) {
  const e = enderecos(msg);
  const mapa = mapaDa(empresa);
  if (e.fone && e.lid && mapa[e.lid] !== e.fone) {
    mapa[e.lid] = e.fone; // aprendeu: este LID é este número
    salvar();
  }
  const fone = e.fone || (e.lid && mapa[e.lid]) || null;
  const lista = conversasDoCliente(empresa, { fone, lid: e.lid });
  const lead = juntarTodas(lista, 'mensagem nova');
  if (lead) anotar(lead, { ...e, fone });
  return lead;
}

// Só procura (não junta nem altera): a conversa deste endereço (número ou LID)
function conversaDoEndereco(empresa, jid) {
  const lista = conversasDoCliente(empresa, { fone: ehTelefone(jid) ? jid : null, lid: ehLid(jid) ? jid : null });
  return lista.length ? principalDe(lista) : null;
}

// A Evolution 2.3 troca o id escondido pelo número ANTES de avisar o CRM (o LID some
// do aviso). Quando chega um número que o CRM não conhece e ainda existem conversas
// só com LID, pergunta à Evolution como a mensagem foi guardada (com o LID original).
const semLidPorNumero = new Map(); // número → quando perguntou e não achou (não repete por 1 h)
async function aprenderLidDaMensagem(empresa, msg) {
  const e = enderecos(msg);
  if (!e.fone || e.lid || !msg?.key?.id) return null;
  if (conversasDoCliente(empresa, { fone: e.fone }).length) return null; // já conhece este cliente
  const temSoLid = estado.conversas.some((c) => c.empresaId === empresa.id && ehLid(c.whatsappJid));
  if (!temSoLid) return null;
  const ultimo = semLidPorNumero.get(e.fone);
  if (ultimo && Date.now() - ultimo < 3600 * 1000) return null;
  const whatsapp = require('./whatsapp');
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await whatsapp.evolution(empresa, 'POST', '/chat/findMessages/{instancia}', { where: { key: { id: msg.key.id } }, page: 1, offset: 3 }, { tempo: 6000 });
      for (const m of r?.messages?.records || []) {
        const k = m.key || {};
        const lid = [k.remoteJid, k.remoteJidAlt, k.senderLid].find(ehLid);
        const fone = [k.remoteJidAlt, k.remoteJid, k.senderPn].find(ehTelefone) || e.fone;
        if (lid && chaveFone(fone) === chaveFone(e.fone)) {
          mapaDa(empresa)[lid] = e.fone;
          salvar();
          return lid;
        }
      }
      break; // respondeu e não tinha o LID: é cliente novo mesmo
    } catch {
      // a Evolution não respondeu: tenta mais uma vez
      if (tentativa === 0) await new Promise((ok) => setTimeout(ok, 800));
    }
  }
  semLidPorNumero.set(e.fone, Date.now());
  return null;
}

// Endereço para guardar numa conversa nova (número de verdade quando souber)
function jidPreferido(empresa, msg) {
  const e = enderecos(msg);
  return e.fone || (e.lid && mapaDa(empresa)[e.lid]) || e.bruto;
}

// Varredura: junta conversas do mesmo cliente que já estão duplicadas
function repararDuplicadas(empresa) {
  const grupos = new Map();
  const mapa = mapaDa(empresa);
  for (const c of estado.conversas.filter((x) => x.empresaId === empresa.id)) {
    const lid = ehLid(c.whatsappJid) ? c.whatsappJid : c.lidJid;
    const chave = chaveDaConversa(c) || (lid && chaveFone(mapa[lid] || '')) || (lid ? `lid:${lid}` : '');
    if (!chave) continue;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(c);
  }
  let juntadas = 0;
  for (const lista of grupos.values()) {
    if (lista.length < 2) continue;
    juntadas += lista.length - 1;
    const p = juntarTodas(lista, 'revisão');
    const lid = lista.map((c) => (ehLid(c.whatsappJid) ? c.whatsappJid : c.lidJid)).find(Boolean);
    const fone = lista.map((c) => (ehTelefone(c.whatsappJid) ? c.whatsappJid : null)).find(Boolean) || (lid && mapa[lid]);
    if (p) anotar(p, { fone, lid, bruto: fone || p.whatsappJid });
  }
  if (juntadas) salvar();
  return juntadas;
}

module.exports = { aprenderLidDaMensagem, conversaDoEndereco, acharCliente, jidPreferido, repararDuplicadas, conversasDoCliente, chaveFone, enderecos, ehTelefone, ehLid };
