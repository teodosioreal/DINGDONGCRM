// sincronizar.js — nenhuma mensagem do WhatsApp fica de fora do painel.
//
// O webhook entrega as mensagens na hora, mas pode perder algumas: o número
// ficou desconectado, a instância foi reconectada, o CRM estava reiniciando
// (deploy), o webhook ficou com endereço antigo… A Evolution guarda as mensagens
// no banco dela, então o CRM busca o que falta e completa as conversas:
//   - quando o WhatsApp conecta de novo (e ao conectar pelo painel): últimos 7 dias;
//   - ao ligar o CRM e a cada 20 minutos: desde a última busca (até 2 dias);
//   - no botão "Buscar mensagens do WhatsApp": 1, 7 ou 30 dias;
//   - o histórico que o WhatsApp manda ao reconectar (MESSAGES_SET) também entra.
// Mensagens importadas NÃO fazem a IA responder nem disparam automações: só
// aparecem na conversa, na ordem certa, sem duplicar.

const { estado, salvar, agora } = require('./db');

const MAX_CONVERSAS = 400;
const MAX_PAGINAS = 10; // 10 × 50 mensagens por conversa
const A_CADA_MS = Number(process.env.SINCRONIA_MS) || 20 * 60 * 1000;
const rodando = new Set(); // empresaId

const whatsapp = () => require('./whatsapp');
const leads = () => require('./leads');

const jidValido = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));
const normalizar = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const segundos = (ts) => {
  const n = Number(ts?.low ?? ts);
  return Number.isFinite(n) && n > 0 ? (n > 1e12 ? Math.floor(n / 1000) : n) : 0;
};

// ---------------------------------------------------------------- número escondido (LID)
// O WhatsApp passou a esconder o número de muitos contatos atrás de um id interno
// ("…@lid"). Ao vivo a Evolution já troca pelo número, mas no histórico dela fica
// o id interno — que NÃO é telefone. Aqui sempre usamos o número de verdade.
const ehTelefone = (j) => /@s\.whatsapp\.net$/.test(String(j || ''));

function numeroDoLid(key = {}, msg = {}) {
  return [key.remoteJidAlt, key.senderPn, key.participantAlt, msg.senderPn].find(ehTelefone) || null;
}

// Uma conversa que ficou com o id interno passa a usar o número de verdade
// (se o cliente já tem outra conversa, as duas viram uma só)
function consertarLid(empresa, lidJid, telefoneJid) {
  if (!lidJid || !ehTelefone(telefoneJid)) return null;
  const doLid = estado.conversas.find((c) => c.empresaId === empresa.id && c.whatsappJid === lidJid);
  const doNumero = estado.conversas.find((c) => c.empresaId === empresa.id && c.whatsappJid === telefoneJid);
  if (doNumero) doNumero.lidJid = lidJid;
  if (!doLid) return doNumero || null;
  if (doNumero) {
    require('./lixeira').juntar(doNumero, doLid, { manterEstado: true });
    return doNumero;
  }
  doLid.whatsappJid = telefoneJid;
  doLid.telefone = telefoneJid.split('@')[0];
  doLid.lidJid = lidJid;
  require('./localizacao').garantir(doLid); // tira a "cidade" que vinha do id interno
  delete doLid.fotoPerfil; // busca a foto de novo, agora pelo número
  require('./fotos-clientes').agendar(doLid);
  return doLid;
}

// Pergunta à Evolution o número de verdade por trás de um id escondido. Tenta, nesta
// ordem: (1) o cache de números da Evolution (/chat/whatsappNumbers), (2) os campos
// das mensagens guardadas dela, (3) os contatos dela. Devolve "55…@s.whatsapp.net" ou null.
async function descobrirNumeroDoLid(empresa, lidJid) {
  const w = whatsapp();
  const r1 = await w.evolucao(empresa, 'POST', '/chat/whatsappNumbers/{instancia}', { numbers: [lidJid] }).catch(() => null);
  for (const x of Array.isArray(r1) ? r1 : []) {
    if (ehTelefone(x?.jid)) return x.jid;
    if (ehTelefone(x?.remoteJidAlt)) return x.remoteJidAlt;
  }
  const r2 = await w.evolucao(empresa, 'POST', '/chat/findMessages/{instancia}', { where: { key: { remoteJid: lidJid } }, page: 1, offset: 50 }).catch(() => null);
  for (const m of r2?.messages?.records || []) {
    const alt = numeroDoLid(m.key || {}, m);
    if (alt) return alt;
  }
  const r3 = await w.evolucao(empresa, 'POST', '/chat/findContacts/{instancia}', { where: { remoteJid: lidJid } }).catch(() => null);
  for (const c of Array.isArray(r3) ? r3 : []) {
    const alt = [c?.remoteJidAlt, c?.phoneNumber && `${String(c.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`, c?.jid].find(ehTelefone);
    if (alt) return alt;
  }
  return null;
}

