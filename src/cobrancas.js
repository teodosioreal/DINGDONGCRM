// cobrancas.js — 💰 Disparo de cobrança (aba Disparos): clientes com mensalidade recebem a
// cobrança pelo WhatsApp todo mês, no vencimento (ou alguns dias antes), com a chave Pix e/ou
// o link de pagamento. Sem IA: sai o texto que a empresa configurou.
//
// Guardado em empresa.cobrancas = { config, clientes: [...] }. Cada cliente guarda, por mês
// ("2026-11"), quando a cobrança saiu (envios) e se foi paga (pagos). A mensagem também entra
// na conversa do cliente (cria a conversa se ainda não existe), marcada com cobrancaId.

const { estado, salvar, novoId, agora } = require('./db');
const { texto, numeroWhatsapp } = require('./util');

const PADRAO = {
  mensagem: '{Olá|Oi} {nome}! 😊 Passando para lembrar da mensalidade{descricao} no valor de *{valor}*, com vencimento em *{vencimento}*.\n\n{pagamento}\n\nQualquer dúvida é só chamar!',
  pix: '',
  pixNome: '',
  link: '',
  pixSeparado: true, // a chave Pix vai numa mensagem só dela (fica fácil de copiar no celular)
  diasAntes: 0, // 0 = no dia do vencimento
  hora: 9, // a partir de que hora envia (horário de Brasília)
  iaResponde: false // quando o cliente responder a cobrança, a IA responde? (padrão: não — a equipe atende)
};
const TOLERANCIA_DIAS = 3; // CRM fora do ar no dia: ainda manda até 3 dias depois do vencimento

const erro = (mensagem, status = 400) => Object.assign(new Error(mensagem), { status });

// ---------------------------------------------------------------- datas (horário de Brasília)

const hojeSp = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // 2026-11-10
const horaSp = (ms = Date.now()) => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24;
const competenciaDe = (dia) => dia.slice(0, 7); // 2026-11
function vencimentoNo(comp, diaVenc) {
  const [a, m] = comp.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate(); // dia 31 em mês de 30 → dia 30
  return `${comp}-${String(Math.min(diaVenc, ultimo)).padStart(2, '0')}`;
}
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const diaBr = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------------------------------------------------------- dados

function dadosDa(empresa) {
  if (!empresa.cobrancas || typeof empresa.cobrancas !== 'object') empresa.cobrancas = {};
  if (!Array.isArray(empresa.cobrancas.clientes)) empresa.cobrancas.clientes = [];
  return empresa.cobrancas;
}

function configDa(empresa) {
  const c = dadosDa(empresa).config || {};
  const n = (v, def, min, max) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(max, Math.max(min, Math.round(Number(v)))) : def);
  return {
    mensagem: String(c.mensagem || '').trim() || PADRAO.mensagem,
    pix: String(c.pix || ''),
    pixNome: String(c.pixNome || ''),
    link: String(c.link || ''),
    pixSeparado: c.pixSeparado !== false,
    diasAntes: n(c.diasAntes, PADRAO.diasAntes, 0, 15),
    hora: n(c.hora, PADRAO.hora, 6, 21),
    iaResponde: c.iaResponde === true
  };
}

function salvarConfig(empresa, b = {}) {
  const d = dadosDa(empresa);
  d.config = {
    mensagem: texto(b.mensagem, 2000),
    pix: texto(b.pix, 140),
    pixNome: texto(b.pixNome, 80),
    link: texto(b.link, 500),
    pixSeparado: b.pixSeparado !== false,
    diasAntes: b.diasAntes,
    hora: b.hora,
    iaResponde: b.iaResponde === true
  };
  d.config = { ...configDa(empresa), mensagem: d.config.mensagem }; // normaliza (mensagem vazia = a padrão)
  salvar();
  return configDa(empresa);
}

// "150", "150,00", "1.250,00", "99.90" ou número → 150 / 1250 / 99.9
function lerValor(v) {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let t = String(v ?? '').replace(/[^\d,.]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(t)) t = t.replace(/\./g, ''); // "1.250" = mil duzentos e cinquenta
  return Math.round(Number(t) * 100) / 100;
}

