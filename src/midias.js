// midias.js — biblioteca de mídias de cada empresa (fotos, vídeos, PDFs,
// áudios) que a IA do WhatsApp pode enviar. Os arquivos ficam em disco e são
// servidos num endereço público com id aleatório, porque o WhatsApp (Evolution
// API) precisa baixar o arquivo por URL para enviar.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { estado, salvar, agora } = require('./db');

// Fotos e vídeos grandes, na qualidade original: até 200 MB (o painel manda em
// pedaços de 900 KB, então o limite do Nginx não atrapalha).
const TAMANHO_MAXIMO = 200 * 1024 * 1024;

const TIPOS = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'video/quicktime': 'video',
  'video/x-m4v': 'video',
  'video/webm': 'video',
  'video/x-matroska': 'video',
  'video/x-msvideo': 'video',
  'video/mpeg': 'video',
  'video/mp2t': 'video',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'application/pdf': 'document'
};

const EXTENSOES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

// Categoria pelo tipo do arquivo: qualquer video/* é Vídeo, image/* é Foto…
function tipoDoMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (TIPOS[m]) return TIPOS[m];
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

// Mídias antigas que entraram como "documento" sendo vídeo/foto (ex.: .mov do iPhone)
function corrigirTipos(empresa) {
  let mudou = false;
  for (const m of empresa.midias || []) {
    const mime = mimeDe(m.arquivo || '', m.mimetype);
    const certo = tipoDoMime(mime);
    if (m.tipo === 'document' && certo !== 'document') {
      m.mimetype = mime;
      m.tipo = certo;
      mudou = true;
      if (certo === 'video') setImmediate(() => require('./video').enfileirar(m));
    }
  }
  if (mudou) salvar();
}

function garantirPasta() {
  fs.mkdirSync(config.midiasDir, { recursive: true });
}

function nomeArquivoSeguro(nome) {
  const base = path.basename(String(nome || 'arquivo'))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'arquivo';
}

function mimeDe(nomeArquivo, informado) {
  const ext = path.extname(nomeArquivo).toLowerCase();
  if (EXTENSOES[ext]) return EXTENSOES[ext];
  if (informado && informado !== 'application/octet-stream') return informado;
  return 'application/octet-stream';
}

const tiposRevisados = new WeakSet();
function midiasDa(empresa) {
  const lista = empresa.midias || [];
  // mídias antigas ganham código e ficam "prontas" (a IA já usava)
  if (lista.some((m) => !m.codigo) || albunsDa(empresa).some((a) => !a.codigo) || pastasDa(empresa).some((p) => !p.codigo)) garantirCodigos(empresa);
  if (!tiposRevisados.has(empresa)) {
    tiposRevisados.add(empresa);
    corrigirTipos(empresa);
  }
  return lista;
}

// ---------------------------------------------------------------- códigos
// Cada mídia, álbum e pasta do Drive tem um CÓDIGO curto e único (ex.: FOTO-ANTES-DEPOIS).
// A IA pede a mídia pelo código ([[MIDIA: FOTO-ANTES-DEPOIS]]), então nunca manda a errada.

