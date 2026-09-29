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
  const d = String(n || '').replace(/\D/g, '');
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : d ? `+${d}` : '';
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

const NOME_PROVEDOR = { anthropic: 'Claude (Anthropic)', gemini: 'Gemini (Google)' };
const rotaEmpresa = (id, sub = '') => `#/empresas/${id}${sub ? `/${sub}` : ''}`;

// ---------------------------------------------------------------- componentes de ajuda

// Balão explicativo (dica no topo das telas / seções)
function balao(titulo, html, tipo = 'dica') {
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
  maquina: I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>')
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
    html += `<p class="titulo-grupo">${esc(empresaAtual.nome)}</p>`;
    html += item(rotaEmpresa(id), 'inicio', 'Início');
    html += item(rotaEmpresa(id, 'conversas'), 'conversas', 'Conversas', d.naoLidas ? `<span class="contador">${d.naoLidas > 99 ? '99+' : d.naoLidas}</span>` : '');
    html += item(rotaEmpresa(id, 'leads'), 'leads', 'Leads (funil)');
    html += item(rotaEmpresa(id, 'automacoes'), 'maquina', 'Máquina de vendas');
    html += item(rotaEmpresa(id, 'disparos'), 'disparos', 'Disparos em massa');
    html += '<p class="titulo-grupo">Configurar</p>';
    html += item(rotaEmpresa(id, 'ia'), 'cerebro', 'Sobre a empresa');
    html += item(rotaEmpresa(id, 'site'), 'site', 'IA do site', ponto(d.canais?.site));
    html += item(rotaEmpresa(id, 'whatsapp'), 'whatsapp', 'IA do WhatsApp', ponto(d.canais?.whatsapp && d.whatsapp?.configurado));
    html += item(rotaEmpresa(id, 'midias'), 'midias', 'Mídias e links');
    html += item(rotaEmpresa(id, 'organizar'), 'etiquetas', 'Etiquetas e etapas');
    html += item(rotaEmpresa(id, 'chave'), 'chave', 'Chave de IA');
  }
  if (ehAdmin()) {
    html += '<p class="titulo-grupo">Administração</p>';
    html += item('#/usuarios', 'usuarios', 'Usuários');
    html += item('#/configuracoes', 'config', 'Configurações do sistema');
  }
  $('#menu').innerHTML = html;
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

async function principalDa(empresaId) {
  const bots = await api(`bots?empresaId=${encodeURIComponent(empresaId)}`);
  return bots.find((b) => b.principal) || bots[0] || null;
}

// ---------------------------------------------------------------- visão geral (admin)