function lerCliente(b = {}, atual = {}) {
  const nome = texto(b.nome ?? atual.nome, 120);
  const telefone = numeroWhatsapp(b.telefone ?? atual.telefone);
  const valor = lerValor(b.valor ?? atual.valor);
  const diaVencimento = Math.round(Number(b.diaVencimento ?? atual.diaVencimento));
  if (!nome) throw erro('Coloque o nome do cliente.');
  if (telefone.length < 12) throw erro('WhatsApp inválido: coloque com DDD (ex.: 24 99999-9999).');
  if (!(valor > 0)) throw erro('Coloque o valor da mensalidade.');
  if (!(diaVencimento >= 1 && diaVencimento <= 31)) throw erro('Dia do vencimento: de 1 a 31.');
  return {
    nome,
    telefone,
    valor,
    diaVencimento,
    descricao: texto(b.descricao ?? atual.descricao, 120),
    link: texto(b.link ?? atual.link, 500), // link de pagamento só deste cliente (opcional)
    ativo: b.ativo === undefined ? atual.ativo !== false : b.ativo !== false
  };
}

function adicionarCliente(empresa, b) {
  const d = dadosDa(empresa);
  const c = { id: novoId('cob'), ...lerCliente(b), criadoEm: agora(), envios: {}, pagos: {} };
  if (d.clientes.some((x) => x.telefone === c.telefone)) throw erro('Esse WhatsApp já está na lista de cobrança.');
  d.clientes.push(c);
  salvar();
  return c;
}

function acharCliente(empresa, cid) {
  const c = dadosDa(empresa).clientes.find((x) => x.id === cid);
  if (!c) throw erro('Cliente de cobrança não encontrado.', 404);
  return c;
}

function editarCliente(empresa, cid, b) {
  const c = acharCliente(empresa, cid);
  const novo = lerCliente(b, c);
  if (dadosDa(empresa).clientes.some((x) => x.id !== cid && x.telefone === novo.telefone)) throw erro('Esse WhatsApp já está na lista de cobrança.');
  Object.assign(c, novo);
  salvar();
  return c;
}

function removerCliente(empresa, cid) {
  acharCliente(empresa, cid);
  dadosDa(empresa).clientes = dadosDa(empresa).clientes.filter((x) => x.id !== cid);
  salvar();
}

// pago / não pago no mês (padrão: o mês do próximo vencimento que importa agora)
function marcarPago(empresa, cid, pago, comp) {
  const c = acharCliente(empresa, cid);
  const k = /^\d{4}-\d{2}$/.test(comp || '') ? comp : situacao(empresa, c).competencia;
  c.pagos = c.pagos || {};
  if (pago) c.pagos[k] = agora();
  else delete c.pagos[k];
  salvar();
  return c;
}

// ---------------------------------------------------------------- mensagem

function sortear(t) {
  return String(t).replace(/\{([^{}]*\|[^{}]*)\}/g, (_, ops) => { const l = ops.split('|'); return l[Math.floor(Math.random() * l.length)]; });
}

// partes: [mensagem principal, chave Pix sozinha (opcional)]
function montar(empresa, c, comp) {
  const cfg = configDa(empresa);
  const venc = vencimentoNo(comp, c.diaVencimento);
  const link = c.link || cfg.link;
  const pix = cfg.pix.trim();
  const linhas = [];
  if (link) linhas.push(`Para pagar pelo link: ${link}`);
  if (pix) linhas.push(cfg.pixSeparado ? `Pix${cfg.pixNome ? ` (${cfg.pixNome})` : ''}: a chave vai na mensagem abaixo 👇` : `Chave Pix${cfg.pixNome ? ` (${cfg.pixNome})` : ''}: ${pix}`);
  const valores = {
    nome: String(c.nome || '').trim().split(/\s+/)[0] || '',
    nome_completo: c.nome || '',
    valor: brl(c.valor),
    vencimento: diaBr(venc),
    descricao: c.descricao ? ` de ${c.descricao}` : '',
    servico: c.descricao || '',
    pix,
    link: link || '',
    pagamento: linhas.join('\n'),
    empresa: empresa.nome || ''
  };
  let msg = sortear(cfg.mensagem).replace(/\{(\w+)\}/g, (m, k) => (k in valores ? valores[k] : m));
  // a mensagem não tinha {pagamento}/{pix}/{link}: o pagamento vai no fim, para não sair cobrança sem como pagar
  if (!/\{(pagamento|pix|link)\}/.test(cfg.mensagem) && valores.pagamento) msg += `\n\n${valores.pagamento}`;
  msg = msg.replace(/\n{3,}/g, '\n\n').trim();
  return [msg, ...(pix && cfg.pixSeparado ? [pix] : [])];
}