function slugCodigo(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/^#/, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// O que a pessoa (ou a IA) escreveu → código guardado. Aceita "#MIDIA_FOTO_ANTES",
// "midia_foto_antes", "**#MIDIA_FOTO_ANTES**", "FOTO-ANTES"… (o prefixo MIDIA_ é só visual)
function semPrefixo(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^[\s*"'`“”]+|[\s*"'`“”.,;!?]+$/g, '')
    .replace(/^#\s*/, '')
    .replace(/^midia(?:[\s_:-]+|$)/i, '');
}
function codigoDaEntrada(v) {
  return slugCodigo(semPrefixo(v));
}

// Como o código aparece no painel e no prompt: #MIDIA_FOTO_ANTES_DEPOIS
function codigoVisivel(codigo) {
  return codigo ? `#MIDIA_${String(codigo).replace(/-/g, '_')}` : '';
}

function codigosEmUso(empresa, excetoId = null) {
  const usados = new Set();
  for (const m of empresa.midias || []) if (m.codigo && m.id !== excetoId) usados.add(m.codigo);
  for (const a of empresa.albuns || []) if (a.codigo && a.id !== excetoId) usados.add(a.codigo);
  for (const p of empresa.drivePastas || []) if (p.codigo && p.id !== excetoId) usados.add(p.codigo);
  return usados;
}

function novoCodigo(empresa, base, excetoId = null) {
  const usados = codigosEmUso(empresa, excetoId);
  const raiz = codigoDaEntrada(base) || slugCodigo(base) || 'ARQUIVO';
  if (!usados.has(raiz)) return raiz;
  for (let i = 2; i < 1000; i++) {
    const c = `${raiz.slice(0, 20)}-${i}`;
    if (!usados.has(c)) return c;
  }
  return `${raiz.slice(0, 16)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// Código escolhido pela pessoa: limpa e confere se já existe
function validarCodigo(empresa, codigo, excetoId) {
  const c = codigoDaEntrada(codigo);
  if (!c || c.length < 2) throw Object.assign(new Error('O código precisa ter pelo menos 2 letras ou números depois de #MIDIA_ (ex.: #MIDIA_TABELA, #MIDIA_FOTO_ANTES_DEPOIS).'), { status: 400 });
  if (codigosEmUso(empresa, excetoId).has(c)) throw Object.assign(new Error(`O código ${codigoVisivel(c)} já está em uso nesta empresa. Escolha outro.`), { status: 400 });
  return c;
}

function garantirCodigos(empresa) {
  for (const m of empresa.midias || []) {
    if (!m.codigo) m.codigo = novoCodigo(empresa, m.nome, m.id);
    if (m.pronta === undefined) m.pronta = true;
  }
  for (const a of empresa.albuns || []) if (!a.codigo) a.codigo = novoCodigo(empresa, a.nome, a.id);
  for (const p of empresa.drivePastas || []) if (!p.codigo) p.codigo = novoCodigo(empresa, p.nome, p.id);
  salvar();
}

// ---------------------------------------------------------------- álbuns (grupos de mídias enviados juntos)

function albunsDa(empresa) {
  return Array.isArray(empresa.albuns) ? empresa.albuns : [];
}

// ASSUNTOS: a própria empresa cria a lista (ex.: "Completo", "Arco"; outra
// empresa, de outro nicho, cria os dela). Cada mídia/álbum pode ter assuntos:
// a IA só manda quando a conversa for sobre aquele assunto.
const MAX_ASSUNTOS = 20;
function assuntosDa(empresa) {
  return Array.isArray(empresa.assuntosMidia) ? empresa.assuntosMidia : [];
}
function salvarAssuntos(empresa, lista) {
  const vistos = new Set();
  const novos = (Array.isArray(lista) ? lista : [])
    .map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter((x) => x && !vistos.has(x.toLowerCase()) && vistos.add(x.toLowerCase()))
    .slice(0, MAX_ASSUNTOS);
  empresa.assuntosMidia = novos;
  // assunto apagado sai das mídias e álbuns
  const ok = new Set(novos);
  for (const item of [...midiasDa(empresa), ...albunsDa(empresa)]) if (Array.isArray(item.assuntos)) item.assuntos = item.assuntos.filter((a) => ok.has(a));
  salvar();
  return novos;
}
const listaAssuntos = (empresa, v) => {
  const ok = new Set(assuntosDa(empresa));
  return [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => ok.has(x)))];
};

const listaEtapas = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 10);

function salvarMidia(empresa, { buffer, nomeArquivo, nome, descricao, mimetypeInformado, extra = {} }) {
  if (!buffer?.length) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });
  if (buffer.length > TAMANHO_MAXIMO) throw Object.assign(new Error('Arquivo maior que 200 MB. Divida o vídeo em partes e envie de novo.'), { status: 413 });
  const arquivo = nomeArquivoSeguro(nomeArquivo);
  const mimetype = mimeDe(arquivo, mimetypeInformado);
  const id = crypto.randomBytes(12).toString('hex');
  garantirPasta();
  fs.writeFileSync(path.join(config.midiasDir, `${id}${path.extname(arquivo).toLowerCase()}`), buffer);
  const nomeFinal = String(nome || path.parse(arquivo).name).trim().slice(0, 80);
  empresa.midias = midiasDa(empresa);
  const midia = {
    id,
    nome: nomeFinal,
    descricao: String(descricao || '').trim().slice(0, 300),
    arquivo,
    mimetype,
    tipo: tipoDoMime(mimetype),
    tamanho: buffer.length,
    criadoEm: agora(),
    codigo: extra.codigo ? validarCodigo(empresa, extra.codigo) : novoCodigo(empresa, extra.pastaId ? `${nomeFinal}` : nomeFinal),
    pronta: extra.pronta !== false,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['codigo', 'pronta'].includes(k)))
  };
  empresa.midias.push(midia);
  salvar();
  require('./video').enfileirar(midia); // vídeo: confere/converte para MP4 do WhatsApp
  return midia;
}

function caminhoDoArquivo(midia) {
  return path.join(config.midiasDir, `${midia.id}${path.extname(midia.arquivo).toLowerCase()}`);
}

function apagarMidia(empresa, midiaId) {
  const i = midiasDa(empresa).findIndex((m) => m.id === midiaId);
  if (i < 0) return false;
  const [midia] = empresa.midias.splice(i, 1);
  if (midia.codigo) require('./catalogo').esquecerMidia(empresa, midia.codigo);
  try {
    fs.unlinkSync(caminhoDoArquivo(midia));
  } catch {
    /* já não existia */
  }
  salvar();
  return true;
}

function apagarTodasDa(empresa) {
  for (const m of midiasDa(empresa)) {
    try {
      fs.unlinkSync(caminhoDoArquivo(m));
    } catch {
      /* ignora */
    }
  }
}

// Endereço público do arquivo (o WhatsApp baixa daqui)
function urlPublica(midia) {
  return `${config.urlPublica}/midia/${midia.id}/${encodeURIComponent(midia.arquivo)}`;
}

function acharPorId(id) {
  for (const e of estado.empresas) {
    const m = midiasDa(e).find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

const limpar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// A IA escreve [[MIDIA: CÓDIGO]] (ou o nome, nas mídias antigas)
function acharPorNome(empresa, nome) {
  const alvo = limpar(nome);
  return midiasDa(empresa).find((m) => !m.pastaId && limpar(m.nome) === alvo) || null;
}

// Código (ou nome) → o que enviar: { itens: [mídias], etapas: [...], alvo }
const MAX_POR_ALBUM = 10;
function resolverPedido(empresa, ref) {
  // "#MIDIA_FOTO_ANTES" → FOTO-ANTES; um código antigo que começa com MIDIA- também vale
  const candidatos = [codigoDaEntrada(ref), slugCodigo(ref)].filter(Boolean);
  const codigo = candidatos.find((c) => codigosEmUso(empresa).has(c)) || candidatos[0] || '';
  const todas = midiasDa(empresa);
  const porCodigo = todas.find((m) => m.codigo === codigo);
  if (porCodigo) return { itens: [porCodigo], etapas: porCodigo.etapas || [], alvo: porCodigo };
  const album = albunsDa(empresa).find((a) => a.codigo === codigo) || albunsDa(empresa).find((a) => limpar(a.nome) === limpar(ref));
  if (album) return { itens: todas.filter((m) => m.albumId === album.id).slice(0, MAX_POR_ALBUM), etapas: album.etapas || [], alvo: album };
  const pasta = pastasDa(empresa).find((p) => p.codigo === codigo) || pastasDa(empresa).find((p) => limpar(p.nome) === limpar(ref));
  if (pasta) return { itens: todas.filter((m) => m.pastaId === pasta.id).slice(0, MAX_POR_ALBUM), etapas: pasta.etapas || [], alvo: pasta };
  const avulsa = acharPorNome(empresa, semPrefixo(ref).replace(/_/g, ' ')) || acharPorNome(empresa, ref);
  if (avulsa) return { itens: [avulsa], etapas: avulsa.etapas || [], alvo: avulsa };
  return { itens: [], etapas: [], alvo: null };
}

function acharParaEnviar(empresa, ref) {
  return resolverPedido(empresa, ref).itens;
}

// O que a IA vê: só mídias PRONTAS (as "a configurar" ficam de fora), cada
// álbum e cada pasta do Drive como um item
function prontaParaIa(m) {
  return m.pronta !== false && !m.processando;
}

// { followup: true } inclui as mídias marcadas "só no follow-up"
function paraIa(empresa, { followup = false } = {}) {
  // mídia ligada a um serviço/produto do catálogo já está "configurada": vai quando se fala dele
  const ligadas = require('./catalogo').midiasLigadas(empresa);
  const doPrompt = codigosDoPrompt(empresa);
  const albunsDoPrompt = new Set(albunsDa(empresa).filter((a) => doPrompt.has(a.codigo)).map((a) => a.id));
  const todas = midiasDa(empresa).filter((m) => prontaParaIa(m) || ((ligadas.has(m.codigo) || doPrompt.has(m.codigo) || albunsDoPrompt.has(m.albumId)) && !m.processando) || (m.albumId && !m.processando));
  const valeAqui = (x) => followup || !x.soFollowup;
  const servicos = (codigo) => ligadas.get(codigo) || [];
  const avulsas = todas
    .filter((m) => !m.pastaId && !m.albumId && valeAqui(m))
    .map((m) => ({ codigo: m.codigo, nome: m.nome, quando: m.descricao, etapas: m.etapas || [], assuntos: m.assuntos || [], tipo: m.tipo, umaVez: m.umaVezPorConversa !== false, servicos: servicos(m.codigo) }));
  const albuns = albunsDa(empresa)
    .filter(valeAqui)
    .map((a) => ({ codigo: a.codigo, nome: a.nome, quando: a.descricao, etapas: a.etapas || [], assuntos: a.assuntos || [], album: true, quantidade: todas.filter((m) => m.albumId === a.id && (prontaParaIa(m) || ligadas.has(a.codigo) || doPrompt.has(a.codigo))).length, servicos: servicos(a.codigo) }))
    .filter((a) => a.quantidade > 0);
  const pastas = pastasDa(empresa)
    .map((p) => ({ codigo: p.codigo, nome: p.nome, quando: p.descricao, etapas: p.etapas || [], album: true, quantidade: todas.filter((m) => m.pastaId === p.id).length, servicos: servicos(p.codigo) }))
    .filter((a) => a.quantidade > 0);
  return [...avulsas, ...albuns, ...pastas];
}

// ---------------------------------------------------------------- códigos citados no prompt
// O dono pode citar o código no prompt ("quando perguntarem do preço, mande #MIDIA_TABELA").
// O sistema reconhece e avisa no painel se o código não existe (ou está desativado).
const CAMPOS_PROMPT = { promptWhatsapp: 'Instruções do WhatsApp', regras: 'Instruções do site', conhecimento: 'Sobre a empresa', oferta: 'Oferta', objetivo: 'Objetivo' };
function codigosCitados(empresa, texto) {
  const achados = [];
  const re = /\[\[\s*M[IÍ]DIA\s*:?\s*([^\]\n]+?)\s*\]\]|#\s*[Mm][IiÍí][Dd][Ii][Aa][_:-]\s*([A-Za-z0-9][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(String(texto || '')))) {
    const ref = (m[1] || m[2] || '').trim();
    if (!ref) continue;
    const pedido = resolverPedido(empresa, ref);
    const alvo = pedido.alvo;
    achados.push({
      escrito: m[0],
      codigo: alvo?.codigo ? codigoVisivel(alvo.codigo) : `#MIDIA_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      existe: Boolean(alvo),
      ativa: Boolean(alvo) && (pedido.itens.some((x) => prontaParaIa(x)) || (!alvo.arquivo && pedido.itens.length > 0)),
      nome: alvo?.nome || ''
    });
  }
  return achados;
}