async function paginaInicio() {
  const [r, empresas] = await Promise.all([api('resumo'), api('empresas')]);
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Visão geral</h1><p class="sub">Todas as empresas do CRM</p></div></div>
    <div class="grade-resumo">
      ${numeroCard('Empresas', r.empresas)}
      ${numeroCard('Leads novos (7 dias)', r.leads7d)}
      ${numeroCard('Chegaram no WhatsApp (7 dias)', r.noWhatsapp7d)}
      ${numeroCard('Esperando a equipe', r.aguardandoEquipe, r.aguardandoEquipe ? 'destaque' : '')}
    </div>
    <div class="cabecalho"><h2 style="margin:0">Empresas</h2><button class="primario" id="nova">+ Nova empresa</button></div>
    ${tabelaEmpresas(empresas)}`;
  $('#nova').onclick = () => modalEmpresa();
  ligarTabelaEmpresas();
}

function numeroCard(rotulo, valor, classe = '') {
  return `<div class="card numero-card ${classe}"><div class="rotulo">${esc(rotulo)}</div><div class="numero">${valor}</div></div>`;
}

function tabelaEmpresas(lista) {
  const canal = (ligado, rotulo) => `<span class="etiqueta ${ligado ? 'ok' : ''}">${rotulo} ${ligado ? 'ligada' : 'desligada'}</span>`;
  return `
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Empresa</th><th class="esconde-mobile">Nicho</th><th>IAs</th><th>Status</th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((e) => `
            <tr class="clicavel" data-empresa="${esc(e.id)}">
              <td><strong>${esc(e.nome)}</strong></td>
              <td class="esconde-mobile">${esc(e.nicho) || '—'}</td>
              <td>${canal(e.canais?.site, 'Site')} ${canal(e.canais?.whatsapp && e.whatsapp?.configurado, 'WhatsApp')}</td>
              <td>${e.ativa ? '<span class="etiqueta ok">Ativa</span>' : '<span class="etiqueta off">Pausada</span>'}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="vazio">Nenhuma empresa ainda. Clique em "+ Nova empresa".</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function ligarTabelaEmpresas() {
  $$('tr[data-empresa]', conteudo).forEach((tr) => {
    tr.onclick = () => { location.hash = rotaEmpresa(tr.dataset.empresa); };
  });
}

async function paginaEmpresas() {
  const lista = await api('empresas');
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Empresas</h1><p class="sub">Cada empresa tem as próprias IAs, chave de IA, WhatsApp e leads.</p></div><button class="primario" id="nova">+ Nova empresa</button></div>
    ${tabelaEmpresas(lista)}`;
  $('#nova').onclick = () => modalEmpresa();
  ligarTabelaEmpresas();
}

function modalEmpresa(emp) {
  abrirModal(`
    <h2>${emp ? 'Editar empresa' : 'Nova empresa'}</h2>
    <form id="f-emp">
      <div class="campos">
        <div class="campo largo"><label>Nome da empresa *</label><input name="nome" required value="${esc(emp?.nome)}"></div>
        <div class="campo"><label>Ramo ${ajuda('Ex.: estética automotiva, clínica odontológica, loja de roupas. Ajuda a IA a entender o negócio.')}</label><input name="nicho" placeholder="Ex.: estética automotiva" value="${esc(emp?.nicho)}"></div>
        <div class="campo"><label>Responsável</label><input name="responsavel" value="${esc(emp?.responsavel)}"></div>
        <div class="campo largo"><label>WhatsApp para atendimento ${ajuda('Para onde o chat do site manda o cliente. Pode deixar vazio: se o WhatsApp estiver conectado no CRM, usamos o número conectado.')}</label><input name="whatsapp" placeholder="(21) 99999-9999 — opcional" value="${esc(emp?.whatsappNumero)}"></div>
        ${emp ? '' : `<div class="campo largo"><label>Site da empresa ${ajuda('O chat só aparece nos sites informados aqui. Pode preencher depois em IA do site.')}</label><input name="sites" placeholder="minhaloja.com.br"></div>`}
        <div class="campo largo"><label>Observações internas</label><textarea name="observacoes">${esc(emp?.observacoes)}</textarea></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativa" ${emp?.ativa === false ? '' : 'checked'}> Empresa ativa (desmarque para pausar tudo dela)</label></div>
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
    const excluir = $('#excluir', m);
    if (excluir) excluir.onclick = async () => {
      if (!(await confirmar({ titulo: `Excluir "${emp.nome}"?`, texto: 'Apaga também os leads, mídias, disparos e usuários dessa empresa. Não dá para desfazer.', botao: 'Excluir', perigo: true }))) return;
      try {
        await api(`empresas/${emp.id}`, { method: 'DELETE' });
        fechar();
        aviso('Empresa excluída.');
        empresaAtual = null;
        location.hash = '#/empresas';
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- empresa: início

async function paginaEmpresa(id) {
  const [emp, r, principal] = await Promise.all([definirEmpresaAtual(id), api(`resumo?empresaId=${encodeURIComponent(id)}`), principalDa(id)]);
  const provedor = principal?.provedor || 'anthropic';
  const temChave = Boolean(emp.chaves?.[provedor]?.funciona);
  const zap = emp.whatsapp || {};
  const perfil = zap.perfil || {};
  const siteLigado = emp.canais.site;
  const zapLigado = emp.canais.whatsapp;

  const lista = [
    { feito: temChave, texto: 'Cadastre a chave de IA', dica: 'É o "motor" das IAs. Grátis para começar no Gemini.', href: rotaEmpresa(id, 'chave') },
    { feito: Boolean(principal && (principal.conhecimento || '').replace(/\.\.\.|R\$ \.\.\./g, '').trim().length > 150), texto: 'Conte para a IA sobre a sua empresa', dica: 'Serviços, preços, horários, dúvidas comuns.', href: rotaEmpresa(id, 'ia') }
  ];
  if (siteLigado) lista.push({ feito: Object.keys(r.porEtapa).length > 0 || r.totalLeads > 0, texto: 'Coloque o chat no seu site', dica: 'Copie e cole um código uma vez só.', href: rotaEmpresa(id, 'site') });
  if (zapLigado) lista.push({ feito: Boolean(zap.configurado), texto: 'Conecte o WhatsApp', dica: 'Clique em Gerar QR code e escaneie com o celular.', href: rotaEmpresa(id, 'whatsapp') });
  if (zapLigado) lista.push({ feito: emp.totalMidias > 0 || (emp.links || []).length > 0, texto: 'Coloque fotos (ou uma pasta do Drive) e links para a IA usar', dica: 'Mostrar o trabalho vende: a IA manda quando o cliente pedir.', href: rotaEmpresa(id, 'midias') });
  if (zapLigado) lista.push({ feito: (emp.automacoes || []).some((a) => a.ativa), texto: 'Ligue a máquina de vendas', dica: 'Recuperar vendas e pedir avaliações no Google, no automático.', href: rotaEmpresa(id, 'automacoes') });
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

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div><h1>${esc(emp.nome)}</h1><p class="sub">${esc(emp.nicho || 'Painel da empresa')}</p></div>
      ${ehAdmin() ? '<button type="button" id="editar-emp">Editar empresa</button>' : ''}
    </div>

    ${tudoPronto ? '' : `
    <div class="card primeiros-passos">
      <div class="pp-topo"><div><h2 style="margin:0">Primeiros passos</h2><p class="rotulo" style="margin:2px 0 0">${feitos} de ${lista.length} prontos — siga na ordem, leva poucos minutos.</p></div><div class="progresso"><span style="width:${Math.round((feitos / lista.length) * 100)}%"></span></div></div>
      <ul class="checklist">
        ${lista.map((p, i) => `<li class="${p.feito ? 'feito' : ''}"><span class="bola">${p.feito ? '✓' : i + 1}</span><a href="${p.href}"><strong>${esc(p.texto)}</strong><span class="rotulo">${esc(p.dica)}</span></a></li>`).join('')}
      </ul>
    </div>`}

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
      <div class="maquina-topo"><span class="canal-icone maquina">${ICONES.maquina}</span><div><h2 style="margin:0">Máquina de vendas</h2><p class="rotulo" style="margin:2px 0 0">Mensagens automáticas: recuperar quem sumiu, pedir avaliação no Google, reativar quem desistiu.</p></div><a class="botao primario pequeno" href="${rotaEmpresa(id, 'automacoes')}">${(emp.automacoes || []).some((a) => a.ativa) ? 'Ver automações' : 'Ligar agora'}</a></div>
      <div class="automacao-numeros"><span><b>${r.automaticas7d}</b> mensagens automáticas (7 dias)</span><span><b>${r.recuperados7d}</b> clientes responderam depois</span><span><b>${emp.naoLidas || 0}</b> mensagens não lidas · <a href="${rotaEmpresa(id, 'conversas')}">abrir conversas</a></span></div>
    </div>
    ${r.aguardandoEquipe ? balao(`${r.aguardandoEquipe} ${r.aguardandoEquipe === 1 ? 'cliente está' : 'clientes estão'} esperando alguém da equipe`, `A IA passou o atendimento para vocês. <a href="${rotaEmpresa(id, 'leads')}">Ver leads</a>`, 'aviso') : ''}

    <div class="card">
      <div class="cabecalho" style="margin-bottom:12px;padding-right:0"><h2 style="margin:0">Funil de leads</h2><a class="botao pequeno" href="${rotaEmpresa(id, 'leads')}">Abrir leads</a></div>
      <div class="funil">
        ${emp.etapas.map((e) => `<a class="funil-etapa" href="${rotaEmpresa(id, 'leads')}"><span class="rotulo">${esc(e)}</span><strong>${r.porEtapa[e] || 0}</strong></a>`).join('')}
      </div>
    </div>`;
  $('#editar-emp')?.addEventListener('click', () => modalEmpresa(emp));
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
      <div class="cab"><span>${canal === 'whatsapp' ? 'Teste a IA do WhatsApp' : 'Teste a IA do site'}</span><button type="button" class="pequeno" id="limpar">Recomeçar</button></div>
      <div class="chat" id="chat"></div>
      <form id="f-teste"><input id="msg-teste" placeholder="${desativado ? 'Salve primeiro para testar' : 'Escreva como se fosse um cliente…'}" ${desativado ? 'disabled' : ''} autocomplete="off"><button class="primario" ${desativado ? 'disabled' : ''}>Enviar</button></form>
      <p class="rotulo nota-teste">Teste usa o que está na tela, mesmo sem salvar. Nada é enviado de verdade.</p>
    </div>`;
}

function ligarChatTeste({ botId, canal, rascunho, saudacao }) {
  const chat = $('#chat');
  let historico = [];
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
    chat.innerHTML = '';
    if (canal === 'site') bolha('bot', saudacao() || 'Olá! Como posso ajudar?');
    else bolha('acao-ia', 'Mande uma mensagem como se fosse um cliente chegando no WhatsApp.');
  };
  reiniciar();
  $('#limpar').onclick = reiniciar;
  $('#f-teste').onsubmit = async (e) => {
    e.preventDefault();
    const campo = $('#msg-teste');
    const texto = campo.value.trim();
    if (!texto || !botId) return;
    campo.value = '';
    bolha('eu', texto);
    historico.push({ papel: 'visitante', texto });
    const esperando = bolha('bot digitando', '<span></span><span></span><span></span>', true);
    const botao = e.target.querySelector('button');
    botao.disabled = true;
    try {
      const r = await api(`bots/${botId}/testar`, { method: 'POST', body: { bot: rascunho(), mensagens: historico, canal } });
      esperando.className = 'msg bot';
      esperando.innerHTML = esc(r.resposta).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
      historico.push({ papel: 'assistente', texto: r.resposta });
      const acoes = [
        ...(r.midias || []).map((m) => `📎 enviaria a mídia "${m}"`),
        ...(r.etiquetas || []).map((t) => `🏷️ colocaria a etiqueta "${t}"`),
        r.etapa ? `➜ moveria o lead para "${r.etapa}"` : '',
        r.humano ? '👤 chamaria uma pessoa da equipe (e pararia de responder)' : ''
      ].filter(Boolean);
      if (acoes.length) bolha('acao-ia', acoes.join('\n'));
      if (r.whatsappUrl) {
        const a = document.createElement('a');
        a.className = 'cta';
        a.href = r.whatsappUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Continuar no WhatsApp →';
        chat.appendChild(a);
        chat.scrollTop = chat.scrollHeight;
      }
    } catch (err) {
      esperando.className = 'msg erro';
      esperando.textContent = err.message;
      historico.pop();
    } finally {
      botao.disabled = false;
      campo.focus();
    }
  };
}

async function salvarBot(botId, form, mensagem = 'Salvo!') {
  await api(`bots/${botId}`, { method: 'PUT', body: formParaObjeto(form) });
  aviso(mensagem);
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
  const [emp, bot] = await Promise.all([definirEmpresaAtual(id), principalDa(id)]);
  if (!bot) return void (conteudo.innerHTML = '<p class="erro-caixa">Esta empresa ainda não tem assistente. Fale com o administrador.</p>');
  const semChave = !emp.chaves?.[bot.provedor || 'anthropic']?.funciona;
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Sobre a empresa</h1><p class="sub">O que as duas IAs sabem e como elas falam</p></div></div>
    ${balao('Aqui você "treina" a IA', 'Escreva como se estivesse explicando o negócio para um funcionário novo: o que vende, quanto custa, onde atende, horários, prazos, garantia, formas de pagamento e as dúvidas mais comuns. <b>A IA só responde o que estiver aqui</b> — o que não souber, ela diz que vai confirmar com a equipe.')}
    ${semChave ? balao('Falta a chave de IA', `Sem ela as IAs não respondem. <a href="${rotaEmpresa(id, 'chave')}">Cadastrar chave de IA</a>`, 'aviso') : ''}
    ${balao('A IA já vem treinada para vender', 'Ela entende a necessidade, mostra o benefício, contorna objeções (preço, "vou pensar"), sugere o próximo passo e propõe fechar quando o cliente mostra interesse — sem inventar nada. Preencha o <b>objetivo</b> e a <b>oferta</b> para ela saber aonde chegar.', 'ok')}
    <div class="editor">
      <form id="f-bot" class="card">
        <div class="campos">
          <div class="campo"><label>Nome do atendente virtual ${ajuda('Como a IA se apresenta. Ex.: "Ana, da Madara Volantes" ou só o nome da empresa.')}</label><input name="nomeAssistente" value="${esc(bot.nomeAssistente)}" placeholder="${esc(emp.nome)}"></div>
          <div class="campo"><label>Jeito de falar ${ajuda('Ex.: simpático e descontraído; formal e objetivo; animado, com emojis.')}</label><input name="tom" value="${esc(bot.tom)}" placeholder="simpático, próximo e profissional"></div>
          <div class="campo"><label>Objetivo da conversa ${ajuda('Onde a IA deve levar o cliente. Ex.: agendar uma visita, fechar o pedido, marcar a avaliação gratuita.')}</label><input name="objetivo" value="${esc(bot.objetivo || '')}" placeholder="Ex.: agendar o serviço"></div>
          <div class="campo"><label>Oferta e diferenciais ${ajuda('O que faz o cliente escolher você: garantia, parcelamento, promoção do mês, atendimento a domicílio… Só coisas verdadeiras — a IA não inventa.')}</label><input name="oferta" value="${esc(bot.oferta || '')}" placeholder="Ex.: 12x sem juros, garantia de 1 ano"></div>
          <div class="campo largo">
            <label>Tudo o que a IA precisa saber *</label>
            <textarea class="grande" name="conhecimento">${esc(bot.conhecimento || MODELO_CONHECIMENTO)}</textarea>
            <small>Dica: troque os "..." do modelo pelas informações reais. Quanto mais completo, melhor a IA atende.</small>
          </div>
        </div>
        <details class="secao-avancada">
          <summary>Qual inteligência artificial usar (avançado)</summary>
          <div class="campos" style="margin-top:12px">
            <div class="campo"><label>IA</label><select name="provedor">${['gemini', 'anthropic'].map((p) => `<option value="${p}" ${p === (bot.provedor || 'anthropic') ? 'selected' : ''}>${NOME_PROVEDOR[p]}${emp.chaves?.[p]?.funciona ? '' : ' — sem chave'}</option>`).join('')}</select></div>
            <div class="campo"><label>Modelo ${ajuda('Pode deixar o que já vem escolhido. Modelos "flash"/"haiku" são mais rápidos e baratos.')}</label><select name="modelo"><option value="${esc(bot.modelo)}">${esc(bot.modelo)}</option></select><small id="aviso-modelo"></small></div>
          </div>
        </details>
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

function ligarSeletorModelo(form, empresaId) {
  const selProvedor = form.elements.provedor;
  const selModelo = form.elements.modelo;
  async function carregar(manterAtual) {
    const atual = manterAtual ? selModelo.value : '';
    selModelo.innerHTML = '<option>carregando…</option>';
    try {
      const r = await api(`ia/modelos?provedor=${encodeURIComponent(selProvedor.value)}&empresaId=${encodeURIComponent(empresaId)}`);
      const lista = r.modelos.slice();
      if (atual && !lista.some((m) => m.id === atual)) lista.unshift({ id: atual, nome: `${atual} (atual)` });
      selModelo.innerHTML = lista.map((m) => `<option value="${esc(m.id)}">${esc(m.id === m.nome ? m.id : `${m.nome} — ${m.id}`)}</option>`).join('');
      const preferido = atual || (selProvedor.value === 'gemini' ? lista.find((m) => /flash/.test(m.id) && !/lite|preview|exp/.test(m.id))?.id : lista[0]?.id);
      if (preferido) selModelo.value = preferido;
      if ($('#aviso-modelo')) $('#aviso-modelo').textContent = r.aviso ? `Não consegui listar os modelos da chave (${r.aviso}). Mostrando sugestões.` : '';
    } catch (err) {
      aviso(err.message, true);
    }
  }
  carregar(true);
  selProvedor.onchange = () => carregar(false);
}

// ---------------------------------------------------------------- empresa: IA do site

async function paginaSite(id) {
  const [emp, bot] = await Promise.all([definirEmpresaAtual(id), principalDa(id)]);
  if (!bot) return void (conteudo.innerHTML = '<p class="erro-caixa">Esta empresa ainda não tem assistente.</p>');
  const codigo = codigoEmpresa(emp.id);
  const ligado = emp.canais.site;
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>IA do site</h1><p class="sub">Um chat estilo WhatsApp no seu site, respondendo 24h</p></div>${interruptor('ligar-site', ligado, ligado ? 'Ligada' : 'Desligada')}</div>
    ${ligado ? '' : balao('A IA do site está desligada', 'O chat não aparece no site. Ligue no botão acima quando quiser usar.', 'aviso')}

    <div class="card">
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
          <div class="campo largo"><label>Instruções da IA do site ${ajuda('Diga o que ela deve descobrir e quando mandar para o WhatsApp.')}</label><textarea name="regras" placeholder="Ex.: Descubra o modelo do carro e o serviço que o cliente quer. Quando ele pedir preço final ou quiser agendar, mande para o WhatsApp.">${esc(bot.regras)}</textarea></div>
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
  ligarChatTeste({ botId: bot.id, canal: 'site', rascunho: () => formParaObjeto(form), saudacao: () => form.elements.boasVindas.value });
}

// ---------------------------------------------------------------- empresa: IA do WhatsApp

async function paginaWhatsapp(id) {
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
      <div class="card">
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

  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>IA do WhatsApp</h1><p class="sub">Responde no número da empresa, manda fotos e vídeos e passa para a equipe</p></div>${interruptor('ligar-zap', ligado, ligado ? 'Ligada' : 'Desligada')}</div>
    ${ligado ? '' : balao('A IA do WhatsApp está desligada', 'As mensagens continuam chegando no CRM (você vê tudo em Leads), mas a IA não responde. Ligue no botão acima quando quiser.', 'aviso')}
    ${conexao}
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
    ligarChatTeste({ botId: bot.id, canal: 'whatsapp', rascunho: () => formParaObjeto(form), saudacao: () => '' });
  }
}

// ---------------------------------------------------------------- empresa: mídias

const ICONE_TIPO = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄' };

async function paginaMidias(id) {
  const emp = await definirEmpresaAtual(id);
  const todas = await api(`empresas/${id}/midias`);
  const lista = todas.filter((m) => !m.pastaId);
  const pastas = emp.drivePastas || [];
  let links = (emp.links || []).map((l) => ({ ...l }));

  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Mídias e links</h1><p class="sub">Fotos, vídeos, PDFs e links que a IA do WhatsApp manda para vender mais</p></div></div>
    ${balao('Mostrar o trabalho vende', 'A IA manda as fotos e links certos na hora certa. Ela escolhe pelo <b>nome</b> e pelo <b>"quando mandar"</b> — ex.: álbum <i>"Volantes em couro"</i>, quando <i>"o cliente pedir fotos ou perguntar do acabamento"</i>. Tudo aqui também pode ir nos disparos, nas automações e na aba Conversas.')}

    <div class="card">
      <h2>📁 Fotos do Google Drive</h2>
      <p class="rotulo" style="margin-top:-6px">Cada pasta vira um <b>álbum</b>: a IA manda as fotos da pasta de uma vez. Coloque fotos novas na pasta e o CRM sincroniza sozinho (a cada 6 horas, ou no botão).</p>
      <details ${pastas.length ? '' : 'open'}><summary>Como compartilhar a pasta</summary>${passos([
        'No Google Drive, clique com o botão direito na pasta → <b>Compartilhar</b>.',
        'Em "Acesso geral", escolha <b>Qualquer pessoa com o link</b> (leitor) → <b>Copiar link</b>.',
        'Cole o link aqui, dê um nome para o álbum e diga quando a IA deve mandar.'
      ])}</details>
      <form id="f-drive" class="campos" style="margin-top:12px">
        <div class="campo largo"><label>Link da pasta</label><input name="link" required placeholder="https://drive.google.com/drive/folders/…"></div>
        <div class="campo"><label>Nome do álbum</label><input name="nome" placeholder="Ex.: Volantes em couro"></div>
        <div class="campo"><label>Quando a IA deve mandar</label><input name="descricao" placeholder="Ex.: quando pedir fotos do couro"></div>
        <div class="campo largo"><div class="acoes" style="margin-top:0"><button class="primario" type="submit">Conectar pasta</button></div></div>
      </form>
      <div class="lista-pastas">
        ${pastas.map((p) => {
          const fotos = todas.filter((m) => m.pastaId === p.id);
          return `
          <div class="pasta">
            <div class="pasta-fotos">${fotos.slice(0, 4).map((m) => (m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`)).join('') || '<span>📁</span>'}</div>
            <div class="pasta-info"><strong>${esc(p.nome)}</strong><span class="rotulo">${p.total || 0} arquivos · ${esc(p.descricao || 'sem instrução de quando mandar')}</span><span class="rotulo">Sincronizada ${data(p.ultimaSincronia)}${p.falhas?.length ? ` · ${p.falhas.length} arquivo(s) não baixaram` : ''}</span></div>
            <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-sinc="${esc(p.id)}">🔄 Sincronizar</button><button type="button" class="pequeno" data-editar-pasta="${esc(p.id)}">Editar</button><button type="button" class="pequeno perigo" data-tirar-pasta="${esc(p.id)}">Remover</button></div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <h2>🔗 Links</h2>
      <p class="rotulo" style="margin-top:-6px">Site, catálogo, cardápio, localização no mapa, agenda online, Instagram… A IA manda quando fizer sentido.</p>
      <div id="lista-links" class="lista-editavel"></div>
      <div class="acoes"><button type="button" id="add-link">+ Novo link</button><button type="button" class="primario" id="salvar-links">Salvar links</button></div>
    </div>

    <form class="card" id="f-midia">
      <h2>📤 Enviar arquivo do computador</h2>
      <label class="soltar" id="soltar">
        <input type="file" name="arquivo" required accept="image/*,video/mp4,audio/*,.pdf,.doc,.docx,.xls,.xlsx">
        <span class="soltar-texto">📁 <b>Clique para escolher</b> ou arraste o arquivo aqui<br><span class="rotulo">Até 16 MB — foto, vídeo MP4, áudio ou PDF</span></span>
      </label>
      <div class="campos" style="margin-top:12px">
        <div class="campo"><label>Nome *</label><input name="nome" required placeholder="Ex.: Tabela de preços"></div>
        <div class="campo"><label>Quando a IA deve mandar</label><input name="descricao" placeholder="Ex.: quando o cliente pedir os preços"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Enviar arquivo</button></div>
    </form>
    <div class="grade-midias">
      ${lista.map((m) => `
        <div class="card midia">
          <a class="midia-previa" href="${esc(m.url)}" target="_blank" rel="noopener">${m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`}</a>
          <strong>${esc(m.nome)}</strong>
          <span class="rotulo">${esc(m.descricao) || 'sem instrução de quando mandar'}</span>
          <span class="rotulo">${esc(m.arquivo)} · ${(m.tamanho / 1024 / 1024).toFixed(1)} MB</span>
          <div class="acoes" style="margin-top:8px"><button class="pequeno" data-editar="${esc(m.id)}">Editar</button><button class="pequeno perigo" data-apagar="${esc(m.id)}">Apagar</button></div>
        </div>`).join('')}
    </div>`;

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
          <div class="campo" style="margin-top:12px"><label>Quando a IA deve mandar</label><input name="descricao" value="${esc(p.descricao || '')}"></div>
          <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
        </form>`, (m, fechar) => {
        $('#f-ed-pasta', m).onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api(`empresas/${id}/drive/${p.id}`, { method: 'PUT', body: formParaObjeto(e.target) });
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

  // ---------- arquivos
  const f = $('#f-midia');
  const entrada = f.elements.arquivo;
  entrada.onchange = () => {
    const a = entrada.files[0];
    if (!a) return;
    $('.soltar-texto').innerHTML = `✅ <b>${esc(a.name)}</b><br><span class="rotulo">${(a.size / 1024 / 1024).toFixed(1)} MB — clique para trocar</span>`;
    if (!f.elements.nome.value) f.elements.nome.value = a.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  };
  const zona = $('#soltar');
  zona.ondragover = (e) => { e.preventDefault(); zona.classList.add('arrastando'); };
  zona.ondragleave = () => zona.classList.remove('arrastando');
  zona.ondrop = (e) => {
    e.preventDefault();
    zona.classList.remove('arrastando');
    if (e.dataTransfer.files[0]) { entrada.files = e.dataTransfer.files; entrada.onchange(); }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const arquivo = entrada.files[0];
    if (!arquivo) return;
    if (arquivo.size > 16 * 1024 * 1024) return aviso('Arquivo maior que 16 MB (limite do WhatsApp).', true);
    try {
      await comEspera(f.querySelector('button[type=submit]'), async () => {
        const qs = new URLSearchParams({ arquivo: arquivo.name, nome: f.elements.nome.value, descricao: f.elements.descricao.value, tipo: arquivo.type || '' });
        const r = await fetch(`api/empresas/${id}/midias?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arquivo });
        const dados = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(dados.erro || (r.status === 413 ? 'Arquivo grande demais para o servidor.' : `Erro ${r.status}`));
      }, 'Enviando…');
      aviso('Mídia adicionada.');
      paginaMidias(id);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-apagar]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar({ titulo: 'Apagar esta mídia?', texto: 'A IA não vai mais conseguir enviá-la.', botao: 'Apagar', perigo: true }))) return;
      try {
        await api(`empresas/${id}/midias/${b.dataset.apagar}`, { method: 'DELETE' });
        paginaMidias(id);
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-editar]').forEach((b) => {
    b.onclick = () => {
      const m = lista.find((x) => x.id === b.dataset.editar);
      abrirModal(`
        <h2>Editar mídia</h2>
        <form id="f-ed-midia">
          <div class="campo"><label>Nome</label><input name="nome" required value="${esc(m.nome)}"></div>
          <div class="campo" style="margin-top:12px"><label>Quando a IA deve mandar</label><input name="descricao" value="${esc(m.descricao)}"></div>
          <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
        </form>`, (modal, fechar) => {
        $('#f-ed-midia', modal).onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: formParaObjeto(e.target) });
            fechar();
            paginaMidias(id);
          } catch (err) { aviso(err.message, true); }
        };
      });
    };
  });
}

// ---------------------------------------------------------------- empresa: etiquetas e etapas

async function paginaOrganizar(id) {
  const emp = await definirEmpresaAtual(id);
  let etiquetas = emp.etiquetas.map((t) => ({ ...t }));
  let etapas = emp.etapas.slice();
  const CORES = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Etiquetas e etapas</h1><p class="sub">Como os seus leads ficam organizados</p></div></div>
    <div class="duas-colunas">
      <div class="card">
        <h2>Etiquetas</h2>
        ${balao('Para que servem?', 'Marcam o lead com uma característica: <i>Quente</i>, <i>Orçamento enviado</i>, <i>Cliente VIP</i>… Você filtra os leads por elas e escolhe <b>para quem fazer disparos</b>. As IAs também podem colocar etiquetas sozinhas.')}
        <div id="lista-etiquetas" class="lista-editavel"></div>
        <div class="acoes"><button type="button" id="add-etiqueta">+ Nova etiqueta</button><button type="button" class="primario" id="salvar-etiquetas">Salvar etiquetas</button></div>
      </div>
      <div class="card">
        <h2>Etapas do funil</h2>
        ${balao('O caminho do cliente', 'Da primeira mensagem até fechar. As IAs movem o lead sozinhas conforme a conversa avança, e você pode mover arrastando no quadro de Leads. Use as setas para mudar a ordem.')}
        <div id="lista-etapas" class="lista-editavel"></div>
        <div class="acoes"><button type="button" id="add-etapa">+ Nova etapa</button><button type="button" class="primario" id="salvar-etapas">Salvar etapas</button></div>
      </div>
    </div>`;

  function desenharEtiquetas() {
    $('#lista-etiquetas').innerHTML = etiquetas.map((t, i) => `
      <div class="linha-editavel">
        <input type="color" value="${esc(t.cor)}" data-cor="${i}" title="Cor">
        <input value="${esc(t.nome)}" data-nome="${i}" placeholder="Nome da etiqueta" maxlength="40">
        <button type="button" class="pequeno perigo" data-tirar="${i}" title="Remover">✕</button>
      </div>`).join('') || '<p class="rotulo">Nenhuma etiqueta.</p>';
    $$('[data-cor]').forEach((el) => { el.oninput = () => { etiquetas[el.dataset.cor].cor = el.value; }; });
    $$('[data-nome]').forEach((el) => { el.oninput = () => { etiquetas[el.dataset.nome].nome = el.value; }; });
    $$('[data-tirar]').forEach((el) => { el.onclick = () => { etiquetas.splice(Number(el.dataset.tirar), 1); desenharEtiquetas(); }; });
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
  $('#add-etiqueta').onclick = () => {
    etiquetas.push({ nome: '', cor: CORES[etiquetas.length % CORES.length] });
    desenharEtiquetas();
    $$('[data-nome]').pop()?.focus();
  };
  $('#add-etapa').onclick = () => {
    etapas.push('');
    desenharEtapas();
    $$('[data-etapa]').pop()?.focus();
  };
  $('#salvar-etiquetas').onclick = async () => {
    try {
      const r = await api(`empresas/${id}/etiquetas`, { method: 'PUT', body: { etiquetas: etiquetas.filter((t) => t.nome.trim()) } });
      etiquetas = r.etiquetas.map((t) => ({ ...t }));
      desenharEtiquetas();
      aviso('Etiquetas salvas.');
    } catch (err) { aviso(err.message, true); }
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

async function paginaChave(id) {
  const emp = await definirEmpresaAtual(id);
  const bloco = (provedor, campo, onde, dica, passosCriar, recomendado) => {
    const c = emp.chaves[provedor];
    const situacao = c.propria
      ? `<span class="etiqueta ok">✓ Chave cadastrada</span> <span class="rotulo">termina em ${esc(c.final)}</span>`
      : c.usaPadrao
        ? '<span class="etiqueta">Usando a chave do administrador</span>'
        : '<span class="etiqueta off">Sem chave</span>';
    return `
      <div class="card">
        <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">${NOME_PROVEDOR[provedor]} ${recomendado ? '<span class="etiqueta ok">mais fácil</span>' : ''}</h2>${situacao}</div>
        <details ${c.propria ? '' : 'open'}><summary>Como conseguir a chave</summary>${passos(passosCriar)}</details>
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
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Chave de IA</h1><p class="sub">O "motor" das suas IAs</p></div></div>
    ${balao('Basta uma chave', 'Cadastre a do <b>Gemini</b> <u>ou</u> a do <b>Claude</b>. O custo das conversas fica na conta da sua empresa (o Gemini tem uma faixa gratuita para começar). A chave fica guardada só no servidor e nunca aparece no site.')}
    ${bloco('gemini', 'geminiApiKey', 'https://aistudio.google.com/apikey', 'AIza…', [
      'Entre em <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> com a sua conta Google.',
      'Clique em <b>Create API key</b> (Criar chave de API).',
      'Copie a chave (começa com <code>AIza</code>) e cole aqui embaixo.'
    ], true)}
    ${bloco('anthropic', 'anthropicApiKey', 'https://console.anthropic.com', 'sk-ant-…', [
      'Entre em <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> e crie a conta.',
      'Em <b>Billing</b>, adicione créditos. Em <b>API Keys</b>, clique em <b>Create Key</b>.',
      'Copie a chave (começa com <code>sk-ant-</code>) e cole aqui embaixo.'
    ], false)}`;

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
          // se o assistente usa a outra IA e ela não tem chave, troca para esta
          const bot = await principalDa(id);
          if (bot && !emp.chaves[bot.provedor]?.funciona && bot.provedor !== provedor) {
            await api(`bots/${bot.id}`, { method: 'PUT', body: { provedor } });
          }
          await testar();
        }, 'Testando…');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
    $('[data-testar]', f)?.addEventListener('click', testar);
    $('[data-remover]', f)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Remover a chave?', texto: 'Se a IA usar esta chave, ela para de responder.', botao: 'Remover', perigo: true }))) return;
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
  return l.nome || (l.telefone ? telefoneBonito(l.telefone) : 'Visitante do site');
}

function chipsDoLead(l, etiquetas) {
  return (l.etiquetas || []).map((tid) => etiquetas.find((t) => t.id === tid)).filter(Boolean).map((t) => chipEtiqueta(t)).join('');
}

function cartaoLead(l, etiquetas) {
  const ultima = l.ultimaMensagem ? `${l.ultimaMensagem.papel === 'visitante' ? '' : l.ultimaMensagem.papel === 'equipe' ? 'Equipe: ' : 'IA: '}${l.ultimaMensagem.texto}` : '';
  return `
    <a class="cartao-lead" href="#/leads/${esc(l.id)}" draggable="true" data-lead="${esc(l.id)}">
      <span class="cartao-topo"><strong>${esc(nomeDoLead(l))}</strong>${l.precisaHumano ? '<span class="etiqueta off">chamou a equipe</span>' : ''}</span>
      ${l.etiquetas?.length ? `<span class="chips">${chipsDoLead(l, etiquetas)}</span>` : ''}
      <span class="rotulo cartao-texto">${esc(ultima)}</span>
      <span class="cartao-rodape">
        ${l.canais.map((c) => `<span class="etiqueta">${ROTULO_CANAL[c] || c}</span>`).join(' ')}
        ${l.iaPausada && !l.precisaHumano ? '<span class="etiqueta">IA pausada</span>' : ''}
        <span class="rotulo" style="margin-left:auto">${data(l.atualizadoEm)}</span>
      </span>
    </a>`;
}

async function paginaLeads(id, params) {
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
    <div id="area-leads"></div>`;

  function desenharQuadro() {
    $('#area-leads').innerHTML = `
      <p class="rotulo dica-arrastar">Arraste um cartão para outra coluna para mudar a etapa.</p>
      <div class="quadro">
        ${emp.etapas.map((etapa) => {
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
        try {
          await api(`leads/${leadId}`, { method: 'PUT', body: { etapa: col.dataset.etapa } });
          lead.etapa = col.dataset.etapa;
          desenharQuadro();
        } catch (err) { aviso(err.message, true); }
      };
    });
  }

  function desenharLista() {
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
                <td><a href="#/leads/${esc(l.id)}"><strong>${esc(nomeDoLead(l))}</strong></a>${l.telefone && l.nome ? `<br><span class="rotulo">${esc(telefoneBonito(l.telefone))}</span>` : ''}${l.precisaHumano ? ' <span class="etiqueta off">chamou a equipe</span>' : ''}</td>
                <td class="esconde-mobile"><span class="chips">${chipsDoLead(l, etiquetas) || '<span class="rotulo">—</span>'}</span></td>
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
      if (await confirmar({ titulo: `Apagar ${n} lead${n === 1 ? '' : 's'}?`, texto: 'Apaga também as conversas. Não dá para desfazer.', botao: 'Apagar', perigo: true })) lote({ apagar: true }, 'Leads apagados.');
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
  const l = await api(`leads/${leadId}`);
  await definirEmpresaAtual(l.empresaId);
  const etiquetasLead = new Set(l.etiquetas);
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>${esc(nomeDoLead(l))}</h1><p class="sub">${esc(l.etapa)} · desde ${data(l.criadoEm)}</p></div><div class="barra">${l.podeReceber ? `<a class="botao primario" href="${rotaEmpresa(l.empresaId, 'conversas')}?lead=${esc(l.id)}">💬 Abrir conversa</a>` : ''}<a class="botao" href="${rotaEmpresa(l.empresaId, 'leads')}">← Leads</a></div></div>
    ${l.precisaHumano ? balao('Este cliente está esperando alguém da equipe', 'A IA passou o atendimento para vocês. Responda aqui embaixo ou pelo celular.', 'aviso') : ''}
    <div class="lead-grade">
      <div>
        <div class="conversa" id="linha-tempo">
          ${l.mensagens.map((m) => htmlMensagem(m, l.id)).join('') || '<p class="rotulo">Sem mensagens ainda.</p>'}
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
            <div class="chips escolher-etiquetas">${l.etiquetasEmpresa.map((t) => `<button type="button" class="chip-filtro ${etiquetasLead.has(t.id) ? 'ativo' : ''}" data-tag="${esc(t.id)}" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}</button>`).join('') || `<a class="rotulo" href="${rotaEmpresa(l.empresaId, 'organizar')}">Criar etiquetas</a>`}</div>
          </div>
          <div class="campo" style="margin-top:12px"><label>Nome</label><input id="nome" value="${esc(l.nome)}" placeholder="Nome do cliente"></div>
          ${l.noWhatsapp ? `<p style="margin:12px 0 0"><strong>WhatsApp:</strong> ${esc(telefoneBonito(l.telefone)) || '—'}</p>` : `<div class="campo" style="margin-top:12px"><label>Telefone / WhatsApp</label><input id="telefone" value="${esc(telefoneBonito(l.telefone))}" placeholder="(21) 99999-9999"></div>`}
          <p class="rotulo" style="margin:10px 0 0">Código #${esc(l.codigo)} · veio por ${ROTULO_CANAL[l.origem] || l.origem}${l.pagina ? ` · <span title="${esc(l.pagina)}">página do site</span>` : ''}</p>
          <div class="secao" style="margin-top:14px;padding-top:14px">
            <p style="margin:0 0 8px"><strong>IA neste lead:</strong> ${l.iaPausada ? `<span class="etiqueta off">pausada</span> <span class="rotulo">${esc(l.iaPausadaMotivo || '')}</span>` : '<span class="etiqueta ok">respondendo</span>'}</p>
            <button type="button" id="alternar-ia">${l.iaPausada ? 'Devolver para a IA' : 'Pausar a IA (a equipe assume)'}</button>
            <label class="linha-check" style="margin-top:12px"><input type="checkbox" id="nao-disparar" ${l.naoDisparar ? 'checked' : ''}> Não enviar disparos em massa para este lead</label>
          </div>
          <div class="campo" style="margin-top:14px"><label>Anotações da equipe</label><textarea id="anotacoes" style="min-height:80px">${esc(l.anotacoes || '')}</textarea></div>
          <div class="acoes"><button class="primario" type="button" id="salvar-lead">Salvar</button><button type="button" class="perigo" id="apagar-lead" style="margin-left:auto">Apagar lead</button></div>
        </div>
        ${l.etapaHistorico?.length ? `<div class="card"><h2>Histórico de etapas</h2><ul class="historico">${l.etapaHistorico.slice().reverse().map((h) => `<li><span class="rotulo">${data(h.em)}</span> ${esc(h.de || '—')} → <strong>${esc(h.para)}</strong> <span class="rotulo">(${esc({ 'ia-site': 'IA do site', 'ia-whatsapp': 'IA do WhatsApp', equipe: 'equipe', sistema: 'automático' }[h.por] || h.por)})</span></li>`).join('')}</ul></div>` : ''}
      </div>
    </div>`;
  const tl = $('#linha-tempo');
  tl.scrollTop = tl.scrollHeight;
  const atualizar = async (body, msg) => {
    try {
      await api(`leads/${leadId}`, { method: 'PUT', body });
      if (msg) aviso(msg);
      paginaLead(leadId);
    } catch (err) { aviso(err.message, true); }
  };
  $('#etapa').onchange = (e) => atualizar({ etapa: e.target.value }, 'Etapa atualizada.');
  $$('[data-tag]').forEach((b) => {
    b.onclick = () => {
      if (etiquetasLead.has(b.dataset.tag)) etiquetasLead.delete(b.dataset.tag);
      else etiquetasLead.add(b.dataset.tag);
      atualizar({ etiquetas: [...etiquetasLead] });
    };
  });
  $('#nao-disparar').onchange = (e) => atualizar({ naoDisparar: e.target.checked }, e.target.checked ? 'Este lead não recebe mais disparos.' : 'Este lead volta a receber disparos.');
  $('#salvar-lead').onclick = () => atualizar({ nome: $('#nome').value, anotacoes: $('#anotacoes').value, ...($('#telefone') ? { telefone: $('#telefone').value } : {}) }, 'Lead salvo.');
  $('#alternar-ia').onclick = () => atualizar({ iaPausada: !l.iaPausada }, l.iaPausada ? 'A IA voltou a responder este lead.' : 'IA pausada neste lead.');
  $('#apagar-lead').onclick = async () => {
    if (!(await confirmar({ titulo: 'Apagar este lead?', texto: 'Apaga também todo o histórico da conversa.', botao: 'Apagar', perigo: true }))) return;
    try {
      await api(`leads/${leadId}`, { method: 'DELETE' });
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
  const emp = await definirEmpresaAtual(id);
  const lista = await api(`empresas/${id}/disparos`);
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

async function paginaNovoDisparo(id) {
  const emp = await definirEmpresaAtual(id);
  const lista = await api(`empresas/${id}/midias`);
  let leadIds = [];
  try { leadIds = JSON.parse(sessionStorage.getItem('disparo_leads') || '[]'); sessionStorage.removeItem('disparo_leads'); } catch { leadIds = []; }

  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Novo disparo</h1><p class="sub">3 passos: quem recebe, a mensagem e quando enviar</p></div><a class="botao" href="${rotaEmpresa(id, 'disparos')}">← Disparos</a></div>
    <form id="f-disparo" class="editor">
      <div>
        <div class="card">
          <h2><span class="passo-num">1</span> Quem vai receber</h2>
          ${leadIds.length ? `${balao(`${leadIds.length} leads escolhidos na lista`, `<a href="${rotaEmpresa(id, 'disparos/novo')}" id="limpar-escolha">Usar filtros em vez disso</a>`, 'ok')}` : `
          <div class="campo"><label>Etapas ${ajuda('Nenhuma marcada = todas as etapas.')}</label><div class="chips">${emp.etapas.map((e) => `<label class="chip-check"><input type="checkbox" name="etapa" value="${esc(e)}"><span>${esc(e)}</span></label>`).join('')}</div></div>
          <div class="campo" style="margin-top:12px"><label>Etiquetas ${ajuda('Recebe quem tiver pelo menos uma das etiquetas marcadas. Nenhuma marcada = qualquer etiqueta.')}</label><div class="chips">${emp.etiquetas.map((t) => `<label class="chip-check" style="--cor:${esc(t.cor)}"><input type="checkbox" name="etiqueta" value="${esc(t.id)}"><span><span class="bolinha-cor"></span>${esc(t.nome)}</span></label>`).join('') || '<span class="rotulo">Nenhuma etiqueta criada.</span>'}</div></div>
          <div class="campo" style="margin-top:12px"><label>De onde veio</label><select name="origem"><option value="todos">Todos</option><option value="site">Site</option><option value="whatsapp">WhatsApp</option><option value="manual">Cadastrados / importados</option></select></div>`}
          <div class="contagem" id="contagem">Calculando…</div>
        </div>
        <div class="card">
          <h2><span class="passo-num">2</span> A mensagem</h2>
          <div class="campo"><label>Nome do disparo (só para você)</label><input name="nome" placeholder="Ex.: Promoção de março"></div>
          <div class="campo" style="margin-top:12px">
            <label>Mensagem *</label>
            <div class="botoes-variavel"><button type="button" class="pequeno" data-inserir="{nome}">+ Nome do cliente</button><button type="button" class="pequeno" data-inserir="{Oi|Olá|E aí}">+ Variação de saudação</button></div>
            <textarea name="mensagem" required style="min-height:140px" placeholder="{Oi|Olá} {nome}! Tudo bem? Esta semana temos 20% de desconto no revestimento de volante. Quer que eu te mande as fotos?"></textarea>
            <small><code>{nome}</code> vira o primeiro nome do cliente. <code>{Oi|Olá}</code> sorteia uma das opções — mensagens diferentes ajudam a não ser bloqueado.</small>
          </div>
          <div class="campo" style="margin-top:12px"><label>Anexar mídia (opcional)</label><select name="midiaId"><option value="">Sem mídia</option>${lista.map((m) => `<option value="${esc(m.id)}">${ICONE_TIPO[m.tipo] || '📎'} ${esc(m.nome)}</option>`).join('')}</select><small>Foto, vídeo ou PDF vão com a mensagem como legenda. <a href="${rotaEmpresa(id, 'midias')}">Cadastrar mídias</a></small></div>
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
        ? `<strong>${r.total} ${r.total === 1 ? 'pessoa vai' : 'pessoas vão'} receber</strong><span class="rotulo">${r.nomes.map(esc).join(', ')}${r.total > r.nomes.length ? '…' : ''}</span>${r.semNumero || r.sairam ? `<span class="rotulo">${r.semNumero ? `${r.semNumero} sem WhatsApp` : ''}${r.semNumero && r.sairam ? ' · ' : ''}${r.sairam ? `${r.sairam} pediram para não receber` : ''} (ficam de fora)</span>` : ''}`
        : '<strong>Ninguém nesse filtro</strong><span class="rotulo">Mude as etapas ou etiquetas.</span>';
      const midia = lista.find((m) => m.id === f.midiaId);
      $('#previa').innerHTML = r.exemplo
        ? `${midia ? `<div class="msg bot midia-previa-msg">${midia.tipo === 'image' ? `<img src="${esc(midia.url)}" alt="">` : `${ICONE_TIPO[midia.tipo]} ${esc(midia.nome)}`}</div>` : ''}<div class="msg bot">${esc(r.exemplo).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')}</div><div class="msg acao-ia">Exemplo com o primeiro contato da lista. Cada pessoa recebe com o próprio nome.</div>`
        : '<div class="msg acao-ia">Escreva a mensagem para ver a prévia.</div>';
      $('#enviar-disparo').disabled = !(r.total && f.mensagem.trim());
      $('#enviar-disparo').textContent = r.total ? `📣 Enviar para ${r.total} ${r.total === 1 ? 'pessoa' : 'pessoas'}` : '📣 Iniciar disparo';
    } catch (err) {
      if (!form.isConnected) return;
      $('#contagem').innerHTML = `<span class="erro-caixa">${esc(err.message)}</span>`;
    }
  }
  const agendarPrevia = () => { clearTimeout(espera); espera = setTimeout(atualizarPrevia, 350); };
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
          midiaId: f.midiaId,
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
  await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/disparos/${disparoId}`);
  const ST = { pendente: ['na fila', ''], enviado: ['enviado', 'ok'], erro: ['erro', 'off'], ignorado: ['ficou de fora', ''], cancelado: ['cancelado', ''] };
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
  if (a.tipo === 'audio') return `<audio class="anexo-audio" controls preload="none" src="${esc(url)}"></audio>${a.transcricao ? `<span class="anexo-nota">📝 ${esc(a.transcricao)}</span>` : ''}`;
  if (a.tipo === 'video') return `<video class="anexo-img" controls preload="none" src="${esc(url)}"></video>`;
  return `<a class="anexo-doc" href="${esc(url)}" target="_blank" rel="noopener">📄 ${esc(a.nome || 'arquivo')}</a>`;
}

function htmlMensagem(m, leadId) {
  const classe = m.papel === 'visitante' ? 'eu' : m.papel === 'equipe' ? 'equipe' : 'bot';
  const origem = m.automacaoNome ? `⚡ ${m.automacaoNome}` : m.disparoId ? '📣 Disparo' : m.agendadaId ? '🕒 Agendada' : PAPEL_ROTULO[m.papel] || m.papel;
  // o texto do cliente com áudio/foto já foi trocado pela transcrição: mostra o arquivo e a transcrição
  const textoVisivel = m.anexo && /^\[(áudio|foto) do cliente\]:/.test(m.texto || '') ? '' : m.texto;
  return `<div class="msg ${classe}"><span class="msg-origem">${ROTULO_CANAL[m.canal || 'site'] || ''} · ${esc(origem)}</span>${htmlAnexo(m, leadId)}${textoVisivel ? `<span class="msg-texto">${esc(textoVisivel).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</span>` : ''}${m.whatsapp ? '<em class="msg-nota">→ Ofereceu continuar no WhatsApp</em>' : ''}<small>${data(m.em)}</small></div>`;
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
  return esc((String(nome || '?').trim()[0] || '?').toUpperCase());
}

async function paginaConversas(id, params) {
  const emp = await definirEmpresaAtual(id);
  let filtro = 'todas';
  let busca = '';
  let abertoId = params.get('lead') || '';
  let lista = [];
  let leadAberto = null;
  let assinaturaAberta = '';

  conteudo.innerHTML = `
    <div class="cabecalho cab-conversas"><div><h1>Conversas</h1><p class="sub">Converse com seus clientes pelo computador — a IA atende junto com você</p></div></div>
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp para conversar por aqui', `<a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    <div class="inbox ${abertoId ? 'com-chat' : ''}" id="inbox">
      <aside class="inbox-lista">
        <div class="inbox-busca"><input id="busca-conversa" placeholder="🔎 Buscar nome, telefone ou mensagem"></div>
        <div class="inbox-filtros">
          <button type="button" class="chip-filtro ativo" data-filtro="todas">Todas</button>
          <button type="button" class="chip-filtro" data-filtro="naoLidas">Não lidas</button>
          <button type="button" class="chip-filtro" data-filtro="equipe">Esperando você</button>
        </div>
        <div id="lista-conversas" class="lista-conversas"><p class="rotulo" style="padding:16px">Carregando…</p></div>
      </aside>
      <section class="inbox-chat" id="inbox-chat">
        <div class="inbox-vazio">${ICONES.leads}<p><b>Escolha uma conversa</b><br><span class="rotulo">As novas mensagens aparecem sozinhas.</span></p></div>
      </section>
    </div>`;

  function desenharLista() {
    const el = $('#lista-conversas');
    if (!el) return;
    el.innerHTML = lista.length
      ? lista.map((c) => `
        <button type="button" class="item-conversa ${c.id === abertoId ? 'ativo' : ''}" data-lead="${esc(c.id)}">
          <span class="avatar">${inicial(nomeDoLead(c))}</span>
          <span class="item-meio">
            <span class="item-linha"><strong>${esc(nomeDoLead(c))}</strong><span class="rotulo item-hora">${horaCurta(c.ultimaEm)}</span></span>
            <span class="item-linha"><span class="rotulo item-previa">${c.ultimaMensagem ? `${c.ultimaMensagem.papel === 'visitante' ? '' : c.ultimaMensagem.papel === 'equipe' ? 'Você: ' : 'IA: '}${esc(c.ultimaMensagem.texto)}` : ''}</span>${c.naoLidas ? `<span class="bolha-nao-lida">${c.naoLidas}</span>` : ''}</span>
            <span class="item-linha item-tags">${c.precisaHumano ? '<span class="etiqueta off">esperando você</span>' : c.iaPausada ? '<span class="etiqueta">IA pausada</span>' : ''}${chipsDoLead(c, emp.etiquetas)}</span>
          </span>
        </button>`).join('')
      : `<p class="rotulo" style="padding:16px">${busca || filtro !== 'todas' ? 'Nada encontrado.' : 'Nenhuma conversa ainda.'}</p>`;
    $$('.item-conversa', el).forEach((b) => { b.onclick = () => abrir(b.dataset.lead); });
  }

  async function carregarLista() {
    lista = await api(`empresas/${id}/conversas?${new URLSearchParams({ filtro, busca })}`);
    desenharLista();
  }

  function desenharChat() {
    const l = leadAberto;
    const area = $('#inbox-chat');
    if (!area || !l) return;
    const pendentes = (l.agendadas || []).filter((a) => a.status === 'pendente');
    area.innerHTML = `
      <header class="chat-topo">
        <button type="button" class="pequeno voltar-lista" id="voltar-lista" aria-label="Voltar">←</button>
        <span class="avatar">${inicial(nomeDoLead(l))}</span>
        <div class="chat-quem"><strong>${esc(nomeDoLead(l))}</strong><span class="rotulo">${l.telefone ? esc(telefoneBonito(l.telefone)) : 'sem WhatsApp'} · <a href="#/leads/${esc(l.id)}">ver lead</a></span></div>
        <select id="chat-etapa" title="Etapa do funil">${l.etapas.map((e) => `<option ${e === l.etapa ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
        ${interruptor('chat-ia', !l.iaPausada, 'IA')}
      </header>
      ${l.precisaHumano ? `<div class="chat-aviso">👤 A IA chamou você para este cliente. Responda e depois devolva para a IA se quiser.</div>` : ''}
      <div class="conversa chat-mensagens" id="chat-mensagens">${l.mensagens.map((m) => htmlMensagem(m, l.id)).join('') || '<p class="rotulo">Sem mensagens.</p>'}</div>
      ${pendentes.length ? `<div class="chat-agendadas">${pendentes.map((a) => `<span>🕒 ${esc(new Date(a.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}: ${esc(a.texto.slice(0, 60))} <button type="button" class="link-botao" data-cancelar="${esc(a.id)}">cancelar</button></span>`).join('')}</div>` : ''}
      ${l.podeReceber ? `
      <form class="chat-envio" id="chat-envio">
        <div class="sugestoes-rapidas" id="sugestoes-rapidas" hidden></div>
        <div class="chat-ferramentas">
          <label class="botao pequeno" title="Enviar foto, vídeo, áudio ou PDF do computador">📎 Arquivo<input type="file" id="chat-arquivo" hidden accept="image/*,video/mp4,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label>
          <button type="button" class="pequeno" id="chat-biblioteca" title="Mídias e álbuns cadastrados">🖼️ Mídias</button>
          <button type="button" class="pequeno" id="chat-rapidas" title="Respostas prontas (ou digite /)">⚡ Respostas</button>
          <button type="button" class="pequeno" id="chat-sugerir" title="A IA escreve uma sugestão para você revisar">✨ Sugerir com IA</button>
          <button type="button" class="pequeno" id="chat-agendar" title="Mandar mais tarde">🕒 Agendar</button>
        </div>
        <div class="chat-linha">
          <textarea id="chat-texto" rows="1" placeholder="Escreva uma mensagem… (Enter envia, / para respostas prontas)"></textarea>
          <button class="primario" type="submit" id="chat-enviar">Enviar</button>
        </div>
        <label class="linha-check rotulo manter-ia"><input type="checkbox" id="chat-manter-ia"> Deixar a IA continuar atendendo depois da minha mensagem</label>
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
    assinaturaAberta = `${leadAberto.mensagens.length}|${leadAberto.atualizadoEm}`;
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
    const assinatura = `${l.mensagens.length}|${l.atualizadoEm}`;
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
    $('#voltar-lista')?.addEventListener('click', () => {
      abertoId = '';
      $('#inbox').classList.remove('com-chat');
      history.replaceState(null, '', rotaEmpresa(id, 'conversas'));
      desenharLista();
    });
    $('#chat-etapa')?.addEventListener('change', async (e) => {
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
    $$('[data-cancelar]').forEach((b) => {
      b.onclick = async () => {
        await api(`leads/${abertoId}/agendadas/${b.dataset.cancelar}`, { method: 'DELETE' }).catch((err) => aviso(err.message, true));
        assinaturaAberta = '';
        recarregarAberto();
      };
    });
    const form = $('#chat-envio');
    if (!form) return;
    const campo = $('#chat-texto');
    const ajustarAltura = () => { campo.style.height = 'auto'; campo.style.height = `${Math.min(160, campo.scrollHeight)}px`; };
    const rapidas = emp.respostasRapidas || [];
    const caixaRapidas = $('#sugestoes-rapidas');
    const mostrarRapidas = () => {
      const m = campo.value.match(/^\/(\S*)$/);
      const achadas = m ? rapidas.filter((r) => r.atalho.includes(m[1].toLowerCase())).slice(0, 6) : [];
      caixaRapidas.hidden = !achadas.length;
      caixaRapidas.innerHTML = achadas.map((r) => `<button type="button" data-rapida="${esc(r.id)}"><b>/${esc(r.atalho)}</b> ${esc(r.texto.slice(0, 80))}</button>`).join('');
      $$('[data-rapida]', caixaRapidas).forEach((b) => {
        b.onclick = () => {
          campo.value = rapidas.find((r) => r.id === b.dataset.rapida).texto;
          caixaRapidas.hidden = true;
          ajustarAltura();
          campo.focus();
        };
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
      if (arquivo.size > 16 * 1024 * 1024) return aviso('Arquivo maior que 16 MB (limite do WhatsApp).', true);
      const legenda = arquivo.type.startsWith('audio/') ? '' : campo.value.trim();
      try {
        await comEspera($('#chat-enviar'), async () => {
          const qs = new URLSearchParams({ nome: arquivo.name, tipo: arquivo.type || '', legenda, manterIa: $('#chat-manter-ia').checked ? '1' : '0' });
          const r = await fetch(`api/leads/${abertoId}/arquivo?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arquivo });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
        }, 'Enviando…');
        campo.value = '';
        aviso('Arquivo enviado.');
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
    $('#chat-rapidas').onclick = () => modalRespostasRapidas(emp, (textoEscolhido) => {
      campo.value = textoEscolhido;
      ajustarAltura();
      campo.focus();
    });
    $('#chat-sugerir').onclick = async (e) => {
      try {
        const r = await comEspera(e.currentTarget, () => api(`leads/${abertoId}/sugerir`, { method: 'POST', body: { pedido: campo.value.trim() } }), 'Pensando…');
        campo.value = r.texto;
        ajustarAltura();
        campo.focus();
        aviso('Sugestão pronta — revise e clique em Enviar.');
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
  let espera = null;
  $('#busca-conversa').oninput = (e) => {
    clearTimeout(espera);
    espera = setTimeout(() => { busca = e.target.value.trim(); carregarLista(); }, 300);
  };

  await carregarLista();
  if (abertoId) await abrir(abertoId);
  const aqui = rotaEmpresa(id, 'conversas');
  atualizador = setInterval(() => {
    if (!location.hash.startsWith(aqui)) return void clearInterval(atualizador);
    carregarLista().catch(() => {});
    recarregarAberto().catch(() => {});
  }, 4000);
}

function modalRespostasRapidas(emp, aoEscolher) {
  let lista = (emp.respostasRapidas || []).map((r) => ({ ...r }));
  abrirModal(`
    <h2>Respostas prontas</h2>
    ${balao('Economize tempo', 'Cadastre as respostas que você manda sempre (endereço, formas de pagamento, horário…). Na conversa, digite <b>/</b> e o atalho para usar.')}
    <div id="lista-rapidas" class="lista-editavel"></div>
    <div class="acoes"><button type="button" id="add-rapida">+ Nova resposta</button><button type="button" class="primario" id="salvar-rapidas">Salvar</button><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
    const desenhar = () => {
      $('#lista-rapidas', m).innerHTML = lista.map((r, i) => `
        <div class="rapida">
          <div class="linha-editavel"><span class="rotulo">/</span><input value="${esc(r.atalho)}" data-atalho="${i}" placeholder="atalho (ex.: pix)" maxlength="30"><button type="button" class="pequeno" data-usar="${i}">Usar</button><button type="button" class="pequeno perigo" data-tirar="${i}">✕</button></div>
          <textarea data-texto="${i}" placeholder="Texto da resposta">${esc(r.texto)}</textarea>
        </div>`).join('') || '<p class="rotulo">Nenhuma resposta pronta ainda.</p>';
      $$('[data-atalho]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.atalho].atalho = el.value; }; });
      $$('[data-texto]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.texto].texto = el.value; }; });
      $$('[data-tirar]', m).forEach((el) => { el.onclick = () => { lista.splice(Number(el.dataset.tirar), 1); desenhar(); }; });
      $$('[data-usar]', m).forEach((el) => {
        el.onclick = () => {
          const r = lista[Number(el.dataset.usar)];
          if (!r.texto.trim()) return;
          aoEscolher?.(r.texto);
          fechar();
        };
      });
    };
    desenhar();
    $('#add-rapida', m).onclick = () => { lista.push({ atalho: '', texto: '' }); desenhar(); };
    $('#salvar-rapidas', m).onclick = async () => {
      try {
        emp.respostasRapidas = await api(`empresas/${emp.id}/respostas`, { method: 'PUT', body: { respostas: lista } });
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
  return r.gatilho.tipo === 'sem_resposta'
    ? `Quando o cliente não responde há ${tempo}`
    : `${tempo} depois de o lead entrar em "${r.gatilho.etapa}"`;
}

async function paginaAutomacoes(id) {
  const emp = await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/automacoes`);
  const precisaLink = d.regras.some((r) => r.ativa && /\{link_avaliacao\}/i.test(r.acao.texto || '')) && !d.linkAvaliacao;
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Máquina de vendas</h1><p class="sub">Mensagens automáticas que recuperam vendas, trazem avaliações e clientes de volta</p></div><button type="button" class="primario" id="nova-regra">+ Criar automação</button></div>
    ${d.whatsappConectado ? '' : balao('Conecte o WhatsApp primeiro', `As automações saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar</a>`, 'aviso')}
    ${balao('Como funciona', 'Cada automação olha seus leads a cada minuto e manda a mensagem sozinha para quem cumpre o critério — ex.: "parou de responder há 20 horas" ou "fechou há 2 dias". Quando o cliente responde, a IA continua a conversa. <b>Ninguém recebe duas vezes</b>, quem pediu SAIR fica de fora e, por padrão, só envia das 8h às 20h.')}

    <div class="card">
      <h2>Link de avaliação do Google</h2>
      <p class="rotulo" style="margin-top:-6px">Usado na automação "Pedir avaliação no Google" (variável <code>{link_avaliacao}</code>).</p>
      <details ${d.linkAvaliacao ? '' : 'open'}><summary>Onde pego esse link?</summary>${passos(['Abra o <a href="https://business.google.com" target="_blank" rel="noopener">Google Meu Negócio</a> (ou pesquise o nome da sua empresa no Google, logado).', 'Clique em <b>Pedir avaliações</b> (ou "Receber mais avaliações").', 'Copie o link que aparece (ex.: <code>https://g.page/r/…/review</code>) e cole aqui.'])}</details>
      <form id="f-link-avaliacao" class="linha-form" style="margin-top:10px"><input name="linkAvaliacao" value="${esc(d.linkAvaliacao)}" placeholder="https://g.page/r/…/review"><button type="submit" class="primario">Salvar</button></form>
      ${precisaLink ? '<p class="erro-caixa" style="margin-top:10px">A automação de avaliação está ligada, mas falta o link — ela não envia até você salvar.</p>' : ''}
    </div>

    <h2>Suas automações</h2>
    <div class="lista-automacoes">
      ${d.regras.length ? d.regras.map((r) => `
        <div class="card automacao ${r.ativa ? 'ligada' : ''}">
          <div class="automacao-topo">
            <div><strong>${esc(r.nome)}</strong><div class="rotulo">${esc(descreverGatilho(r))} · ${r.acao.modo === 'ia' ? '✨ a IA escreve' : '✉️ mensagem pronta'}${r.maxPorLead > 1 ? ` · até ${r.maxPorLead}x por lead` : ''}${r.horarioComercial ? ' · 8h–20h' : ''}</div></div>
            ${interruptor(`regra-${r.id}`, r.ativa)}
          </div>
          ${r.explicacao ? `<p class="rotulo" style="margin:8px 0 0">${esc(r.explicacao)}</p>` : ''}
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
  $('#nova-regra').onclick = () => modalAutomacao(emp, null, () => paginaAutomacoes(id));
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
        <select name="tipo"><option value="sem_resposta" ${r?.gatilho.tipo !== 'etapa' ? 'selected' : ''}>Quando o cliente não responde há…</option><option value="etapa" ${r?.gatilho.tipo === 'etapa' ? 'selected' : ''}>Depois que o lead entra numa etapa…</option></select>
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
        <small>Na mensagem pronta: <code>{nome}</code>, <code>{empresa}</code>, <code>{link_avaliacao}</code> e variações <code>{Oi|Olá}</code>.</small>
      </div>
      <div class="campos" style="margin-top:12px">
        <div class="campo"><label>Mandar junto (opcional)</label><select name="midiaId"><option value="">Nada</option>${lista.filter((m) => !m.pastaId).map((m) => `<option value="${esc(m.id)}" ${m.id === r?.acao.midiaId ? 'selected' : ''}>${ICONE_TIPO[m.tipo] || '📎'} ${esc(m.nome)}</option>`).join('')}</select></div>
        <div class="campo"><label>Vezes por lead ${ajuda('Quantas vezes, no máximo, o mesmo cliente recebe esta automação.')}</label><input type="number" name="maxPorLead" min="1" max="5" value="${r?.maxPorLead || 1}"></div>
      </div>
      <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="horarioComercial" ${r?.horarioComercial === false ? '' : 'checked'}> Só das 8h às 20h</label>
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
        horarioComercial: o.horarioComercial,
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

// ---------------------------------------------------------------- usuários (admin)

async function paginaUsuarios() {
  const [lista, empresas] = await Promise.all([api('usuarios'), api('empresas')]);
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

// ---------------------------------------------------------------- configurações do sistema (admin)

async function paginaConfiguracoes() {
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
    ${balao('Normalmente fica vazia', 'Cada empresa cadastra a própria chave em <b>Chave de IA</b>. A chave padrão só é usada por empresas sem chave — por exemplo, se você quiser pagar a IA de um cliente.')}
    ${linha('gemini', 'Gemini (Google)', 'geminiApiKey', 'https://aistudio.google.com/apikey', 'AIza…')}
    ${linha('anthropic', 'Claude (Anthropic)', 'anthropicApiKey', 'https://console.anthropic.com', 'sk-ant-…')}`;

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
        automacoes: () => paginaAutomacoes(id),
        disparos: () => (partes[3] === 'novo' ? paginaNovoDisparo(id) : partes[3] ? paginaDisparo(id, partes[3]) : paginaDisparos(id)),
        ia: () => paginaCerebro(id),
        site: () => paginaSite(id),
        whatsapp: () => paginaWhatsapp(id),
        midias: () => paginaMidias(id),
        organizar: () => paginaOrganizar(id),
        chave: () => paginaChave(id)
      };
      if (!paginas[sub]) return void (location.hash = rotaEmpresa(id));
      await paginas[sub]();
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
  $('#tema-menu').onchange = alternarTema;
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
  window.addEventListener('hashchange', rotear);
  rotear();
}

iniciar();
