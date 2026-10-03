// sugestao-midia.js — o cliente mandou a foto do volante ou disse qual é o carro:
// o CRM sugere para a equipe, na conversa, a mídia certa da biblioteca para mandar
// (pelo nome, código, descrição, assuntos e serviços do catálogo ligados à mídia).
//
// Dois jeitos, juntos:
//   1. Código (na hora, sem IA): palavras da mensagem do cliente que aparecem no
//      nome/descrição de poucas mídias ("civic", "hb20", "corolla 2019"…).
//   2. IA (barata), alguns segundos depois: lê o fim da conversa e, se o cliente
//      mandou foto, olha a foto; escolhe na lista as mídias que combinam.
// Nada é enviado sozinho: aparece "Mandar" / "Dispensar" na conversa.
// Liga/desliga em Mídias (empresa.sugestaoMidia.ativo).

const fs = require('fs');
const { estado, salvar, novoId, agora } = require('./db');

const ESPERA_MS = Number(process.env.SUGESTAO_MIDIA_ESPERA_MS) || 6000;
const MAX_SUGESTOES = 3;
const timers = new Map(); // leadId → timeout

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// palavras que não dizem nada sobre o carro/serviço
const VAZIAS = new Set(('a o e de da do das dos em no na nos nas um uma uns umas que se por para pra pro com sem meu minha seu sua ele ela eu voce vc ' +
  'oi ola bom boa dia tarde noite tudo bem obrigado obrigada valeu sim nao ok blz beleza quero queria gostaria qual quais quanto quanta ' +
  'custa preco valor fica ficaria tem teria pode poderia faz fazem fazer foto fotos video videos imagem manda mande envia ' +
  'carro veiculo modelo ano esse essa este esta isso aqui ai la tambem mais menos muito pouco como onde quando ja agora entao ' +
  'mas porque pois sobre ate depois antes servico servicos trabalho').split(' '));

function configDa(empresa) {
  if (!empresa.sugestaoMidia || typeof empresa.sugestaoMidia !== 'object') empresa.sugestaoMidia = { ativo: true };
  return empresa.sugestaoMidia;
}
const ativo = (empresa) => configDa(empresa).ativo !== false;

function ligar(empresa, sim) {
  configDa(empresa).ativo = sim === true;
  salvar();
  return { ativo: ativo(empresa) };
}

const palavras = (t) => semAcento(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 2 && !VAZIAS.has(p) && !/^\d{1}$/.test(p));

// O que dá para sugerir: mídias avulsas, álbuns e pastas do Drive (com o texto de cada um)
function candidatos(empresa) {
  const midias = require('./midias');
  const ligadas = require('./catalogo').midiasLigadas(empresa);
  const todas = midias.midiasDa(empresa).filter((m) => !m.processando);
  const servicos = (codigo) => ligadas.get(codigo) || [];
  const item = (x, extra) => ({ codigo: x.codigo, nome: x.nome || '', descricao: x.descricao || '', assuntos: x.assuntos || [], servicos: servicos(x.codigo), ...extra });
  return [
    ...todas.filter((m) => !m.pastaId && !m.albumId).map((m) => item(m, { tipo: m.tipo })),
    ...midias.albunsDa(empresa).map((a) => item(a, { album: true, quantidade: todas.filter((m) => m.albumId === a.id).length })).filter((a) => a.quantidade),
    ...midias.pastasDa(empresa).map((p) => item(p, { album: true, quantidade: todas.filter((m) => m.pastaId === p.id).length })).filter((a) => a.quantidade)
  ].filter((c) => c.codigo);
}

const textoDo = (c) => [c.nome, c.codigo.replace(/-/g, ' '), c.descricao, ...c.assuntos, ...c.servicos].join(' ');

// ---------------------------------------------------------------- 1. código (na hora)
function porCodigo(lista, textoCliente) {
  const doCliente = new Set(palavras(textoCliente));
  if (!doCliente.size || !lista.length) return [];
  const dePalavras = lista.map((c) => new Set(palavras(textoDo(c))));
  // palavra que aparece em muitas mídias ("volante", "couro") não diferencia nada
  const freq = new Map();
  for (const s of dePalavras) for (const p of s) freq.set(p, (freq.get(p) || 0) + 1);
  const limite = Math.max(2, Math.ceil(lista.length * 0.34));
  // nome/modelo vale mais que número ("onix" > "2020"); só número não basta
  const pontos = lista.map((c, i) => {
    const bate = [...doCliente].filter((p) => dePalavras[i].has(p) && (freq.get(p) <= limite || lista.length <= 2) && (p.length >= 3 || /\d/.test(p)));
    const palavrasDeVerdade = bate.filter((p) => !/^\d+$/.test(p)).length;
    return { c, pontos: palavrasDeVerdade ? palavrasDeVerdade * 10 + bate.length : 0, bate };
  });
  const melhor = Math.max(0, ...pontos.map((x) => x.pontos));
  if (!melhor) return [];
  return pontos.filter((x) => x.pontos === melhor).slice(0, MAX_SUGESTOES).map((x) => ({ codigo: x.c.codigo, motivo: `o cliente falou "${x.bate.join(', ')}"` }));
}