// ---------------------------------------------------------------- menções de mídia no prompt
// O dono escreve no prompt "mande o vídeo do revestimento quando…" (sem código) ou cita
// um código que não existe. O painel mostra cada trecho e ajuda a CONECTAR a mídia certa:
// o CRM coloca o código #MIDIA_ certo no prompt.
const FALA_DE_MIDIA = /\b(fotos?|imagens?|v[ií]deos?|[áa]udios?|pdfs?|cat[áa]logos?|tabelas?( de pre[cç]os?)?|portf[óo]lios?|card[áa]pios?|apresenta[cç](?:[ãa]o|[õo]es)|antes e depois|prints?|[áa]lbu(?:m|ns)|folders?|panfletos?|or[cç]amento em pdf)\b/i;
const VERBO_ENVIAR = /\b(mand\w*|envi\w*|mostr\w*|pass\w*|compartilh\w*|segue|seguem|apresent\w*|exib\w*|disponibiliz\w*)\b/i;
const PALAVRAS_VAZIAS = new Set('para quando cliente clientes pedir perguntar pergunta sobre como mande manda mandar envie enviar envia mostre mostrar depois antes sempre voce você ele ela isso esse essa este esta que com sem uma umas uns dos das nos nas pelo pela tambem também entao então foto fotos video videos vídeo vídeos audio audios áudio áudios imagem imagens midia mídia midias mídias'.split(' '));
const tokens = (t) => new Set(limpar(t).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w)));
const idPendencia = (...partes) => crypto.createHash('sha1').update(partes.join('|')).digest('hex').slice(0, 12);