// Conversas que estão só com o id escondido: tenta achar o número (no máximo a cada 6 h por conversa)
async function resolverLids(empresa, { forcar = false } = {}) {
  let n = 0;
  for (const c of estado.conversas.filter((x) => x.empresaId === empresa.id && /@lid$/.test(x.whatsappJid || ''))) {
    if (!forcar && c.lidTentativaEm && Date.now() - new Date(c.lidTentativaEm).getTime() < 6 * 3600 * 1000) continue;
    c.lidTentativaEm = agora();
    const lid = c.whatsappJid;
    const tel = await descobrirNumeroDoLid(empresa, lid).catch(() => null);
    if (tel && consertarLid(empresa, lid, tel)) n++;
  }
  if (n) salvar();
  return n;
}

// Para onde vai esta mensagem: o jid com o número de verdade (ou null se não der para saber)
function jidReal(empresa, msg) {
  const rj = msg?.key?.remoteJid || '';
  if (ehTelefone(rj)) return rj;
  if (!/@lid$/.test(rj)) return null;
  const alt = numeroDoLid(msg.key, msg);
  if (alt) {
    consertarLid(empresa, rj, alt);
    return alt;
  }
  // sem o número na mensagem: só entra se já conhecemos esse contato
  const conhecido = estado.conversas.find((c) => c.empresaId === empresa.id && (c.lidJid === rj || c.whatsappJid === rj));
  return conhecido ? conhecido.whatsappJid : null;
}

// Conversas antigas que ficaram com o id interno e já têm o telefone: corrige na hora
function consertarConversasComLid(empresa) {
  let n = 0;
  for (const c of estado.conversas.filter((x) => x.empresaId === empresa.id && /@lid$/.test(x.whatsappJid || ''))) {
    const tel = String(c.telefone || '').replace(/\D/g, '');
    if (tel.length >= 12 && consertarLid(empresa, c.whatsappJid, `${tel}@s.whatsapp.net`)) n++;
  }
  if (n) salvar();
  return n;
}

// Já temos esta mensagem? (pelo id do WhatsApp; nas antigas, sem id, pelo texto e horário)
function jaTem(lead, wid, papelSaida, texto, emMs) {
  for (const m of lead.mensagens || []) {
    if (m.wid === wid || m.wids?.includes(wid)) return m;
  }
  const alvo = normalizar(texto);
  if (!alvo) return null;
  return (
    (lead.mensagens || []).find(
      (m) =>
        !m.wid &&
        (m.papel !== 'visitante') === papelSaida &&
        Math.abs(new Date(m.em).getTime() - emMs) < 10 * 60 * 1000 &&
        (normalizar(m.texto) === alvo || normalizar(m.texto).includes(alvo) || alvo.includes(normalizar(m.texto)))
    ) || null
  );
}