// ---------------------------------------------------------------- 2. IA (foto ou texto)
// Vale chamar a IA? foto do cliente, ou fala de carro/modelo/ano/marca
const PISTA_CARRO = /\b(carro|veiculo|modelo|ano|volante|painel|banco|bancos|meu e (um|uma)|tenho (um|uma)|fiat|vw|volks|volkswagen|chevrolet|chevr|gm|ford|toyota|honda|hyundai|renault|nissan|jeep|peugeot|citroen|mitsubishi|kia|bmw|audi|mercedes|byd|caoa|chery|suzuki|land rover|volvo|ram|dodge|(19|20)\d{2})\b/;

async function porIa(empresa, lead, lista, fotos) {
  const bot = require('./whatsapp').botDoWhatsapp(empresa);
  if (!bot) return [];
  const conversa = (lead.mensagens || [])
    .filter((m) => (m.texto || m.anexo) && !m.apagada)
    .slice(-10)
    .map((m) => `${m.papel === 'visitante' ? 'Cliente' : 'Empresa'}: ${String(m.texto || '[anexo]').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  const catalogo = lista
    .slice(0, 150)
    .map((c) => `- ${c.codigo} | ${c.album ? `álbum (${c.quantidade})` : c.tipo || 'mídia'} | ${c.nome}${c.descricao ? ` | ${c.descricao.slice(0, 200)}` : ''}${c.assuntos.length ? ` | assuntos: ${c.assuntos.join(', ')}` : ''}${c.servicos.length ? ` | serviços: ${c.servicos.join(', ')}` : ''}`)
    .join('\n');
  const pedido =
    `Mídias cadastradas pela empresa (código | tipo | nome | descrição):\n${catalogo}\n\nFim da conversa no WhatsApp:\n${conversa}\n\n` +
    (fotos ? 'A foto anexada é a última que o cliente mandou (ex.: o volante, o painel ou o carro dele). Identifique o carro/modelo/peça pela foto.\n' : '') +
    `Tarefa: escolha até ${MAX_SUGESTOES} mídias da lista que a equipe deveria mandar AGORA para este cliente, porque mostram o carro/modelo/peça/serviço que ele tem ou pediu. ` +
    'Só escolha quando o nome ou a descrição da mídia combinar de verdade com o que o cliente disse ou mostrou (mesmo modelo, mesma marca, mesmo tipo de peça ou serviço). Se nada combinar, devolva lista vazia. Não invente códigos.\n' +
    'Responda SOMENTE com JSON: {"carro": "o que você entendeu (modelo/ano) ou vazio", "midias": [{"codigo": "...", "porque": "frase curta"}]}';
  const ia = require('./ia');
  const r = fotos
    ? await ia.perguntarComImagem(bot, empresa, 'Você ajuda uma empresa a escolher a foto/vídeo certo da biblioteca para mandar a um cliente. Responda só com JSON.', pedido, fotos, 600)
    : await ia.gerarTexto(bot, empresa, 'Você ajuda uma empresa a escolher a foto/vídeo certo da biblioteca para mandar a um cliente. Responda só com JSON.', pedido, 600, { barato: true });
  const m = String(r || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  const j = JSON.parse(m[0]);
  const validos = new Set(lista.map((c) => c.codigo));
  const carro = String(j.carro || '').trim().slice(0, 80);
  return (Array.isArray(j.midias) ? j.midias : [])
    .map((x) => ({ codigo: String(x?.codigo || '').trim().toUpperCase(), motivo: String(x?.porque || '').trim().slice(0, 160) || (carro ? `cliente: ${carro}` : '') }))
    .filter((x) => validos.has(x.codigo))
    .slice(0, MAX_SUGESTOES)
    .map((x) => ({ ...x, carro }));
}

// última foto do cliente (desde a última conferência), para a IA olhar
function fotoDoCliente(lead, desde) {
  const midias = require('./midias');
  const m = [...(lead.mensagens || [])].reverse().find((x) => x.papel === 'visitante' && x.anexo?.tipo === 'image' && (!desde || String(x.em) > desde));
  if (!m) return null;
  const caminho = midias.caminhoAnexo(lead.id, m.anexo.arquivo);
  try {
    if (!caminho || fs.statSync(caminho).size > 5 * 1024 * 1024) return null;
    return { base64: fs.readFileSync(caminho).toString('base64'), mime: m.anexo.mimetype };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- conferir uma conversa
async function conferir(empresa, lead) {
  if (!ativo(empresa)) return null;
  const doCliente = (lead.mensagens || []).filter((m) => m.papel === 'visitante' && !m.apagada);
  const ultima = doCliente[doCliente.length - 1];
  if (!ultima || (lead.sugestaoMidiaConferidaAte && String(ultima.em) <= lead.sugestaoMidiaConferidaAte)) return null;
  const desde = lead.sugestaoMidiaConferidaAte || '';
  lead.sugestaoMidiaConferidaAte = String(ultima.em);
  const novas = doCliente.filter((m) => !desde || String(m.em) > desde);
  const lista = candidatos(empresa);
  if (!lista.length) return null;
  const textoNovo = novas.map((m) => m.texto || '').join(' ');
  const recentes = doCliente.slice(-3).map((m) => m.texto || '').join(' ');
  // foto nova do cliente: a IA olha a foto primeiro; senão, palavras primeiro (sem gastar IA)
  const foto = novas.some((m) => m.anexo?.tipo === 'image') ? fotoDoCliente(lead, desde) : null;
  let achadas = foto ? [] : porCodigo(lista, recentes);
  if (!achadas.length && (foto || PISTA_CARRO.test(semAcento(textoNovo)))) {
    try {
      achadas = (await porIa(empresa, lead, lista, foto)).map((x) => ({ ...x, por: 'ia' }));
    } catch (err) {
      console.error(`[sugestao-midia ${lead.id}]`, err.message);
    }
  }
  if (!achadas.length && foto) achadas = porCodigo(lista, recentes);
  const enviadas = new Set((lead.mensagens || []).filter((m) => m.midiaCodigo).map((m) => m.midiaCodigo));
  const dispensadas = new Set(lead.midiasDispensadas || []);
  achadas = achadas.filter((x) => !enviadas.has(x.codigo) && !dispensadas.has(x.codigo));
  if (!achadas.length) return null;
  lead.sugestaoMidia = {
    id: novoId('sm'),
    em: agora(),
    por: achadas[0].por || 'codigo',
    carro: achadas.find((x) => x.carro)?.carro || '',
    itens: achadas.map(({ codigo, motivo }) => ({ codigo, motivo }))
  };
  salvar();
  return lead.sugestaoMidia;
}

// Chamado a cada mensagem do WhatsApp: confere uns segundos depois da última do cliente
function observar(empresa, lead) {
  if (!empresa || !lead || !ativo(empresa)) return;
  const ultima = (lead.mensagens || [])[lead.mensagens.length - 1];
  if (ultima?.papel !== 'visitante') return;
  clearTimeout(timers.get(lead.id));
  const t = setTimeout(() => {
    timers.delete(lead.id);
    conferir(empresa, lead).catch((err) => console.error('[sugestao-midia]', err.message));
  }, ESPERA_MS);
  t.unref?.();
  timers.set(lead.id, t);
}

// O que a conversa mostra (some o que já foi mandado)
function paraPainel(empresa, lead) {
  const s = lead.sugestaoMidia;
  if (!s || !ativo(empresa)) return null;
  const midias = require('./midias');
  const enviadas = new Set((lead.mensagens || []).filter((m) => m.midiaCodigo).map((m) => m.midiaCodigo));
  const todas = midias.midiasDa(empresa);
  const itens = s.itens
    .filter((x) => !enviadas.has(x.codigo))
    .map((x) => {
      const r = midias.resolverPedido(empresa, x.codigo);
      if (!r.alvo) return null;
      const capa = r.itens.find((m) => m.tipo === 'image') || null;
      const album = !todas.includes(r.alvo);
      return { codigo: x.codigo, motivo: x.motivo, nome: r.alvo.nome, tipo: album ? 'album' : r.alvo.tipo, quantidade: r.itens.length, capa: capa ? midias.urlPublica(capa) : '' };
    })
    .filter(Boolean);
  return itens.length ? { id: s.id, em: s.em, por: s.por, carro: s.carro, itens } : null;
}

function dispensar(lead, codigo) {
  const s = lead.sugestaoMidia;
  if (!s) return;
  const fora = codigo ? [codigo] : s.itens.map((x) => x.codigo);
  lead.midiasDispensadas = [...new Set([...(lead.midiasDispensadas || []), ...fora])].slice(-50);
  s.itens = s.itens.filter((x) => !fora.includes(x.codigo));
  if (!s.itens.length) delete lead.sugestaoMidia;
  salvar();
}

// A equipe mandou uma mídia (ou álbum): sai da sugestão
function enviada(lead, codigo) {
  const s = lead.sugestaoMidia;
  if (!s || !codigo) return;
  s.itens = s.itens.filter((x) => x.codigo !== codigo);
  if (!s.itens.length) delete lead.sugestaoMidia;
}

module.exports = { enviada, configDa, ligar, observar, conferir, paraPainel, dispensar, porCodigo, candidatos };