// Quais mídias combinam com o trecho do prompt (pelo nome, "quando enviar", código, assunto e tipo)
function sugerirMidias(empresa, trecho, max = 4) {
  const alvo = tokens(trecho);
  const t = limpar(trecho);
  const querTipo = /v[ií]deo/.test(t) ? 'video' : /[áa]udio/.test(t) ? 'audio' : /pdf|tabela|catalogo|cardapio|apresenta|orcamento/.test(t) ? 'document' : /foto|imagem|antes e depois|print/.test(t) ? 'image' : '';
  const todas = midiasDa(empresa);
  const itens = [
    ...todas.filter((m) => !m.pastaId && !m.albumId).map((m) => ({ codigo: m.codigo, nome: m.nome, tipo: m.tipo, quando: m.descricao || '', assuntos: m.assuntos || [], ativa: prontaParaIa(m), id: m.id, capa: m.tipo === 'image' ? urlPublica(m) : '' })),
    ...albunsDa(empresa).map((a) => { const fs_ = todas.filter((m) => m.albumId === a.id); const capa = fs_.find((m) => m.tipo === 'image'); return { codigo: a.codigo, nome: a.nome, tipo: 'album', quando: a.descricao || '', assuntos: a.assuntos || [], ativa: fs_.some((m) => prontaParaIa(m)), quantidade: fs_.length, capa: capa ? urlPublica(capa) : '' }; }),
    ...pastasDa(empresa).map((p) => { const fs_ = todas.filter((m) => m.pastaId === p.id); const capa = fs_.find((m) => m.tipo === 'image'); return { codigo: p.codigo, nome: p.nome, tipo: 'album', quando: p.descricao || '', assuntos: [], ativa: fs_.length > 0, quantidade: fs_.length, capa: capa ? urlPublica(capa) : '' }; })
  ];
  const pontuadas = itens.map((x) => {
    const deles = tokens(`${x.nome} ${x.quando} ${x.codigo.replace(/-/g, ' ')} ${x.assuntos.join(' ')}`);
    let pontos = 0;
    for (const w of alvo) if (deles.has(w)) pontos += 3;
    for (const w of alvo) if (w.length >= 5 && [...deles].some((d) => d.length >= 5 && (d.startsWith(w.slice(0, 5)) || w.startsWith(d.slice(0, 5))))) pontos += 1;
    if (querTipo && (x.tipo === querTipo || (querTipo === 'image' && x.tipo === 'album'))) pontos += 2;
    return { ...x, codigoVisivel: codigoVisivel(x.codigo), pontos };
  });
  return pontuadas.filter((x) => x.pontos > 0).sort((a, b) => b.pontos - a.pontos).slice(0, max);
}

function trechosDe(texto) {
  return String(texto || '')
    .split(/\n+/)
    .flatMap((linha) => linha.split(/(?<=[.!?;])\s+/))
    .map((x) => x.trim())
    .filter((x) => x.length >= 6);
}

// Pendências: código que não existe, mídia desativada e mídia citada sem código
function pendenciasDoPrompt(empresa) {
  const ignoradas = new Set(empresa.mencoesIgnoradas || []);
  const lista = [];
  for (const bot of estado.bots.filter((b) => b.empresaId === empresa.id)) {
    for (const [campo, rotulo] of Object.entries(CAMPOS_PROMPT)) {
      for (const trecho of trechosDe(bot[campo])) {
        const citados = codigosCitados(empresa, trecho);
        const base = { botId: bot.id, campo, onde: rotulo, trecho };
        if (citados.length) {
          for (const c of citados) {
            if (c.existe && (c.ativa || campo === 'promptWhatsapp')) continue;
            const id = idPendencia(bot.id, campo, trecho, c.escrito);
            if (ignoradas.has(id)) continue;
            lista.push({ ...base, id, tipo: c.existe ? 'desativada' : 'inexistente', escrito: c.escrito, codigo: c.codigo, nome: c.nome, sugestoes: c.existe ? [] : sugerirMidias(empresa, `${trecho} ${c.codigo.replace(/^#MIDIA_/, '').replace(/_/g, ' ')}`) });
          }
          continue;
        }
        if (!FALA_DE_MIDIA.test(trecho) || !VERBO_ENVIAR.test(trecho)) continue;
        const id = idPendencia(bot.id, campo, trecho);
        if (ignoradas.has(id)) continue;
        if (campo === 'promptWhatsapp' && conexaoCerta(empresa, trecho)) continue; // a IA já recebe com o código certo
        lista.push({ ...base, id, tipo: 'sem-codigo', escrito: (trecho.match(FALA_DE_MIDIA) || [''])[0], sugestoes: sugerirMidias(empresa, trecho) });
      }
    }
  }
  return lista;
}

// Coloca o código certo no prompt: troca o código errado ou acrescenta "(mídia #MIDIA_X)" no trecho
function conectarNoPrompt(empresa, pendencia, codigoMidia) {
  const bot = estado.bots.find((b) => b.id === pendencia.botId && b.empresaId === empresa.id);
  if (!bot) throw Object.assign(new Error('Assistente não encontrado.'), { status: 404 });
  const texto = String(bot[pendencia.campo] || '');
  if (!texto.includes(pendencia.trecho)) throw Object.assign(new Error('O prompt mudou desde que a página abriu. Recarregue e tente de novo.'), { status: 409 });
  const codigo = codigoVisivel(codigoMidia);
  let novoTrecho;
  if (pendencia.tipo === 'inexistente') novoTrecho = pendencia.trecho.split(pendencia.escrito).join(codigo);
  else novoTrecho = pendencia.trecho.replace(/\s*([.!?;:]*)$/, (_, pont) => ` (mídia ${codigo})${pont}`);
  return { bot, campo: pendencia.campo, textoNovo: texto.replace(pendencia.trecho, novoTrecho), novoTrecho };
}