// Coloca UMA mensagem do histórico na conversa certa (cria o lead se precisar).
// Devolve true se entrou algo novo.
function importarMensagem(empresa, msg) {
  const wid = msg?.key?.id;
  if (!wid || !jidValido(msg?.key?.remoteJid)) return false;
  const jid = jidReal(empresa, msg);
  if (!jid) return false; // número escondido que ainda não sabemos de quem é: não inventa conversa
  const texto = whatsapp().textoDa(msg);
  if (!texto) return false; // reação, aviso do sistema, mensagem apagada…
  const ts = segundos(msg.messageTimestamp);
  if (!ts) return false;
  const emMs = ts * 1000;
  const saida = Boolean(msg.key.fromMe);

  const identidade = require('./identidade');
  let lead = identidade.acharCliente(empresa, { ...msg, key: { ...msg.key, ...(msg.key.remoteJid !== jid ? { remoteJidAlt: msg.key.remoteJidAlt || jid } : {}) } });
  if (!lead) {
    // na lixeira? fica lá (a pessoa apagou de propósito)
    const ch = identidade.chaveFone(jid);
    if ((estado.lixeira || []).some((c) => c.empresaId === empresa.id && (c.whatsappJid === jid || c.lidJid === jid || (ch && identidade.chaveFone(c.whatsappJid) === ch)))) return false;
    const comNumero = { ...msg, key: { ...msg.key, remoteJid: jid }, ...(saida ? { pushName: '' } : {}) };
    lead = whatsapp().acharOuCriarLead(empresa, jid, saida ? '' : texto, comNumero);
    if (!lead.mensagens.length) {
      lead.historicoImportado = true; // não entra em automação até o cliente escrever de novo
      lead.criadoEm = new Date(emMs).toISOString();
    }
    require('./localizacao').garantir(lead);
  }
  const existente = jaTem(lead, wid, saida, texto, emMs);
  if (existente) {
    if (!existente.wid && !existente.wids) existente.wid = wid; // da próxima vez acha pelo id
    return false;
  }
  const nova = {
    id: require('./db').novoId('msg'),
    em: new Date(emMs).toISOString(),
    papel: saida ? 'equipe' : 'visitante',
    canal: 'whatsapp',
    texto,
    wid,
    importada: true
  };
  lead.mensagens.push(nova);
  // foto/PDF do cliente dos últimos 3 dias: baixa e lê o comprovante (como ao vivo)
  const conteudo = msg.message || {};
  if (!saida && Date.now() - emMs < 3 * 86400000 && (conteudo.imageMessage || conteudo.documentMessage || conteudo.documentWithCaptionMessage)) {
    whatsapp().anexoAtrasado(empresa, lead, msg, nova);
  }
  if (!saida) require('./localizacao').lerMensagem(lead, texto);
  require('./fotos-clientes').agendar(lead); // foto de perfil (se ainda não tem)
  lead.mensagens.sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : 0));
  if (lead.mensagens.length > 400) lead.mensagens.splice(0, lead.mensagens.length - 400);
  const ultimaEm = lead.mensagens[lead.mensagens.length - 1].em;
  if (lead.historicoImportado || !lead.atualizadoEm || ultimaEm > lead.atualizadoEm) lead.atualizadoEm = ultimaEm;
  // mensagem do cliente das últimas 24h que ninguém viu: conta como não lida
  if (!saida && Date.now() - emMs < 24 * 3600 * 1000) lead.naoLidas = (lead.naoLidas || 0) + 1;
  if (lead.arquivado && !saida && lead.arquivadoPor === 'apagada no WhatsApp' && Date.now() - emMs < 24 * 3600 * 1000) lead.arquivado = false;
  return true;
}

// Histórico que a Evolution manda pelo webhook ao reconectar (MESSAGES_SET)
function importarLote(empresa, mensagens, { dias = 30 } = {}) {
  const limite = Date.now() / 1000 - dias * 86400;
  let novas = 0;
  for (const m of mensagens || []) {
    if (segundos(m?.messageTimestamp) < limite) continue;
    if (importarMensagem(empresa, m)) novas++;
  }
  if (novas) salvar();
  return novas;
}

async function listarChats(empresa, desdeSeg) {
  const r = await whatsapp().evolucao(empresa, 'POST', '/chat/findChats/{instancia}', { where: {} });
  const lista = Array.isArray(r) ? r : r?.chats || [];
  return lista
    .filter((c) => jidValido(c.remoteJid))
    .map((c) => ({ jid: c.remoteJid, ultima: segundos(c.lastMessage?.messageTimestamp) || (c.updatedAt ? Math.floor(new Date(c.updatedAt).getTime() / 1000) : 0) }))
    .filter((c) => !c.ultima || c.ultima >= desdeSeg)
    .sort((a, b) => b.ultima - a.ultima)
    .slice(0, MAX_CONVERSAS);
}

async function mensagensDesde(empresa, jid, desdeSeg) {
  const todas = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const where = { key: { remoteJid: jid }, messageTimestamp: { gte: new Date(desdeSeg * 1000).toISOString(), lte: new Date(Date.now() + 60000).toISOString() } };
    const r = await whatsapp().evolucao(empresa, 'POST', '/chat/findMessages/{instancia}', { where, page: pagina, offset: 50 });
    const registros = r?.messages?.records || (Array.isArray(r) ? r : []);
    todas.push(...registros);
    const paginas = Number(r?.messages?.pages) || 0;
    if (registros.length < 50 || (paginas && pagina >= paginas)) break;
  }
  return todas.filter((m) => segundos(m.messageTimestamp) >= desdeSeg);
}

