// Painel do DingDong CRM (páginas por hash).
// Dentro de cada empresa: Início, Leads, Disparos e, em "Configurar": Sobre a
// empresa, IA do site, IA do WhatsApp, Mídias, Etiquetas e etapas, Chave de IA.
// Cada tela explica em balões o que fazer, para o próprio empresário configurar.
'use strict';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const conteudo = $('#conteudo');
let sessao = null; // { usuario, empresa, provedores, urlPublica, versao }
let empresaAtual = null; // { id, nome, dados }
let atualizador = null; // setInterval de páginas que se atualizam sozinhas

// ---------------------------------------------------------------- utilidades

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(caminho, opcoes = {}) {
  const metodo = opcoes.method || 'GET';
  const r = await fetch(`api/${caminho}`, {
    method: metodo,
    headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: metodo === 'GET' ? undefined : JSON.stringify(opcoes.body || {})
  });
  if (r.status === 401) {
    location.href = 'login';
    throw new Error('Sessão expirada.');
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(dados.erro || `Erro ${r.status}`), { status: r.status, dados });
  return dados;
}

function aviso(texto, erro = false) {
  const t = document.createElement('div');
  t.className = `toast${erro ? ' erro' : ''}`;
  t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), erro ? 5000 : 2500);
}

function data(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function telefoneBonito(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (/^\d{10,11}$/.test(d)) d = `55${d}`; // salvo sem o 55
  // celular que o WhatsApp guarda sem o 9 (55 + DDD + 8 dígitos começando com 6-9): mostra com o 9
  if (/^55\d{2}[6-9]\d{7}$/.test(d)) d = `${d.slice(0, 4)}9${d.slice(4)}`;
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : d.length >= 8 && d.length <= 13 ? `+${d}` : '';
}

const ehAdmin = () => sessao?.usuario.papel === 'admin';

function formParaObjeto(form) {
  const dados = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') dados[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) dados[el.name] = el.value; }
    else dados[el.name] = el.value;
  }
  return dados;
}

function abrirModal(html, aoMontar) {
  const fundo = document.createElement('div');
  fundo.className = 'fundo-modal';
  fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const fechar = () => fundo.remove();
  fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
  fundo.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
  document.body.appendChild(fundo);
  $$('[data-fechar]', fundo).forEach((b) => b.addEventListener('click', fechar));
  aoMontar?.(fundo, fechar);
  fundo.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  return fechar;
}

// Confirmação bonita (no lugar do confirm() do navegador)
function confirmar({ titulo, texto, botao = 'Confirmar', perigo = false }) {
  return new Promise((resolve) => {
    let respondeu = false;
    const fechar = abrirModal(`
      <h2>${esc(titulo)}</h2>
      <div class="texto-modal">${texto}</div>
      <div class="acoes"><button type="button" class="${perigo ? 'perigo-cheio' : 'primario'}" id="sim">${esc(botao)}</button><button type="button" data-fechar>Cancelar</button></div>`, (m) => {
      $('#sim', m).onclick = () => { respondeu = true; fechar(); resolve(true); };
      $('#sim', m).focus();
      new MutationObserver((_, obs) => { if (!m.isConnected) { obs.disconnect(); if (!respondeu) resolve(false); } }).observe(document.body, { childList: true });
    });
  });
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    aviso('Copiado!');
  } catch {
    aviso('Não consegui copiar. Selecione o texto e copie manualmente.', true);
  }
}

// Botão com "carregando…" enquanto a ação roda
async function comEspera(botao, acao, texto = 'Aguarde…') {
  // sem botão (ex.: e.currentTarget depois de um "confirmar", que já é null): só executa
  if (!botao) return acao();
  const antes = botao.innerHTML;
  botao.disabled = true;
  botao.innerHTML = `<span class="girando"></span> ${esc(texto)}`;
  try {
    return await acao();
  } finally {
    botao.disabled = false;
    botao.innerHTML = antes;
  }
}

function codigoEmpresa(empresaId) {
  return `<script src="${sessao.urlPublica}/chat.js" data-empresa="${empresaId}" async></script>`;
}

const NOME_PROVEDOR = { anthropic: 'Claude (Anthropic)', openai: 'ChatGPT (OpenAI)', gemini: 'Gemini (Google)' };
const NOME_IA_CURTO = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini' };

// "12,3 mil" / "1,2 mi" — para mostrar tokens gastos
function numeroCurto(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return n.toLocaleString('pt-BR');
}
const rotaEmpresa = (id, sub = '') => `#/empresas/${id}${sub ? `/${sub}` : ''}`;
// código de mídia como aparece no prompt: #MIDIA_FOTO_ANTES (guardado como FOTO-ANTES)
const codMidia = (c) => (c ? `#MIDIA_${String(c).replace(/-/g, '_')}` : '');
const sem = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // sem acento, minúsculo (busca)

// ---------------------------------------------------------------- componentes de ajuda

// Balão explicativo (dica no topo das telas / seções)
function balao(titulo, html, tipo = 'dica') {
  // dica: fica recolhida num "ⓘ" (abre ao clicar) — deixa a tela limpa
  if (tipo === 'dica' && html) return `<details class="balao-dica"><summary><span class="i">i</span>${titulo}</summary><div class="balao-corpo">${html}</div></details>`;
  const icone = { dica: '💡', aviso: '⚠️', ok: '✅', passo: '👉' }[tipo] || '💡';
  return `<div class="balao balao-${tipo}"><span class="balao-icone">${icone}</span><div><strong>${titulo}</strong>${html ? `<div class="balao-texto">${html}</div>` : ''}</div></div>`;
}

// "?" ao lado de um campo: passa o mouse (ou toca) e aparece o balão
function ajuda(texto) {
  return `<span class="ajuda" tabindex="0" role="button" aria-label="Ajuda">?<span class="ajuda-balao" role="tooltip">${texto}</span></span>`;
}

// Passo a passo numerado em balões
function passos(lista) {
  return `<ol class="passos">${lista.map((p, i) => `<li><span class="passo-num">${i + 1}</span><div>${p}</div></li>`).join('')}</ol>`;
}

function interruptor(id, ligado, rotulo = '') {
  return `<label class="interruptor"><input type="checkbox" id="${id}" ${ligado ? 'checked' : ''}><span class="trilho"><span class="bolinha"></span></span>${rotulo ? `<span>${rotulo}</span>` : ''}</label>`;
}

function chipEtiqueta(t, extra = '') {
  return `<span class="chip" style="--cor:${esc(t.cor)}" ${extra}>${esc(t.nome)}</span>`;
}

// ---------------------------------------------------------------- ícones do menu

const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONES = {
  inicio: I('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>'),
  leads: I('<path d="M4 5h16v11H8l-4 4z"/>'),
  disparos: I('<path d="M3 10v4h3l6 4V6L6 10z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>'),
  cerebro: I('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/>'),
  site: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>'),
  whatsapp: I('<path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.1A8 8 0 1 1 20 12z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2z"/>'),
  midias: I('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  etiquetas: I('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
  chave: I('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>'),
  empresas: I('<path d="M4 21V5l8-2v18M12 8h8v13M8 8h.01M8 12h.01M8 16h.01M16 12h.01M16 16h.01"/>'),
  usuarios: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  config: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  visao: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  conversas: I('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M8 11h8M8 14h5"/>'),
  maquina: I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  agenda: I('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 14h3"/>'),
  followup: I('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  livro: I('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7M8 11h5"/>'),
  dinheiro: I('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>'),
  catalogo: I('<path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>')
};

// ---------------------------------------------------------------- tema e menu

const ICONE_SOL = I('<path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.4-6.4-1.4 1.4M6.4 17.6 5 19m13.4 0-1.4-1.4M6.4 6.4 5 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z"/>');
const ICONE_LUA = I('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>');

function ajustarBotaoTema() {
  const escuro = document.documentElement.classList.contains('dark');
  const b = $('#tema');
  b.innerHTML = escuro ? ICONE_SOL : ICONE_LUA;
  b.title = escuro ? 'Mudar para o modo claro' : 'Mudar para o modo escuro';
  const chave = $('#tema-menu');
  if (chave) chave.checked = escuro;
}

function alternarTema() {
  const escuro = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('dingdong_crm_tema', escuro ? 'escuro' : 'claro');
  } catch {
    /* modo privado: segue sem guardar */
  }
  ajustarBotaoTema();
}

function fecharMenu() {
  document.body.classList.remove('menu-aberto');
}

function montarMenu(ativo) {
  const item = (href, icone, rotulo, extra = '') =>
    `<a class="item-menu${href === ativo ? ' ativo' : ''}" href="${href}"><span class="icone-menu">${ICONES[icone]}</span><span class="rotulo-menu">${esc(rotulo)}</span>${extra}</a>`;
  let html = '';
  if (ehAdmin()) {
    html += item('#/', 'visao', 'Visão geral');
    html += item('#/empresas', 'empresas', 'Empresas');
  }
  if (empresaAtual) {
    const id = empresaAtual.id;
    const d = empresaAtual.dados || {};
    const ponto = (ligado) => `<span class="ponto ${ligado ? 'on' : 'off'}" title="${ligado ? 'Ligada' : 'Desligada'}"></span>`;
    const u = d.usoHoje || {};
    html += `<a class="empresa-menu" href="${rotaEmpresa(id)}">${avatarEmpresa(d)}<span class="empresa-menu-nome"><span>${esc(empresaAtual.nome)}</span><small class="tokens-hoje" title="Tokens de IA gastos hoje (${(u.chamadas || 0).toLocaleString('pt-BR')} chamadas)">🔢 ${numeroCurto(u.total)} tokens hoje</small></span></a>`;
    // tudo à vista, em 4 grupos (nada escondido), com busca no topo
    const st = d.status || {};
    const marca = (k) => (st[k] === 'ok' ? '<span class="marca-ok" title="Configurado">✓</span>' : st[k] === 'atencao' ? '<span class="marca-atencao" title="Precisa de atenção">!</span>' : st[k] ? '<span class="marca-off" title="Desligado">–</span>' : '');
    const extra = {
      '': (d.dicas || []).some((x) => x.nivel === 'erro') ? '<span class="ponto off" title="Algo precisa de atenção"></span>' : '',
      conversas: d.naoLidas ? `<span class="contador">${d.naoLidas > 99 ? '99+' : d.naoLidas}</span>` : '',
      agenda: d.agendaHoje ? `<span class="contador contador-agenda" title="Agendamentos de hoje">${d.agendaHoje}</span>` : '',
      whatsapp: d.whatsapp?.modoTeste ? '<span class="etiqueta aviso" style="padding:0 6px">teste</span>' : ''
    };
    const grupos = [
      ['Dia a dia', [
        ['', 'inicio', 'Início', 'painel resumo comeco primeiros passos'],
        ['conversas', 'conversas', 'Conversas', 'chat whatsapp mensagens responder clientes'],
        ['followup', 'followup', 'Follow-up', 'retomar sumiu parou de responder mensagens prontas sequencia'],
        ['agenda', 'agenda', 'Agendamentos', 'agenda horario marcado visita instalacao'],
        ['leads', 'leads', 'Leads (funil)', 'funil clientes kanban etapas contatos'],
        ['faturamento', 'dinheiro', 'Faturamento', 'vendas pix comprovante dinheiro valor obrigado pela preferencia gastos despesas lucro grupo categoria']
      ]],
      ['Vender no automático', [
        ['automacoes', 'maquina', 'Máquina de vendas', 'automacoes avaliacao google comentario anuncio pos-venda reativar'],
        ['disparos', 'disparos', 'Disparos em massa', 'campanha lista enviar para todos promocao']
      ]],
      ['Sua IA', [
        ['ia', 'cerebro', 'Sobre a empresa', 'treinar instrucoes conhecimento prompt nome atendente'],
        ['catalogo', 'catalogo', 'Serviços e preços', 'catalogo produtos preco tabela valores'],
        ['midias', 'midias', 'Mídias e respostas', 'fotos videos imagens respostas rapidas so follow-up sugestao de midia'],
        ['aprendizado', 'livro', 'Clone e aprendizados', 'clone aprender responder igual a mim aprendizado anuncios'],
        ['whatsapp', 'whatsapp', 'IA do WhatsApp', 'conectar qr code numero instrucoes aviso de agendamento etiquetas lista negra modo teste'],
        ['site', 'site', 'IA do site', 'chat do site codigo widget instalar']
      ]],
      ['Ajustes', [
        ['organizar', 'etiquetas', 'Etiquetas e etapas', 'etiquetas tickets etapas funil'],
        ['chave', 'chave', 'IAs e chaves', 'chave api claude gemini gpt openai tokens reserva']
      ]]
    ];
    html += '<div class="busca-menu"><input type="search" id="busca-menu" placeholder="🔎 Buscar (ex.: clone, pix, etiqueta)" aria-label="Buscar no painel" autocomplete="off"></div>';
    for (const [titulo, itens] of grupos) {
      html += `<div class="grupo-menu"><p class="titulo-grupo">${titulo}</p>`;
      for (const [k, icone, rotulo, palavras] of itens) {
        const a = item(rotaEmpresa(id, k || undefined), icone, rotulo, extra[k] || marca(k));
        html += a.replace('<a class="item-menu', `<a data-busca="${esc(sem(`${rotulo} ${palavras}`))}" class="item-menu`);
      }
      html += '</div>';
    }
  }
  if (ehAdmin()) {
    html += '<p class="titulo-grupo">Administração</p>';
    html += item('#/usuarios', 'usuarios', 'Usuários');
    html += item('#/configuracoes', 'config', 'Configurações do sistema');
  }
  $('#menu').innerHTML = html;
  // busca no menu: filtra pelo nome e por palavras (ex.: "clone", "pix", "qr code"); Enter abre a primeira
  const busca = $('#busca-menu');
  busca?.addEventListener('input', () => {
    const q = sem(busca.value).trim();
    $$('#menu .grupo-menu').forEach((g) => {
      let algum = false;
      $$('a[data-busca]', g).forEach((a) => { const ok = !q || q.split(/\s+/).every((p) => a.dataset.busca.includes(p)); a.hidden = !ok; if (ok) algum = true; });
      g.hidden = !algum;
    });
  });
  busca?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { busca.value = ''; busca.dispatchEvent(new Event('input')); }
    if (e.key !== 'Enter') return;
    const a = $$('#menu a[data-busca]').find((x) => !x.hidden);
    if (a) { location.hash = a.getAttribute('href'); busca.value = ''; fecharMenu(); }
  });
  $$('.lateral a').forEach((a) => {
    if (a.classList.contains('item-menu') && a.closest('.rodape-menu')) a.classList.toggle('ativo', a.getAttribute('href') === ativo);
    a.onclick = fecharMenu;
  });
}

async function definirEmpresaAtual(id) {
  if (!id) {
    empresaAtual = ehAdmin() ? null : empresaAtual;
    return null;
  }
  const dados = await api(`empresas/${id}`);
  empresaAtual = { id: dados.id, nome: dados.nome, dados };
  return dados;
}

// ---------------------------------------------------------------- de onde o cliente veio (site)
const ICONE_FONTE = { anuncio: '📣', busca: '🔎', rede: '📱', direto: '🌐', site: '🔗' };
function caminhoDe(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname.replace(/^www\./, '') : decodeURIComponent(u.pathname);
  } catch {
    return url;
  }
}
const nomePagina = (p) => p.titulo || caminhoDe(p.url);
const linkPagina = (p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.url)}">${esc(nomePagina(p))}</a>`;

// Linha curta (topo do chat): "📣 Anúncio Instagram · campanha verao · vendo: Volante em couro"
function linhaOrigem(o) {
  if (!o || (!o.fonte && !o.atual && !o.anuncio && !o.manual)) return '';
  const atual = o.atual || o.paginas?.[o.paginas.length - 1];
  const partes = [];
  if (o.fonte || atual) partes.push(`${ICONE_FONTE[o.tipo] || '🌐'} Veio ${o.fonte ? `de <b>${esc(o.fonte)}</b>` : 'do site'}`);
  if (o.anuncio) partes.push(`anúncio <b>${esc(o.anuncio.nome)}</b>`);
  else if (o.campanha) partes.push(`campanha <b>${esc(o.campanha)}</b>`);
  if (atual) partes.push(`estava vendo ${linkPagina(atual)}`);
  if (o.manual) partes.push(`📝 ${esc(o.manual)}`);
  return `<div class="chat-origem" title="${esc(partes.join(' · ').replace(/<[^>]+>/g, ''))}">${partes.join(' · ')}</div>`;
}

function cardOrigem(o, l) {
  o = o || {};
  const atual = o.atual || o.paginas?.[o.paginas.length - 1];
  const controles = l ? `
      <div class="secao" style="margin-top:12px;padding-top:12px">
        <div class="campo"><label>Anúncio / campanha ${ajuda('O CRM escolhe sozinho pelas palavras cadastradas em Clone e aprendizados → Anúncios. Se estiver errado, escolha aqui: a IA passa a usar as informações desse anúncio.')}</label><select id="origem-anuncio"><option value="">— nenhum —</option>${(l.anunciosEmpresa || []).map((a) => `<option value="${esc(a.id)}" ${o.anuncio?.id === a.id ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select>${(l.anunciosEmpresa || []).length ? '' : `<small><a href="${rotaEmpresa(l.empresaId, 'aprendizado')}">Cadastrar anúncios</a></small>`}</div>
        <div class="campo" style="margin-top:10px"><label>Anotação sobre a origem ${ajuda('A IA lê isto. Ex.: indicação do João, veio da feira, cliente antigo.')}</label><input id="origem-manual" maxlength="300" value="${esc(o.manual || '')}" placeholder="Ex.: indicação do João"></div>
        <div class="acoes" style="margin-top:10px"><button type="button" class="pequeno" id="salvar-origem">Salvar origem</button></div>
      </div>` : '';
  const utm = Object.entries(o.utm || {}).map(([k, v]) => `<span class="etiqueta">${esc(k)}: ${esc(v)}</span>`).join(' ');
  const outras = (o.paginas || []).filter((p) => p.url !== atual?.url && p.url !== o.chegada?.url).slice(-6).reverse();
  return `
    <div class="card origem-card">
      <h2 style="margin:0 0 10px;font-size:16px">De onde veio ${ajuda('O chat do site anota como o cliente chegou (anúncio, Google, Instagram…) e as páginas que ele viu. As duas IAs usam isso para entender o interesse dele.')}</h2>
      ${o.fonte || o.chegada ? `<div class="origem-fonte">${ICONE_FONTE[o.tipo] || '🌐'} <b>${esc(o.fonte || 'Site')}</b>${o.campanha ? `<span class="rotulo"> · campanha ${esc(o.campanha)}</span>` : ''}</div>` : '<p class="rotulo" style="margin:0">Sem informação automática (o cliente não passou pelo chat nem por um botão do site, nem por anúncio de clique para WhatsApp).</p>'}
      ${o.anuncio ? `<div style="margin-top:8px">📣 Anúncio: <b>${esc(o.anuncio.nome)}</b> <span class="rotulo">(${o.anuncio.por === 'equipe' ? 'escolhido pela equipe' : 'reconhecido pelo CRM'})</span></div>` : ''}
      ${o.anuncioMeta ? `<div class="rotulo" style="margin-top:6px">Anúncio do Meta: “${esc(o.anuncioMeta.titulo || o.anuncioMeta.url || o.anuncioMeta.id)}”${o.anuncioMeta.url ? ` · <a href="${esc(o.anuncioMeta.url)}" target="_blank" rel="noopener noreferrer">ver</a>` : ''}</div>` : ''}
      ${utm ? `<div class="chips" style="margin-top:8px">${utm}</div>` : ''}
      <dl class="origem-lista">
        ${o.chegada ? `<dt>Entrou por</dt><dd>${linkPagina(o.chegada)}${o.chegada.referrer ? `<span class="rotulo"> · vindo de ${esc(caminhoDe(o.chegada.referrer))}</span>` : ''}</dd>` : ''}
        ${atual ? `<dt>Estava vendo</dt><dd>${linkPagina(atual)}</dd>` : ''}
        ${outras.length ? `<dt>Também viu</dt><dd>${outras.map(linkPagina).join('<br>')}</dd>` : ''}
      </dl>
      ${controles}
    </div>`;
}

// "Precisa de atenção": dicas geradas por regras (sem IA) para configurar e resolver
function htmlDicas(emp, id, pular = []) {
  // não repete o que já está nos "Primeiros passos"
  const lista = (emp.dicas || []).filter((d) => !/pausada|Modo teste/.test(d.texto) && !(d.nivel !== 'erro' && pular.includes(d.sub)));
  if (!lista.length) return '';
  const ICONE = { erro: '🔴', aviso: '🟡', dica: '💡' };
  const ordem = { erro: 0, aviso: 1, dica: 2 };
  return `<div class="card dicas-card"><h2 style="margin:0 0 8px">${lista.some((d) => d.nivel === 'erro') ? '⚠️ Precisa de atenção' : '💡 Dicas para vender mais'}</h2>
    <ul class="lista-dicas">${lista.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]).map((d) => `<li class="${d.nivel}">${ICONE[d.nivel] || '💡'} <span>${esc(d.texto)}</span>${d.sub !== undefined ? `<a class="botao pequeno" href="${rotaEmpresa(id, d.sub)}">Resolver</a>` : ''}</li>`).join('')}</ul></div>`;
}

// Faixa vermelha quando a empresa está pausada (a IA e as automações não respondem ninguém)
function faixaPausada(emp) {
  if (!emp || emp.ativa !== false) return '';
  return `<div class="faixa-pausada">⏸️ <div><b>Esta empresa está pausada no CRM.</b> A IA do site, a do WhatsApp e as automações não respondem ninguém enquanto estiver pausada.</div>${ehAdmin() ? `<button type="button" class="primario pequeno" data-reativar="${esc(emp.id)}">Reativar a empresa</button>` : '<span class="rotulo">Peça ao administrador para reativar.</span>'}</div>`;
}

async function reativarEmpresa(empresaId, botao) {
  try {
    const r = await comEspera(botao, () => api(`empresas/${empresaId}/whatsapp/reativar-empresa`, { method: 'POST' }), 'Reativando…');
    aviso(r.respondendo ? `Empresa reativada. A IA já está respondendo ${r.respondendo} ${r.respondendo === 1 ? 'cliente que ficou' : 'clientes que ficaram'} esperando.` : 'Empresa reativada. A IA volta a responder as próximas mensagens.');
    rotear();
  } catch (err) {
    aviso(err.message, true);
  }
}

async function principalDa(empresaId) {
  const bots = await api(`bots?empresaId=${encodeURIComponent(empresaId)}`);
  return bots.find((b) => b.principal) || bots[0] || null;
}

// ---------------------------------------------------------------- visão geral (admin)

async function paginaInicio() {
  const hashDaPagina = location.hash;
  const [r, empresas] = await Promise.all([api('resumo'), api('empresas')]);
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Visão geral</h1><p class="sub">${empresas.length} ${empresas.length === 1 ? 'empresa' : 'empresas'} no CRM</p></div><button class="primario" id="nova">+ Nova empresa</button></div>
    <div class="grade-resumo compacta">
      ${numeroCard('Leads novos (7 dias)', r.leads7d)}
      ${numeroCard('Chegaram no WhatsApp (7 dias)', r.noWhatsapp7d)}
      ${numeroCard('Esperando a equipe', r.aguardandoEquipe, r.aguardandoEquipe ? 'destaque' : '')}
      ${numeroCard('Empresas ativas', `${empresas.filter((e) => e.ativa !== false).length}<small>/${r.empresas}</small>`)}
    </div>
    <h2 class="secao-titulo">Empresas</h2>
    ${gradeEmpresas(empresas)}
    ${tabelaTokens(empresas)}`;
  $('#nova').onclick = () => modalEmpresa();
  $('#nova-cartao')?.addEventListener('click', () => modalEmpresa());
  ligarExcluirEmpresas(empresas, () => paginaInicio());
  $$('[data-ir-empresa]').forEach((tr) => { tr.onclick = () => { location.hash = rotaEmpresa(tr.dataset.irEmpresa); }; });
}

function numeroCard(rotulo, valor, classe = '') {
  return `<div class="card numero-card ${classe}"><div class="rotulo">${esc(rotulo)}</div><div class="numero">${valor}</div></div>`;
}

async function paginaEmpresas() {
  const hashDaPagina = location.hash;
  const lista = await api('empresas');
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Empresas</h1><p class="sub">Cada empresa tem as próprias IAs, chave de IA, WhatsApp e leads.</p></div><button class="primario" id="nova">+ Nova empresa</button></div>
    ${gradeEmpresas(lista)}
    ${ehAdmin() ? tabelaTokens(lista) : ''}`;
  $('#nova').onclick = () => modalEmpresa();
  $('#nova-cartao')?.addEventListener('click', () => modalEmpresa());
  ligarExcluirEmpresas(lista, () => paginaEmpresas());
  $$('[data-ir-empresa]').forEach((tr) => { tr.onclick = () => { location.hash = rotaEmpresa(tr.dataset.irEmpresa); }; });
}

// Excluir empresa: pede para digitar o nome (não dá para desfazer pelo painel)
function excluirEmpresa(emp, depois) {
  abrirModal(`
    <h2>🗑️ Excluir "${esc(emp.nome)}"?</h2>
    <p>Apaga a empresa com <b>todos os leads, conversas, mídias, vendas, automações, disparos e usuários</b> dela. Não dá para desfazer pelo painel.</p>
    <p class="rotulo">Se foi sem querer, o administrador ainda consegue voltar pelo backup automático do servidor (pasta <code>backups/</code>).</p>
    <form id="f-excluir-emp">
      <div class="campo"><label>Para confirmar, digite o nome da empresa: <b>${esc(emp.nome)}</b></label><input name="nome" autocomplete="off" required></div>
      <div class="acoes"><button type="submit" class="perigo" disabled>Excluir para sempre</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    const f = $('#f-excluir-emp', m);
    const botao = $('button[type=submit]', f);
    f.elements.nome.oninput = () => { botao.disabled = f.elements.nome.value.trim().toLowerCase() !== emp.nome.trim().toLowerCase(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (botao.disabled) return;
      try {
        await comEspera(botao, () => api(`empresas/${emp.id}`, { method: 'DELETE' }), 'Excluindo…');
        fechar();
        aviso(`Empresa "${emp.nome}" excluída.`);
        if (empresaAtual?.id === emp.id) empresaAtual = null;
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

function ligarExcluirEmpresas(lista, depois) {
  $$('[data-excluir-empresa]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      excluirEmpresa(lista.find((x) => x.id === b.dataset.excluirEmpresa), depois);
    };
  });
}

// Tokens de IA gastos, separados por empresa (hoje, 7 e 30 dias)
function tabelaTokens(lista) {
  const linhas = [...lista].sort((a, b) => (b.uso30d?.total || 0) - (a.uso30d?.total || 0));
  const total = (k) => linhas.reduce((n, e) => n + (e[k]?.total || 0), 0);
  const porIa = (u) => Object.entries(u?.porIa || {}).map(([p, n]) => `${NOME_IA_CURTO[p] || p} ${numeroCurto(n)}`).join(' · ') || '—';
  return `
    <div class="card tabela-wrap tokens-tabela">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">Uso de IA por empresa</h2><span class="rotulo">cada empresa tem a própria conta</span></div>
      <table>
        <thead><tr><th>Empresa</th><th class="num">Hoje</th><th class="num">7 dias</th><th class="num">30 dias</th><th class="esconde-mobile">Por IA (30 dias)</th><th class="esconde-mobile num">Chamadas (30 d)</th></tr></thead>
        <tbody>
          ${linhas.map((e) => `<tr class="clicavel" data-ir-empresa="${esc(e.id)}"><td><b>${esc(e.nome)}</b></td><td class="num">${numeroCurto(e.usoHoje?.total)}</td><td class="num">${numeroCurto(e.uso7d?.total)}</td><td class="num"><b>${numeroCurto(e.uso30d?.total)}</b></td><td class="esconde-mobile rotulo">${porIa(e.uso30d)}</td><td class="esconde-mobile num">${(e.uso30d?.chamadas || 0).toLocaleString('pt-BR')}</td></tr>`).join('') || '<tr><td colspan="6" class="rotulo">Nenhuma empresa.</td></tr>'}
        </tbody>
        ${linhas.length > 1 ? `<tfoot><tr><td><b>Total</b></td><td class="num">${numeroCurto(total('usoHoje'))}</td><td class="num">${numeroCurto(total('uso7d'))}</td><td class="num"><b>${numeroCurto(total('uso30d'))}</b></td><td class="esconde-mobile"></td><td class="esconde-mobile"></td></tr></tfoot>` : ''}
      </table>
      <p class="rotulo" style="margin:8px 0 0">Token ≈ 4 letras. Inclui respostas, fotos, áudios, comprovantes lidos pela IA e a varredura dos aprendizados. A parte que vem do cache custa ~10% do preço.</p>
    </div>`;
}

function modalEmpresa(emp) {
  abrirModal(`
    <h2>${emp ? 'Editar empresa' : 'Nova empresa'}</h2>
    <form id="f-emp">
      ${emp ? `<div class="logo-editar">${avatarEmpresa(emp, 'grande')}<div><b>Foto / logo da empresa</b><div class="rotulo">Aparece no painel e no chat do site (se o assistente não tiver outra foto).</div><div class="acoes" style="margin-top:6px"><button type="button" class="pequeno" id="trocar-logo">${emp.logoUrl ? 'Trocar foto' : 'Adicionar foto'}</button>${emp.logoUrl ? '<button type="button" class="pequeno perigo" id="tirar-logo">Remover</button>' : ''}</div></div></div>` : ''}
      <div class="campos">
        <div class="campo largo"><label>Nome da empresa *</label><input name="nome" required value="${esc(emp?.nome)}"></div>
        <div class="campo"><label>Ramo ${ajuda('Ex.: estética automotiva, clínica odontológica, loja de roupas. Ajuda a IA a entender o negócio.')}</label><input name="nicho" placeholder="Ex.: estética automotiva" value="${esc(emp?.nicho)}"></div>
        <div class="campo"><label>Responsável</label><input name="responsavel" value="${esc(emp?.responsavel)}"></div>
        <div class="campo largo"><label>WhatsApp para atendimento ${ajuda('Para onde o chat do site manda o cliente. Pode deixar vazio: se o WhatsApp estiver conectado no CRM, usamos o número conectado.')}</label><input name="whatsapp" placeholder="(21) 99999-9999 — opcional" value="${esc(emp?.whatsappNumero)}"></div>
        ${emp ? '' : `<div class="campo largo"><label>Site da empresa ${ajuda('O chat só aparece nos sites informados aqui. Pode preencher depois em IA do site.')}</label><input name="sites" placeholder="minhaloja.com.br"></div>`}
        <div class="campo largo"><label>Observações internas</label><textarea name="observacoes">${esc(emp?.observacoes)}</textarea></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativa" ${emp?.ativa === false ? '' : 'checked'}> Empresa ativa (desmarque para pausar tudo dela)</label></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="usarChavePadrao" ${emp && emp.usarChavePadrao !== false ? 'checked' : ''}> Pode usar a chave de IA do administrador quando não tiver a própria ${ajuda('Desmarcado = a empresa usa só as chaves que ela mesma cadastrou em IAs e chaves (e paga os próprios tokens). Marcado = sem chave própria, usa a chave padrão das Configurações do sistema e o custo sai da sua conta.')}</label></div>
      </div>
      <div class="acoes">
        <button class="primario" type="submit">Salvar</button>
        <button type="button" data-fechar>Cancelar</button>
        ${emp ? '<button type="button" class="perigo" id="excluir" style="margin-left:auto">Excluir empresa</button>' : ''}
      </div>
    </form>`, (m, fechar) => {
    $('#f-emp', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const salva = await api(emp ? `empresas/${emp.id}` : 'empresas', { method: emp ? 'PUT' : 'POST', body: formParaObjeto(e.target) });
        fechar();
        aviso(emp ? 'Empresa salva.' : 'Empresa criada! Siga os primeiros passos.');
        empresaAtual = null;
        location.hash = rotaEmpresa(salva.id);
        if (emp) rotear();
      } catch (err) { aviso(err.message, true); }
    };
    $('#trocar-logo', m)?.addEventListener('click', () => escolherLogo(emp, () => { fechar(); empresaAtual = null; rotear(); }));
    $('#tirar-logo', m)?.addEventListener('click', async () => {
      await api(`empresas/${emp.id}/logo`, { method: 'DELETE' }).catch((err) => aviso(err.message, true));
      fechar();
      empresaAtual = null;
      rotear();
    });
    const excluir = $('#excluir', m);
    if (excluir) excluir.onclick = () => {
      fechar();
      excluirEmpresa(emp, () => { empresaAtual = null; location.hash = '#/empresas'; });
    };
  });
}

// ---------------------------------------------------------------- empresa: início

async function paginaEmpresa(id) {
  const hashDaPagina = location.hash;
  const [emp, r, principal] = await Promise.all([definirEmpresaAtual(id), api(`resumo?empresaId=${encodeURIComponent(id)}`), principalDa(id)]);
  const provedor = principal?.provedor || 'anthropic';
  const temChave = Boolean(emp.chaves?.[provedor]?.funciona);
  const zap = emp.whatsapp || {};
  const perfil = zap.perfil || {};
  const siteLigado = emp.canais.site;
  const zapLigado = emp.canais.whatsapp;

  const lista = [
    { feito: temChave, texto: 'Cadastre a chave de IA', dica: 'É o "motor" das IAs. Grátis para começar no Gemini.', href: rotaEmpresa(id, 'chave') },
    { feito: Boolean(principal && (principal.conhecimento || '').replace(/\.\.\.|R\$ \.\.\./g, '').trim().length > 150), texto: 'Conte para a IA sobre a sua empresa', dica: 'Como vocês atendem, horários, região, dúvidas comuns.', href: rotaEmpresa(id, 'ia') },
    { feito: emp.totalCatalogo > 0, texto: 'Cadastre seus serviços e preços', dica: 'A IA consulta esta lista em toda resposta — mudou o preço, vale na hora.', href: rotaEmpresa(id, 'catalogo') }
  ];
  if (siteLigado) lista.push({ feito: Object.keys(r.porEtapa).length > 0 || r.totalLeads > 0, texto: 'Coloque o chat no seu site', dica: 'Copie e cole um código uma vez só.', href: rotaEmpresa(id, 'site') });
  if (zapLigado) lista.push({ feito: Boolean(zap.configurado), texto: 'Conecte o WhatsApp', dica: 'Clique em Gerar QR code e escaneie com o celular.', href: rotaEmpresa(id, 'whatsapp') });
  if (zapLigado) lista.push({ feito: emp.totalMidias > 0 || (emp.links || []).length > 0, texto: 'Coloque fotos (ou uma pasta do Drive) e links para a IA usar', dica: 'Mostrar o trabalho vende: a IA manda quando o cliente pedir.', href: rotaEmpresa(id, 'midias') });
  if (zapLigado) lista.push({ feito: emp.followupAtivo || (emp.automacoes || []).some((a) => a.ativa), texto: 'Ligue a máquina de vendas', dica: 'Recuperar vendas e pedir avaliações no Google, no automático.', href: rotaEmpresa(id, 'automacoes') });
  const feitos = lista.filter((p) => p.feito).length;
  const tudoPronto = feitos === lista.length;

  const cartaoCanal = (tipo) => {
    const site = tipo === 'site';
    const ligado = site ? siteLigado : zapLigado;
    let detalhe;
    if (site) {
      detalhe = ligado ? 'Responde os visitantes no chat do seu site.' : 'O chat não aparece no site.';
    } else if (!zap.configurado) {
      detalhe = `<a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp →</a>`;
    } else {
      detalhe = `${perfil.foto ? `<img class="mini-foto" src="${esc(perfil.foto)}" alt="" onerror="this.remove()">` : ''}<span>${esc(perfil.nome || 'WhatsApp conectado')}${perfil.numero ? ` · ${esc(telefoneBonito(perfil.numero))}` : ''}</span>`;
    }
    return `
      <div class="card canal ${ligado ? 'ligado' : ''}">
        <div class="canal-topo">
          <span class="canal-icone ${tipo}">${ICONES[site ? 'site' : 'whatsapp']}</span>
          <div class="canal-titulo"><strong>${site ? 'IA do site' : 'IA do WhatsApp'}</strong><span class="rotulo">${ligado ? 'Ligada' : 'Desligada'}</span></div>
          ${interruptor(`canal-${tipo}`, ligado)}
        </div>
        <div class="canal-detalhe">${detalhe}</div>
        <a class="botao pequeno" href="${rotaEmpresa(id, site ? 'site' : 'whatsapp')}">Configurar</a>
      </div>`;
  };

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho">
      <div class="titulo-empresa"><button type="button" class="logo-botao" id="logo-inicio" title="Trocar a foto da empresa">${avatarEmpresa(emp, 'grande')}<span class="logo-lapis">✎</span></button><div><h1>${esc(emp.nome)}</h1><p class="sub">${esc(emp.nicho || 'Painel da empresa')} · faturamento no mês: <a href="${rotaEmpresa(id, 'faturamento')}"><b>${brl(emp.faturamentoMes)}</b></a></p></div></div>
      ${ehAdmin() ? '<button type="button" id="editar-emp">Editar empresa</button>' : ''}
    </div>

    ${tudoPronto ? '' : `
    <div class="card primeiros-passos">
      <div class="pp-topo"><div><h2 style="margin:0">Primeiros passos</h2><p class="rotulo" style="margin:2px 0 0">${feitos} de ${lista.length} prontos — siga na ordem, leva poucos minutos.</p></div><div class="progresso"><span style="width:${Math.round((feitos / lista.length) * 100)}%"></span></div></div>
      <ul class="checklist">
        ${lista.map((p, i) => `<li class="${p.feito ? 'feito' : ''}"><span class="bola">${p.feito ? '✓' : i + 1}</span><a href="${p.href}"><strong>${esc(p.texto)}</strong><span class="rotulo">${esc(p.dica)}</span></a></li>`).join('')}
      </ul>
    </div>`}

    ${faixaPausada(emp)}
    ${htmlDicas(emp, id, tudoPronto ? [] : lista.filter((p) => !p.feito).map((p) => p.href.split('/').pop()))}
    ${zap.modoTeste ? balao('🧪 Modo teste ligado', `A IA do WhatsApp só está respondendo: <b>${esc((zap.numerosTeste || '').split(/,\s*/).filter(Boolean).map(telefoneBonito).join(', '))}</b>. Os outros clientes não recebem resposta automática. <button type="button" class="pequeno" data-desligar-teste="${esc(id)}">Desligar o modo teste</button>`, 'aviso') : ''}
    <h2>Seus atendentes de IA</h2>
    ${balao('Duas IAs, um atendimento só', 'A <b>IA do site</b> tira as dúvidas no chat do site e, quando o cliente quer avançar, manda ele para o WhatsApp. Lá a <b>IA do WhatsApp</b> continua a mesma conversa, de onde parou. Pode usar as duas juntas ou só uma delas — é só ligar ou desligar aqui.')}
    <div class="canais">${cartaoCanal('site')}${cartaoCanal('whatsapp')}</div>

    <div class="grade-resumo" style="margin-top:8px">
      ${numeroCard('Leads novos (7 dias)', r.leads7d)}
      ${numeroCard('Chegaram no WhatsApp (7 dias)', r.noWhatsapp7d)}
      ${numeroCard('Esperando a equipe', r.aguardandoEquipe, r.aguardandoEquipe ? 'destaque' : '')}
      ${numeroCard('Disparos em andamento', r.disparosAtivos)}
    </div>
    <div class="card maquina-card">
      <div class="maquina-topo"><span class="canal-icone maquina">${ICONES.maquina}</span><div><h2 style="margin:0">Máquina de vendas</h2><p class="rotulo" style="margin:2px 0 0">Mensagens automáticas: recuperar quem sumiu, pedir avaliação no Google, reativar quem desistiu.</p></div><a class="botao primario pequeno" href="${rotaEmpresa(id, 'automacoes')}">${emp.followupAtivo || (emp.automacoes || []).some((a) => a.ativa) ? 'Ver automações' : 'Ligar agora'}</a></div>
      <div class="automacao-numeros"><span><b>${r.automaticas7d}</b> mensagens automáticas (7 dias)</span><span><b>${r.recuperados7d}</b> clientes responderam depois</span></div>
    </div>
    ${r.aguardandoEquipe ? balao(`${r.aguardandoEquipe} ${r.aguardandoEquipe === 1 ? 'cliente está' : 'clientes estão'} esperando alguém da equipe`, `A IA passou o atendimento para vocês. <a href="${rotaEmpresa(id, 'leads')}">Ver leads</a>`, 'aviso') : ''}

    <div class="card">
      <div class="cabecalho" style="margin-bottom:12px;padding-right:0"><h2 style="margin:0">Funil de leads</h2><a class="botao pequeno" href="${rotaEmpresa(id, 'leads')}">Abrir leads</a></div>
      <div class="funil">
        ${emp.etapas.map((e) => `<a class="funil-etapa" href="${rotaEmpresa(id, 'leads')}"><span class="rotulo">${esc(e)}</span><strong>${r.porEtapa[e] || 0}</strong></a>`).join('')}
      </div>
    </div>
    ${(r.porFonte || []).length ? `
    <div class="card">
      <h2 style="margin:0 0 4px">De onde vêm seus clientes</h2>
      <p class="rotulo" style="margin:0 0 12px">Leads dos últimos 30 dias, pela forma como chegaram ${ajuda('Para saber qual anúncio ou campanha trouxe cada cliente, use links com UTM (ex.: ?utm_source=instagram&utm_medium=paid&utm_campaign=promo). O Google Ads e o Facebook Ads já são reconhecidos sozinhos.')}</p>
      <div class="fontes">${(() => { const max = Math.max(...r.porFonte.map((f) => f.n)); return r.porFonte.map((f) => `<div class="fonte-linha"><span class="fonte-nome">${esc(f.fonte)}</span><span class="fonte-barra"><span style="width:${Math.max(4, Math.round((f.n / max) * 100))}%"></span></span><b>${f.n}</b></div>`).join(''); })()}</div>
    </div>` : ''}`;
  $('#editar-emp')?.addEventListener('click', () => modalEmpresa(emp));
  $('#logo-inicio').onclick = () => escolherLogo(emp, () => paginaEmpresa(id).then(() => montarMenu(rotaEmpresa(id))));
  for (const tipo of ['site', 'whatsapp']) {
    $(`#canal-${tipo}`).onchange = async (e) => {
      const ligado = e.target.checked;
      try {
        await api(`empresas/${id}/canais`, { method: 'PUT', body: { [tipo]: ligado } });
        aviso(`${tipo === 'site' ? 'IA do site' : 'IA do WhatsApp'} ${ligado ? 'ligada' : 'desligada'}.`);
        paginaEmpresa(id).then(() => montarMenu(rotaEmpresa(id)));
      } catch (err) {
        e.target.checked = !ligado;
        aviso(err.message, true);
      }
    };
  }
}

// ---------------------------------------------------------------- chat de teste (reusado)

function htmlChatTeste(canal, desativado) {
  return `
    <div class="card teste ${canal}">
      <div class="cab"><span>${canal === 'whatsapp' ? '🧪 Modo teste da IA do WhatsApp' : 'Teste a IA do site'}</span><button type="button" class="pequeno" id="limpar">Recomeçar</button></div>
      <div class="chat" id="chat"></div>
      ${canal === 'whatsapp' ? `<div class="eventos-teste" id="eventos-teste"><span class="rotulo">Simular aviso interno:</span>${['SEM_RESPOSTA', 'CHECAR_VIDEO', 'FOLLOWUP_1'].map((e) => `<button type="button" class="pequeno" data-evento-teste="${e}" ${desativado ? 'disabled' : ''}>[${e}]</button>`).join('')}</div>` : ''}
      <form id="f-teste"><input id="msg-teste" placeholder="${desativado ? 'Salve primeiro para testar' : 'Escreva como se fosse um cliente…'}" ${desativado ? 'disabled' : ''} autocomplete="off"><button class="primario" ${desativado ? 'disabled' : ''}>Enviar</button></form>
      <p class="rotulo nota-teste">${canal === 'whatsapp' ? 'Mostra a resposta, os códigos que a IA escreveu e qual mídia seria enviada. Nada é enviado pelo WhatsApp.' : 'Teste usa o que está na tela, mesmo sem salvar. Nada é enviado de verdade.'}</p>
    </div>`;
}

const STATUS_MIDIA = { enviaria: ['ok', '✓ seria enviada'], enviada: ['ok', '✓ enviada'], 'ja-enviada': ['off', '↺ já enviada — não repete'], 'nao-existe': ['erro', '✕ código não existe no cadastro'], inativa: ['aviso', '⚠ mídia desativada'], pulada: ['off', '⏭ pulada'], erro: ['erro', '✕ falhou ao enviar'] };
const TIPO_MIDIA_TXT = { image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'documento' };

// Detalhes técnicos de uma resposta (modo teste e log): códigos, mídias, avisos e texto bruto
function htmlDetalhesResposta(r) {
  const cods = r.codigos || [];
  const mids = r.midiasPlanejadas || r.midias || [];
  const erros = [...(r.erros || []), ...mids.filter((m) => ['nao-existe', 'erro', 'inativa'].includes(m.status)).map((m) => `${m.codigo}: ${m.motivo || STATUS_MIDIA[m.status]?.[1] || ''}`)];
  return `<div class="detalhes-ia">
    ${cods.length ? `<div><span class="rotulo">Códigos detectados:</span> ${cods.map((c) => `<span class="cod-det ${esc(c.tipo)}" title="${esc({ midia: 'mídia', controle: 'controle', acao: 'ação', desconhecido: 'código desconhecido (apagado do texto)' }[c.tipo] || c.tipo)}">${esc(c.codigo)}</span>`).join(' ')}</div>` : '<div class="rotulo">Nenhum código na resposta.</div>'}
    ${mids.length ? `<div class="midias-det">${mids.map((m) => { const [cls, txt] = STATUS_MIDIA[m.status] || ['off', m.status]; return `<div class="midia-det ${cls}">${m.url && m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span class="ic">${ICONE_TIPO[m.tipo] || '📎'}</span>`}<span><b>${esc(m.codigo)}</b>${m.nome ? ` · ${esc(m.nome)}` : ''}${m.tipo ? ` · ${TIPO_MIDIA_TXT[m.tipo] || m.tipo}` : ''}<br><span class="rotulo">${txt}${m.motivo ? ` — ${esc(m.motivo)}` : ''}${m.endpoint ? ` · ${esc(m.endpoint)}` : ''}${m.evolution?.id ? ` · id ${esc(m.evolution.id)}` : ''}${m.legenda ? ` · legenda: “${esc(m.legenda)}”` : ''}</span></span></div>`; }).join('')}</div>` : ''}
    ${(r.avisos || []).map((a) => `<div class="det-aviso">⚠️ ${esc(a)}</div>`).join('')}
    ${erros.map((e) => `<div class="det-erro">✕ ${esc(e)}</div>`).join('')}
    ${r.bruto ? `<details><summary>Texto bruto da IA</summary><pre class="bruto-ia">${esc(r.bruto)}</pre></details>` : ''}
  </div>`;
}

function ligarChatTeste({ botId, canal, rascunho, saudacao }) {
  const chat = $('#chat');
  let historico = [];
  let midiasEnviadas = [];
  const bolha = (classe, texto, html = false) => {
    const d = document.createElement('div');
    d.className = `msg ${classe}`;
    if (html) d.innerHTML = texto;
    else d.textContent = texto;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  };
  const reiniciar = () => {
    historico = [];
    midiasEnviadas = [];
    chat.innerHTML = '';
    if (canal === 'site') bolha('bot', saudacao() || 'Olá! Como posso ajudar?');
    else bolha('acao-ia', 'Mande uma mensagem como se fosse um cliente chegando no WhatsApp.');
  };
  reiniciar();
  $('#limpar').onclick = reiniciar;
  const perguntar = async (botao, evento) => {
    const esperando = bolha('bot digitando', '<span></span><span></span><span></span>', true);
    botao.disabled = true;
    try {
      const corpo = { mensagens: historico, canal, midiasEnviadas, ...(evento ? { evento } : {}), ...(rascunho ? { bot: rascunho() } : { usarSalvo: true }) };
      const r = await api(`bots/${botId}/testar`, { method: 'POST', body: corpo });
      if (r.resposta) {
        esperando.className = 'msg bot';
        esperando.innerHTML = esc(r.resposta).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
        historico.push({ papel: 'assistente', texto: r.resposta });
      } else {
        esperando.className = 'msg acao-ia';
        esperando.textContent = r.nada ? '🤐 A IA decidiu não mandar nada (#NADA).' : '(sem texto)';
      }
      for (const m of r.midiasPlanejadas || []) {
        if (m.status !== 'enviaria') continue;
        midiasEnviadas.push(m.codigo);
        historico.push({ papel: 'assistente', texto: `[enviou a mídia: ${m.codigo} — ${m.nome}]` });
      }
      const acoes = [
        ...(canal === 'whatsapp' ? [] : (r.midias || []).map((m) => `📎 enviaria a mídia "${m}"`)),
        ...(r.etiquetas || []).map((t) => `🏷️ colocaria a etiqueta "${t}"`),
        r.etapa ? `➜ moveria o lead para "${r.etapa}"` : '',
        r.humano ? '⏸️ #PAUSAR: pausaria a IA neste contato depois dos envios (a equipe assume)' : ''
      ].filter(Boolean);
      if (acoes.length) bolha('acao-ia', acoes.join('\n'));
      if (canal === 'whatsapp') bolha('detalhes', htmlDetalhesResposta(r), true);
      if (r.whatsappUrl) {
        const a = document.createElement('a');
        a.className = 'cta';
        a.href = r.whatsappUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Continuar no WhatsApp →';
        chat.appendChild(a);
      }
      chat.scrollTop = chat.scrollHeight;
      return true;
    } catch (err) {
      esperando.className = 'msg erro';
      esperando.textContent = err.message;
      return false;
    } finally {
      botao.disabled = false;
    }
  };
  $('#f-teste').onsubmit = async (e) => {
    e.preventDefault();
    const campo = $('#msg-teste');
    const texto = campo.value.trim();
    if (!texto || !botId) return;
    campo.value = '';
    bolha('eu', texto);
    historico.push({ papel: 'visitante', texto });
    if (!(await perguntar(e.target.querySelector('button')))) historico.pop();
    campo.focus();
  };
  $$('[data-evento-teste]').forEach((b) => {
    b.onclick = async () => {
      if (!historico.some((m) => m.papel === 'visitante')) return aviso('Mande primeiro uma mensagem como cliente.', true);
      bolha('acao-ia', `⚙️ aviso interno [${b.dataset.eventoTeste}] (o cliente não vê)`);
      await perguntar(b, b.dataset.eventoTeste);
    };
  });
}

async function salvarBot(botId, form, mensagem = 'Salvo!') {
  await api(`bots/${botId}`, { method: 'PUT', body: formParaObjeto(form) });
  aviso(mensagem);
  form._atualizarPainel?.();
}

// Painel ao lado das instruções: última mudança, se a IA está usando, última
// conferência, alterações não salvas, regras conferidas sozinhas e histórico
function painelInstrucoes(form, botId, canal) {
  const campo = canal === 'whatsapp' ? 'promptWhatsapp' : 'regras';
  const area = form.elements[campo];
  if (!area) return;
  let painel = form.querySelector('.painel-instr');
  if (!painel) {
    painel = document.createElement('div');
    painel.className = 'painel-instr';
    area.closest('.campo').after(painel);
  }
  let bot = null;
  const desenhar = () => {
    if (!bot) return;
    const ed = bot.instrucoesEditadas?.[canal];
    const conf = bot.ultimaConferencia?.[canal];
    const salvo = String(bot[campo] || '');
    const mudou = area.value !== salvo;
    const hist = (bot.historicoInstrucoes || []).filter((h) => h.canal === canal);
    const pn = canal === 'whatsapp' ? bot.promptNovo : null;
    painel.innerHTML = `
      <div class="pi-linhas">
        <div class="pi-linha"><span class="pi-rot">Última mudança</span><span>${ed ? `<b>${esc(data(ed.em))}</b>${ed.por ? ` · ${esc(ed.por)}` : ''} · ${ed.caracteres} caracteres` : salvo ? 'antes do histórico começar' : '<span class="rotulo">nenhuma instrução salva</span>'}</span></div>
        <div class="pi-linha"><span class="pi-rot">Situação</span><span>${mudou ? '<span class="pi-tag aviso">● Alterações não salvas — a IA ainda usa a versão anterior</span>' : salvo ? '<span class="pi-tag ok">● Em uso pela IA</span> <span class="rotulo">vale na próxima mensagem de qualquer conversa</span>' : '<span class="pi-tag">● Sem instruções — a IA segue só o padrão</span>'}</span></div>
        <div class="pi-linha"><span class="pi-rot">Última conferência</span><span>${conf ? `${conf.antiga ? '<span class="pi-tag aviso">desatualizada (o texto mudou depois)</span> ' : `<span class="pi-tag ${conf.nota === 'ok' ? 'ok' : 'aviso'}">${esc(conf.placar)}</span> `}<span class="rotulo">${esc(data(conf.em))}</span>` : '<span class="rotulo">nunca — clique em <b>Atualizar e conferir</b></span>'}</span></div>
        ${pn ? `<div class="pi-linha"><span class="pi-rot">Só o prompt novo</span><span><span class="pi-tag ok">● Desde ${esc(data(pn.em))}</span> <span class="rotulo">a IA não usa ${[pn.guardado?.cloneResponder ? 'o clone' : '', pn.guardado?.aprendizadosNoPrompt ? 'os aprendizados' : ''].filter(Boolean).join(' nem ') || 'clone nem aprendizados'} e não imita as respostas antigas das conversas.</span> <button type="button" class="pequeno" data-voltar-prompt>↩️ Voltar clone e aprendizados</button></span></div>` : ''}
      </div>
      ${hist.length ? `<details class="pi-hist"><summary>Versões anteriores (${hist.length})</summary>${hist.map((h, i) => `<div class="pi-versao"><div class="rotulo">Usada até ${esc(data(h.ate))}${h.por ? ` · trocada por ${esc(h.por)}` : ''}</div><pre>${esc(h.texto.length > 400 ? `${h.texto.slice(0, 400)}…` : h.texto)}</pre><button type="button" class="pequeno" data-restaurar="${i}">Usar esta versão</button></div>`).join('')}</details>` : ''}`;
    painel.querySelector('[data-voltar-prompt]')?.addEventListener('click', async (e) => {
      if (!(await confirmar({ titulo: 'Voltar o clone e os aprendizados?', texto: 'A IA volta a usar o clone e os aprendizados como estavam antes do "Atualizar prompt" e volta a ler as conversas inteiras como antes. As instruções continuam as de agora.', botao: '↩️ Voltar' }))) return;
      try {
        await comEspera(e.currentTarget, () => api(`bots/${botId}/atualizar-prompt/voltar`, { method: 'POST', body: {} }));
        aviso('Pronto: o clone e os aprendizados voltaram como estavam.');
        atualizar();
      } catch (err) { aviso(err.message, true); }
    });
    $$('[data-restaurar]', painel).forEach((b) => {
      b.onclick = () => { area.value = hist[Number(b.dataset.restaurar)].texto; desenhar(); area.focus(); aviso('Versão antiga colocada no campo. Clique em Salvar ou em Atualizar e conferir para usar.'); };
    });
  };
  const atualizar = async () => {
    try { bot = await api(`bots/${botId}`); desenhar(); } catch { /* o painel é só informativo */ }
  };
  area.addEventListener('input', () => { clearTimeout(area._pi); area._pi = setTimeout(desenhar, 250); });
  form._atualizarPainel = atualizar;
  atualizar();
}

// Botão "Atualizar prompt" (IA do WhatsApp): salva e, daqui para frente, a IA segue só o
// prompt novo — sem clone nem aprendizados (guardados) e sem imitar as respostas antigas
function ligarAtualizarPrompt(form, botId) {
  const acoes = form.querySelector(':scope > .acoes');
  if (!acoes || acoes.querySelector('.atualizar-prompt')) return;
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'atualizar-prompt primario';
  botao.textContent = '🆕 Atualizar prompt';
  botao.title = 'Salva e a IA passa a seguir só estas instruções (tira o clone e os aprendizados antigos, guardados para voltar)';
  acoes.prepend(botao);
  botao.onclick = async () => {
    const area = form.elements.promptWhatsapp;
    if (!area?.value.trim()) return aviso('Escreva as instruções antes de atualizar.', true);
    if (!(await confirmar({ titulo: 'Atualizar prompt?', texto: '<p>A partir de agora a IA segue <b>só estas instruções</b>:</p><ul><li>o <b>clone</b> e os <b>aprendizados</b> saem da IA (ficam guardados — dá para voltar);</li><li>nas conversas em andamento ela <b>não imita as respostas antigas</b> (usa só para saber o que já foi falado);</li><li>as mídias citadas no texto são <b>conectadas</b> sozinhas quando a mídia certa é clara.</li></ul>', botao: '🆕 Atualizar prompt' }))) return;
    try {
      const r = await comEspera(botao, () => api(`bots/${botId}/atualizar-prompt`, { method: 'POST', body: { promptWhatsapp: area.value } }), 'Atualizando…');
      area.value = r.bot.promptWhatsapp || '';
      const partes = ['Prompt atualizado: a IA segue só as instruções novas.'];
      if (r.conectadas.length) partes.push(`${r.conectadas.length} mídia(s) conectada(s): ${r.conectadas.map((c) => c.codigo).join(', ')}.`);
      if (r.pendencias.length) partes.push(`${r.pendencias.length} trecho(s) falam de mídia sem conexão certa — veja em Mídias.`);
      aviso(partes.join(' '), r.pendencias.length > 0);
      form._atualizarPainel?.();
    } catch (err) { aviso(err.message, true); }
  };
}

// Botão "Atualizar e conferir": salva as instruções e testa a IA de verdade
// (mensagens de cliente pensadas para as regras + um fiscal que confere cada uma)
function ligarConferirPrompt(form, botId, canal) {
  const acoes = form.querySelector(':scope > .acoes');
  if (!acoes || acoes.querySelector('.conferir-prompt')) return;
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'conferir-prompt';
  botao.textContent = '🔄 Atualizar e conferir';
  botao.title = 'Salva e testa se a IA está lendo as instruções novas e obedecendo';
  acoes.append(botao);
  const area = document.createElement('div');
  area.className = 'conferir-resultado';
  acoes.after(area);
  const ICONE = { sim: '<span class="cf-ok">✓</span>', nao: '<span class="cf-nao">✗</span>', nao_testada: '<span class="cf-nt">–</span>' };
  botao.onclick = async () => {
    try {
      await salvarBot(botId, form, 'Instruções salvas. Testando a IA…');
      area.innerHTML = '<p class="rotulo"><span class="girando"></span> A IA está respondendo mensagens de teste com as instruções novas e um fiscal está conferindo cada regra (leva uns 20 a 40 segundos)…</p>';
      const r = await comEspera(botao, () => api(`bots/${botId}/conferir`, { method: 'POST', body: { canal } }), 'Testando…');
      area.innerHTML = `
        <div class="conferir-caixa ${r.nota}">
          <div class="cf-topo"><strong>${r.lendo ? '✓ A IA está lendo as instruções novas' : '⚠️ A IA NÃO está lendo o texto salvo'}</strong><span class="etiqueta ${r.nota === 'ok' ? 'ok' : 'aviso'}">${esc(r.placar)}</span></div>
          <p class="rotulo" style="margin:2px 0 10px">Salvas ${r.instrucoesSalvasEm ? `em ${esc(data(r.instrucoesSalvasEm))}` : 'agora'} · ${r.caracteres} caracteres · valem para todas as próximas mensagens, inclusive em conversas que já estavam abertas.</p>
          <ul class="cf-regras">${r.regras.map((x) => `<li>${ICONE[x.resultado]}<div><b>${esc(x.regra)}</b>${x.porque ? `<span class="rotulo">${esc(x.porque)}</span>` : ''}</div></li>`).join('')}</ul>
          ${r.resumo ? `<p style="margin:10px 0 0">${esc(r.resumo)}</p>` : ''}
          ${r.sugestao ? `<p class="cf-sugestao">💡 <b>Para a IA obedecer melhor:</b> ${esc(r.sugestao)}</p>` : ''}
          <details style="margin-top:10px"><summary>Ver as respostas do teste</summary>
            ${r.conversas.map((c) => `<div class="cf-conversa"><p><span class="rotulo">Cliente:</span> ${esc(c.cliente)}</p><p><span class="rotulo">IA:</span> ${c.ia ? esc(c.ia) : `<span class="aviso-texto">${esc(c.erro || 'sem resposta')}</span>`}${c.acoes?.length ? ` <span class="rotulo">(${esc(c.acoes.join('; '))})</span>` : ''}</p></div>`).join('')}
          </details>
        </div>`;
      form._atualizarPainel?.();
    } catch (err) {
      area.innerHTML = '';
      aviso(err.message, true);
      form._atualizarPainel?.();
    }
  };
}

// ---------------------------------------------------------------- empresa: agendamentos (agenda simples)

async function paginaAgenda(id, params) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/agendamentos`);
  if (location.hash !== hashDaPagina) return;
  let aba = params?.get('aba') || 'proximos';
  const sp = (iso, o) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...o });
  const chaveDia = (iso) => sp(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const hoje = chaveDia(new Date().toISOString());
  const amanha = chaveDia(new Date(Date.now() + 86400000).toISOString());
  const tituloDia = (iso) => {
    const k = chaveDia(iso);
    const nome = sp(iso, { weekday: 'long', day: '2-digit', month: 'long' });
    return k === hoje ? `Hoje · ${nome}` : k === amanha ? `Amanhã · ${nome}` : nome.charAt(0).toUpperCase() + nome.slice(1);
  };
  const QUEM = { ia: 'IA', equipe: 'equipe', cliente: 'cliente', detectado: '✨ percebido', etiqueta: '🏷️ etiqueta Agendado' };
  const linha = (x) => `
    <div class="ag-linha ${x.grupo}" data-ag="${esc(x.id)}">
      <div class="ag-hora">${x.quando ? sp(x.quando, { hour: '2-digit', minute: '2-digit' }) : '—'}</div>
      <div class="ag-quem">${avatarLead({ nome: x.nome, telefone: x.telefone, fotoUrl: x.foto })}<div><strong>${esc(x.nome || telefoneBonito(x.telefone) || 'Cliente')}</strong><span class="rotulo">${esc(x.descricao || 'Sem descrição')}${x.quandoTexto && !x.quando && x.quandoTexto !== 'Data a combinar' ? ` · ${esc(x.quandoTexto)}` : ''}</span></div></div>
      <div class="ag-tags">
        <span class="etiqueta">${esc(QUEM[x.por] || x.por)}</span>
        ${x.grupo === 'cancelados' ? `<span class="etiqueta off">${x.status === 'remarcado' ? 'horário trocado' : 'cancelado'}</span>` : ''}${x.status === 'concluido' ? '<span class="etiqueta ok">✅ venda concluída</span>' : ''}
        ${x.avisoStatus === 'enviado' ? '<span class="etiqueta ok" title="O número de aviso recebeu">aviso ✓</span>' : x.avisoStatus === 'erro' ? `<span class="etiqueta aviso" title="${esc(x.avisoErro)}">aviso falhou</span>` : ''}
      </div>
      <div class="ag-acoes"><a class="botao pequeno" href="${rotaEmpresa(id, 'conversas')}?lead=${esc(x.leadId)}">Conversa</a>${x.grupo === 'proximos' ? `<button type="button" class="pequeno perigo" data-ag-cancelar="${esc(x.id)}" data-lead="${esc(x.leadId)}" title="Cancelar">✕</button>` : ''}</div>
    </div>`;
  const desenhar = () => {
    const itens = d[aba] || [];
    let html = '';
    if (!itens.length) html = `<div class="card vazio-grande"><div class="vazio-icone">📅</div><h2>${aba === 'proximos' ? 'Nenhum agendamento pela frente' : aba === 'passados' ? 'Nenhum agendamento passado' : 'Nenhum cancelado'}</h2><p class="rotulo">${aba === 'proximos' ? 'Quando você, a equipe ou a IA combinarem um horário com o cliente no WhatsApp, ele aparece aqui sozinho.' : ''}</p></div>`;
    else {
      let dia = '';
      html = '<div class="card ag-lista">';
      for (const x of itens) {
        const k = x.quando ? chaveDia(x.quando) : 'sem-data';
        if (k !== dia) { dia = k; html += `<div class="ag-dia ${k === hoje ? 'hoje' : ''}">${x.quando ? esc(tituloDia(x.quando)) : 'Data a combinar'}</div>`; }
        html += linha(x);
      }
      html += '</div>';
    }
    $('#ag-conteudo').innerHTML = html;
    $$('[data-ag-cancelar]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmar({ titulo: 'Cancelar este agendamento?', texto: 'Ele sai da agenda e o lead sai de "Agendou". Se o aviso de agendamento estiver ligado, o número cadastrado recebe o cancelamento. O cliente não recebe nada automático.', botao: 'Cancelar agendamento', perigo: true }))) return;
        try { await api(`leads/${b.dataset.lead}/agendamentos/${b.dataset.agCancelar}`, { method: 'DELETE', body: {} }); aviso('Agendamento cancelado.'); paginaAgenda(id, new URLSearchParams({ aba })).then(() => montarMenu(rotaEmpresa(id, 'agenda'))); } catch (err) { aviso(err.message, true); }
      };
    });
  };
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Agendamentos</h1><p class="sub">O que está marcado com os clientes. Entra sozinho quando um horário é combinado no WhatsApp.</p></div><a class="botao" href="${rotaEmpresa(id, 'whatsapp')}">Aviso no WhatsApp</a></div>
    <div class="card cat-resumo">
      <div><span class="rotulo">Hoje</span><b>${d.resumo.hoje}</b></div>
      <div><span class="rotulo">Próximos 7 dias</span><b>${d.resumo.semana}</b></div>
      <div><span class="rotulo">Todos à frente</span><b>${d.resumo.proximos}</b></div>
    </div>
    <div class="chips ag-abas">${[['proximos', `Próximos (${d.proximos.length})`], ['passados', `Passados (${d.passados.length})`], ['cancelados', `Cancelados (${d.cancelados.length})`]].map(([k, r]) => `<button type="button" class="chip-filtro ${k === aba ? 'ativo' : ''}" data-ag-aba="${k}">${r}</button>`).join('')}</div>
    <div id="ag-conteudo"></div>`;
  $$('[data-ag-aba]').forEach((b) => { b.onclick = () => { aba = b.dataset.agAba; $$('[data-ag-aba]').forEach((x) => x.classList.toggle('ativo', x === b)); desenhar(); }; });
  desenhar();
}

// ---------------------------------------------------------------- empresa: serviços e preços (catálogo)

const TIPO_CATALOGO = { servico: 'Serviço', produto: 'Produto' };
const precoBonito = (x) => {
  if (x.preco == null && x.precoAte == null) return x.precoObs || 'Sob consulta';
  const faixa = x.preco != null && x.precoAte != null ? `${brl(x.preco)} – ${brl(x.precoAte)}` : brl(x.preco ?? x.precoAte);
  return faixa;
};

// O que dá para ligar a um item: fotos/vídeos soltos, álbuns e pastas do Drive (pelo código)
async function opcoesDeMidia(id, emp) {
  const [todas, albuns] = await Promise.all([api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`)]);
  const capa = (filtro) => todas.find((m) => filtro(m) && m.tipo === 'image')?.url || '';
  return [
    ...todas.filter((m) => !m.pastaId && !m.albumId && m.codigo).map((m) => ({ codigo: m.codigo, nome: m.nome, tipo: m.tipo, capa: m.tipo === 'image' ? m.url : '', pronta: m.pronta !== false })),
    ...albuns.filter((a) => a.codigo).map((a) => ({ codigo: a.codigo, nome: a.nome, tipo: 'album', capa: capa((m) => m.albumId === a.id), quantidade: todas.filter((m) => m.albumId === a.id).length, pronta: true })),
    ...(emp.drivePastas || []).filter((p) => p.codigo).map((p) => ({ codigo: p.codigo, nome: p.nome, tipo: 'drive', capa: capa((m) => m.pastaId === p.id), pronta: true }))
  ];
}

function miniaturaMidia(o, extra = '') {
  const icone = o.tipo === 'album' ? '🗂️' : o.tipo === 'drive' ? '📁' : ICONE_TIPO[o.tipo] || '📎';
  return `<span class="mini-midia ${extra}" title="${esc(o.nome)} · ${esc(codMidia(o.codigo))}">${o.capa ? `<img src="${esc(o.capa)}" alt="" loading="lazy">` : `<span>${icone}</span>`}${o.tipo === 'video' ? '<i>▶</i>' : o.tipo === 'album' ? `<i>${o.quantidade || ''}</i>` : ''}</span>`;
}

async function paginaCatalogo(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const [d, opcoes] = await Promise.all([api(`empresas/${id}/catalogo`), opcoesDeMidia(id, emp)]);
  if (location.hash !== hashDaPagina) return;
  const porCodigo = Object.fromEntries(opcoes.map((o) => [o.codigo, o]));
  emp.catalogoCategorias = d.itens.map((x) => x.categoria).filter(Boolean);
  let filtro = 'todos';
  let busca = '';
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Serviços e preços</h1><p class="sub">O que a empresa vende. A IA consulta esta lista em toda resposta — mudou aqui, vale na próxima mensagem, sem mexer no prompt.</p></div>
      <div class="acoes-topo"><button type="button" id="cat-importar">✨ Trazer de "Sobre a empresa"</button><button type="button" class="primario" id="cat-novo">+ Novo serviço ou produto</button></div></div>
    ${balao('Como a IA usa isto', 'Os <b>preços daqui valem acima de qualquer outro texto</b> (Sobre a empresa, site, conversas antigas). Item sem preço = a IA diz que vai confirmar. As <b>mídias ligadas</b> a um item vão quando o cliente fala daquele serviço ou produto. Desligou um item? A IA para de oferecer na hora.')}
    <div class="card cat-resumo">
      <div><span class="rotulo">Na lista</span><b>${d.total}</b></div>
      <div><span class="rotulo">A IA está oferecendo</span><b>${d.ativos}</b></div>
      <div><span class="rotulo">Última mudança</span><b class="cat-data">${d.atualizadoEm ? esc(data(d.atualizadoEm)) : '—'}</b></div>
    </div>
    <div class="cat-filtros">
      <input id="cat-busca" placeholder="🔎 Buscar serviço ou produto">
      <div class="chips">${[['todos', 'Todos'], ['servico', 'Serviços'], ['produto', 'Produtos'], ['off', 'Desligados']].map(([k, r]) => `<button type="button" class="chip-filtro ${k === filtro ? 'ativo' : ''}" data-cat-filtro="${k}">${r}</button>`).join('')}</div>
    </div>
    <div id="cat-lista"></div>`;

  const desenhar = () => {
    const termo = busca.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const lista = d.itens
      .filter((x) => filtro === 'todos' || (filtro === 'off' ? !x.ativo : x.tipo === filtro))
      .filter((x) => !termo || `${x.nome} ${x.categoria} ${x.descricao}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(termo))
      .sort((a, b) => (a.categoria || '').localeCompare(b.categoria || '') || a.nome.localeCompare(b.nome));
    $('#cat-lista').innerHTML = !d.itens.length
      ? `<div class="card vazio-grande"><div class="vazio-icone">🛍️</div><h2>Cadastre o que você vende</h2><p class="rotulo">Cada serviço ou produto com o preço e as fotos/vídeos que mostram ele. A IA passa a usar na hora.</p><div class="acoes" style="justify-content:center"><button type="button" class="primario" data-cat-novo>+ Novo serviço ou produto</button><button type="button" data-cat-importar>✨ Trazer de "Sobre a empresa"</button></div></div>`
      : !lista.length
        ? '<p class="rotulo">Nada encontrado com esse filtro.</p>'
        : `<div class="cat-grade">${lista.map((x) => `
          <div class="card cat-item ${x.ativo ? '' : 'desligado'}" data-cat-item="${esc(x.id)}">
            <div class="cat-midias">${x.midias.length ? x.midias.slice(0, 4).map((c) => (porCodigo[c] ? miniaturaMidia(porCodigo[c]) : '')).join('') + (x.midias.length > 4 ? `<span class="mini-midia mais">+${x.midias.length - 4}</span>` : '') : '<span class="cat-sem-midia">sem mídia</span>'}</div>
            <div class="cat-corpo">
              <div class="cat-linha1"><span class="etiqueta ${x.tipo === 'produto' ? 'aviso' : 'ok'}">${TIPO_CATALOGO[x.tipo]}</span>${x.categoria ? `<span class="rotulo">${esc(x.categoria)}</span>` : ''}</div>
              <strong class="cat-nome">${esc(x.nome)}</strong>
              <div class="cat-preco">${esc(precoBonito(x))}${x.precoObs && (x.preco != null || x.precoAte != null) ? ` <span class="rotulo">${esc(x.precoObs)}</span>` : ''}</div>
              ${x.duracao ? `<div class="rotulo">⏱ ${esc(x.duracao)}</div>` : ''}
              ${x.descricao ? `<p class="cat-desc">${esc(x.descricao)}</p>` : ''}
            </div>
            <div class="cat-rodape">${interruptor(`cat-ativo-${x.id}`, x.ativo, x.ativo ? 'IA oferece' : 'Desligado')}<span class="cat-acoes"><button type="button" class="pequeno" data-cat-editar="${esc(x.id)}">Editar</button><button type="button" class="pequeno perigo" data-cat-apagar="${esc(x.id)}" title="Apagar">✕</button></span></div>
          </div>`).join('')}</div>`;
    $$('[data-cat-editar]').forEach((b) => { b.onclick = () => editorCatalogo(id, emp, opcoes, d.itens.find((x) => x.id === b.dataset.catEditar), recarregar); });
    $$('[data-cat-novo]').forEach((b) => { b.onclick = () => editorCatalogo(id, emp, opcoes, null, recarregar); });
    $$('[data-cat-importar]').forEach((b) => { b.onclick = () => importarCatalogo(id, recarregar); });
    $$('[data-cat-apagar]').forEach((b) => {
      b.onclick = async () => {
        const x = d.itens.find((i) => i.id === b.dataset.catApagar);
        if (!(await confirmar({ titulo: `Apagar "${x.nome}"?`, texto: 'A IA deixa de oferecer este item. As mídias continuam na biblioteca.', botao: 'Apagar', perigo: true }))) return;
        try { await api(`empresas/${id}/catalogo/${x.id}`, { method: 'DELETE' }); aviso('Apagado.'); recarregar(); } catch (err) { aviso(err.message, true); }
      };
    });
    for (const x of d.itens) {
      const ch = $(`#cat-ativo-${x.id}`);
      if (ch) ch.onchange = async (e) => {
        try { await api(`empresas/${id}/catalogo/${x.id}`, { method: 'PUT', body: { ativo: e.target.checked } }); aviso(e.target.checked ? `A IA voltou a oferecer "${x.nome}".` : `A IA parou de oferecer "${x.nome}".`); recarregar(); } catch (err) { aviso(err.message, true); }
      };
    }
  };
  const recarregar = () => paginaCatalogo(id).then(() => montarMenu(rotaEmpresa(id, 'catalogo')));
  $('#cat-novo').onclick = () => editorCatalogo(id, emp, opcoes, null, recarregar);
  $('#cat-importar').onclick = () => importarCatalogo(id, recarregar);
  $('#cat-busca').oninput = (e) => { busca = e.target.value; desenhar(); };
  $$('[data-cat-filtro]').forEach((b) => { b.onclick = () => { filtro = b.dataset.catFiltro; $$('[data-cat-filtro]').forEach((x) => x.classList.toggle('ativo', x === b)); desenhar(); }; });
  desenhar();
}

function editorCatalogo(id, emp, opcoes, item, depois) {
  const x = item || { tipo: 'servico', nome: '', categoria: '', preco: null, precoAte: null, precoObs: '', duracao: '', descricao: '', midias: [], ativo: true };
  const escolhidas = new Set(x.midias);
  const num = (v) => (v == null ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const categorias = [...new Set((emp.catalogoCategorias || []))];
  abrirModal(`
    <h2>${item ? 'Editar' : 'Novo'} serviço ou produto</h2>
    <form id="f-cat" class="form-cat">
      <div class="segmentado"><label><input type="radio" name="tipo" value="servico" ${x.tipo !== 'produto' ? 'checked' : ''}><span>Serviço</span></label><label><input type="radio" name="tipo" value="produto" ${x.tipo === 'produto' ? 'checked' : ''}><span>Produto</span></label></div>
      <div class="campos">
        <div class="campo largo"><label>Nome *</label><input name="nome" required maxlength="100" value="${esc(x.nome)}" placeholder="Ex.: Limpeza completa, Corte masculino, Consulta"></div>
        <div class="campo"><label>Preço (R$)</label><input name="preco" inputmode="decimal" value="${esc(num(x.preco))}" placeholder="350,00"></div>
        <div class="campo"><label>Até (R$) <span class="rotulo">— se for faixa</span></label><input name="precoAte" inputmode="decimal" value="${esc(num(x.precoAte))}" placeholder="opcional"></div>
        <div class="campo"><label>Sobre o preço</label><input name="precoObs" maxlength="120" value="${esc(x.precoObs)}" placeholder="a partir de · no Pix · em até 3x"></div>
        <div class="campo"><label>${x.tipo === 'produto' ? 'Prazo de entrega' : 'Duração / prazo'}</label><input name="duracao" maxlength="80" value="${esc(x.duracao)}" placeholder="Ex.: 2 horas · fica pronto no mesmo dia"></div>
        <div class="campo"><label>Categoria <span class="rotulo">— opcional</span></label><input name="categoria" maxlength="60" value="${esc(x.categoria)}" list="cat-categorias" placeholder="Ex.: Serviços, Produtos, Pacotes"><datalist id="cat-categorias">${categorias.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="campo largo"><label>Detalhes para a IA usar ${ajuda('O que está incluso, materiais, cores, garantia, condições. Só o que for verdade: a IA usa isto para responder.')}</label><textarea name="descricao" maxlength="1500" style="min-height:90px" placeholder="Ex.: Couro legítimo, costura à mão, cores preto e caramelo, garantia de 1 ano.">${esc(x.descricao)}</textarea></div>
      </div>
      <div class="campo">
        <label>Mídias deste item <span class="rotulo" id="cat-qtd"></span> ${ajuda('Fotos, vídeos, álbuns ou pastas do Drive que mostram este serviço/produto. A IA manda quando o cliente falar dele.')}</label>
        ${opcoes.length ? `<input id="cat-busca-midia" placeholder="🔎 Filtrar mídias" style="margin-bottom:8px">
        <div class="seletor-midias">${opcoes.map((o) => `<button type="button" class="opcao-midia ${escolhidas.has(o.codigo) ? 'marcada' : ''}" data-codigo="${esc(o.codigo)}" data-busca="${esc(`${o.nome} ${o.codigo}`.toLowerCase())}">${miniaturaMidia(o)}<span class="opcao-nome">${esc(o.nome)}</span><span class="opcao-check">✓</span></button>`).join('')}</div>`
        : `<p class="rotulo">Nenhuma mídia na biblioteca ainda. <a href="${rotaEmpresa(id, 'midias')}">Subir fotos e vídeos</a></p>`}
      </div>
      <label class="linha-check" style="margin-top:10px"><input type="checkbox" name="ativo" ${x.ativo ? 'checked' : ''}> A IA oferece este item</label>
      <div class="acoes"><button type="submit" class="primario">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    const qtd = () => { const q = $('#cat-qtd', m); if (q) q.textContent = escolhidas.size ? `· ${escolhidas.size} escolhida(s)` : ''; };
    qtd();
    $$('.opcao-midia', m).forEach((b) => {
      b.onclick = () => { const c = b.dataset.codigo; if (escolhidas.has(c)) escolhidas.delete(c); else escolhidas.add(c); b.classList.toggle('marcada', escolhidas.has(c)); qtd(); };
    });
    $('#cat-busca-midia', m)?.addEventListener('input', (e) => { const t = e.target.value.toLowerCase(); $$('.opcao-midia', m).forEach((b) => { b.hidden = t && !b.dataset.busca.includes(t); }); });
    $('#f-cat', m).onsubmit = async (e) => {
      e.preventDefault();
      const corpo = { ...formParaObjeto(e.target), midias: [...escolhidas] };
      try {
        await comEspera(e.submitter, () => api(item ? `empresas/${id}/catalogo/${item.id}` : `empresas/${id}/catalogo`, { method: item ? 'PUT' : 'POST', body: corpo }), 'Salvando…');
        fechar();
        aviso('Salvo. A IA já usa na próxima mensagem.');
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// "Trazer de Sobre a empresa": a IA lê o texto e sugere a lista; você escolhe o que entra
async function importarCatalogo(id, depois) {
  const fechar = abrirModal('<h2>Trazer de "Sobre a empresa"</h2><p class="rotulo"><span class="girando"></span> A IA está lendo o texto de "Sobre a empresa" e separando os serviços e preços…</p>');
  let r;
  try { r = await api(`empresas/${id}/catalogo/sugerir`, { method: 'POST', body: {} }); } catch (err) { fechar(); return aviso(err.message, true); }
  fechar();
  if (!r.itens.length) return aviso('Não achei serviços novos em "Sobre a empresa" (ou já estão todos no catálogo).');
  abrirModal(`
    <h2>Encontrei ${r.itens.length} ${r.itens.length === 1 ? 'item' : 'itens'}</h2>
    <p class="rotulo" style="margin-top:-6px">Confira os preços e desmarque o que não quiser. Depois dá para editar cada um e ligar as mídias.</p>
    <div class="lista-importar">${r.itens.map((x, i) => `<label class="linha-importar"><input type="checkbox" data-i="${i}" checked><span><b>${esc(x.nome)}</b> <span class="etiqueta ${x.tipo === 'produto' ? 'aviso' : 'ok'}">${TIPO_CATALOGO[x.tipo]}</span><br><span class="rotulo">${esc(precoBonito(x))}${x.precoObs && (x.preco != null || x.precoAte != null) ? ` · ${esc(x.precoObs)}` : ''}${x.duracao ? ` · ⏱ ${esc(x.duracao)}` : ''}</span></span></label>`).join('')}</div>
    <div class="acoes"><button type="button" class="primario" id="imp-ok">Adicionar marcados</button><button type="button" data-fechar>Cancelar</button></div>`, (m, fecharLista) => {
    $('#imp-ok', m).onclick = async (e) => {
      const marcados = $$('[data-i]', m).filter((c) => c.checked).map((c) => r.itens[Number(c.dataset.i)]);
      let ok = 0;
      await comEspera(e.currentTarget, async () => {
        for (const x of marcados) { try { await api(`empresas/${id}/catalogo`, { method: 'POST', body: x }); ok++; } catch { /* repetido: pula */ } }
      }, 'Adicionando…');
      fecharLista();
      aviso(`${ok} ${ok === 1 ? 'item adicionado' : 'itens adicionados'}. A IA já usa.`);
      depois?.();
    };
  });
}

// ---------------------------------------------------------------- empresa: sobre a empresa (cérebro)

const MODELO_CONHECIMENTO = `SERVIÇOS E PREÇOS
- Serviço 1: ... — R$ ...
- Serviço 2: ... — R$ ...

COMO FUNCIONA / ATENDIMENTO
- Onde atende, dias e horários:
- Quanto tempo leva:
- Garantia:

PAGAMENTO
- Formas aceitas:

PERGUNTAS FREQUENTES
- Pergunta? Resposta.
`;

async function paginaCerebro(id) {
  const hashDaPagina = location.hash;
  const [emp, bot] = await Promise.all([definirEmpresaAtual(id), principalDa(id)]);
  if (!bot) return void (conteudo.innerHTML = '<p class="erro-caixa">Esta empresa ainda não tem assistente. Fale com o administrador.</p>');
  const semChave = !emp.chaves?.[bot.provedor || 'anthropic']?.funciona;
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Sobre a empresa</h1><p class="sub">O que as duas IAs sabem e como elas falam</p></div></div>
    ${balao('Aqui você "treina" a IA', 'Escreva como se estivesse explicando o negócio para um funcionário novo: o que vende, quanto custa, onde atende, horários, prazos, garantia, formas de pagamento e as dúvidas mais comuns. <b>A IA só responde o que estiver aqui</b> — o que não souber, ela diz que vai confirmar com a equipe.')}
    ${semChave ? balao('Falta a chave de IA', `Sem ela as IAs não respondem. <a href="${rotaEmpresa(id, 'chave')}">Cadastrar chave de IA</a>`, 'aviso') : ''}
    ${balao('A IA já vem treinada para vender', 'Ela entende a necessidade, mostra o benefício, contorna objeções (preço, "vou pensar"), sugere o próximo passo e propõe fechar quando o cliente mostra interesse — sem inventar nada. Preencha o <b>objetivo</b> e a <b>oferta</b> para ela saber aonde chegar.', 'ok')}
    <div class="editor">
      <form id="f-bot" class="card">
        <div class="campos">
          <div class="campo"><label>Nome do atendente virtual ${ajuda('Como a IA se apresenta. Ex.: "Ana, da Loja Exemplo" ou só o nome da empresa.')}</label><input name="nomeAssistente" value="${esc(bot.nomeAssistente)}" placeholder="${esc(emp.nome)}"></div>
          <div class="campo"><label>Jeito de falar ${ajuda('Ex.: simpático e descontraído; formal e objetivo; animado, com emojis.')}</label><input name="tom" value="${esc(bot.tom)}" placeholder="simpático, próximo e profissional"></div>
          <div class="campo"><label>Objetivo da conversa ${ajuda('Onde a IA deve levar o cliente. Ex.: agendar uma visita, fechar o pedido, marcar a avaliação gratuita.')}</label><input name="objetivo" value="${esc(bot.objetivo || '')}" placeholder="Ex.: agendar o serviço"></div>
          <div class="campo"><label>Oferta e diferenciais ${ajuda('O que faz o cliente escolher você: garantia, parcelamento, promoção do mês, atendimento a domicílio… Só coisas verdadeiras — a IA não inventa.')}</label><input name="oferta" value="${esc(bot.oferta || '')}" placeholder="Ex.: 12x sem juros, garantia de 1 ano"></div>
          <div class="campo largo">
            <label>Tudo o que a IA precisa saber *</label>
            <textarea class="grande" name="conhecimento">${esc(bot.conhecimento || MODELO_CONHECIMENTO)}</textarea>
            <small>Dica: troque os "..." do modelo pelas informações reais. Quanto mais completo, melhor a IA atende. <b>Preços e serviços:</b> cadastre em <a href="${rotaEmpresa(id, 'catalogo')}">Serviços e preços</a> — lá a IA sempre consulta e você muda sem mexer neste texto.</small>
          </div>
        </div>
        <p class="rotulo" style="margin:14px 0 0">🧠 A IA que responde (e as reservas, se ela falhar) fica em <a href="${rotaEmpresa(id, 'chave')}">IAs e chaves</a>.</p>
        <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
      </form>
      <div>
        <div class="seletor-canal"><button type="button" class="ativo" data-canal="site">Como IA do site</button><button type="button" data-canal="whatsapp">Como IA do WhatsApp</button></div>
        <div id="teste-wrap"></div>
      </div>
    </div>`;
  const form = $('#f-bot');
  ligarSeletorModelo(form, id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await salvarBot(bot.id, form); } catch (err) { aviso(err.message, true); }
  };
  const montarTeste = (canal) => {
    $('#teste-wrap').innerHTML = htmlChatTeste(canal, false);
    ligarChatTeste({ botId: bot.id, canal, rascunho: () => formParaObjeto(form), saudacao: () => bot.boasVindas });
  };
  $$('.seletor-canal button').forEach((b) => {
    b.onclick = () => {
      $$('.seletor-canal button').forEach((x) => x.classList.toggle('ativo', x === b));
      montarTeste(b.dataset.canal);
    };
  });
  montarTeste('site');
}

function ligarSeletorModelo(form, empresaId, selProvedor = form.elements.provedor, selModelo = form.elements.modelo, avisoEl = $('#aviso-modelo')) {
  if (!selProvedor || !selModelo) return;
  async function carregar(manterAtual) {
    const atual = manterAtual ? selModelo.value : '';
    selModelo.innerHTML = '<option>carregando…</option>';
    try {
      const r = await api(`ia/modelos?provedor=${encodeURIComponent(selProvedor.value)}&empresaId=${encodeURIComponent(empresaId)}`);
      const lista = r.modelos.slice();
      if (atual && !lista.some((m) => m.id === atual)) lista.unshift({ id: atual, nome: `${atual} (atual)` });
      selModelo.innerHTML = lista.map((m) => `<option value="${esc(m.id)}">${esc(m.id === m.nome ? m.id : `${m.nome} — ${m.id}`)}</option>`).join('');
      const preferido = atual || (selProvedor.value === 'gemini' ? lista.find((m) => /flash/.test(m.id) && !/lite|preview|exp/.test(m.id))?.id : selProvedor.value === 'openai' ? (lista.find((m) => m.id === 'gpt-5-mini') || lista[0])?.id : lista[0]?.id);
      if (preferido) selModelo.value = preferido;
      if (avisoEl) avisoEl.textContent = r.aviso ? `Não consegui listar os modelos da chave (${r.aviso}). Mostrando sugestões.` : '';
    } catch (err) {
      aviso(err.message, true);
    }
  }
  carregar(true);
  selProvedor.onchange = () => carregar(false);
}

// ---------------------------------------------------------------- empresa: IA do site

async function paginaSite(id) {
  const hashDaPagina = location.hash;
  const [emp, bot] = await Promise.all([definirEmpresaAtual(id), principalDa(id)]);
  if (!bot) return void (conteudo.innerHTML = '<p class="erro-caixa">Esta empresa ainda não tem assistente.</p>');
  const codigo = codigoEmpresa(emp.id);
  const ligado = emp.canais.site;
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>IA do site</h1><p class="sub">Um chat estilo WhatsApp no seu site, respondendo 24h</p></div>${interruptor('ligar-site', ligado, ligado ? 'Ligada' : 'Desligada')}</div>
    ${ligado ? '' : balao('A IA do site está desligada', 'O chat não aparece no site. Ligue no botão acima quando quiser usar.', 'aviso')}

    <div class="card" data-cfg="codigo-site" data-pronto="${emp.chatNoSite ? 'ok' : ''}" data-resumo="O chat já está no seu site (chegaram conversas por ele)">
      <h2>1. Coloque o chat no seu site</h2>
      ${passos([
        '<b>Copie o código</b> abaixo.',
        'Cole <b>uma vez só</b> no cabeçalho (<code>&lt;head&gt;</code>) ou no rodapé do site. Veja abaixo onde fica em cada plataforma.',
        'Pronto! O botão verde aparece em todas as páginas. O que você mudar aqui no painel vale na hora — o código nunca muda.'
      ])}
      <div class="codigo">${esc(codigo)}</div>
      <div class="acoes"><button type="button" class="primario" id="copiar">Copiar código</button></div>
      <details style="margin-top:12px"><summary>Onde colar em cada plataforma</summary>
        <ul class="lista-plataformas">
          <li><strong>WordPress:</strong> instale o plugin <em>WPCode</em> → Code Snippets → Header &amp; Footer → cole em <em>Header</em> → Salvar.</li>
          <li><strong>Lovable:</strong> no chat do projeto, peça <em>"adicione este script em todas as páginas"</em> e cole o código.</li>
          <li><strong>Wix:</strong> Configurações → Código personalizado → + Adicionar código → "Todas as páginas" → "Head".</li>
          <li><strong>Shopify / Nuvemshop / outros:</strong> procure "código personalizado" ou "scripts" nas configurações.</li>
          <li><strong>Site próprio (HTML):</strong> antes de <code>&lt;/head&gt;</code> ou de <code>&lt;/body&gt;</code>.</li>
        </ul>
      </details>
    </div>

    <div class="editor">
      <form id="f-bot" class="card">
        <h2>2. Como a IA do site atende</h2>
        ${balao('O papel da IA do site', 'Ela tira as dúvidas, entende o que o cliente quer e, quando ele estiver pronto (quer orçamento, agendar, comprar), oferece o botão <b>"Continuar no WhatsApp"</b> com a mensagem já escrita. Lá a IA do WhatsApp continua.')}
        <div class="campos">
          <div class="campo largo"><label>Instruções da IA do site ${ajuda('Diga o que ela deve descobrir e quando mandar para o WhatsApp.')}</label><textarea name="regras" placeholder="Ex.: Descubra o que o cliente precisa. Quando ele pedir preço final ou quiser agendar, mande para o WhatsApp.">${esc(bot.regras)}</textarea></div>
          <div class="campo largo"><label>Mensagem de boas-vindas</label><input name="boasVindas" value="${esc(bot.boasVindas)}" placeholder="Olá! 👋 Como posso te ajudar?"></div>
          <div class="campo largo"><label>Balão de chamada (opcional) ${ajuda('Aparece ao lado do botão alguns segundos depois de a pessoa abrir o site, para chamar atenção.')}</label><input name="chamada" value="${esc(bot.chamada)}" placeholder="Tire suas dúvidas por aqui! 💬"></div>
        </div>
        <div class="secao">
          <h2>Aparência</h2>
          <div class="campos">
            <div class="campo"><label>Foto / logo (endereço da imagem) ${ajuda('Abra a imagem do seu logo no navegador, copie o endereço e cole aqui. Vazio = só a inicial.')}</label><input name="avatarUrl" value="${esc(bot.avatarUrl)}" placeholder="https://…/logo.png"></div>
            <div class="campo"><label>Cor do chat</label><input type="color" name="cor" value="${esc(bot.cor || '#008069')}"></div>
            <div class="campo"><label>Lado da tela</label><select name="posicao"><option value="direita" ${bot.posicao !== 'esquerda' ? 'selected' : ''}>Canto direito</option><option value="esquerda" ${bot.posicao === 'esquerda' ? 'selected' : ''}>Canto esquerdo</option></select></div>
          </div>
        </div>
        <div class="secao">
          <h2>Contexto do cliente</h2>
          <label class="linha-check"><input type="checkbox" name="lerPaginaDoSite" ${bot.lerPaginaDoSite === false ? '' : 'checked'}> A IA lê a página em que o cliente está ${ajuda('O chat conta para a IA de onde o cliente veio (anúncio, Google, Instagram) e em que página ele está. Com esta opção, a IA também lê o texto dessa página para já saber qual produto ou serviço ele estava olhando. Só páginas do seu site (os domínios em Segurança).')}</label>
          <small class="rotulo">Também vale para a IA do WhatsApp quando o cliente veio do site. Botões de WhatsApp do seu site levam um código para o CRM ligar o cliente à página de onde ele clicou.</small>
        </div>
        <div class="secao">
          <h2>Passagem para o WhatsApp</h2>
          <div class="campos">
            <div class="campo"><label>Número do WhatsApp ${ajuda('Para onde o cliente vai. Vazio = usa o WhatsApp conectado no CRM (ou o da empresa).')}</label><input name="whatsapp" value="${esc(bot.whatsapp)}" placeholder="${esc(telefoneBonito(emp.whatsappNumero || emp.whatsapp?.perfil?.numero) || 'Vazio = o conectado no CRM')}"></div>
            <div class="campo"><label>Mensagem do botão do topo do chat</label><input name="mensagemWhatsappPadrao" value="${esc(bot.mensagemWhatsappPadrao)}" placeholder="Olá! Vim pelo site."></div>
          </div>
        </div>
        <div class="secao">
          <h2>Segurança</h2>
          <div class="campos">
            <div class="campo largo"><label>Sites onde o chat pode aparecer ${ajuda('Evita que outra pessoa use o seu chat (e a sua chave de IA) no site dela. Subdomínios entram automaticamente.')}</label><input name="dominios" value="${esc((bot.dominios || []).join(', '))}" placeholder="minhaloja.com.br, minhaloja.lovable.app"><small>Separe por vírgula. Vazio = qualquer site (não recomendado).</small></div>
            ${ehAdmin() ? `
            <div class="campo"><label>Limite de mensagens por dia</label><input type="number" min="1" name="limiteDiario" value="${esc(bot.limiteDiario)}"></div>
            <div class="campo"><label>Limite de mensagens por conversa</label><input type="number" min="1" name="limiteConversa" value="${esc(bot.limiteConversa)}"></div>` : ''}
          </div>
        </div>
        <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
      </form>
      <div>${htmlChatTeste('site', false)}</div>
    </div>`;
  $('#copiar').onclick = () => copiar(codigo);
  $('#ligar-site').onchange = async (e) => {
    try {
      await api(`empresas/${id}/canais`, { method: 'PUT', body: { site: e.target.checked } });
      aviso(e.target.checked ? 'IA do site ligada.' : 'IA do site desligada.');
      paginaSite(id).then(() => montarMenu(rotaEmpresa(id, 'site')));
    } catch (err) { aviso(err.message, true); }
  };
  const form = $('#f-bot');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await salvarBot(bot.id, form); } catch (err) { aviso(err.message, true); }
  };
  ligarConferirPrompt(form, bot.id, 'site');
  painelInstrucoes(form, bot.id, 'site');
  ligarChatTeste({ botId: bot.id, canal: 'site', rascunho: () => formParaObjeto(form), saudacao: () => form.elements.boasVindas.value });
}

// ---------------------------------------------------------------- empresa: IA do WhatsApp

async function paginaWhatsapp(id) {
  const hashDaPagina = location.hash;
  const [emp, bot] = await Promise.all([definirEmpresaAtual(id), principalDa(id)]);
  const w = emp.whatsapp || {};
  const ligado = emp.canais.whatsapp;
  const p = w.perfil || {};
  const online = p.estado === 'open';

  const areaQr = `
    <div id="zap-qr-area" class="qr-area"></div>`;

  let conexao;
  if (!w.configurado) {
    const comoConectar = passos([
      'Clique em <b>Gerar QR code</b> — o CRM cria a conexão sozinho no nosso servidor do WhatsApp.',
      'No celular da empresa, abra o WhatsApp e toque em <b>⋮ (ou Configurações) → Aparelhos conectados → Conectar um aparelho</b>.',
      'Aponte a câmera para o QR code. <b>Pronto!</b> Esta tela percebe sozinha quando conectar.'
    ]);
    if (w.podeCriar) {
      conexao = `
      <div class="card">
        <h2>1. Conecte o WhatsApp da empresa</h2>
        ${comoConectar}
        <div class="acoes"><button type="button" class="primario grande-botao" id="zap-criar" style="max-width:320px">Gerar QR code</button></div>
        ${areaQr}
      </div>`;
    } else if (ehAdmin()) {
      // falta a chave global: o admin cola aqui mesmo e já gera o QR code
      conexao = `
      <div class="card" id="f-chave-global">
        <h2>1. Conecte o WhatsApp da empresa</h2>
        ${balao('Só uma vez: a chave global da Evolution API', 'É a mesma <code>EVOLUTION_API_KEY</code> do DingDong Tracking (a <code>AUTHENTICATION_API_KEY</code> do servidor da Evolution). Com ela o CRM cria a conexão de cada empresa sozinho. Fica guardada só no servidor e vale para todas as empresas.', 'aviso')}
        <div class="campo"><label>Chave global da Evolution API</label><input id="chave-global" type="password" autocomplete="off" placeholder="cole a chave global"></div>
        <div id="chave-global-erro"></div>
        <div class="acoes"><button type="button" class="primario" id="salvar-chave-global">Salvar e gerar QR code</button></div>
        ${areaQr}
      </div>`;
    } else {
      conexao = `
      <div class="card">
        <h2>1. Conecte o WhatsApp da empresa</h2>
        ${balao('Conexão ainda não liberada', 'O administrador do sistema precisa ativar a conexão automática. Assim que ativar, aqui aparece o botão "Gerar QR code".', 'aviso')}
      </div>`;
    }
  } else if (!online) {
    conexao = `
      <div class="card">
        <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">Falta conectar o celular</h2><span class="etiqueta aviso">● Aguardando conexão</span></div>
        ${passos([
          'No celular da empresa, abra o WhatsApp.',
          'Toque em <b>⋮ (ou Configurações) → Aparelhos conectados → Conectar um aparelho</b>.',
          'Aponte a câmera para o QR code abaixo. Esta tela percebe sozinha quando conectar.'
        ])}
        ${areaQr}
        <div class="acoes">
          <button type="button" class="perigo" id="zap-sair" style="margin-left:auto">Remover conexão</button>
        </div>
      </div>`;
  } else {
    conexao = `
      <div class="card" data-cfg="conexao" ${online ? `data-pronto="ok" data-resumo="${esc([p.nome || w.sessao, p.numero ? telefoneBonito(p.numero) : '', 'online'].filter(Boolean).join(' · '))}"` : ''}>
        <div class="cabecalho" style="margin-bottom:12px;padding-right:0"><h2 style="margin:0">WhatsApp conectado</h2><button type="button" class="pequeno" id="zap-atualizar">Atualizar</button></div>
        <div class="perfil-zap">
          ${p.foto ? `<img src="${esc(p.foto)}" alt="" class="foto-zap" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'foto-zap vazia'}))">` : `<span class="foto-zap vazia">${ICONES.whatsapp}</span>`}
          <div>
            <strong>${esc(p.nome || 'WhatsApp')}</strong>
            <div class="rotulo">${p.numero ? esc(telefoneBonito(p.numero)) : ''}${w.criadaPeloCrm ? '' : ` · sessão <code>${esc(w.sessao)}</code>`}</div>
            <div style="margin-top:6px"><span class="etiqueta ok">● Online</span></div>
          </div>
        </div>
        <div id="zap-resultado"></div>
        <div class="acoes">
          <button type="button" id="zap-trocar-numero">Trocar de número</button>
          ${w.criadaPeloCrm ? '' : '<button type="button" id="zap-trocar">Trocar Session ID / API Key</button>'}
          <button type="button" class="perigo" id="zap-sair" style="margin-left:auto">Remover conexão</button>
        </div>
      </div>`;
  }

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>IA do WhatsApp</h1><p class="sub">Responde no número da empresa, manda fotos e vídeos e passa para a equipe</p></div>${interruptor('ligar-zap', ligado, ligado ? 'Ligada' : 'Desligada')}</div>
    ${faixaPausada(emp)}
    ${ligado ? '' : balao('A IA do WhatsApp está desligada', 'As mensagens continuam chegando no CRM (você vê tudo em Leads), mas a IA não responde. Ligue no botão acima quando quiser.', 'aviso')}
    ${conexao}
    <div class="card" id="card-diagnostico" data-pronto="off" data-resumo="Use quando a IA não responder alguém">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">🩺 A IA não está respondendo?</h2><button type="button" class="primario pequeno" id="rodar-diagnostico">Verificar agora</button></div>
      <p class="rotulo" style="margin:0">O CRM confere tudo: conexão do celular, se as mensagens estão chegando, chave de IA, modo teste e conversas pausadas — e mostra o que a IA fez com as últimas mensagens.</p>
      <div id="resultado-diagnostico"></div>
    </div>
    ${w.configurado ? `<div class="card" data-cfg="sincronia" data-pronto="ok" data-resumo="Busca sozinha a cada 20 min e ao reconectar">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">📥 Mensagens do WhatsApp no painel</h2><button type="button" id="zap-sincronizar">🔄 Buscar mensagens</button></div>
      <p class="rotulo" style="margin:0">Todas as mensagens do WhatsApp aparecem aqui. Se alguma não chegou (o número ficou desconectado, você reconectou, o servidor reiniciou), o CRM busca sozinho a cada 20 minutos e sempre que o WhatsApp volta a conectar — sem a IA responder mensagens antigas.${w.sincronia ? ` <br>Última busca: <b>${esc(data(w.sincronia.em))}</b> · ${w.sincronia.erro ? `<span class="aviso-texto">erro: ${esc(w.sincronia.erro)}</span>` : `${w.sincronia.importadas} mensagem(ns) recuperada(s)${w.sincronia.importadas ? ` em ${w.sincronia.conversas} conversa(s)` : ''}`}.` : ''}</p>
    </div>` : ''}
    <form class="card" id="f-ritmo" data-pronto="ok" data-resumo="${esc({ rapido: 'Rápido', humanizado: 'Humanizado', lento: 'Mais lento' }[w.velocidade || 'humanizado'] || 'Humanizado')}${w.whatsappAvisos ? ' · avisos de erro no WhatsApp' : ''}">
      <h2 style="margin:0 0 6px">⏱️ Ritmo das respostas</h2>
      <p class="rotulo" style="margin:0 0 12px">Quanto a IA espera e quanto tempo fica "digitando…" antes de responder. Mais lento parece mais humano.</p>
      <div class="opcoes-ritmo">
        ${[['rapido', '⚡ Rápido', 'responde em ~3 s'], ['humanizado', '🙂 Humanizado', 'espera ~8 s e digita no ritmo de uma pessoa'], ['lento', '🐢 Mais lento', 'espera ~25 s, bem calmo']].map(([v, n, d]) => `<label class="opcao-ritmo"><input type="radio" name="velocidade" value="${v}" ${(w.velocidade || 'humanizado') === v ? 'checked' : ''}><span><b>${n}</b><small>${d}</small></span></label>`).join('')}
      </div>
      <div class="campos" style="margin-top:12px">
        <div class="campo"><label>Responder a 1ª mensagem de um cliente novo depois de ${ajuda('Só para quem chama pela primeira vez. Ex.: 2 minutos, para não parecer robô. As próximas seguem o ritmo acima.')}</label>
          <select name="esperaPrimeiraSeg">${[[0, 'na hora (só o ritmo acima)'], [30, '30 segundos'], [60, '1 minuto'], [120, '2 minutos'], [300, '5 minutos'], [600, '10 minutos'], [1800, '30 minutos']].map(([v, n]) => `<option value="${v}" ${Number(w.esperaPrimeiraSeg || 0) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="campo"><label>WhatsApp para avisos de erro ${ajuda('Se algo der errado (IA sem crédito, WhatsApp desconectado, mídia que não saiu), o CRM manda um aviso para este número. No máximo 1 aviso do mesmo tipo a cada 30 minutos.')}</label><input name="whatsappAvisos" value="${esc(telefoneBonito(w.whatsappAvisos || ''))}" placeholder="Seu número pessoal com DDD (opcional)"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
    </form>
    <div class="card" data-cfg="ia-manual" data-pronto="ok" data-resumo="${!w.iaAposManual ? 'Ligado: a IA para quando você responde' : 'Desligado: a IA continua atendendo'}">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">✋ IA para de responder depois da minha mensagem manual</h2>${interruptor('ia-para-manual', !w.iaAposManual, !w.iaAposManual ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0">${!w.iaAposManual
        ? '<b>Ligado (padrão):</b> quando você (ou a equipe) manda uma mensagem pelo painel ou pelo celular, a IA <b>para de responder</b> aquele cliente — você assume. Para devolver, use "Devolver para a IA" na conversa.'
        : '<b>Desligado:</b> mesmo depois da sua mensagem manual, a IA <b>continua atendendo</b> aquele cliente.'}
        Na hora de enviar, dá para trocar só para aquela mensagem na caixinha "Deixar a IA continuar atendendo".</p>
    </div>
    <div class="card" data-cfg="nao-atropelar" data-pronto="ok" data-resumo="${w.naoAtropelar !== false ? 'Ligado: junta as mensagens do cliente numa resposta só' : 'Desligado'}">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🧩 Não atropelar o cliente</h2>${interruptor('nao-atropelar', w.naoAtropelar !== false, w.naoAtropelar !== false ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0">${w.naoAtropelar !== false
        ? '<b>Ligado (padrão):</b> se o cliente manda outra mensagem enquanto a IA ainda está escrevendo, a resposta antiga <b>é cancelada</b> e a IA lê tudo o que ele mandou antes de responder — uma resposta só, mais completa.'
        : '<b>Desligado:</b> a IA responde cada mensagem assim que termina de escrever, mesmo que o cliente tenha mandado outra no meio.'}</p>
    </div>
    <div class="card" data-cfg="ia-economica" data-pronto="ok" data-resumo="${emp.iaEconomica !== false ? 'Ligado: modelo mais em conta no dia a dia' : 'Desligado: sempre o modelo escolhido'}">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">💸 Modo econômico</h2>${interruptor('ia-economica', emp.iaEconomica !== false, emp.iaEconomica !== false ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0">${emp.iaEconomica !== false
        ? '<b>Ligado (padrão):</b> a conversa do dia a dia usa um modelo mais em conta da mesma IA (ex.: Claude Sonnet no lugar do Opus — cerca de metade do preço). O modelo escolhido em <i>IAs e chaves</i> entra sozinho nos casos difíceis: objeção de preço, reclamação, negociação, mensagem longa ou quando o modelo econômico avisa que a conversa está difícil.'
        : '<b>Desligado:</b> todas as respostas usam o modelo escolhido em <i>IAs e chaves</i> (mais caro).'} Veja quanto cada tarefa gasta em <a href="${rotaEmpresa(id, 'chave')}">IAs e chaves</a>.</p>
    </div>
    <div class="card" id="card-eventos-ia"><p class="rotulo">Carregando avisos internos…</p></div>
    <div class="card" id="card-log-ia"><p class="rotulo">Carregando log das respostas…</p></div>
    ${w.configurado ? '<div class="card" id="card-aviso-agenda"><p class="rotulo">Carregando aviso de agendamento…</p></div><div class="card" id="card-etq-zap"><p class="rotulo">Carregando etiquetas…</p></div><div class="card" id="card-lista-negra"><p class="rotulo">Carregando lista negra…</p></div>' : ''}
    <div class="card modo-teste ${w.modoTeste ? 'ligado' : ''}" data-cfg="modo-teste" ${w.modoTeste ? '' : 'data-pronto="off" data-resumo="Desligado: a IA responde todos os clientes"'}>
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🧪 Modo teste</h2>${interruptor('modo-teste', w.modoTeste, w.modoTeste ? 'Ligado' : 'Desligado')}</div>
      ${balao('Teste a IA sem ela falar com seus clientes', 'Com o modo teste ligado, a IA do WhatsApp (e as automações) <b>só respondem os números abaixo</b>. As mensagens dos outros clientes continuam chegando no CRM, mas ninguém recebe resposta automática. Quando estiver tudo certo, é só desligar.')}
      <form id="f-numeros-teste" class="linha-form"><input name="numerosTeste" value="${esc((w.numerosTeste || '').split(/,\s*/).filter(Boolean).map(telefoneBonito).join(', '))}" placeholder="Seu número com DDD — ex.: (21) 99999-9999 (separe vários por vírgula)"><button type="submit">Salvar números</button></form>
    </div>
    ${bot ? `
    <div class="editor">
      <form id="f-bot" class="card">
        <h2>${w.configurado ? '' : '2. '}Como a IA do WhatsApp atende</h2>
        ${balao('Ela continua de onde o site parou', 'Quem vem do chat do site chega com um código (#ABC123) e a IA recebe toda a conversa anterior — não pergunta tudo de novo. Quem chama direto no WhatsApp vira um lead novo.')}
        <div class="campos">
          <div class="campo largo"><label>Instruções da IA do WhatsApp ${ajuda('Como ela deve conduzir: o que perguntar, que fotos/vídeos mandar, quando passar para uma pessoa.')}</label><textarea name="promptWhatsapp" style="min-height:150px" placeholder="Ex.: Continue o atendimento do site. Envie as fotos do serviço escolhido, combine dia e bairro e, quando o cliente confirmar, chame a equipe.">${esc(bot.promptWhatsapp)}</textarea></div>
        </div>
        <div class="o-que-ela-faz">
          <p class="rotulo" style="margin:0 0 6px">Sozinha, a IA do WhatsApp:</p>
          <ul>
            <li>🎤 ${emp.ouveAudio ? '<b>ouve os áudios</b> e <b>entende as fotos</b> que o cliente manda' : 'entende as fotos que o cliente manda — para <b>ouvir áudios</b>, cadastre também a <a href="' + rotaEmpresa(id, 'chave') + '">chave do Gemini</a> (grátis)'}</li>
            <li>📎 envia as <a href="${rotaEmpresa(id, 'midias')}">fotos, álbuns do Drive e links</a> quando o cliente pede</li>
            <li>➜ move o lead de <a href="${rotaEmpresa(id, 'organizar')}">etapa</a> e coloca <a href="${rotaEmpresa(id, 'organizar')}">etiquetas</a></li>
            <li>👤 chama alguém da equipe quando precisa (e para de responder aquele cliente)</li>
            <li>✋ para sozinha quando alguém da equipe responde pelo celular</li>
          </ul>
        </div>
        <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
      </form>
      <div>${htmlChatTeste('whatsapp', false)}</div>
    </div>` : ''}
    ${ehAdmin() ? `
    <details class="card secao-avancada">
      <summary>Servidor da Evolution desta empresa (só admin)</summary>
      <p class="rotulo">Vazio = usa o servidor padrão das Configurações do sistema. Só preencha se esta empresa usar outra Evolution.</p>
      <form id="f-evo" class="linha-form"><input name="evolutionUrl" value="${esc(w.evolutionUrlPropria || '')}" placeholder="https://outra-evolution.com"><button type="submit">Salvar</button></form>
    </details>` : ''}`;

  const recarregar = () => paginaWhatsapp(id).then(() => montarMenu(rotaEmpresa(id, 'whatsapp')));
  const aqui = location.hash;

  // ---------- QR code que se atualiza e percebe sozinho quando conectar
  function mostrarQr(r) {
    const area = $('#zap-qr-area');
    if (!area) return;
    if (r.conectado) return void conectou();
    area.innerHTML = `
      <div class="qr-caixa">
        ${r.base64 ? `<img alt="QR code do WhatsApp" class="qr" src="${esc(r.base64.startsWith('data:') ? r.base64 : `data:image/png;base64,${r.base64}`)}">` : '<div class="qr qr-vazio"><span class="girando"></span></div>'}
        <div class="qr-lado">
          <p class="rotulo" style="margin:0"><span class="girando"></span> Esperando você escanear… o código se renova sozinho.</p>
          <details style="margin-top:12px"><summary>Não consegue escanear? Conectar com o número</summary>
            <form id="f-pareamento" class="linha-form" style="margin-top:8px"><input name="telefone" placeholder="(21) 99999-9999" inputmode="tel"><button type="submit">Gerar código</button></form>
            <div id="codigo-pareamento"></div>
          </details>
        </div>
      </div>`;
    $('#f-pareamento').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const c = await comEspera(e.target.querySelector('button'), () => api(`empresas/${id}/whatsapp/pareamento`, { method: 'POST', body: formParaObjeto(e.target) }));
        if (c.conectado) return conectou();
        pararQr = true; // o QR novo invalidaria o código
        $('#codigo-pareamento').innerHTML = `<div class="codigo-pareamento">${esc(c.codigo)}</div>${passos(['No celular: WhatsApp → <b>Aparelhos conectados → Conectar um aparelho</b>.', 'Toque em <b>Conectar com número de telefone</b>.', 'Digite o código acima.'])}`;
      } catch (err) { aviso(err.message, true); }
    };
  }
  let pararQr = false;
  let ultimoQr = 0;
  function conectou() {
    clearInterval(atualizador);
    atualizador = null;
    aviso('WhatsApp conectado! 🎉');
    recarregar();
  }
  function acompanhar() {
    clearInterval(atualizador);
    ultimoQr = Date.now();
    atualizador = setInterval(async () => {
      if (location.hash !== aqui || !$('#zap-qr-area')) return void clearInterval(atualizador);
      try {
        const s = await api(`empresas/${id}/whatsapp/situacao`, { method: 'POST' });
        if (s.conectado) return conectou();
        const semImagem = !document.querySelector('#zap-qr-area img.qr');
        if (!pararQr && (semImagem || Date.now() - ultimoQr > 30000)) {
          ultimoQr = Date.now();
          mostrarQr(await api(`empresas/${id}/whatsapp/qrcode`, { method: 'POST' }));
        }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 4000);
  }
  async function pedirQr() {
    const area = $('#zap-qr-area');
    area.innerHTML = '<p class="rotulo"><span class="girando"></span> Gerando o QR code…</p>';
    try {
      mostrarQr(await api(`empresas/${id}/whatsapp/qrcode`, { method: 'POST' }));
      acompanhar();
    } catch (err) {
      area.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p><div class="acoes"><button type="button" id="qr-tentar">Tentar de novo</button></div>`;
      $('#qr-tentar').onclick = pedirQr;
    }
  }

  $('#zap-criar')?.addEventListener('click', async (e) => {
    const area = $('#zap-qr-area');
    try {
      const r = await comEspera(e.target, () => api(`empresas/${id}/whatsapp/criar`, { method: 'POST' }), 'Criando conexão…');
      e.target.closest('.acoes').hidden = true;
      mostrarQr(r);
      acompanhar();
    } catch (err) {
      if (err.status === 409) return tratarConflito(err, () => recarregar());
      area.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`;
    }
  });
  if (w.configurado && !online) pedirQr();

  $('#salvar-chave-global')?.addEventListener('click', async (e) => {
    const botao = e.currentTarget;
    const chave = $('#chave-global').value.trim();
    if (!chave) return aviso('Cole a chave global.', true);
    $('#chave-global-erro').innerHTML = '';
    try {
      const r = await comEspera(botao, async () => {
        await api('config', { method: 'PUT', body: { evolutionApiKey: chave } });
        return api(`empresas/${id}/whatsapp/criar`, { method: 'POST' });
      }, 'Criando conexão…');
      botao.closest('.acoes').hidden = true;
      mostrarQr(r);
      acompanhar();
    } catch (err) {
      if (err.status === 409) return tratarConflito(err, () => recarregar());
      $('#chave-global-erro').innerHTML = `<p class="erro-caixa" style="margin-top:12px">${esc(/não conferem|Unauthorized|401/i.test(err.message) ? 'A Evolution recusou essa chave. Confira se é a chave GLOBAL do servidor (a mesma EVOLUTION_API_KEY do DingDong Tracking).' : err.message)}</p>`;
    }
  });

  const TIPO_EVENTO = { respondeu: '✅ respondeu', ignorou: '⏸️ não respondeu', erro: '❌ erro' };
  async function rodarDiagnostico(botao) {
    const alvo = $('#resultado-diagnostico');
    try {
      const d = await comEspera(botao, () => api(`empresas/${id}/whatsapp/diagnostico`, { method: 'POST' }), 'Verificando…');
      const webhookRuim = d.itens.find((i) => i.titulo.startsWith('Mensagens chegando') && !i.ok);
      const pausadas = d.itens.find((i) => i.titulo.startsWith('Conversas com a IA pausada'));
      alvo.innerHTML = `
        <ul class="diagnostico">${d.itens.map((i) => `<li class="${i.ok ? 'ok' : 'ruim'}"><span>${i.ok ? '✓' : '✕'}</span><div><b>${esc(i.titulo)}</b>${i.detalhe ? `<div class="rotulo">${esc(i.detalhe)}</div>` : ''}</div></li>`).join('')}</ul>
        <div class="acoes">
          ${d.itens.some((i) => i.titulo === 'Empresa ativa no CRM' && !i.ok) && ehAdmin() ? `<button type="button" class="primario pequeno" data-reativar="${esc(id)}">Reativar a empresa</button>` : ''}
          ${webhookRuim ? '<button type="button" class="primario pequeno" id="consertar-webhook">Consertar: ligar as mensagens no CRM</button>' : ''}
          ${pausadas && /^\d/.test(pausadas.detalhe) ? '<button type="button" class="pequeno" id="devolver-todas">Devolver todas as conversas para a IA</button>' : ''}
        </div>
        ${d.eventos.length ? `<h3 style="margin:16px 0 8px;font-size:15px">O que a IA fez com as últimas mensagens</h3>
        <div class="tabela-wrap"><table><thead><tr><th>Quando</th><th>Cliente</th><th>O que aconteceu</th></tr></thead><tbody>${d.eventos.slice(0, 20).map((ev) => `<tr><td class="rotulo" style="white-space:nowrap">${data(ev.em)}</td><td>${ev.leadId ? `<a href="#/leads/${esc(ev.leadId)}">${esc(ev.cliente || 'cliente')}</a>` : '—'}</td><td>${TIPO_EVENTO[ev.tipo] || ev.tipo} <span class="rotulo">${esc(ev.motivo)}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="rotulo" style="margin-top:12px">Nenhuma mensagem recebida ainda desde a atualização. Mande um "oi" de outro número e verifique de novo.</p>'}`;
      $('#consertar-webhook')?.addEventListener('click', async (e) => {
        try {
          await comEspera(e.target, () => api(`empresas/${id}/whatsapp/webhook`, { method: 'POST' }));
          aviso('Pronto: as mensagens voltam a chegar no CRM.');
          rodarDiagnostico($('#rodar-diagnostico'));
        } catch (err) {
          if (err.status === 409) return tratarConflito(err, () => rodarDiagnostico($('#rodar-diagnostico')));
          aviso(err.message, true);
        }
      });
      $('#devolver-todas')?.addEventListener('click', async () => {
        const r = await api(`empresas/${id}/whatsapp/devolver-ia`, { method: 'POST' }).catch((err) => aviso(err.message, true));
        if (r) aviso(`${r.devolvidas} conversas devolvidas para a IA.`);
        rodarDiagnostico($('#rodar-diagnostico'));
      });
    } catch (err) {
      alvo.innerHTML = `<p class="erro-caixa" style="margin-top:12px">${esc(err.message)}</p>`;
    }
  }
  $('#rodar-diagnostico').onclick = (e) => rodarDiagnostico(e.currentTarget);

  $('#f-ritmo').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { velocidade: f.elements.velocidade.value, esperaPrimeiraSeg: Number(f.elements.esperaPrimeiraSeg.value), whatsappAvisos: f.elements.whatsappAvisos.value } }));
      aviso('Ritmo salvo.');
    } catch (err) { aviso(err.message, true); }
  };
  $('#zap-sincronizar')?.addEventListener('click', () => modalSincronizar(id, recarregar));
  if (w.configurado) { cartaoAvisoAgendamento(id); cartaoEtiquetasZap(id); cartaoListaNegra(id); }
  $('#ia-para-manual').onchange = (e) => trocarIaParaManual(id, e.target, recarregar);
  cartaoEventosIa(id);
  cartaoLogIa(id);
  // o prompt cita mídia sem conexão certa? avisa aqui também
  api(`empresas/${id}/midias/prompt`).then((r) => {
    const n = (r.pendencias || []).length;
    const area = $('textarea[name=promptWhatsapp]');
    if (!n || !area || location.hash !== aqui) return;
    const d = document.createElement('div');
    d.className = 'det-aviso';
    d.id = 'aviso-midias-prompt';
    d.innerHTML = `⚠️ Este prompt cita <b>${n} mídia(s)</b> sem conexão certa — a IA não consegue mandar. <a href="${rotaEmpresa(id, 'midias')}">Conectar agora →</a>`;
    area.closest('.campo').after(d);
  }).catch(() => {});
  $('#ia-economica').onchange = async (e) => {
    const ligar = e.target.checked;
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { iaEconomica: ligar } });
      aviso(ligar ? 'Modo econômico ligado.' : 'Modo econômico desligado: sempre o modelo escolhido.');
      recarregar();
    } catch (err) {
      e.target.checked = !ligar;
      aviso(err.message, true);
    }
  };
  $('#nao-atropelar').onchange = async (e) => {
    const ligar = e.target.checked;
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { naoAtropelar: ligar } });
      aviso(ligar ? 'Ligado: a IA junta as mensagens do cliente antes de responder.' : 'Desligado: a IA responde cada mensagem na hora.');
      recarregar();
    } catch (err) {
      e.target.checked = !ligar;
      aviso(err.message, true);
    }
  };
  const salvarTeste = async (modoTeste) => {
    const numerosTeste = $('#f-numeros-teste').elements.numerosTeste.value;
    await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { modoTeste, numerosTeste } });
  };
  $('#modo-teste').onchange = async (e) => {
    const ligar = e.target.checked;
    if (ligar && !$('#f-numeros-teste').elements.numerosTeste.value.trim()) {
      e.target.checked = false;
      aviso('Coloque primeiro o número de teste e depois ligue.', true);
      $('#f-numeros-teste').elements.numerosTeste.focus();
      return;
    }
    try {
      await salvarTeste(ligar);
      aviso(ligar ? 'Modo teste ligado: a IA só responde os números de teste.' : 'Modo teste desligado: a IA responde todos os clientes.');
      recarregar();
    } catch (err) {
      e.target.checked = !ligar;
      aviso(err.message, true);
    }
  };
  $('#f-numeros-teste').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await salvarTeste(w.modoTeste);
      aviso('Números de teste salvos.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  };

  $('#ligar-zap').onchange = async (e) => {
    try {
      await api(`empresas/${id}/canais`, { method: 'PUT', body: { whatsapp: e.target.checked } });
      aviso(e.target.checked ? 'IA do WhatsApp ligada.' : 'IA do WhatsApp desligada.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  };

  async function tratarConflito(err, depois) {
    const ok = await confirmar({
      titulo: 'Este WhatsApp já está ligado a outro sistema',
      texto: `<p>A instância manda as mensagens para: <code>${esc(err.dados?.webhookAtual || '')}</code></p><p>Se continuar, <b>esse outro sistema para de receber as mensagens</b> deste número.</p><p class="rotulo">O recomendado é usar uma conexão só para o CRM.</p>`,
      botao: 'Trocar mesmo assim',
      perigo: true
    });
    if (!ok) return aviso('Nada foi trocado.');
    try {
      await api(`empresas/${id}/whatsapp/webhook`, { method: 'POST', body: { forcar: true } });
      depois();
    } catch (e2) { aviso(e2.message, true); }
  }

  async function conectarManual(dados, botao, erroEl) {
    try {
      await comEspera(botao, () => api(`empresas/${id}/whatsapp/conectar`, { method: 'POST', body: dados }), 'Conferindo…');
      aviso('WhatsApp conectado!');
      recarregar();
    } catch (err) {
      if (err.status === 409) return tratarConflito(err, recarregar);
      if (erroEl) erroEl.innerHTML = `<p class="erro-caixa" style="margin-top:12px">${esc(err.message)}</p>`;
      else aviso(err.message, true);
    }
  }

  $('#zap-atualizar')?.addEventListener('click', (e) => comEspera(e.target, async () => {
    try {
      const s = await api(`empresas/${id}/whatsapp/situacao`, { method: 'POST' });
      if (s.webhookOk === false) {
        $('#zap-resultado').innerHTML = balao('As mensagens não estão chegando no CRM', 'A ligação com o CRM foi trocada por outro sistema. Clique em "Remover conexão" e conecte de novo.', 'aviso');
        return;
      }
      recarregar();
    } catch (err) { $('#zap-resultado').innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; }
  }, 'Conferindo…'));

  $('#zap-trocar-numero')?.addEventListener('click', async (e) => {
    if (!(await confirmar({ titulo: 'Trocar de número?', texto: 'O número atual sai do CRM (é desconectado no celular). Depois é só escanear um QR code novo com o outro número.', botao: 'Desconectar e trocar', perigo: true }))) return;
    try {
      await comEspera(e.target, () => api(`empresas/${id}/whatsapp/sair-numero`, { method: 'POST' }));
      recarregar();
    } catch (err) { aviso(err.message, true); }
  });

  $('#zap-trocar')?.addEventListener('click', () => abrirModal(`
    <h2>Trocar Session ID / API Key</h2>
    <form id="f-trocar">
      <div class="campo"><label>Session ID</label><input name="sessionId" required value="${esc(w.sessao)}" autocomplete="off"></div>
      <div class="campo" style="margin-top:12px"><label>API Key</label><input name="apiKey" type="password" autocomplete="off" placeholder="vazio = manter a atual (${esc(w.apiKeyFinal)})"></div>
      <div id="trocar-erro"></div>
      <div class="acoes"><button class="primario" type="submit">Conectar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    $('#f-trocar', m).onsubmit = (e) => {
      e.preventDefault();
      conectarManual(formParaObjeto(e.target), e.target.querySelector('button[type=submit]'), $('#trocar-erro', m)).then(() => { if (!$('#trocar-erro', m)?.innerHTML) fechar(); });
    };
  }));

  $('#zap-sair')?.addEventListener('click', async (e) => {
    const texto = w.criadaPeloCrm
      ? 'O número é desconectado e a IA para de responder. Para voltar, é só gerar um QR code novo.'
      : 'A IA para de responder e as mensagens deixam de chegar aqui. O número continua conectado na Evolution.';
    if (!(await confirmar({ titulo: 'Remover a conexão do WhatsApp?', texto, botao: 'Remover', perigo: true }))) return;
    try {
      await comEspera(e.target, () => api(`empresas/${id}/whatsapp/desconectar`, { method: 'POST' }));
      aviso('Conexão removida.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  });

  $('#f-evo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Servidor salvo.');
    } catch (err) { aviso(err.message, true); }
  });

  if (bot) {
    const form = $('#f-bot');
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await salvarBot(bot.id, form); } catch (err) { aviso(err.message, true); }
    };
    ligarAtualizarPrompt(form, bot.id);
    ligarConferirPrompt(form, bot.id, 'whatsapp');
    painelInstrucoes(form, bot.id, 'whatsapp');
    ligarChatTeste({ botId: bot.id, canal: 'whatsapp', rascunho: () => formParaObjeto(form), saudacao: () => '' });
  }
}

// ---------------------------------------------------------------- empresa: mídias

const ICONE_TIPO = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄' };

async function paginaMidias(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const [todas, albuns, { assuntos: ASSUNTOS }, sugMidia, noPrompt, logsErro, botPrincipal] = await Promise.all([api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`), api(`empresas/${id}/assuntos-midia`), api(`empresas/${id}/sugestao-midia`).catch(() => ({ ativo: true })), api(`empresas/${id}/midias/prompt`).catch(() => null), api(`empresas/${id}/logs-ia?soErros=1&limite=20`).catch(() => []), principalDa(id).catch(() => null)]);
  const errosRecentes = (logsErro || []).filter((l) => l.erros.length && Date.now() - new Date(l.em).getTime() < 3 * 86400000);
  const lista = todas.filter((m) => !m.pastaId);
  const pastas = emp.drivePastas || [];
  let links = (emp.links || []).map((l) => ({ ...l }));

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Mídias e respostas</h1><p class="sub">Fotos, vídeos, PDFs, links e respostas rápidas que a IA do WhatsApp manda para vender mais</p></div></div>
    ${balao('Como fazer a IA mandar a foto certa na hora certa', passos([
      '<b>Adicione</b> as fotos e vídeos (pode escolher vários de uma vez, até 200 MB cada, na qualidade original). Eles entram em <b>"A configurar"</b> — a IA ainda não usa.',
      'Em cada um, clique em <b>Configurar</b> e diga <b>quando enviar</b> (ex.: <i>"quando o cliente perguntar do serviço X ou pedir fotos"</i>). Se quiser, escolha a <b>etapa</b> (ex.: só em "Convertendo").',
      'Deixe <b>Ativa</b> marcada. Pronto: a IA manda sozinha na hora certa (cada mídia só uma vez por conversa, se você quiser).',
      'Vende mais de uma coisa? Crie <b>assuntos</b> (ex.: <i>Completo</i>, <i>Arco</i> — ou os do seu ramo) e marque em cada mídia: a IA só manda a mídia do assunto que está explicando. Mídias de <b>follow-up</b> ficam guardadas para o <a href="' + rotaEmpresa(id, 'followup') + '">Follow-up</a>.',
      'Cada mídia tem um <b>código</b> (ex.: <code>#MIDIA_TABELA</code>) com o botão <b>copiar código</b>. A lista de mídias entra sozinha no prompt da IA — você não precisa escrever. Mas pode citar o código nas instruções: <i>"Depois de passar o preço, envie #MIDIA_TABELA"</i>. Várias fotos juntas? Crie um <b>álbum</b>.'
    ]))}

    <div class="card card-midias-prompt" id="card-midias-prompt">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">🧩 Mídias no prompt da IA</h2>${botPrincipal ? '<button type="button" class="primario pequeno" id="abrir-modo-teste">🧪 Modo teste</button>' : ''}</div>
      <p class="rotulo" style="margin:0 0 8px">A lista das mídias <b>ativas</b> (código, tipo e quando enviar) entra sozinha no fim do prompt a cada resposta. A IA escreve o código na última linha e o CRM troca pelo arquivo — o código nunca chega ao cliente.</p>
      ${(noPrompt?.pendencias || []).length ? `<div class="det-erro forte pend-resumo">⚠️ Seu prompt cita <b>${noPrompt.pendencias.length} mídia(s)</b> que não estão conectadas do jeito certo — a IA não vai conseguir mandar. <button type="button" class="primario pequeno" id="resolver-prompt">Conectar agora</button></div>` : ''}
      ${noPrompt?.citados?.length && !(noPrompt.pendencias || []).length ? `<div class="rotulo">✓ Mídias citadas no prompt: ${[...new Set(noPrompt.citados.map((c) => c.codigo))].map((c) => `<span class="codigo-chip">${esc(c)}</span>`).join(' ')} — todas conectadas.</div>` : ''}
      ${errosRecentes.length ? `<div class="det-erro forte">✕ ${errosRecentes.length} resposta(s) com problema de mídia nos últimos 3 dias:<ul>${errosRecentes.slice(0, 5).map((l) => `<li><span class="rotulo">${esc(data(l.em))}${l.cliente ? ` · ${esc(l.cliente)}` : ''}</span> — ${esc(l.erros.join(' · '))}</li>`).join('')}</ul><a href="${rotaEmpresa(id, 'whatsapp')}">Ver o log completo →</a></div>` : ''}
    </div>

    <div class="card" id="card-sugestao-midia">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">💡 Sugerir a mídia certa na conversa</h2>${interruptor('sug-midia-ativo', sugMidia.ativo, sugMidia.ativo ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0">Quando o cliente <b>manda uma foto</b> ou <b>diz o que tem ou quer</b> (ex.: <i>"tenho um Civic 2019"</i>, <i>"é um iPhone 13"</i>, <i>"quero o vestido azul"</i>), o CRM procura nas suas mídias pelo <b>nome, descrição, assuntos e serviços</b> e mostra na conversa: <b>📸 Sugestão para mandar</b> com a mídia que combina e o botão <b>Mandar</b>. Nada é enviado sozinho. Dica: coloque o modelo/tipo no nome ou na descrição de cada mídia (ex.: <i>"Volante Civic"</i>, <i>"Capinha iPhone 13"</i>).</p>
    </div>

    <div class="card" id="biblioteca">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🖼️ Suas fotos, vídeos e arquivos</h2><span class="barra"><button type="button" id="midia-por-link" title="Cole o link de um arquivo do Google Drive">🔗 Por link do Drive</button><label class="botao primario">📤 Adicionar (vários de uma vez)<input type="file" id="mais-midias" multiple hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label></span></div>
      <label class="soltar" id="soltar"><span class="soltar-texto">📁 Arraste vários arquivos aqui — fotos, vídeos (até 200 MB cada, qualidade original), PDFs e áudios</span></label>
      <div id="fila-envio"></div>
      <div class="assuntos-midia" id="assuntos-midia"></div>
      <div class="chips abas-midia" id="abas-midia"></div>
      <div class="chips filtro-assunto" id="filtro-assunto"></div>
      <div class="barra-selecao" id="barra-selecao" hidden></div>
      <div id="grade-biblioteca"></div>
    </div>

    <div class="card" data-cfg="drive" data-pronto="${pastas.length ? 'ok' : 'off'}" data-resumo="${pastas.length ? `${pastas.length} pasta(s) conectada(s)` : 'Nenhuma pasta conectada'}">
      <h2>📁 Fotos do Google Drive</h2>
      <p class="rotulo" style="margin-top:-6px">Cada pasta vira um <b>álbum</b>: a IA manda as fotos da pasta de uma vez. Coloque fotos novas na pasta e o CRM sincroniza sozinho (a cada 6 horas, ou no botão).</p>
      <details ${pastas.length ? '' : 'open'}><summary>Como compartilhar a pasta</summary>${passos([
        'No Google Drive, clique com o botão direito na pasta → <b>Compartilhar</b>.',
        'Em "Acesso geral", escolha <b>Qualquer pessoa com o link</b> (leitor) → <b>Copiar link</b>.',
        'Cole o link aqui, dê um nome para o álbum e diga quando a IA deve mandar.'
      ])}</details>
      <form id="f-drive" class="campos" style="margin-top:12px">
        <div class="campo largo"><label>Link da pasta</label><input name="link" required placeholder="https://drive.google.com/drive/folders/…"></div>
        <div class="campo"><label>Nome do álbum</label><input name="nome" placeholder="Ex.: Trabalhos feitos"></div>
        <div class="campo"><label>Quando a IA deve mandar</label><input name="descricao" placeholder="Ex.: quando pedir fotos de trabalhos feitos"></div>
        <div class="campo largo"><div class="acoes" style="margin-top:0"><button class="primario" type="submit">Conectar pasta</button></div></div>
      </form>
      <div class="lista-pastas">
        ${pastas.map((p) => {
          const fotos = todas.filter((m) => m.pastaId === p.id);
          return `
          <div class="pasta">
            <div class="pasta-fotos">${fotos.slice(0, 4).map((m) => (m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`)).join('') || '<span>📁</span>'}</div>
            <div class="pasta-info"><strong>${esc(p.nome)} ${p.codigo ? `<button type="button" class="codigo-chip" data-copiar="${esc(codMidia(p.codigo))}" title="Copiar código">${esc(codMidia(p.codigo))} ⧉</button>` : ''}</strong><span class="rotulo">${p.total || 0} arquivos · ${esc(p.descricao || 'sem instrução de quando mandar')}</span><span class="rotulo">Sincronizada ${data(p.ultimaSincronia)}${p.falhas?.length ? ` · ${p.falhas.length} arquivo(s) não baixaram` : ''}</span></div>
            <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-sinc="${esc(p.id)}">🔄 Sincronizar</button><button type="button" class="pequeno" data-editar-pasta="${esc(p.id)}">Editar</button><button type="button" class="pequeno perigo" data-tirar-pasta="${esc(p.id)}">Remover</button></div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card" data-cfg="rapidas" data-pronto="${(emp.respostasRapidas || []).length ? 'ok' : 'off'}" data-resumo="${(emp.respostasRapidas || []).length ? `${emp.respostasRapidas.length} atalho(s)` : 'Nenhum atalho ainda'}">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">⚡ Respostas rápidas com mídia</h2><button type="button" class="primario pequeno" id="abrir-rapidas">Gerenciar</button></div>
      <p class="rotulo" style="margin:0 0 10px">Atalhos como <b>/preco</b> e <b>/catalogo</b> que mandam texto + foto, PDF ou álbum de uma vez — na aba Conversas${emp.atalhosNoCelular !== false ? ' e digitando no WhatsApp do celular' : ''}.</p>
      ${(emp.respostasRapidas || []).length ? `<div class="tabela-wrap"><table><thead><tr><th>Atalho</th><th>Manda</th><th class="esconde-mobile">Quando usar</th></tr></thead><tbody>${emp.respostasRapidas.map((r) => `<tr><td><b>/${esc(r.atalho)}</b></td><td>${esc((r.texto || '').slice(0, 70))}${(r.texto || '').length > 70 ? '…' : ''}${r.midia ? ` <span class="codigo-chip">${esc(codMidia(r.midia))}</span>` : ''}</td><td class="esconde-mobile rotulo">${esc(r.quando || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<span class="rotulo">Nenhuma ainda.</span>'}
    </div>

    <div class="card" data-cfg="links" data-pronto="${links.length ? 'ok' : 'off'}" data-resumo="${links.length ? `${links.length} link(s)` : 'Nenhum link ainda'}">
      <h2>🔗 Links</h2>
      <p class="rotulo" style="margin-top:-6px">Site, catálogo, cardápio, localização no mapa, agenda online, Instagram… A IA manda quando fizer sentido.</p>
      <div id="lista-links" class="lista-editavel"></div>
      <div class="acoes"><button type="button" id="add-link">+ Novo link</button><button type="button" class="primario" id="salvar-links">Salvar links</button></div>
    </div>
`;

  // ⚠️ mídias citadas no prompt sem conexão: o aviso abre sozinho (uma vez por sessão para o mesmo conjunto)
  const pendencias = noPrompt?.pendencias || [];
  const abrirPendencias = () => modalPendenciasPrompt(id, pendencias, [...lista.filter((m) => !m.albumId), ...albuns.map((a) => ({ ...a, tipo: 'album' })), ...pastas.map((p) => ({ ...p, tipo: 'album' }))], () => paginaMidias(id));
  $('#resolver-prompt')?.addEventListener('click', abrirPendencias);
  if (pendencias.length) {
    const chave = `pend-prompt-${id}`;
    const assinatura = pendencias.map((x) => x.id).sort().join(',');
    let visto = '';
    try { visto = sessionStorage.getItem(chave) || ''; } catch { /* ok */ }
    if (visto !== assinatura) {
      try { sessionStorage.setItem(chave, assinatura); } catch { /* ok */ }
      abrirPendencias();
    }
  }
  $('#abrir-modo-teste')?.addEventListener('click', () => {
    abrirModal(`<div class="modal-teste">${htmlChatTeste('whatsapp', false)}</div><div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m) => {
      m.querySelector('.modal').classList.add('modal-largo');
      ligarChatTeste({ botId: botPrincipal.id, canal: 'whatsapp', rascunho: null, saudacao: () => '' });
    });
  });
  $('#midia-por-link').onclick = () => {
    abrirModal(`
      <h2>🔗 Mídia por link do Google Drive</h2>
      <p class="rotulo" style="margin:0 0 10px">No Drive: botão direito no arquivo → <b>Compartilhar</b> → "Qualquer pessoa com o link" → <b>Copiar link</b>. O CRM converte para o link de download direto, baixa e guarda o arquivo.</p>
      <form id="f-midia-link">
        <div class="campo"><label>Link do arquivo *</label><input name="link" required placeholder="https://drive.google.com/file/d/…/view"></div>
        <div class="campos" style="margin-top:10px">
          <div class="campo"><label>Nome *</label><input name="nome" required placeholder="Ex.: Vídeo revestimento completo"></div>
          <div class="campo"><label>Código (opcional)</label><input name="codigo" placeholder="#MIDIA_… (vazio = criado pelo nome)" style="text-transform:uppercase"></div>
        </div>
        <div class="campo" style="margin-top:10px"><label>Quando a IA deve enviar</label><textarea name="descricao" rows="2" placeholder="Ex.: quando o cliente perguntar do serviço completo"></textarea></div>
        <div class="campo" style="margin-top:10px"><label>Legenda (opcional)</label><input name="legenda" maxlength="1000"></div>
        <label class="linha-check" style="margin-top:10px"><input type="checkbox" name="umaVez" checked> Enviar uma vez por conversa</label>
        <label class="linha-check" style="margin-top:6px"><input type="checkbox" name="ativa" checked> Ativa (precisa do "quando enviar")</label>
        <div class="acoes"><button class="primario" type="submit">Adicionar</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (modal, fechar) => {
      $('#f-midia-link', modal).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          const nova = await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/midias/link`, { method: 'POST', body: { link: f.elements.link.value, nome: f.elements.nome.value, codigo: f.elements.codigo.value, descricao: f.elements.descricao.value, legenda: f.elements.legenda.value, umaVezPorConversa: f.elements.umaVez.checked, ativa: f.elements.ativa.checked } }), 'Baixando do Drive…');
          fechar();
          aviso(`Mídia ${nova.codigoVisivel} adicionada${nova.pronta === false ? ' — falta o "quando enviar" para ativar' : ''}.`);
          paginaMidias(id);
        } catch (err) { aviso(err.message, true); }
      };
    });
  };
  $('#abrir-rapidas').onclick = () => modalRespostasRapidas(emp, null).then(() => {
    // redesenha a lista resumida quando o modal fechar (se ainda estiver nesta página)
    const aqui = location.hash;
    const obs = new MutationObserver(() => {
      if (document.querySelector('.fundo-modal')) return;
      obs.disconnect();
      if (location.hash === aqui) paginaMidias(id);
    });
    obs.observe(document.body, { childList: true });
  });

  // ---------- Drive
  $('#f-drive').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await comEspera(e.target.querySelector('button[type=submit]'), () => api(`empresas/${id}/drive`, { method: 'POST', body: formParaObjeto(e.target) }), 'Baixando fotos…');
      aviso(`Álbum "${r.pasta.nome}" conectado: ${r.adicionados} arquivos.${r.falhas.length ? ` ${r.falhas.length} não baixaram.` : ''}`);
      paginaMidias(id);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-sinc]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await comEspera(b, () => api(`empresas/${id}/drive/${b.dataset.sinc}/sincronizar`, { method: 'POST' }), 'Sincronizando…');
        aviso(`Sincronizado: ${r.adicionados} novos, ${r.removidos} removidos.`);
        paginaMidias(id);
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-tirar-pasta]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar({ titulo: 'Remover este álbum?', texto: 'As fotos saem do CRM (no seu Drive continuam).', botao: 'Remover', perigo: true }))) return;
      await api(`empresas/${id}/drive/${b.dataset.tirarPasta}`, { method: 'DELETE' }).catch((err) => aviso(err.message, true));
      paginaMidias(id);
    };
  });
  $$('[data-editar-pasta]').forEach((b) => {
    b.onclick = () => {
      const p = pastas.find((x) => x.id === b.dataset.editarPasta);
      abrirModal(`
        <h2>Editar álbum</h2>
        <form id="f-ed-pasta">
          <div class="campo"><label>Nome do álbum</label><input name="nome" required value="${esc(p.nome)}"></div>
          <div class="campo" style="margin-top:12px"><label>Código</label><input name="codigo" value="${esc(p.codigo || '')}" style="text-transform:uppercase"></div>
          <div class="campo" style="margin-top:12px"><label>Quando a IA deve mandar</label><input name="descricao" value="${esc(p.descricao || '')}"></div>
          ${(emp.etapas || []).length ? `<div class="campo" style="margin-top:12px"><label>Só enviar nestas etapas (opcional)</label><div class="chips">${emp.etapas.map((e) => `<label class="chip-check"><input type="checkbox" name="etapa" value="${esc(e)}" ${(p.etapas || []).includes(e) ? 'checked' : ''}><span>${esc(e)}</span></label>`).join('')}</div></div>` : ''}
          <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
        </form>`, (m, fechar) => {
        $('#f-ed-pasta', m).onsubmit = async (e) => {
          e.preventDefault();
          try {
            const f = e.target;
            await api(`empresas/${id}/drive/${p.id}`, { method: 'PUT', body: { nome: f.elements.nome.value, codigo: f.elements.codigo.value, descricao: f.elements.descricao.value, etapas: [...f.querySelectorAll('input[name=etapa]:checked')].map((c) => c.value) } });
            fechar();
            paginaMidias(id);
          } catch (err) { aviso(err.message, true); }
        };
      });
    };
  });

  // ---------- links
  function desenharLinks() {
    $('#lista-links').innerHTML = links.map((l, i) => `
      <div class="linha-link">
        <input value="${esc(l.nome)}" data-lnome="${i}" placeholder="Nome (ex.: Catálogo)" maxlength="80">
        <input value="${esc(l.url)}" data-lurl="${i}" placeholder="https://…">
        <input value="${esc(l.descricao || '')}" data-ldesc="${i}" placeholder="Quando mandar (ex.: quando pedir o catálogo)">
        <button type="button" class="pequeno perigo" data-ltirar="${i}" title="Remover">✕</button>
      </div>`).join('') || '<p class="rotulo">Nenhum link ainda.</p>';
    $$('[data-lnome]').forEach((el) => { el.oninput = () => { links[el.dataset.lnome].nome = el.value; }; });
    $$('[data-lurl]').forEach((el) => { el.oninput = () => { links[el.dataset.lurl].url = el.value; }; });
    $$('[data-ldesc]').forEach((el) => { el.oninput = () => { links[el.dataset.ldesc].descricao = el.value; }; });
    $$('[data-ltirar]').forEach((el) => { el.onclick = () => { links.splice(Number(el.dataset.ltirar), 1); desenharLinks(); }; });
  }
  desenharLinks();
  $('#add-link').onclick = () => { links.push({ nome: '', url: '', descricao: '' }); desenharLinks(); $$('[data-lnome]').pop()?.focus(); };
  $('#salvar-links').onclick = async () => {
    try {
      links = (await api(`empresas/${id}/links`, { method: 'PUT', body: { links } })).map((l) => ({ ...l }));
      desenharLinks();
      aviso('Links salvos.');
    } catch (err) { aviso(err.message, true); }
  };

  // ---------- biblioteca (abas, seleção, envio em massa)
  const ETAPAS = emp.etapas || [];
  const semRegra = (m) => !m.descricao?.trim();
  const grupos = {
    configurar: { nome: '⚠️ A configurar', filtro: (m) => m.pronta === false && !m.soFollowup },
    fotos: { nome: '📷 Fotos', filtro: (m) => m.pronta !== false && !m.soFollowup && m.tipo === 'image' },
    videos: { nome: '🎬 Vídeos', filtro: (m) => m.pronta !== false && !m.soFollowup && m.tipo === 'video' },
    docs: { nome: '📄 Documentos e áudios', filtro: (m) => m.pronta !== false && !m.soFollowup && !['image', 'video'].includes(m.tipo) },
    // separadas: só saem no follow-up (a IA nunca manda na conversa)
    followup: { nome: '🔁 Só follow-up', filtro: (m) => m.soFollowup === true },
    albuns: { nome: '🗂️ Álbuns', filtro: () => false }
  };
  let aba = lista.some((m) => m.pronta === false && !m.soFollowup) ? 'configurar' : 'fotos';
  let filtroAssunto = '';
  const passaAssunto = (m) => !filtroAssunto || (filtroAssunto === '__sem' ? !(m.assuntos || []).length : filtroAssunto === '__fup' ? m.soFollowup : (m.assuntos || []).includes(filtroAssunto));
  const chipsAssuntos = (x) => `${(x.assuntos || []).map((a) => `<span class="etiqueta assunto">🏷️ ${esc(a)}</span>`).join(' ')}${x.soFollowup ? ' <span class="etiqueta fup">🔁 só follow-up</span>' : ''}`;
  // editor dos assuntos (cada empresa cria os seus)
  function desenharAssuntos() {
    $('#assuntos-midia').innerHTML = `
      <div class="assuntos-linha"><b>🏷️ Assuntos</b> ${ajuda('Separe suas mídias pelo que você vende ou explica (ex.: Completo, Arco · numa clínica: Limpeza, Clareamento). Marque o assunto em cada mídia: a IA só manda mídia do assunto que está explicando. Mídia sem assunto vale para tudo.')}
        ${ASSUNTOS.map((a, i) => `<span class="etiqueta assunto">${esc(a)} <button type="button" class="x-chip" data-tirar-assunto="${i}" title="Remover assunto">✕</button></span>`).join(' ') || '<span class="rotulo">nenhum ainda</span>'}
        <form id="f-assunto" class="inline-form"><input name="a" maxlength="40" placeholder="Novo assunto (ex.: Completo)"><button type="submit" class="pequeno">+ Criar</button></form>
      </div>`;
    const salvarLista = async (nova) => {
      try {
        ASSUNTOS.splice(0, ASSUNTOS.length, ...(await api(`empresas/${id}/assuntos-midia`, { method: 'PUT', body: { assuntos: nova } })).assuntos);
        const ok = new Set(ASSUNTOS);
        for (const x of [...lista, ...albuns]) if (x.assuntos) x.assuntos = x.assuntos.filter((a) => ok.has(a));
        if (filtroAssunto && !filtroAssunto.startsWith('__') && !ok.has(filtroAssunto)) filtroAssunto = '';
        desenharAssuntos();
        desenharBiblioteca();
      } catch (err) { aviso(err.message, true); }
    };
    $('#f-assunto').onsubmit = (e) => { e.preventDefault(); const v = e.target.elements.a.value.trim(); if (v) salvarLista([...ASSUNTOS, v]); };
    $$('[data-tirar-assunto]').forEach((b) => {
      b.onclick = async () => {
        const nome = ASSUNTOS[Number(b.dataset.tirarAssunto)];
        if (!(await confirmar({ titulo: `Remover o assunto "${nome}"?`, texto: 'As mídias continuam; só perdem essa marcação.', botao: 'Remover', perigo: true }))) return;
        salvarLista(ASSUNTOS.filter((a) => a !== nome));
      };
    });
  }
  desenharAssuntos();
  try { aba = sessionStorage.getItem(`midias_aba_${id}`) || aba; } catch { /* ok */ }
  const selecionadas = new Set();
  const albumDe = (m) => albuns.find((a) => a.id === m.albumId);
  const previa = (m) => (m.tipo === 'image'
    ? `<img src="${esc(m.url)}" alt="" loading="lazy">`
    : m.tipo === 'video'
      ? (m.processando
        ? '<span class="video-convertendo"><span class="girando-emoji">⏳</span><small>Convertendo para o WhatsApp…</small></span>'
        : `<video src="${esc(m.url)}#t=0.5" preload="metadata" muted playsinline onerror="this.hidden=true"></video><span class="selo-video">▶</span>`)
      : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`);
  const duracaoTxt = (s) => (s ? ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');
  const statusVideo = (m) => {
    if (m.tipo !== 'video') return '';
    if (m.processando) return '<span class="rotulo">⏳ Convertendo para MP4 do WhatsApp — a IA usa assim que terminar.</span>';
    if (m.erroVideo) return `<span class="rotulo aviso-texto">⚠️ ${esc(m.erroVideo.replace(/\.?$/, '.'))} Vai como arquivo.</span>`;
    if (m.avisoVideo) return `<span class="rotulo aviso-texto">⚠️ ${esc(m.avisoVideo)}</span>`;
    if (m.convertido) return `<span class="rotulo">✓ Convertido para o WhatsApp (${(m.convertido.tamanhoAntes / 1024 / 1024).toFixed(1)} MB → ${(m.tamanho / 1024 / 1024).toFixed(1)} MB)</span>`;
    if (m.videoOk) return '<span class="rotulo">✓ Pronto para tocar no WhatsApp</span>';
    return '';
  };
  const chipEtapas = (etapas) => (etapas?.length ? etapas.map((e) => `<span class="etiqueta">${esc(e)}</span>`).join(' ') : '');
  const cartao = (m) => `
    <div class="card midia ${selecionadas.has(m.id) ? 'selecionada' : ''} ${m.pronta === false ? 'a-configurar' : ''}">
      <label class="midia-check" title="Selecionar"><input type="checkbox" data-sel="${esc(m.id)}" ${selecionadas.has(m.id) ? 'checked' : ''}></label>
      <a class="midia-previa" href="${esc(m.url)}" target="_blank" rel="noopener">${previa(m)}</a>
      <strong>${esc(m.nome)}</strong>
      <span><button type="button" class="codigo-chip" data-copiar="${esc(codMidia(m.codigo))}" title="Copiar código para colar no prompt">${esc(codMidia(m.codigo))} ⧉ copiar código</button>${albumDe(m) ? ` <span class="etiqueta">🗂️ ${esc(albumDe(m).nome)}</span>` : ''}</span>
      <span class="rotulo">${semRegra(m) ? '<span class="aviso-texto">⚠️ falta dizer quando enviar</span>' : `Quando: ${esc(m.descricao)}`}</span>
      ${m.etapas?.length ? `<span class="rotulo">Só na etapa: ${chipEtapas(m.etapas)}</span>` : ''}
      ${(m.assuntos || []).length || m.soFollowup ? `<span class="rotulo">${chipsAssuntos(m)}</span>` : ''}
      ${statusVideo(m)}
      <span class="rotulo">${m.tamanho < 100 * 1024 ? `${Math.max(1, Math.round(m.tamanho / 1024))} KB` : `${(m.tamanho / 1024 / 1024).toFixed(1)} MB`}${duracaoTxt(m.duracao)} · ${m.pronta === false ? '<span class="etiqueta aviso">a configurar</span>' : '<span class="etiqueta ok">✓ ativa</span>'}${m.umaVezPorConversa === false ? ' <span class="etiqueta">pode repetir</span>' : ''}${m.legenda ? ' <span class="etiqueta" title="Tem legenda">💬 legenda</span>' : ''}</span>
      <div class="acoes" style="margin-top:8px"><button class="pequeno ${m.pronta === false ? 'primario' : ''}" data-editar="${esc(m.id)}">${m.pronta === false ? 'Configurar' : 'Editar'}</button><button class="pequeno perigo" data-apagar="${esc(m.id)}">Apagar</button></div>
    </div>`;
  const cartaoAlbum = (a) => {
    const itens = lista.filter((m) => m.albumId === a.id);
    return `
    <div class="pasta">
      <div class="pasta-fotos">${itens.slice(0, 4).map((m) => (m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`)).join('') || '<span>🗂️</span>'}</div>
      <div class="pasta-info"><strong>${esc(a.nome)} <button type="button" class="codigo-chip" data-copiar="${esc(codMidia(a.codigo))}" title="Copiar código">${esc(codMidia(a.codigo))} ⧉</button></strong><span class="rotulo">${itens.length} ${itens.length === 1 ? 'arquivo' : 'arquivos'}${itens.some((m) => m.pronta === false || m.processando) ? ` · <span class="aviso-texto">⚠️ só ${itens.filter((m) => m.pronta !== false && !m.processando).length} pronta(s) — a IA manda só as prontas</span>` : ''} · ${a.descricao ? `quando: ${esc(a.descricao)}` : '<span class="aviso-texto">⚠️ falta dizer quando enviar</span>'}</span>${a.etapas?.length ? `<span class="rotulo">Só na etapa: ${chipEtapas(a.etapas)}</span>` : ''}${(a.assuntos || []).length || a.soFollowup ? `<span class="rotulo">${chipsAssuntos(a)}</span>` : ''}</div>
      <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-editar-album="${esc(a.id)}">Editar</button><button type="button" class="pequeno perigo" data-apagar-album="${esc(a.id)}">Apagar álbum</button></div>
    </div>`;
  };
  function desenharBiblioteca() {
    $('#abas-midia').innerHTML = Object.entries(grupos).map(([k, g]) => {
      const n = k === 'albuns' ? albuns.filter(passaAssunto).length : lista.filter((m) => g.filtro(m) && passaAssunto(m)).length;
      return `<button type="button" class="chip-filtro ${k === aba ? 'ativo' : ''}" data-aba="${k}">${g.nome} <b>${n}</b></button>`;
    }).join('');
    $$('[data-aba]').forEach((b) => { b.onclick = () => { aba = b.dataset.aba; try { sessionStorage.setItem(`midias_aba_${id}`, aba); } catch { /* ok */ } selecionadas.clear(); desenharBiblioteca(); }; });
    $('#filtro-assunto').innerHTML = ASSUNTOS.length
      ? [['', 'Todos os assuntos'], ...ASSUNTOS.map((a) => [a, `🏷️ ${a}`]), ['__sem', 'Sem assunto']]
        .map(([v, t]) => `<button type="button" class="chip-filtro pequeno-chip ${filtroAssunto === v ? 'ativo' : ''}" data-fassunto="${esc(v)}">${esc(t)}</button>`).join('')
      : '';
    $$('[data-fassunto]').forEach((b) => { b.onclick = () => { filtroAssunto = b.dataset.fassunto; selecionadas.clear(); desenharBiblioteca(); }; });
    const grade = $('#grade-biblioteca');
    if (aba === 'albuns') {
      grade.innerHTML = `<p class="rotulo" style="margin:4px 0 12px">Álbum = várias mídias que a IA manda juntas (até 10). Selecione as mídias nas outras abas e use <b>Pôr no álbum</b>, ou crie aqui.</p>
        <div class="acoes" style="margin:0 0 12px"><button type="button" class="primario pequeno" id="novo-album">+ Novo álbum</button></div>
        <div class="lista-pastas">${albuns.filter(passaAssunto).map(cartaoAlbum).join('') || '<p class="rotulo">Nenhum álbum aqui.</p>'}</div>`;
    } else {
      const itens = lista.filter((m) => grupos[aba].filtro(m) && passaAssunto(m));
      grade.innerHTML = (aba === 'followup' ? `<p class="rotulo" style="margin:4px 0 10px">🔁 Estas mídias <b>só saem no follow-up</b> (escolha nos passos da aba <a href="${rotaEmpresa(id, 'followup')}">Follow-up</a>). A IA <b>nunca</b> manda estas na conversa. Para mover para cá: selecione e use <b>Uso → Só no follow-up</b>, ou envie arquivos com esta aba aberta.</p>` : '') +
        (itens.length ? `<div class="grade-midias">${itens.map(cartao).join('')}</div>` : `<p class="rotulo" style="padding:12px 0">${aba === 'configurar' ? 'Nada para configurar. 🎉' : 'Nenhuma aqui ainda.'}</p>`);
    }
    const barra = $('#barra-selecao');
    barra.hidden = !selecionadas.size;
    barra.innerHTML = `<b>${selecionadas.size} selecionada${selecionadas.size === 1 ? '' : 's'}</b>
      <button type="button" class="pequeno primario" data-lote="pronta">✓ Marcar como prontas</button>
      <button type="button" class="pequeno" data-lote="aConfigurar">Voltar para "a configurar"</button>
      <select id="lote-album"><option value="">🗂️ Pôr no álbum…</option>${albuns.map((a) => `<option value="${esc(a.id)}">${esc(a.nome)}</option>`).join('')}<option value="__novo">+ Novo álbum com elas</option><option value="__sem">Tirar do álbum</option></select>
      ${ASSUNTOS.length ? `<select id="lote-assunto"><option value="">🏷️ Assunto…</option>${ASSUNTOS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}<option value="__nenhum">Sem assunto (vale para tudo)</option></select>` : ''}
      <select id="lote-uso"><option value="">🔁 Uso…</option><option value="naConversa">Conversa e follow-up</option><option value="soFollowup">Só no follow-up</option></select>
      <button type="button" class="pequeno perigo" data-lote="apagar">Apagar</button>
      <button type="button" class="pequeno" id="limpar-sel">Desmarcar</button>`;
    ligarBiblioteca();
  }
  async function lote(acao, extra = {}) {
    if (acao === 'apagar' && !(await confirmar({ titulo: `Apagar ${selecionadas.size} mídia(s)?`, texto: 'A IA não vai mais conseguir enviá-las.', botao: 'Apagar', perigo: true }))) return;
    try {
      await api(`empresas/${id}/midias/lote`, { method: 'POST', body: { ids: [...selecionadas], acao, ...extra } });
      aviso('Pronto.');
      paginaMidias(id);
    } catch (err) { aviso(err.message, true); }
  }
  function ligarBiblioteca() {
    $$('[data-sel]').forEach((c) => { c.onchange = () => { if (c.checked) selecionadas.add(c.dataset.sel); else selecionadas.delete(c.dataset.sel); desenharBiblioteca(); }; });
    $$('[data-lote]').forEach((b) => { b.onclick = () => lote(b.dataset.lote); });
    $('#limpar-sel')?.addEventListener('click', () => { selecionadas.clear(); desenharBiblioteca(); });
    $('#lote-album')?.addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      if (v === '__novo') return modalAlbum(null, [...selecionadas]);
      lote('album', { albumId: v === '__sem' ? '' : v });
    });
    $('#lote-assunto')?.addEventListener('change', (e) => {
      const v = e.target.value;
      if (v) lote('assuntos', { assuntos: v === '__nenhum' ? [] : [v] });
    });
    $('#lote-uso')?.addEventListener('change', (e) => { if (e.target.value) lote(e.target.value); });
    $$('[data-copiar]').forEach((b) => { b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copiar).then(() => aviso(`Código ${b.dataset.copiar} copiado.`)).catch(() => aviso(b.dataset.copiar)); }; });
    $$('[data-apagar]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmar({ titulo: 'Apagar esta mídia?', texto: 'A IA não vai mais conseguir enviá-la.', botao: 'Apagar', perigo: true }))) return;
        try {
          await api(`empresas/${id}/midias/${b.dataset.apagar}`, { method: 'DELETE' });
          paginaMidias(id);
        } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-editar]').forEach((b) => { b.onclick = () => modalMidia(lista.find((x) => x.id === b.dataset.editar)); });
    $('#novo-album')?.addEventListener('click', () => modalAlbum(null, []));
    $$('[data-editar-album]').forEach((b) => { b.onclick = () => modalAlbum(albuns.find((a) => a.id === b.dataset.editarAlbum), null); });
    $$('[data-apagar-album]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmar({ titulo: 'Apagar este álbum?', texto: 'As mídias dele continuam na biblioteca.', botao: 'Apagar álbum', perigo: true }))) return;
        await api(`empresas/${id}/albuns/${b.dataset.apagarAlbum}`, { method: 'DELETE' }).catch((err) => aviso(err.message, true));
        paginaMidias(id);
      };
    });
  }
  // campos iguais para mídia e álbum: quando enviar + etapas
  const camposQuando = (item) => `
    <div class="campo" style="margin-top:12px"><label>Quando a IA deve enviar ${ajuda('Escreva como falaria para um funcionário. A IA segue isto à risca.')}</label><textarea name="descricao" rows="2" placeholder="Ex.: quando o cliente perguntar desse serviço ou pedir fotos do resultado">${esc(item?.descricao || '')}</textarea>
      <small>Exemplos: <i>quando pedir o preço</i> · <i>logo depois de mandar o orçamento</i> · <i>quando perguntar onde fica a loja</i></small></div>
    ${ETAPAS.length ? `<div class="campo" style="margin-top:12px"><label>Só enviar nestas etapas (opcional) ${ajuda('Nenhuma marcada = qualquer etapa. Marcada = a IA só manda quando o cliente estiver nessa etapa do funil.')}</label><div class="chips">${ETAPAS.map((e) => `<label class="chip-check"><input type="checkbox" name="etapa" value="${esc(e)}" ${(item?.etapas || []).includes(e) ? 'checked' : ''}><span>${esc(e)}</span></label>`).join('')}</div></div>` : ''}
    <div class="campo" style="margin-top:12px"><label>Assunto — enviar ao explicar… ${ajuda('Nenhum marcado = vale para qualquer assunto. Marcado = a IA só manda quando estiver explicando esse assunto. Crie os assuntos do seu negócio na página Mídias.')}</label>${ASSUNTOS.length ? `<div class="chips">${ASSUNTOS.map((a) => `<label class="chip-check"><input type="checkbox" name="assunto" value="${esc(a)}" ${(item?.assuntos || []).includes(a) ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div>` : '<small>Nenhum assunto criado ainda — crie em "🏷️ Assuntos", acima da biblioteca (ex.: Completo, Arco).</small>'}</div>
    <div class="campo" style="margin-top:12px"><label>Onde usar</label><div class="chips">
      <label class="chip-check"><input type="radio" name="uso" value="conversa" ${item?.soFollowup ? '' : 'checked'}><span>💬 Conversa e follow-up</span></label>
      <label class="chip-check"><input type="radio" name="uso" value="followup" ${item?.soFollowup ? 'checked' : ''}><span>🔁 Só no follow-up</span></label>
    </div></div>`;
  const lerEtapas = (form) => [...form.querySelectorAll('input[name=etapa]:checked')].map((c) => c.value);
  const lerAssuntos = (form) => ({ assuntos: [...form.querySelectorAll('input[name=assunto]:checked')].map((c) => c.value), soFollowup: form.querySelector('input[name=uso]:checked')?.value === 'followup' });
  function modalMidia(m) {
    abrirModal(`
      <h2>${m.pronta === false ? 'Configurar mídia' : 'Editar mídia'}</h2>
      <div class="midia-previa grande-previa">${previa(m)}</div>
      <form id="f-ed-midia">
        <div class="campos">
          <div class="campo"><label>Nome</label><input name="nome" required value="${esc(m.nome)}"></div>
          <div class="campo"><label>Código ${ajuda('É assim que a IA pede esta mídia, sem risco de mandar outra. Formato #MIDIA_ + MAIÚSCULAS e _ (o CRM ajeita sozinho). Pode citar nas instruções da IA: "envie #MIDIA_TABELA quando…".')}</label><input name="codigo" required value="${esc(codMidia(m.codigo))}" style="text-transform:uppercase"></div>
        </div>
        <p class="rotulo" style="margin:6px 0 0">Tipo: <b>${esc(TIPO_MIDIA_TXT[m.tipo] || m.tipo)}</b>${m.origemLink ? ` · veio do link <a href="${esc(m.origemLink)}" target="_blank" rel="noopener">Google Drive</a>` : ''}</p>
        ${camposQuando(m)}
        ${m.tipo === 'audio' ? '' : `<div class="campo" style="margin-top:12px"><label>Legenda (opcional) ${ajuda('Texto que vai junto com a foto/vídeo/documento no WhatsApp.')}</label><input name="legenda" value="${esc(m.legenda || '')}" maxlength="1000" placeholder="Ex.: Resultado do serviço completo ✨"></div>`}
        <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="umaVez" ${m.umaVezPorConversa === false ? '' : 'checked'}> Enviar <b>uma vez por conversa</b> (a IA não repete para o mesmo cliente)</label>
        <div class="campo" style="margin-top:12px"><label>Álbum</label><select name="albumId"><option value="">— nenhum —</option>${albuns.map((a) => `<option value="${esc(a.id)}" ${a.id === m.albumId ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select></div>
        <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="pronta" ${m.pronta === false ? '' : 'checked'}> <b>Ativa</b> — a IA já pode enviar (desmarcada = fica em "a configurar")</label>
        <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (modal, fechar) => {
      $('#f-ed-midia', modal).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        if (f.elements.pronta.checked && !f.elements.descricao.value.trim() && !f.elements.albumId.value) {
          if (!(await confirmar({ titulo: 'Sem "quando enviar"?', texto: 'Sem essa regra a IA decide sozinha quando mandar. Quer salvar assim mesmo?', botao: 'Salvar assim' }))) return;
        }
        try {
          await api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: { nome: f.elements.nome.value, codigo: f.elements.codigo.value, descricao: f.elements.descricao.value, etapas: lerEtapas(f), ...lerAssuntos(f), albumId: f.elements.albumId.value, pronta: f.elements.pronta.checked, umaVezPorConversa: f.elements.umaVez.checked, ...(f.elements.legenda ? { legenda: f.elements.legenda.value } : {}) } });
          fechar();
          aviso('Mídia salva.');
          paginaMidias(id);
        } catch (err) { aviso(err.message, true); }
      };
    });
  }
  function modalAlbum(a, novasMidias) {
    abrirModal(`
      <h2>${a ? 'Editar álbum' : 'Novo álbum'}</h2>
      <form id="f-album">
        <div class="campos">
          <div class="campo"><label>Nome do álbum</label><input name="nome" required value="${esc(a?.nome || '')}" placeholder="Ex.: Trabalhos feitos"></div>
          <div class="campo"><label>Código ${ajuda('Vazio = o CRM cria a partir do nome.')}</label><input name="codigo" value="${esc(a?.codigo ? codMidia(a.codigo) : '')}" placeholder="#MIDIA_TRABALHOS_FEITOS" style="text-transform:uppercase"></div>
        </div>
        ${camposQuando(a)}
        ${novasMidias?.length ? `<p class="rotulo" style="margin-top:10px">${novasMidias.length} mídia(s) selecionada(s) entram neste álbum.</p>` : ''}
        <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (modal, fechar) => {
      $('#f-album', modal).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const corpo = { nome: f.elements.nome.value, codigo: f.elements.codigo.value, descricao: f.elements.descricao.value, etapas: lerEtapas(f), ...lerAssuntos(f), midias: novasMidias || [] };
        try {
          await api(a ? `empresas/${id}/albuns/${a.id}` : `empresas/${id}/albuns`, { method: a ? 'PUT' : 'POST', body: corpo });
          fechar();
          aviso('Álbum salvo.');
          paginaMidias(id);
        } catch (err) { aviso(err.message, true); }
      };
    });
  }

  // envio em massa: cada arquivo vai em pedaços (aceita vídeos grandes) e entra em "a configurar"
  async function enviarArquivos(arquivos) {
    const abaDoEnvio = aba; // enviando com a aba "Só follow-up" aberta: entram como só follow-up
    const fila = $('#fila-envio');
    const lista_ = [...arquivos];
    fila.innerHTML = lista_.map((a, i) => `<div class="envio-item" id="envio-${i}"><span>${esc(a.name)}</span><span class="barra-envio"><span style="width:0%"></span></span><span class="rotulo" data-st>na fila</span></div>`).join('');
    let ok = 0;
    for (const [i, arq] of lista_.entries()) {
      const linha = $(`#envio-${i}`);
      const st = $('[data-st]', linha);
      const barra = $('.barra-envio span', linha);
      try {
        if (arq.size > 200 * 1024 * 1024) throw new Error(`tem ${(arq.size / 1048576).toFixed(0)} MB — o máximo é 200 MB`);
        const ini = await api(`empresas/${id}/midias/envio`, { method: 'POST', body: { arquivo: arq.name, tamanho: arq.size, tipo: arq.type || '' } });
        for (let pos = 0; pos < arq.size; pos += ini.pedaco) {
          const parte = arq.slice(pos, pos + ini.pedaco);
          let tentativa = 0;
          for (;;) {
            const r = await fetch(`api/empresas/${id}/midias/envio/${ini.envioId}/parte?pos=${pos}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: parte }).catch((err) => ({ ok: false, erro: err }));
            if (r.ok) break;
            if (++tentativa >= 3) throw new Error(r.status === 413 ? 'o servidor recusou o pedaço (limite do Nginx)' : 'a conexão caiu');
            await new Promise((ok_) => setTimeout(ok_, 1000 * tentativa));
          }
          const feito = Math.min(arq.size, pos + ini.pedaco);
          barra.style.width = `${Math.round((feito / arq.size) * 100)}%`;
          st.textContent = `${Math.round((feito / arq.size) * 100)}%`;
        }
        const nova = await api(`empresas/${id}/midias/envio/${ini.envioId}/concluir`, { method: 'POST', body: {} });
        if (abaDoEnvio === 'followup' && nova?.id) await api(`empresas/${id}/midias/${nova.id}`, { method: 'PUT', body: { soFollowup: true, pronta: true } }).catch(() => {});
        st.textContent = nova.tipo === 'video' ? (nova.processando ? '✓ enviado · 🎬 convertendo para o WhatsApp…' : '✓ enviado · 🎬 em Vídeos') : '✓ enviado';
        linha.classList.add('ok');
        ok++;
      } catch (err) {
        st.textContent = `✕ ${err.message}`;
        linha.classList.add('erro');
      }
    }
    aviso(abaDoEnvio === 'followup' ? `${ok} de ${lista_.length} arquivo(s) enviados para "Só follow-up".` : `${ok} de ${lista_.length} arquivo(s) enviados. Agora configure em "A configurar".`, ok < lista_.length);
    try { sessionStorage.setItem(`midias_aba_${id}`, abaDoEnvio === 'followup' ? 'followup' : 'configurar'); } catch { /* ok */ }
    setTimeout(() => { if (location.hash === hashDaPagina) paginaMidias(id); }, ok < lista_.length ? 4000 : 800);
  }
  $('#sug-midia-ativo').onchange = async (e) => {
    try {
      const r = await api(`empresas/${id}/sugestao-midia`, { method: 'PUT', body: { ativo: e.target.checked } });
      e.target.closest('.interruptor').querySelector('span:last-child').textContent = r.ativo ? 'Ligado' : 'Desligado';
      aviso(r.ativo ? 'Sugestão de mídia ligada.' : 'Sugestão de mídia desligada.');
    } catch (err) { aviso(err.message, true); e.target.checked = !e.target.checked; }
  };
  $('#mais-midias').onchange = (e) => { if (e.target.files.length) enviarArquivos(e.target.files); };
  const zona = $('#soltar');
  zona.ondragover = (e) => { e.preventDefault(); zona.classList.add('arrastando'); };
  zona.ondragleave = () => zona.classList.remove('arrastando');
  zona.ondrop = (e) => {
    e.preventDefault();
    zona.classList.remove('arrastando');
    if (e.dataTransfer.files.length) enviarArquivos(e.dataTransfer.files);
  };
  zona.onclick = (e) => { e.preventDefault(); $('#mais-midias').click(); };
  desenharBiblioteca();
  // vídeo convertendo: atualiza sozinho quando terminar (se a pessoa ainda estiver aqui)
  if (lista.some((m) => m.processando)) {
    const conferir = () => {
      if (location.hash !== hashDaPagina || $('#fila-envio')?.children.length) return;
      if (document.querySelector('.fundo-modal') || selecionadas.size) return setTimeout(conferir, 6000); // não atrapalha quem está editando
      paginaMidias(id);
    };
    setTimeout(conferir, 6000);
  }
}

// ---------------------------------------------------------------- empresa: etiquetas e etapas

async function paginaOrganizar(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  let etiquetas = emp.etiquetas.slice();
  let etapas = emp.etapas.slice();

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Etiquetas e etapas</h1><p class="sub">Como os seus leads ficam organizados</p></div></div>
    <div class="duas-colunas">
      <div class="card">
        <h2>Etiquetas do WhatsApp</h2>
        ${balao('Vêm do seu WhatsApp Business', 'As etiquetas são as mesmas do celular conectado: <b>crie, renomeie ou apague no WhatsApp Business</b> e elas mudam aqui sozinhas. Marcou um cliente no celular, aparece aqui; marcou aqui, aparece no celular. Você filtra os leads por elas e escolhe <b>para quem fazer disparos</b>.')}
        <div id="lista-etiquetas" class="chips" style="margin-bottom:8px"></div>
        <div class="acoes"><button type="button" id="atualizar-etiquetas">🔄 Atualizar do WhatsApp</button><a class="botao" href="${rotaEmpresa(id, 'whatsapp')}">Ver no WhatsApp</a></div>
      </div>
      <div class="card">
        <h2>Etapas do funil</h2>
        ${balao('O caminho do cliente', 'Da primeira mensagem até fechar. As IAs movem o lead sozinhas conforme a conversa avança, e você pode mover arrastando no quadro de Leads. Use as setas para mudar a ordem.')}
        <div id="lista-etapas" class="lista-editavel"></div>
        <div class="acoes"><button type="button" id="add-etapa">+ Nova etapa</button><button type="button" class="primario" id="salvar-etapas">Salvar etapas</button></div>
      </div>
    </div>`;

  function desenharEtiquetas() {
    $('#lista-etiquetas').innerHTML = etiquetas.map((t) => `<span class="chip-etq" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}</span>`).join('') ||
      '<p class="rotulo" style="margin:0">Nenhuma etiqueta chegou do WhatsApp ainda. Crie etiquetas no WhatsApp Business do celular conectado e clique em <b>Atualizar do WhatsApp</b>.</p>';
  }
  function desenharEtapas() {
    $('#lista-etapas').innerHTML = etapas.map((e, i) => `
      <div class="linha-editavel">
        <span class="passo-num">${i + 1}</span>
        <input value="${esc(e)}" data-etapa="${i}" maxlength="60">
        <button type="button" class="pequeno" data-subir="${i}" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
        <button type="button" class="pequeno" data-descer="${i}" ${i === etapas.length - 1 ? 'disabled' : ''} title="Descer">↓</button>
        <button type="button" class="pequeno perigo" data-tirar-etapa="${i}" title="Remover">✕</button>
      </div>`).join('');
    $$('[data-etapa]').forEach((el) => { el.oninput = () => { etapas[el.dataset.etapa] = el.value; }; });
    const trocar = (a, b) => { [etapas[a], etapas[b]] = [etapas[b], etapas[a]]; desenharEtapas(); };
    $$('[data-subir]').forEach((el) => { el.onclick = () => trocar(Number(el.dataset.subir), Number(el.dataset.subir) - 1); });
    $$('[data-descer]').forEach((el) => { el.onclick = () => trocar(Number(el.dataset.descer), Number(el.dataset.descer) + 1); });
    $$('[data-tirar-etapa]').forEach((el) => { el.onclick = () => { etapas.splice(Number(el.dataset.tirarEtapa), 1); desenharEtapas(); }; });
  }
  desenharEtiquetas();
  desenharEtapas();
  $('#add-etapa').onclick = () => {
    etapas.push('');
    desenharEtapas();
    $$('[data-etapa]').pop()?.focus();
  };
  $('#atualizar-etiquetas').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api(`empresas/${id}/etiquetas-zap/carregar`, { method: 'POST', body: {} });
      etiquetas = (await api(`empresas/${id}`)).etiquetas.slice();
      desenharEtiquetas();
      aviso(r.erro ? r.erro : `${etiquetas.length} etiqueta(s) do WhatsApp.`, !!r.erro);
    } catch (err) { aviso(err.message, true); }
    e.target.disabled = false;
  };
  $('#salvar-etapas').onclick = async () => {
    const limpas = etapas.map((e) => e.trim()).filter(Boolean);
    const removidas = emp.etapas.filter((e) => !limpas.includes(e));
    if (removidas.length && !(await confirmar({ titulo: 'Salvar etapas?', texto: `Os leads que estão em <b>${removidas.map(esc).join(', ')}</b> vão para a primeira etapa (${esc(limpas[0] || '')}).`, botao: 'Salvar' }))) return;
    try {
      const r = await api(`empresas/${id}/etapas`, { method: 'PUT', body: { etapas: limpas } });
      etapas = r.etapas.slice();
      emp.etapas = r.etapas.slice();
      desenharEtapas();
      aviso('Etapas salvas.');
    } catch (err) { aviso(err.message, true); }
  };
}

// ---------------------------------------------------------------- empresa: chave de IA

// Onde os tokens foram nos últimos 7 dias: por tarefa e por modelo, com o custo estimado
const NOME_TAREFA_IA = { resposta: '💬 Respostas no WhatsApp', site: '🌐 Chat do site', evento: '⏰ Avisos internos (sem resposta, follow-up com IA)', followup: '🔁 Follow-up e automações com IA', foto: '🖼️ Fotos dos clientes', audio: '🎤 Áudios dos clientes', comprovante: '🧾 Comprovantes', 'sugestao-midia': '📎 Sugestão de mídia', agenda: '📅 Detector de agendamento', 'aviso-agendamento': '📣 Aviso de agendamento', aprendizado: '📚 Aprendizado diário', catalogo: '🛍️ Catálogo (sugerir itens)', 'conferir-prompt': '✅ Atualizar e conferir', 'sugestao-equipe': '✍️ Sugestão de resposta para a equipe', teste: '🧪 Testes', outros: 'Outros' };
function tabelaGastoIa(u) {
  const linhas = (obj, nome) => Object.entries(obj || {}).sort((a, b) => (b[1].custo || 0) - (a[1].custo || 0) || b[1].tokens - a[1].tokens).map(([k, x]) => `<tr><td>${esc(nome(k))}</td><td class="num">${(x.chamadas || 0).toLocaleString('pt-BR')}</td><td class="num">${numeroCurto(x.tokens)}</td><td class="num esconde-mobile">${numeroCurto(x.cache)}</td><td class="num">${x.custo ? (x.custo < 0.01 ? '&lt; US$ 0.01' : `US$ ${x.custo.toFixed(2)}`) : '—'}</td></tr>`).join('');
  const porTarefa = linhas(u?.porTarefa, (k) => NOME_TAREFA_IA[k] || k);
  const porModelo = linhas(u?.porModelo, (k) => k);
  const cab = (t) => `<thead><tr><th>${t}</th><th class="num">Chamadas</th><th class="num">Tokens</th><th class="num esconde-mobile">Cache</th><th class="num">Custo est.</th></tr></thead>`;
  return `<div class="card tokens-tabela">
      <h2 style="margin:0 0 8px">🔎 Para onde foram os tokens (7 dias)</h2>
      ${porTarefa ? `<div class="tabela-wrap"><table>${cab('Tarefa')}<tbody>${porTarefa}</tbody></table></div>
      <div class="tabela-wrap" style="margin-top:12px"><table>${cab('Modelo')}<tbody>${porModelo}</tbody></table></div>
      <p class="rotulo" style="margin:10px 0 0">Custo estimado pelos preços de tabela do Claude (entrada, saída e leitura do cache); outras IAs aparecem sem custo. Começou a contar por tarefa nesta atualização.</p>` : '<p class="rotulo" style="margin:0">Ainda sem dados por tarefa — aparecem a partir das próximas chamadas à IA.</p>'}
    </div>`;
}

async function paginaChave(id) {
  const hashDaPagina = location.hash;
  const [emp, bot] = await Promise.all([definirEmpresaAtual(id), principalDa(id)]);
  const bloco = (provedor, campo, dica, passosCriar, extra = '') => {
    const c = emp.chaves[provedor];
    const situacao = c.propria
      ? `<span class="etiqueta ok">✓ Chave cadastrada</span> <span class="rotulo">termina em ${esc(c.final)}</span>`
      : c.usaPadrao
        ? '<span class="etiqueta aviso">Usando a chave do administrador (custo na conta dele)</span>'
        : '<span class="etiqueta off">Sem chave — cadastre a da empresa</span>';
    // pronto (tem chave) ou opcional (não é a IA principal): vira uma linha; a principal sem chave fica aberta
    const principalSemChave = !c.propria && !c.usaPadrao && provedor === (bot?.provedor || 'anthropic');
    const pronto = c.propria || c.usaPadrao ? 'ok' : principalSemChave ? '' : 'off';
    const resumo = c.propria ? `Chave da empresa · termina em ${c.final}` : c.usaPadrao ? 'Usando a chave do administrador' : 'Sem chave · opcional (para usar como reserva)';
    return `
      <div class="card" data-cfg="chave-${provedor}" data-titulo="${esc(NOME_PROVEDOR[provedor])}" data-pronto="${pronto}" data-resumo="${esc(resumo)}">
        <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">${NOME_PROVEDOR[provedor]} ${extra}</h2>${situacao}</div>
        <details ${principalSemChave ? 'open' : ''}><summary>Como conseguir a chave</summary>${passos(passosCriar)}</details>
        <form data-provedor="${provedor}" style="margin-top:12px">
          <div class="campo"><label>${c.propria ? 'Trocar chave' : 'Cole a chave aqui'}</label><input name="${campo}" type="password" autocomplete="off" placeholder="${esc(dica)}"></div>
          <div class="acoes">
            <button class="primario" type="submit">Salvar e testar</button>
            ${c.funciona ? '<button type="button" data-testar>Testar</button>' : ''}
            ${c.propria ? '<button type="button" class="perigo" data-remover>Remover</button>' : ''}
          </div>
        </form>
      </div>`;
  };
  // posições atuais (sem ordem salva: começa pela IA do assistente)
  const motores = emp.motores?.length ? emp.motores : bot ? [{ ordem: 1, provedor: bot.provedor || 'anthropic', modelo: bot.modelo, chavePropria: false }] : [];
  const ROTULO_POS = ['1ª IA — principal', '2ª IA — reserva', '3ª IA — reserva'];
  const linhaMotor = (i) => {
    const m = motores[i] || {};
    return `
      <div class="motor" data-i="${i}">
        <div class="motor-topo"><b>${ROTULO_POS[i]}</b>${m.provedor ? `<button type="button" class="pequeno" data-testar-motor="${i}" ${emp.motores?.[i] ? '' : 'disabled title="Salve primeiro"'}>Testar</button>` : ''}</div>
        <div class="campos">
          <div class="campo"><label>IA</label><select data-prov>${i ? '<option value="">— nenhuma —</option>' : ''}${['anthropic', 'openai', 'gemini'].map((p) => `<option value="${p}" ${p === m.provedor ? 'selected' : ''}>${NOME_PROVEDOR[p]}${emp.chaves?.[p]?.funciona ? '' : ' — sem chave'}</option>`).join('')}</select></div>
          <div class="campo"><label>Modelo</label><select data-mod><option value="${esc(m.modelo || '')}">${esc(m.modelo || '—')}</option></select><small data-aviso></small></div>
        </div>
        <details class="chave-posicao" ${m.chavePropria ? 'open' : ''}><summary>Usar outra chave nesta posição (opcional)</summary>
          <p class="rotulo" style="margin:6px 0">Ex.: uma 2ª conta do Claude como reserva. Vazio = usa a chave da empresa para esta IA (cadastrada abaixo).</p>
          <input type="password" data-chave autocomplete="off" placeholder="${m.chavePropria ? `salva — termina em ${esc(m.chaveFinal)} (deixe vazio para manter)` : 'cole a chave desta posição'}">
          ${m.chavePropria ? '<label class="linha-check" style="margin-top:6px"><input type="checkbox" data-remover-chave> Tirar a chave própria desta posição</label>' : ''}
        </details>
      </div>`;
  };
  const u = emp.usoHoje || {};
  const reserva = emp.iaReserva;
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>IAs e chaves</h1><p class="sub">Qual IA responde seus clientes — e quem assume se ela falhar</p></div></div>
    ${balao('Como funciona', passos([
      'Cada empresa usa as <b>próprias chaves</b> de IA — os tokens gastos saem da conta da empresa e aparecem aqui embaixo. Cadastre a chave de <b>pelo menos uma</b> IA (lá embaixo). Quanto mais chaves, mais seguro.',
      'Escolha a ordem: a <b>1ª</b> responde sempre. Se ela falhar (acabou o crédito, chave errada, fora do ar), a <b>2ª</b> responde na hora, e depois a <b>3ª</b>. O cliente não percebe.',
      'Quando uma reserva precisar entrar, o CRM avisa você no sininho 🔔 (e no WhatsApp de avisos, se tiver).'
    ]))}
    <div class="card">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🧠 Ordem das IAs</h2>${emp.motores?.length ? `<span class="etiqueta ok">${emp.motores.length} ${emp.motores.length === 1 ? 'IA' : 'IAs'} em ordem</span>` : '<span class="etiqueta aviso">escolha e salve</span>'}</div>
      <div id="motores">${[0, 1, 2].map(linhaMotor).join('')}</div>
      <div class="acoes"><button type="button" class="primario" id="salvar-motores">Salvar ordem</button></div>
      ${reserva ? `<p class="rotulo" style="margin:10px 0 0">Última vez que a reserva entrou: ${data(reserva.em)} — respondeu a ${esc(reserva.usou)}. Motivo: ${esc((reserva.falhas || []).join('; '))}</p>` : ''}
    </div>
    <div class="card">
      <h2 style="margin:0 0 8px">📊 Gasto de hoje</h2>
      <div class="grade-resumo" style="margin:0">
        ${numeroCard('Tokens hoje', numeroCurto(u.total))}
        ${numeroCard('Chamadas à IA', (u.chamadas || 0).toLocaleString('pt-BR'))}
        ${numeroCard('Vindos do cache (≈90% mais barato)', numeroCurto(u.cache))}
      </div>
      <p class="rotulo" style="margin:10px 0 0">${Object.entries(u.porIa || {}).map(([p, n]) => `${NOME_IA_CURTO[p] || p}: ${numeroCurto(n)}`).join(' · ') || 'Nenhuma chamada hoje ainda.'} ${ajuda('Token é a unidade que as IAs cobram (≈ 4 letras). O CRM já economiza: a parte fixa das instruções fica em cache, comprovantes são lidos sem IA e fotos/comprovantes usam o modelo mais barato.')}</p>
    </div>
    ${tabelaGastoIa(emp.uso7d)}
    <h2 style="margin-top:24px">🔑 Chaves das IAs</h2>
    ${bloco('gemini', 'geminiApiKey', 'AIza…', [
      'Entre em <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> com a sua conta Google.',
      'Clique em <b>Create API key</b> (Criar chave de API).',
      'Copie a chave (começa com <code>AIza</code>) e cole aqui embaixo.'
    ], '<span class="etiqueta ok">tem faixa grátis · ouve áudio</span>')}
    ${bloco('anthropic', 'anthropicApiKey', 'sk-ant-…', [
      'Entre em <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> e crie a conta.',
      'Em <b>Billing</b>, adicione créditos. Em <b>API Keys</b>, clique em <b>Create Key</b>.',
      'Copie a chave (começa com <code>sk-ant-</code>) e cole aqui embaixo.'
    ])}
    ${bloco('openai', 'openaiApiKey', 'sk-…', [
      'Entre em <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a> e crie a conta.',
      'Em <b>Billing</b>, adicione créditos. Depois clique em <b>Create new secret key</b>.',
      'Copie a chave (começa com <code>sk-</code>) e cole aqui embaixo.'
    ], '<span class="etiqueta">ouve áudio</span>')}`;

  // posições: modelo depende da IA escolhida
  $$('.motor').forEach((el) => {
    const prov = $('[data-prov]', el);
    const mod = $('[data-mod]', el);
    const mostrar = () => { mod.closest('.campo').hidden = !prov.value; };
    if (prov.value) ligarSeletorModelo(null, id, prov, mod, $('[data-aviso]', el));
    prov.addEventListener('change', () => { mostrar(); if (prov.value && !prov.dataset.ligado) { prov.dataset.ligado = '1'; ligarSeletorModelo(null, id, prov, mod, $('[data-aviso]', el)); } });
    if (prov.value) prov.dataset.ligado = '1';
    mostrar();
  });
  $('#salvar-motores').onclick = async (e) => {
    const lista = $$('.motor').map((el) => ({
      provedor: $('[data-prov]', el).value,
      modelo: $('[data-mod]', el).value,
      chave: $('[data-chave]', el).value.trim(),
      removerChave: $('[data-remover-chave]', el)?.checked || false
    })).filter((m) => m.provedor);
    if (!lista.length) return aviso('Escolha pelo menos a 1ª IA.', true);
    try {
      await comEspera(e.target, () => api(`empresas/${id}/motores`, { method: 'PUT', body: { motores: lista } }), 'Salvando…');
      aviso('Ordem das IAs salva.');
      paginaChave(id);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-testar-motor]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await comEspera(b, () => api(`empresas/${id}/motores/testar`, { method: 'POST', body: { indice: Number(b.dataset.testarMotor) } }), 'Testando…');
        aviso(r.mensagem);
      } catch (err) { aviso(err.message, true); }
    };
  });

  $$('form[data-provedor]').forEach((f) => {
    const provedor = f.dataset.provedor;
    const recarregar = () => { paginaChave(id); };
    const testar = async () => {
      try {
        const r = await api(`empresas/${id}/chaves/testar`, { method: 'POST', body: { provedor } });
        aviso(r.mensagem);
      } catch (err) { aviso(err.message, true); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const dados = formParaObjeto(f);
      if (!Object.values(dados)[0]) return aviso('Cole a chave antes de salvar.', true);
      try {
        await comEspera(f.querySelector('button[type=submit]'), async () => {
          await api(`empresas/${id}/chaves`, { method: 'PUT', body: dados });
          // primeira chave da empresa: esta IA vira a principal
          if (!emp.motores?.length && bot && !emp.chaves[bot.provedor]?.funciona) {
            await api(`empresas/${id}/motores`, { method: 'PUT', body: { motores: [{ provedor }] } });
          }
          await testar();
        }, 'Testando…');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
    $('[data-testar]', f)?.addEventListener('click', testar);
    $('[data-remover]', f)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Remover a chave?', texto: 'Se a IA usar esta chave, ela para de responder (a reserva assume, se tiver).', botao: 'Remover', perigo: true }))) return;
      try {
        await api(`empresas/${id}/chaves`, { method: 'PUT', body: { remover: [provedor] } });
        recarregar();
      } catch (err) { aviso(err.message, true); }
    });
  });
}

// ---------------------------------------------------------------- empresa: leads

const ROTULO_CANAL = { site: '🌐 Site', whatsapp: '🟢 WhatsApp', manual: '✍️ Cadastro' };
let modoLeads = 'quadro';
try { modoLeads = localStorage.getItem('dingdong_crm_leads') || 'quadro'; } catch { /* ok */ }

function nomeDoLead(l) {
  return l.nome || (l.telefone && telefoneBonito(l.telefone)) || (l.noWhatsapp ? 'Contato do WhatsApp' : 'Visitante do site');
}

// 📍 de onde o cliente é (DDD do WhatsApp, o que ele disse na conversa ou a equipe)
function chipLocal(l, classe = '') {
  if (!l?.local?.texto) return '';
  return `<span class="etiqueta chip-local ${classe}" title="Localização: ${esc(l.local.origem || '')}">📍 ${esc(l.local.texto)}</span>`;
}

function chipsDoLead(l, etiquetas) {
  return (l.etiquetas || []).map((tid) => etiquetas.find((t) => t.id === tid)).filter(Boolean).map((t) => chipEtiqueta(t)).join('');
}

function cartaoLead(l, etiquetas) {
  const ultima = l.ultimaMensagem ? `${l.ultimaMensagem.papel === 'visitante' ? '' : l.ultimaMensagem.papel === 'equipe' ? 'Equipe: ' : 'IA: '}${l.ultimaMensagem.texto}` : '';
  return `
    <a class="cartao-lead" href="#/leads/${esc(l.id)}" draggable="true" data-lead="${esc(l.id)}">
      <span class="cartao-topo"><span class="cartao-quem">${avatarLead(l, 'mini')}<strong>${esc(nomeDoLead(l))}</strong></span>${l.precisaHumano ? '<span class="etiqueta off">chamou a equipe</span>' : ''}</span>
      ${l.etiquetas?.length || l.local?.texto ? `<span class="chips">${chipLocal(l)}${chipsDoLead(l, etiquetas)}</span>` : ''}
      <span class="rotulo cartao-texto">${esc(ultima)}</span>
      <span class="cartao-rodape">
        ${l.canais.map((c) => `<span class="etiqueta">${ROTULO_CANAL[c] || c}</span>`).join(' ')}
        ${l.iaPausada && !l.precisaHumano ? '<span class="etiqueta">IA pausada</span>' : ''}
        <span class="rotulo" style="margin-left:auto">${data(l.atualizadoEm)}</span>
      </span>
    </a>`;
}

async function paginaLeads(id, params) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const busca = params.get('busca') || '';
  const etiqueta = params.get('etiqueta') || '';
  const lista = await api(`leads?${new URLSearchParams({ empresaId: id, busca, etiqueta })}`);
  const etiquetas = emp.etiquetas;
  const irPara = (mudancas) => {
    const p = new URLSearchParams({ busca, etiqueta, ...mudancas });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    location.hash = rotaEmpresa(id, 'leads') + (p.toString() ? `?${p}` : '');
  };

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho">
      <div><h1>Leads</h1><p class="sub">${lista.length} ${lista.length === 1 ? 'lead' : 'leads'}${busca || etiqueta ? ' neste filtro' : ''}</p></div>
      <div class="barra">
        <div class="alternar-modo"><button type="button" data-modo="quadro" class="${modoLeads === 'quadro' ? 'ativo' : ''}">Quadro</button><button type="button" data-modo="lista" class="${modoLeads === 'lista' ? 'ativo' : ''}">Lista</button></div>
        <button type="button" id="novo-lead">+ Adicionar</button>
      </div>
    </div>
    <div class="filtros">
      <form id="f-busca" class="linha-form"><input name="busca" value="${esc(busca)}" placeholder="🔎 Buscar nome, telefone, mensagem…"><button type="submit">Buscar</button></form>
      <div class="chips filtro-etiquetas">
        <span class="rotulo">Etiqueta:</span>
        <button type="button" class="chip-filtro ${etiqueta ? '' : 'ativo'}" data-etiqueta="">Todas</button>
        ${etiquetas.map((t) => `<button type="button" class="chip-filtro ${etiqueta === t.id ? 'ativo' : ''}" data-etiqueta="${esc(t.id)}" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}</button>`).join('')}
        <a class="rotulo" href="${rotaEmpresa(id, 'organizar')}" style="margin-left:4px">editar</a>
      </div>
    </div>
    ${lista.length === 0 && !busca && !etiqueta ? balao('Ainda não tem leads', `Eles aparecem aqui sozinhos quando alguém conversar com a IA no site ou chamar no WhatsApp. Você também pode <b>adicionar</b> ou <b>importar</b> contatos no botão "+ Adicionar".`) : ''}
    <div class="leads-layout"><div id="area-leads"></div><aside class="funil-lateral" id="funil-lateral" aria-label="Funil de vendas"></aside></div>`;

  // Funil desenhado (lado direito): quantos clientes em cada etapa; "Não fechou" fica à parte
  const ehPerda = (e) => /nao fech|perdid|desist|cancel/i.test(String(e).normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  function desenharFunil() {
    const el = $('#funil-lateral');
    if (!el) return;
    const etapas = emp.etapas.filter((e) => !ehPerda(e));
    const perdas = emp.etapas.filter(ehPerda);
    const qtd = (e) => lista.filter((l) => l.etapa === e).length;
    const total = lista.length || 1;
    const L = 240, H = 58, G = 5, topo = 240, base = 96;
    const passo = etapas.length > 1 ? (topo - base) / etapas.length : 0;
    const camadas = etapas.map((e, i) => {
      const w1 = topo - passo * i, w2 = topo - passo * (i + 1);
      const y = i * (H + G);
      const x1 = (L - w1) / 2, x2 = (L - w2) / 2;
      const n = qtd(e);
      const nomes = lista.filter((l) => l.etapa === e).slice(0, 12).map((l) => l.nome || l.telefone || 'Cliente').join(', ');
      return `<g class="camada-funil" data-funil-etapa="${esc(e)}" tabindex="0" role="button" aria-label="${esc(e)}: ${n}">
        <title>${esc(e)}: ${n} cliente(s)${nomes ? ` — ${esc(nomes)}${n > 12 ? '…' : ''}` : ''}</title>
        <path d="M${x1},${y} L${x1 + w1},${y} L${x2 + w2},${y + H} L${x2},${y + H} Z" style="opacity:${(1 - i * (0.42 / Math.max(1, etapas.length - 1))).toFixed(2)}"/>
        <text x="${L / 2}" y="${y + 24}" class="funil-num">${n}</text>
        <text x="${L / 2}" y="${y + 43}" class="funil-nome">${esc(e.length > 18 ? e.slice(0, 17) + '…' : e)} · ${Math.round((n / total) * 100)}%</text>
      </g>`;
    }).join('');
    const alturaSvg = etapas.length * (H + G) - G;
    el.innerHTML = `
      <div class="card funil-card">
        <h2 style="margin:0 0 2px">Funil</h2>
        <p class="rotulo" style="margin:0 0 12px">${lista.length} ${lista.length === 1 ? 'cliente' : 'clientes'}${busca || etiqueta ? ' neste filtro' : ''} · clique numa etapa</p>
        <svg viewBox="0 0 ${L} ${alturaSvg}" class="funil-svg" role="img" aria-label="Funil de vendas">${camadas}</svg>
        ${etapas.length > 1 ? `<p class="rotulo funil-conv">De <b>${esc(etapas[0])}</b> até <b>${esc(etapas[etapas.length - 1])}</b>: <b>${lista.length ? Math.round((qtd(etapas[etapas.length - 1]) / total) * 100) : 0}%</b></p>` : ''}
      </div>
      ${perdas.map((e) => `<button type="button" class="card funil-perda" data-funil-etapa="${esc(e)}" title="Clique para ver · arraste um cartão aqui"><span>✕ ${esc(e)}<small>arraste um cartão aqui</small></span><b>${qtd(e)}</b></button>`).join('')}`;
    // "Não fechou": arrastar um cartão para a caixa move o lead; clicar mostra quem está lá
    $$('.funil-perda', el).forEach((cx) => {
      cx.ondragover = (ev) => { ev.preventDefault(); cx.classList.add('alvo'); };
      cx.ondragleave = () => cx.classList.remove('alvo');
      cx.ondrop = async (ev) => {
        ev.preventDefault();
        cx.classList.remove('alvo');
        const lead = lista.find((l) => l.id === ev.dataTransfer.getData('text/plain'));
        if (!lead || lead.etapa === cx.dataset.funilEtapa) return;
        try { await api(`leads/${lead.id}`, { method: 'PUT', body: { etapa: cx.dataset.funilEtapa } }); lead.etapa = cx.dataset.funilEtapa; aviso(`${lead.nome || 'Lead'} foi para "${cx.dataset.funilEtapa}".`); (modoLeads === 'lista' ? desenharLista : desenharQuadro)(); } catch (err) { aviso(err.message, true); }
      };
      cx.onclick = () => {
        const etapa = cx.dataset.funilEtapa;
        const deles = lista.filter((l) => l.etapa === etapa);
        abrirModal(`<h2>✕ ${esc(etapa)} (${deles.length})</h2>
          ${deles.length ? `<div class="lista-perdidos">${deles.map((l) => `<a class="linha-perdido" href="#/leads/${esc(l.id)}">${avatarLead(l)}<span><b>${esc(l.nome || telefoneBonito(l.telefone) || 'Cliente')}</b><span class="rotulo">${esc((l.ultimaMensagem?.texto || '').slice(0, 80))}</span></span></a>`).join('')}</div>` : '<p class="rotulo">Ninguém aqui. Arraste um cartão para a caixa quando o cliente não fechar.</p>'}
          <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`);
      };
    });
    $$('.camada-funil', el).forEach((g) => {
      const ir = () => {
        const etapa = g.dataset.funilEtapa;
        if (modoLeads !== 'quadro') return;
        const col = [...$$('.coluna')].find((c) => c.dataset.etapa === etapa);
        if (!col) return;
        col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        col.classList.remove('piscar'); void col.offsetWidth; col.classList.add('piscar');
      };
      g.onclick = ir;
      g.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ir(); } };
    });
  }

  function desenharQuadro() {
    desenharFunil();
    $('#area-leads').innerHTML = `
      <p class="rotulo dica-arrastar">Arraste um cartão para outra coluna para mudar a etapa.</p>
      <div class="quadro">
        ${emp.etapas.filter((e) => !ehPerda(e)).map((etapa) => {
          const daEtapa = lista.filter((l) => l.etapa === etapa);
          return `<section class="coluna" data-etapa="${esc(etapa)}"><header><span>${esc(etapa)}</span><span class="etiqueta">${daEtapa.length}</span></header>${daEtapa.map((l) => cartaoLead(l, etiquetas)).join('') || '<p class="rotulo vazio-coluna">—</p>'}</section>`;
        }).join('')}
      </div>`;
    $$('.cartao-lead').forEach((c) => {
      c.ondragstart = (e) => { e.dataTransfer.setData('text/plain', c.dataset.lead); c.classList.add('arrastando'); };
      c.ondragend = () => c.classList.remove('arrastando');
    });
    $$('.coluna').forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('alvo'); };
      col.ondragleave = () => col.classList.remove('alvo');
      col.ondrop = async (e) => {
        e.preventDefault();
        col.classList.remove('alvo');
        const leadId = e.dataTransfer.getData('text/plain');
        const lead = lista.find((l) => l.id === leadId);
        if (!lead || lead.etapa === col.dataset.etapa) return;
        if (ehEtapaDeVenda(col.dataset.etapa) && !ehEtapaDeVenda(lead.etapa)) {
          if (await modalVendaConcluida(leadId, id)) { lead.etapa = col.dataset.etapa; desenharQuadro(); }
          return;
        }
        try {
          await api(`leads/${leadId}`, { method: 'PUT', body: { etapa: col.dataset.etapa } });
          lead.etapa = col.dataset.etapa;
          desenharQuadro();
        } catch (err) { aviso(err.message, true); }
      };
    });
  }

  function desenharLista() {
    desenharFunil();
    $('#area-leads').innerHTML = `
      <div class="barra-lote" id="barra-lote" hidden>
        <strong id="qtd-sel"></strong>
        <select id="lote-etapa"><option value="">Mover para etapa…</option>${emp.etapas.map((e) => `<option>${esc(e)}</option>`).join('')}</select>
        <select id="lote-etiqueta"><option value="">Colocar etiqueta…</option>${etiquetas.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select>
        <button type="button" class="primario pequeno" id="lote-disparar">📣 Disparar para eles</button>
        <button type="button" class="perigo pequeno" id="lote-apagar">Apagar</button>
      </div>
      <div class="card tabela-wrap">
        <table>
          <thead><tr><th style="width:36px"><input type="checkbox" id="sel-todos" aria-label="Selecionar todos"></th><th>Lead</th><th class="esconde-mobile">Etiquetas</th><th>Etapa</th><th class="esconde-mobile">Canal</th><th class="esconde-mobile">Atualizado</th></tr></thead>
          <tbody>
            ${lista.map((l) => `
              <tr>
                <td><input type="checkbox" class="sel" value="${esc(l.id)}" aria-label="Selecionar"></td>
                <td><div class="celula-lead">${avatarLead(l, 'mini')}<div><a href="#/leads/${esc(l.id)}"><strong>${esc(nomeDoLead(l))}</strong></a>${l.telefone && l.nome ? `<br><span class="rotulo">${esc(telefoneBonito(l.telefone))}</span>` : ''}${l.precisaHumano ? ' <span class="etiqueta off">chamou a equipe</span>' : ''}</div></div></td>
                <td class="esconde-mobile"><span class="chips">${chipLocal(l)}${chipsDoLead(l, etiquetas) || (l.local?.texto ? '' : '<span class="rotulo">—</span>')}</span></td>
                <td>${esc(l.etapa)}</td>
                <td class="esconde-mobile">${l.canais.map((c) => ROTULO_CANAL[c] || c).join(' ')}</td>
                <td class="esconde-mobile rotulo">${data(l.atualizadoEm)}</td>
              </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum lead.</td></tr>'}
          </tbody>
        </table>
      </div>`;
    const selecionados = () => $$('.sel:checked').map((c) => c.value);
    const atualizarBarra = () => {
      const n = selecionados().length;
      $('#barra-lote').hidden = n === 0;
      $('#qtd-sel').textContent = `${n} selecionado${n === 1 ? '' : 's'}`;
    };
    $$('.sel').forEach((c) => { c.onchange = atualizarBarra; });
    $('#sel-todos').onchange = (e) => { $$('.sel').forEach((c) => { c.checked = e.target.checked; }); atualizarBarra(); };
    const lote = async (corpo, msg) => {
      try {
        await api(`empresas/${id}/leads/lote`, { method: 'POST', body: { ids: selecionados(), ...corpo } });
        aviso(msg);
        paginaLeads(id, params);
      } catch (err) { aviso(err.message, true); }
    };
    $('#lote-etapa').onchange = (e) => e.target.value && lote({ etapa: e.target.value }, 'Leads movidos.');
    $('#lote-etiqueta').onchange = (e) => e.target.value && lote({ adicionarEtiqueta: e.target.value }, 'Etiqueta colocada.');
    $('#lote-apagar').onclick = async () => {
      const n = selecionados().length;
      if (await confirmar({ titulo: `Apagar ${n} lead${n === 1 ? '' : 's'}?`, texto: 'Os leads e as conversas vão para a Lixeira (Conversas → 🗑️) e podem ser restaurados por 30 dias.', botao: 'Apagar', perigo: true })) lote({ apagar: true }, 'Leads na lixeira (30 dias para restaurar).');
    };
    $('#lote-disparar').onclick = () => {
      sessionStorage.setItem('disparo_leads', JSON.stringify(selecionados()));
      location.hash = rotaEmpresa(id, 'disparos/novo');
    };
  }

  (modoLeads === 'lista' ? desenharLista : desenharQuadro)();
  $$('[data-modo]').forEach((b) => {
    b.onclick = () => {
      modoLeads = b.dataset.modo;
      try { localStorage.setItem('dingdong_crm_leads', modoLeads); } catch { /* ok */ }
      $$('[data-modo]').forEach((x) => x.classList.toggle('ativo', x === b));
      (modoLeads === 'lista' ? desenharLista : desenharQuadro)();
    };
  });
  $('#f-busca').onsubmit = (e) => { e.preventDefault(); irPara({ busca: e.target.elements.busca.value.trim() }); };
  $$('[data-etiqueta]').forEach((b) => { b.onclick = () => irPara({ etiqueta: b.dataset.etiqueta }); });
  $('#novo-lead').onclick = () => modalNovoLead(emp, () => paginaLeads(id, params));
}

function modalNovoLead(emp, depois) {
  abrirModal(`
    <h2>Adicionar leads</h2>
    <div class="seletor-canal" style="margin-bottom:14px"><button type="button" class="ativo" data-aba="um">Um contato</button><button type="button" data-aba="varios">Importar vários</button></div>
    <form id="f-lead">
      <div data-painel="um" class="campos">
        <div class="campo"><label>Nome</label><input name="nome" placeholder="Maria Silva"></div>
        <div class="campo"><label>WhatsApp *</label><input name="telefone" placeholder="(21) 99999-9999"></div>
      </div>
      <div data-painel="varios" hidden>
        ${balao('Um contato por linha', 'No formato <code>Nome, telefone</code>. Pode copiar de uma planilha (Excel/Google): duas colunas, nome e telefone. Números repetidos são ignorados.')}
        <textarea name="lista" style="min-height:160px" placeholder="Maria Silva, 21 99999-9999&#10;João, (24) 98888-7777"></textarea>
        <p class="rotulo">Só importe pessoas que conhecem a sua empresa — mandar mensagem para desconhecidos faz o WhatsApp bloquear o número.</p>
      </div>
      <div class="campos" style="margin-top:12px">
        <div class="campo"><label>Etapa</label><select name="etapa">${emp.etapas.map((e) => `<option>${esc(e)}</option>`).join('')}</select></div>
        <div class="campo"><label>Etiqueta (opcional)</label><select name="etiqueta"><option value="">Nenhuma</option>${emp.etiquetas.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Adicionar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    let aba = 'um';
    $$('[data-aba]', m).forEach((b) => {
      b.onclick = () => {
        aba = b.dataset.aba;
        $$('[data-aba]', m).forEach((x) => x.classList.toggle('ativo', x === b));
        $$('[data-painel]', m).forEach((p) => { p.hidden = p.dataset.painel !== aba; });
      };
    });
    $('#f-lead', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formParaObjeto(e.target);
      const corpo = { etapa: f.etapa, etiquetas: f.etiqueta ? [f.etiqueta] : [] };
      if (aba === 'um') Object.assign(corpo, { nome: f.nome, telefone: f.telefone });
      else {
        corpo.contatos = f.lista.split('\n').map((linha) => {
          const partes = linha.split(/[;,\t]/).map((x) => x.trim()).filter(Boolean);
          const tel = partes.find((p) => /\d{8,}/.test(p.replace(/\D/g, ''))) || '';
          const nome = partes.find((p) => p !== tel) || '';
          return { nome, telefone: tel };
        }).filter((c) => c.telefone);
        if (!corpo.contatos.length) return aviso('Cole pelo menos um contato com telefone.', true);
      }
      try {
        const r = await api(`empresas/${emp.id}/leads`, { method: 'POST', body: corpo });
        fechar();
        aviso(aba === 'um' ? 'Lead adicionado.' : `${r.criados} importados${r.repetidos ? `, ${r.repetidos} já existiam` : ''}${r.invalidos ? `, ${r.invalidos} com telefone inválido` : ''}.`);
        depois();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

async function paginaLead(leadId) {
  const hashDaPagina = location.hash;
  const l = await api(`leads/${leadId}`);
  await definirEmpresaAtual(l.empresaId);
  const etiquetasLead = new Set(l.etiquetas);
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div class="lead-quem">${l.fotoUrl ? `<a href="${esc(l.fotoUrl)}" target="_blank" rel="noopener" title="Ver a foto">${avatarLead(l, 'grande')}</a>` : avatarLead(l, 'grande')}<div><h1>${esc(nomeDoLead(l))}</h1><p class="sub">${esc(l.etapa)}${l.local?.texto ? ` · <span title="Localização: ${esc(l.local.origem || '')}">📍 ${esc(l.local.texto)}</span>` : ''} · desde ${data(l.criadoEm)}${l.noWhatsapp ? ` · <button type="button" class="link-botao" id="atualizar-foto" title="Buscar a foto de perfil do WhatsApp de novo">🔄 ${l.fotoUrl ? 'atualizar foto' : 'buscar foto'}</button>` : ''}</p></div></div><div class="barra"><button type="button" id="registrar-venda">💰 Registrar venda</button><button type="button" id="marcar-agendamento">📅 Agendamento</button>${l.podeReceber ? `<a class="botao primario" href="${rotaEmpresa(l.empresaId, 'conversas')}?lead=${esc(l.id)}">💬 Abrir conversa</a>` : ''}<a class="botao" href="${rotaEmpresa(l.empresaId, 'leads')}">← Leads</a></div></div>
    ${l.precisaHumano ? balao('Este cliente está esperando alguém da equipe', 'A IA passou o atendimento para vocês. Responda aqui embaixo ou pelo celular.', 'aviso') : ''}
    <div class="lead-grade">
      <div>
        ${htmlPedidos(l)}
        ${htmlProximos(l)}
        <div class="conversa" id="linha-tempo">
          ${htmlConversa(l.mensagens, l.id, l.tickets) || '<p class="rotulo">Sem mensagens ainda.</p>'}
        </div>
        ${l.podeReceber ? `
        <form class="card" id="f-responder" style="margin-top:12px">
          <div class="campo"><label>Responder pelo WhatsApp</label><textarea name="texto" required style="min-height:70px" placeholder="Sua mensagem…"></textarea><small>Ao responder, a IA para neste lead para não atropelar você. Dá para devolver para a IA ao lado.</small></div>
          <div class="acoes"><button class="primario" type="submit">Enviar</button></div>
        </form>` : '<p class="rotulo" style="margin-top:12px">Este lead ainda não tem WhatsApp. Coloque o telefone ao lado para poder falar com ele.</p>'}
      </div>
      <div>
        <div class="card">
          <div class="campo"><label>Etapa</label><select id="etapa">${l.etapas.map((e) => `<option ${e === l.etapa ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>
          <div class="campo" style="margin-top:12px"><label>Etiquetas</label>
            <div class="chips escolher-etiquetas">${l.etiquetasEmpresa.map((t) => `<button type="button" class="chip-filtro ${etiquetasLead.has(t.id) ? 'ativo' : ''}" data-tag="${esc(t.id)}" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}</button>`).join('') || '<span class="rotulo">Nenhuma etiqueta — crie no WhatsApp Business do celular.</span>'}</div>
          </div>
          <div class="campo" style="margin-top:12px"><label>Nome</label><input id="nome" value="${esc(l.nome)}" placeholder="Nome do cliente"></div>
          <div class="campo" style="margin-top:12px"><label>📍 Localização ${ajuda('O CRM lê a conversa: quando o cliente diz de onde é ("sou de Petrópolis", "moro em Itaipava"), aparece aqui sozinho. Pode corrigir à mão; vazio = volta a ler da conversa.')}</label><input id="localizacao" value="${esc(l.local?.texto || '')}" placeholder="Ex.: Petrópolis - RJ (aparece quando o cliente disser)"></div>
          ${l.noWhatsapp ? `<p style="margin:12px 0 0"><strong>WhatsApp:</strong> ${esc(telefoneBonito(l.telefone)) || '—'}</p>` : `<div class="campo" style="margin-top:12px"><label>Telefone / WhatsApp</label><input id="telefone" value="${esc(telefoneBonito(l.telefone))}" placeholder="(21) 99999-9999"></div>`}
          <p class="rotulo" style="margin:10px 0 0">Código #${esc(l.codigo)} · veio por ${ROTULO_CANAL[l.origem] || l.origem}${l.pagina ? ` · <span title="${esc(l.pagina)}">página do site</span>` : ''}</p>
          <div class="secao" style="margin-top:14px;padding-top:14px">
            <p style="margin:0 0 8px"><strong>IA neste lead:</strong> ${l.iaPausada ? `<span class="etiqueta off">pausada</span> <span class="rotulo">${esc(l.iaPausadaMotivo || '')}</span>` : '<span class="etiqueta ok">respondendo</span>'}</p>
            <button type="button" id="alternar-ia">${l.iaPausada ? 'Devolver para a IA' : 'Pausar a IA (a equipe assume)'}</button>
            <label class="linha-check" style="margin-top:12px"><input type="checkbox" id="lead-fup" ${l.followupDesligado ? '' : 'checked'}> 🔁 Follow-up automático ligado para este cliente</label>
            <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="nao-disparar" ${l.naoDisparar ? 'checked' : ''}> Não enviar disparos em massa para este lead</label>
          </div>
          <div class="campo" style="margin-top:14px"><label>Anotações da equipe</label><textarea id="anotacoes" style="min-height:80px">${esc(l.anotacoes || '')}</textarea></div>
          <div class="acoes"><button class="primario" type="button" id="salvar-lead">Salvar</button><button type="button" class="perigo" id="apagar-lead" style="margin-left:auto">Apagar lead</button></div>
        </div>
        ${cardOrigem(l.origemSite, l)}
        ${l.etapaHistorico?.length ? `<div class="card"><h2>Histórico de etapas</h2><ul class="historico">${l.etapaHistorico.slice().reverse().map((h) => `<li><span class="rotulo">${data(h.em)}</span> ${esc(h.de || '—')} → <strong>${esc(h.para)}</strong> <span class="rotulo">(${esc({ 'ia-site': 'IA do site', 'ia-whatsapp': 'IA do WhatsApp', equipe: 'equipe', sistema: 'automático' }[h.por] || h.por)})</span></li>`).join('')}</ul></div>` : ''}
      </div>
    </div>`;
  const tl = $('#linha-tempo');
  tl.scrollTop = tl.scrollHeight;
  tl.addEventListener('mensagem-apagada', () => paginaLead(leadId));
  const atualizar = async (body, msg) => {
    try {
      await api(`leads/${leadId}`, { method: 'PUT', body });
      if (msg) aviso(msg);
      paginaLead(leadId);
    } catch (err) { aviso(err.message, true); }
  };
  $('#etapa').onchange = async (e) => {
    if (ehEtapaDeVenda(e.target.value) && !l.vendaConcluida) {
      if (await modalVendaConcluida(l.id, l.empresaId)) paginaLead(l.id);
      else e.target.value = l.etapa;
      return;
    }
    atualizar({ etapa: e.target.value }, 'Etapa atualizada.');
  };
  $('#atualizar-foto')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '⏳ buscando…';
    try {
      const r = await api(`leads/${leadId}/foto/atualizar`, { method: 'POST', body: {} });
      aviso(r.temFoto ? 'Foto atualizada.' : 'Este cliente não tem foto no WhatsApp (ou esconde pela privacidade).');
      paginaLead(leadId);
    } catch (err) {
      aviso(err.message, true);
      e.target.disabled = false;
      e.target.textContent = '🔄 buscar foto';
    }
  });
  $('#registrar-venda').onclick = () => modalVenda({ id: l.empresaId }, null, l.id, () => paginaLead(leadId), { cliente: l.nome });
  $('#marcar-agendamento').onclick = () => modalAgendamento(l.id, () => paginaLead(leadId));
  ligarPedidos(conteudo, l, () => paginaLead(leadId));
  ligarProximos(conteudo, l.id, () => paginaLead(leadId));
  ligarCancelarAgendamento(conteudo, l.id, () => paginaLead(leadId));
  $$('[data-tag]').forEach((b) => {
    b.onclick = () => {
      if (etiquetasLead.has(b.dataset.tag)) etiquetasLead.delete(b.dataset.tag);
      else etiquetasLead.add(b.dataset.tag);
      atualizar({ etiquetas: [...etiquetasLead] });
    };
  });
  $('#nao-disparar').onchange = (e) => atualizar({ naoDisparar: e.target.checked }, e.target.checked ? 'Este lead não recebe mais disparos.' : 'Este lead volta a receber disparos.');
  $('#salvar-origem')?.addEventListener('click', () => {
    const escolhido = $('#origem-anuncio').value;
    const mudouAnuncio = escolhido !== (l.origemSite?.anuncio?.id || '');
    atualizar({ origemManual: $('#origem-manual').value, ...(mudouAnuncio ? { anuncioId: escolhido } : {}) }, 'Origem salva. A IA já usa na próxima resposta.');
  });
  $('#salvar-lead').onclick = () => atualizar({ nome: $('#nome').value, localizacao: $('#localizacao').value, anotacoes: $('#anotacoes').value, ...($('#telefone') ? { telefone: $('#telefone').value } : {}) }, 'Lead salvo.');
  $('#alternar-ia').onclick = () => atualizar({ iaPausada: !l.iaPausada }, l.iaPausada ? 'A IA voltou a responder este lead.' : 'IA pausada neste lead.');
  $('#lead-fup').onchange = (e) => atualizar({ followupLigado: e.target.checked }, e.target.checked ? 'Follow-up ligado para este cliente.' : 'Follow-up desligado para este cliente.');
  $('#apagar-lead').onclick = async () => {
    if (!(await confirmar({ titulo: 'Apagar este lead?', texto: 'O lead e a conversa vão para a Lixeira (em Conversas → 🗑️) e podem ser restaurados por 30 dias.', botao: 'Apagar', perigo: true }))) return;
    try {
      await api(`leads/${leadId}`, { method: 'DELETE', body: {} });
      aviso('Lead na lixeira (Conversas → 🗑️) por 30 dias.');
      location.hash = rotaEmpresa(l.empresaId, 'leads');
    } catch (err) { aviso(err.message, true); }
  };
  $('#f-responder')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await comEspera(e.target.querySelector('button'), () => api(`leads/${leadId}/mensagem`, { method: 'POST', body: { texto: e.target.elements.texto.value } }), 'Enviando…');
      paginaLead(leadId);
    } catch (err) { aviso(err.message, true); }
  });
}

// ---------------------------------------------------------------- empresa: disparos em massa

const STATUS_DISPARO = {
  agendado: ['Agendado', ''],
  enviando: ['Enviando', 'ok'],
  pausado: ['Pausado', 'aviso'],
  concluido: ['Concluído', 'ok'],
  cancelado: ['Cancelado', 'off']
};

function statusDisparo(d) {
  const [rotulo, classe] = STATUS_DISPARO[d.status] || [d.status, ''];
  const extra = d.status === 'enviando' && d.aguardandoHorario ? ' (fora do horário)' : '';
  return `<span class="etiqueta ${classe}">${rotulo}${extra}</span>`;
}

function barraProgresso(d) {
  const feitos = d.enviado + d.erro + d.ignorado;
  return `<div class="progresso"><span style="width:${d.total ? Math.round((feitos / d.total) * 100) : 0}%"></span></div>`;
}

async function paginaDisparos(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const lista = await api(`empresas/${id}/disparos`);
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Disparos em massa</h1><p class="sub">Mande uma mensagem pelo WhatsApp para vários leads de uma vez</p></div>${emp.whatsapp?.configurado ? `<a class="botao primario" href="${rotaEmpresa(id, 'disparos/novo')}">+ Novo disparo</a>` : ''}</div>
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `Os disparos saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    ${balao('Quando o cliente responde, a IA assume', 'Quem responder o disparo cai no atendimento normal: a IA do WhatsApp continua a conversa (se estiver ligada) e o lead aparece em Leads. Os envios saem <b>um por vez, com intervalos</b>, para o WhatsApp não bloquear o número.')}
    ${lista.length ? `
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Disparo</th><th>Status</th><th>Progresso</th><th class="esconde-mobile">Responderam</th><th class="esconde-mobile">Criado</th></tr></thead>
        <tbody>
          ${lista.map((d) => `
            <tr class="clicavel" data-disparo="${esc(d.id)}">
              <td><strong>${esc(d.nome)}</strong><br><span class="rotulo cartao-texto">${esc(d.mensagem.slice(0, 80))}</span></td>
              <td>${statusDisparo(d)}</td>
              <td style="min-width:140px">${barraProgresso(d)}<span class="rotulo">${d.enviado} de ${d.total} enviados${d.erro ? ` · ${d.erro} erro${d.erro === 1 ? '' : 's'}` : ''}</span></td>
              <td class="esconde-mobile">${d.responderam}</td>
              <td class="esconde-mobile rotulo">${data(d.criadoEm)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : emp.whatsapp?.configurado ? '<div class="card vazio">Nenhum disparo ainda. Clique em "+ Novo disparo".</div>' : ''}`;
  $$('tr[data-disparo]').forEach((tr) => { tr.onclick = () => { location.hash = rotaEmpresa(id, `disparos/${tr.dataset.disparo}`); }; });
  if (lista.some((d) => ['enviando', 'agendado'].includes(d.status))) {
    atualizador = setInterval(() => { if (location.hash === rotaEmpresa(id, 'disparos')) paginaDisparos(id).catch(() => {}); }, 8000);
  }
}

// Sobe um arquivo para a biblioteca de mídias em pedaços (aceita vídeo grande). Entra em "a configurar".
async function subirParaBiblioteca(empresaId, arq, progresso = () => {}) {
  if (arq.size > 200 * 1024 * 1024) throw new Error(`${arq.name} tem ${(arq.size / 1048576).toFixed(0)} MB — o máximo é 200 MB`);
  const ini = await api(`empresas/${empresaId}/midias/envio`, { method: 'POST', body: { arquivo: arq.name, tamanho: arq.size, tipo: arq.type || '' } });
  for (let pos = 0; pos < arq.size; pos += ini.pedaco) {
    let tentativa = 0;
    for (;;) {
      const r = await fetch(`api/empresas/${empresaId}/midias/envio/${ini.envioId}/parte?pos=${pos}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arq.slice(pos, pos + ini.pedaco) }).catch(() => ({ ok: false }));
      if (r.ok) break;
      if (++tentativa >= 3) throw new Error(r.status === 413 ? 'o servidor recusou o pedaço' : 'a conexão caiu');
      await new Promise((ok) => setTimeout(ok, 1000 * tentativa));
    }
    progresso(Math.round((Math.min(arq.size, pos + ini.pedaco) / arq.size) * 100));
  }
  return api(`empresas/${empresaId}/midias/envio/${ini.envioId}/concluir`, { method: 'POST', body: {} });
}

async function paginaNovoDisparo(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const [lista, albuns] = await Promise.all([api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`)]);
  const escolhidas = []; // ids de mídias e álbuns, na ordem
  const itemDe = (mid) => {
    const m = lista.find((x) => x.id === mid);
    if (m) return { nome: m.nome, icone: ICONE_TIPO[m.tipo] || '📎', tipo: m.tipo, url: m.url, processando: m.processando };
    const a = albuns.find((x) => x.id === mid);
    return a ? { nome: `${a.nome} (álbum, ${a.quantidade})`, icone: '🗂️', tipo: 'album' } : null;
  };
  let leadIds = [];
  try { leadIds = JSON.parse(sessionStorage.getItem('disparo_leads') || '[]'); sessionStorage.removeItem('disparo_leads'); } catch { leadIds = []; }

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Novo disparo</h1><p class="sub">3 passos: quem recebe, a mensagem e quando enviar</p></div><a class="botao" href="${rotaEmpresa(id, 'disparos')}">← Disparos</a></div>
    <form id="f-disparo" class="editor">
      <div>
        <div class="card">
          <h2><span class="passo-num">1</span> Quem vai receber</h2>
          ${leadIds.length ? `${balao(`${leadIds.length} leads escolhidos na lista`, `<a href="${rotaEmpresa(id, 'disparos/novo')}" id="limpar-escolha">Usar filtros em vez disso</a>`, 'ok')}` : `
          <div class="campo"><label>Etapas ${ajuda('Nenhuma marcada = todas as etapas.')}</label><div class="chips">${emp.etapas.map((e) => `<label class="chip-check"><input type="checkbox" name="etapa" value="${esc(e)}"><span>${esc(e)}</span></label>`).join('')}</div></div>
          <div class="campo" style="margin-top:12px"><label>Etiquetas ${ajuda('Recebe quem tiver pelo menos uma das etiquetas marcadas. Nenhuma marcada = qualquer etiqueta.')}</label><div class="chips">${emp.etiquetas.map((t) => `<label class="chip-check" style="--cor:${esc(t.cor)}"><input type="checkbox" name="etiqueta" value="${esc(t.id)}"><span><span class="bolinha-cor"></span>${esc(t.nome)}</span></label>`).join('') || '<span class="rotulo">Nenhuma etiqueta do WhatsApp ainda.</span>'}</div></div>
          <div class="campo" style="margin-top:12px"><label>De onde veio</label><select name="origem"><option value="todos">Todos</option><option value="site">Site</option><option value="whatsapp">WhatsApp</option><option value="manual">Cadastrados / importados</option></select></div>`}
          <div class="contagem" id="contagem">Calculando…</div>
        </div>
        <div class="card">
          <h2><span class="passo-num">2</span> A mensagem</h2>
          <div class="campo"><label>Nome do disparo (só para você)</label><input name="nome" placeholder="Ex.: Promoção de março"></div>
          <div class="campo" style="margin-top:12px">
            <label>Mensagem *</label>
            <div class="botoes-variavel"><button type="button" class="pequeno" data-inserir="{nome}">+ Nome do cliente</button><button type="button" class="pequeno" data-inserir="{Oi|Olá|E aí}">+ Variação de saudação</button></div>
            <textarea name="mensagem" required style="min-height:140px" placeholder="{Oi|Olá} {nome}! Tudo bem? Esta semana temos 20% de desconto. Quer que eu te mande os detalhes?"></textarea>
            <small><code>{nome}</code> vira o primeiro nome do cliente. <code>{Oi|Olá}</code> sorteia uma das opções — mensagens diferentes ajudam a não ser bloqueado.</small>
          </div>
          <div class="campo" style="margin-top:12px"><label>Fotos, vídeos e arquivos (opcional, até 5) ${ajuda('A primeira foto/vídeo/PDF leva a mensagem como legenda; as outras vão logo depois. Álbum manda as fotos dele.')}</label>
            <div class="midias-fup" id="disp-midias"></div>
            <div class="linha-form" style="margin-top:6px;flex-wrap:wrap">
              <select id="disp-add-midia"><option value="">+ Escolher da biblioteca…</option>${albuns.filter((a) => a.quantidade).length ? `<optgroup label="Álbuns">${albuns.filter((a) => a.quantidade).map((a) => `<option value="${esc(a.id)}">🗂️ ${esc(a.nome)} (${a.quantidade})</option>`).join('')}</optgroup>` : ''}<optgroup label="Mídias">${lista.filter((m) => !m.pastaId).map((m) => `<option value="${esc(m.id)}">${ICONE_TIPO[m.tipo] || '📎'} ${esc(m.nome)}</option>`).join('')}</optgroup></select>
              <label class="botao pequeno">📤 Enviar arquivo novo<input type="file" id="disp-novo" multiple hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label>
            </div>
            <div id="disp-envio" class="rotulo"></div>
            <small>Arquivo novo fica guardado em <a href="${rotaEmpresa(id, 'midias')}">Mídias</a> (em "a configurar": a IA só usa depois que você configurar).</small></div>
        </div>
        <div class="card">
          <h2><span class="passo-num">3</span> Quando e como enviar</h2>
          ${balao('Proteção contra bloqueio', 'O WhatsApp bloqueia números que mandam muitas mensagens iguais de uma vez. Por isso o CRM envia <b>uma por vez</b>, com um intervalo sorteado entre elas. Quanto maior o intervalo, mais seguro.')}
          <div class="campos">
            <div class="campo"><label>Intervalo entre mensagens</label><select name="intervalo"><option value="15-35">Rápido (15 a 35 s)</option><option value="30-75" selected>Recomendado (30 a 75 s)</option><option value="60-150">Bem seguro (1 a 2,5 min)</option></select></div>
            <div class="campo"><label>Começar</label><select name="quando"><option value="agora">Agora</option><option value="agendar">Agendar…</option></select></div>
            <div class="campo" id="campo-agenda" hidden><label>Data e hora</label><input type="datetime-local" name="agendadoPara"></div>
          </div>
          <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="horarioComercial" checked> Enviar só em horário comercial (8h às 20h)</label>
          <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="rodapeSair" checked> Colocar "responda SAIR para não receber mais" no final</label>
        </div>
      </div>
      <div>
        <div class="card teste whatsapp previa-disparo">
          <div class="cab"><span>Prévia no WhatsApp</span></div>
          <div class="chat" id="previa"><div class="msg acao-ia">Escreva a mensagem para ver a prévia.</div></div>
        </div>
        <button type="submit" class="primario grande-botao" id="enviar-disparo" disabled>📣 Iniciar disparo</button>
      </div>
    </form>`;

  const form = $('#f-disparo');
  const filtro = () => {
    if (leadIds.length) return { leadIds };
    const f = formParaObjeto(form);
    return {
      etapas: $$('input[name=etapa]:checked', form).map((c) => c.value),
      etiquetas: $$('input[name=etiqueta]:checked', form).map((c) => c.value),
      origem: f.origem
    };
  };
  let total = 0;
  let espera = null;
  async function atualizarPrevia() {
    if (!form.isConnected) return;
    const f = formParaObjeto(form);
    try {
      const r = await api(`empresas/${id}/disparos/previa`, { method: 'POST', body: { filtro: filtro(), mensagem: f.mensagem, rodapeSair: f.rodapeSair } });
      if (!form.isConnected) return;
      total = r.total;
      $('#contagem').innerHTML = r.total
        ? `<strong>${r.total} ${r.total === 1 ? 'pessoa vai' : 'pessoas vão'} receber</strong><span class="rotulo">${r.nomes.map(esc).join(', ')}${r.total > r.nomes.length ? '…' : ''}</span>${r.semNumero || r.sairam ? `<span class="rotulo">${r.semNumero ? `${r.semNumero} sem WhatsApp` : ''}${r.semNumero && r.sairam ? ' · ' : ''}${r.sairam ? `${r.sairam} pediram para não receber ou estão na lista negra` : ''} (ficam de fora)</span>` : ''}`
        : '<strong>Ninguém nesse filtro</strong><span class="rotulo">Mude as etapas ou etiquetas.</span>';
      const itens = escolhidas.map(itemDe).filter(Boolean);
      $('#previa').innerHTML = r.exemplo
        ? `${itens.map((m) => `<div class="msg bot midia-previa-msg">${m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="">` : `${m.icone} ${esc(m.nome)}`}</div>`).join('')}<div class="msg bot">${esc(r.exemplo).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')}</div><div class="msg acao-ia">Exemplo com o primeiro contato da lista. Cada pessoa recebe com o próprio nome.</div>`
        : '<div class="msg acao-ia">Escreva a mensagem para ver a prévia.</div>';
      $('#enviar-disparo').disabled = !(r.total && f.mensagem.trim());
      $('#enviar-disparo').textContent = r.total ? `📣 Enviar para ${r.total} ${r.total === 1 ? 'pessoa' : 'pessoas'}` : '📣 Iniciar disparo';
    } catch (err) {
      if (!form.isConnected) return;
      $('#contagem').innerHTML = `<span class="erro-caixa">${esc(err.message)}</span>`;
    }
  }
  const agendarPrevia = () => { clearTimeout(espera); espera = setTimeout(atualizarPrevia, 350); };
  function desenharEscolhidas() {
    $('#disp-midias').innerHTML = escolhidas.map((mid, i) => { const m = itemDe(mid); return m ? `<span class="etiqueta">${m.icone} ${esc(m.nome)}${m.processando ? ' ⏳' : ''} <button type="button" class="x-chip" data-tirar-disp="${i}" title="Tirar">✕</button></span>` : ''; }).join('') || '<span class="rotulo">Nenhuma — vai só o texto.</span>';
    $$('[data-tirar-disp]').forEach((b) => { b.onclick = () => { escolhidas.splice(Number(b.dataset.tirarDisp), 1); desenharEscolhidas(); agendarPrevia(); }; });
    $('#disp-add-midia').disabled = escolhidas.length >= 5;
  }
  desenharEscolhidas();
  $('#disp-add-midia').onchange = (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (v && !escolhidas.includes(v) && escolhidas.length < 5) escolhidas.push(v);
    desenharEscolhidas();
    agendarPrevia();
  };
  $('#disp-novo').onchange = async (e) => {
    const arquivos = [...e.target.files].slice(0, 5 - escolhidas.length);
    e.target.value = '';
    for (const arq of arquivos) {
      try {
        const nova = await subirParaBiblioteca(id, arq, (pct) => { $('#disp-envio').textContent = `Enviando ${arq.name}: ${pct}%`; });
        lista.push(nova);
        escolhidas.push(nova.id);
        $('#disp-envio').textContent = nova.processando ? `✓ ${arq.name} enviado · 🎬 convertendo para o WhatsApp (sai assim que terminar)` : `✓ ${arq.name} enviado`;
        desenharEscolhidas();
        agendarPrevia();
      } catch (err) {
        $('#disp-envio').textContent = `✕ ${arq.name}: ${err.message}`;
      }
    }
  };
  form.addEventListener('input', agendarPrevia);
  form.addEventListener('change', agendarPrevia);
  atualizarPrevia();
  $$('[data-inserir]').forEach((b) => {
    b.onclick = () => {
      const t = form.elements.mensagem;
      const pos = t.selectionStart ?? t.value.length;
      t.value = t.value.slice(0, pos) + b.dataset.inserir + t.value.slice(t.selectionEnd ?? pos);
      t.focus();
      agendarPrevia();
    };
  });
  form.elements.quando.onchange = (e) => { $('#campo-agenda').hidden = e.target.value !== 'agendar'; };
  $('#limpar-escolha')?.addEventListener('click', (e) => { e.preventDefault(); paginaNovoDisparo(id); });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = formParaObjeto(form);
    const [min, max] = f.intervalo.split('-').map(Number);
    const agendado = f.quando === 'agendar' && f.agendadoPara ? new Date(f.agendadoPara) : null;
    if (f.quando === 'agendar' && !agendado) return aviso('Escolha a data e a hora.', true);
    const minutos = Math.round((total * ((min + max) / 2)) / 60);
    const ok = await confirmar({
      titulo: `Enviar para ${total} ${total === 1 ? 'pessoa' : 'pessoas'}?`,
      texto: `<p>${agendado ? `Começa em <b>${esc(agendado.toLocaleString('pt-BR'))}</b>.` : 'Começa agora.'} Leva mais ou menos <b>${minutos < 60 ? `${Math.max(1, minutos)} min` : `${(minutos / 60).toFixed(1).replace('.', ',')} h`}</b>${f.horarioComercial ? ' (só em horário comercial)' : ''}.</p><p class="rotulo">Dá para pausar ou cancelar a qualquer momento.</p>`,
      botao: agendado ? 'Agendar' : 'Começar agora'
    });
    if (!ok) return;
    try {
      const d = await api(`empresas/${id}/disparos`, {
        method: 'POST',
        body: {
          nome: f.nome,
          mensagem: f.mensagem,
          midiaIds: escolhidas,
          filtro: filtro(),
          intervaloMin: min,
          intervaloMax: max,
          horarioComercial: f.horarioComercial,
          rodapeSair: f.rodapeSair,
          agendadoPara: agendado ? agendado.toISOString() : null
        }
      });
      aviso(agendado ? 'Disparo agendado!' : 'Disparo iniciado!');
      location.hash = rotaEmpresa(id, `disparos/${d.id}`);
    } catch (err) { aviso(err.message, true); }
  };
}

async function paginaDisparo(id, disparoId) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/disparos/${disparoId}`);
  const ST = { pendente: ['na fila', ''], enviado: ['enviado', 'ok'], erro: ['erro', 'off'], ignorado: ['ficou de fora', ''], cancelado: ['cancelado', ''] };
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>${esc(d.nome)}</h1><p class="sub">${statusDisparo(d)} ${d.agendadoPara && d.status === 'agendado' ? `começa em ${data(d.agendadoPara)}` : ''}</p></div><a class="botao" href="${rotaEmpresa(id, 'disparos')}">← Disparos</a></div>
    ${d.status === 'pausado' && d.motivoPausa ? balao('Disparo pausado', esc(d.motivoPausa), 'aviso') : ''}
    ${d.status === 'enviando' && d.aguardandoHorario ? balao('Esperando o horário comercial', 'Os envios continuam sozinhos a partir das 8h.', 'dica') : ''}
    <div class="grade-resumo">
      ${numeroCard('Total', d.total)}
      ${numeroCard('Enviados', d.enviado)}
      ${numeroCard('Responderam', d.responderam)}
      ${numeroCard('Com erro / de fora', d.erro + d.ignorado)}
    </div>
    <div class="card">
      ${barraProgresso(d)}
      <p class="rotulo" style="margin:8px 0 0">${d.proximoEnvioEm && d.status === 'enviando' ? `Próximo envio às ${new Date(d.proximoEnvioEm).toLocaleTimeString('pt-BR')}` : ''}</p>
      <div class="acoes">
        ${['enviando', 'agendado'].includes(d.status) ? '<button type="button" data-acao="pausar">⏸ Pausar</button>' : ''}
        ${d.status === 'pausado' ? '<button type="button" class="primario" data-acao="retomar">▶ Continuar</button>' : ''}
        ${!['concluido', 'cancelado'].includes(d.status) ? '<button type="button" class="perigo" data-acao="cancelar">Cancelar disparo</button>' : ''}
        ${!['enviando', 'agendado'].includes(d.status) ? '<button type="button" class="perigo" id="apagar-disparo" style="margin-left:auto">Apagar</button>' : ''}
      </div>
    </div>
    <div class="duas-colunas">
      <div class="card"><h2>Mensagem</h2><div class="conversa"><div class="msg bot">${esc(d.mensagem)}</div></div><p class="rotulo">Intervalo de ${d.intervaloMin} a ${d.intervaloMax} s${d.horarioComercial ? ' · só em horário comercial' : ''}${d.rodapeSair ? ' · com opção SAIR' : ''} · criado por ${esc(d.criadoPor || '—')}</p></div>
      <div class="card tabela-wrap" style="max-height:480px;overflow:auto">
        <table>
          <thead><tr><th>Contato</th><th>Situação</th></tr></thead>
          <tbody>${d.destinatarios.map((x) => `<tr><td><a href="#/leads/${esc(x.leadId)}">${esc(x.nome || x.numero || 'Lead')}</a>${x.nome && x.numero ? `<br><span class="rotulo">${esc(telefoneBonito(x.numero))}</span>` : ''}</td><td><span class="etiqueta ${ST[x.status]?.[1] || ''}">${ST[x.status]?.[0] || x.status}</span>${x.erro ? `<br><span class="rotulo">${esc(x.erro)}</span>` : ''}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  $$('[data-acao]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.acao === 'cancelar' && !(await confirmar({ titulo: 'Cancelar o disparo?', texto: 'Quem ainda não recebeu não vai receber. Não dá para retomar depois.', botao: 'Cancelar disparo', perigo: true }))) return;
      try {
        await api(`empresas/${id}/disparos/${disparoId}/${b.dataset.acao}`, { method: 'POST' });
        paginaDisparo(id, disparoId);
      } catch (err) { aviso(err.message, true); }
    };
  });
  $('#apagar-disparo')?.addEventListener('click', async () => {
    if (!(await confirmar({ titulo: 'Apagar este disparo?', texto: 'Some só o relatório; as mensagens enviadas continuam nos leads.', botao: 'Apagar', perigo: true }))) return;
    try {
      await api(`empresas/${id}/disparos/${disparoId}`, { method: 'DELETE' });
      location.hash = rotaEmpresa(id, 'disparos');
    } catch (err) { aviso(err.message, true); }
  });
  if (['enviando', 'agendado'].includes(d.status)) {
    const aqui = location.hash;
    atualizador = setInterval(() => { if (location.hash === aqui) paginaDisparo(id, disparoId).catch(() => {}); }, 6000);
  }
}

// ---------------------------------------------------------------- mensagens (reusado em Conversas e no lead)

const PAPEL_ROTULO = { visitante: 'Cliente', assistente: 'IA', equipe: 'Equipe' };

function htmlAnexo(m, leadId) {
  const a = m.anexo;
  if (!a) return '';
  const url = `api/leads/${encodeURIComponent(leadId)}/anexos/${encodeURIComponent(a.arquivo)}`;
  if (a.tipo === 'image') return `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="anexo-img" src="${esc(url)}" alt="foto" loading="lazy"></a>${a.descricao ? `<span class="anexo-nota">👁️ ${esc(a.descricao)}</span>` : ''}`;
  if (a.tipo === 'audio') return `<audio class="anexo-audio" controls preload="none" src="${esc(url)}"></audio>${a.transcricao ? `<span class="anexo-nota">📝 ${esc(a.transcricao)}</span>` : m.papel === 'visitante' ? `<button type="button" class="link-botao anexo-nota" data-entender="${esc(a.arquivo)}" data-lead="${esc(leadId)}">📝 Transcrever áudio</button>` : ''}`;
  if (a.tipo === 'video') return `<video class="anexo-img" controls preload="none" src="${esc(url)}"></video>`;
  return `<a class="anexo-doc" href="${esc(url)}" target="_blank" rel="noopener">📄 ${esc(a.nome || 'arquivo')}</a>`;
}

// Formatação do WhatsApp: *negrito*, _itálico_, ~riscado~ e links
function formatarWhats(t) {
  return esc(t)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?]|$)/g, '$1<s>$2</s>');
}

function diaDaMensagem(iso) {
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(Date.now() - 864e5);
  if (d.toDateString() === hoje.toDateString()) return 'HOJE';
  if (d.toDateString() === ontem.toDateString()) return 'ONTEM';
  if (Date.now() - d.getTime() < 6 * 864e5) return d.toLocaleDateString('pt-BR', { weekday: 'long' }).toUpperCase();
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Uma mensagem no balão, do lado certo (cliente à esquerda, empresa à direita)
function htmlMensagem(m, leadId, anterior) {
  const saida = m.papel !== 'visitante';
  const lado = saida ? 'saida' : 'entrada';
  const seguida = anterior && (anterior.papel !== 'visitante') === saida && new Date(m.em) - new Date(anterior.em) < 5 * 60 * 1000;
  const rotulo = m.automacaoNome ? `⚡ ${m.automacaoNome}` : m.disparoId ? '📣 Disparo' : m.agendadaId ? '🕒 Agendada' : m.papel === 'assistente' ? '🤖 IA' : '';
  const canal = m.canal === 'site' ? '🌐 chat do site' : '';
  const topo = [rotulo, canal].filter(Boolean).join(' · ');
  // o texto do cliente com áudio/foto já foi trocado pela transcrição: mostra o arquivo e a transcrição
  const textoVisivel = m.anexo && /^\[(áudio|foto) do cliente\]:/.test(m.texto || '') ? '' : m.texto;
  const hora = new Date(m.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  // botão ⌄ no canto do balão (como no WhatsApp): apagar a mensagem
  const menu = m.id ? `<button type="button" class="msg-menu" data-msg-menu="${esc(m.id)}" data-lead="${esc(leadId)}" data-todos="${m.apagaParaTodos ? '1' : ''}" data-cliente="${saida ? '' : '1'}" title="Apagar mensagem" aria-label="Opções da mensagem">⌄</button>` : '';
  if (m.apagada) {
    const quem = { cliente: 'O cliente apagou esta mensagem', celular: 'Apagada pelo celular da empresa', equipe: 'Você apagou esta mensagem' }[m.apagada.por] || 'Mensagem apagada';
    return `<div class="msg ${lado} apagada${seguida ? '' : ' cauda'}" title="${esc(data(m.apagada.em || m.em))}">${menu.replace('data-todos="1"', 'data-todos=""')}<span class="msg-texto">🚫 <i>${esc(quem)}</i></span><span class="msg-rodape">${hora}</span></div>`;
  }
  return `<div class="msg ${lado}${seguida ? '' : ' cauda'}" title="${esc(data(m.em))}">${menu}${topo ? `<span class="msg-origem">${esc(topo)}</span>` : ''}${htmlAnexo(m, leadId)}${textoVisivel ? `<span class="msg-texto">${formatarWhats(textoVisivel)}</span>` : ''}${m.whatsapp ? '<em class="msg-nota">→ Ofereceu continuar no WhatsApp</em>' : ''}${m.envio === 'erro' ? `<em class="msg-nota erro-envio">⚠️ Não foi enviado: ${esc(m.erroEnvio || 'erro no WhatsApp')}</em>` : m.comoArquivo ? '<em class="msg-nota">Foi como arquivo (qualidade original)</em>' : ''}<span class="msg-rodape">${hora}${m.envio === 'enviando' ? ' <span class="enviando" title="Enviando pelo WhatsApp">⏳</span>' : m.envio === 'erro' ? '' : saida ? ' <span class="checks">✓✓</span>' : ''}</span></div>`;
}

// O que o modo clone aprendeu (dá para apagar exemplos ruins)
async function modalClone(empresaId, depois) {
  const r = await api(`empresas/${empresaId}/clone`);
  abrirModal(`
    <h2>🧬 O que o clone aprendeu</h2>
    <p class="rotulo">Respostas manuais de conversas que viraram venda. Na hora de responder, a IA usa as mais parecidas com o que o cliente disse. Tire as que não representam o seu jeito.</p>
    <div class="lista-clone">${r.exemplos.map((ex) => `
      <div class="exemplo-clone" data-ex="${esc(ex.id)}">
        <div class="rotulo">Cliente: ${esc(ex.cliente)}</div>
        <div><b>Você:</b> ${esc(ex.resposta || '(só mandou mídia)')}${(ex.midias || []).length ? ` <span class="etiqueta">🖼️ ${ex.midias.map(esc).join(', ')}</span>` : ''}</div>
        <button type="button" class="pequeno perigo" data-apagar-ex="${esc(ex.id)}">Não usar esta</button>
      </div>`).join('') || '<p class="rotulo">Nada ainda.</p>'}</div>
    <div class="acoes">${r.exemplos.length ? '<button type="button" class="perigo" id="limpar-clone">Recomeçar do zero</button>' : ''}<button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
    $$('[data-apagar-ex]', m).forEach((b) => {
      b.onclick = async () => {
        await api(`empresas/${empresaId}/clone/exemplos/${b.dataset.apagarEx}`, { method: 'DELETE', body: {} });
        b.closest('.exemplo-clone').remove();
      };
    });
    $('#limpar-clone', m)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Recomeçar o clone do zero?', texto: 'Ele esquece o que aprendeu até agora e volta a contar a partir das próximas vendas (as conversas e as mídias continuam).', botao: 'Recomeçar', perigo: true }))) return;
      await api(`empresas/${empresaId}/clone/exemplos`, { method: 'DELETE', body: {} });
      fechar();
      depois?.();
    });
  });
}

// Liga/desliga "a IA para de responder depois da minha mensagem manual"
// ⏰ Avisos internos para a IA ([SEM_RESPOSTA], [CHECAR_VIDEO]…): liga/desliga e tempo por empresa
async function cartaoEventosIa(id) {
  const el = $('#card-eventos-ia');
  if (!el) return;
  let c;
  try { c = await api(`empresas/${id}/eventos-ia`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  const DICA = {
    fotoCliente: 'Quando o cliente manda uma imagem, a IA recebe [CLIENTE_ENVIOU_FOTO] junto com a descrição da foto. Não gasta nada a mais.',
    semResposta: 'O cliente parou de responder depois da última mensagem da IA: ela recebe [SEM_RESPOSTA] e decide se retoma (uma vez por silêncio).',
    checarVideo: 'Depois que a IA manda um vídeo e o cliente não responde: ela recebe [CHECAR_VIDEO] e pergunta se ele conseguiu ver.',
    followup1: 'Primeira retomada feita pela IA, com o contexto da conversa. Se você usa o Follow-up sem IA, deixe este desligado para não mandar dois.'
  };
  const ligados = Object.values(c).filter((e) => e.ativo).length;
  el.dataset.cfg = 'eventos-ia';
  el.dataset.pronto = ligados ? 'ok' : 'off';
  el.dataset.resumo = `${ligados} de 4 ligados`;
  el.innerHTML = `
    <h2 style="margin:0 0 6px">⏰ Avisos internos para a IA</h2>
    <p class="rotulo" style="margin:0 0 10px">O sistema manda para a IA uma mensagem entre colchetes que o cliente <b>nunca vê</b>, e ela responde de acordo. Só dispara se a IA não estiver pausada no contato e só para conversas depois de ligar. Os avisos com tempo usam a IA (gastam crédito).</p>
    <form id="f-eventos-ia" class="lista-eventos-ia">
      ${Object.entries(c).map(([k, e]) => `
        <div class="evento-ia">
          <label class="linha-check"><input type="checkbox" name="${k}-ativo" ${e.ativo ? 'checked' : ''}> <b>[${esc(e.tag)}]</b> ${esc(e.nome)}</label>
          ${e.semTempo ? '<span class="rotulo">na hora</span>' : `<span class="tempo-evento">depois de <input type="number" name="${k}-minutos" min="1" max="20160" value="${Number(e.minutos) || 1}"> min</span>`}
          <small class="rotulo">${DICA[k] || ''}</small>
        </div>`).join('')}
      <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
    </form>`;
  marcarPronto(el, el.dataset.pronto, el.dataset.resumo);
  $('#f-eventos-ia').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const corpo = {};
    for (const k of Object.keys(c)) corpo[k] = { ativo: f.elements[`${k}-ativo`].checked, ...(f.elements[`${k}-minutos`] ? { minutos: Number(f.elements[`${k}-minutos`].value) } : {}) };
    try {
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/eventos-ia`, { method: 'PUT', body: corpo }));
      aviso('Avisos internos salvos.');
      cartaoEventosIa(id);
    } catch (err) { aviso(err.message, true); }
  };
}

// 📜 Log das respostas da IA: texto bruto, códigos, mídias, Evolution e erros
async function cartaoLogIa(id, soErros = false) {
  const el = $('#card-log-ia');
  if (!el) return;
  let lista;
  try { lista = await api(`empresas/${id}/logs-ia?limite=40${soErros ? '&soErros=1' : ''}`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  const comErro = lista.filter((l) => l.erros.length).length;
  const SIT = { enviada: '✓ enviada', descartada: '↩ descartada', pausada: '⏸ enviada e pausou', erro: '✕ erro', nada: '🤐 nada a dizer' };
  el.innerHTML = `
    <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">📜 Log das respostas da IA</h2>
      <span class="barra"><label class="linha-check" style="margin:0"><input type="checkbox" id="log-so-erros" ${soErros ? 'checked' : ''}> só com problema</label><button type="button" class="pequeno" id="log-atualizar">🔄</button></span></div>
    <p class="rotulo" style="margin:0 0 8px">Cada resposta: o que a IA escreveu (bruto), os códigos encontrados, as mídias (enviada, já enviada, não existe, erro), o retorno do WhatsApp e os erros.${comErro ? ` <b class="aviso-texto">${comErro} com erro.</b>` : ''}</p>
    ${lista.length ? `<div class="lista-log-ia">${lista.map((l) => `
      <details class="log-ia ${l.erros.length ? 'com-erro' : l.avisos.length ? 'com-aviso' : ''}">
        <summary><span class="rotulo">${esc(data(l.em))}</span> <b>${esc(l.cliente || 'cliente')}</b> · ${esc(SIT[l.situacao] || l.situacao)}${l.origem !== 'resposta' ? ` · <span class="cod-det controle">${esc(l.origem.replace('evento:', '['))}${l.origem.startsWith('evento:') ? ']' : ''}</span>` : ''}${l.midias.length ? ` · 📎 ${l.midias.length}` : ''}${l.erros.length ? ` · <span class="aviso-texto">✕ ${esc(l.erros[0])}</span>` : ''}</summary>
        ${l.textoEnviado ? `<div class="rotulo" style="margin-top:6px">Texto enviado${l.evolutionTexto?.id ? ` (sendText · id ${esc(l.evolutionTexto.id)})` : ''}:</div><div class="msg bot log-texto">${esc(l.textoEnviado)}</div>` : ''}
        ${htmlDetalhesResposta(l)}
        ${l.leadId ? `<a class="rotulo" href="${rotaEmpresa(id, 'conversas')}?lead=${esc(l.leadId)}">Abrir conversa →</a>` : ''}
      </details>`).join('')}</div>` : `<p class="rotulo">${soErros ? 'Nenhuma resposta com problema. 👍' : 'Nenhuma resposta registrada ainda.'}</p>`}`;
  $('#log-so-erros').onchange = (e) => cartaoLogIa(id, e.target.checked);
  $('#log-atualizar').onclick = () => cartaoLogIa(id, soErros);
}

async function trocarIaParaManual(empresaId, chk, depois) {
  const parar = chk.checked;
  try {
    await api(`empresas/${empresaId}/whatsapp`, { method: 'PUT', body: { iaAposManual: !parar } });
    aviso(parar ? 'Ligado: a IA para de responder o cliente quando você manda uma mensagem manual.' : 'Desligado: a IA continua atendendo mesmo depois das suas mensagens manuais.');
    depois?.();
  } catch (err) {
    chk.checked = !parar;
    aviso(err.message, true);
  }
}

// Sobe um arquivo em pedaços de ~900 KB (passa do limite do servidor e aguenta
// vídeo grande); tenta cada pedaço até 3 vezes se a internet oscilar
async function subirEmPedacos(arquivo, ini, aoAvancar) {
  for (let pos = 0; pos < arquivo.size; pos += ini.pedaco) {
    const parte = arquivo.slice(pos, pos + ini.pedaco);
    for (let tentativa = 1; ; tentativa++) {
      const r = await fetch(`api/empresas/${ini.empresaId}/midias/envio/${ini.envioId}/parte?pos=${pos}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: parte }).catch(() => ({ ok: false }));
      if (r.ok) break;
      if (tentativa >= 3) throw new Error(r.status === 413 ? 'o servidor recusou um pedaço do arquivo' : 'a conexão caiu no meio do envio. Tente de novo.');
      await new Promise((ok) => setTimeout(ok, 1000 * tentativa));
    }
    aoAvancar?.(Math.round((Math.min(arquivo.size, pos + ini.pedaco) / arquivo.size) * 100));
  }
}

// Buscar no WhatsApp as mensagens que não chegaram ao painel
// 🏷️ etiquetas do WhatsApp Business ⇄ CRM (página IA do WhatsApp)
async function cartaoEtiquetasZap(id) {
  const el = $('#card-etq-zap');
  if (!el) return;
  let r;
  try { r = await api(`empresas/${id}/etiquetas-zap`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  setTimeout(() => marcarPronto(el, !r.ativo ? 'off' : r.noZap.length ? 'ok' : null, !r.ativo ? 'Desligado' : `${r.noZap.length} etiqueta(s) ligadas ao celular`));
  el.innerHTML = `
    <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🏷️ Etiquetas do WhatsApp Business</h2>${interruptor('etq-zap-ativo', r.ativo, r.ativo ? 'Ligado' : 'Desligado')}</div>
    <p class="rotulo" style="margin:0 0 10px">As etiquetas do CRM são <b>só as do WhatsApp Business</b>: criou, renomeou ou apagou no celular, muda aqui. Marcou <b>Agendado</b> num cliente no celular → aparece aqui. Marcou aqui → aparece no celular. Funciona só em número <b>WhatsApp Business</b>.</p>
    ${r.ativo ? `
    <div class="chips" style="margin-bottom:8px">${r.noZap.length ? r.noZap.map((l) => `<span class="chip-etq" style="--cor:${esc(l.cor)}"><span class="bolinha-cor"></span>${esc(l.nome)} ✓</span>`).join('') : '<span class="rotulo">Nenhuma etiqueta lida do WhatsApp ainda.</span>'}</div>
    ${r.erro ? `<p class="rotulo aviso-texto" style="margin:0 0 8px">⚠️ ${esc(r.erro)}</p>` : ''}
    ${!r.noZap.length ? `<div class="balao balao-aviso" style="margin:0 0 10px"><span class="balao-icone">🏷️</span><div><strong>Suas etiquetas do celular ainda não chegaram</strong><div class="balao-texto">O WhatsApp só manda todas as etiquetas quando o celular é conectado. Clique em <b>Trazer etiquetas do celular</b> e escaneie o QR code com o <b>mesmo celular</b> (WhatsApp Business → Aparelhos conectados). Leva 1 minuto; nenhuma conversa se perde e o CRM busca as mensagens desse intervalo.</div><div class="acoes" style="margin:8px 0 0"><button type="button" class="primario" id="etq-zap-reconectar">🔄 Trazer etiquetas do celular</button></div></div></div>` : ''}
    <p class="rotulo" style="margin:0 0 10px">📱 Celular ligado a esta empresa: <b>${r.numero ? `${esc(telefoneBonito(r.numero))} (final ${esc(r.numero.slice(-4))})` : 'número não lido ainda'}</b> · última etiqueta recebida do celular: <b>${r.ultimoEventoEm ? esc(data(r.ultimoEventoEm)) : 'nenhuma até agora'}</b>.<br>Para testar: neste celular, abra uma conversa e coloque uma etiqueta — ela aparece aqui em segundos. Se você coloca as etiquetas em <b>outro celular</b>, é ele que precisa estar conectado aqui.</p>
    <div class="acoes" style="margin:0"><button type="button" id="etq-zap-ler">🔄 Ler etiquetas do WhatsApp agora</button><span class="rotulo">${r.carregadoEm ? `Última leitura: ${esc(data(r.carregadoEm))}` : ''}</span></div>` : ''}`;
  // enquanto a tela está aberta, confere se chegou etiqueta nova (teste ao vivo)
  clearTimeout(cartaoEtiquetasZap.vigia);
  const vigiar = async () => {
    if (!el.isConnected) return;
    const n = await api(`empresas/${id}/etiquetas-zap`).catch(() => null);
    if (n && (n.ultimoEventoEm !== r.ultimoEventoEm || n.noZap.length !== r.noZap.length)) { aviso('Etiqueta recebida do celular.'); cartaoEtiquetasZap(id); } else if (el.isConnected) cartaoEtiquetasZap.vigia = setTimeout(vigiar, 8000);
  };
  if (r.ativo) cartaoEtiquetasZap.vigia = setTimeout(vigiar, 8000);
  $('#etq-zap-ativo').onchange = async (e) => {
    try { await api(`empresas/${id}/etiquetas-zap`, { method: 'PUT', body: { ativo: e.target.checked } }); if (e.target.checked) await api(`empresas/${id}/etiquetas-zap/carregar`, { method: 'POST', body: {} }); cartaoEtiquetasZap(id); } catch (err) { aviso(err.message, true); }
  };
  $('#etq-zap-reconectar')?.addEventListener('click', async (e) => {
    if (!(await confirmar({ titulo: 'Reconectar o WhatsApp?', texto: 'O CRM desconecta este número da conexão e mostra um QR code novo. Escaneie com o <b>mesmo celular</b> (WhatsApp Business → Aparelhos conectados → Conectar um aparelho). O celular manda todas as etiquetas e marcações. Enquanto não escanear, a IA não responde por aqui.', botao: 'Reconectar agora' }))) return;
    try {
      await comEspera(e.target, () => api(`empresas/${id}/whatsapp/sair-numero`, { method: 'POST' }));
      aviso('Agora escaneie o QR code com o mesmo celular.');
      paginaWhatsapp(id).then(() => window.scrollTo(0, 0));
    } catch (err) { aviso(err.message, true); }
  });
  $('#etq-zap-ler')?.addEventListener('click', async (e) => {
    try { await comEspera(e.target, () => api(`empresas/${id}/etiquetas-zap/carregar`, { method: 'POST', body: {} }), 'Lendo…'); aviso('Etiquetas lidas.'); cartaoEtiquetasZap(id); } catch (err) { aviso(err.message, true); }
  });
}

// 📅 aviso de agendamento para um número cadastrado (página IA do WhatsApp)
async function cartaoAvisoAgendamento(id) {
  const el = $('#card-aviso-agenda');
  if (!el) return;
  let c;
  try { c = await api(`empresas/${id}/aviso-agendamento`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  // número salvo mas desligado: fica aberto e avisa (é o caso em que "nada chega")
  setTimeout(() => marcarPronto(el, c.ativo && c.numero ? 'ok' : c.numero ? null : 'off', c.ativo && c.numero ? `Ligado · ${telefoneBonito(c.numero)}` : 'Desligado: ninguém é avisado dos agendamentos'));
  el.innerHTML = `
    <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">📅 Aviso de agendamento</h2>${interruptor('aviso-ag-ativo', c.ativo, c.ativo ? 'Ligado' : 'Desligado')}</div>
    <p class="rotulo" style="margin:0 0 10px">Todo agendamento <b>confirmado</b> — pela IA, por você no painel ou combinado na conversa do WhatsApp — manda um resumo para este número: cliente, telefone com link para chamar (wa.me), dia e hora, serviço, item do cliente (carro, aparelho…), endereço, preço e outras informações importantes da conversa.</p>
    ${c.numero && !c.ativo ? `<p class="aviso-desligado">⚠️ O número <b>${esc(telefoneBonito(c.numero))}</b> está salvo, mas o aviso está <b>DESLIGADO</b> — por isso nada chega. Ligue no botão acima.</p>` : ''}
    <form id="f-aviso-ag" class="linha-form" style="flex-wrap:wrap"><input name="numero" value="${esc(c.numero ? telefoneBonito(c.numero) : '')}" placeholder="WhatsApp que recebe o aviso (DDD + número)"><button type="submit" class="primario">Salvar número</button><button type="button" id="aviso-ag-teste" ${c.numero ? '' : 'disabled'}>Mandar um teste</button></form>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--borda)">${interruptor('agenda-auto', c.automatica, 'Perceber agendamentos sozinho na conversa')}<p class="rotulo" style="margin:4px 0 0">Quando você, a equipe ou a IA combinam um horário com o cliente (ex.: "sábado às 9h?" → "pode ser"), o CRM marca o agendamento, move o lead para Agendou e avisa no sininho. Se o cliente desmarcar ou trocar o horário, ele cancela ou remarca sozinho. Dá para desfazer na conversa.</p></div>`;
  $('#agenda-auto').onchange = async (e) => {
    try { await api(`empresas/${id}/aviso-agendamento`, { method: 'PUT', body: { automatica: e.target.checked } }); aviso(e.target.checked ? 'O CRM vai perceber os agendamentos sozinho.' : 'Agendamentos só pela IA e à mão.'); } catch (err) { aviso(err.message, true); }
  };
  const salvar_ = async (corpo, msg) => {
    try {
      const r = await api(`empresas/${id}/aviso-agendamento`, { method: 'PUT', body: corpo });
      aviso(r.pendentes ? `${msg} Mandando o aviso de ${r.pendentes} agendamento(s) que já estavam marcados.` : msg);
      cartaoAvisoAgendamento(id);
    } catch (err) { aviso(err.message, true); cartaoAvisoAgendamento(id); }
  };
  $('#aviso-ag-ativo').onchange = (e) => salvar_({ ativo: e.target.checked, numero: $('#f-aviso-ag').elements.numero.value }, e.target.checked ? 'Aviso de agendamento ligado.' : 'Aviso de agendamento desligado.');
  $('#f-aviso-ag').onsubmit = (e) => { e.preventDefault(); salvar_({ numero: e.target.elements.numero.value }, 'Número salvo e aviso ligado.'); };
  $('#aviso-ag-teste').onclick = async (e) => {
    try { await comEspera(e.target, () => api(`empresas/${id}/aviso-agendamento/testar`, { method: 'POST', body: {} }), 'Enviando…'); aviso('Teste enviado. Confira o WhatsApp do número cadastrado.'); } catch (err) { aviso(err.message, true); }
  };
}

// 🚫 lista negra (página IA do WhatsApp)
async function cartaoListaNegra(id) {
  const el = $('#card-lista-negra');
  if (!el) return;
  let lista;
  try { lista = await api(`empresas/${id}/lista-negra`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  setTimeout(() => marcarPronto(el, 'ok', lista.length ? `${lista.length} número(s) bloqueado(s)` : 'Ninguém bloqueado'));
  el.innerHTML = `
    <h2>🚫 Lista negra</h2>
    <p class="rotulo" style="margin-top:-6px">Quem está aqui <b>não recebe nada</b>: nem IA, automações, follow-up, disparos ou mensagens da equipe. As mensagens deles continuam chegando (filtro 🚫 em Conversas). Também dá para pôr pelo botão 🚫 dentro da conversa.</p>
    <form id="f-lista-negra" class="linha-form" style="flex-wrap:wrap"><input name="numero" placeholder="Número com DDD (ex.: 21 99999-9999)" required><input name="motivo" placeholder="Motivo (opcional)"><button type="submit" class="perigo">🚫 Bloquear</button></form>
    ${lista.length ? `<div class="tabela-wrap" style="margin-top:10px"><table class="lista-negra-tabela"><thead><tr><th>Cliente</th><th class="esconde-mobile">Motivo</th><th class="esconde-mobile">Desde</th><th></th></tr></thead><tbody>${lista.map((b) => `<tr><td><b>${esc(b.nome || 'Sem nome')}</b><br><span class="rotulo">${esc(telefoneBonito(b.telefone) || (String(b.chaves?.[0] || '').endsWith('@lid') ? 'número oculto pelo WhatsApp' : b.chaves?.[0] || ''))}</span></td><td class="esconde-mobile rotulo">${esc(b.motivo || '—')}</td><td class="esconde-mobile rotulo">${esc(data(b.em))}</td><td><button type="button" class="pequeno" data-desbloquear="${esc(b.id)}">Desbloquear</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="rotulo" style="margin:10px 0 0">Ninguém na lista negra.</p>'}`;
  $('#f-lista-negra').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`empresas/${id}/lista-negra`, { method: 'POST', body: formParaObjeto(e.target) }); aviso('Número bloqueado.'); cartaoListaNegra(id); } catch (err) { aviso(err.message, true); }
  };
  $$('[data-desbloquear]', el).forEach((b) => {
    b.onclick = async () => {
      try { await api(`empresas/${id}/lista-negra/${b.dataset.desbloquear}`, { method: 'DELETE', body: {} }); aviso('Desbloqueado.'); cartaoListaNegra(id); } catch (err) { aviso(err.message, true); }
    };
  });
}

function modalSincronizar(empresaId, aoTerminar) {
  abrirModal(`
    <h2>🔄 Buscar mensagens do WhatsApp</h2>
    <p class="rotulo">O CRM confere as conversas do WhatsApp e traz para cá as mensagens que faltam (sem duplicar e sem a IA responder mensagens antigas).</p>
    <div class="opcoes-apagar">
      <button type="button" data-dias="1">Últimas 24 horas<small>rápido</small></button>
      <button type="button" class="primario" data-dias="7">Últimos 7 dias<small>recomendado depois de reconectar</small></button>
      <button type="button" data-dias="30">Últimos 30 dias<small>pode levar alguns minutos</small></button>
      <button type="button" data-fechar>Cancelar</button>
    </div>`, (modal, fechar) => {
    $$('[data-dias]', modal).forEach((b) => {
      b.onclick = async () => {
        $$('[data-dias]', modal).forEach((x) => { x.disabled = true; });
        try {
          const r = await comEspera(b, () => api(`empresas/${empresaId}/whatsapp/sincronizar`, { method: 'POST', body: { dias: Number(b.dataset.dias) } }), 'Buscando…');
          fechar();
          aviso(r.importadas ? `${r.importadas} mensagem(ns) recuperada(s) em ${r.conversas} conversa(s).` : 'Tudo certo: nenhuma mensagem faltando.');
          aoTerminar?.();
        } catch (err) {
          $$('[data-dias]', modal).forEach((x) => { x.disabled = false; });
          aviso(err.message, true);
        }
      };
    });
  });
}

// "Desligar o modo teste" direto das faixas de aviso (Início e Conversas)
document.addEventListener('click', async (e) => {
  const botao = e.target.closest?.('[data-desligar-teste]');
  if (!botao) return;
  e.preventDefault();
  try {
    await comEspera(botao, () => api(`empresas/${encodeURIComponent(botao.dataset.desligarTeste)}/whatsapp`, { method: 'PUT', body: { modoTeste: false } }), '…');
    aviso('Modo teste desligado: a IA responde todos os clientes.');
    rotear();
  } catch (err) { aviso(err.message, true); }
});

// Transcrever áudio na hora (a IA só transcreve sozinha quando vai responder, para economizar)
document.addEventListener('click', async (e) => {
  const botao = e.target.closest?.('[data-entender]');
  if (!botao) return;
  e.preventDefault();
  try {
    const r = await comEspera(botao, () => api(`leads/${encodeURIComponent(botao.dataset.lead)}/anexos/${encodeURIComponent(botao.dataset.entender)}/entender`, { method: 'POST', body: {} }), 'Transcrevendo…');
    const nota = document.createElement('span');
    nota.className = 'anexo-nota';
    nota.textContent = `📝 ${r.anexo.transcricao || r.anexo.descricao || ''}`;
    botao.replaceWith(nota);
  } catch (err) { aviso(err.message, true); }
});

// Apagar mensagem: "para todos" (sai do WhatsApp do cliente) ou "só no CRM"
document.addEventListener('click', (e) => {
  const botao = e.target.closest?.('[data-msg-menu]');
  if (!botao) return;
  e.preventDefault();
  e.stopPropagation();
  const { msgMenu: msgId, lead: leadId } = botao.dataset;
  const paraTodos = botao.dataset.todos === '1';
  const doCliente = botao.dataset.cliente === '1';
  abrirModal(`
    <h2>Apagar mensagem?</h2>
    <div class="opcoes-apagar">
      ${paraTodos ? '<button type="button" class="perigo" data-opcao="todos">🗑️ Apagar para todos<small>Some também do WhatsApp do cliente</small></button>' : ''}
      <button type="button" data-opcao="crm">Apagar só aqui no CRM<small>${doCliente ? 'Mensagem do cliente: some do painel e a IA deixa de ler. No celular dele continua.' : paraTodos ? 'O cliente continua vendo no WhatsApp dele' : 'Sai do painel e a IA deixa de ler'}</small></button>
      <button type="button" data-fechar>Cancelar</button>
    </div>
    ${!paraTodos && !doCliente ? '<p class="rotulo">"Apagar para todos" só aparece em mensagens enviadas pelo WhatsApp há menos de 2 dias (limite do WhatsApp).</p>' : ''}`, (modal, fechar) => {
    $$('[data-opcao]', modal).forEach((b) => {
      b.onclick = async () => {
        try {
          await comEspera(b, () => api(`leads/${encodeURIComponent(leadId)}/mensagens/${encodeURIComponent(msgId)}`, { method: 'DELETE', body: { paraTodos: b.dataset.opcao === 'todos' } }));
          fechar();
          aviso(b.dataset.opcao === 'todos' ? 'Mensagem apagada para todos.' : 'Mensagem apagada do CRM.');
          botao.dispatchEvent(new CustomEvent('mensagem-apagada', { bubbles: true }));
        } catch (err) { aviso(err.message, true); }
      };
    });
  });
});

// A conversa inteira, com o separador de dia do WhatsApp
// "sáb. 03/10 às 09:00" — agendamentos sempre no horário de Brasília
function quandoBrasilia(iso, comDia = true) {
  const d = new Date(iso);
  const f = (o) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...o });
  return `${comDia ? `${f({ weekday: 'short' })} ` : ''}${f({ day: '2-digit', month: '2-digit' })} às ${f({ hour: '2-digit', minute: '2-digit' })}`;
}

// Aviso no meio da conversa: VENDA CONCLUÍDA ou AGENDADO
function htmlTicket(t) {
  const quando = (iso) => quandoBrasilia(iso);
  const hora = new Date(t.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (t.tipo === 'venda') {
    const quem = t.origem === 'ia' ? `entendida pela IA${t.forma === 'Dinheiro' ? ' · recebida em dinheiro' : ''}` : t.origem === 'comprovante' ? `comprovante ${esc(t.forma || 'Pix')}` : `registrada pela equipe${t.forma ? ` · ${esc(t.forma)}` : ''}`;
    return `<div class="wa-ticket venda${t.status === 'conferir' ? ' conferir' : ''}" role="note">
      <span class="ticket-icone" aria-hidden="true">✅</span>
      <div class="ticket-corpo"><b>VENDA CONCLUÍDA</b><span class="ticket-info">${t.valor ? brl(t.valor) : 'valor a informar'}${t.descricao ? ` · ${esc(t.descricao)}` : ''}</span>
      <small>${quem} · ${hora}${t.status === 'conferir' ? ' · <span class="ticket-conferir">a conferir no Faturamento</span>' : ''}</small></div>
    </div>`;
  }
  const cancelado = t.status === 'cancelado' || t.status === 'remarcado';
  const QUEM = { ia: 'marcado pela IA', cliente: 'o cliente confirmou na conversa', etiqueta: `🏷️ etiqueta Agendado no WhatsApp${t.detectadoPor === 'ia' ? ' (a IA achou o horário na conversa)' : ''}`, detectado: `✨ percebido na conversa${t.detectadoPor === 'ia' ? ' pela IA' : ''}` };
  const QUEM_CANCELOU = { ia: 'a IA desmarcou', detectado: 'desmarcado na conversa', equipe: 'cancelado pela equipe' };
  const concluido = t.status === 'concluido';
  const titulo = t.status === 'remarcado' ? 'HORÁRIO TROCADO' : cancelado ? 'AGENDAMENTO CANCELADO' : concluido ? 'AGENDAMENTO CONCLUÍDO (VENDA)' : 'AGENDADO';
  return `<div class="wa-ticket agendamento${cancelado ? ' cancelado' : ''}" role="note">
    <span class="ticket-icone" aria-hidden="true">${cancelado ? '🗓️' : '📅'}</span>
    <div class="ticket-corpo"><b>${titulo}</b><span class="ticket-info">${t.quando ? esc(quando(t.quando)) : esc(t.quandoTexto || 'data a combinar')}${t.descricao ? ` · ${esc(t.descricao)}` : ''}</span>
    ${!cancelado && t.trecho ? `<span class="ticket-trecho">“${esc(t.trecho)}”</span>` : ''}
    <small>${cancelado ? esc(QUEM_CANCELOU[t.canceladoPor] || 'cancelado') + (t.motivoCancelamento && !/^(remarcado|cancelado pela equipe)$/.test(t.motivoCancelamento) ? ` · ${esc(t.motivoCancelamento)}` : '') : esc(QUEM[t.por] || 'marcado pela equipe')} · ${hora}${cancelado || concluido ? '' : ` · <button type="button" class="link-botao" data-cancelar-ag="${esc(t.id)}" data-detectado="${t.por === 'detectado' ? '1' : ''}">${t.por === 'detectado' ? 'não era isso, desfazer' : 'cancelar'}</button>`}</small></div>
  </div>`;
}

function htmlConversa(mensagens, leadId, tickets = []) {
  let dia = '';
  let anterior = null;
  let html = '';
  const fila = [...(tickets || [])].sort((a, b) => (a.em < b.em ? -1 : 1));
  const separador = (em) => {
    const d = diaDaMensagem(em);
    if (d !== dia) {
      html += `<div class="wa-dia">${esc(d)}</div>`;
      dia = d;
      anterior = null;
    }
  };
  const avisosAte = (em) => {
    while (fila.length && (!em || fila[0].em <= em)) {
      const t = fila.shift();
      separador(t.em);
      html += htmlTicket(t);
      anterior = null;
    }
  };
  for (const m of mensagens) {
    avisosAte(m.em);
    separador(m.em);
    html += htmlMensagem(m, leadId, anterior);
    anterior = m;
  }
  avisosAte(null);
  return html;
}

// ---------------------------------------------------------------- cronômetro dos próximos envios
// "2d 03:12:45" / "03:12:45" / "enviando…". Um relógio só atualiza todos da tela.
function textoContagem(iso, curto = false) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'enviando…';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  const dois = (n) => String(n).padStart(2, '0');
  if (curto) return d ? `${d}d ${h}h` : h ? `${h}h ${dois(m)}m` : `${m}m ${dois(seg)}s`;
  return `${d ? `${d}d ` : ''}${dois(h)}:${dois(m)}:${dois(seg)}`;
}

let relogioContagem = null;
function ligarRelogio() {
  if (relogioContagem) return;
  relogioContagem = setInterval(() => {
    for (const el of document.querySelectorAll('[data-contagem]')) el.textContent = textoContagem(el.dataset.contagem, el.dataset.curto === '1');
  }, 1000);
}

// Faixa na conversa: o que vai sair para o cliente e quando (com cronômetro)
function htmlProximos(l) {
  const lista = l.proximosEnvios || [];
  if (!lista.length) return '';
  return `<div class="proximos-envios">${lista.map((p) => `
    <div class="proximo ${p.porIa ? 'por-ia' : ''}" title="${esc(new Date(p.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}">
      <span class="relogio">⏳</span>
      <b class="contagem" data-contagem="${esc(p.quando)}">${textoContagem(p.quando)}</b>
      <span class="proximo-texto"><b>${esc(p.titulo)}</b>${p.detalhe ? ` · <span class="rotulo">${esc(p.detalhe.slice(0, 90))}</span>` : ''} <span class="rotulo">(${esc(new Date(p.quando).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))})</span></span>
      <button type="button" class="link-botao" ${p.tipo === 'agendada' ? `data-cancelar="${esc(p.id)}"` : `data-pular-automacao="${esc(p.id)}"`}>${p.tipo === 'agendada' ? 'cancelar' : 'não enviar'}</button>
    </div>`).join('')}</div>`;
}

function ligarProximos(raiz, leadId, depois) {
  ligarRelogio();
  $$('[data-cancelar]', raiz).forEach((b) => {
    b.onclick = async () => {
      await api(`leads/${leadId}/agendadas/${b.dataset.cancelar}`, { method: 'DELETE' }).catch((err) => aviso(err.message, true));
      aviso('Envio cancelado.');
      depois?.();
    };
  });
  $$('[data-pular-automacao]', raiz).forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar({ titulo: 'Não enviar para este cliente?', texto: 'Esta automação não vai mais mandar mensagem para este cliente. As outras continuam.', botao: 'Não enviar' }))) return;
      await api(`leads/${leadId}/pular-automacao`, { method: 'POST', body: { regraId: b.dataset.pularAutomacao } }).catch((err) => aviso(err.message, true));
      depois?.();
    };
  });
}

// É a etapa de "vendeu"? (Vendi, Fechado, Ganho…)
const ehEtapaDeVenda = (e) => /fechad|ganh|vendi/i.test(String(e || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

// ✅ Venda concluída: pede o valor (lança a venda no Faturamento) e o que fazer
// com os pedidos de avaliação no Google e de comentário no anúncio.
// Resolve true se concluiu, false se cancelou.
async function modalVendaConcluida(leadId, empresaId) {
  const [l, cat] = await Promise.all([api(`leads/${leadId}`), api(`empresas/${empresaId}/catalogo`).catch(() => ({ itens: [] }))]);
  const itens = (cat.itens || []).filter((x) => x.ativo && x.preco != null);
  const pv = l.posVenda || {};
  const ja = l.ultimaVenda && l.ultimaVenda.status !== 'conferir' && l.ultimaVenda.valor > 0;
  const linhaPedido = (tipo, titulo, ondeLink) => {
    const p = pv[tipo] || {};
    const dias = p.horas != null ? (p.horas >= 24 ? `${Math.round(p.horas / 24)} dia(s)` : `${p.horas} h`) : '';
    const padrao = p.jaPedido ? 'nao' : p.automatica ? 'auto' : p.link ? 'agora' : 'nao';
    const op = (v, rotulo, ok = true, dica = '') => `<label class="op-pedido ${ok ? '' : 'desabilitada'}" ${dica ? `title="${esc(dica)}"` : ''}><input type="radio" name="p-${tipo}" value="${v}" ${v === padrao ? 'checked' : ''} ${ok ? '' : 'disabled'}><span>${rotulo}</span></label>`;
    return `<div class="linha-pedido"><div><b>${titulo}</b>${p.jaPedido ? `<span class="rotulo"> · já pedido em ${esc(data(p.jaPedido))}</span>` : ''}${!p.link ? `<span class="rotulo"> · sem link salvo (<a href="${rotaEmpresa(empresaId, 'automacoes')}">${ondeLink}</a>)</span>` : ''}</div>
      <div class="ops-pedido">${op('agora', 'Mandar agora', p.link, p.link ? '' : 'Salve o link na Máquina de vendas')}${op('auto', p.automatica ? `Automático em ${dias}` : 'Automático (desligado)', p.automatica && p.link, p.automatica ? '' : 'Ligue a automação na Máquina de vendas')}${op('nao', 'Não mandar')}</div></div>`;
  };
  return new Promise((resolve) => {
    let feito = false;
    const fechar = abrirModal(`
      <h2>✅ Venda concluída${l.nome ? ` — ${esc(l.nome)}` : ''}</h2>
      <form id="f-concluir">
        ${ja ? `<p class="caixa-ok">Venda já lançada: <b>${brl(l.ultimaVenda.valor)}</b>${l.ultimaVenda.descricao ? ` · ${esc(l.ultimaVenda.descricao)}` : ''} (${esc(data(l.ultimaVenda.data))}).</p>` : `
        <p class="rotulo" style="margin-top:-4px">A venda entra no Faturamento na hora, igual à venda automática.</p>
        ${itens.length ? `<div class="campo"><label>O que foi vendido</label><select id="conc-item"><option value="">— escolher do catálogo —</option>${itens.map((x) => `<option value="${esc(x.id)}">${esc(x.nome)} · ${brl(x.preco)}</option>`).join('')}</select></div>` : ''}
        <div class="campos" style="margin-top:10px">
          <div class="campo"><label>Valor (R$) *</label><input name="valor" required inputmode="decimal" placeholder="350,00" value="${l.ultimaVenda?.valor ? esc(String(l.ultimaVenda.valor).replace('.', ',')) : ''}"></div>
          <div class="campo"><label>Forma de pagamento</label><select name="forma">${['Pix', 'Dinheiro', 'Cartão', 'Boleto', 'Transferência', 'Outro'].map((f) => `<option>${f}</option>`).join('')}</select></div>
          <div class="campo largo"><label>Descrição (opcional)</label><input name="descricao" maxlength="200" value="${esc(l.ultimaVenda?.descricao || '')}" placeholder="Ex.: o que foi vendido"></div>
        </div>`}
        <h3 style="margin:16px 0 6px">Depois da venda</h3>
        ${l.noWhatsapp === false ? '<p class="rotulo">Este cliente não tem WhatsApp: os pedidos não podem ser enviados.</p>' : `${linhaPedido('avaliacao', '⭐ Avaliação no Google', 'salvar o link')}${linhaPedido('comentario', '💬 Comentário no anúncio', 'salvar o link')}`}
        <div class="acoes"><button type="submit" class="primario">Concluir venda</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (m, fecharModal) => {
      $('#conc-item', m)?.addEventListener('change', (e) => {
        const x = itens.find((i) => i.id === e.target.value);
        if (!x) return;
        m.querySelector('[name=valor]').value = Number(x.preco).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        m.querySelector('[name=descricao]').value = x.nome;
      });
      new MutationObserver((_, obs) => { if (!m.isConnected) { obs.disconnect(); if (!feito) resolve(false); } }).observe(document.body, { childList: true });
      $('#f-concluir', m).onsubmit = async (e) => {
        e.preventDefault();
        const f = formParaObjeto(e.target);
        const pedidos = {};
        for (const t of ['avaliacao', 'comentario']) { const r = m.querySelector(`[name=p-${t}]:checked`); if (r) pedidos[t] = r.value; }
        try {
          const r = await comEspera(e.submitter, () => api(`leads/${leadId}/venda-concluida`, { method: 'POST', body: { concluida: true, ...(ja ? {} : { valor: f.valor, forma: f.forma, descricao: f.descricao }), pedidos } }), 'Concluindo…');
          feito = true;
          fecharModal();
          const partes = [r.venda ? `Venda de ${brl(r.venda.valor)} lançada` : 'Venda concluída'];
          for (const [t, nome] of [['avaliacao', 'avaliação'], ['comentario', 'comentário']]) {
            if (r.pedidos?.[t] === 'enviado') partes.push(`pedido de ${nome} enviado`);
            else if (/^não enviado/.test(r.pedidos?.[t] || '')) partes.push(`${nome}: ${r.pedidos[t]}`);
          }
          aviso(`${partes.join(' · ')}.`, Object.values(r.pedidos || {}).some((x) => /^não enviado/.test(x)));
          resolve(true);
        } catch (err) { aviso(err.message, true); }
      };
    });
    void fechar;
  });
}

// Depois da venda: botões para pedir a avaliação do Google e o comentário no anúncio
function htmlPedidos(l) {
  const vendeu = l.vendaConcluida || (l.tickets || []).some((t) => t.tipo === 'venda');
  if (!vendeu || !l.podeReceber) return '';
  const botao = (tipo, rotulo, temLink) => {
    const ja = l.pedidos?.[tipo];
    return `<button type="button" class="pequeno ${ja ? '' : 'primario'}" data-pedido="${tipo}" ${temLink ? '' : 'title="Salve o link na Máquina de vendas"'}>${rotulo}</button>${ja ? `<span class="rotulo">✓ já pedido ${esc(data(ja))}</span>` : ''}`;
  };
  return `<div class="chat-pedidos">✅ <b>Venda concluída.</b> ${botao('avaliacao', '⭐ Pedir avaliação no Google', l.temLinkAvaliacao)} ${botao('comentario', '💬 Pedir comentário no anúncio', l.temLinkAnuncio)}</div>`;
}

function ligarPedidos(raiz, l, depois) {
  $$('[data-pedido]', raiz).forEach((b) => {
    b.onclick = async () => {
      const tipo = b.dataset.pedido;
      const nome = tipo === 'avaliacao' ? 'a avaliação no Google' : 'o comentário no anúncio';
      let forcar = false;
      if (l.pedidos?.[tipo]) {
        if (!(await confirmar({ titulo: 'Já foi pedido', texto: `Este cliente já recebeu o pedido d${tipo === 'avaliacao' ? 'a avaliação' : 'o comentário'} em ${data(l.pedidos[tipo])}. Mandar de novo?`, botao: 'Mandar de novo' }))) return;
        forcar = true;
      }
      try {
        await comEspera(b, () => api(`leads/${l.id}/pedido`, { method: 'POST', body: { tipo, forcar } }), 'Enviando…');
        aviso(`Pedido d${tipo === 'avaliacao' ? 'a avaliação' : 'o comentário'} enviado.`);
        depois?.();
      } catch (err) {
        aviso(err.status === 409 ? `Já foi pedido ${nome}.` : err.message, true);
      }
    };
  });
}

// Marcar agendamento pela equipe
function modalAgendamento(leadId, depois) {
  const amanha = new Date(Date.now() + 24 * 3600 * 1000);
  amanha.setHours(9, 0, 0, 0);
  const local = new Date(amanha.getTime() - amanha.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  abrirModal(`
    <h2>📅 Marcar agendamento</h2>
    <p class="rotulo" style="margin-top:-4px">Aparece como aviso na conversa. A IA também marca sozinha quando o cliente confirma dia e horário.</p>
    <form id="f-ag">
      <div class="campo"><label>Dia e horário</label><input type="datetime-local" name="quando" value="${local}" required></div>
      <div class="campo" style="margin-top:10px"><label>O que foi agendado</label><input name="descricao" maxlength="200" placeholder="Ex.: Avaliação, instalação, consulta"></div>
      <div class="acoes"><button class="primario" type="submit">Marcar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    $('#f-ag', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`leads/${leadId}/agendamentos`, { method: 'POST', body: formParaObjeto(e.target) });
        fechar();
        aviso('Agendamento marcado.');
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

function ligarCancelarAgendamento(raiz, leadId, depois) {
  $$('[data-cancelar-ag]', raiz).forEach((b) => {
    b.onclick = async () => {
      const desfazer = b.dataset.detectado === '1';
      if (!(await confirmar(desfazer
        ? { titulo: 'Desfazer este agendamento?', texto: 'O CRM tinha entendido que um horário foi combinado. Ele sai da agenda (o cliente não recebe nada).', botao: 'Desfazer' }
        : { titulo: 'Cancelar este agendamento?', texto: 'O aviso fica na conversa como cancelado e o lead sai de "Agendou". Se o aviso de agendamento estiver ligado, o número cadastrado recebe o cancelamento. O cliente não recebe nada automático.', botao: 'Cancelar agendamento', perigo: true }))) return;
      try {
        await api(`leads/${leadId}/agendamentos/${b.dataset.cancelarAg}`, { method: 'DELETE', body: { motivo: desfazer ? 'detectado por engano (desfeito)' : '' } });
        aviso(desfazer ? 'Desfeito.' : 'Agendamento cancelado.');
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- empresa: conversas (estilo WhatsApp Web)

function horaCurta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoje = new Date();
  return d.toDateString() === hoje.toDateString()
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function inicial(nome) {
  return esc((String(nome || '').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase());
}

// Foto de perfil do WhatsApp do cliente (ou a inicial, se ele não tem/esconde a foto)
function avatarLead(l, classe = '') {
  const letra = inicial(nomeDoLead(l));
  if (!l?.fotoUrl) return `<span class="avatar ${classe}">${letra}</span>`;
  return `<span class="avatar ${classe}"><img src="${esc(l.fotoUrl)}" alt="" loading="lazy" onerror="this.remove()"><span class="avatar-letra">${letra}</span></span>`;
}

// 📸 mídia sugerida pelo que o cliente disse/mostrou (foto, modelo, item)
function htmlSugestaoMidia(l) {
  const s = l.sugestaoMidia;
  if (!s?.itens?.length || !l.podeReceber) return '';
  return `<div class="sug-midia">
    <div class="sug-midia-topo"><b>📸 Sugestão para mandar${s.item ? ` · ${esc(s.item)}` : ''}</b><span class="rotulo">${s.por === 'ia' ? '✨ a IA olhou a conversa' : 'pelo que o cliente escreveu'}</span>${s.itens.length > 1 ? '<button type="button" class="pequeno" data-sug-tirar="">Dispensar todas</button>' : ''}</div>
    <div class="sug-midia-itens">${s.itens.map((x) => `
      <div class="sug-midia-item">
        ${x.capa ? `<img src="${esc(x.capa)}" alt="" loading="lazy">` : `<span class="sug-midia-icone">${x.tipo === 'album' ? '📁' : ICONE_TIPO[x.tipo] || '📎'}</span>`}
        <div class="sug-midia-txt"><b>${esc(x.nome)}</b><span class="rotulo">${esc(codMidia(x.codigo))}${x.tipo === 'album' ? ` · álbum, ${x.quantidade} arquivos` : ''}${x.motivo ? ` · ${esc(x.motivo)}` : ''}</span></div>
        <button type="button" class="pequeno primario" data-sug-enviar="${esc(x.codigo)}">Mandar</button>
        <button type="button" class="pequeno" data-sug-tirar="${esc(x.codigo)}" title="Não é essa" aria-label="Dispensar">✕</button>
      </div>`).join('')}</div>
  </div>`;
}

async function paginaConversas(id, params) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  let filtro = 'todas';
  let filtroEtiqueta = '';
  try { filtroEtiqueta = sessionStorage.getItem(`conv_etiqueta_${id}`) || ''; } catch { /* ok */ }
  if (filtroEtiqueta && !(emp.etiquetas || []).some((t) => t.id === filtroEtiqueta)) filtroEtiqueta = '';
  let busca = '';
  let abertoId = params.get('lead') || '';
  let lista = [];
  let leadAberto = null;
  let assinaturaAberta = '';

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho cab-conversas"><div><h1>Conversas</h1><p class="sub">Converse com seus clientes pelo computador — a IA atende junto com você</p></div>${emp.whatsapp?.configurado ? `<div class="barra"><span class="interruptor-topo" title="Quando você manda uma mensagem manual (painel ou celular), a IA para de responder aquele cliente">${interruptor('conv-ia-para-manual', !emp.whatsapp?.iaAposManual, 'IA para quando eu respondo')}</span><button type="button" id="buscar-mensagens" title="Traz do WhatsApp as mensagens que não apareceram aqui (ex.: depois de reconectar)">🔄 Buscar mensagens do WhatsApp</button></div>` : ''}</div>
    ${faixaPausada(emp)}
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp para conversar por aqui', `<a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    ${emp.whatsapp?.modoTeste ? `<p class="faixa-teste">🧪 Modo teste: a IA só responde ${esc((emp.whatsapp.numerosTeste || '').split(/,\s*/).filter(Boolean).map(telefoneBonito).join(', '))} · <button type="button" class="link-botao" data-desligar-teste="${esc(id)}">desligar</button></p>` : ''}
    <div class="inbox ${abertoId ? 'com-chat' : ''}" id="inbox">
      <aside class="inbox-lista">
        <div class="inbox-busca"><input id="busca-conversa" placeholder="🔎 Buscar nome, telefone ou mensagem"></div>
        <div class="inbox-filtros">
          <button type="button" class="chip-filtro ativo" data-filtro="todas">Todas</button>
          <button type="button" class="chip-filtro" data-filtro="naoLidas">Não lidas</button>
          <button type="button" class="chip-filtro" data-filtro="vendas">✅ Vendas concluídas</button>
          <button type="button" class="chip-filtro" data-filtro="iaAtiva" title="Conversas em que a IA está respondendo">🤖 IA ativa</button>
          <button type="button" class="chip-filtro" data-filtro="iaPausada" title="Conversas em que a IA está pausada (a equipe atende)">✋ IA pausada</button>
          <button type="button" class="chip-filtro" data-filtro="arquivadas" title="Arquivadas ou apagadas no WhatsApp">🗄️</button>
          <button type="button" class="chip-filtro" data-filtro="listaNegra" title="Lista negra: ninguém (nem a IA) manda nada para eles">🚫</button>
          <button type="button" class="chip-filtro" data-filtro="lixeira" title="Lixeira: conversas apagadas (dá para restaurar por 30 dias)">🗑️</button>
        </div>
        ${(emp.etiquetas || []).length ? `<div class="inbox-filtros filtro-etiquetas">${emp.etiquetas.map((t) => `<button type="button" class="chip-filtro" style="--cor:${esc(t.cor)}" data-fetiqueta="${esc(t.id)}" title="Só conversas com a etiqueta ${esc(t.nome)}"><span class="bolinha-cor"></span>${esc(t.nome)}</button>`).join('')}</div>` : ''}
        <div id="lista-conversas" class="lista-conversas"><p class="rotulo" style="padding:16px">Carregando…</p></div>
      </aside>
      <section class="inbox-chat" id="inbox-chat">
        <div class="inbox-vazio">${ICONES.leads}<p><b>Escolha uma conversa</b><br><span class="rotulo">As novas mensagens aparecem sozinhas.</span></p></div>
      </section>
    </div>`;

  function desenharLixeira(el) {
    el.innerHTML = `
      <div class="lixeira-topo"><span class="rotulo">🗑️ Ficam aqui por 30 dias e depois somem de vez. O WhatsApp do celular não é mexido.</span>${lista.length ? '<button type="button" class="pequeno perigo" id="esvaziar-lixeira">Esvaziar lixeira</button>' : ''}</div>
      ${lista.length ? lista.map((c) => `
        <div class="item-conversa item-lixeira">
          ${avatarLead(c)}
          <span class="item-meio">
            <span class="item-linha"><strong>${esc(nomeDoLead(c))}</strong><span class="rotulo item-hora">apagada ${horaCurta(c.apagadaEm)}</span></span>
            <span class="item-linha"><span class="rotulo item-previa">${c.ultimaMensagem ? esc(c.ultimaMensagem.texto) : ''}</span></span>
            <span class="item-linha item-tags"><span class="etiqueta off">some em ${c.diasRestantes} ${c.diasRestantes === 1 ? 'dia' : 'dias'}</span><span class="acoes-lixeira"><button type="button" class="pequeno" data-restaurar="${esc(c.id)}">↩️ Restaurar</button><button type="button" class="pequeno perigo" data-apagar-vez="${esc(c.id)}">Apagar de vez</button></span></span>
          </span>
        </div>`).join('') : '<p class="rotulo" style="padding:16px">A lixeira está vazia.</p>'}`;
    $$('[data-restaurar]', el).forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await comEspera(b, () => api(`lixeira/${b.dataset.restaurar}/restaurar`, { method: 'POST', body: {} }));
          aviso(r.juntou ? 'Conversa restaurada e juntada com a conversa nova desse cliente.' : 'Conversa restaurada.');
          carregarLista();
        } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-apagar-vez]', el).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmar({ titulo: 'Apagar de vez?', texto: 'A conversa, as fotos, áudios e arquivos dela somem para sempre. As vendas continuam no Faturamento.', botao: 'Apagar de vez', perigo: true }))) return;
        try {
          await api(`lixeira/${b.dataset.apagarVez}`, { method: 'DELETE', body: {} });
          aviso('Apagada para sempre.');
          carregarLista();
        } catch (err) { aviso(err.message, true); }
      };
    });
    $('#esvaziar-lixeira')?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Esvaziar a lixeira?', texto: `${lista.length} ${lista.length === 1 ? 'conversa some' : 'conversas somem'} para sempre, com fotos, áudios e arquivos. As vendas continuam no Faturamento.`, botao: 'Esvaziar', perigo: true }))) return;
      try {
        await api(`empresas/${id}/lixeira`, { method: 'DELETE', body: {} });
        aviso('Lixeira esvaziada.');
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    });
  }

  // 🗑️ manda a conversa para a lixeira (com confirmação)
  async function apagarConversa(leadId) {
    const c = lista.find((x) => x.id === leadId) || leadAberto;
    if (!(await confirmar({ titulo: 'Apagar esta conversa?', texto: `A conversa com <b>${esc(nomeDoLead(c || {}))}</b> vai para a Lixeira (🗑️) e pode ser restaurada por 30 dias. Mensagens agendadas para ela são canceladas. O WhatsApp do celular não é mexido.`, botao: 'Apagar', perigo: true }))) return;
    try {
      await api(`leads/${leadId}`, { method: 'DELETE', body: {} });
      aviso('Conversa na lixeira.');
      if (abertoId === leadId) {
        abertoId = '';
        leadAberto = null;
        $('#inbox')?.classList.remove('com-chat');
        history.replaceState(null, '', rotaEmpresa(id, 'conversas'));
        const area = $('#inbox-chat');
        if (area) area.innerHTML = `<div class="inbox-vazio">${ICONES.leads}<p><b>Conversa apagada</b><br><span class="rotulo">Está na Lixeira (🗑️) por 30 dias.</span></p></div>`;
      }
      carregarLista();
    } catch (err) { aviso(err.message, true); }
  }

  function desenharLista() {
    const el = $('#lista-conversas');
    if (!el) return;
    if (filtro === 'lixeira') return desenharLixeira(el);
    el.innerHTML = lista.length
      ? lista.map((c) => `
        <div class="item-conversa-caixa">
        <button type="button" class="apagar-conversa" data-apagar-conversa="${esc(c.id)}" title="Apagar conversa" aria-label="Apagar conversa">🗑️</button>
        <button type="button" class="item-conversa ${c.id === abertoId ? 'ativo' : ''}" data-lead="${esc(c.id)}">
          ${avatarLead(c)}
          <span class="item-meio">
            <span class="item-linha"><strong>${esc(nomeDoLead(c))}</strong><span class="rotulo item-hora">${horaCurta(c.ultimaEm)}</span></span>
            <span class="item-linha"><span class="rotulo item-previa">${c.ultimaMensagem ? `${c.ultimaMensagem.papel === 'visitante' ? '' : c.ultimaMensagem.papel === 'equipe' ? 'Você: ' : 'IA: '}${esc(c.ultimaMensagem.texto)}` : ''}</span>${c.naoLidas ? `<span class="bolha-nao-lida">${c.naoLidas}</span>` : ''}</span>
            <span class="item-linha item-tags">${c.proximoEnvio ? `<span class="etiqueta ticket-chip contagem-chip" title="${esc(c.proximoEnvio.titulo)}">⏳ <span data-contagem="${esc(c.proximoEnvio.quando)}" data-curto="1">${textoContagem(c.proximoEnvio.quando, true)}</span></span>` : ''}${c.destaque?.tipo === 'agendamento' ? `<span class="etiqueta ticket-chip ag">📅 ${esc(quandoBrasilia(c.destaque.quando, false))}</span>` : c.destaque?.tipo === 'venda' ? '<span class="etiqueta ticket-chip venda">✅ Venda</span>' : ''}${c.precisaHumano ? '<span class="etiqueta off">esperando você</span>' : c.iaPausada ? '<span class="etiqueta">IA pausada</span>' : ''}${chipLocal(c)}${chipsDoLead(c, emp.etiquetas)}</span>
          </span>
        </button>
        </div>`).join('')
      : `<p class="rotulo" style="padding:16px">${filtro === 'listaNegra' ? 'Ninguém na lista negra.' : busca || filtro !== 'todas' || filtroEtiqueta ? 'Nada encontrado.' : 'Nenhuma conversa ainda.'}</p>`;
    $$('.item-conversa', el).forEach((b) => { b.onclick = () => abrir(b.dataset.lead); });
    $$('[data-apagar-conversa]', el).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); apagarConversa(b.dataset.apagarConversa); }; });
    ligarRelogio();
  }

  async function carregarLista() {
    if (filtro === 'lixeira') {
      const b = busca.toLowerCase();
      lista = (await api(`empresas/${id}/lixeira`)).filter((c) => !b || [c.nome, c.telefone, c.ultimaMensagem?.texto].join(' ').toLowerCase().includes(b));
    } else {
      lista = await api(`empresas/${id}/conversas?${new URLSearchParams({ filtro, busca, etiqueta: filtroEtiqueta })}`);
    }
    desenharLista();
  }

  function desenharChat() {
    const l = leadAberto;
    const area = $('#inbox-chat');
    if (!area || !l) return;
    area.innerHTML = `
      <header class="chat-topo">
        <button type="button" class="pequeno voltar-lista" id="voltar-lista" aria-label="Voltar">←</button>
        ${l.fotoUrl ? `<a href="${esc(l.fotoUrl)}" target="_blank" rel="noopener" title="Ver a foto">${avatarLead(l)}</a>` : avatarLead(l)}
        <div class="chat-quem"><a class="chat-nome" href="#/leads/${esc(l.id)}" title="Ver o perfil do lead"><strong>${esc(nomeDoLead(l))}</strong></a><span class="rotulo">${esc(telefoneBonito(l.telefone)) || (l.noWhatsapp ? 'número oculto pelo WhatsApp' : 'sem WhatsApp')}</span>${l.local?.texto ? `<span class="rotulo chat-local" title="Localização: ${esc(l.local.origem || '')}">📍 ${esc(l.local.texto)}</span>` : ''}</div>
        <select id="chat-etapa" title="Etapa do funil">${l.etapas.map((e) => `<option ${e === l.etapa ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
        ${interruptor('chat-ia', !l.iaPausada, 'IA')}
        ${l.noWhatsapp ? `<span title="Follow-up automático deste cliente (mensagens prontas, sem IA)">${interruptor('chat-fup', !l.followupDesligado, '🔁 Follow-up')}</span>` : ''}
        <span class="chat-acoes"><button type="button" class="pequeno ${l.vendaConcluida ? 'primario' : ''}" id="chat-concluida" title="${l.vendaConcluida ? 'Tirar de Vendas concluídas' : 'Mover para a aba Vendas concluídas'}">${l.vendaConcluida ? '✅ Venda concluída' : '✅ Mover para Vendas concluídas'}</button>
        <button type="button" class="pequeno" id="chat-arquivar" title="${l.arquivado ? 'Voltar para a lista' : 'Arquivar aqui e no WhatsApp do celular'}">${l.arquivado ? '📤 Desarquivar' : '🗄️ Arquivar'}</button>
        <button type="button" class="pequeno ${l.listaNegra ? 'primario' : ''}" id="chat-lista-negra" title="${l.listaNegra ? 'Tirar da lista negra' : 'Lista negra: ninguém (nem a IA) manda mais nada para este cliente'}">${l.listaNegra ? '✅ Desbloquear' : '🚫 Lista negra'}</button>
        <button type="button" class="pequeno perigo" id="chat-apagar" title="Apagar conversa (vai para a Lixeira por 30 dias)" aria-label="Apagar conversa">🗑️</button></span>
      </header>
      <div class="chat-etiquetas">🏷️ ${(l.etiquetas || []).map((tid) => emp.etiquetas.find((t) => t.id === tid)).filter(Boolean).map((t) => `<span class="chip-etq" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}<button type="button" class="x-chip" data-tirar-etq="${esc(t.id)}" title="Tirar etiqueta">✕</button></span>`).join('')}
        ${emp.etiquetas.some((t) => !(l.etiquetas || []).includes(t.id)) ? `<select id="chat-add-etq" class="pequeno-select"><option value="">+ etiqueta</option>${emp.etiquetas.filter((t) => !(l.etiquetas || []).includes(t.id)).map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select>` : ''}
        ${l.erroEtiquetaZap ? `<span class="rotulo aviso-texto" title="${esc(l.erroEtiquetaZap.msg)}">⚠️ não consegui marcar no WhatsApp</span>` : ''}</div>
      ${l.listaNegra ? '<div class="chat-aviso perigo-aviso">🚫 <b>Na lista negra.</b> Nada é enviado para este cliente — nem pela IA, automações, follow-up, disparos ou por você. As mensagens dele continuam aparecendo aqui.</div>' : ''}
      ${l.arquivado ? `<div class="chat-aviso">🗄️ Conversa ${esc(l.arquivadoPor || 'arquivada')}. Se o cliente mandar mensagem, ela volta sozinha para a lista.</div>` : ''}
      ${linhaOrigem(l.origemSite)}
      ${htmlPedidos(l)}
      ${l.iaReiniciadaEm ? `<div class="chat-aviso">🔄 Aprendizado desta conversa reiniciado em ${esc(data(l.iaReiniciadaEm))}: a IA só lê as mensagens daqui para frente. <button type="button" class="link-botao" id="chat-reiniciar-desfazer">Desfazer</button></div>` : ''}
      ${l.precisaHumano ? `<div class="chat-aviso">👤 A IA chamou você para este cliente. Responda e depois devolva para a IA se quiser.</div>` : ''}
      ${l.iaStatus && l.iaStatus.tipo !== 'respondeu' && l.mensagens[l.mensagens.length - 1]?.papel === 'visitante' ? `<div class="chat-ia-status ${l.iaStatus.tipo}">🤖 <b>A IA não respondeu:</b> ${esc(l.iaStatus.motivo)}${l.iaPausada ? ' <button type="button" class="pequeno" id="devolver-ia">Devolver para a IA</button>' : emp.ativa === false && ehAdmin() ? ` <button type="button" class="pequeno" data-reativar="${esc(id)}">Reativar a empresa</button>` : ''}</div>` : ''}
      <div class="conversa chat-mensagens" id="chat-mensagens">${htmlConversa(l.mensagens, l.id, l.tickets) || '<p class="rotulo">Sem mensagens.</p>'}</div>
      ${htmlProximos(l)}
      ${htmlSugestaoMidia(l)}
      ${l.podeReceber ? `
      <form class="chat-envio" id="chat-envio">
        <div class="sugestoes-rapidas" id="sugestoes-rapidas" hidden></div>
        <div class="chat-ferramentas">
          <label class="botao pequeno" title="Enviar foto, vídeo, áudio ou PDF do computador">📎 Arquivo<input type="file" id="chat-arquivo" hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label>
          <button type="button" class="pequeno" id="chat-biblioteca" title="Mídias e álbuns cadastrados">🖼️ Mídias</button>
          <button type="button" class="pequeno" id="chat-rapidas" title="Respostas prontas (ou digite /)">⚡ Respostas</button>
          <button type="button" class="pequeno" id="chat-sugerir" title="A IA escreve uma sugestão para você revisar">✨ Sugerir com IA</button>
          <button type="button" class="pequeno" id="chat-reiniciar-ia" title="A IA esquece o que leu desta conversa e começa do zero a partir da próxima mensagem">🔄 Reiniciar aprendizado da conversa</button>
          <button type="button" class="pequeno" id="chat-agendar" title="Mandar uma mensagem mais tarde">🕒 Mandar depois</button>
          ${l.vendaConcluida ? '<button type="button" class="pequeno" id="chat-venda" title="Lançar outra venda deste cliente (compra repetida)">➕ Outra venda</button>' : ''}
          <button type="button" class="pequeno" id="chat-agendamento" title="Marcar agendamento com o cliente">📅 Agendamento</button>
        </div>
        <div class="rapida-pendente" id="rapida-pendente" hidden></div>
        <div class="chat-linha">
          <textarea id="chat-texto" rows="1" placeholder="Escreva uma mensagem… (Enter envia, / para respostas prontas)"></textarea>
          <button class="primario" type="submit" id="chat-enviar">Enviar</button>
        </div>
        <label class="linha-check rotulo manter-ia"><input type="checkbox" id="chat-manter-ia" ${emp.whatsapp?.iaAposManual ? 'checked' : ''}> Deixar a IA continuar atendendo depois da minha mensagem</label>
      </form>` : '<p class="rotulo" style="padding:12px 16px">Este lead não tem WhatsApp. Coloque o telefone no lead para conversar.</p>'}`;
    const caixa = $('#chat-mensagens');
    caixa.scrollTop = caixa.scrollHeight;
    ligarChat();
  }

  async function abrir(leadId, rolar = true) {
    abertoId = leadId;
    $('#inbox')?.classList.add('com-chat');
    desenharLista();
    history.replaceState(null, '', `${rotaEmpresa(id, 'conversas')}?lead=${encodeURIComponent(leadId)}`);
    leadAberto = await api(`leads/${leadId}`);
    assinaturaAberta = `${leadAberto.mensagens.length}|${leadAberto.atualizadoEm}|${leadAberto.tickets?.length || 0}|${leadAberto.mensagens.filter((m) => m.apagada).length}|${leadAberto.listaNegra}|${(leadAberto.etiquetas || []).join()}|${leadAberto.erroEtiquetaZap?.em || ''}|${leadAberto.sugestaoMidia?.itens.map((x) => x.codigo).join() || ''}`;
    if (rolar) desenharChat();
    if (leadAberto.naoLidas) {
      api(`leads/${leadId}/lido`, { method: 'POST' }).catch(() => {});
      const item = lista.find((c) => c.id === leadId);
      if (item) item.naoLidas = 0;
      desenharLista();
    }
  }

  async function recarregarAberto() {
    if (!abertoId) return;
    const l = await api(`leads/${abertoId}`);
    const assinatura = `${l.mensagens.length}|${l.atualizadoEm}|${l.tickets?.length || 0}|${l.mensagens.filter((m) => m.apagada).length}|${l.listaNegra}|${(l.etiquetas || []).join()}|${l.erroEtiquetaZap?.em || ''}|${l.sugestaoMidia?.itens.map((x) => x.codigo).join() || ''}`;
    if (assinatura === assinaturaAberta) return;
    // não apaga o que a pessoa está digitando
    const rascunho = $('#chat-texto')?.value || '';
    const foco = document.activeElement?.id === 'chat-texto';
    leadAberto = l;
    assinaturaAberta = assinatura;
    desenharChat();
    if ($('#chat-texto')) {
      $('#chat-texto').value = rascunho;
      if (foco) $('#chat-texto').focus();
    }
    if (l.naoLidas) api(`leads/${abertoId}/lido`, { method: 'POST' }).catch(() => {});
  }

  async function enviarTexto(textoMsg) {
    const botao = $('#chat-enviar');
    await comEspera(botao, () => api(`leads/${abertoId}/mensagem`, { method: 'POST', body: { texto: textoMsg, manterIa: $('#chat-manter-ia')?.checked } }), '…');
    await recarregarAberto();
    carregarLista();
  }

  function ligarChat() {
    $('#chat-apagar')?.addEventListener('click', () => apagarConversa(abertoId));
    $('#chat-lista-negra')?.addEventListener('click', async (e) => {
      const por = !leadAberto.listaNegra;
      if (por && !(await confirmar({ titulo: 'Pôr na lista negra?', texto: `<b>${esc(nomeDoLead(leadAberto))}</b> não recebe mais nada: nem IA, automações, follow-up, disparos ou mensagens da equipe. Mensagens agendadas são canceladas. Dá para desfazer quando quiser.`, botao: '🚫 Pôr na lista negra', perigo: true }))) return;
      try {
        await comEspera(e.target, () => api(`leads/${abertoId}/lista-negra`, { method: por ? 'POST' : 'DELETE', body: {} }));
        aviso(por ? 'Cliente na lista negra.' : 'Cliente fora da lista negra.');
        await recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    });
    const salvarEtiquetas = async (nova) => {
      try {
        await api(`leads/${abertoId}`, { method: 'PUT', body: { etiquetas: nova } });
        await recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    };
    $('#chat-add-etq')?.addEventListener('change', (e) => { if (e.target.value) salvarEtiquetas([...(leadAberto.etiquetas || []), e.target.value]); });
    $$('[data-tirar-etq]').forEach((b) => { b.onclick = () => salvarEtiquetas((leadAberto.etiquetas || []).filter((t) => t !== b.dataset.tirarEtq)); });
    $('#chat-concluida')?.addEventListener('click', async (e) => {
      const concluir = !leadAberto.vendaConcluida;
      if (concluir) {
        if (await modalVendaConcluida(abertoId, id)) { assinaturaAberta = ''; await recarregarAberto(); carregarLista(); }
        return;
      }
      if (!(await confirmar({ titulo: 'Tirar de Vendas concluídas?', texto: 'A conversa volta para a lista normal (e para a etapa em que estava).', botao: 'Tirar' }))) return;
      try {
        await comEspera(e.currentTarget, () => api(`leads/${abertoId}/venda-concluida`, { method: 'POST', body: { concluida: concluir } }));
        aviso('Voltou para a lista de conversas.');
        assinaturaAberta = '';
        await recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    });
    $('#chat-arquivar')?.addEventListener('click', async (e) => {
      const arquivar = !leadAberto.arquivado;
      try {
        const r = await comEspera(e.target, () => api(`leads/${abertoId}/arquivar`, { method: 'POST', body: { arquivar } }));
        aviso(arquivar ? `Conversa arquivada${r.noCelular ? ' (no WhatsApp também)' : ''}.` : 'Conversa de volta na lista.');
        assinaturaAberta = '';
        await recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    });
    ligarPedidos($('#inbox-chat'), leadAberto, () => { assinaturaAberta = ''; recarregarAberto(); });
    ligarCancelarAgendamento($('#inbox-chat'), abertoId, () => { assinaturaAberta = ''; recarregarAberto(); carregarLista(); });
    $('#voltar-lista')?.addEventListener('click', () => {
      abertoId = '';
      $('#inbox').classList.remove('com-chat');
      history.replaceState(null, '', rotaEmpresa(id, 'conversas'));
      desenharLista();
    });
    $('#devolver-ia')?.addEventListener('click', async () => {
      try {
        await api(`leads/${abertoId}`, { method: 'PUT', body: { iaPausada: false } });
        aviso('A IA voltou a responder este cliente (a partir da próxima mensagem dele).');
        assinaturaAberta = '';
        recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    });
    $('#chat-etapa')?.addEventListener('change', async (e) => {
      if (ehEtapaDeVenda(e.target.value) && !leadAberto.vendaConcluida) {
        if (!(await modalVendaConcluida(abertoId, id))) e.target.value = leadAberto.etapa;
        assinaturaAberta = ''; await recarregarAberto(); carregarLista();
        return;
      }
      try {
        await api(`leads/${abertoId}`, { method: 'PUT', body: { etapa: e.target.value } });
        aviso('Etapa atualizada.');
      } catch (err) { aviso(err.message, true); }
    });
    $('#chat-ia')?.addEventListener('change', async (e) => {
      try {
        await api(`leads/${abertoId}`, { method: 'PUT', body: { iaPausada: !e.target.checked } });
        aviso(e.target.checked ? 'A IA voltou a responder este cliente.' : 'IA pausada: você atende este cliente.');
        recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    });
    $('#chat-reiniciar-ia')?.addEventListener('click', async (e) => {
      const botao = e.currentTarget; // depois do "confirmar" o evento já acabou
      if (!(await confirmar({ titulo: 'Reiniciar aprendizado da conversa?', texto: 'A IA <b>esquece tudo o que leu desta conversa</b> e começa do zero a partir da próxima mensagem (útil quando ela se confundiu ou guardou uma informação errada). O histórico continua aparecendo aqui para você, e o aprendizado diário relê esta conversa do zero.', botao: '🔄 Reiniciar' }))) return;
      try {
        await comEspera(botao, () => api(`leads/${abertoId}/reiniciar-aprendizado`, { method: 'POST', body: {} }));
        aviso('Pronto: a IA começa esta conversa do zero.');
        assinaturaAberta = '';
        recarregarAberto();
      } catch (err) { aviso(err.message, true); }
    });
    $('#chat-reiniciar-desfazer')?.addEventListener('click', async () => {
      try {
        await api(`leads/${abertoId}/reiniciar-aprendizado`, { method: 'POST', body: { desfazer: true } });
        aviso('A IA volta a ler a conversa inteira.');
        assinaturaAberta = '';
        recarregarAberto();
      } catch (err) { aviso(err.message, true); }
    });
    $('#chat-fup')?.addEventListener('change', async (e) => {
      try {
        await api(`leads/${abertoId}`, { method: 'PUT', body: { followupLigado: e.target.checked } });
        aviso(e.target.checked ? 'Follow-up ligado para este cliente.' : 'Follow-up desligado para este cliente.');
        assinaturaAberta = '';
        recarregarAberto();
      } catch (err) { e.target.checked = !e.target.checked; aviso(err.message, true); }
    });
    ligarProximos($('#inbox-chat'), abertoId, () => { assinaturaAberta = ''; recarregarAberto(); carregarLista(); });
    const form = $('#chat-envio');
    if (!form) return;
    const campo = $('#chat-texto');
    const ajustarAltura = () => { campo.style.height = 'auto'; campo.style.height = `${Math.min(160, campo.scrollHeight)}px`; };
    const caixaRapidas = $('#sugestoes-rapidas');
    // resposta pronta com mídia escolhida: vai junto quando clicar em Enviar
    let pendente = null;
    const mostrarPendente = () => {
      const el = $('#rapida-pendente');
      el.hidden = !pendente;
      el.innerHTML = pendente ? `⚡ <b>/${esc(pendente.atalho)}</b> vai com 📎 <b>${esc(pendente.midia)}</b> <button type="button" class="link-botao" id="tirar-pendente">tirar</button>` : '';
      $('#tirar-pendente')?.addEventListener('click', () => { pendente = null; mostrarPendente(); });
    };
    const escolherRapida = (r) => {
      campo.value = r.texto || '';
      pendente = r.midia ? r : null;
      mostrarPendente();
      caixaRapidas.hidden = true;
      ajustarAltura();
      campo.focus();
    };
    const mostrarRapidas = () => {
      const rapidas = emp.respostasRapidas || [];
      const m = campo.value.match(/^\/(\S*)$/);
      const achadas = m ? rapidas.filter((r) => r.atalho.includes(m[1].toLowerCase())).slice(0, 6) : [];
      caixaRapidas.hidden = !achadas.length;
      caixaRapidas.innerHTML = achadas.map((r) => `<button type="button" data-rapida="${esc(r.id)}"><b>/${esc(r.atalho)}</b> ${r.midia ? `📎 ${esc(r.midia)} · ` : ''}${esc((r.texto || '').slice(0, 80))}</button>`).join('');
      $$('[data-rapida]', caixaRapidas).forEach((b) => {
        b.onclick = () => escolherRapida(rapidas.find((r) => r.id === b.dataset.rapida));
      });
    };
    campo.addEventListener('input', () => { ajustarAltura(); mostrarRapidas(); });
    campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const t = campo.value.trim();
      if (pendente) {
        const r = pendente;
        try {
          await comEspera($('#chat-enviar'), () => api(`leads/${abertoId}/resposta-rapida`, { method: 'POST', body: { id: r.id, texto: t, manterIa: $('#chat-manter-ia')?.checked } }), 'Enviando…');
          campo.value = '';
          pendente = null;
          mostrarPendente();
          await recarregarAberto();
          carregarLista();
        } catch (err) { aviso(err.message, true); }
        return;
      }
      if (!t) return;
      try {
        campo.value = '';
        await enviarTexto(t);
      } catch (err) {
        campo.value = t;
        aviso(err.message, true);
      }
    };
    $('#chat-arquivo').onchange = async (e) => {
      const arquivo = e.target.files[0];
      e.target.value = '';
      if (!arquivo) return;
      if (arquivo.size > 200 * 1024 * 1024) return aviso(`"${arquivo.name}" tem ${(arquivo.size / 1048576).toFixed(0)} MB. O máximo é 200 MB — divida o vídeo em partes.`, true);
      const legenda = arquivo.type.startsWith('audio/') ? '' : campo.value.trim();
      const botao = $('#chat-enviar');
      const leadId = abertoId;
      try {
        let r;
        await comEspera(botao, async () => {
          // sobe em pedaços (arquivo grande, qualidade original) e depois manda pelo WhatsApp
          const ini = await api(`leads/${leadId}/arquivo/envio`, { method: 'POST', body: { arquivo: arquivo.name, tamanho: arquivo.size, tipo: arquivo.type || '' } });
          await subirEmPedacos(arquivo, ini, (pct) => { botao.innerHTML = `<span class="girando"></span> ${pct}%`; });
          botao.innerHTML = '<span class="girando"></span> Enviando…';
          r = await api(`leads/${leadId}/arquivo/envio/${ini.envioId}/concluir`, { method: 'POST', body: { legenda, manterIa: $('#chat-manter-ia')?.checked } });
        }, 'Enviando…');
        campo.value = '';
        aviso('Arquivo recebido. Enviando pelo WhatsApp na qualidade original — aparece ✓ quando chegar.');
        await recarregarAberto();
        carregarLista();
      } catch (err) { aviso(err.message, true); }
    };
    $('#chat-biblioteca').onclick = async () => {
      const lista = await api(`empresas/${id}/midias`);
      const avulsas = lista.filter((m) => !m.pastaId);
      const albuns = (emp.drivePastas || []).filter((p) => p.total);
      abrirModal(`
        <h2>Enviar da biblioteca</h2>
        ${!avulsas.length && !albuns.length ? `<p class="rotulo">Nenhuma mídia cadastrada. <a href="${rotaEmpresa(id, 'midias')}">Cadastrar mídias</a></p>` : ''}
        <div class="grade-escolha">
          ${albuns.map((p) => `<button type="button" class="escolha" data-nome="${esc(p.nome)}"><span class="escolha-icone">📁</span><b>${esc(p.nome)}</b><span class="rotulo">álbum · ${p.total} arquivos</span></button>`).join('')}
          ${avulsas.map((m) => `<button type="button" class="escolha" data-nome="${esc(m.nome)}">${m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="">` : `<span class="escolha-icone">${ICONE_TIPO[m.tipo] || '📎'}</span>`}<b>${esc(m.nome)}</b></button>`).join('')}
        </div>
        <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
        $$('[data-nome]', m).forEach((b) => {
          b.onclick = async () => {
            try {
              await comEspera(b, () => api(`leads/${abertoId}/midia`, { method: 'POST', body: { nome: b.dataset.nome } }), 'Enviando…');
              fechar();
              aviso('Enviado.');
              recarregarAberto();
            } catch (err) { aviso(err.message, true); }
          };
        });
      });
    };
    $$('[data-sug-enviar]').forEach((b) => {
      b.onclick = async () => {
        try {
          await comEspera(b, () => api(`leads/${abertoId}/midia`, { method: 'POST', body: { nome: b.dataset.sugEnviar } }), 'Enviando…');
          aviso('Enviado.');
          assinaturaAberta = '';
          recarregarAberto();
        } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-sug-tirar]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`leads/${abertoId}/sugestao-midia/dispensar`, { method: 'POST', body: { codigo: b.dataset.sugTirar } });
          assinaturaAberta = '';
          recarregarAberto();
        } catch (err) { aviso(err.message, true); }
      };
    });
    $('#chat-rapidas').onclick = () => modalRespostasRapidas(emp, escolherRapida);
    const recarregarJa = () => { assinaturaAberta = ''; recarregarAberto(); carregarLista(); };
    $('#chat-venda')?.addEventListener('click', () => modalVenda({ id }, null, abertoId, recarregarJa, { cliente: leadAberto.nome }));
    $('#chat-agendamento').onclick = () => modalAgendamento(abertoId, recarregarJa);
    $('#chat-sugerir').onclick = async (e) => {
      try {
        const r = await comEspera(e.currentTarget, () => api(`leads/${abertoId}/sugerir`, { method: 'POST', body: { pedido: campo.value.trim() } }), 'Pensando…');
        if (!r.texto) throw new Error('A IA não conseguiu escrever uma sugestão agora. Tente de novo.');
        campo.value = r.texto;
        ajustarAltura();
        campo.focus();
        aviso(r.midias?.length ? `Sugestão pronta — a IA também mandaria: ${r.midias.map((m) => `#${m}`).join(', ')} (use 🖼️ Mídias).` : 'Sugestão pronta — revise e clique em Enviar.');
      } catch (err) { aviso(err.message, true); }
    };
    $('#chat-agendar').onclick = () => {
      const amanha = new Date(Date.now() + 24 * 3600 * 1000);
      amanha.setHours(9, 0, 0, 0);
      const local = new Date(amanha.getTime() - amanha.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      abrirModal(`
        <h2>Agendar mensagem</h2>
        ${balao('Mande na hora certa', 'Ex.: lembrar do orçamento amanhã cedo, confirmar o horário na véspera, dar parabéns depois do serviço.')}
        <form id="f-agendar">
          <div class="campo"><label>Mensagem</label><textarea name="texto" required style="min-height:100px">${esc(campo.value)}</textarea></div>
          <div class="campo" style="margin-top:12px"><label>Quando</label><input type="datetime-local" name="quando" required value="${local}"></div>
          <div class="acoes"><button class="primario" type="submit">Agendar</button><button type="button" data-fechar>Cancelar</button></div>
        </form>`, (m, fechar) => {
        $('#f-agendar', m).onsubmit = async (ev) => {
          ev.preventDefault();
          const f = formParaObjeto(ev.target);
          try {
            await api(`leads/${abertoId}/agendar`, { method: 'POST', body: { texto: f.texto, quando: new Date(f.quando).toISOString() } });
            fechar();
            campo.value = '';
            aviso('Mensagem agendada.');
            assinaturaAberta = '';
            recarregarAberto();
          } catch (err) { aviso(err.message, true); }
        };
      });
    };
  }

  $$('[data-filtro]').forEach((b) => {
    b.onclick = () => {
      filtro = b.dataset.filtro;
      $$('[data-filtro]').forEach((x) => x.classList.toggle('ativo', x === b));
      carregarLista();
    };
  });
  // filtro por etiqueta (clicar de novo tira)
  $$('[data-fetiqueta]').forEach((b) => {
    b.onclick = () => {
      filtroEtiqueta = filtroEtiqueta === b.dataset.fetiqueta ? '' : b.dataset.fetiqueta;
      try { sessionStorage.setItem(`conv_etiqueta_${id}`, filtroEtiqueta); } catch { /* ok */ }
      $$('[data-fetiqueta]').forEach((x) => x.classList.toggle('ativo', x.dataset.fetiqueta === filtroEtiqueta));
      carregarLista();
    };
    b.classList.toggle('ativo', b.dataset.fetiqueta === filtroEtiqueta);
  });
  let espera = null;
  $('#busca-conversa').oninput = (e) => {
    clearTimeout(espera);
    espera = setTimeout(() => { busca = e.target.value.trim(); carregarLista(); }, 300);
  };

  await carregarLista();
  if (abertoId) await abrir(abertoId);
  const aqui = rotaEmpresa(id, 'conversas');
  $('#conv-ia-para-manual')?.addEventListener('change', (e) => trocarIaParaManual(id, e.target, () => {
    const caixa = $('#chat-manter-ia');
    if (caixa) caixa.checked = !e.target.checked; // a caixinha da conversa segue o novo padrão
    if (emp.whatsapp) emp.whatsapp.iaAposManual = !e.target.checked;
  }));
  $('#buscar-mensagens')?.addEventListener('click', () => modalSincronizar(id, () => { assinaturaAberta = ''; carregarLista(); recarregarAberto().catch(() => {}); }));
  // mensagem apagada no chat aberto: redesenha a conversa e a prévia da lista
  $('#inbox-chat').addEventListener('mensagem-apagada', () => {
    assinaturaAberta = '';
    recarregarAberto().catch(() => {});
    carregarLista().catch(() => {});
  });
  atualizador = setInterval(() => {
    if (!location.hash.startsWith(aqui)) return void clearInterval(atualizador);
    carregarLista().catch(() => {});
    recarregarAberto().catch(() => {});
  }, 4000);
}

async function modalRespostasRapidas(emp, aoEscolher) {
  let lista = (emp.respostasRapidas || []).map((r) => ({ ...r }));
  const [todas, albunsRr] = await Promise.all([api(`empresas/${emp.id}/midias`).catch(() => []), api(`empresas/${emp.id}/albuns`).catch(() => [])]);
  // a mídia é escolhida pelo CÓDIGO (nunca manda a errada, mesmo se renomear)
  const opcoesMidia = [
    ...albunsRr.filter((a) => a.quantidade).map((a) => ({ nome: a.codigo, rotulo: `🗂️ ${a.nome} (álbum) · ${codMidia(a.codigo)}` })),
    ...(emp.drivePastas || []).filter((p) => p.total).map((p) => ({ nome: p.codigo || p.nome, rotulo: `📁 ${p.nome} (Drive) · #${p.codigo || ''}` })),
    ...todas.filter((m) => !m.pastaId).map((m) => ({ nome: m.codigo, rotulo: `${ICONE_TIPO[m.tipo] || '📎'} ${m.nome} · ${codMidia(m.codigo)}` }))
  ];
  const casa = (o, r) => o.nome === r.midia || o.rotulo.includes(` ${r.midia} `);
  abrirModal(`
    <h2>Respostas rápidas</h2>
    ${balao('Texto + foto/catálogo com um atalho', `Ex.: <b>/preco</b> manda a tabela de preços, <b>/catalogo</b> manda o álbum de fotos. Use aqui na aba Conversas${emp.atalhosNoCelular !== false ? ' <b>e também no WhatsApp do celular</b>: digite <b>/preco</b> na conversa do cliente e o CRM troca pelo texto + mídia' : ''}.`)}
    ${balao('E as respostas rápidas que já estão no WhatsApp Business?', 'Elas ficam guardadas só no celular — o WhatsApp não deixa nenhum sistema ler (nem o CRM, nem a Evolution). Recrie aqui <b>com o mesmo atalho</b>: aí elas funcionam no celular e no CRM, e ainda mandam foto/vídeo pelo código. Pode apagar as antigas do WhatsApp Business para não duplicar.', 'aviso')}
    <label class="linha-check" style="margin-bottom:12px"><input type="checkbox" id="atalhos-celular" ${emp.atalhosNoCelular !== false ? 'checked' : ''}> Funcionar também quando eu digitar o atalho no WhatsApp do celular ${ajuda('Você digita só "/preco" na conversa do cliente, no seu celular. O CRM apaga esse "/preco" e manda no lugar o texto e a mídia cadastrados.')}</label>
    <div id="lista-rapidas" class="lista-editavel"></div>
    <div class="acoes"><button type="button" id="add-rapida">+ Nova resposta</button><button type="button" class="primario" id="salvar-rapidas">Salvar</button><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
    const desenhar = () => {
      $('#lista-rapidas', m).innerHTML = lista.map((r, i) => `
        <div class="rapida">
          <div class="linha-editavel"><span class="rotulo">/</span><input value="${esc(r.atalho)}" data-atalho="${i}" placeholder="atalho (ex.: preco)" maxlength="30">${aoEscolher ? `<button type="button" class="pequeno" data-usar="${i}">Usar</button>` : ''}<button type="button" class="pequeno perigo" data-tirar="${i}">✕</button></div>
          <textarea data-texto="${i}" placeholder="Texto (opcional se tiver mídia)">${esc(r.texto || '')}</textarea>
          <select data-midia="${i}"><option value="">Sem mídia</option>${opcoesMidia.map((o) => `<option value="${esc(o.nome)}" ${casa(o, r) ? 'selected' : ''}>${esc(o.rotulo)}</option>`).join('')}</select>
          <input data-quando="${i}" value="${esc(r.quando || '')}" placeholder="Quando usar (lembrete para a equipe — ex.: quando pedirem o preço)" maxlength="200">
        </div>`).join('') || '<p class="rotulo">Nenhuma resposta rápida ainda.</p>';
      $$('[data-quando]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.quando].quando = el.value; }; });
      $$('[data-atalho]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.atalho].atalho = el.value; }; });
      $$('[data-texto]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.texto].texto = el.value; }; });
      $$('[data-midia]', m).forEach((el) => { el.onchange = () => { lista[el.dataset.midia].midia = el.value; }; });
      $$('[data-tirar]', m).forEach((el) => { el.onclick = () => { lista.splice(Number(el.dataset.tirar), 1); desenhar(); }; });
      $$('[data-usar]', m).forEach((el) => {
        el.onclick = () => {
          const r = lista[Number(el.dataset.usar)];
          if (!r.id) return aviso('Salve antes de usar.', true);
          if (!(r.texto || '').trim() && !r.midia) return;
          aoEscolher?.(r);
          fechar();
        };
      });
    };
    desenhar();
    $('#add-rapida', m).onclick = () => { lista.push({ atalho: '', texto: '', midia: '' }); desenhar(); };
    $('#salvar-rapidas', m).onclick = async () => {
      try {
        const celular = $('#atalhos-celular', m).checked;
        emp.respostasRapidas = await api(`empresas/${emp.id}/respostas`, { method: 'PUT', body: { respostas: lista, atalhosNoCelular: celular } });
        emp.atalhosNoCelular = celular;
        lista = emp.respostasRapidas.map((r) => ({ ...r }));
        desenhar();
        aviso('Respostas salvas.');
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- empresa: máquina de vendas (automações)

function descreverGatilho(r) {
  const h = r.gatilho.horas;
  const tempo = h % 24 === 0 ? `${h / 24} ${h / 24 === 1 ? 'dia' : 'dias'}` : `${h} ${h === 1 ? 'hora' : 'horas'}`;
  if (r.gatilho.tipo === 'venda') return `${tempo} depois da venda confirmada (Pix, IA ou equipe)`;
  return r.gatilho.tipo === 'sem_resposta'
    ? `Quando o cliente não responde há ${tempo}`
    : `${tempo} depois de o lead entrar em "${r.gatilho.etapa}"`;
}

// ---------------------------------------------------------------- follow-up automático (em passos)

// Seção 🔁 Follow-up: mensagens prontas, SEM IA — lista simples + editor com prévia do WhatsApp
async function secaoFollowup(id, emp, el, editar = null) {
  if (!el?.isConnected) return;
  const [d, todas, albuns] = await Promise.all([api(`empresas/${id}/followup`), api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`)]);
  if (!el.isConnected) return;
  // o que dá para anexar: mídias soltas, álbuns e pastas do Drive (pelo código), com miniatura
  const capa = (itens) => itens.find((m) => m.tipo === 'image')?.url || '';
  const opcoes = [
    ...todas.filter((m) => !m.pastaId && !m.albumId).map((m) => ({ codigo: m.codigo, nome: m.nome, tipo: m.tipo, url: m.tipo === 'image' ? m.url : '', soFollowup: m.soFollowup })),
    ...albuns.map((a) => ({ codigo: a.codigo, nome: a.nome, tipo: 'album', url: capa(todas.filter((m) => m.albumId === a.id)), soFollowup: a.soFollowup, qtd: todas.filter((m) => m.albumId === a.id).length })),
    ...(emp.drivePastas || []).map((p) => ({ codigo: p.codigo, nome: p.nome, tipo: 'album', url: capa(todas.filter((m) => m.pastaId === p.id)), qtd: p.total }))
  ].filter((o) => o.codigo);
  const porCodigo = Object.fromEntries(opcoes.map((o) => [o.codigo, o]));
  const etiquetas = emp.etiquetas || [];
  const etapas = d.etapas || [];
  const ICONE = { video: '🎬', audio: '🎵', document: '📄', album: '🗂️' };
  const miniatura = (o, extra = '') => (o?.url ? `<img src="${esc(o.url)}" alt="" loading="lazy" ${extra}>` : `<span class="mini-icone" ${extra}>${ICONE[o?.tipo] || '📎'}</span>`);
  const tempo = (h) => (h % 24 === 0 ? { n: h / 24, u: 'd' } : { n: h, u: 'h' });
  const tempoTxt = (h) => { const t = tempo(h); return `${t.n} ${t.u === 'd' ? (t.n === 1 ? 'dia' : 'dias') : t.n === 1 ? 'hora' : 'horas'}`; };
  const nomeEtq = (tid) => etiquetas.find((t) => t.id === tid)?.nome || 'etiqueta';
  const quandoTxt = (q) => (q.inicio.tipo === 'etiqueta' ? `quando recebe a etiqueta "${nomeEtq(q.inicio.etiqueta)}"` : q.inicio.tipo === 'etapa' ? `quando entra na etapa "${q.inicio.etapa}"` : 'quando o cliente para de responder');
  const copiar = (q) => ({ ...q, inicio: { ...q.inicio }, soEtiquetas: [...(q.soEtiquetas || [])], soEtapas: [...(q.soEtapas || [])], passos: q.passos.map((p) => ({ ...p, textos: [...(p.textos || [])], midias: [...(p.midias || [])] })) });
  let numeroTeste = '';
  try { numeroTeste = localStorage.getItem('fup_teste_numero') || ''; } catch { /* ok */ }

  // ------------------------------------------------ teste: manda para um número qualquer
  function modalTeste(passos, titulo) {
    abrirModal(`
      <h2>📤 ${esc(titulo)}</h2>
      <p class="rotulo" style="margin-top:-4px">Chega no WhatsApp exatamente como o cliente recebe (texto, variação sorteada e mídias). Nada é gravado em conversa nenhuma.</p>
      <form id="f-teste-fup">
        <div class="campos"><div class="campo"><label>Mandar para</label><input name="numero" required value="${esc(numeroTeste)}" placeholder="21 99999-9999"></div>
        <div class="campo"><label>Nome no lugar de {nome}</label><input name="nome" value="João" maxlength="40"></div></div>
        <div class="acoes"><button type="button" data-fechar>Cancelar</button><button type="submit" class="primario">Enviar teste</button></div>
      </form>`, (m, fechar) => {
      $('#f-teste-fup', m).onsubmit = async (e) => {
        e.preventDefault();
        const f = formParaObjeto(e.target);
        try {
          await comEspera(e.submitter, () => api(`empresas/${id}/followup/teste`, { method: 'POST', body: { numero: f.numero, nome: f.nome, passos } }), 'Enviando…');
          numeroTeste = f.numero;
          try { localStorage.setItem('fup_teste_numero', f.numero); } catch { /* ok */ }
          fechar();
          aviso('Teste enviado. Confira no WhatsApp.');
        } catch (err) { aviso(err.message, true); }
      };
    });
  }

  // ------------------------------------------------ escolher mídias vendo as miniaturas
  function modalMidias(atuais, aoEscolher) {
    const escolhidas = new Set(atuais);
    let filtro = opcoes.some((o) => o.soFollowup) ? 'fup' : 'todas';
    abrirModal(`
      <h2>🖼️ Escolher mídias</h2>
      <div class="chips" id="fm-filtro" style="margin-bottom:10px"></div>
      <div class="grade-escolha-midia" id="fm-grade"></div>
      <p class="rotulo" style="margin:10px 0 0">Nova mídia? Envie em <a href="${rotaEmpresa(id, 'midias')}">Mídias</a>, na aba <b>🔁 Só follow-up</b>.</p>
      <div class="acoes"><button type="button" data-fechar>Cancelar</button><button type="button" class="primario" id="fm-ok">Usar selecionadas</button></div>`, (m, fechar) => {
      const desenhar = () => {
        const n = (f) => opcoes.filter((o) => f === 'todas' || o.soFollowup).length;
        $('#fm-filtro', m).innerHTML = [['fup', '🔁 Só follow-up'], ['todas', 'Todas']].map(([k, t]) => `<button type="button" class="chip-filtro ${filtro === k ? 'ativo' : ''}" data-f="${k}">${t} <b>${n(k)}</b></button>`).join('');
        const lista = opcoes.filter((o) => filtro === 'todas' || o.soFollowup);
        $('#fm-grade', m).innerHTML = lista.map((o) => `<button type="button" class="item-escolha-midia ${escolhidas.has(o.codigo) ? 'marcada' : ''}" data-c="${esc(o.codigo)}">${miniatura(o)}<span class="nome-mini">${esc(o.nome)}${o.qtd ? ` (${o.qtd})` : ''}</span>${escolhidas.has(o.codigo) ? '<span class="check-mini">✓</span>' : ''}</button>`).join('') || `<p class="rotulo">${filtro === 'fup' ? 'Nenhuma mídia marcada como "Só follow-up" ainda. Veja em "Todas" ou envie em Mídias.' : 'Nenhuma mídia cadastrada.'}</p>`;
        $$('[data-f]', m).forEach((b) => { b.onclick = () => { filtro = b.dataset.f; desenhar(); }; });
        $$('[data-c]', m).forEach((b) => { b.onclick = () => { const c = b.dataset.c; if (escolhidas.has(c)) escolhidas.delete(c); else if (escolhidas.size < 5) escolhidas.add(c); else aviso('No máximo 5 mídias por mensagem.', true); desenhar(); }; });
      };
      desenhar();
      $('#fm-ok', m).onclick = () => { aoEscolher([...escolhidas]); fechar(); };
    });
  }

  // ------------------------------------------------ prévia do WhatsApp
  const variacaoPrevia = {}; // passo → qual variação mostrar
  function textoPrevia(t, nome) {
    return esc(String(t || '').replace(/\{([^{}]*\|[^{}]*)\}/g, (_, o) => o.split('|')[0]).replace(/\{(primeiro_)?nome\}/gi, nome || 'João').replace(/\{nome_completo\}/gi, nome || 'João').replace(/\{empresa\}/gi, emp.nome || ''))
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>').replace(/\n/g, '<br>');
  }
  function htmlPrevia(q, nome) {
    return q.passos.map((p, i) => {
      const v = Math.min(variacaoPrevia[i] || 0, Math.max(0, p.textos.length - 1));
      const texto = p.textos[v] ? `<div class="wa-bolha-fup">${textoPrevia(p.textos[v], nome)}<span class="wa-hora-fup">10:0${i} ✓✓</span></div>` : '';
      const mids = p.midias.map((c) => { const o = porCodigo[c]; return `<div class="wa-bolha-fup midia">${o?.url ? `<img src="${esc(o.url)}" alt="">` : `<div class="wa-arquivo-fup">${ICONE[o?.tipo] || '📎'} ${esc(o?.nome || c)}</div>`}</div>`; }).join('');
      return `<div class="wa-sep-fup">⏱ depois de ${tempoTxt(p.horas)}${i ? ' (da anterior)' : ''}</div>
        ${p.textos.length > 1 ? `<div class="wa-var-fup">${p.textos.map((_, j) => `<button type="button" class="${j === v ? 'ativo' : ''}" data-pv="${i}:${j}">Variação ${j + 1}</button>`).join('')}</div>` : ''}
        ${p.midiaPrimeiro ? mids + texto : texto + mids}`;
    }).join('') || '<p class="rotulo" style="text-align:center">Adicione uma mensagem para ver a prévia.</p>';
  }

  // ------------------------------------------------ lista (tela inicial, minimalista)
  function telaLista() {
    el.innerHTML = `
      <div class="card fup-secao ${d.ativo ? 'ligada' : ''}">
        <div class="cabecalho" style="margin-bottom:4px;padding-right:0"><div><h2 style="margin:0">🔁 Follow-up automático</h2><p class="rotulo" style="margin:2px 0 0">Mensagens prontas — sem IA, não gasta tokens. ${d.ativo ? `<b>${d.naFila}</b> na fila · <b>${d.enviadosHoje}</b> enviado(s) hoje` : '<b>Desligado.</b>'}</p></div>${interruptor('fup-ativo', d.ativo, d.ativo ? 'Ligado' : 'Desligado')}</div>
        <div class="lista-seq-fup">${(d.sequencias || []).map((q, si) => `
          <div class="seq-fup-linha ${q.ativa ? '' : 'desligada'}">
            <div class="seq-fup-info"><b>${q.ativa ? '🟢' : '⚪'} ${esc(q.nome)}</b><span class="rotulo">${esc(quandoTxt(q))} · ${q.passos.length} ${q.passos.length === 1 ? 'mensagem' : 'mensagens'}: ${q.passos.map((p) => tempoTxt(p.horas)).join(' → ')}${d.porSequencia?.[q.id] ? ` · ${d.porSequencia[q.id]} na fila` : ''}</span></div>
            <div class="seq-fup-midias">${[...new Set(q.passos.flatMap((p) => p.midias))].slice(0, 4).map((c) => miniatura(porCodigo[c], `title="${esc(porCodigo[c]?.nome || c)}"`)).join('')}</div>
            <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-testar-seq="${si}">📤 Testar</button><button type="button" class="pequeno primario" data-editar-seq="${si}">Editar</button></div>
          </div>`).join('')}</div>
        <div class="acoes" style="margin-top:8px"><button type="button" id="add-seq">+ Nova sequência</button></div>
        <details style="margin-top:8px"><summary>⚙️ Regras gerais</summary>
          <label class="linha-check" style="margin-top:8px"><input type="checkbox" id="fup-pausados" ${d.incluirPausados ? 'checked' : ''}> Mandar também para quem a equipe está atendendo</label>
          <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="fup-indeciso" ${d.etiquetaIndeciso !== false ? 'checked' : ''}> Marcar a etiqueta <b>Indeciso</b> (se existir no WhatsApp)</label>
          ${etapas.length ? `<div class="campo" style="margin-top:10px"><label>"Parou de responder" não manda para quem está em</label><div class="chips">${etapas.map((e) => `<label class="chip-check"><input type="checkbox" name="parar" value="${esc(e)}" ${(d.pararEtapas || []).includes(e) ? 'checked' : ''}><span>${esc(e)}</span></label>`).join('')}</div></div>` : ''}
          <div class="acoes"><button type="button" class="primario pequeno" id="salvar-regras">Salvar regras</button></div>
        </details>
        <div id="fila-fup" style="margin-top:10px"></div>
      </div>`;
    ligarRelogio();
    desenharFila();
    $('#fup-ativo').onchange = async (e) => {
      try {
        await api(`empresas/${id}/followup`, { method: 'PUT', body: { ativo: e.target.checked } });
        aviso(e.target.checked ? 'Follow-up ligado.' : 'Follow-up desligado.');
        secaoFollowup(id, emp, el);
      } catch (err) { e.target.checked = !e.target.checked; aviso(err.message, true); }
    };
    $$('[data-editar-seq]', el).forEach((b) => { b.onclick = () => telaEditor(Number(b.dataset.editarSeq)); });
    $$('[data-testar-seq]', el).forEach((b) => { b.onclick = () => { const q = d.sequencias[b.dataset.testarSeq]; modalTeste(q.passos, `Testar "${q.nome}" (${q.passos.length} mensagens)`); }; });
    $('#add-seq').onclick = () => telaEditor(-1);
    $('#salvar-regras').onclick = async (e) => {
      try {
        await comEspera(e.target, () => api(`empresas/${id}/followup`, { method: 'PUT', body: { incluirPausados: $('#fup-pausados').checked, etiquetaIndeciso: $('#fup-indeciso').checked, ...($$('input[name=parar]', el).length ? { pararEtapas: $$('input[name=parar]:checked', el).map((c) => c.value) } : {}) } }));
        aviso('Regras salvas.');
      } catch (err) { aviso(err.message, true); }
    };
  }

  // ------------------------------------------------ fila: quem vai receber, desativar, colocar à mão
  let filtroFila = '';
  async function desenharFila(dados = null) {
    const alvo = $('#fila-fup', el);
    if (!alvo) return;
    let f = dados;
    if (!f) {
      try { f = await api(`empresas/${id}/followup/fila`); } catch (err) { alvo.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
    }
    if (!alvo.isConnected) return;
    const varias = (d.sequencias || []).length > 1;
    const bate = (x) => !filtroFila || `${x.nome} ${x.telefone}`.toLowerCase().includes(filtroFila.toLowerCase());
    const linhas = f.naFila.filter(bate);
    alvo.innerHTML = `
      <div class="cabecalho" style="margin:0 0 6px;padding-right:0"><h3 style="margin:0">👥 Clientes na fila (${f.naFila.length})</h3><button type="button" class="pequeno primario" id="fila-colocar">+ Colocar cliente na fila</button></div>
      ${f.naFila.length > 6 ? `<input type="search" id="fila-busca" placeholder="Buscar na fila por nome ou número" value="${esc(filtroFila)}" style="margin-bottom:6px">` : ''}
      ${linhas.length ? `<ul class="fila-fup">${linhas.map((x) => `<li>
          <span><a href="${rotaEmpresa(id, 'conversas')}?lead=${esc(x.leadId)}">${esc(x.nome)}</a> <span class="rotulo">· mensagem ${x.passo} de ${x.total}${varias ? ` · ${esc(x.sequencia)}` : ''}${x.manual ? ' · ✋ colocado à mão' : ''}</span></span>
          <span class="acoes" style="margin:0;gap:6px;align-items:center"><b class="contagem" data-contagem="${esc(x.quando)}">${textoContagem(x.quando)}</b>
            <button type="button" class="pequeno" data-fila="tirar" data-lead="${esc(x.leadId)}" title="Esta rodada não sai (volta se o cliente responder e sumir de novo)">Tirar da fila</button>
            <button type="button" class="pequeno perigo" data-fila="desativar" data-lead="${esc(x.leadId)}" title="Este cliente não recebe mais follow-up">Desativar</button></span>
        </li>`).join('')}</ul>` : `<p class="rotulo">${!d.ativo ? 'Ligue o follow-up para a fila andar.' : f.naFila.length ? 'Ninguém com esse nome na fila.' : 'Ninguém na fila agora.'}</p>`}
      ${f.desligados.length ? `<details style="margin-top:6px"><summary>🚫 Follow-up desativado (${f.desligados.length})</summary><ul class="fila-fup">${f.desligados.map((x) => `<li><span><a href="${rotaEmpresa(id, 'conversas')}?lead=${esc(x.leadId)}">${esc(x.nome)}</a>${x.em ? ` <span class="rotulo">· desde ${esc(data(x.em))}</span>` : ''}</span><button type="button" class="pequeno" data-fila="reativar" data-lead="${esc(x.leadId)}">Reativar</button></li>`).join('')}</ul></details>` : ''}
      <p class="rotulo" style="margin:6px 0 0">Quem já comprou (venda no CRM, venda concluída ou etiqueta de venda do WhatsApp) não entra na fila.</p>`;
    $('#fila-busca', alvo)?.addEventListener('input', (e) => { filtroFila = e.target.value; const pos = e.target.selectionStart; desenharFila(f).then(() => { const b = $('#fila-busca', alvo); if (b) { b.focus(); b.setSelectionRange(pos, pos); } }); });
    $('#fila-colocar', alvo).onclick = () => modalColocarNaFila();
    $$('[data-fila]', alvo).forEach((b) => {
      b.onclick = async () => {
        const acao = b.dataset.fila;
        if (acao === 'desativar' && !(await confirmar({ titulo: 'Desativar o follow-up deste cliente?', texto: 'Ele sai da fila e não recebe mais nenhuma mensagem de follow-up. Dá para reativar depois.', botao: 'Desativar', perigo: true }))) return;
        try {
          const r = await comEspera(b, () => api(`empresas/${id}/followup/cliente`, { method: 'POST', body: { leadId: b.dataset.lead, acao } }));
          aviso(acao === 'tirar' ? 'Tirado da fila desta vez.' : acao === 'desativar' ? 'Follow-up desativado para este cliente.' : 'Follow-up reativado.');
          desenharFila(r);
        } catch (err) { aviso(err.message, true); }
      };
    });
  }

  function modalColocarNaFila() {
    const seqs = (d.sequencias || []).filter((q) => q.ativa && q.passos.length);
    if (!seqs.length) return aviso('Ligue (ou crie) uma sequência primeiro.', true);
    abrirModal(`
      <h2>+ Colocar cliente na fila</h2>
      <div class="campos">
        <div class="campo largo"><label>Cliente</label><input type="search" id="cf-busca" placeholder="Nome ou número (pelo menos 3 letras)" autocomplete="off"></div>
        <div class="campo"><label>Sequência</label><select id="cf-seq">${seqs.map((q) => `<option value="${esc(q.id)}">${esc(q.nome)} (${q.passos.length} mensagens)</option>`).join('')}</select></div>
      </div>
      <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="cf-ja"> Mandar a 1ª mensagem já (sem esperar o tempo dela)</label>
      <div id="cf-lista" style="margin-top:10px"><p class="rotulo">Digite para buscar.</p></div>
      <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
      let t = null;
      const lista = $('#cf-lista', m);
      $('#cf-busca', m).focus();
      $('#cf-busca', m).oninput = (e) => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const q = e.target.value.trim();
          if (q.length < 3) { lista.innerHTML = '<p class="rotulo">Digite para buscar.</p>'; return; }
          try {
            const r = await api(`empresas/${id}/followup/buscar?q=${encodeURIComponent(q)}`);
            lista.innerHTML = r.length ? `<ul class="fila-fup">${r.map((x) => `<li><span><b>${esc(x.nome)}</b> <span class="rotulo">${x.telefone ? `· ${esc(telefoneBonito(x.telefone))}` : ''}${x.etapa ? ` · ${esc(x.etapa)}` : ''}${x.naFila ? ` · já na fila (${esc(x.sequencia)})` : ''}</span>${x.bloqueio ? `<br><span class="rotulo">🚫 ${esc(x.bloqueio)}</span>` : ''}</span>${x.bloqueio ? '' : `<button type="button" class="pequeno primario" data-colocar="${esc(x.leadId)}">Colocar</button>`}</li>`).join('')}</ul>` : '<p class="rotulo">Nenhum cliente encontrado.</p>';
            $$('[data-colocar]', lista).forEach((b) => {
              b.onclick = async () => {
                try {
                  const r2 = await comEspera(b, () => api(`empresas/${id}/followup/cliente`, { method: 'POST', body: { leadId: b.dataset.colocar, acao: 'colocar', seqId: $('#cf-seq', m).value, jaPrimeira: $('#cf-ja', m).checked } }));
                  aviso('Cliente colocado na fila.');
                  fechar();
                  desenharFila(r2);
                } catch (err) { aviso(err.message, true); }
              };
            });
          } catch (err) { lista.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; }
        }, 300);
      };
    });
  }

  // ------------------------------------------------ editor de UMA sequência (com prévia ao lado)
  function telaEditor(si) {
    const nova = si < 0;
    const q = nova
      ? { id: '', nome: 'Nova sequência', ativa: true, inicio: { tipo: 'sem_resposta' }, soEtiquetas: [], soEtapas: [], pararAoResponder: true, passos: [{ id: '', horas: 24, textos: [''], midias: [], midiaPrimeiro: false }] }
      : copiar(d.sequencias[si]);
    let nomeEx = 'João';
    el.innerHTML = `
      <div class="card fup-editor">
        <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><div><button type="button" class="link-botao" id="fup-voltar">← Voltar</button><h2 style="margin:4px 0 0">${nova ? 'Nova sequência' : esc(q.nome)}</h2></div><div class="acoes" style="margin:0"><button type="button" id="fup-testar-tudo">📤 Testar sequência</button><button type="button" class="primario" id="fup-salvar">Salvar</button></div></div>
        <div class="fup-editor-colunas">
          <div class="fup-editor-esq">
            <div class="campos">
              <div class="campo"><label>Nome</label><input id="q-nome" value="${esc(q.nome)}" maxlength="60"></div>
              <div class="campo"><label>Começa</label><select id="q-tipo">
                <option value="sem_resposta" ${q.inicio.tipo === 'sem_resposta' ? 'selected' : ''}>quando o cliente para de responder</option>
                <option value="etiqueta" ${q.inicio.tipo === 'etiqueta' ? 'selected' : ''} ${etiquetas.length ? '' : 'disabled'}>quando recebe uma etiqueta</option>
                <option value="etapa" ${q.inicio.tipo === 'etapa' ? 'selected' : ''}>quando entra numa etapa</option></select></div>
              <div class="campo" id="q-alvo"></div>
            </div>
            <label class="linha-check" style="margin-top:4px"><input type="checkbox" id="q-ativa" ${q.ativa ? 'checked' : ''}> Ligada</label>
            <details style="margin-top:6px"><summary class="rotulo">Mais opções</summary>
              ${etiquetas.length ? `<div class="campo" style="margin-top:8px"><label>Só para quem tem a etiqueta (nenhuma = todos)</label><div class="chips">${etiquetas.map((t) => `<label class="chip-check" style="--cor:${esc(t.cor)}"><input type="checkbox" data-so-etq value="${esc(t.id)}" ${q.soEtiquetas.includes(t.id) ? 'checked' : ''}><span><span class="bolinha-cor"></span>${esc(t.nome)}</span></label>`).join('')}</div></div>` : ''}
              <div class="campo" style="margin-top:6px"><label>Só para quem está nas etapas (nenhuma = todas)</label><div class="chips">${etapas.map((e) => `<label class="chip-check"><input type="checkbox" data-so-etapa value="${esc(e)}" ${q.soEtapas.includes(e) ? 'checked' : ''}><span>${esc(e)}</span></label>`).join('')}</div></div>
              <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="q-parar" ${q.pararAoResponder !== false ? 'checked' : ''}> Parar se o cliente responder</label>
            </details>
            <h3 style="margin:14px 0 6px">Mensagens</h3>
            <div id="q-passos"></div>
            <div class="acoes" style="margin-top:4px"><button type="button" id="q-add">+ Mensagem</button>${nova ? '' : '<button type="button" class="perigo" id="q-apagar">Apagar sequência</button>'}</div>
          </div>
          <div class="fup-editor-dir">
            <div class="wa-celular-fup">
              <div class="wa-topo-fup"><span class="avatar mini">${esc((nomeEx[0] || 'J').toUpperCase())}</span><div><b id="pv-nome-topo">${esc(nomeEx)}</b><small>prévia no WhatsApp</small></div></div>
              <div class="wa-corpo-fup" id="q-previa"></div>
              <div class="wa-rodape-fup"><label>Nome do cliente na prévia <input id="pv-nome" value="${esc(nomeEx)}" maxlength="30"></label></div>
            </div>
          </div>
        </div>
      </div>`;
    const atualizarPrevia = () => {
      $('#q-previa').innerHTML = htmlPrevia(q, nomeEx);
      $$('[data-pv]').forEach((b) => { b.onclick = () => { const [i, j] = b.dataset.pv.split(':').map(Number); variacaoPrevia[i] = j; atualizarPrevia(); }; });
    };
    const desenharAlvo = () => {
      $('#q-alvo').innerHTML = q.inicio.tipo === 'etiqueta'
        ? `<label>Etiqueta</label><select id="q-etq"><option value="">Escolha…</option>${etiquetas.map((t) => `<option value="${esc(t.id)}" ${q.inicio.etiqueta === t.id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select>`
        : q.inicio.tipo === 'etapa'
          ? `<label>Etapa</label><select id="q-etapa"><option value="">Escolha…</option>${etapas.map((e) => `<option ${q.inicio.etapa === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>`
          : '';
      $('#q-etq')?.addEventListener('change', (e) => { q.inicio.etiqueta = e.target.value; });
      $('#q-etapa')?.addEventListener('change', (e) => { q.inicio.etapa = e.target.value; });
    };
    function desenharPassos() {
      $('#q-passos').innerHTML = q.passos.map((p, i) => {
        const t = tempo(p.horas);
        return `<div class="msg-fup">
          <div class="msg-fup-topo"><b>${i + 1}</b><span>depois de</span><input type="number" min="1" value="${t.n}" data-n="${i}"><select data-u="${i}"><option value="h" ${t.u === 'h' ? 'selected' : ''}>horas</option><option value="d" ${t.u === 'd' ? 'selected' : ''}>dias</option></select>
            <span class="msg-fup-acoes">${i ? `<button type="button" class="icone-botao" data-subir="${i}" title="Subir">↑</button>` : ''}${i < q.passos.length - 1 ? `<button type="button" class="icone-botao" data-descer="${i}" title="Descer">↓</button>` : ''}<button type="button" class="icone-botao" data-testar="${i}" title="Enviar esta mensagem de teste">📤</button><button type="button" class="icone-botao perigo" data-tirar="${i}" title="Remover">🗑</button></span></div>
          ${p.textos.map((tx, j) => `<div class="var-fup">${p.textos.length > 1 ? `<span class="var-fup-rotulo">Variação ${j + 1}</span>` : ''}<textarea rows="2" maxlength="2000" data-texto="${i}:${j}" placeholder="{Oi|Olá} {nome}! Passando para saber se ficou alguma dúvida 😊">${esc(tx)}</textarea>${p.textos.length > 1 || p.midias.length ? `<button type="button" class="icone-botao" data-tirar-texto="${i}:${j}" title="Tirar">✕</button>` : ''}</div>`).join('')}
          <div class="msg-fup-midias">${p.midias.map((c, j) => `<span class="mini-escolhida" title="${esc(porCodigo[c]?.nome || c)}">${porCodigo[c] ? miniatura(porCodigo[c]) : '<span class="mini-icone">⚠️</span>'}<button type="button" data-tirar-midia="${i}:${j}" title="Tirar">✕</button></span>`).join('')}
            <button type="button" class="mini-add" data-add-midia="${i}" title="Escolher mídias">＋ 🖼️</button>
            ${p.textos.length < 6 ? `<button type="button" class="link-botao" data-add-texto="${i}">+ variação de texto</button>` : ''}
            ${p.midias.length && p.textos.length ? `<button type="button" class="link-botao" data-ordem="${i}">${p.midiaPrimeiro ? 'mídia antes do texto ⇄' : 'texto antes da mídia ⇄'}</button>` : ''}</div>
        </div>`;
      }).join('') || '<p class="rotulo">Nenhuma mensagem.</p>';
      const ij = (v) => v.split(':').map(Number);
      const muda = () => atualizarPrevia();
      $$('[data-n]', el).forEach((x) => { x.onchange = () => { const i = Number(x.dataset.n); const u = $(`[data-u="${i}"]`, el).value; q.passos[i].horas = Math.max(1, Math.round(Number(x.value) || 1)) * (u === 'd' ? 24 : 1); muda(); }; });
      $$('[data-u]', el).forEach((x) => { x.onchange = () => { const i = Number(x.dataset.u); const n = Number($(`[data-n="${i}"]`, el).value) || 1; q.passos[i].horas = Math.max(1, Math.round(n)) * (x.value === 'd' ? 24 : 1); muda(); }; });
      $$('[data-texto]', el).forEach((x) => { x.oninput = () => { const [i, j] = ij(x.dataset.texto); q.passos[i].textos[j] = x.value; variacaoPrevia[i] = j; muda(); }; });
      $$('[data-add-texto]', el).forEach((x) => { x.onclick = () => { const i = Number(x.dataset.addTexto); q.passos[i].textos.push(''); variacaoPrevia[i] = q.passos[i].textos.length - 1; desenharPassos(); }; });
      $$('[data-tirar-texto]', el).forEach((x) => { x.onclick = () => { const [i, j] = ij(x.dataset.tirarTexto); q.passos[i].textos.splice(j, 1); variacaoPrevia[i] = 0; desenharPassos(); }; });
      $$('[data-ordem]', el).forEach((x) => { x.onclick = () => { const p = q.passos[x.dataset.ordem]; p.midiaPrimeiro = !p.midiaPrimeiro; desenharPassos(); }; });
      $$('[data-tirar]', el).forEach((x) => { x.onclick = () => { q.passos.splice(Number(x.dataset.tirar), 1); desenharPassos(); }; });
      $$('[data-subir]', el).forEach((x) => { x.onclick = () => { const i = Number(x.dataset.subir); [q.passos[i - 1], q.passos[i]] = [q.passos[i], q.passos[i - 1]]; desenharPassos(); }; });
      $$('[data-descer]', el).forEach((x) => { x.onclick = () => { const i = Number(x.dataset.descer); [q.passos[i + 1], q.passos[i]] = [q.passos[i], q.passos[i + 1]]; desenharPassos(); }; });
      $$('[data-tirar-midia]', el).forEach((x) => { x.onclick = () => { const [i, j] = ij(x.dataset.tirarMidia); q.passos[i].midias.splice(j, 1); desenharPassos(); }; });
      $$('[data-add-midia]', el).forEach((x) => { x.onclick = () => { const i = Number(x.dataset.addMidia); modalMidias(q.passos[i].midias, (lista) => { q.passos[i].midias = lista; desenharPassos(); }); }; });
      $$('[data-testar]', el).forEach((x) => { x.onclick = () => { const i = Number(x.dataset.testar); const p = limpo(q.passos[i]); if (!p.textos.length && !p.midias.length) return aviso('Escreva um texto ou escolha uma mídia primeiro.', true); modalTeste([p], `Testar a mensagem ${i + 1}`); }; });
      atualizarPrevia();
    }
    const limpo = (p) => ({ ...p, textos: p.textos.map((t) => t.trim()).filter(Boolean) });
    desenharAlvo();
    desenharPassos();
    $('#q-nome').oninput = (e) => { q.nome = e.target.value; };
    $('#q-tipo').onchange = (e) => { q.inicio = { tipo: e.target.value }; desenharAlvo(); };
    $('#q-ativa').onchange = (e) => { q.ativa = e.target.checked; };
    $('#q-parar').onchange = (e) => { q.pararAoResponder = e.target.checked; };
    $$('[data-so-etq]', el).forEach((x) => { x.onchange = () => { q.soEtiquetas = x.checked ? [...q.soEtiquetas, x.value] : q.soEtiquetas.filter((v) => v !== x.value); }; });
    $$('[data-so-etapa]', el).forEach((x) => { x.onchange = () => { q.soEtapas = x.checked ? [...q.soEtapas, x.value] : q.soEtapas.filter((v) => v !== x.value); }; });
    $('#pv-nome').oninput = (e) => { nomeEx = e.target.value || 'João'; $('#pv-nome-topo').textContent = nomeEx; atualizarPrevia(); };
    $('#q-add').onclick = () => { const ult = q.passos[q.passos.length - 1]; q.passos.push({ id: '', horas: ult ? ult.horas : 24, textos: [''], midias: [], midiaPrimeiro: false }); desenharPassos(); };
    $('#fup-voltar').onclick = () => telaLista();
    $('#fup-testar-tudo').onclick = () => { const ps = q.passos.map(limpo).filter((p) => p.textos.length || p.midias.length); if (!ps.length) return aviso('Nada para testar ainda.', true); modalTeste(ps, `Testar "${q.nome}" (${ps.length} mensagens)`); };
    const salvarTudo = async (seqs, botao) => {
      await comEspera(botao, () => api(`empresas/${id}/followup`, { method: 'PUT', body: { sequencias: seqs.map((x) => ({ ...x, passos: x.passos.map(limpo) })) } }));
    };
    $('#fup-salvar').onclick = async (e) => {
      const seqs = (d.sequencias || []).map(copiar);
      if (nova) seqs.push(q); else seqs[si] = q;
      try {
        await salvarTudo(seqs, e.currentTarget);
        aviso('Follow-up salvo.');
        secaoFollowup(id, emp, el);
      } catch (err) { aviso(err.message, true); }
    };
    $('#q-apagar')?.addEventListener('click', async (e) => {
      if (!(await confirmar({ titulo: 'Apagar sequência?', texto: `A sequência <b>${esc(q.nome)}</b> será apagada.`, botao: 'Apagar', perigo: true }))) return;
      try {
        await salvarTudo((d.sequencias || []).filter((_, k) => k !== si).map(copiar), e.currentTarget);
        aviso('Sequência apagada.');
        secaoFollowup(id, emp, el);
      } catch (err) { aviso(err.message, true); }
    });
  }

  if (editar !== null) telaEditor(editar);
  else telaLista();
}

// 🔁 Follow-up: aba própria (abaixo de Conversas) — tudo do follow-up se configura aqui
async function paginaFollowup(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/followup`);
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Follow-up</h1><p class="sub">Mensagens prontas que recuperam quem parou de responder — sem IA, não gastam tokens</p></div></div>
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `O follow-up sai pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar</a>`, 'aviso')}
    <div class="card horario-auto">
      <label class="linha-check" style="margin:0"><input type="checkbox" id="horario-auto" ${d.horarioComercial ? 'checked' : ''}> <b>Só enviar das 8h às 20h</b> (horário de Brasília) <span class="rotulo">— vale para o follow-up e as automações da Máquina de vendas</span></label>
    </div>
    <div id="secao-followup"><div class="card"><p class="rotulo">Carregando follow-up…</p></div></div>
    <p class="rotulo">🖼️ Mídias para os passos: em <a href="${rotaEmpresa(id, 'midias')}">Mídias</a>, aba <b>🔁 Só follow-up</b> (a IA nunca manda essas na conversa).</p>`;
  secaoFollowup(id, emp, $('#secao-followup'));
  $('#horario-auto').onchange = async (e) => {
    try {
      await api(`empresas/${id}/followup`, { method: 'PUT', body: { horarioComercial: e.target.checked } });
      aviso(e.target.checked ? 'Envios automáticos só das 8h às 20h.' : 'Envios automáticos a qualquer hora.');
    } catch (err) { aviso(err.message, true); e.target.checked = !e.target.checked; }
  };
}

async function paginaAutomacoes(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/automacoes`);
  const precisaLink = d.regras.some((r) => r.ativa && /\{link_avaliacao\}/i.test(r.acao.texto || '')) && !d.linkAvaliacao;
  const precisaAnuncio = d.regras.some((r) => r.ativa && /\{link_anuncio\}/i.test(r.acao.texto || '')) && !d.linkAnuncio;
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Máquina de vendas</h1><p class="sub">Mensagens automáticas que recuperam vendas, trazem avaliações e clientes de volta</p></div><button type="button" class="primario" id="nova-regra">+ Criar automação</button></div>
    ${d.whatsappConectado ? '' : balao('Conecte o WhatsApp primeiro', `As automações saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar</a>`, 'aviso')}
    ${balao('Como funciona', 'Tudo que sai sozinho para o cliente fica aqui. <b>Follow-up</b> retoma quem parou de responder; as <b>automações</b> abaixo cuidam do resto (avaliação no Google, pós-venda, reativar quem desistiu…). O CRM confere seus leads a cada minuto, <b>ninguém recebe duas vezes</b>, quem pediu SAIR ou está na lista negra fica de fora, e quando o cliente responde a IA continua a conversa.')}

    <div class="card horario-auto">
      <label class="linha-check" style="margin:0"><input type="checkbox" id="horario-auto" ${d.horarioAutomatico ? 'checked' : ''}> <b>Só enviar das 8h às 20h</b> (horário de Brasília) <span class="rotulo">— vale para o follow-up e todas as automações</span></label>
    </div>

    <div class="card"><div class="cabecalho" style="margin:0;padding-right:0"><div><h2 style="margin:0">🔁 Follow-up</h2><p class="rotulo" style="margin:2px 0 0">Agora tem aba própria, logo abaixo de Conversas: sequências, mensagens e mídias, tudo sem IA.</p></div><a class="botao primario pequeno" href="${rotaEmpresa(id, 'followup')}">Abrir Follow-up</a></div></div>

    <div class="card" data-cfg="link-google" data-pronto="${d.linkAvaliacao ? 'ok' : precisaLink ? '' : 'off'}" data-resumo="${d.linkAvaliacao ? 'Link salvo' : 'Ainda sem link'}">
      <h2>Link de avaliação do Google</h2>
      <p class="rotulo" style="margin-top:-6px">Usado na automação "Pedir avaliação no Google" (variável <code>{link_avaliacao}</code>).</p>
      <details ${d.linkAvaliacao ? '' : 'open'}><summary>Onde pego esse link?</summary>${passos(['Abra o <a href="https://business.google.com" target="_blank" rel="noopener">Google Meu Negócio</a> (ou pesquise o nome da sua empresa no Google, logado).', 'Clique em <b>Pedir avaliações</b> (ou "Receber mais avaliações").', 'Copie o link que aparece (ex.: <code>https://g.page/r/…/review</code>) e cole aqui.'])}</details>
      <form id="f-link-avaliacao" class="linha-form" style="margin-top:10px"><input name="linkAvaliacao" value="${esc(d.linkAvaliacao)}" placeholder="https://g.page/r/…/review"><button type="submit" class="primario">Salvar</button></form>
      ${precisaLink ? '<p class="erro-caixa" style="margin-top:10px">A automação de avaliação está ligada, mas falta o link — ela não envia até você salvar.</p>' : ''}
    </div>

    <div class="card" data-cfg="link-anuncio" data-pronto="${d.linkAnuncio ? 'ok' : precisaAnuncio ? '' : 'off'}" data-resumo="${d.linkAnuncio ? 'Link salvo' : 'Ainda sem link'}">
      <h2>Link do anúncio (Instagram/Facebook)</h2>
      <p class="rotulo" style="margin-top:-6px">Usado na automação "Pedir comentário no anúncio" (variável <code>{link_anuncio}</code>). O cliente abre o post do anúncio e comenta como foi — comentários reais no anúncio passam confiança para quem ainda não comprou.</p>
      <details ${d.linkAnuncio ? '' : 'open'}><summary>Onde pego esse link?</summary>${passos(['Abra o <a href="https://adsmanager.facebook.com" target="_blank" rel="noopener">Gerenciador de Anúncios</a> e clique no anúncio que está rodando.', 'Em <b>Visualização do anúncio</b>, clique no ícone de compartilhar (↗) e escolha <b>Publicação do Instagram com comentários</b> (ou do Facebook).', 'Copie o link da publicação (ex.: <code>https://www.instagram.com/p/…</code>) e cole aqui. Trocou de anúncio? É só colar o link novo.'])}<p class="rotulo" style="margin:8px 0 0">Dica: peça só a clientes reais e não ofereça brinde em troca do comentário — as regras do Meta não permitem.</p></details>
      <form id="f-link-anuncio" class="linha-form" style="margin-top:10px"><input name="linkAnuncio" value="${esc(d.linkAnuncio)}" placeholder="https://www.instagram.com/p/…"><button type="submit" class="primario">Salvar</button></form>
      ${precisaAnuncio ? '<p class="erro-caixa" style="margin-top:10px">A automação de comentário no anúncio está ligada, mas falta o link — ela não envia até você salvar.</p>' : ''}
    </div>

    <h2>Outras automações</h2>
    <div class="lista-automacoes">
      ${d.regras.length ? d.regras.map((r) => `
        <div class="card automacao ${r.ativa ? 'ligada' : ''}">
          <div class="automacao-topo">
            <div><strong>${esc(r.nome)}</strong><div class="rotulo">${esc(descreverGatilho(r))} · ${r.acao.modo === 'ia' ? '✨ a IA escreve' : '✉️ mensagem pronta'}${r.maxPorLead > 1 ? ` · até ${r.maxPorLead}x por lead` : ''}</div></div>
            ${interruptor(`regra-${r.id}`, r.ativa)}
          </div>
          ${r.explicacao ? `<p class="rotulo" style="margin:8px 0 0">${esc(r.explicacao)}</p>` : ''}
          ${r.gatilho.tipo === 'venda' ? `<label class="linha-antigos">Mandar também para quem já comprou antes de ligar: <select data-antigos="${esc(r.id)}">${[[0, 'não, só vendas novas'], [30, 'sim, vendas dos últimos 30 dias'], [90, 'sim, últimos 90 dias'], [365, 'sim, último ano']].map(([v, n]) => `<option value="${v}" ${Number(r.incluirAntigosDias || 0) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
          <div class="automacao-numeros">
            <span><b>${r.numeros.leadsAtingidos}</b> clientes receberam</span>
            <span><b>${r.numeros.responderam}</b> responderam</span>
            <span><b>${r.numeros.prontosAgora}</b> na fila agora</span>
          </div>
          <div class="acoes"><button type="button" class="pequeno" data-editar="${esc(r.id)}">Editar</button><button type="button" class="pequeno perigo" data-apagar="${esc(r.id)}">Apagar</button></div>
        </div>`).join('') : '<div class="card vazio">Nenhuma automação ainda. Comece por uma receita pronta abaixo 👇</div>'}
    </div>

    <h2>Receitas prontas</h2>
    <div class="grade-receitas">
      ${d.receitas.map((r) => `
        <div class="card receita">
          <strong>${esc(r.nome)}</strong>
          <p class="rotulo">${esc(r.explicacao)}</p>
          ${r.jaTem ? '<span class="etiqueta ok">✓ Na sua lista</span>' : `<button type="button" class="primario pequeno" data-receita="${esc(r.id)}">Ligar</button>`}
        </div>`).join('')}
    </div>`;

  $('#f-link-anuncio').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const bot = await principalDa(id);
      await api(`bots/${bot.id}`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Link do anúncio salvo.');
      paginaAutomacoes(id);
    } catch (err) { aviso(err.message, true); }
  };
  $('#f-link-avaliacao').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const bot = await principalDa(id);
      await api(`bots/${bot.id}`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Link salvo.');
      paginaAutomacoes(id);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-receita]').forEach((b) => {
    b.onclick = async () => {
      try {
        await comEspera(b, () => api(`empresas/${id}/automacoes`, { method: 'POST', body: { receita: b.dataset.receita } }));
        aviso('Automação ligada!');
        paginaAutomacoes(id);
      } catch (err) { aviso(err.message, true); }
    };
  });
  for (const r of d.regras) {
    $(`#regra-${r.id}`).onchange = async (e) => {
      try {
        await api(`empresas/${id}/automacoes/${r.id}`, { method: 'PUT', body: { ativa: e.target.checked } });
        aviso(e.target.checked ? 'Automação ligada.' : 'Automação desligada.');
      } catch (err) { aviso(err.message, true); e.target.checked = !e.target.checked; }
    };
  }
  $$('[data-apagar]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar({ titulo: 'Apagar esta automação?', texto: 'As mensagens que já saíram continuam nas conversas.', botao: 'Apagar', perigo: true }))) return;
      await api(`empresas/${id}/automacoes/${b.dataset.apagar}`, { method: 'DELETE' }).catch((err) => aviso(err.message, true));
      paginaAutomacoes(id);
    };
  });
  $$('[data-editar]').forEach((b) => { b.onclick = () => modalAutomacao(emp, d.regras.find((r) => r.id === b.dataset.editar), () => paginaAutomacoes(id)); });
  $$('[data-antigos]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api(`empresas/${id}/automacoes/${sel.dataset.antigos}`, { method: 'PUT', body: { incluirAntigosDias: Number(sel.value) } });
        aviso(Number(sel.value) ? 'Quem já comprou entra na fila (aos poucos, no horário comercial).' : 'Só vendas novas.');
        paginaAutomacoes(id);
      } catch (err) { aviso(err.message, true); }
    };
  });
  $('#nova-regra').onclick = () => modalAutomacao(emp, null, () => paginaAutomacoes(id));
  $('#horario-auto').onchange = async (e) => {
    try {
      await api(`empresas/${id}/followup`, { method: 'PUT', body: { horarioComercial: e.target.checked } });
      aviso(e.target.checked ? 'Envios automáticos só das 8h às 20h.' : 'Envios automáticos a qualquer hora.');
    } catch (err) { aviso(err.message, true); e.target.checked = !e.target.checked; }
  };
}

async function modalAutomacao(emp, r, depois) {
  const lista = await api(`empresas/${emp.id}/midias`);
  const horas = r?.gatilho.horas || 24;
  const emDias = horas % 24 === 0;
  abrirModal(`
    <h2>${r ? 'Editar automação' : 'Nova automação'}</h2>
    <form id="f-regra">
      <div class="campo"><label>Nome</label><input name="nome" required value="${esc(r?.nome || '')}" placeholder="Ex.: Lembrar orçamento enviado"></div>
      <div class="campo" style="margin-top:12px"><label>Quando enviar</label>
        <select name="tipo"><option value="venda" ${!r || r.gatilho.tipo === 'venda' ? 'selected' : ''}>Depois da venda confirmada (comprovante, IA ou equipe)…</option><option value="etapa" ${r?.gatilho.tipo === 'etapa' ? 'selected' : ''}>Depois que o lead entra numa etapa…</option></select>
      </div>
      <div class="campos" style="margin-top:12px">
        <div class="campo"><label>Tempo</label><div class="linha-form"><input type="number" name="quantidade" min="1" value="${emDias ? horas / 24 : horas}"><select name="unidade" style="width:auto"><option value="h" ${emDias ? '' : 'selected'}>horas</option><option value="d" ${emDias ? 'selected' : ''}>dias</option></select></div></div>
        <div class="campo" id="campo-etapa-gatilho"><label>Etapa</label><select name="etapa">${emp.etapas.map((e) => `<option ${e === r?.gatilho.etapa ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>
      </div>
      <div class="campo" style="margin-top:12px"><label>Só para leads nas etapas ${ajuda('Nenhuma marcada = todas.')}</label><div class="chips">${emp.etapas.map((e) => `<label class="chip-check"><input type="checkbox" name="fetapa" value="${esc(e)}" ${r?.filtro.etapas.includes(e) ? 'checked' : ''}><span>${esc(e)}</span></label>`).join('')}</div></div>
      <div class="campo" style="margin-top:12px"><label>Só para leads com as etiquetas ${ajuda('Nenhuma marcada = qualquer uma.')}</label><div class="chips">${emp.etiquetas.map((t) => `<label class="chip-check" style="--cor:${esc(t.cor)}"><input type="checkbox" name="fetiqueta" value="${esc(t.id)}" ${r?.filtro.etiquetas.includes(t.id) ? 'checked' : ''}><span><span class="bolinha-cor"></span>${esc(t.nome)}</span></label>`).join('') || '<span class="rotulo">sem etiquetas</span>'}</div></div>
      <div class="campo" style="margin-top:12px"><label>O que mandar</label>
        <div class="seletor-canal"><button type="button" data-modo="ia" class="${r?.acao.modo !== 'texto' ? 'ativo' : ''}">✨ A IA escreve (personalizado)</button><button type="button" data-modo="texto" class="${r?.acao.modo === 'texto' ? 'ativo' : ''}">✉️ Mensagem pronta</button></div>
        <textarea name="instrucao" data-painel-modo="ia" placeholder="Ex.: Lembre o cliente do orçamento enviado, pergunte se ficou alguma dúvida e ofereça o parcelamento.">${esc(r?.acao.instrucao || '')}</textarea>
        <textarea name="texto" data-painel-modo="texto" placeholder="{Oi|Olá} {nome}! …">${esc(r?.acao.texto || '')}</textarea>
        <small>Na mensagem pronta: <code>{nome}</code>, <code>{empresa}</code>, <code>{link_avaliacao}</code>, <code>{link_anuncio}</code> e variações <code>{Oi|Olá}</code>.</small>
      </div>
      <div class="campos" style="margin-top:12px">
        <div class="campo"><label>Mandar junto (opcional)</label><select name="midiaId"><option value="">Nada</option>${lista.filter((m) => !m.pastaId).map((m) => `<option value="${esc(m.id)}" ${m.id === r?.acao.midiaId ? 'selected' : ''}>${ICONE_TIPO[m.tipo] || '📎'} ${esc(m.nome)}</option>`).join('')}</select></div>
        <div class="campo"><label>Vezes por lead ${ajuda('Quantas vezes, no máximo, o mesmo cliente recebe esta automação.')}</label><input type="number" name="maxPorLead" min="1" max="5" value="${r?.maxPorLead || 1}"></div>
      </div>
      <p class="rotulo" style="margin:12px 0 0">Quem parou de responder é com o 🔁 Follow-up, no topo da página. O horário (8h–20h) é o mesmo para tudo.</p>
      <label class="linha-check" style="margin-top:6px"><input type="checkbox" name="incluirPausados" ${r?.incluirPausados ? 'checked' : ''}> Mandar também para leads que a equipe está atendendo</label>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    const f = $('#f-regra', m);
    let modo = r?.acao.modo === 'texto' ? 'texto' : 'ia';
    const ajustar = () => {
      $('#campo-etapa-gatilho', m).hidden = f.elements.tipo.value !== 'etapa';
      $$('[data-painel-modo]', m).forEach((t) => { t.hidden = t.dataset.painelModo !== modo; });
    };
    $$('[data-modo]', m).forEach((b) => {
      b.onclick = () => {
        modo = b.dataset.modo;
        $$('[data-modo]', m).forEach((x) => x.classList.toggle('ativo', x === b));
        ajustar();
      };
    });
    f.elements.tipo.onchange = ajustar;
    ajustar();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const o = formParaObjeto(f);
      const corpo = {
        nome: o.nome,
        gatilho: { tipo: o.tipo, etapa: o.etapa, horas: Number(o.quantidade) * (o.unidade === 'd' ? 24 : 1) },
        filtro: { etapas: $$('input[name=fetapa]:checked', f).map((c) => c.value), etiquetas: $$('input[name=fetiqueta]:checked', f).map((c) => c.value) },
        acao: { modo, instrucao: o.instrucao, texto: o.texto, midiaId: o.midiaId },
        maxPorLead: Number(o.maxPorLead),
        incluirPausados: o.incluirPausados,
        ...(r ? {} : { ativa: true })
      };
      try {
        await api(r ? `empresas/${emp.id}/automacoes/${r.id}` : `empresas/${emp.id}/automacoes`, { method: r ? 'PUT' : 'POST', body: corpo });
        fechar();
        aviso('Automação salva.');
        depois();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- logo / avatar da empresa

const CORES_AVATAR = ['#0f766e', '#1d4ed8', '#7c3aed', '#be185d', '#b45309', '#15803d', '#0e7490', '#4338ca'];
function avatarEmpresa(e, classe = '') {
  if (e?.logoUrl) return `<img class="avatar-empresa ${classe}" src="${esc(e.logoUrl)}" alt="">`;
  const nome = String(e?.nome || '?').trim();
  const iniciais = nome.split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
  const cor = CORES_AVATAR[[...nome].reduce((s, c) => s + c.charCodeAt(0), 0) % CORES_AVATAR.length];
  return `<span class="avatar-empresa ${classe}" style="background:${cor}">${esc(iniciais || '?')}</span>`;
}

function brl(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Escolher e enviar a foto/logo da empresa
function escolherLogo(emp, depois) {
  const entrada = document.createElement('input');
  entrada.type = 'file';
  entrada.accept = 'image/png,image/jpeg,image/webp';
  entrada.onchange = async () => {
    const f = entrada.files[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) return aviso('Imagem maior que 3 MB.', true);
    try {
      const r = await fetch(`api/empresas/${emp.id}/logo?tipo=${encodeURIComponent(f.type)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
      aviso('Foto da empresa atualizada.');
      depois?.(d);
    } catch (err) { aviso(err.message, true); }
  };
  entrada.click();
}

function gradeEmpresas(lista) {
  return `
    <div class="grade-empresas">
      ${lista.map((e) => `
        <div class="cartao-empresa-caixa">
        ${ehAdmin() ? `<button type="button" class="cartao-excluir" data-excluir-empresa="${esc(e.id)}" title="Excluir empresa" aria-label="Excluir ${esc(e.nome)}">🗑️</button>` : ''}
        <a class="cartao-empresa ${e.ativa === false ? 'pausada' : ''}" href="${rotaEmpresa(e.id)}">
          <div class="cartao-empresa-topo">${avatarEmpresa(e, 'grande')}<div class="cartao-empresa-nome"><strong>${esc(e.nome)}</strong><span class="rotulo">${esc(e.nicho || 'Sem ramo definido')}</span></div></div>
          <div class="cartao-empresa-hero"><span class="rotulo">Faturamento no mês</span><b>${brl(e.faturamentoMes)}</b></div>
          <div class="cartao-empresa-numeros">
            <div><b>${e.leads7d || 0}</b><span class="rotulo">Leads 7 dias</span></div>
            <div class="${e.naoLidas ? 'pede' : ''}"><b>${e.naoLidas || 0}</b><span class="rotulo">Não lidas</span></div>
            <div><b>${numeroCurto(e.usoHoje?.total)}</b><span class="rotulo">Tokens hoje</span></div>
          </div>
          <div class="cartao-empresa-rodape">
            <span class="ponto-canal ${e.canais?.site ? 'ok' : ''}">Site</span>
            <span class="ponto-canal ${e.canais?.whatsapp && e.whatsapp?.configurado ? 'ok' : e.whatsapp?.configurado ? '' : 'falta'}">WhatsApp${e.whatsapp?.configurado ? '' : ' · não conectado'}</span>
            <span class="rodape-fim">
            ${e.ativa === false ? '<span class="etiqueta off">Pausada</span>' : ''}
            ${(e.dicas || []).some((x) => x.nivel === 'erro') ? '<span class="etiqueta off">Precisa de atenção</span>' : ''}${e.alertasNaoLidos ? `<span class="etiqueta aviso">${e.alertasNaoLidos} ${e.alertasNaoLidos === 1 ? 'alerta' : 'alertas'}</span>` : ''}
            <span class="abrir-seta" aria-hidden="true">→</span>
            </span>
          </div>
        </a>
        </div>`).join('')}
      ${ehAdmin() ? '<button type="button" class="cartao-empresa nova-empresa" id="nova-cartao"><span class="mais">+</span><strong>Nova empresa</strong><span class="rotulo">Cadastre um cliente e configure em minutos</span></button>' : ''}
    </div>`;
}

// ---------------------------------------------------------------- empresa: faturamento

async function paginaFaturamento(id, params) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const mes = params.get('mes') || '';
  const [d, gd] = await Promise.all([api(`empresas/${id}/faturamento?${new URLSearchParams({ mes })}`), api(`empresas/${id}/gastos?${new URLSearchParams({ mes })}`).catch(() => null)]);
  const r = d.resumo;
  const cfg = d.config;
  const variacao = r.mesAnterior ? Math.round(((r.mes - r.mesAnterior) / r.mesAnterior) * 100) : null;
  const meses = [];
  for (let i = 0; i < 12; i++) {
    const dt = new Date();
    dt.setDate(1);
    dt.setMonth(dt.getMonth() - i);
    meses.push({ id: dt.toISOString().slice(0, 7), nome: dt.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) });
  }
  const maxDia = Math.max(...r.porDia.map((x) => x.total), 0);
  const topo = maxDia ? Math.ceil(maxDia / 10 ** Math.floor(Math.log10(maxDia))) * 10 ** Math.floor(Math.log10(maxDia)) : 100;
  const iMaior = r.porDia.findIndex((x) => x.total === maxDia && maxDia > 0);
  const ROTULO_ORIGEM = { texto: '📄 lido do PDF', ocr: '📷 lido da foto', ia: '✨ lido pela IA', manual: '✍️ lançada à mão', 'ia-conversa': '🤖 fechada pela IA na conversa', equipe: '👤 marcada pela equipe' };

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho">
      <div><h1>Faturamento</h1><p class="sub">Vendas, gastos e lucro da empresa — entram sozinhos pelo WhatsApp</p></div>
      <div class="barra">
        <button type="button" id="procurar-vendas" title="Procura agora (sem IA) a frase de venda da equipe e comprovantes que ficaram para trás — roda sozinho de hora em hora">🔎 Procurar vendas agora</button>
        <label class="botao" title="Enviar um comprovante (foto ou PDF) pelo computador">📄 Ler comprovante<input type="file" id="ler-comprovante" hidden accept="image/*,.pdf"></label>
        <button type="button" class="primario" id="nova-venda">+ Lançar venda</button>
      </div>
    </div>
    ${balao('As vendas entram sozinhas', `Quando o cliente manda o <b>comprovante do Pix</b> (print ou PDF) no WhatsApp, o CRM lê o valor, a data e quem pagou <b>sem usar IA</b> (não gasta crédito), registra a venda aqui, move o lead para "Vendi" e a IA agradece o cliente. ${cfg.usarIa ? 'Só quando a foto está ruim de ler a IA ajuda.' : 'A IA não é usada para ler comprovantes.'}`)}
    ${cfg.recebedores ? '' : balao('Proteja-se de comprovante falso', 'Informe abaixo, em <b>Configurações</b>, o nome, CNPJ/CPF ou chave Pix de quem recebe. Comprovante feito para outra pessoa fica marcado "A conferir".', 'aviso')}
    ${r.aConferir ? balao(`${r.aConferir} ${r.aConferir === 1 ? 'venda precisa' : 'vendas precisam'} ser conferida${r.aConferir === 1 ? '' : 's'}`, 'Veja na lista abaixo (marcadas com ⚠). Confira no extrato do banco e clique em Confirmar ou Cancelar.', 'aviso') : ''}

    <div class="grade-resumo">
      ${numeroCard('Hoje', brl(r.hoje))}
      ${numeroCard('Últimos 7 dias', brl(r.seteDias))}
      <div class="card numero-card"><div class="rotulo">Este mês</div><div class="numero">${brl(r.mes)}</div>${variacao !== null ? `<div class="rotulo variacao">${variacao >= 0 ? '▲' : '▼'} ${Math.abs(variacao)}% vs. mês passado (${brl(r.mesAnterior)})</div>` : ''}</div>
      <div class="card numero-card"><div class="rotulo">Ticket médio (mês)</div><div class="numero">${brl(r.ticketMedio)}</div><div class="rotulo variacao">${r.vendasMes} ${r.vendasMes === 1 ? 'venda' : 'vendas'} no mês</div></div>
    </div>

    <div class="card">
      <h2 style="margin-bottom:4px">Vendas por dia</h2>
      <p class="rotulo" style="margin:0 0 12px">Últimos 30 dias · só vendas confirmadas · passe o mouse (ou toque) numa barra</p>
      <div class="grafico" role="img" aria-label="Faturamento por dia nos últimos 30 dias">
        <div class="grafico-eixo"><span>${brl(topo)}</span><span>${brl(topo / 2)}</span><span>R$ 0</span></div>
        <div class="grafico-area">
          <div class="grafico-grade"><span></span><span></span><span></span></div>
          <div class="grafico-barras">
            ${r.porDia.map((x, i) => {
              const dia = new Date(x.dia);
              const rotulo = dia.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
              return `<div class="coluna-grafico" tabindex="0" data-dica="${esc(`${rotulo}: ${brl(x.total)} · ${x.vendas} ${x.vendas === 1 ? 'venda' : 'vendas'}`)}">
                ${i === iMaior ? `<span class="valor-topo${i > 24 ? ' fim' : i < 4 ? ' inicio' : ''}" style="bottom:calc(${(x.total / topo) * 100}% + 4px)">${brl(x.total)}</span>` : ''}
                <span class="barra-grafico" style="height:${x.total ? Math.max(2, (x.total / topo) * 100) : 0}%"></span>
                <span class="dia-grafico">${i % 5 === 4 || i === 29 ? rotulo : ''}</span>
              </div>`;
            }).join('')}
          </div>
          <div class="dica-grafico" id="dica-grafico" hidden></div>
        </div>
      </div>
    </div>

    ${gd ? htmlGastos(gd) : ''}

    <div class="card tabela-wrap">
      <div class="cabecalho" style="padding:16px 16px 0;margin-bottom:8px"><h2 style="margin:0">Vendas</h2>
        <select id="filtro-mes" style="width:auto"><option value="">Todas</option>${meses.map((m) => `<option value="${m.id}" ${m.id === mes ? 'selected' : ''}>${esc(m.nome)}</option>`).join('')}</select>
      </div>
      <table>
        <thead><tr><th>Data</th><th>Cliente</th><th>Valor</th><th class="esconde-mobile">Como entrou</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          ${d.vendas.length ? d.vendas.map((v) => `
            <tr class="${v.status === 'cancelada' ? 'cancelada' : ''}">
              <td style="white-space:nowrap">${data(v.data)}</td>
              <td>${v.leadId ? `<a href="#/leads/${esc(v.leadId)}">${esc(v.cliente || v.leadNome || 'Cliente')}</a>` : esc(v.cliente || v.pagador || '—')}${v.descricao ? `<br><span class="rotulo">${esc(v.descricao)}</span>` : ''}</td>
              <td style="white-space:nowrap"><b>${brl(v.valor)}</b><br><span class="rotulo">${esc(v.forma)}</span></td>
              <td class="esconde-mobile rotulo">${ROTULO_ORIGEM[v.lidoPor] || v.lidoPor}${v.comprovanteUrl ? `<br><a href="${esc(v.comprovanteUrl)}" target="_blank" rel="noopener">ver comprovante</a>` : ''}</td>
              <td>${v.status === 'confirmada' ? '<span class="etiqueta ok">✓ Confirmada</span>' : v.status === 'conferir' ? `<span class="etiqueta aviso">⚠ A conferir</span><br><span class="rotulo">${esc(v.motivoConferir)}</span>` : '<span class="etiqueta off">✕ Cancelada</span>'}</td>
              <td style="white-space:nowrap">
                ${v.status !== 'confirmada' ? `<button type="button" class="pequeno" data-status="confirmada" data-venda="${esc(v.id)}">Confirmar</button>` : ''}
                ${v.status !== 'cancelada' ? `<button type="button" class="pequeno" data-status="cancelada" data-venda="${esc(v.id)}">Cancelar</button>` : ''}
                <button type="button" class="pequeno" data-editar-venda="${esc(v.id)}">Editar</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="6" class="vazio">Nenhuma venda ainda. Elas aparecem aqui quando um cliente manda o comprovante no WhatsApp.</td></tr>'}
        </tbody>
      </table>
    </div>

    <details class="card secao-avancada" ${cfg.recebedores ? '' : 'open'}>
      <summary>Configurações da leitura de comprovantes</summary>
      <form id="f-cfg-fat" style="margin-top:12px">
        <div class="campo"><label>Quem recebe os pagamentos ${ajuda('Nome da empresa como aparece no comprovante, CNPJ/CPF e/ou chave Pix. Separe por vírgula. Comprovante para outra pessoa fica "A conferir".')}</label><input name="recebedores" value="${esc(cfg.recebedores)}" placeholder="Ex.: NOME DA EMPRESA, 12.345.678/0001-90, pix@empresa.com"></div>
        <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="ativo" ${cfg.ativo ? 'checked' : ''}> Registrar vendas pelos comprovantes que chegam no WhatsApp</label>
        <label class="linha-check" style="margin-top:6px"><input type="checkbox" name="usarIa" ${cfg.usarIa ? 'checked' : ''}> Se não der para ler sem IA (foto ruim), deixar a IA tentar ${ajuda('Gasta um pouco de crédito da IA só nesses casos. Desmarcado = nunca usa IA para comprovantes.')}</label>
        <label class="linha-check" style="margin-top:6px"><input type="checkbox" name="moverParaFechado" ${cfg.moverParaFechado ? 'checked' : ''}> Mover o lead para "Vendi" quando pagar (e trocar a etiqueta "Agendado" pela de venda)</label>
        <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="vendaPorFrase" ${cfg.vendaPorFrase ? 'checked' : ''}> Registrar venda quando a equipe mandar a frase de venda ${ajuda('De hora em hora, sem gastar IA: se você ou a equipe mandarem a frase (ex.: "Obrigado pela preferência"), o CRM lança a venda com o valor que achar na conversa. Sem valor, a venda fica "a conferir" e chega um aviso no sininho.')}</label>
        <div class="campo" style="margin-top:6px"><label>Frase(s) de venda (separe por vírgula)</label><input name="frasesVenda" value="${esc(cfg.frasesVenda)}" placeholder="obrigado pela preferência, obrigada pela preferência"></div>
        <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
      </form>
    </details>`;

  // dica do gráfico (mouse e teclado)
  const dica = $('#dica-grafico');
  $$('.coluna-grafico').forEach((c) => {
    const mostrar = () => {
      dica.textContent = c.dataset.dica;
      dica.hidden = false;
      const area = c.parentElement.getBoundingClientRect();
      const col = c.getBoundingClientRect();
      dica.style.left = `${Math.min(Math.max(0, col.left - area.left + col.width / 2 - dica.offsetWidth / 2), area.width - dica.offsetWidth)}px`;
    };
    c.onmouseenter = mostrar;
    c.onfocus = mostrar;
    c.onclick = mostrar;
    c.onmouseleave = () => { dica.hidden = true; };
    c.onblur = () => { dica.hidden = true; };
  });

  $('#filtro-mes').onchange = (e) => { location.hash = rotaEmpresa(id, 'faturamento') + (e.target.value ? `?mes=${e.target.value}` : ''); };
  if (gd) ligarGastos(id, gd, () => paginaFaturamento(id, params));
  $('#procurar-vendas').onclick = async (e) => {
    try {
      const r = await comEspera(e.currentTarget, () => api(`empresas/${id}/varredura-vendas`, { method: 'POST', body: {} }), 'Procurando…');
      aviso(r.frase || r.comprovante ? `Achei ${r.frase + r.comprovante} venda(s): ${r.frase} pela frase, ${r.comprovante} pelo comprovante.` : 'Nenhuma venda nova encontrada.');
      paginaFaturamento(id, params);
    } catch (err) { aviso(err.message, true); }
  };
  $('#f-cfg-fat').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`empresas/${id}/faturamento/config`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Configurações salvas.');
      paginaFaturamento(id, params);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-status]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`empresas/${id}/vendas/${b.dataset.venda}`, { method: 'PUT', body: { status: b.dataset.status } });
        aviso(b.dataset.status === 'confirmada' ? 'Venda confirmada.' : 'Venda cancelada.');
        paginaFaturamento(id, params);
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-editar-venda]').forEach((b) => {
    b.onclick = () => modalVenda(emp, d.vendas.find((v) => v.id === b.dataset.editarVenda), null, () => paginaFaturamento(id, params));
  });
  $('#nova-venda').onclick = () => modalVenda(emp, null, null, () => paginaFaturamento(id, params));
  $('#ler-comprovante').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const qs = new URLSearchParams({ nome: f.name, tipo: f.type || '' });
      const resp = await fetch(`api/empresas/${id}/vendas/comprovante?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const v = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(v.erro || `Erro ${resp.status}`);
      aviso(v.repetida ? `Este comprovante (${brl(v.valor)}) já estava registrado.` : `Venda de ${brl(v.valor)} registrada${v.status === 'conferir' ? ' — a conferir' : ''}.`);
      paginaFaturamento(id, params);
    } catch (err) { aviso(err.message, true); }
  };
}

// 💸 Gastos da empresa (lançados pelo grupo do WhatsApp ou à mão) + lucro do mês
function htmlGastos(gd) {
  const r = gd.resumo;
  const c = gd.config;
  const nomeMes = new Date(`${r.mes}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const maior = Math.max(...r.porCategoria.map((x) => x.total), 0);
  const ORIGEM = { texto: '💬 escrito no grupo', ocr: '📷 foto no grupo', ia: '✨ comprovante lido pela IA', manual: '✍️ lançado à mão' };
  const grupo = c.grupoJid
    ? `<div class="grupo-gastos ligado"><span>💬 Grupo conectado: <b>${esc(c.grupoNome || 'grupo')}</b> — mande lá <i>"gastei 50 gasolina"</i> ou a foto do comprovante.${c.ultimaBusca ? ` <span class="rotulo">Última conferência: ${esc(data(c.ultimaBusca.em))}</span>` : ''}</span><span class="barra"><button type="button" class="pequeno" id="gastos-buscar" title="Procura no grupo mensagens que não chegaram (ex.: WhatsApp desconectado)">🔄 Conferir grupo</button><button type="button" class="pequeno" id="gastos-grupo">Trocar grupo</button></span></div>`
    : `<div class="grupo-gastos"><span>💬 <b>Lance os gastos pelo WhatsApp:</b> conecte um grupo onde o número da empresa participa. Tudo o que vocês mandarem lá (<i>"gastei 50 gasolina"</i>, <i>"120 aluguel"</i> ou a foto do comprovante do Pix) entra aqui sozinho, por categoria.</span>${gd.whatsappConectado ? '<button type="button" class="primario pequeno" id="gastos-grupo">Conectar grupo</button>' : '<span class="rotulo">Conecte o WhatsApp da empresa primeiro.</span>'}</div>`;
  return `
    <div class="card" id="card-gastos">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">💸 Faturamento e gastos · ${esc(nomeMes)}</h2>
        <div class="barra"><button type="button" class="pequeno" id="gastos-categorias">Categorias</button><button type="button" class="primario pequeno" id="novo-gasto">+ Lançar gasto</button></div></div>
      ${grupo}
      <div class="grade-resumo gastos-numeros">
        ${numeroCard('Faturamento', brl(r.faturamento))}
        ${numeroCard('Gastos', brl(r.gastos), 'gasto')}
        ${numeroCard(r.lucro >= 0 ? 'Sobrou (lucro)' : 'Faltou (prejuízo)', brl(r.lucro), r.lucro >= 0 ? 'lucro' : 'prejuizo')}
      </div>
      ${r.porCategoria.length ? `<h3 style="margin:14px 0 8px">Gastos por categoria</h3><div class="gastos-categorias">${r.porCategoria.map((x) => `<div class="cat-gasto"><span class="cat-nome">${esc(x.categoria)}</span><span class="cat-barra"><span style="width:${maior ? Math.max(3, (x.total / maior) * 100) : 0}%"></span></span><b>${brl(x.total)}</b><span class="rotulo">${r.gastos ? Math.round((x.total / r.gastos) * 100) : 0}%</span></div>`).join('')}</div>` : '<p class="rotulo" style="margin:12px 0 0">Nenhum gasto neste mês ainda.</p>'}
      ${gd.gastos.length ? `<details class="gastos-lista" style="margin-top:12px"><summary>Ver os ${gd.gastos.length} gasto(s) do mês</summary>
        <table><thead><tr><th>Data</th><th>Gasto</th><th>Categoria</th><th>Valor</th><th class="esconde-mobile">Como entrou</th><th></th></tr></thead><tbody>
        ${gd.gastos.map((g) => `<tr><td style="white-space:nowrap">${data(g.data)}</td><td>${esc(g.descricao || '—')}${g.autor ? `<br><span class="rotulo">por ${esc(g.autor)}</span>` : ''}</td><td>${esc(g.categoria)}</td><td style="white-space:nowrap"><b>${brl(g.valor)}</b></td><td class="esconde-mobile rotulo">${ORIGEM[g.lidoPor] || esc(g.lidoPor || '')}${g.comprovanteUrl ? `<br><a href="${esc(g.comprovanteUrl)}" target="_blank" rel="noopener">ver comprovante</a>` : ''}</td><td><button type="button" class="pequeno" data-editar-gasto="${esc(g.id)}">Editar</button></td></tr>`).join('')}
        </tbody></table></details>` : ''}
    </div>`;
}

function ligarGastos(id, gd, recarregar) {
  $('#novo-gasto').onclick = () => modalGasto(id, gd, null, recarregar);
  $$('[data-editar-gasto]').forEach((b) => { b.onclick = () => modalGasto(id, gd, gd.gastos.find((g) => g.id === b.dataset.editarGasto), recarregar); });
  $('#gastos-grupo')?.addEventListener('click', () => modalGrupoGastos(id, gd, recarregar));
  $('#gastos-categorias').onclick = () => modalCategoriasGastos(id, gd, recarregar);
  $('#gastos-buscar')?.addEventListener('click', async (e) => {
    try {
      const r = await comEspera(e.currentTarget, () => api(`empresas/${id}/gastos/buscar`, { method: 'POST', body: {} }), 'Conferindo…');
      aviso(r.achados ? `${r.achados} gasto(s) novo(s) encontrado(s) no grupo.` : 'Tudo certo: nenhum gasto ficou para trás.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  });
}

function modalGasto(id, gd, g, depois) {
  const quando = new Date(g ? g.data : Date.now());
  const local = new Date(quando.getTime() - quando.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const cats = gd.config.categorias.map((c) => c.nome);
  if (g && !cats.includes(g.categoria)) cats.unshift(g.categoria);
  abrirModal(`
    <h2>${g ? 'Editar gasto' : 'Lançar gasto'}</h2>
    <form id="f-gasto">
      <div class="campos">
        <div class="campo"><label>Valor (R$) *</label><input name="valor" required inputmode="decimal" value="${g ? esc(String(g.valor).replace('.', ',')) : ''}" placeholder="50,00"></div>
        <div class="campo"><label>Categoria</label><select name="categoria">${cats.map((c) => `<option ${c === (g?.categoria || 'Outros') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <div class="campo"><label>Data</label><input type="datetime-local" name="data" value="${local}"></div>
        <div class="campo"><label>O que foi (opcional)</label><input name="descricao" value="${esc(g?.descricao || '')}" placeholder="Ex.: gasolina"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button>${g ? '<button type="button" class="perigo" id="apagar-gasto" style="margin-left:auto">Apagar</button>' : ''}</div>
    </form>`, (m, fechar) => {
    $('#f-gasto', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formParaObjeto(e.target);
      try {
        await api(g ? `empresas/${id}/gastos/${g.id}` : `empresas/${id}/gastos`, { method: g ? 'PUT' : 'POST', body: { ...f, data: f.data ? new Date(f.data).toISOString() : undefined } });
        fechar();
        aviso('Gasto salvo.');
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
    $('#apagar-gasto', m)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Apagar este gasto?', texto: 'Ele sai das contas do mês.', botao: 'Apagar', perigo: true }))) return;
      try {
        await api(`empresas/${id}/gastos/${g.id}`, { method: 'DELETE' });
        fechar();
        depois?.();
      } catch (err) { aviso(err.message, true); }
    });
  });
}

function modalGrupoGastos(id, gd, depois) {
  const c = gd.config;
  abrirModal(`
    <h2>💬 Grupo de gastos</h2>
    <p class="rotulo" style="margin:0 0 12px">Escolha um grupo do WhatsApp em que o <b>número da empresa</b> participa. Crie um grupo só para isso (ex.: "Gastos da empresa") com quem lança as despesas. As mensagens dos outros grupos continuam ignoradas.</p>
    <div id="lista-grupos"><p class="rotulo">Buscando seus grupos…</p></div>
    <label class="linha-check" style="margin-top:12px"><input type="checkbox" id="g-responder" ${c.responderNoGrupo ? 'checked' : ''}> Confirmar no grupo cada gasto lançado (✅ Gasto de R$ 50,00 · Combustível)</label>
    <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="g-ia" ${c.usarIa ? 'checked' : ''}> Se a foto do comprovante estiver ruim de ler, deixar a IA tentar ${ajuda('Primeiro o CRM lê sem IA (não gasta crédito). Só se não achar o valor a IA olha a foto.')}</label>
    <div class="acoes"><button type="button" class="primario" id="g-salvar">Salvar</button><button type="button" data-fechar>Cancelar</button>${c.grupoJid ? '<button type="button" class="perigo" id="g-desconectar" style="margin-left:auto">Desconectar grupo</button>' : ''}</div>`, async (m, fechar) => {
    let escolhido = c.grupoJid;
    let nome = c.grupoNome;
    const salvarCfg = async (corpo) => {
      await api(`empresas/${id}/gastos/config`, { method: 'PUT', body: corpo });
      fechar();
      depois?.();
    };
    $('#g-salvar', m).onclick = async (e) => {
      if (!escolhido) return aviso('Escolha um grupo da lista.', true);
      try {
        await comEspera(e.currentTarget, () => salvarCfg({ ...(escolhido !== c.grupoJid ? { grupoJid: escolhido, grupoNome: nome } : {}), responderNoGrupo: $('#g-responder', m).checked, usarIa: $('#g-ia', m).checked }), 'Conectando…');
        aviso(escolhido !== c.grupoJid ? `Grupo "${nome}" conectado. Mande um gasto lá para testar!` : 'Salvo.');
      } catch (err) { aviso(err.message, true); }
    };
    $('#g-desconectar', m)?.addEventListener('click', async () => {
      try {
        await salvarCfg({ grupoJid: '' });
        aviso('Grupo desconectado. Os gastos já lançados continuam aqui.');
      } catch (err) { aviso(err.message, true); }
    });
    const caixa = $('#lista-grupos', m);
    try {
      const grupos = await api(`empresas/${id}/gastos/grupos`);
      if (!caixa.isConnected) return;
      caixa.innerHTML = grupos.length
        ? `<input type="search" id="g-busca" placeholder="Procurar grupo…" style="margin-bottom:8px"><div class="lista-grupos">${grupos.map((g) => `<label class="item-grupo"><input type="radio" name="grupo" value="${esc(g.id)}" data-nome="${esc(g.nome)}" ${g.id === c.grupoJid ? 'checked' : ''}><span><b>${esc(g.nome)}</b>${g.membros ? ` <small>${g.membros} participantes</small>` : ''}</span></label>`).join('')}</div>`
        : '<p class="aviso-texto">O número da empresa não está em nenhum grupo. Crie um grupo no WhatsApp com o número da empresa e clique de novo.</p>';
      $$('input[name=grupo]', caixa).forEach((r) => { r.onchange = () => { escolhido = r.value; nome = r.dataset.nome; }; });
      $('#g-busca', caixa)?.addEventListener('input', (e) => {
        const q = sem(e.target.value);
        $$('.item-grupo', caixa).forEach((el) => { el.hidden = q && !sem(el.textContent).includes(q); });
      });
    } catch (err) {
      caixa.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`;
    }
  });
}

function modalCategoriasGastos(id, gd, depois) {
  const linhas = gd.config.categorias.map((c) => `${c.nome}${c.palavras ? `: ${c.palavras}` : ''}`).join('\n');
  abrirModal(`
    <h2>Categorias de gastos</h2>
    <p class="rotulo" style="margin:0 0 10px">Uma categoria por linha. Depois dos dois-pontos, as palavras que levam o gasto para ela (ex.: <i>Combustível: gasolina, posto, etanol</i>). No grupo, dá para escolher na hora: <i>"35 almoço categoria equipe"</i>. O que não se encaixar vai para <b>Outros</b>.</p>
    <textarea id="cats" rows="12" style="width:100%;font-family:inherit">${esc(linhas)}</textarea>
    <div class="acoes"><button type="button" class="primario" id="cats-salvar">Salvar</button><button type="button" data-fechar>Cancelar</button></div>`, (m, fechar) => {
    $('#cats-salvar', m).onclick = async () => {
      const categorias = $('#cats', m).value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i < 0 ? { nome: l, palavras: '' } : { nome: l.slice(0, i).trim(), palavras: l.slice(i + 1).trim() }; });
      try {
        await api(`empresas/${id}/gastos/config`, { method: 'PUT', body: { categorias } });
        fechar();
        aviso('Categorias salvas.');
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// Sobe um arquivo em pedaços (aceita vídeo grande) e devolve a mídia criada
async function subirMidiaEmPedacos(empresaId, arq) {
  if (arq.size > 200 * 1024 * 1024) throw new Error(`O arquivo tem ${(arq.size / 1048576).toFixed(0)} MB — o máximo é 200 MB.`);
  const ini = await api(`empresas/${empresaId}/midias/envio`, { method: 'POST', body: { arquivo: arq.name, tamanho: arq.size, tipo: arq.type || '' } });
  for (let pos = 0; pos < arq.size; pos += ini.pedaco) {
    const r = await fetch(`api/empresas/${empresaId}/midias/envio/${ini.envioId}/parte?pos=${pos}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arq.slice(pos, pos + ini.pedaco) });
    if (!r.ok) throw new Error('A conexão caiu no meio do envio. Tente de novo.');
  }
  return api(`empresas/${empresaId}/midias/envio/${ini.envioId}/concluir`, { method: 'POST', body: {} });
}

// Mídias citadas no prompt que não estão conectadas: mostra o trecho e conecta a mídia certa
function modalPendenciasPrompt(empresaId, pendencias, opcoes, aoFechar) {
  const TIPO = {
    'sem-codigo': ['⚠️ Mídia citada sem código', 'O prompt fala de mídia, mas sem o código. A IA não sabe QUAL arquivo mandar. Escolha a mídia — o CRM coloca o código certo no prompt.'],
    inexistente: ['✕ Código que não existe', 'Este código não está cadastrado (erro de digitação ou mídia apagada). Escolha a mídia certa — o CRM troca o código no prompt — ou envie o arquivo agora com esse código.'],
    desativada: ['⚠️ Mídia desativada', 'A mídia existe, mas está desativada ("a configurar"). A IA não manda enquanto não ativar.']
  };
  const ICONE = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄', album: '🗂️' };
  const marcar = (trecho, escrito) => (escrito ? esc(trecho).split(esc(escrito)).join(`<mark>${esc(escrito)}</mark>`) : esc(trecho));
  let mudou = false;
  abrirModal(`
    <h2>⚠️ Conecte as mídias citadas no seu prompt</h2>
    <p class="rotulo" style="margin:0 0 12px">Para a IA mandar o arquivo certo, cada mídia citada precisa do <b>código</b> dela (ex.: <code>#MIDIA_TABELA</code>). Resolva abaixo com um clique — o CRM ajusta o prompt para você.</p>
    <div class="lista-pend">${pendencias.map((p) => `
      <div class="pend-prompt" data-pend="${esc(p.id)}">
        <div class="pend-tipo ${p.tipo}">${TIPO[p.tipo][0]} <span class="rotulo">· em ${esc(p.onde)}</span></div>
        <blockquote class="pend-trecho">${marcar(p.trecho, p.escrito)}</blockquote>
        <p class="rotulo" style="margin:4px 0 8px">${TIPO[p.tipo][1]}</p>
        ${p.tipo === 'desativada' ? `<div class="acoes" style="margin:0"><button type="button" class="primario pequeno" data-ativar="${esc(p.id)}">Ativar ${esc(p.codigo)}</button><button type="button" class="pequeno" data-ignorar="${esc(p.id)}">Ignorar</button></div>` : `
        ${p.sugestoes.length ? `<div class="sug-pend">${p.sugestoes.map((x, i) => `<label class="sug-pend-item"><input type="radio" name="esc-${esc(p.id)}" value="${esc(x.codigo)}" ${i === 0 ? 'checked' : ''}>${x.capa ? `<img src="${esc(x.capa)}" alt="" loading="lazy">` : `<span class="ic">${ICONE[x.tipo] || '📎'}</span>`}<span><b>${esc(x.nome)}</b>${i === 0 ? ' <span class="etiqueta ok">mais provável</span>' : ''}<br><span class="rotulo">${esc(x.codigoVisivel)}${x.ativa ? '' : ' · desativada (ativa ao conectar)'}</span></span></label>`).join('')}</div>` : '<p class="rotulo" style="margin:0 0 6px">Nenhuma mídia parecida. Escolha na lista ou envie o arquivo.</p>'}
        <div class="linha-pend">
          <select data-outra="${esc(p.id)}"><option value="">${p.sugestoes.length ? 'Ou escolha outra mídia…' : 'Escolha a mídia…'}</option>${opcoes.map((m) => `<option value="${esc(m.codigo)}">${ICONE[m.tipo] || '📎'} ${esc(m.nome)} · ${esc(codMidia(m.codigo))}</option>`).join('')}</select>
          <button type="button" class="primario pequeno" data-conectar="${esc(p.id)}">Conectar</button>
          <label class="botao pequeno" title="Envia o arquivo e já conecta">📤 Enviar arquivo novo<input type="file" hidden data-novo="${esc(p.id)}" accept="image/*,video/*,audio/*,.pdf"></label>
          <button type="button" class="pequeno" data-ignorar="${esc(p.id)}">${p.tipo === 'sem-codigo' ? 'Não é mídia' : 'Ignorar'}</button>
        </div>`}
        <div class="pend-res" data-res="${esc(p.id)}"></div>
      </div>`).join('')}</div>
    <div class="acoes"><button type="button" class="primario" data-fechar>Pronto</button></div>`, (m, fechar) => {
    m.querySelector('.modal').classList.add('modal-largo');
    new MutationObserver((_, obs) => { if (!m.isConnected) { obs.disconnect(); if (mudou) aoFechar?.(); } }).observe(document.body, { childList: true });
    const feito = (pid, html) => {
      const card = $(`[data-pend="${pid}"]`, m);
      card.classList.add('resolvida');
      $$('button, select, input, label.botao', card).forEach((x) => { x.disabled = true; if (x.tagName === 'LABEL') x.hidden = true; });
      $(`[data-res="${pid}"]`, m).innerHTML = html;
      mudou = true;
    };
    const conectar = async (pid, codigo, botao) => {
      const r = await comEspera(botao, () => api(`empresas/${empresaId}/midias/prompt/conectar`, { method: 'POST', body: { id: pid, codigo } }), 'Conectando…');
      feito(pid, r.ativou ? `✓ ${esc(r.ativou)} ativada — a IA já pode mandar.` : `✓ Conectado com <b>${esc(r.codigo)}</b>. O prompt agora diz: <i>“${esc(r.trecho)}”</i>`);
    };
    $$('[data-conectar]', m).forEach((b) => {
      b.onclick = async () => {
        const pid = b.dataset.conectar;
        const codigo = $(`[data-outra="${pid}"]`, m).value || $(`input[name="esc-${pid}"]:checked`, m)?.value;
        if (!codigo) return aviso('Escolha a mídia que o prompt está citando.', true);
        try { await conectar(pid, codigo, b); } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-ativar]', m).forEach((b) => { b.onclick = async () => { try { await conectar(b.dataset.ativar, '', b); } catch (err) { aviso(err.message, true); } }; });
    $$('[data-ignorar]', m).forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`empresas/${empresaId}/midias/prompt/ignorar`, { method: 'POST', body: { id: b.dataset.ignorar } });
          feito(b.dataset.ignorar, '<span class="rotulo">Ignorado — este trecho não vai mais aparecer aqui.</span>');
        } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-novo]', m).forEach((inp) => {
      inp.onchange = async () => {
        const arq = inp.files[0];
        inp.value = '';
        if (!arq) return;
        const p = pendencias.find((x) => x.id === inp.dataset.novo);
        const res = $(`[data-res="${p.id}"]`, m);
        res.innerHTML = '<span class="rotulo">⏳ Enviando o arquivo…</span>';
        try {
          const nova = await subirMidiaEmPedacos(empresaId, arq);
          // código inexistente: a mídia nova ganha EXATAMENTE o código que o prompt cita
          await api(`empresas/${empresaId}/midias/${nova.id}`, { method: 'PUT', body: { ...(p.tipo === 'inexistente' ? { codigo: p.codigo } : {}), descricao: p.trecho.slice(0, 300), pronta: true } });
          if (p.tipo === 'inexistente') feito(p.id, `✓ Arquivo enviado com o código <b>${esc(p.codigo)}</b> — o prompt já funciona.`);
          else await conectar(p.id, nova.codigo, null);
        } catch (err) {
          res.innerHTML = `<span class="det-erro">✕ ${esc(err.message)}</span>`;
        }
      };
    });
  });
}

function modalVenda(emp, v, leadId, depois, padrao = {}) {
  const agora = new Date(v ? v.data : Date.now());
  const local = new Date(agora.getTime() - agora.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  abrirModal(`
    <h2>${v ? 'Editar venda' : 'Lançar venda'}</h2>
    <form id="f-venda">
      <div class="campos">
        <div class="campo"><label>Valor (R$) *</label><input name="valor" required inputmode="decimal" value="${v ? esc(String(v.valor).replace('.', ',')) : ''}" placeholder="150,00"></div>
        <div class="campo"><label>Forma de pagamento</label><select name="forma">${['Pix', 'Dinheiro', 'Cartão', 'Boleto', 'Transferência', 'Outro'].map((f) => `<option ${f === (v?.forma || 'Pix') ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
        <div class="campo"><label>Data</label><input type="datetime-local" name="data" value="${local}"></div>
        <div class="campo"><label>Cliente</label><input name="cliente" value="${esc(v?.cliente || padrao.cliente || '')}" placeholder="Nome do cliente"></div>
        <div class="campo largo"><label>O que foi vendido (opcional)</label><input name="descricao" value="${esc(v?.descricao || '')}" placeholder="Ex.: o que foi vendido"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button>${v ? '<button type="button" class="perigo" id="apagar-venda" style="margin-left:auto">Apagar</button>' : ''}</div>
    </form>`, (m, fechar) => {
    $('#f-venda', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formParaObjeto(e.target);
      const corpo = { ...f, data: f.data ? new Date(f.data).toISOString() : undefined, ...(leadId ? { leadId } : {}) };
      try {
        await api(v ? `empresas/${emp.id}/vendas/${v.id}` : `empresas/${emp.id}/vendas`, { method: v ? 'PUT' : 'POST', body: corpo });
        fechar();
        aviso('Venda salva.');
        depois?.();
      } catch (err) { aviso(err.message, true); }
    };
    $('#apagar-venda', m)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Apagar esta venda?', texto: 'Ela sai do faturamento. Para só não contar, prefira "Cancelar".', botao: 'Apagar', perigo: true }))) return;
      try {
        await api(`empresas/${emp.id}/vendas/${v.id}`, { method: 'DELETE' });
        fechar();
        depois?.();
      } catch (err) { aviso(err.message, true); }
    });
  });
}

// ---------------------------------------------------------------- empresa: aprendizados da IA (varredura das conversas)

// 🧬 Clone (Aprendizados da IA, junto do "O que a IA aprendeu"): aprende com as
// respostas manuais das conversas que viraram venda; com 10, fica completo
async function cartaoClone(id) {
  const el = $('#ap-clone');
  if (!el) return;
  let c;
  try { c = await api(`empresas/${id}/clone`); } catch (err) { el.innerHTML = `<div class="card"><p class="erro-caixa">${esc(err.message)}</p></div>`; return; }
  if (!el.isConnected) return;
  const feito = Math.min(c.conversas, c.meta);
  const nome = c.nome || 'o clone';
  el.innerHTML = `
    <div class="card clone-card ${c.ativo ? 'ligado' : ''}">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">🧬 Clone${c.nome ? `: ${esc(c.nome)}` : ''}</h2>${interruptor('clone-ativo', c.ativo, c.ativo ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0 0 10px">Aprende com as <b>respostas que você (ou a equipe) escreveu à mão</b> nas conversas que <b>viraram venda</b> — tom, tamanho, preço, como fecha e as mídias que mandou. Com <b>${c.meta} vendas</b> o aprendizado fica completo e ele responde igual a você. Não gasta IA para aprender.</p>
      <div class="clone-progresso"><div class="barra-clone"><span style="width:${Math.round((feito / c.meta) * 100)}%"></span></div><b>${feito}/${c.meta}</b> conversas vendidas${c.completo ? ' · <span class="etiqueta ok">✓ aprendizado completo</span>' : ` · faltam ${c.meta - feito}`}</div>
      <p class="rotulo" style="margin:6px 0 12px">${c.total} resposta(s) manual(is) aprendida(s)${c.midiasAprendidas ? ` · ${c.midiasAprendidas} mídia(s) na biblioteca` : ''}.</p>
      <form id="f-clone" class="linha-form" style="flex-wrap:wrap;margin-bottom:10px"><input name="nome" maxlength="40" value="${esc(c.nome)}" placeholder="Nome do clone (ex.: Teodósio)"><button type="submit">Salvar nome</button></form>
      ${interruptor('clone-responder', c.responder, `Responder igual ao operador${c.completo ? '' : ' (já usa o que aprendeu; fica 100% com ' + c.meta + ' vendas)'}`)}
      <div class="acoes" style="margin-top:12px">
        <a class="botao" href="api/empresas/${esc(id)}/clone/arquivo">⬇️ Baixar o arquivo do clone</a>
        ${c.total ? '<button type="button" id="ver-clone">Ver o que aprendeu</button>' : ''}
      </div>
    </div>`;
  const salvarClone = async (corpo, msg) => {
    try { await api(`empresas/${id}/clone`, { method: 'PUT', body: corpo }); aviso(msg); cartaoClone(id); } catch (err) { aviso(err.message, true); cartaoClone(id); }
  };
  $('#clone-ativo').onchange = (e) => salvarClone({ ativo: e.target.checked }, e.target.checked ? `Clone ligado: ${nome} está aprendendo com as suas vendas.` : 'Clone desligado.');
  $('#clone-responder').onchange = (e) => salvarClone({ responder: e.target.checked, ...(e.target.checked ? { ativo: true } : {}) }, e.target.checked ? `A IA responde igual a ${nome}.` : 'A IA volta a responder no estilo normal.');
  $('#f-clone').onsubmit = (e) => { e.preventDefault(); salvarClone({ nome: e.target.elements.nome.value }, 'Nome salvo.'); };
  $('#ver-clone')?.addEventListener('click', () => modalClone(id, () => cartaoClone(id)));
}

async function paginaAprendizado(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const a = await api(`empresas/${id}/aprendizado`);
  const rodando = a.rodando;
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Clone e aprendizados</h1><p class="sub">A IA aprende com o seu site, com os seus anúncios e com as conversas do seu WhatsApp</p></div>
      <div class="barra"><a class="botao" href="api/empresas/${esc(id)}/aprendizado/arquivo">⬇️ Baixar arquivo</a><button type="button" class="primario" id="varrer" ${rodando || !emp.whatsapp?.configurado ? 'disabled' : ''}>🔍 Varrer agora</button></div>
    </div>
    <div class="chips atalhos-secao">
      <button type="button" class="chip-filtro" data-ir="ap-site">🌐 Seu site</button>
      <button type="button" class="chip-filtro" data-ir="ap-anuncios">📣 Anúncios e campanhas</button>
      <button type="button" class="chip-filtro" data-ir="ap-conversas">💬 Conversas do WhatsApp</button>
      <button type="button" class="chip-filtro" data-ir="ap-clone">🧬 Clone</button>
    </div>
    <div id="area-site"></div>
    <div id="area-anuncios"></div>

    <h2 id="ap-conversas" style="margin-top:28px">💬 Conversas do WhatsApp</h2>
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `<a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    ${balao('Como funciona', `${passos([
      'Todo dia às <b>8h</b> (ou quando você clicar em <b>Varrer agora</b>) a IA lê as conversas do WhatsApp.',
      'Da primeira vez ela lê o histórico; depois, <b>só as mensagens novas</b>. Conversa com <b>venda concluída</b> é lida uma última vez e depois não é mais lida.',
      'Ela estuda <b>só as conversas que deram venda</b> (comprovante, venda marcada ou lead em "Vendi") e anota o que funcionou: jeito de falar, perguntas, preços, como respondeu objeções e como fechou — sem guardar dados pessoais. Conversa que não vendeu fica de fora.',
      'A IA do WhatsApp e a do site usam esse arquivo para atender cada vez mais parecido com você. Você pode ler, corrigir ou desligar.'
    ])}`)}

    ${rodando ? `<div class="card varredura-andamento"><span class="girando"></span> <b>${esc(rodando.etapa)}</b><div class="rotulo">${rodando.lidas} de ${rodando.conversas} conversas verificadas · ${rodando.mensagens} mensagens novas · ${rodando.lotes} ${rodando.lotes === 1 ? 'parte estudada' : 'partes estudadas'}</div></div>` : ''}

    <div class="grade-resumo">
      ${numeroCard('Última varredura', a.ultimaVarredura ? data(a.ultimaVarredura) : 'nunca', 'numero-texto')}
      ${numeroCard('Conversas acompanhadas', a.conversasConhecidas)}
      ${numeroCard('Vendas concluídas (não lê mais)', a.conversasConcluidas)}
      ${numeroCard('Ficou para a próxima', a.pendentes || 0)}
    </div>

    <div class="card">
      ${interruptor('diario', a.diario, 'Varrer sozinho todo dia às 8h')}
      <div style="height:10px"></div>
      ${interruptor('usar', a.usarNoPrompt, 'A IA usa estes aprendizados para atender')}
      <div style="height:10px"></div>
      ${interruptor('somente-vendas', a.somenteVendas !== false, 'Aprender só com conversas que deram venda (recomendado)')}
    </div>

    <form class="card" id="f-aprendizado">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">📘 O que a IA aprendeu</h2><span class="rotulo">${(a.texto || '').split(/\s+/).filter(Boolean).length} palavras</span></div>
      <p class="rotulo" style="margin:0 0 10px">Pode corrigir à vontade: a próxima varredura continua a partir do que estiver aqui.</p>
      <textarea class="grande" name="texto" placeholder="Ainda vazio. Clique em &quot;Varrer agora&quot; para a IA ler as suas conversas.">${esc(a.texto || '')}</textarea>
      <div class="acoes"><button class="primario" type="submit">Salvar alterações</button></div>
    </form>

    <div id="ap-clone"><div class="card"><p class="rotulo">Carregando o clone…</p></div></div>

    ${a.historico.length ? `
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Quando</th><th>Como</th><th>Conversas lidas</th><th class="esconde-mobile">Mensagens</th><th>Situação</th></tr></thead>
        <tbody>${a.historico.map((h) => `<tr><td>${data(h.em)}</td><td class="rotulo">${esc(h.motivo)}</td><td>${h.conversas}${h.concluidasIgnoradas ? ` <span class="rotulo">(+${h.concluidasIgnoradas} já estudadas)</span>` : ''}${h.semVenda ? ` <span class="rotulo">· ${h.semVenda} sem venda ignoradas</span>` : ''}</td><td class="esconde-mobile">${h.mensagens}</td><td>${h.status === 'ok' ? '<span class="etiqueta ok">✓ ok</span>' : `<span class="etiqueta off">erro</span> <span class="rotulo">${esc(h.erro)}</span>`}${h.pendentes ? ` <span class="rotulo">· ${h.pendentes} para a próxima</span>` : ''}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}

    <details class="card secao-avancada"><summary>Recomeçar do zero</summary>
      <p class="rotulo">Apaga o arquivo e faz a IA ler todas as conversas de novo na próxima varredura.</p>
      <button type="button" class="perigo" id="zerar">Apagar aprendizados e recomeçar</button>
    </details>`;

  $$('[data-ir]').forEach((b) => { b.onclick = () => document.getElementById(b.dataset.ir)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  montarSiteDaEmpresa(id, $('#area-site'));
  montarAnuncios(id, $('#area-anuncios'));
  cartaoClone(id);
  $('#varrer')?.addEventListener('click', async (e) => {
    try {
      await comEspera(e.target, () => api(`empresas/${id}/aprendizado/varrer`, { method: 'POST' }), 'Começando…');
      aviso('Varredura começou. Pode continuar usando o painel.');
      paginaAprendizado(id);
    } catch (err) { aviso(err.message, true); }
  });
  $('#diario').onchange = (e) => api(`empresas/${id}/aprendizado`, { method: 'PUT', body: { diario: e.target.checked } }).then(() => aviso(e.target.checked ? 'Vai varrer todo dia às 8h.' : 'Varredura diária desligada.')).catch((err) => aviso(err.message, true));
  $('#usar').onchange = (e) => api(`empresas/${id}/aprendizado`, { method: 'PUT', body: { usarNoPrompt: e.target.checked } }).then(() => aviso(e.target.checked ? 'A IA vai usar os aprendizados.' : 'A IA não vai usar os aprendizados.')).catch((err) => aviso(err.message, true));
  $('#somente-vendas').onchange = (e) => api(`empresas/${id}/aprendizado`, { method: 'PUT', body: { somenteVendas: e.target.checked } }).then(() => aviso(e.target.checked ? 'Só conversas com venda.' : 'Todas as conversas.')).catch((err) => aviso(err.message, true));
  $('#f-aprendizado').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`empresas/${id}/aprendizado`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Aprendizados salvos.');
    } catch (err) { aviso(err.message, true); }
  };
  $('#zerar').onclick = async () => {
    if (!(await confirmar({ titulo: 'Apagar os aprendizados?', texto: 'A IA esquece o que aprendeu e lê todas as conversas de novo na próxima varredura.', botao: 'Apagar e recomeçar', perigo: true }))) return;
    try {
      await api(`empresas/${id}/aprendizado/zerar`, { method: 'POST' });
      paginaAprendizado(id);
    } catch (err) { aviso(err.message, true); }
  };
  if (rodando) {
    const aqui = location.hash;
    atualizador = setInterval(async () => {
      if (location.hash !== aqui) return void clearInterval(atualizador);
      const novo = await api(`empresas/${id}/aprendizado`).catch(() => null);
      if (!novo) return;
      if (!novo.rodando) {
        clearInterval(atualizador);
        aviso(novo.historico[0]?.status === 'erro' ? `A varredura deu erro: ${novo.historico[0].erro}` : 'Varredura concluída!', novo.historico[0]?.status === 'erro');
        return void paginaAprendizado(id);
      }
      // só o quadro do andamento muda (não apaga o que a pessoa está digitando)
      const r = novo.rodando;
      const quadro = $('.varredura-andamento');
      if (quadro) quadro.innerHTML = `<span class="girando"></span> <b>${esc(r.etapa)}</b><div class="rotulo">${r.lidas} de ${r.conversas} conversas verificadas · ${r.mensagens} mensagens novas · ${r.lotes} ${r.lotes === 1 ? 'parte estudada' : 'partes estudadas'}</div>`;
    }, 2500);
  }
}

// ---------------------------------------------------------------- usuários (admin)

async function paginaUsuarios() {
  const hashDaPagina = location.hash;
  const [lista, empresas] = await Promise.all([api('usuarios'), api('empresas')]);
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Usuários</h1><p class="sub">Quem entra no painel</p></div><button class="primario" id="novo">+ Novo usuário</button></div>
    ${balao('Dê acesso ao dono da empresa', 'Crie um <b>usuário de empresa</b>: ele entra direto na empresa dele, só vê o que é dela e consegue configurar tudo sozinho (chave de IA, WhatsApp, mídias, disparos).')}
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Nome</th><th class="esconde-mobile">E-mail</th><th>Acesso</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${lista.map((u) => `
            <tr>
              <td>${esc(u.nome)}</td>
              <td class="esconde-mobile">${esc(u.email)}</td>
              <td>${u.papel === 'admin' ? 'Administrador' : `Empresa: ${esc(u.empresaNome || '—')}`}</td>
              <td>${u.ativo ? '<span class="etiqueta ok">Ativo</span>' : '<span class="etiqueta off">Bloqueado</span>'}</td>
              <td><button class="pequeno" data-editar="${esc(u.id)}">Editar</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  $('#novo').onclick = () => modalUsuario(null, empresas);
  $$('[data-editar]').forEach((b) => {
    b.onclick = () => modalUsuario(lista.find((u) => u.id === b.dataset.editar), empresas);
  });
}

function modalUsuario(u, empresas) {
  abrirModal(`
    <h2>${u ? 'Editar usuário' : 'Novo usuário'}</h2>
    <form id="f-usr">
      <div class="campos">
        <div class="campo"><label>Nome *</label><input name="nome" required value="${esc(u?.nome)}"></div>
        <div class="campo"><label>E-mail *</label><input name="email" type="email" required value="${esc(u?.email)}"></div>
        <div class="campo"><label>Acesso</label><select name="papel"><option value="empresa" ${u?.papel !== 'admin' ? 'selected' : ''}>Usuário de empresa</option><option value="admin" ${u?.papel === 'admin' ? 'selected' : ''}>Administrador</option></select></div>
        <div class="campo" id="campo-empresa"><label>Empresa</label><select name="empresaId"><option value="">Escolha…</option>${empresas.map((e) => `<option value="${esc(e.id)}" ${e.id === u?.empresaId ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}</select></div>
        <div class="campo largo"><label>${u ? 'Nova senha (deixe vazio para manter)' : 'Senha *'}</label><input name="senha" type="password" minlength="8" autocomplete="new-password" ${u ? '' : 'required'}></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativo" ${u?.ativo === false ? '' : 'checked'}> Pode entrar no painel</label></div>
      </div>
      <div class="acoes">
        <button class="primario" type="submit">Salvar</button>
        <button type="button" data-fechar>Cancelar</button>
        ${u && u.id !== sessao.usuario.id ? '<button type="button" class="perigo" id="excluir" style="margin-left:auto">Excluir</button>' : ''}
      </div>
    </form>`, (m, fechar) => {
    const papel = $('[name=papel]', m);
    const ajustar = () => { $('#campo-empresa', m).hidden = papel.value === 'admin'; };
    papel.onchange = ajustar;
    ajustar();
    $('#f-usr', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(u ? `usuarios/${u.id}` : 'usuarios', { method: u ? 'PUT' : 'POST', body: formParaObjeto(e.target) });
        fechar();
        aviso('Usuário salvo.');
        paginaUsuarios();
      } catch (err) { aviso(err.message, true); }
    };
    const excluir = $('#excluir', m);
    if (excluir) excluir.onclick = async () => {
      if (!(await confirmar({ titulo: `Excluir ${u.email}?`, texto: 'A pessoa perde o acesso ao painel.', botao: 'Excluir', perigo: true }))) return;
      try {
        await api(`usuarios/${u.id}`, { method: 'DELETE' });
        fechar();
        paginaUsuarios();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- aprendizados: o site da empresa

async function montarSiteDaEmpresa(id, alvo) {
  if (!alvo) return;
  const aqui = location.hash;
  let s;
  try {
    s = await api(`empresas/${id}/site`);
  } catch (err) {
    alvo.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`;
    return;
  }
  if (location.hash !== aqui || !alvo.isConnected) return;
  const tudoPouco = s.paginas.length > 0 && s.paginas.every((p) => p.poucoTexto);
  const algumasPoucas = s.paginas.filter((p) => p.poucoTexto).length;
  const comTexto = s.paginas.length - algumasPoucas;
  // resposta clara: deu para ler o site só com o link?
  const statusLeitura = s.lendo || !s.links.length
    ? ''
    : s.erro && !s.paginas.length
      ? `<div class="status-leitura ruim">✕ <div><b>Não consegui ler o site só com o link.</b> ${esc(s.erro)} Confira o endereço ou <b>cole a copy do site</b> no campo abaixo.</div></div>`
      : !s.paginas.length
        ? '<div class="status-leitura">ℹ️ <div>Ainda não li o site. Clique em <b>Salvar e ler o site</b>.</div></div>'
        : tudoPouco
          ? `<div class="status-leitura ruim">⚠️ <div><b>Não consegui ler o conteúdo do site só com o link.</b> Abri ${s.paginas.length} página(s), mas o site monta o texto no navegador (comum em sites feitos no Lovable/React) e o CRM só enxerga o título. <b>Cole a copy do site no campo abaixo</b> para a IA conhecer tudo.</div></div>`
          : `<div class="status-leitura bom">✓ <div><b>Consegui ler o site só com o link:</b> ${comTexto} página(s) com texto${algumasPoucas ? ` (${algumasPoucas} com pouco texto — se forem importantes, cole a copy delas abaixo)` : ''}. A IA já usa esse conteúdo.</div></div>`;
  alvo.innerHTML = `
    <div class="card" id="ap-site">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">🌐 Seu site</h2>${interruptor('site-usar', s.usar, 'A IA usa o site')}</div>
      ${statusLeitura}
      <p class="rotulo" style="margin:0 0 12px">Cole o link do seu site: o CRM lê as páginas (produtos, serviços, preços, a copy de vendas) e as duas IAs passam a conhecer tudo e a vender com as mesmas palavras. Se preferir, cole o texto do site no campo de baixo. O site é lido de novo sozinho toda semana.</p>
      <form id="f-site">
        <div class="campo"><label>Links do seu site ${ajuda('Um por linha. Comece pela página inicial; com a opção de baixo marcada, o CRM também abre as páginas que ela liga (produtos, serviços, sobre…), até 20.')}</label><textarea name="links" rows="3" placeholder="https://minhaloja.com.br&#10;https://minhaloja.com.br/produtos">${esc(s.links.join('\n'))}</textarea></div>
        <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="seguirLinks" ${s.seguirLinks ? 'checked' : ''}> Ler também as páginas ligadas (até 20 páginas)</label>
        <div class="campo" style="margin-top:12px"><label>Copy do site (opcional) ${ajuda('Cole aqui textos que você quer que a IA use: a página de vendas, o catálogo, descrições de produtos, perguntas frequentes. Útil quando o site mostra pouco texto para o CRM.')}</label><textarea name="copia" class="grande" style="min-height:140px" maxlength="${s.maxCopia}" placeholder="Cole aqui o texto do seu site, da página de vendas ou do catálogo…">${esc(s.copia)}</textarea><small id="site-contador">${s.copia.length.toLocaleString('pt-BR')} de ${s.maxCopia.toLocaleString('pt-BR')} caracteres</small></div>
        <div class="acoes"><button class="primario" type="submit" ${s.lendo ? 'disabled' : ''}>${s.links.length ? 'Salvar e ler o site' : 'Salvar'}</button>${s.links.length && !s.lendo ? '<button type="button" id="site-reler">Ler de novo agora</button>' : ''}</div>
      </form>
      ${s.lendo ? `<div class="varredura-andamento" style="margin-top:12px"><span class="girando"></span> <b>Lendo o site…</b><div class="rotulo">${s.lendo.lidas} de ${s.lendo.total} páginas</div></div>` : ''}
      ${s.erro ? `<p class="erro-caixa" style="margin-top:12px">${esc(s.erro)}</p>` : ''}

      ${s.paginas.length ? `
      <div class="tabela-wrap" style="margin-top:12px"><table>
        <thead><tr><th>Página lida</th><th style="width:130px">Texto</th></tr></thead>
        <tbody>${s.paginas.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.titulo || caminhoDe(p.url))}</a><div class="rotulo" style="font-size:12px">${esc(caminhoDe(p.url))}</div></td><td>${p.poucoTexto ? `<span class="etiqueta aviso">pouco texto</span>` : `${p.caracteres.toLocaleString('pt-BR')} caracteres`}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
      <p class="rotulo" style="margin:10px 0 0">${s.lidoEm ? `Lido em ${data(s.lidoEm)} · ` : ''}${s.caracteresNaIa ? `a IA recebe ${s.caracteresNaIa.toLocaleString('pt-BR')} caracteres do site${s.usar ? '' : ' (desligado)'}` : 'a IA ainda não recebe nada do site'}</p>
    </div>`;
  const form = $('#f-site', alvo);
  form.elements.copia.oninput = (e) => { $('#site-contador', alvo).textContent = `${e.target.value.length.toLocaleString('pt-BR')} de ${s.maxCopia.toLocaleString('pt-BR')} caracteres`; };
  const ler = async (botao) => {
    await comEspera(botao, () => api(`empresas/${id}/site/ler`, { method: 'POST' }), 'Lendo…');
    aviso('Lendo o site. Pode continuar usando o painel.');
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const botao = e.submitter || $('button[type=submit]', form);
    try {
      const salvo = await comEspera(botao, () => api(`empresas/${id}/site`, { method: 'PUT', body: { links: form.elements.links.value.split(/\s+/).filter(Boolean), seguirLinks: form.elements.seguirLinks.checked, copia: form.elements.copia.value } }), 'Salvando…');
      if (salvo.links.length) await ler(botao);
      else aviso('Salvo.');
      montarSiteDaEmpresa(id, alvo);
    } catch (err) { aviso(err.message, true); }
  };
  $('#site-reler', alvo)?.addEventListener('click', async (e) => {
    try { await ler(e.target); montarSiteDaEmpresa(id, alvo); } catch (err) { aviso(err.message, true); }
  });
  $('#site-usar', alvo).onchange = (e) => api(`empresas/${id}/site`, { method: 'PUT', body: { usar: e.target.checked } }).then(() => aviso(e.target.checked ? 'A IA vai usar o site.' : 'A IA não vai usar o site.')).catch((err) => aviso(err.message, true));
  if (s.lendo) setTimeout(() => { if (location.hash === aqui && alvo.isConnected) montarSiteDaEmpresa(id, alvo); }, 2000);
}

// ---------------------------------------------------------------- UTM prontas para os anúncios da empresa
function htmlSugestoesUtm() {
  const nome = String(empresaAtual?.dados?.nome || empresaAtual?.nome || 'empresa').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'empresa';
  const linha = (onde, valor, dica) => `<div class="utm-linha"><div class="utm-onde">${onde}</div><div class="utm-valor"><code>${esc(valor)}</code><button type="button" class="pequeno" data-copiar-utm>Copiar</button></div>${dica ? `<small class="rotulo">${dica}</small>` : ''}</div>`;
  return `
    <details class="utm-card"><summary>🎯 UTMs prontas para saber de onde vem cada lead (Google Ads e Meta Ads)</summary>
      <p class="rotulo" style="margin:8px 0 12px">Coloque uma vez em cada plataforma. Depois disso o CRM mostra, em cada lead, qual anúncio/campanha trouxe o cliente — e a IA já sabe o que ele viu.</p>
      <h4>Google Ads</h4>
      ${linha('Conta → Configurações da conta → <b>Modelo de acompanhamento</b> (ou em cada campanha → Opções de URL da campanha)', '{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}', 'O Google troca {campaignid}, {keyword} etc. sozinho. O gclid também é reconhecido automaticamente.')}
      <h4>Meta Ads (Facebook e Instagram)</h4>
      ${linha('Gerenciador de Anúncios → no <b>anúncio</b> → Rastreamento → <b>Parâmetros de URL</b>', 'utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}', 'O Meta preenche o nome da campanha e do anúncio. {{site_source_name}} vira fb ou ig.')}
      ${linha('Anúncio de <b>clique para WhatsApp</b>: nada para configurar', '(o CRM lê o título do anúncio sozinho na 1ª mensagem)', 'Dica: na mensagem pronta do anúncio, use algo único, ex.: "Oi! Vi a promoção de inverno" — e cadastre "promoção de inverno" nas palavras abaixo.')}
      <h4>Links que não são anúncio</h4>
      ${linha('Link da <b>bio do Instagram</b>', `?utm_source=instagram&utm_medium=bio&utm_campaign=${nome}`, 'Coloque depois do endereço do site. Ex.: https://seusite.com.br/?utm_source=instagram…')}
      ${linha('Botão do <b>Google Meu Negócio</b> (site)', `?utm_source=google&utm_medium=perfil-empresa&utm_campaign=${nome}`, '')}
      ${linha('Link enviado em <b>disparos/WhatsApp</b>', `?utm_source=whatsapp&utm_medium=disparo&utm_campaign=${nome}-promo`, 'Troque "promo" pelo nome da campanha.')}
      <p class="rotulo" style="margin:10px 0 0">Depois, cadastre cada campanha abaixo usando o nome do <code>utm_campaign</code> nas palavras — e escreva o que a IA precisa saber sobre ela.</p>
    </details>`;
}

// ---------------------------------------------------------------- aprendizados: anúncios e campanhas

async function montarAnuncios(id, alvo) {
  if (!alvo) return;
  const aqui = location.hash;
  let d;
  try {
    d = await api(`empresas/${id}/anuncios`);
  } catch (err) {
    alvo.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`;
    return;
  }
  if (location.hash !== aqui || !alvo.isConnected) return;
  let lista = d.anuncios.map((a) => ({ ...a, palavras: a.palavras.join(', ') }));
  let alterado = false;

  const itemHtml = (a, i) => `
    <div class="anuncio-item" data-i="${i}">
      <div class="anuncio-topo">
        <input data-campo="nome" value="${esc(a.nome)}" placeholder="Nome do anúncio (ex.: Promoção de inverno)" aria-label="Nome do anúncio">
        ${a.id ? `<span class="rotulo" style="white-space:nowrap">${a.leads30d || 0} ${a.leads30d === 1 ? 'lead' : 'leads'} em 30 dias</span>` : '<span class="etiqueta">novo</span>'}
        <button type="button" class="pequeno perigo" data-remover="${i}" aria-label="Remover anúncio">Remover</button>
      </div>
      <div class="campo"><label>Palavras para reconhecer ${ajuda('O CRM liga o cliente a este anúncio quando alguma destas palavras aparece: no título do anúncio do Instagram/Facebook, no utm_campaign do link, no endereço da página ou na mensagem pronta do anúncio. Separe por vírgula.')}</label><input data-campo="palavras" value="${esc(a.palavras)}" placeholder="Ex.: promo-inverno, vi a promoção"></div>
      <div class="campo"><label>O que a IA precisa saber sobre este anúncio ${ajuda('A oferta, o preço anunciado, a condição, para quem é e como a IA deve puxar a conversa. Ex.: “Anúncio do serviço X por R$ 299 em 3x só este mês. Pergunte o que o cliente precisa e ofereça horário.”')}</label><textarea data-campo="info" rows="3" placeholder="Ex.: Oferta do serviço X por R$ 299 em 3x até o fim do mês. Pergunte o que o cliente precisa e ofereça um horário.">${esc(a.info)}</textarea></div>
    </div>`;

  const desenhar = () => {
    alvo.innerHTML = `
      <div class="card" id="ap-anuncios">
        <h2 style="margin:0 0 6px">📣 Anúncios e campanhas</h2>
        <p class="rotulo" style="margin:0 0 10px">Cadastre cada anúncio e explique para a IA o que ele oferece. Quando um cliente chega por esse anúncio, a IA do site e a do WhatsApp já sabem do que ele está falando — e você vê quantos leads cada anúncio trouxe.</p>
        <details ${lista.length ? '' : 'open'}><summary>Como o CRM sabe de qual anúncio o cliente veio?</summary>${passos([
          '<b>Anúncio de clique para WhatsApp</b> (Instagram/Facebook): o CRM lê o título do anúncio sozinho. Ele aparece abaixo em “Anúncios que chegaram” — é só clicar em <b>Cadastrar</b>.',
          '<b>Anúncio que leva para o site</b>: no link do anúncio, coloque <code>?utm_campaign=nome-da-campanha</code> e use esse nome nas palavras. O Google Ads e o Facebook Ads já são reconhecidos como anúncio sozinhos.',
          '<b>Mensagem pronta do anúncio</b> (ex.: “Quero a promoção de inverno”): use um pedaço dela nas palavras.',
          'Errou? No lead, em <b>De onde veio</b>, a equipe escolhe o anúncio certo à mão.'
        ])}</details>
        ${htmlSugestoesUtm()}
        <div id="lista-anuncios">${lista.map(itemHtml).join('') || '<p class="rotulo" style="margin:12px 0 0">Nenhum anúncio cadastrado ainda.</p>'}</div>
        <div class="acoes"><button type="button" id="add-anuncio">+ Adicionar anúncio</button><button type="button" class="primario" id="salvar-anuncios">Salvar anúncios</button></div>
        ${d.detectados.length || d.campanhas.length ? `
        <div class="secao" style="margin-top:16px;padding-top:14px">
          <h3 style="margin:0 0 8px;font-size:15px">Anúncios que chegaram e ainda não estão cadastrados</h3>
          <div class="detectados">
            ${d.detectados.map((ad, i) => `<div class="detectado"><div><b>${esc(ad.titulo || ad.url || `Anúncio ${ad.id}`)}</b>${ad.texto ? `<div class="rotulo">${esc(ad.texto.slice(0, 140))}</div>` : ''}<div class="rotulo">📣 clique para WhatsApp · ${ad.leads} ${ad.leads === 1 ? 'lead' : 'leads'}</div></div><button type="button" class="pequeno" data-cadastrar-ad="${i}">Cadastrar</button></div>`).join('')}
            ${d.campanhas.map((c, i) => `<div class="detectado"><div><b>${esc(c.nome)}</b><div class="rotulo">🔗 campanha (utm_campaign) · ${c.leads} ${c.leads === 1 ? 'lead' : 'leads'}</div></div><button type="button" class="pequeno" data-cadastrar-camp="${i}">Cadastrar</button></div>`).join('')}
          </div>
        </div>` : ''}
      </div>`;
    $$('[data-campo]', alvo).forEach((el) => {
      el.oninput = () => {
        lista[Number(el.closest('[data-i]').dataset.i)][el.dataset.campo] = el.value;
        alterado = true;
      };
    });
    $$('[data-remover]', alvo).forEach((b) => { b.onclick = () => { lista.splice(Number(b.dataset.remover), 1); alterado = true; desenhar(); }; });
    $('#add-anuncio', alvo).onclick = () => {
      lista.push({ nome: '', palavras: '', info: '' });
      desenhar();
      $$('[data-campo="nome"]', alvo).pop()?.focus();
    };
    const adicionar = (nome, palavras) => {
      lista.push({ nome: nome.slice(0, 80), palavras, info: '' });
      alterado = true;
      desenhar();
      const ultimo = $$('.anuncio-item', alvo).pop();
      ultimo?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('[data-campo="info"]', ultimo)?.focus();
      aviso('Agora escreva o que a IA precisa saber sobre este anúncio e salve.');
    };
    $$('[data-cadastrar-ad]', alvo).forEach((b) => {
      b.onclick = () => {
        const ad = d.detectados[Number(b.dataset.cadastrarAd)];
        adicionar(ad.titulo || 'Anúncio do Instagram/Facebook', [ad.titulo, ad.id].filter(Boolean).join(', '));
      };
    });
    $$('[data-cadastrar-camp]', alvo).forEach((b) => {
      b.onclick = () => {
        const c = d.campanhas[Number(b.dataset.cadastrarCamp)];
        adicionar(c.nome, c.nome);
      };
    });
    $('#salvar-anuncios', alvo).onclick = async (e) => {
      try {
        d = await comEspera(e.target, () => api(`empresas/${id}/anuncios`, { method: 'PUT', body: { anuncios: lista } }), 'Salvando…');
        lista = d.anuncios.map((a) => ({ ...a, palavras: a.palavras.join(', ') }));
        alterado = false;
        aviso('Anúncios salvos. A IA já usa nas próximas conversas.');
        desenhar();
      } catch (err) { aviso(err.message, true); }
    };
  };
  desenhar();
  alvo.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copiar-utm]');
    if (!b) return;
    const texto = b.previousElementSibling?.textContent || '';
    navigator.clipboard?.writeText(texto).then(() => aviso('Copiado. Cole no lugar indicado.')).catch(() => aviso(texto));
  });
  window.addEventListener('beforeunload', (e) => { if (alterado && location.hash === aqui) e.preventDefault(); }, { once: true });
}

// ---------------------------------------------------------------- configurações do sistema (admin)

async function paginaConfiguracoes() {
  const hashDaPagina = location.hash;
  const c = await api('config');
  const linha = (id, nome, campo, onde, dica) => `
    <div class="card">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">${nome}</h2>${c[id].configurada ? `<span><span class="etiqueta ok">Configurada</span> <span class="rotulo">termina em ${esc(c[id].final)}</span></span>` : '<span class="etiqueta">Sem chave padrão</span>'}</div>
      <form data-provedor="${id}">
        <div class="campo"><label>${c[id].configurada ? 'Trocar chave' : 'Chave de API'}</label><input name="${campo}" type="password" autocomplete="off" placeholder="${esc(dica)}"><small>Crie em <a href="${onde}" target="_blank" rel="noopener">${onde.replace('https://', '')}</a>.</small></div>
        <div class="acoes">
          <button class="primario" type="submit">Salvar</button>
          ${c[id].configurada ? '<button type="button" data-testar>Testar</button>' : ''}
          ${c[id].origem === 'painel' ? '<button type="button" class="perigo" data-remover>Remover</button>' : ''}
        </div>
      </form>
    </div>`;
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Configurações do sistema</h1><p class="sub">Vale para todas as empresas</p></div></div>
    <form class="card" id="f-evolution">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">Servidor do WhatsApp (Evolution API)</h2>${c.evolutionChave.configurada ? '<span class="etiqueta ok">Criação automática ligada</span>' : '<span class="etiqueta aviso">Criação automática desligada</span>'}</div>
      ${balao('O cliente só clica em "Gerar QR code"', 'Com a <b>chave global</b> da sua Evolution API, o CRM cria a conexão (instância) de cada empresa sozinho e já liga as mensagens no CRM — igual ao DingDong Tracking. A chave fica só no servidor.')}
      <div class="campos">
        <div class="campo largo"><label>Endereço da Evolution API</label><input name="evolutionUrl" value="${esc(c.evolutionUrl)}" placeholder="https://api.suaevolution.com"></div>
        <div class="campo largo"><label>Chave global (AUTHENTICATION_API_KEY) ${ajuda('É a chave do servidor da Evolution (a mesma EVOLUTION_API_KEY do .env do DingDong Tracking). Não é a API Key de uma instância.')}</label><input name="evolutionApiKey" type="password" autocomplete="off" placeholder="${c.evolutionChave.configurada ? `salva — termina em ${esc(c.evolutionChave.final)} (deixe vazio para manter)` : 'cole a chave global'}"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button>${c.evolutionChave.origem === 'painel' ? '<button type="button" class="perigo" id="remover-evo">Remover chave</button>' : ''}</div>
    </form>
    <h2 style="margin-top:24px">Chave de IA padrão (opcional)</h2>
    ${balao('Normalmente fica vazia', 'Cada empresa cadastra a própria chave em <b>IAs e chaves</b>. A chave padrão só é usada por empresas sem chave — por exemplo, se você quiser pagar a IA de um cliente.')}
    ${linha('gemini', 'Gemini (Google)', 'geminiApiKey', 'https://aistudio.google.com/apikey', 'AIza…')}
    ${linha('anthropic', 'Claude (Anthropic)', 'anthropicApiKey', 'https://console.anthropic.com', 'sk-ant-…')}
    ${linha('openai', 'ChatGPT (OpenAI)', 'openaiApiKey', 'https://platform.openai.com/api-keys', 'sk-…')}`;

  $('#f-evolution').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('config', { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Servidor do WhatsApp salvo.');
      paginaConfiguracoes();
    } catch (err) { aviso(err.message, true); }
  };
  $('#remover-evo')?.addEventListener('click', async () => {
    if (!(await confirmar({ titulo: 'Remover a chave global?', texto: 'As conexões que já existem continuam funcionando; só não dá mais para criar novas pelo botão.', botao: 'Remover', perigo: true }))) return;
    try {
      await api('config', { method: 'PUT', body: { remover: ['evolution'] } });
      paginaConfiguracoes();
    } catch (err) { aviso(err.message, true); }
  });
  $$('form[data-provedor]').forEach((f) => {
    const provedor = f.dataset.provedor;
    const recarregar = async () => {
      sessao = await api('auth/eu');
      paginaConfiguracoes();
    };
    const testar = async () => {
      try {
        const r = await api('config/testar', { method: 'POST', body: { provedor } });
        aviso(r.mensagem);
      } catch (err) { aviso(err.message, true); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const dados = formParaObjeto(f);
      if (!Object.values(dados)[0]) return aviso('Cole a chave antes de salvar.', true);
      try {
        await api('config', { method: 'PUT', body: dados });
        aviso('Chave salva. Testando…');
        await testar();
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
    $('[data-testar]', f)?.addEventListener('click', testar);
    $('[data-remover]', f)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Remover a chave padrão?', texto: 'Empresas sem chave própria param de responder.', botao: 'Remover', perigo: true }))) return;
      try {
        await api('config', { method: 'PUT', body: { remover: [provedor] } });
        recarregar();
      } catch (err) { aviso(err.message, true); }
    });
  });
}

// ---------------------------------------------------------------- minha conta

function paginaConta() {
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Minha conta</h1></div></div>
    <form class="card" id="f-senha" style="max-width:480px">
      <p style="margin-top:0"><strong>${esc(sessao.usuario.nome)}</strong><br><span class="rotulo">${esc(sessao.usuario.email)}</span></p>
      <h2>Trocar senha</h2>
      <div class="campo"><label>Senha atual</label><input type="password" name="senhaAtual" required autocomplete="current-password"></div>
      <div class="campo" style="margin-top:12px"><label>Nova senha (mín. 8 caracteres)</label><input type="password" name="senhaNova" minlength="8" required autocomplete="new-password"></div>
      <div class="acoes"><button class="primario" type="submit">Trocar senha</button></div>
    </form>`;
  $('#f-senha').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('auth/senha', { method: 'PUT', body: formParaObjeto(e.target) });
      e.target.reset();
      aviso('Senha alterada.');
    } catch (err) { aviso(err.message, true); }
  };
}

// ---------------------------------------------------------------- roteador

// endereços antigos do painel continuam funcionando
const ROTAS_ANTIGAS = { assistentes: 'site', instalar: 'site' };

// ---------------------------------------------------------------- sininho: avisos do sistema (erros de IA, WhatsApp, mídia…)
async function atualizarSino() {
  if (!sessao) return null;
  const empresaId = empresaAtual?.id || '';
  const r = await fetch(`api/alertas${empresaId ? `?empresaId=${encodeURIComponent(empresaId)}` : ''}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const b = $('#sino');
  if (!r || !b) return null;
  b.hidden = false;
  $('.contador-sino', b).textContent = r.naoLidos ? (r.naoLidos > 99 ? '99+' : r.naoLidos) : '';
  b.classList.toggle('com-alerta', r.naoLidos > 0);
  return r;
}

async function abrirAlertas() {
  const r = await atualizarSino();
  if (!r) return;
  const NIVEL = { erro: '🔴', aviso: '🟡' };
  abrirModal(`
    <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🔔 Avisos do sistema</h2>${r.alertas.length ? '<button type="button" class="pequeno" id="alertas-lidos">Marcar todos como lidos</button>' : ''}</div>
    <p class="rotulo" style="margin:0 0 12px">O CRM vigia a IA, o WhatsApp, as mídias e as automações e avisa aqui quando algo dá errado — com a dica do que fazer.</p>
    ${r.backup ? `<p class="rotulo" style="margin:0 0 12px">🛡️ Backup: ${r.backup.copiasBanco} cópias do banco (última: ${esc(r.backup.ultimoBanco || 'nenhuma ainda')}) · ${r.backup.fotosMidias} cópias das mídias.</p>` : ''}
    <div class="lista-alertas">${r.alertas.filter((a) => !a.resolvido).map((a) => `
      <div class="alerta-item ${a.lido ? '' : 'novo'}">
        <div class="alerta-topo"><span>${NIVEL[a.nivel] || '🟡'} <b>${esc(a.empresaNome)}</b> · <span class="rotulo">${esc(data(a.ultimoEm))}${a.vezes > 1 ? ` · ${a.vezes}x` : ''}</span></span><button type="button" class="pequeno" data-resolver="${esc(a.id)}">Resolvido</button></div>
        <div>${esc(a.mensagem)}</div>
        ${a.dica ? `<div class="rotulo">💡 ${esc(a.dica)}</div>` : ''}
        ${a.leadId ? `<a class="rotulo" href="#/leads/${esc(a.leadId)}" data-fechar>ver o cliente</a>` : ''}
      </div>`).join('') || '<p class="rotulo">Nenhum aviso. Tudo funcionando. ✅</p>'}</div>
    <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
    $('#alertas-lidos', m)?.addEventListener('click', async () => {
      await api('alertas/lidos', { method: 'POST' }).catch(() => {});
      fechar();
      atualizarSino();
    });
    $$('[data-resolver]', m).forEach((b) => {
      b.onclick = async () => {
        await api(`alertas/${b.dataset.resolver}/resolver`, { method: 'POST' }).catch((err) => aviso(err.message, true));
        b.closest('.alerta-item').remove();
        atualizarSino();
      };
    });
  });
}

// Seção já configurada: vira uma linha recolhida e esmaecida ("✓ Título · resumo · Editar").
// estado: 'ok' (configurado), 'off' (desligado/opcional) ou null (precisa de atenção: fica aberta)
function marcarPronto(card, estado, resumo = '') {
  if (!card) return;
  const chave = `cfg_${(location.hash.split('?')[0] || '#/').replace(/[^\w/-]/g, '')}_${card.id || card.dataset.cfg || ''}`;
  card.classList.toggle('cfg-pronto', Boolean(estado));
  let barra = card.querySelector(':scope > .cfg-barra');
  if (!estado) { card.classList.remove('recolhido'); barra?.remove(); return; }
  let aberto = false;
  try { aberto = sessionStorage.getItem(chave) === '1'; } catch { /* ok */ }
  if (!barra) {
    barra = document.createElement('button');
    barra.type = 'button';
    barra.className = 'cfg-barra';
    card.prepend(barra);
  }
  const titulo = card.dataset.titulo || (card.querySelector('h2')?.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const desenhar = () => {
    const rec = card.classList.contains('recolhido');
    barra.innerHTML = `<span class="cfg-ok ${estado === 'off' ? 'off' : ''}">${estado === 'off' ? '○' : '✓'}</span><span class="cfg-titulo">${esc(titulo)}</span><span class="cfg-resumo">${rec ? esc(resumo || (estado === 'off' ? 'Desligado' : 'Configurado')) : ''}</span><span class="cfg-abrir">${rec ? (estado === 'off' ? 'Configurar' : 'Editar') : 'Recolher'}</span>`;
  };
  card.classList.toggle('recolhido', !aberto);
  desenhar();
  barra.onclick = () => {
    const recolher = !card.classList.contains('recolhido');
    card.classList.toggle('recolhido', recolher);
    try { sessionStorage.setItem(chave, recolher ? '0' : '1'); } catch { /* ok */ }
    desenhar();
  };
}
function aplicarProntos(raiz = conteudo) {
  $$('.card[data-pronto]', raiz).forEach((c) => marcarPronto(c, c.dataset.pronto || null, c.dataset.resumo || ''));
}

async function rotear() {
  clearInterval(atualizador);
  atualizador = null;
  const [caminho, query = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const partes = caminho.split('/').filter(Boolean);

  // usuário de empresa: sempre dentro da própria empresa
  if (!ehAdmin() && (partes.length === 0 || (partes[0] === 'empresas' && !partes[1]) || ['usuarios', 'configuracoes'].includes(partes[0]))) {
    location.replace(rotaEmpresa(sessao.usuario.empresaId));
    return;
  }

  conteudo.innerHTML = '<div class="carregando"><span class="girando"></span> Carregando…</div>';
  let ativo = `#${caminho}`;
  try {
    if (partes[0] === 'empresas' && partes[1]) {
      const id = partes[1];
      const sub = partes[2] || '';
      if (ROTAS_ANTIGAS[sub]) return void location.replace(rotaEmpresa(id, ROTAS_ANTIGAS[sub]));
      const paginas = {
        '': () => paginaEmpresa(id),
        leads: () => paginaLeads(id, params),
        conversas: () => paginaConversas(id, params),
        agenda: () => paginaAgenda(id, params),
        faturamento: () => paginaFaturamento(id, params),
        aprendizado: () => paginaAprendizado(id),
        automacoes: () => paginaAutomacoes(id),
        followup: () => paginaFollowup(id),
        disparos: () => (partes[3] === 'novo' ? paginaNovoDisparo(id) : partes[3] ? paginaDisparo(id, partes[3]) : paginaDisparos(id)),
        ia: () => paginaCerebro(id),
        catalogo: () => paginaCatalogo(id),
        site: () => paginaSite(id),
        whatsapp: () => paginaWhatsapp(id),
        midias: () => paginaMidias(id),
        organizar: () => paginaOrganizar(id),
        chave: () => paginaChave(id)
      };
      if (!paginas[sub]) return void (location.hash = rotaEmpresa(id));
      await paginas[sub]();
      aplicarProntos();
      if (sub === 'disparos') ativo = rotaEmpresa(id, 'disparos');
      if (sub === 'leads') ativo = rotaEmpresa(id, 'leads');
    } else {
      if (ehAdmin() && !['assistentes', 'leads'].includes(partes[0])) empresaAtual = null;
      switch (partes[0]) {
        case undefined: await paginaInicio(); break;
        case 'empresas': await paginaEmpresas(); break;
        case 'assistentes': {
          // endereço antigo de um assistente: leva para a IA do site da empresa
          const bot = partes[1] && partes[1] !== 'novo' ? await api(`bots/${partes[1]}`).catch(() => null) : null;
          location.replace(bot ? rotaEmpresa(bot.empresaId, 'site') : '#/');
          return;
        }
        case 'leads':
          await paginaLead(partes[1]);
          ativo = rotaEmpresa(empresaAtual?.id, 'leads');
          break;
        case 'usuarios': if (ehAdmin()) await paginaUsuarios(); break;
        case 'configuracoes': if (ehAdmin()) await paginaConfiguracoes(); break;
        case 'conta': paginaConta(); break;
        default: location.hash = '#/';
      }
    }
  } catch (err) {
    conteudo.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`;
  }
  montarMenu(ativo);
  window.scrollTo(0, 0);
}

async function iniciar() {
  ajustarBotaoTema();
  $('#tema').onclick = alternarTema;
  $('#tema-menu')?.addEventListener('change', alternarTema);
  $('#abrir-menu').onclick = () => document.body.classList.add('menu-aberto');
  $('#cortina').onclick = fecharMenu;
  try {
    sessao = await api('auth/eu');
  } catch {
    return;
  }
  $('#nome-usuario').textContent = sessao.usuario.email;
  if (sessao.versao?.em) {
    const quando = new Date(sessao.versao.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    $('#versao').textContent = `Última atualização: ${quando}`;
    $('#versao').title = `Versão ${sessao.versao.commit || ''}`.trim();
  }
  $('#sair').onclick = async () => {
    await api('auth/sair', { method: 'POST' }).catch(() => {});
    location.href = 'login';
  };
  // "?" dos balões de ajuda: no celular abre/fecha com toque
  document.addEventListener('click', (e) => {
    const alvo = e.target.closest('.ajuda');
    $$('.ajuda.aberta').forEach((a) => { if (a !== alvo) a.classList.remove('aberta'); });
    if (alvo) {
      e.preventDefault();
      alvo.classList.toggle('aberta');
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-reativar]');
    if (b) reativarEmpresa(b.dataset.reativar, b);
  });
  window.addEventListener('hashchange', () => {
    // trocou de página (link, voltar do navegador): janela aberta da página anterior fecha
    $$('.fundo-modal').forEach((m) => m.remove());
    rotear();
  });
  $('#sino').onclick = abrirAlertas;
  window.addEventListener('hashchange', () => setTimeout(atualizarSino, 800));
  setInterval(atualizarSino, 60 * 1000);
  rotear().then(() => atualizarSino());
}

iniciar();