// A mídia certa para um trecho do prompt, só quando não há dúvida: a melhor sugestão
// combina com o trecho (nome/descrição/assunto) e ganha com folga da segunda
function conexaoCerta(empresa, trecho) {
  const [a, b] = sugerirMidias(empresa, trecho, 2);
  if (!a || a.pontos < 5) return null;
  if (b && b.pontos > a.pontos - 3) return null;
  return a;
}

// Instruções que vão para a IA com as mídias conectadas: o trecho que fala de mídia sem
// código ganha "(mídia #MIDIA_X)" e um código que não existe é trocado pelo certo — só
// quando a mídia certa é clara. Não muda o texto salvo (o "Atualizar prompt" grava).
// Devolve { texto, conectadas: [{ trecho, codigo, nome }] }
const cacheConexoes = new Map(); // empresaId → { chave, r }
function instrucoesComMidias(empresa, texto, botId = '') {
  const original = String(texto || '').trim();
  if (!empresa || !original) return { texto: original, conectadas: [] };
  const chave = crypto
    .createHash('sha1')
    .update(JSON.stringify([botId, original, empresa.mencoesIgnoradas || [], midiasDa(empresa).map((m) => [m.codigo, m.nome, m.descricao, m.assuntos, m.pronta, m.tipo, m.albumId, m.pastaId]), albunsDa(empresa).map((a) => [a.codigo, a.nome, a.descricao, a.assuntos]), pastasDa(empresa).map((x) => [x.codigo, x.nome, x.descricao])]))
    .digest('hex');
  const guardado = cacheConexoes.get(`${empresa.id}|${botId}`);
  if (guardado && guardado.chave === chave) return guardado.r;
  const ignoradas = new Set(empresa.mencoesIgnoradas || []);
  let saida = original;
  const conectadas = [];
  for (const trecho of trechosDe(original)) {
    const citados = codigosCitados(empresa, trecho);
    let novo = trecho;
    if (citados.length) {
      for (const c of citados.filter((x) => !x.existe)) {
        if (ignoradas.has(idPendencia(botId, 'promptWhatsapp', trecho, c.escrito))) continue;
        const certa = conexaoCerta(empresa, `${trecho} ${c.codigo.replace(/^#MIDIA_/, '').replace(/_/g, ' ')}`);
        if (certa) {
          novo = novo.split(c.escrito).join(certa.codigoVisivel);
          conectadas.push({ trecho, codigo: certa.codigoVisivel, nome: certa.nome, trocou: c.escrito });
        }
      }
    } else if (FALA_DE_MIDIA.test(trecho) && VERBO_ENVIAR.test(trecho) && !ignoradas.has(idPendencia(botId, 'promptWhatsapp', trecho))) {
      const certa = conexaoCerta(empresa, trecho);
      if (certa) {
        novo = trecho.replace(/\s*([.!?;:]*)$/, (_, pont) => ` (mídia ${certa.codigoVisivel})${pont}`);
        conectadas.push({ trecho, codigo: certa.codigoVisivel, nome: certa.nome });
      }
    }
    if (novo !== trecho) saida = saida.replace(trecho, novo);
  }
  const r = { texto: saida, conectadas };
  if (cacheConexoes.size > 500) cacheConexoes.clear();
  cacheConexoes.set(`${empresa.id}|${botId}`, { chave, r });
  return r;
}

// Códigos (mídia, álbum ou pasta) que as instruções do WhatsApp citam (com as conexões
// automáticas): o dono mandou enviar, então a IA pode mandar mesmo "a configurar"
function codigosDoPrompt(empresa) {
  const set = new Set();
  for (const bot of estado.bots.filter((b) => b.empresaId === empresa.id)) {
    const texto = instrucoesComMidias(empresa, bot.promptWhatsapp, bot.id).texto;
    for (const c of codigosCitados(empresa, texto)) if (c.existe) set.add(codigoDaEntrada(c.codigo));
  }
  return set;
}

function avisosDoPrompt(empresa) {
  const bots = estado.bots.filter((b) => b.empresaId === empresa.id);
  const lista = [];
  for (const bot of bots) {
    for (const [campo, rotulo] of Object.entries(CAMPOS_PROMPT)) {
      for (const c of codigosCitados(empresa, bot[campo])) lista.push({ ...c, campo, onde: rotulo, botId: bot.id, bot: bot.nome || 'Assistente' });
    }
  }
  const unicos = (f) => [...new Map(lista.filter(f).map((c) => [`${c.codigo}|${c.onde}`, c])).values()];
  return { citados: unicos(() => true), inexistentes: unicos((c) => !c.existe), desativadas: unicos((c) => c.existe && !c.ativa) };
}

// ---------------------------------------------------------------- envio em pedaços (arquivos grandes)
// O painel manda o arquivo em pedaços de até 900 KB; aqui eles são juntados.

const envios = new Map(); // envioId → { empresaId, arquivo, tipo, tamanho, recebido, caminho, em }
const PASTA_ENVIOS = () => path.join(config.midiasDir, '.envios');