// ---------------------------------------------------------------- situação de cada cliente

const proximoMes = (comp) => { const [a, m] = comp.split('-').map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`; };

// o mês que importa agora: o deste mês; passa para o próximo quando este foi pago, quando
// venceu sem ter sido cobrado (cliente novo) ou quando já é dia de cobrar o próximo
function situacao(empresa, c, ms = Date.now()) {
  const cfg = configDa(empresa);
  const hoje = hojeSp(ms);
  let comp = competenciaDe(hoje);
  const prox = proximoMes(comp);
  const vencAqui = vencimentoNo(comp, c.diaVencimento);
  const passou = hoje > somarDias(vencAqui, TOLERANCIA_DIAS);
  if ((c.pagos || {})[comp] || (passou && !(c.envios || {})[comp]) || hoje >= somarDias(vencimentoNo(prox, c.diaVencimento), -cfg.diasAntes)) comp = prox;
  const venc = vencimentoNo(comp, c.diaVencimento);
  return { competencia: comp, vencimento: venc, diaEnvio: somarDias(venc, -cfg.diasAntes), enviado: (c.envios || {})[comp] || null, pago: (c.pagos || {})[comp] || null, atrasado: !(c.pagos || {})[comp] && hoje > venc,
    // meses anteriores cobrados e ainda não marcados como pagos
    emAberto: Object.keys(c.envios || {}).filter((k) => k < comp && !(c.pagos || {})[k]).sort() };
}

// deve enviar agora? (ativo, no dia/hora, ainda não enviou nem foi pago, e o cliente já existia no dia)
function deveEnviar(empresa, c, ms = Date.now()) {
  if (c.ativo === false) return null;
  const cfg = configDa(empresa);
  const hoje = hojeSp(ms);
  const comp = competenciaDe(hoje);
  // o mês atual e (perto da virada) o seguinte, para quem cobra dias antes do vencimento
  for (const k of [comp, proximoMes(comp)]) {
    if ((c.envios || {})[k] || (c.pagos || {})[k]) continue;
    const venc = vencimentoNo(k, c.diaVencimento);
    const diaEnvio = somarDias(venc, -cfg.diasAntes);
    if (hoje < diaEnvio || hoje > somarDias(venc, TOLERANCIA_DIAS)) continue;
    if (hoje === diaEnvio && horaSp(ms) < cfg.hora) continue;
    if (hojeSp(Date.parse(c.criadoEm)) > diaEnvio) continue; // cadastrado depois do dia de cobrar: começa no mês seguinte
    return k;
  }
  return null;
}

// ---------------------------------------------------------------- envio

function chaves(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  const k = [d];
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') k.push(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12) k.push(`${d.slice(0, 4)}9${d.slice(4)}`);
  return k.filter(Boolean);
}

// a conversa do cliente (cria se ainda não existe)
function conversaDo(empresa, c) {
  const alvo = new Set(chaves(c.telefone));
  const achada = estado.conversas.find((l) => l.empresaId === empresa.id && [l.whatsappJid ? l.whatsappJid.split('@')[0] : '', l.telefone].some((n) => chaves(n).some((k) => alvo.has(k))));
  if (achada) return achada;
  const bot = estado.bots.find((b) => b.empresaId === empresa.id && b.principal) || estado.bots.find((b) => b.empresaId === empresa.id);
  return require('./leads').criarLead({ empresa, bot, canal: 'manual', nome: c.nome, telefone: c.telefone });
}

async function enviar(empresa, c, comp, { manual = false } = {}) {
  const whatsapp = require('./whatsapp');
  const leads = require('./leads');
  if (!whatsapp.configurado(empresa)) throw erro('Conecte o WhatsApp da empresa antes de cobrar.');
  const cfg = configDa(empresa);
  const lead = conversaDo(empresa, c);
  const destino = whatsapp.destinoDoLead(lead) || numeroWhatsapp(c.telefone);
  const partes = montar(empresa, c, comp);
  c.envios = c.envios || {};
  try {
    for (const [i, t] of partes.entries()) {
      const r = await whatsapp.enviarTexto(empresa, destino, t);
      const jid = r?.key?.remoteJid;
      if (!lead.whatsappJid && /@s\.whatsapp\.net$/.test(jid || '')) lead.whatsappJid = jid;
      leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: t, cobrancaId: c.id, cobrancaMes: comp });
      if (i < partes.length - 1) await new Promise((ok) => setTimeout(ok, 1500));
    }
    c.envios[comp] = { em: agora(), status: 'enviado', manual };
    delete c.ultimoErro;
    if (!cfg.iaResponde && !lead.iaPausada) {
      lead.iaPausada = true;
      lead.iaPausadaMotivo = 'Cliente de cobrança: a equipe atende (Disparos → Cobrança)';
    }
    salvar();
    return c.envios[comp];
  } catch (err) {
    c.ultimoErro = { em: agora(), competencia: comp, motivo: String(err.message || err).slice(0, 200) };
    salvar();
    throw err;
  }
}

// "Enviar agora": manda a cobrança do mês que importa agora, mesmo fora do dia
async function enviarAgora(empresa, cid) {
  const c = acharCliente(empresa, cid);
  return enviar(empresa, c, situacao(empresa, c).competencia, { manual: true });
}

// ---------------------------------------------------------------- de tempos em tempos

let rodando = false;
async function verificar(ms = Date.now()) {
  if (rodando) return 0;
  rodando = true;
  let n = 0;
  try {
    const whatsapp = require('./whatsapp');
    for (const empresa of estado.empresas) {
      if (empresa.ativa === false || !empresa.cobrancas?.clientes?.length || !whatsapp.configurado(empresa)) continue;
      for (const c of empresa.cobrancas.clientes) {
        const comp = deveEnviar(empresa, c, ms);
        if (!comp) continue;
        // falhou há pouco: tenta de novo só depois de 1 h
        if (c.ultimoErro?.competencia === comp && Date.now() - Date.parse(c.ultimoErro.em) < 3600e3) continue;
        try {
          if (n) await new Promise((ok) => setTimeout(ok, 8000 + Math.random() * 7000)); // espaçado entre um cliente e outro
          await enviar(empresa, c, comp);
          n++;
        } catch (err) {
          console.error(`[cobranca ${empresa.id}] não enviou:`, err.message);
          require('./alertas').registrar(empresa, 'whatsapp-envio', `A cobrança de ${c.nome} não saiu: ${String(err.message).slice(0, 160)}. O CRM tenta de novo em 1 h.`, { nivel: 'aviso' });
        }
      }
    }
  } catch (err) {
    console.error('[cobranca]', err.message);
  } finally {
    rodando = false;
  }
  if (n) console.log(`[cobranca] ${n} cobrança(s) enviada(s)`);
  return n;
}

function iniciar() {
  setTimeout(() => verificar().catch(() => {}), 60 * 1000).unref?.();
  setInterval(() => verificar().catch(() => {}), 10 * 60 * 1000).unref?.();
}

// ---------------------------------------------------------------- para o painel

function resumo(empresa) {
  const d = dadosDa(empresa);
  const clientes = d.clientes.map((c) => ({ ...c, situacao: situacao(empresa, c) }));
  const ativos = clientes.filter((c) => c.ativo !== false);
  const mes = competenciaDe(hojeSp());
  const doMes = ativos.filter((c) => c.situacao.competencia === mes || (c.envios || {})[mes] || (c.pagos || {})[mes]);
  return {
    config: configDa(empresa),
    padrao: PADRAO.mensagem,
    clientes,
    mes,
    totais: {
      ativos: ativos.length,
      mensal: ativos.reduce((s, c) => s + Number(c.valor || 0), 0),
      enviadasMes: ativos.filter((c) => (c.envios || {})[mes]).length,
      pagasMes: ativos.filter((c) => (c.pagos || {})[mes]).length,
      recebidoMes: ativos.filter((c) => (c.pagos || {})[mes]).reduce((s, c) => s + Number(c.valor || 0), 0),
      doMes: doMes.length
    },
    exemplo: d.clientes[0] ? montar(empresa, d.clientes[0], situacao(empresa, d.clientes[0]).competencia) : montar(empresa, { nome: 'Maria Silva', valor: 150, diaVencimento: 10, descricao: '' }, competenciaDe(hojeSp()))
  };
}

module.exports = { PADRAO, configDa, salvarConfig, adicionarCliente, editarCliente, removerCliente, marcarPago, montar, situacao, deveEnviar, enviarAgora, verificar, iniciar, resumo, vencimentoNo, hojeSp };