// Busca na Evolution tudo desde `dias` atrás (ou desde a última busca) e completa as conversas
async function sincronizarEmpresa(empresa, { dias = null, motivo = 'auto' } = {}) {
  const w = whatsapp();
  if (!w.configurado(empresa) || empresa.ativa === false) return null;
  if (rodando.has(empresa.id)) return { emAndamento: true };
  rodando.add(empresa.id);
  const cfg = empresa.whatsappConfig;
  const anterior = cfg.sincronia || {};
  // automático: desde a última busca (com 15 min de folga), no máximo 2 dias
  const desdeSeg = Math.floor(
    dias
      ? Date.now() / 1000 - dias * 86400
      : Math.max(Date.now() / 1000 - 2 * 86400, anterior.em ? new Date(anterior.em).getTime() / 1000 - 15 * 60 : Date.now() / 1000 - 2 * 86400)
  );
  const resumo = { em: agora(), motivo, desde: new Date(desdeSeg * 1000).toISOString(), conversas: 0, importadas: 0, erro: '' };
  try {
    await w.revisarWebhook(empresa).catch(() => null); // aproveita e conserta o webhook se precisar
    resumo.corrigidas = consertarConversasComLid(empresa) + (await resolverLids(empresa, { forcar: motivo === 'botão' }).catch(() => 0));
    const chats = await listarChats(empresa, desdeSeg);
    // conversas que ainda estão com o id interno: lê o histórico delas para achar o número
    for (const c of estado.conversas.filter((x) => x.empresaId === empresa.id && /@lid$/.test(x.whatsappJid || ''))) {
      const ch = chats.find((x) => x.jid === c.whatsappJid);
      if (ch) ch.desde = Math.floor(Date.now() / 1000 - 30 * 86400);
      else chats.push({ jid: c.whatsappJid, ultima: 0, desde: Math.floor(Date.now() / 1000 - 30 * 86400) });
    }
    for (const chat of chats) {
      const msgs = await mensagensDesde(empresa, chat.jid, Math.min(desdeSeg, chat.desde || desdeSeg)).catch(() => []);
      let novas = 0;
      for (const m of msgs.sort((a, b) => segundos(a.messageTimestamp) - segundos(b.messageTimestamp))) if (importarMensagem(empresa, m)) novas++;
      if (novas) {
        resumo.conversas++;
        resumo.importadas += novas;
        salvar();
      }
    }
  } catch (err) {
    resumo.erro = String(err.message || err).slice(0, 200);
    console.error(`[sincronizar ${empresa.id}]`, resumo.erro);
  } finally {
    rodando.delete(empresa.id);
  }
  cfg.sincronia = resumo;
  salvar();
  if (resumo.importadas) console.log(`[sincronizar ${empresa.id}] ${resumo.importadas} mensagem(ns) recuperada(s) em ${resumo.conversas} conversa(s) (${motivo})`);
  return resumo;
}

// WhatsApp voltou a conectar: busca a última semana. Vários avisos seguidos
// (conectar + "open" + oscilação) viram uma busca só, um pouco depois do último.
const pendentes = new Map(); // empresaId → timer
function aoReconectar(empresa) {
  clearTimeout(pendentes.get(empresa.id));
  // espera a Evolution terminar de receber o histórico do celular
  const t = setTimeout(() => {
    pendentes.delete(empresa.id);
    const repetir = () =>
      sincronizarEmpresa(empresa, { dias: 7, motivo: 'reconectou' })
        .then((r) => {
          if (r?.emAndamento) setTimeout(repetir, 30 * 1000).unref?.(); // outra busca rodando: tenta logo depois
        })
        .catch(() => {});
    repetir();
  }, Number(process.env.SINCRONIA_ESPERA_MS) || 45 * 1000);
  t.unref?.();
  pendentes.set(empresa.id, t);
}

let timer = null;
function iniciar() {
  if (timer || process.env.SINCRONIA === 'nao') return;
  const rodada = async () => {
    for (const e of estado.empresas) await sincronizarEmpresa(e, { motivo: 'automática' }).catch(() => {});
  };
  setTimeout(rodada, 60 * 1000).unref?.(); // ao ligar (pega o que chegou durante o deploy)
  timer = setInterval(rodada, A_CADA_MS);
  timer.unref?.();
}

module.exports = { descobrirNumeroDoLid, resolverLids, consertarConversasComLid, consertarLid, jidReal, sincronizarEmpresa, importarMensagem, importarLote, aoReconectar, iniciar };