function iniciarEnvio(empresa, { arquivo, tamanho, tipo }) {
  const t = Number(tamanho) || 0;
  if (t <= 0) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });
  if (t > TAMANHO_MAXIMO) throw Object.assign(new Error(`"${arquivo}" tem ${(t / 1024 / 1024).toFixed(0)} MB. O máximo é 200 MB — divida o vídeo em partes.`), { status: 413 });
  // limpa envios abandonados (mais de 2 horas)
  for (const [id, e] of envios) {
    if (Date.now() - e.em > 2 * 3600 * 1000) {
      fs.rmSync(e.caminho, { force: true });
      envios.delete(id);
    }
  }
  fs.mkdirSync(PASTA_ENVIOS(), { recursive: true });
  const id = crypto.randomBytes(12).toString('hex');
  const caminho = path.join(PASTA_ENVIOS(), `${id}.part`);
  fs.writeFileSync(caminho, Buffer.alloc(0));
  envios.set(id, { empresaId: empresa.id, arquivo: nomeArquivoSeguro(arquivo), tipo: String(tipo || ''), tamanho: t, recebido: 0, caminho, em: Date.now() });
  return { envioId: id, pedaco: 900 * 1024 };
}

function receberPedaco(empresa, envioId, posicao, buffer) {
  const e = envios.get(envioId);
  if (!e || e.empresaId !== empresa.id) throw Object.assign(new Error('Envio não encontrado (começe de novo).'), { status: 404 });
  if (Number(posicao) !== e.recebido) return { recebido: e.recebido }; // pedaço repetido: ignora
  if (e.recebido + buffer.length > e.tamanho) throw Object.assign(new Error('O arquivo veio maior que o combinado.'), { status: 400 });
  fs.appendFileSync(e.caminho, buffer);
  e.recebido += buffer.length;
  e.em = Date.now();
  return { recebido: e.recebido };
}

function concluirEnvio(empresa, envioId, dados = {}) {
  const e = envios.get(envioId);
  if (!e || e.empresaId !== empresa.id) throw Object.assign(new Error('Envio não encontrado (começe de novo).'), { status: 404 });
  if (e.recebido !== e.tamanho) throw Object.assign(new Error('O arquivo não chegou inteiro. Tente de novo.'), { status: 400 });
  const mimetype = mimeDe(e.arquivo, e.tipo);
  const id = crypto.randomBytes(12).toString('hex');
  garantirPasta();
  fs.renameSync(e.caminho, path.join(config.midiasDir, `${id}${path.extname(e.arquivo).toLowerCase()}`));
  envios.delete(envioId);
  const nome = String(dados.nome || path.parse(e.arquivo).name.replace(/[-_]+/g, ' ')).trim().slice(0, 80);
  empresa.midias = midiasDa(empresa);
  const midia = {
    id,
    nome,
    descricao: String(dados.descricao || '').trim().slice(0, 300),
    arquivo: e.arquivo,
    mimetype,
    tipo: tipoDoMime(mimetype),
    tamanho: e.tamanho,
    criadoEm: agora(),
    codigo: dados.codigo ? validarCodigo(empresa, dados.codigo) : novoCodigo(empresa, nome),
    // enviada em massa: fica "a configurar" (a IA só usa depois que você marcar como pronta)
    pronta: dados.pronta === true,
    etapas: listaEtapas(dados.etapas)
  };
  empresa.midias.push(midia);
  salvar();
  require('./video').enfileirar(midia);
  return midia;
}

// ---------------------------------------------------------------- links

function linksDa(empresa) {
  return Array.isArray(empresa.links) ? empresa.links : [];
}

// ---------------------------------------------------------------- Google Drive (pastas públicas)
// A empresa cola o link de uma pasta compartilhada ("qualquer pessoa com o
// link"). O CRM lista os arquivos, baixa as fotos/vídeos/PDFs e mantém a pasta
// sincronizada. Cada pasta vira um "álbum" que a IA pode mandar pelo nome.

const DRIVE = (process.env.DRIVE_BASE_URL || 'https://drive.google.com').replace(/\/+$/, '');
const DRIVE_API = (process.env.DRIVE_API_URL || 'https://www.googleapis.com/drive/v3').replace(/\/+$/, '');
const DRIVE_MAX_ARQUIVOS = 60;

function pastasDa(empresa) {
  return Array.isArray(empresa.drivePastas) ? empresa.drivePastas : [];
}

function idDaPasta(link) {
  const t = String(link || '').trim();
  const m = t.match(/\/folders\/([\w-]{10,})/) || t.match(/[?&]id=([\w-]{10,})/) || t.match(/^([\w-]{20,})$/);
  return m ? m[1] : '';
}

function desescapar(t) {
  return String(t)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// Lista os arquivos da pasta pela página pública do Drive (sem chave)
async function listarPastaPublica(pastaId) {
  const res = await fetch(`${DRIVE}/embeddedfolderview?id=${encodeURIComponent(pastaId)}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw Object.assign(new Error(`O Google Drive respondeu ${res.status}.`), { status: 502 });
  const html = await res.text();
  const titulo = desescapar((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').replace(/\s*-\s*Google Drive\s*$/i, '');
  const arquivos = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]*)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    if (/\/folders\//.test(m[2])) continue; // subpastas ficam de fora
    arquivos.push({ id: m[1], nome: desescapar(m[3]) });
  }
  return { titulo, arquivos };
}

// Plano B: API do Drive com a chave do Google da empresa (se a API estiver ativa)
async function listarPastaApi(pastaId, chaveGoogle) {
  const q = encodeURIComponent(`'${pastaId}' in parents and trashed = false`);
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,mimeType)&pageSize=200&key=${encodeURIComponent(chaveGoogle)}`, {
    signal: AbortSignal.timeout(30000)
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados?.error?.message || `HTTP ${res.status}`);
  return {
    titulo: '',
    arquivos: (dados.files || []).filter((f) => f.mimeType !== 'application/vnd.google-apps.folder').map((f) => ({ id: f.id, nome: f.name }))
  };
}

async function baixarDoDrive(arquivoId) {
  // arquivo grande: o Drive mostra "não foi possível verificar vírus" — confirm=t pula o aviso
  for (const url of [linkDiretoDrive(arquivoId), `${linkDiretoDrive(arquivoId)}&confirm=t`]) {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
    const tipo = res.headers.get('content-type') || '';
    if (res.ok && !/text\/html/i.test(tipo)) {
      const nome = decodeURIComponent((res.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] || '');
      return { buffer: Buffer.from(await res.arrayBuffer()), tipo: tipo.split(';')[0], nome };
    }
  }
  throw new Error('o arquivo não está público ("Qualquer pessoa com o link") ou não existe');
}

// Link de ARQUIVO do Google Drive (compartilhar, abrir, uc…) → id do arquivo
function idDoArquivoDrive(link) {
  const t = String(link || '').trim();
  if (!/drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com/i.test(t) && !t.startsWith(DRIVE)) return '';
  if (/\/folders\//.test(t)) return '';
  const m = t.match(/\/file\/d\/([\w-]{10,})/) || t.match(/[?&]id=([\w-]{10,})/) || t.match(/\/d\/([\w-]{10,})/);
  return m ? m[1] : '';
}

// Link direto de download (o que o CRM baixa e guarda)
function linkDiretoDrive(arquivoId) {
  return `${DRIVE}/uc?export=download&id=${encodeURIComponent(arquivoId)}`;
}

// Cadastra uma mídia a partir do link de um arquivo do Drive: converte para o link
// direto, baixa e guarda na biblioteca (o WhatsApp baixa do CRM, sempre funciona)
async function salvarMidiaDoLink(empresa, { link, nome, descricao, extra = {} }) {
  const arquivoId = idDoArquivoDrive(link);
  if (!arquivoId) throw Object.assign(new Error('Cole o link de um ARQUIVO do Google Drive (ex.: https://drive.google.com/file/d/…/view). Para pasta, use "Pasta do Drive".'), { status: 400 });
  let baixado;
  try {
    baixado = await baixarDoDrive(arquivoId);
  } catch (err) {
    throw Object.assign(new Error(`Não consegui baixar do Drive: ${err.message}.`), { status: 400 });
  }
  const ext = Object.entries(EXTENSOES).find(([, mime]) => mime === baixado.tipo)?.[0] || path.extname(baixado.nome || '') || '';
  const nomeArquivo = baixado.nome || `${nome || 'arquivo'}${ext}`;
  return salvarMidia(empresa, { buffer: baixado.buffer, nomeArquivo: path.extname(nomeArquivo) ? nomeArquivo : `${nomeArquivo}${ext}`, nome: nome || path.parse(nomeArquivo).name, descricao, mimetypeInformado: baixado.tipo, extra: { ...extra, origemLink: linkDiretoDrive(arquivoId).replace(DRIVE, 'https://drive.google.com') } });
}

const EXT_ACEITAS = /\.(jpe?g|png|webp|gif|mp4|3gp|mov|m4v|webm|mkv|avi|mp3|ogg|opus|m4a|aac|pdf)$/i;

// Adiciona ou sincroniza uma pasta. Retorna o resumo do que mudou.
async function sincronizarPasta(empresa, { link, nome, descricao, pastaExistente, chaveGoogle }) {
  const pastaId = pastaExistente?.driveId || idDaPasta(link);
  if (!pastaId) throw Object.assign(new Error('Link de pasta do Google Drive inválido. Copie o link da pasta (drive.google.com/drive/folders/…).'), { status: 400 });
  let lista;
  try {
    lista = await listarPastaPublica(pastaId);
    if (!lista.arquivos.length && chaveGoogle) lista = await listarPastaApi(pastaId, chaveGoogle).catch(() => lista);
  } catch (err) {
    if (!chaveGoogle) throw Object.assign(new Error(`Não consegui abrir a pasta do Drive (${err.message}). Confira se ela está compartilhada como "Qualquer pessoa com o link".`), { status: 400 });
    lista = await listarPastaApi(pastaId, chaveGoogle);
  }
  if (!lista.arquivos.length) {
    throw Object.assign(new Error('A pasta está vazia ou não está pública. No Drive: botão direito na pasta → Compartilhar → "Qualquer pessoa com o link".'), { status: 400 });
  }
  empresa.drivePastas = pastasDa(empresa);
  let pasta = pastaExistente;
  if (!pasta) {
    pasta = {
      id: crypto.randomBytes(8).toString('hex'),
      driveId: pastaId,
      nome: String(nome || lista.titulo || 'Fotos do Drive').trim().slice(0, 80),
      descricao: String(descricao || '').trim().slice(0, 300),
      criadoEm: agora()
    };
    empresa.drivePastas.push(pasta);
  }
  const noDrive = lista.arquivos.filter((a) => EXT_ACEITAS.test(a.nome)).slice(0, DRIVE_MAX_ARQUIVOS);
  const idsNoDrive = new Set(noDrive.map((a) => a.id));
  let adicionados = 0;
  let removidos = 0;
  const falhas = [];
  // saíram do Drive → saem do CRM
  for (const m of midiasDa(empresa).filter((x) => x.pastaId === pasta.id && !idsNoDrive.has(x.driveId))) {
    apagarMidia(empresa, m.id);
    removidos++;
  }
  const jaTem = new Set(midiasDa(empresa).filter((x) => x.pastaId === pasta.id).map((x) => x.driveId));
  for (const a of noDrive) {
    if (jaTem.has(a.id)) continue;
    try {
      const { buffer, tipo } = await baixarDoDrive(a.id);
      salvarMidia(empresa, {
        buffer,
        nomeArquivo: a.nome,
        nome: `${pasta.nome} · ${path.parse(a.nome).name}`.slice(0, 80),
        descricao: '',
        mimetypeInformado: tipo,
        extra: { pastaId: pasta.id, driveId: a.id, origem: 'drive' }
      });
      adicionados++;
    } catch (err) {
      falhas.push(`${a.nome}: ${err.message}`);
    }
  }
  pasta.ultimaSincronia = agora();
  pasta.total = midiasDa(empresa).filter((x) => x.pastaId === pasta.id).length;
  pasta.falhas = falhas.slice(0, 10);
  salvar();
  return { pasta, adicionados, removidos, falhas };
}

function apagarPasta(empresa, pastaId) {
  for (const m of midiasDa(empresa).filter((x) => x.pastaId === pastaId)) apagarMidia(empresa, m.id);
  empresa.drivePastas = pastasDa(empresa).filter((p) => p.id !== pastaId);
  salvar();
}

// ---------------------------------------------------------------- anexos das conversas
// Arquivos que o cliente mandou (ou a equipe mandou pelo painel). Ficam fora
// da pasta pública: só o painel (com login) consegue abrir.

function pastaAnexos(leadId) {
  return path.join(config.midiasDir, 'conversas', String(leadId).replace(/[^\w-]/g, ''));
}

const EXT_DO_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'application/pdf': '.pdf'
};

function salvarAnexo(leadId, buffer, mimetype, nomeOriginal) {
  const mime = String(mimetype || '').split(';')[0].trim() || 'application/octet-stream';
  const ext = EXT_DO_MIME[mime] || path.extname(String(nomeOriginal || '')).toLowerCase().replace(/[^.\w]/g, '').slice(0, 6) || '.bin';
  const arquivo = `${crypto.randomBytes(10).toString('hex')}${ext}`;
  fs.mkdirSync(pastaAnexos(leadId), { recursive: true });
  fs.writeFileSync(path.join(pastaAnexos(leadId), arquivo), buffer);
  return { arquivo, mimetype: mime, tipo: tipoDoMime(mime), nome: String(nomeOriginal || '').slice(0, 120), tamanho: buffer.length };
}

// Arquivo grande que a equipe mandou na conversa (chegou em pedaços): vai para a
// pasta da conversa, na qualidade original
function concluirAnexo(empresa, envioId, leadId) {
  const e = envios.get(envioId);
  if (!e || e.empresaId !== empresa.id) throw Object.assign(new Error('Envio não encontrado (comece de novo).'), { status: 404 });
  if (e.recebido !== e.tamanho) throw Object.assign(new Error('O arquivo não chegou inteiro. Tente de novo.'), { status: 400 });
  const mime = mimeDe(e.arquivo, e.tipo);
  const ext = EXT_DO_MIME[mime] || path.extname(e.arquivo).toLowerCase().replace(/[^.\w]/g, '').slice(0, 6) || '.bin';
  const arquivo = `${crypto.randomBytes(10).toString('hex')}${ext}`;
  fs.mkdirSync(pastaAnexos(leadId), { recursive: true });
  fs.renameSync(e.caminho, path.join(pastaAnexos(leadId), arquivo));
  envios.delete(envioId);
  return { arquivo, mimetype: mime, tipo: tipoDoMime(mime), nome: e.arquivo.slice(0, 120), tamanho: e.tamanho };
}

// Link temporário (6 h) para o WhatsApp baixar um anexo da conversa, que é privado
const linksTemporarios = new Map(); // token → { leadId, arquivo, mimetype, ate }
function linkTemporario(leadId, anexo) {
  const agoraMs = Date.now();
  for (const [t, l] of linksTemporarios) if (l.ate < agoraMs) linksTemporarios.delete(t);
  const token = crypto.randomBytes(24).toString('hex');
  linksTemporarios.set(token, { leadId, arquivo: anexo.arquivo, mimetype: anexo.mimetype, ate: agoraMs + 6 * 3600 * 1000 });
  return `${config.urlPublica}/anexo/${token}/${encodeURIComponent(nomeArquivoSeguro(anexo.nome || anexo.arquivo))}`;
}

function arquivoDoLink(token) {
  const l = linksTemporarios.get(String(token || ''));
  if (!l || l.ate < Date.now()) return null;
  const caminho = caminhoAnexo(l.leadId, l.arquivo);
  return caminho ? { caminho, mimetype: l.mimetype } : null;
}

function caminhoAnexo(leadId, arquivo) {
  if (!/^[a-f0-9]{20}\.[\w]{1,6}$/.test(String(arquivo))) return null;
  return path.join(pastaAnexos(leadId), arquivo);
}

function apagarAnexosDoLead(leadId) {
  try {
    fs.rmSync(pastaAnexos(leadId), { recursive: true, force: true });
  } catch {
    /* ignora */
  }
}

module.exports = {
  TAMANHO_MAXIMO,
  albunsDa,
  novoCodigo,
  validarCodigo,
  slugCodigo,
  codigoDaEntrada,
  codigoVisivel,
  idDoArquivoDrive,
  linkDiretoDrive,
  salvarMidiaDoLink,
  codigosCitados,
  instrucoesComMidias,
  conexaoCerta,
  codigosDoPrompt,
  avisosDoPrompt,
  pendenciasDoPrompt,
  conectarNoPrompt,
  sugerirMidias,
  codigosEmUso,
  listaEtapas,
  resolverPedido,
  iniciarEnvio,
  receberPedaco,
  concluirEnvio,
  TIPOS,
  tipoDoMime,
  prontaParaIa,
  assuntosDa,
  salvarAssuntos,
  listaAssuntos,
  acharParaEnviar,
  paraIa,
  linksDa,
  pastasDa,
  idDaPasta,
  sincronizarPasta,
  apagarPasta,
  salvarAnexo,
  caminhoAnexo,
  concluirAnexo,
  linkTemporario,
  arquivoDoLink,
  pastaAnexosDoLead: pastaAnexos,
  apagarAnexosDoLead,
  mimeDe,
  midiasDa,
  salvarMidia,
  apagarMidia,
  apagarTodasDa,
  caminhoDoArquivo,
  urlPublica,
  acharPorId,
  acharPorNome
};
