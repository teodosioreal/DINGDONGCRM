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
  // entrou pelo link de acesso único: primeiro cria a senha nova
  if (r.status === 403 && dados.trocarSenha) {
    location.href = 'login#nova-senha';
    throw new Error(dados.erro);
  }
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
function confirmar({ titulo, texto, botao = 'Confirmar', perigo = false, voltar = 'Cancelar' }) {
  return new Promise((resolve) => {
    let respondeu = false;
    const fechar = abrirModal(`
      <h2>${esc(titulo)}</h2>
      <div class="texto-modal">${texto}</div>
      <div class="acoes"><button type="button" class="${perigo ? 'perigo-cheio' : 'primario'}" id="sim">${esc(botao)}</button><button type="button" data-fechar>${esc(voltar)}</button></div>`, (m) => {
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

// 🔄 quantas vezes cada chave do Gemini respondeu/falhou hoje (a rotação funcionando)
function rotacaoDeHoje(emp) {
  const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hoje = emp.iaChavesUso?.[dia];
  if (!hoje) return '<p class="rotulo" style="margin:0 0 10px">🔄 Rotação de hoje: nenhuma chave reserva precisou entrar (ou ainda não houve conversa hoje).</p>';
  const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
  const ordem = ['principal', '1ª reserva', '2ª reserva', '3ª reserva'];
  const linhas = [...ordem, ...Object.keys(hoje).filter((n) => !ordem.includes(n))].filter((n) => hoje[n]).map((n) => {
    const c = hoje[n];
    return `<li><b>${esc(n === 'principal' ? 'Chave principal' : n[0].toUpperCase() + n.slice(1))}</b>: respondeu ${c.ok}x${c.falhas ? ` · <span class="aviso-texto">falhou ${c.falhas}x</span>${c.ultimaFalha ? ` (última às ${esc(hora(c.ultimaFalha.em))}: ${esc(c.ultimaFalha.motivo)})` : ''}` : ''}</li>`;
  });
  return `<div class="balao" style="margin:0 0 12px"><span class="balao-icone">🔄</span><div><strong>Rotação de hoje</strong><ul class="lista-checagem" style="margin:4px 0 0;padding-left:0;list-style:none">${linhas.join('')}</ul><div class="balao-texto" style="margin-top:4px">A ordem é: principal → 1ª → 2ª → 3ª reserva. Chave que bateu no limite vai para o fim da fila (1 min se foi o limite por minuto; até o Google liberar se foi o limite do dia). Se TODAS acabarem no modelo escolhido, as mesmas chaves respondem em outro modelo do Gemini (o limite grátis é por modelo) — a conversa continua igual.</div></div></div>`;
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
// celular/tablet: sem mouse (sem Shift no teclado, sem passar o mouse por cima)
const telaDeToque = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const rotaEmpresa = (id, sub = '') => `#/empresas/${id}${sub ? `/${sub}` : ''}`;
// código de mídia como aparece no prompt: #MIDIA_FOTO_ANTES (guardado como FOTO-ANTES)
const codMidia = (c) => (c ? `#MIDIA_${String(c).replace(/-/g, '_')}` : '');
// o código simples de cada mídia/álbum: o número (#MIDIA_7); sem número, o de texto
const codNum = (x) => (x?.numero ? `#MIDIA_${x.numero}` : codMidia(x?.codigo));
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
  microfone: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
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
  catalogo: I('<path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  meta: I('<path d="M3 17l5-5 4 4 8-8"/><path d="M14 8h6v6"/>')
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
        ['disparos', 'disparos', 'Disparos em massa', 'campanha lista enviar para todos promocao'],
        ['meta-ads', 'meta', 'Meta Ads', 'facebook instagram pixel api de conversoes anuncio vendas campanha fbclid']
      ]],
      ['Sua IA', [
        ['ia', 'cerebro', 'Sobre a empresa', 'treinar instrucoes conhecimento prompt nome atendente'],
        ['catalogo', 'catalogo', 'Serviços e preços', 'catalogo produtos preco tabela valores'],
        ['midias', 'midias', 'Mídias e respostas', 'fotos videos imagens audios gravar audio microfone respostas rapidas so follow-up sugestao de midia'],
        ['aprendizado', 'livro', 'Clone e aprendizados', 'clone aprender responder igual a mim aprendizado anuncios'],
        ['whatsapp', 'whatsapp', 'IA do WhatsApp', 'conectar qr code numero instrucoes aviso de agendamento etiquetas lista negra modo teste'],
        ['site', 'site', 'IA do site', 'chat do site codigo widget instalar']
      ]],
      ['Ajustes', [
        ['organizar', 'etiquetas', 'Etiquetas e etapas', 'etiquetas tickets etapas funil'],
        ['chave', 'chave', 'IAs e chaves', 'chave api claude gemini gpt openai tokens reserva'],
        ['lead-externo', 'chave', 'Lead externo', 'webhook api integracao lead externo cadastro automatico teste gratis outro sistema']
      ]]
    ];
    html += '<div class="busca-menu"><input type="search" id="busca-menu" placeholder="🔎 Buscar configuração (ex.: follow-up, horário, pixel)" aria-label="Buscar no painel" autocomplete="off" enterkeyhint="search"><div id="busca-resultados" class="busca-resultados" role="listbox" hidden></div></div>';
    paginasBusca = grupos.flatMap(([, itens]) => itens.map(([k, , rotulo, palavras]) => ({ k, rotulo, palavras })));
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
    html += item('#/usuarios', 'usuarios', 'Usuários', sessao.pendentes ? `<span class="contador" title="Contas aguardando aprovação">${sessao.pendentes}</span>` : '');
    html += item('#/configuracoes', 'config', 'Configurações do sistema');
  }
  $('#menu').innerHTML = html;
  // busca: acha a página E a configuração (sem acento, palavras parecidas, erro de digitação);
  // ↑ ↓ escolhem, Enter abre e rola até a seção
  const busca = $('#busca-menu');
  const caixa = $('#busca-resultados');
  let achados = [];
  let sel = 0;
  const abrir = (it) => {
    busca.value = '';
    caixa.hidden = true;
    $$('#menu .grupo-menu').forEach((g) => { g.hidden = false; });
    fecharMenu();
    irParaBusca(empresaAtual.id, it);
  };
  const desenharAchados = () => {
    caixa.innerHTML = achados.length
      ? achados.map((it, i) => `<button type="button" role="option" class="busca-item ${i === sel ? 'ativo' : ''}" data-i="${i}"><b>${esc(it.titulo)}</b><small>${it.onde === 'Página' ? 'abre a página' : `em ${esc(it.onde)}`}</small></button>`).join('')
      : '<p class="rotulo" style="margin:6px 8px">Nada encontrado. Tente outra palavra (ex.: "horário", "pix", "QR code").</p>';
    $$('.busca-item', caixa).forEach((b) => { b.onmousedown = (e) => e.preventDefault(); b.onclick = () => abrir(achados[Number(b.dataset.i)]); });
  };
  busca?.addEventListener('input', () => {
    const q = busca.value.trim();
    $$('#menu .grupo-menu').forEach((g) => { g.hidden = Boolean(q); });
    if (!q) { caixa.hidden = true; return; }
    achados = buscarNoPainel(q, paginasBusca);
    sel = 0;
    caixa.hidden = false;
    desenharAchados();
  });
  busca?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { busca.value = ''; busca.dispatchEvent(new Event('input')); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && achados.length) {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : achados.length - 1)) % achados.length;
      desenharAchados();
    }
    if (e.key === 'Enter' && achados[sel] && busca.value.trim()) { e.preventDefault(); abrir(achados[sel]); }
  });
  $$('.lateral a').forEach((a) => {
    if (a.classList.contains('item-menu') && a.closest('.rodape-menu')) a.classList.toggle('ativo', a.getAttribute('href') === ativo);
    a.onclick = fecharMenu;
  });
}

// ---------------------------------------------------------------- busca do painel
// Cada configuração do painel: [título, página da empresa, texto do título da seção para rolar
// até ela (| = alternativas), palavras que as pessoas usam, aba ([chave do sessionStorage, valor])]
const INDICE_BUSCA = [
  ['Follow-up automático (ligar / desligar)', 'followup', 'Follow-up automático', 'retomar cliente sumiu parou de responder mensagem pronta sequencia recuperar insistir cobrar ligar desligar'],
  ['Mensagens do follow-up (editar)', 'followup', 'Follow-up automático', 'editar texto mensagem follow variação sequencia passos horas dias'],
  ['Follow-up que puxa agendamento (modelo pronto)', 'followup', 'Follow-up automático', 'modelo agendar agendamento oferecer horario horarios puxar marcar'],
  ['Clientes na fila do follow-up', 'followup', 'Clientes na fila', 'fila quem vai receber colocar na fila'],
  ['Follow-up só para clientes quentes (alta chance de venda)', 'followup', 'Follow-up automático', 'quente quentes chance de venda probabilidade alta morno filtrar para quem'],
  ['Ver clientes 🔥 quentes', 'conversas', '', 'quente quentes chance de venda probabilidade alta prontos para fechar'],
  ['Horários livres para agendar ({horarios})', 'agenda', 'Horários que a IA pode agendar', 'horarios livres vagas disponibilidade agenda da ia dias horario cadastrar horario'],
  ['Agendamento automático (só com endereço)', 'agenda', 'Agendamento automático', 'endereco agendar sozinho detectar automatico perceber'],
  ['Valor do agendamento e previsão de faturamento', 'agenda', 'Valor do agendamento|Previsão de faturamento', 'valor previsao faturamento quanto vai entrar'],
  ['Cancelar ou excluir agendamento', 'agenda', '', 'excluir apagar cancelar desmarcar agendamento errado remover'],
  ['Conectar o WhatsApp (QR code)', 'whatsapp', 'WhatsApp conectado|Conecte o WhatsApp|Falta conectar', 'conectar qr code numero celular desconectado reconectar parear'],
  ['A IA não está respondendo? (diagnóstico)', 'whatsapp', 'A IA não está respondendo', 'nao responde parou travou erro diagnostico problema'],
  ['Buscar mensagens do celular (sincronizar)', 'whatsapp', 'Mensagens do WhatsApp no painel', 'sincronizar historico importar mensagens antigas buscar puxar celular'],
  ['Velocidade das respostas da IA', 'whatsapp', 'Velocidade das respostas', 'rapido devagar humano tempo resposta demora digitando'],
  ['Primeira mensagem de cliente novo (espera)', 'whatsapp', 'Primeira mensagem de um cliente novo', 'esperar minutos primeira resposta cliente novo demora'],
  ['Pausas entre as partes da resposta', 'whatsapp', 'Pausas entre as partes', 'pausa partes mensagens separadas quebrar'],
  ['Avisos de erro no seu WhatsApp', 'whatsapp', 'Avisos de erro no seu WhatsApp', 'alerta numero avisos notificacao erro me avisar'],
  ['Fotos dos clientes', 'whatsapp', 'Fotos dos clientes', 'foto perfil avatar'],
  ['IA para depois da minha mensagem manual', 'whatsapp', 'IA para de responder depois', 'pausar ia quando eu responder manual equipe assumir parar'],
  ['Não atropelar o cliente', 'whatsapp', 'Não atropelar', 'esperar cliente terminar digitar varias mensagens juntas'],
  ['Modo econômico (gastar menos tokens)', 'whatsapp', 'Modo econômico', 'economizar tokens gastar menos barato economia'],
  ['IA atende quem já comprou / quem agendou', 'whatsapp', 'Quem já comprou e quem agendou', 'compradores agendados ia desligada comprou agendou cliente antigo'],
  ['Modo teste', 'whatsapp', 'Modo teste', 'testar teste sem enviar numero de teste simular'],
  ['Instruções da IA do WhatsApp (prompt)', 'whatsapp', 'Como a IA do WhatsApp atende', 'prompt instrucoes roteiro script como responder treinar comportamento regras'],
  ['Aviso de agendamento (técnico / dono)', 'whatsapp', 'Aviso de agendamento', 'avisar tecnico numero agendamento novo mensagem para mim notificar'],
  ['Lista negra (bloquear número)', 'whatsapp', 'Lista negra', 'bloquear numero ignorar contato nao responder bloqueio'],
  ['Horário da IA responder', 'whatsapp', 'Horário da IA responder', 'horario atendimento comercial noite fim de semana madrugada'],
  ['Avisos internos para a IA', 'whatsapp', 'Avisos internos para a IA', 'eventos lembrete interno aviso ia'],
  ['Log das respostas da IA', 'whatsapp', 'Log das respostas da IA', 'historico erros o que a ia respondeu log registro'],
  ['Enviar fotos, vídeos e arquivos', 'midias', 'Suas fotos, vídeos e arquivos', 'upload adicionar foto video pdf arquivo subir imagem enviar midia'],
  ['Gravar áudio pelo CRM', 'midias', 'Novo áudio', 'audio gravar voz microfone regravar ouvir', ['midias_aba', 'audios']],
  ['Trocar o arquivo de uma mídia', 'midias', 'Suas fotos, vídeos e arquivos', 'trocar substituir arquivo foto video mesma midia mesmo codigo'],
  ['Ativar ou desligar mídia ("a configurar")', 'midias', 'Suas fotos, vídeos e arquivos', 'desativar ativar pronta a configurar desligar midia nao enviar', ['midias_aba', 'configurar']],
  ['Álbuns de fotos', 'midias', 'Suas fotos, vídeos e arquivos', 'album varias fotos juntas', ['midias_aba', 'albuns']],
  ['Mídias só do follow-up', 'midias', 'Suas fotos, vídeos e arquivos', 'so follow-up midia follow', ['midias_aba', 'followup']],
  ['Revezar mídias e teste A/B de áudio', 'midias', 'Suas fotos, vídeos e arquivos', 'revezar alternar ab teste audio texto revezamento'],
  ['Mídias citadas no prompt da IA', 'midias', 'Mídias no prompt da IA', 'codigo midia prompt #midia conectar'],
  ['Respostas rápidas (/atalho)', 'midias', 'Respostas rápidas', 'atalho /preco resposta pronta barra rapida'],
  ['Links (site, Instagram, catálogo)', 'midias', 'Links', 'link site instagram catalogo url endereco'],
  ['Serviços e preços (catálogo)', 'catalogo', 'Cadastre o que você vende', 'preco valor tabela produto servico catalogo quanto custa'],
  ['Custo e margem de lucro do produto', 'catalogo', 'Custo para você', 'custo margem lucro produto quanto ganho por venda custo fixo material'],
  ['Sobre a empresa (o que a IA sabe)', 'ia', '', 'informacoes empresa endereco conhecimento treinar nome atendente horario de funcionamento'],
  ['Clone (responder igual a mim)', 'aprendizado', 'Clone', 'clone aprender responder igual a mim copiar meu jeito'],
  ['O que a IA aprendeu', 'aprendizado', 'O que a IA aprendeu', 'aprendizado aprendeu correcoes'],
  ['Site da empresa (a IA lê o site)', 'aprendizado', 'Seu site', 'site ler pagina conteudo'],
  ['Anúncios e campanhas (de onde vem o cliente)', 'aprendizado', 'Anúncios e campanhas', 'anuncio campanha utm palavras reconhecer origem'],
  ['Código do chat no site', 'site', 'Coloque o chat no seu site', 'instalar script widget codigo site colar'],
  ['Aparência do chat do site', 'site', 'Aparência', 'cor botao posicao visual'],
  ['Passagem do site para o WhatsApp', 'site', 'Passagem para o WhatsApp', 'botao whatsapp site levar mensagem pronta'],
  ['Domínios liberados do chat (segurança)', 'site', 'Segurança', 'dominio permitido seguranca'],
  ['Meta Ads: Pixel e token', 'meta-ads', '', 'pixel token api conversoes facebook instagram configurar meta', ['meta_aba', 'config']],
  ['Meta Ads: código do site (rastrear anúncio)', 'meta-ads', 'Código do site', 'codigo site fbclid rastrear script meta', ['meta_aba', 'config']],
  ['Meta Ads: vendas enviadas', 'meta-ads', 'Vendas para a Meta', 'vendas enviadas meta conversao compra', ['meta_aba', 'vendas']],
  ['Meta Ads: do anúncio ao WhatsApp', 'meta-ads', '', 'fbclid clique anuncio caminho funil perdidos', ['meta_aba', 'caminho']],
  ['Máquina de vendas (receitas prontas)', 'automacoes', 'Receitas prontas', 'automacao receita pos venda reativar avaliacao lembrete'],
  ['Link de avaliação do Google', 'automacoes', 'Link de avaliação do Google', 'google avaliacao review estrelas comentario'],
  ['Link do anúncio (Instagram/Facebook)', 'automacoes', 'Link do anúncio', 'link anuncio instagram facebook'],
  ['Disparo em massa', 'disparos', '', 'campanha enviar para todos lista promocao broadcast massa'],
  ['Vendas e comprovantes (Pix)', 'faturamento', 'Vendas', 'venda pix comprovante faturamento recibo'],
  ['Gastos e lucro', 'faturamento', 'Gastos por categoria|Faturamento e gastos', 'gasto despesa custo lucro categoria'],
  ['Etiquetas', 'organizar', 'Etiquetas do CRM', 'etiqueta etiquetas tag label marcar cliente criar etiqueta renomear cor'],
  ['Etapas do funil', 'organizar', 'Etapas do funil', 'etapa funil kanban coluna'],
  ['Chave do Gemini (IA)', 'chave', 'Gemini', 'api key chave google gemini ia sem credito'],
  ['Chaves reserva', 'chave', 'Chaves reserva', 'reserva backup outra chave limite'],
  ['Gasto de tokens', 'chave', 'Gasto de hoje|Para onde foram os tokens', 'token custo gasto consumo quanto gastei'],
  ['Adicionar leads', 'leads', '', 'importar contatos adicionar lead novo cliente'],
  ['Conversas', 'conversas', '', 'chat responder cliente mensagem whatsapp'],
  ['Trocar senha', '#/conta', 'Trocar senha', 'senha conta login']
];
const PALAVRAS_VAZIAS = new Set(['de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'e', 'para', 'pra', 'pro', 'como', 'que', 'no', 'na', 'nos', 'um', 'uma', 'meu', 'minha', 'onde', 'fica', 'quero', 'ver', 'em', 'com', 'se', 'eu', 'por']);
const raizBusca = (w) => (w.length > 4 ? w.replace(/(oes|aes|ais|eis|res|es|s)$/, '') : w);
function palavrasBusca(t) {
  const base = sem(t);
  // "follow-up" vale como "follow up" e como "followup" (e "QR code" como "qrcode")
  const juntas = [...base.matchAll(/([a-z0-9]+)[-\s]([a-z0-9]+)/g)].map((m) => m[1] + m[2]).filter((w) => w.length >= 6);
  return [...base.replace(/[^a-z0-9#/{} ]+/g, ' ').split(/\s+/), ...juntas].filter((w) => w.length > 1 && !PALAVRAS_VAZIAS.has(w)).map(raizBusca);
}
// distância de edição pequena (erros de digitação: "folowup", "agendameto")
function quasiIgual(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const lim = a.length >= 7 ? 2 : 1;
  let ant = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > lim) return false;
    ant = cur;
  }
  return ant[b.length] <= lim;
}
function pontoPalavra(q, lista) {
  let melhor = 0;
  for (const w of lista) {
    if (w === q) return 3;
    if (q.length >= 3 && (w.startsWith(q) || (q.startsWith(w) && w.length >= 4))) melhor = Math.max(melhor, 2);
    else if (q.length >= 4 && w.includes(q)) melhor = Math.max(melhor, 1.5);
    else if (q.length >= 4 && w.length >= 4 && quasiIgual(q, w)) melhor = Math.max(melhor, 1.2);
  }
  return melhor;
}
// [{ titulo, onde, href, alvo, aba, pontos }] do mais certo ao menos certo
function buscarNoPainel(texto, paginas) {
  const q = palavrasBusca(texto);
  if (!q.length) return [];
  const itens = [
    ...paginas.map((p) => ({ titulo: p.rotulo, onde: 'Página', pagina: p.k, palavras: p.palavras, alvo: '' })),
    ...INDICE_BUSCA.map(([titulo, pagina, alvo, palavras, aba]) => ({ titulo, onde: (paginas.find((p) => p.k === pagina) || {}).rotulo || 'Minha conta', pagina, palavras, alvo, aba }))
  ];
  const r = [];
  for (const it of itens) {
    const doTitulo = palavrasBusca(it.titulo);
    const resto = palavrasBusca(`${it.palavras} ${it.onde}`);
    let pontos = 0;
    let achou = 0;
    for (const w of q) {
      const p = Math.max(pontoPalavra(w, doTitulo) * 1.5, pontoPalavra(w, resto));
      if (p) achou++;
      pontos += p;
    }
    if (!achou || achou < Math.ceil(q.length / 2)) continue;
    if (achou === q.length) pontos += 2;
    if (it.onde === 'Página') pontos += 0.5;
    r.push({ ...it, pontos });
  }
  return r.sort((a, b) => b.pontos - a.pontos).slice(0, 8);
}
// abre a página e rola até a seção (destacada); abre <details> fechado no caminho
async function irParaBusca(empresaId, it) {
  if (it.aba) { try { sessionStorage.setItem(`${it.aba[0]}_${empresaId}`, it.aba[1]); } catch { /* ok */ } }
  const destino = it.pagina.startsWith('#') ? it.pagina : rotaEmpresa(empresaId, it.pagina || undefined);
  if (location.hash === destino) await rotear();
  else location.hash = destino;
  if (!it.alvo) return;
  const alvos = it.alvo.split('|').map(sem);
  for (let i = 0; i < 40; i++) {
    await new Promise((ok) => setTimeout(ok, 200));
    const el = [...document.querySelectorAll('#conteudo h1, #conteudo h2, #conteudo h3, #conteudo summary, #conteudo legend')].find((x) => x.offsetParent !== null && alvos.some((a) => sem(x.textContent).includes(a)));
    if (!el) continue;
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    const bloco = el.closest('.card') || el;
    bloco.scrollIntoView({ behavior: 'smooth', block: 'start' });
    bloco.classList.add('destaque-busca');
    setTimeout(() => bloco.classList.remove('destaque-busca'), 2600);
    return;
  }
}

let paginasBusca = [];
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

// campanha/conjunto/anúncio: o nome (UTM) ou, sem o UTM com nomes, o número (ID) da Meta
const nomeOuNumero = (p) => (!p ? '' : p.nome || `nº ${p.id}`);
function blocoCampanha(cp, curto = false) {
  if (!cp) return '';
  const via = cp.via === 'mensagem' ? '💬 Campanha de mensagem (WhatsApp)' : cp.via === 'site' ? '🌐 Campanha para o site' : '🔗 Link com UTM';
  const itens = [['Campanha', cp.campanha], ['Conjunto', cp.conjunto], ['Anúncio', cp.anuncio]].filter(([, p]) => p);
  if (curto) return itens.map(([n, p]) => `${n.toLowerCase()} <b>${esc(nomeOuNumero(p))}</b>`).join(' · ');
  return `<div class="campanha-lead"><div class="rotulo">${via}</div>${itens.length ? itens.map(([n, p]) => `<div><span class="rotulo">${n}:</span> <b>${esc(nomeOuNumero(p))}</b></div>`).join('') : '<div class="rotulo">Sem nome de campanha (o anúncio não tem UTM).</div>'}${cp.soNumeros ? '<div class="rotulo aviso-texto" style="margin-top:4px">Aparecem só os números (IDs) da Meta: coloque o UTM com os nomes no anúncio (aba Meta Ads → Copiar) para ver o nome da campanha e do anúncio.</div>' : ''}</div>`;
}

// Linha curta (topo do chat): "📣 Anúncio Instagram · campanha verao · vendo: Volante em couro"
function linhaOrigem(o) {
  if (!o || (!o.fonte && !o.atual && !o.anuncio && !o.manual)) return '';
  const atual = o.atual || o.paginas?.[o.paginas.length - 1];
  const partes = [];
  if (o.fonte || atual) partes.push(`${ICONE_FONTE[o.tipo] || '🌐'} Veio ${o.fonte ? `de <b>${esc(o.fonte)}</b>` : 'do site'}`);
  if (o.anuncio) partes.push(`anúncio <b>${esc(o.anuncio.nome)}</b>`);
  else if (o.campanhaMeta && blocoCampanha(o.campanhaMeta, true)) partes.push(blocoCampanha(o.campanhaMeta, true));
  else if (o.campanha) partes.push(`campanha <b>${esc(o.campanha)}</b>`);
  if (atual) partes.push(`estava vendo ${linkPagina(atual)}`);
  if (o.manual) partes.push(`📝 ${esc(o.manual)}`);
  return `<div class="chat-origem" title="${esc(partes.join(' · ').replace(/<[^>]+>/g, ''))}">${partes.join(' · ')}</div>`;
}

// 📣 Meta Ads na conversa: o cliente veio de anúncio (o CRM pegou o fbclid do clique)
function linhaMeta(m) {
  if (!m) return '';
  const data = (iso, hora = true) => (iso ? new Date(iso).toLocaleString('pt-BR', hora ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' }) : '');
  const via = { site: 'campanha para o site (clicou no anúncio e passou pelo site)', whatsapp: 'campanha de mensagem (anúncio direto para o WhatsApp)', utm: 'link marcado como Facebook/Instagram' }[m.via] || '';
  const info = [
    m.clicouEm ? `em <b>${esc(data(m.clicouEm))}</b>` : '',
    m.campanha ? `campanha <b>${esc(m.campanha)}</b>` : '',
    m.conjunto ? `conjunto <b>${esc(m.conjunto)}</b>` : '',
    m.anuncio ? `anúncio <b>${esc(m.anuncio)}</b>` : '',
    m.anuncioZap?.titulo && !m.anuncio ? `anúncio <b>${esc(m.anuncioZap.titulo)}</b>` : '',
    m.soNumeros ? '<span class="aviso-texto">só os números da Meta: coloque o UTM com nomes no anúncio</span>' : '',
    m.origem ? `origem ${esc(m.origem)}` : '',
    m.pagina && m.via === 'site' ? `página ${esc(m.pagina)}` : ''
  ].filter(Boolean).join(' · ');
  const curto = m.fbclid.length > 18 ? `${m.fbclid.slice(0, 10)}…${m.fbclid.slice(-6)}` : m.fbclid;
  const d = m.dados || {};
  const marca = (ok, nome) => `${ok ? '✓' : '✗'} ${nome}`;
  const dados = [
    m.fbclid ? `✓ fbclid <code title="${esc(m.fbclid)}">${esc(curto)}</code> <button type="button" class="link-botao" data-copiar-fbclid="${esc(m.fbclid)}">copiar</button>` : '✗ fbclid',
    marca(d.telefone, 'telefone'), marca(d.nome, 'nome'), marca(d.pixelDoSite, 'cookie do Pixel'), marca(d.ipNavegador, 'IP/navegador')
  ].join(' · ');
  const envio = !m.ligado ? '<span class="aviso-texto">⚪ envio de vendas para a Meta desligado</span>'
    : m.naoVai ? `<span class="aviso-texto">⚠️ se comprar, a venda NÃO vai para a Meta: ${esc(m.naoVai)}</span>`
    : m.peloTelefone && m.viaMensagem ? '✅ se comprar, a venda vai para a Meta (campanha de mensagem: a Meta reconhece o cliente pelo telefone)'
    : m.peloTelefone ? '✅ se comprar, a venda vai para a Meta pelo telefone (sem o clique: a Meta reconhece o cliente)'
    : `✅ se comprar até <b>${esc(data(m.vaiAte, false))}</b>, a venda vai para a Meta`;
  const vendas = (m.vendas || []).map((v) => `<div>💰 ${brl(v.valor)} → ${esc(v.situacao)}</div>`).join('');
  // fechado por padrão: só a etiqueta "📣 Meta Ads" com um resumo; clica e abre os detalhes
  const resumo = (m.vendas || []).length ? `💰 ${m.vendas.length} venda${m.vendas.length > 1 ? 's' : ''}` : !m.ligado ? 'envio desligado' : m.naoVai ? '⚠️ venda não vai' : m.via === 'whatsapp' ? '💬 campanha de mensagem' : m.via === 'site' ? '🌐 campanha para o site' : 'veio de anúncio';
  return `<details class="chat-meta"><summary><span class="chat-meta-etiqueta">📣 Meta Ads</span><span class="rotulo">${resumo}${m.campanha ? ` · ${esc(m.campanha)}` : ''}</span></summary><div class="chat-meta-corpo"><div>${esc(via)}${info ? ` · ${info}` : ''}</div><div class="chat-meta-dados">${dados}</div><div>${envio}</div>${vendas}</div></details>`;
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
      ${o.fonte || o.chegada ? `<div class="origem-fonte">${ICONE_FONTE[o.tipo] || '🌐'} <b>${esc(o.fonte || 'Site')}</b>${o.campanha && !o.campanhaMeta ? `<span class="rotulo"> · campanha ${esc(o.campanha)}</span>` : ''}</div>` : o.campanhaMeta ? '' : '<p class="rotulo" style="margin:0">Sem informação automática (o cliente não passou pelo chat nem por um botão do site, nem por anúncio de clique para WhatsApp).</p>'}
      ${blocoCampanha(o.campanhaMeta)}
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
  $$('[data-acesso-empresa]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const emp = lista.find((x) => x.id === b.dataset.acessoEmpresa);
      const ativar = b.dataset.ativar === '1';
      const contas = (emp?.contas || []).map((u) => esc(u.email)).join(', ');
      const ok = await confirmar(ativar
        ? { titulo: `Reativar ${esc(emp?.nome || '')}?`, texto: `A IA, as automações e o follow-up voltam a funcionar${contas ? `, e ${contas} volta(m) a entrar no painel` : ''}. Tudo continua como estava.`, botao: '✅ Reativar' }
        : { titulo: `Desativar ${esc(emp?.nome || '')}?`, texto: `<b>Nada é apagado.</b> Enquanto estiver desativada:<br>• a IA do site e a do WhatsApp, as automações, o follow-up e os disparos param;<br>• ${contas ? `<b>${contas}</b> sai do painel na hora e não consegue mais entrar` : 'ninguém dessa empresa consegue entrar no painel'}.<br><br>Dá para reativar quando quiser, com um clique.`, botao: '🚫 Desativar', perigo: true });
      if (!ok) return;
      try {
        await comEspera(b, () => api(`empresas/${emp.id}/acesso`, { method: 'POST', body: { ativo: ativar } }));
        aviso(ativar ? 'Conta reativada.' : 'Conta desativada. Nada foi apagado.');
        depois();
      } catch (err) { aviso(err.message, true); }
    };
  });
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
  if (zapLigado) lista.push({ feito: emp.totalMidias > 0 || (emp.links || []).length > 0, texto: 'Coloque fotos e links para a IA usar', dica: 'Mostrar o trabalho vende: a IA manda quando o cliente pedir.', href: rotaEmpresa(id, 'midias') });
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
    <div id="painel-previsao"></div>
    ${cartaoEsperandoIa(emp, id)}

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
  // 💰 previsão de faturamento pelos agendamentos (sem IA), carregada depois para não atrasar o painel
  api(`empresas/${id}/agendamentos`).then((d) => {
    const el = $('#painel-previsao');
    if (!el || location.hash !== hashDaPagina || !(d.proximos || []).length && !(d.passados || []).length) return;
    const p = (k) => somaPrevisao(d, periodoPrevisao(k));
    const [h, s7, m] = [p('hoje'), p('7d'), p('mes')];
    const bloco = (t, r) => `<div><span class="rotulo">${t}</span><b>${brl(r.aEntrar)}</b><span class="rotulo">${r.n} agendamento${r.n === 1 ? '' : 's'}${r.semValor ? ` · ${r.semValor} sem valor` : ''}</span></div>`;
    el.innerHTML = `
      <div class="card ag-previsao">
        <div class="cabecalho" style="margin-bottom:10px;padding-right:0"><h2 style="margin:0">💰 Previsão de faturamento (agendamentos)</h2><a class="botao pequeno" href="${rotaEmpresa(id, 'agenda')}">Ver por data →</a></div>
        <div class="cat-resumo painel-prev">${bloco('Hoje', h)}${bloco('Próximos 7 dias', s7)}${bloco('Este mês (a fazer)', m)}</div>
        ${m.nFeitos ? `<p class="rotulo" style="margin:10px 0 0">Já realizados este mês: <b>${brl(m.realizado)}</b> em ${m.nFeitos} atendimento${m.nFeitos === 1 ? '' : 's'}.</p>` : ''}
      </div>`;
  }).catch(() => { /* sem agenda: o painel segue normal */ });
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
    ${r.prompt ? `<details><summary>Prompt que a IA recebeu: ${Number(r.prompt.enviado || 0).toLocaleString('pt-BR')} caracteres (salvo: ${Number(r.prompt.salvo || 0).toLocaleString('pt-BR')})${r.prompt.inteiro ? ' ✓ inteiro' : ' ⚠️ incompleto'}${r.prompt.historicoCortado ? ` · ${r.prompt.historicoCortado} mensagem(ns) antiga(s) do histórico fora` : ''}</summary><div class="rotulo">Fim do texto que a IA recebeu (últimos 200 caracteres):</div><pre class="bruto-ia">${esc(r.prompt.final || '')}</pre></details>` : ''}
    ${(r.avisos || []).map((a) => `<div class="det-aviso">⚠️ ${esc(a)}</div>`).join('')}
    ${erros.map((e) => `<div class="det-erro">✕ ${esc(e)}</div>`).join('')}
    ${r.bruto ? `<details><summary>Texto bruto da IA</summary><pre class="bruto-ia">${esc(r.bruto)}</pre></details>` : ''}
  </div>`;
}

// soltar um arquivo fora de uma área que aceita não abre o arquivo no lugar do CRM
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files') && !e.defaultPrevented) e.preventDefault(); });

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

// Máximo das instruções (o servidor recusa acima disso, sem cortar)
const MAX_PROMPT = 30000;
function tamanhoPrompt(noCampo, salvo) {
  const n = String(noCampo || '').trim().length;
  const fmt = (x) => x.toLocaleString('pt-BR');
  const campo = n > MAX_PROMPT
    ? `<span class="pi-tag aviso">${fmt(n)} de ${fmt(MAX_PROMPT)} caracteres — passou do máximo; encurte antes de salvar</span>`
    : `<b>${fmt(n)}</b> de ${fmt(MAX_PROMPT)} caracteres no campo`;
  return `${campo} · <span class="rotulo">salvo: ${fmt(String(salvo || '').length)}</span>`;
}

// ⏳ Clientes esperando os tokens da IA voltarem (limite/crédito): a IA responde sozinha, em ordem
function cartaoEsperandoIa(emp, id) {
  const n = emp.esperandoIaCredito || 0;
  if (!n) return '';
  return `<div class="balao balao-aviso" style="margin:0 0 14px"><span class="balao-icone">⏳</span><div><strong>Esperando token da IA: ${n} cliente${n === 1 ? '' : 's'}</strong><div class="balao-texto">A IA ficou sem cota (limite grátis ou crédito) e vai responder ${n === 1 ? 'esse cliente' : `esses ${n} clientes`} sozinha, na ordem de chegada, assim que os tokens voltarem.${emp.chaves?.geminiReserva?.propria || emp.chaves?.geminiReserva2?.propria || emp.chaves?.geminiReserva3?.propria ? '' : ` Para não parar mais: cadastre uma <a href="${rotaEmpresa(id, 'chave')}">chave reserva do Gemini</a>.`}</div></div></div>`;
}

// ⏱️ Tempo de resposta da IA (WhatsApp): opções e o resumo do cartão fechado
const TEMPOS_PRIMEIRA = [[0, 'na hora (só a velocidade acima)'], [30, '30 segundos'], [60, '1 minuto'], [120, '2 minutos'], [300, '5 minutos'], [600, '10 minutos'], [1800, '30 minutos']];
function resumoTempoIa(w) {
  const vel = { rapido: 'Rápido', humanizado: 'Humanizado', lento: 'Mais lento', humano: 'Bem humano' }[w.velocidade || 'humanizado'] || 'Humanizado';
  const prim = Number(w.esperaPrimeiraSeg || 0);
  const txtPrim = prim ? (TEMPOS_PRIMEIRA.find(([v]) => v === prim)?.[1] || `${prim} s`) : 'na hora';
  return `${vel} · 1ª mensagem: ${txtPrim} · pausas ${w.esperaAntesMidiaSeg ?? 3}/${w.esperaDepoisMidiaSeg ?? 10}/${w.esperaEntreTextosSeg ?? 5} s`;
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
        <div class="pi-linha"><span class="pi-rot">Tamanho</span><span>${tamanhoPrompt(area.value, salvo)}</span></div>
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
            ${r.conversas.map((c) => `<div class="cf-conversa"><p><span class="rotulo">Cliente:</span> ${esc(c.cliente)}</p><p><span class="rotulo">IA:</span> ${c.ia ? `<span style="white-space:pre-wrap;display:block">${esc(c.ia)}</span>` : `<span class="aviso-texto">${esc(c.erro || 'sem resposta')}</span>`}${c.acoes?.length ? ` <span class="rotulo">(${esc(c.acoes.join('; '))})</span>` : ''}</p></div>`).join('')}
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

// Previsão de faturamento pelos agendamentos (valor lido sem IA: digitado, descrição ou conversa)
const diaSp = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
function periodoPrevisao(chave, de, ate) {
  const hoje = diaSp(new Date().toISOString());
  const somar = (dias) => diaSp(new Date(Date.now() + dias * 86400000).toISOString());
  const [a, m] = hoje.split('-').map(Number);
  const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const mesTxt = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;
  if (chave === 'hoje') return { de: hoje, ate: hoje };
  if (chave === '7d') return { de: hoje, ate: somar(6) };
  if (chave === '30d') return { de: hoje, ate: somar(29) };
  if (chave === 'mes') return { de: `${mesTxt(a, m)}-01`, ate: `${mesTxt(a, m)}-${ultimoDia(a, m)}` };
  if (chave === 'proximo') { const [a2, m2] = m === 12 ? [a + 1, 1] : [a, m + 1]; return { de: `${mesTxt(a2, m2)}-01`, ate: `${mesTxt(a2, m2)}-${ultimoDia(a2, m2)}` }; }
  if (chave === 'tudo') return { de: hoje, ate: '9999-12-31' };
  return { de: de || hoje, ate: ate || de || hoje };
}
// Faturamento: períodos para trás (hoje, ontem, últimos 7/30 dias, este mês, mês passado, escolher datas)
const PERIODOS_VENDAS = [['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', 'Últimos 7 dias'], ['30d', 'Últimos 30 dias'], ['mes', 'Este mês'], ['mespassado', 'Mês passado'], ['tudo', 'Tudo'], ['datas', 'Escolher datas']];
function periodoVendas(chave, de, ate) {
  const hoje = diaSp(new Date().toISOString());
  const voltar = (dias) => diaSp(new Date(Date.now() - dias * 86400000).toISOString());
  const [a, m] = hoje.split('-').map(Number);
  const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const mesTxt = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;
  if (chave === 'hoje') return { de: hoje, ate: hoje };
  if (chave === 'ontem') return { de: voltar(1), ate: voltar(1) };
  if (chave === '7d') return { de: voltar(6), ate: hoje };
  if (chave === '30d') return { de: voltar(29), ate: hoje };
  if (chave === 'mes') return { de: `${mesTxt(a, m)}-01`, ate: hoje };
  if (chave === 'mespassado') { const [a2, m2] = m === 1 ? [a - 1, 12] : [a, m - 1]; return { de: `${mesTxt(a2, m2)}-01`, ate: `${mesTxt(a2, m2)}-${ultimoDia(a2, m2)}` }; }
  if (chave === 'tudo') return { de: '', ate: '' };
  const d1 = /^\d{4}-\d{2}-\d{2}$/.test(de || '') ? de : voltar(6);
  const d2 = /^\d{4}-\d{2}-\d{2}$/.test(ate || '') ? ate : hoje;
  return d1 <= d2 ? { de: d1, ate: d2 } : { de: d2, ate: d1 };
}

function somaPrevisao(d, { de, ate }) {
  const dentro = (x) => x.quando && diaSp(x.quando) >= de && diaSp(x.quando) <= ate;
  const futuros = (d.proximos || []).filter(dentro);
  const feitos = (d.passados || []).filter((x) => dentro(x) && (x.status === 'realizado' || x.status === 'concluido'));
  const total = (l) => l.reduce((n, x) => n + (Number(x.valor) || 0), 0);
  return {
    aEntrar: total(futuros), n: futuros.length, semValor: futuros.filter((x) => !x.valor).length, incertos: futuros.filter((x) => x.valorIncerto).length,
    realizado: total(feitos), nFeitos: feitos.length,
    semData: (d.proximos || []).filter((x) => !x.quando).length
  };
}
const ORIGEM_VALOR = { manual: 'você colocou', descricao: 'da descrição', conversa: 'lido da conversa' };

async function paginaAgenda(id, params) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  const [d, horas] = await Promise.all([api(`empresas/${id}/agendamentos`), api(`empresas/${id}/horarios-ia`).catch(() => null)]);
  if (location.hash !== hashDaPagina) return;
  let aba = params?.get('aba') || 'proximos';
  const modoEmp = d.regras?.modo || 'presencial';
  const temOnline = [...d.proximos, ...d.passados].some((x) => x.modo === 'online');
  let tipo = 'todos';
  try { tipo = localStorage.getItem('ag-tipo') || 'todos'; } catch { /* sem armazenamento */ }
  if (modoEmp === 'presencial' && !temOnline) tipo = 'todos';
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
  const STATUS = (x) => x.status === 'concluido' ? ['ok', '✅ Venda concluída'] : x.status === 'realizado' ? ['neutro', x.semData ? 'Saiu da agenda' : '✔ Realizado'] : x.status === 'remarcado' ? ['off', 'Horário trocado'] : x.status === 'cancelado' ? ['off', 'Cancelado'] : x.quando && chaveDia(x.quando) === hoje ? ['hoje', '● Hoje'] : ['agendado', 'Agendado'];
  const falta = (iso) => {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return '';
    const h = Math.round(ms / 3600000);
    return h < 1 ? `em ${Math.max(1, Math.round(ms / 60000))} min` : h < 24 ? `em ${h} h` : `em ${Math.round(h / 24)} dia${Math.round(h / 24) > 1 ? 's' : ''}`;
  };
  const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const cartao = (x) => {
    const [cls, rotulo] = STATUS(x);
    const nFotos = (x.fotos || []).length;
    return `
    <article class="ag-card ${x.grupo} st-${cls}" data-ag="${esc(x.id)}">
      <header class="ag-card-topo">
        <div class="ag-card-hora">
          <b>${x.quando ? (x.semHora ? '<span title="Combinaram o dia, mas não a hora">a combinar</span>' : sp(x.quando, { hour: '2-digit', minute: '2-digit' })) : '--:--'}</b>
          <span>${x.quando ? esc(maiuscula(sp(x.quando, { weekday: 'short', day: '2-digit', month: 'short' }).replace(/ de /g, ' ').replace(/\./g, ''))) : 'Data a combinar'}${x.grupo === 'proximos' && x.quando && falta(x.quando) ? ` · ${falta(x.quando)}` : ''}</span>
        </div>
        <span class="ag-status ${cls}">${esc(rotulo)}</span>
      </header>
      <div class="ag-card-cliente">
        ${avatarLead({ nome: x.nome, telefone: x.telefone, fotoUrl: x.foto })}
        <div><strong>${esc(x.nome || telefoneBonito(x.telefone) || 'Cliente')}</strong><span>${esc(telefoneBonito(x.telefone) || '')}${x.local && x.modo !== 'online' ? ` · 📍 ${esc(x.local)}` : ''}</span></div>
      </div>
      <p class="ag-card-servico">${x.modo === 'online' ? '<span class="ag-online">💻 Online</span> ' : modoEmp !== 'presencial' ? '<span class="ag-presencial">📍 Presencial</span> ' : ''}${esc(x.descricao || 'Serviço não descrito')}</p>
      ${x.modo === 'online' && x.link ? `<a class="ag-entrar" href="${esc(x.link)}" target="_blank" rel="noopener">🔗 Abrir link da reunião</a>` : ''}
      ${x.status === 'cancelado' || x.status === 'remarcado' ? '' : `<button type="button" class="ag-valor ${x.valor ? '' : 'vazio'} ${x.valorIncerto ? 'incerto' : ''}" data-ag-valor="${esc(x.id)}" title="${esc(x.valorTrecho || 'Clique para colocar ou corrigir o valor')}">💰 ${x.valor ? `<b>${brl(x.valor)}</b> <small>${esc(ORIGEM_VALOR[x.valorOrigem] || '')}${x.valorIncerto ? ' · ⚠️ confira' : ''}</small>` : '<small>Sem valor — clique para colocar</small>'} <span aria-hidden="true">✎</span></button>`}
      <div class="ag-card-info">
        <span title="Quem marcou">🗓️ ${esc(QUEM[x.por] || x.por || 'equipe')}</span>
        ${x.avisoStatus === 'enviado' ? '<span class="ok" title="O número de aviso recebeu">🔔 aviso enviado</span>' : x.avisoStatus === 'erro' ? `<span class="erro" title="${esc(x.avisoErro)}">🔔 aviso falhou</span>` : ''}
      </div>
      <footer class="ag-card-acoes">
        <button type="button" class="ag-btn-fotos" data-ag-fotos="${esc(x.id)}" ${nFotos ? '' : 'disabled title="O cliente não mandou fotos na conversa"'}>📷 ${nFotos ? `Ver fotos <em>${nFotos}</em>` : 'Sem fotos do cliente'}</button>
        <a class="botao pequeno" href="${rotaEmpresa(id, 'conversas')}?lead=${esc(x.leadId)}">💬 Conversa</a>
        ${x.grupo === 'proximos' ? `<button type="button" class="pequeno" data-ag-cancelar="${esc(x.id)}" data-lead="${esc(x.leadId)}" title="Cancelar: o cliente ou você desmarcou (fica no histórico)">✕ Cancelar</button>` : ''}
        <button type="button" class="pequeno perigo" data-ag-excluir="${esc(x.id)}" data-lead="${esc(x.leadId)}" title="Excluir: o agendamento está errado (some de tudo)">🗑️ Excluir</button>
      </footer>
    </article>`;
  };
  const desenhar = () => {
    const itens = (d[aba] || []).filter((x) => tipo === 'todos' || x.modo === tipo);
    let html = '';
    if (!itens.length) html = `<div class="card vazio-grande"><div class="vazio-icone">📅</div><h2>${aba === 'proximos' ? 'Nenhum agendamento pela frente' : aba === 'passados' ? 'Nenhum agendamento passado' : 'Nenhum cancelado'}${tipo !== 'todos' ? ` (${tipo === 'online' ? 'online' : 'presencial'})` : ''}</h2><p class="rotulo">${aba === 'proximos' ? 'Quando você, a equipe ou a IA combinarem um horário com o cliente no WhatsApp, ele aparece aqui sozinho.' : ''}</p></div>`;
    else {
      const grupos = [];
      for (const x of itens) {
        const k = x.quando ? chaveDia(x.quando) : 'sem-data';
        if (!grupos.length || grupos[grupos.length - 1].k !== k) grupos.push({ k, titulo: x.quando ? tituloDia(x.quando) : 'Data a combinar', itens: [] });
        grupos[grupos.length - 1].itens.push(x);
      }
      html = grupos.map((g) => `<section class="ag-grupo"><h3 class="ag-grupo-titulo ${g.k === hoje ? 'hoje' : ''}">${esc(g.titulo)} <span>${g.itens.length}</span></h3><div class="ag-grade">${g.itens.map(cartao).join('')}</div></section>`).join('');
    }
    $('#ag-conteudo').innerHTML = html;
    $$('[data-ag-fotos]').forEach((b) => {
      b.onclick = () => {
        const x = itens.find((y) => y.id === b.dataset.agFotos);
        if (x?.fotos?.length) galeriaFotos(x.fotos, x.nome || telefoneBonito(x.telefone) || 'Cliente');
      };
    });
    $$('[data-ag-excluir]').forEach((b) => {
      b.onclick = async () => {
        if (!(await excluirAgendamento(b.dataset.lead, b.dataset.agExcluir))) return;
        paginaAgenda(id, new URLSearchParams({ aba })).then(() => montarMenu(rotaEmpresa(id, 'agenda')));
      };
    });
    $$('[data-ag-cancelar]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmar({ titulo: 'Cancelar este agendamento?', texto: 'Ele sai da agenda e o lead sai de "Agendou". Se o aviso de agendamento estiver ligado, o número cadastrado recebe o cancelamento. O cliente não recebe nada automático.', botao: 'Cancelar agendamento', perigo: true }))) return;
        try { await api(`leads/${b.dataset.lead}/agendamentos/${b.dataset.agCancelar}`, { method: 'DELETE', body: {} }); aviso('Agendamento cancelado.'); paginaAgenda(id, new URLSearchParams({ aba })).then(() => montarMenu(rotaEmpresa(id, 'agenda'))); } catch (err) { aviso(err.message, true); }
      };
    });
  };
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Agendamentos</h1><p class="sub">O que está marcado com os clientes — presencial ou online. Entra sozinho quando um horário é combinado no WhatsApp.</p></div><a class="botao" href="${rotaEmpresa(id, 'whatsapp')}">Aviso no WhatsApp</a></div>
    <div class="card cat-resumo">
      <div><span class="rotulo">Hoje</span><b>${d.resumo.hoje}</b></div>
      <div><span class="rotulo">Próximos 7 dias</span><b>${d.resumo.semana}</b></div>
      <div><span class="rotulo">Todos à frente</span><b>${d.resumo.proximos}</b></div>
    </div>
    <div class="card ag-previsao" id="ag-previsao"></div>
    <div class="card ag-tipo">
      <h2 style="margin:0 0 4px">🧭 Como você atende</h2>
      <p class="rotulo" style="margin:0 0 10px">Muda o que a IA pede antes de marcar. Online = videochamada, ligação, reunião ou serviço digital (site, design, consultoria, aula…): <b>nunca pede endereço</b>.</p>
      <div class="ag-modos">${[['presencial', '📍', 'Presencial', 'Visita, instalação, loja ou consultório'], ['online', '💻', 'Online / digital', 'Videochamada, ligação ou serviço digital'], ['ambos', '🔀', 'Os dois', 'A IA pergunta como o cliente prefere']].map(([k, ic, nome, txt]) => `<button type="button" class="ag-modo ${modoEmp === k ? 'ativo' : ''}" data-ag-modo="${k}" aria-pressed="${modoEmp === k}"><span>${ic}</span><b>${nome}</b><small>${txt}</small></button>`).join('')}</div>
      ${modoEmp !== 'presencial' ? `<form class="campo ag-link" id="ag-link-form" style="margin-top:12px"><label>🔗 Link das reuniões online <span class="rotulo">(opcional — a IA manda quando confirma)</span></label><div class="linha-input"><input name="link" type="url" inputmode="url" maxlength="300" placeholder="https://meet.google.com/abc-defg-hij" value="${esc(d.regras?.link || '')}"><button type="submit">Salvar</button></div><small class="rotulo">Google Meet, Zoom, Teams ou sua página de reunião. Vazio: a IA diz que o link (ou a ligação) chega pelo WhatsApp perto do horário.</small></form>` : ''}
    </div>
    <div class="card" ${modoEmp === 'online' ? 'hidden' : ''}>
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">🛡️ Agendamento automático</h2>${interruptor('ag-exige-endereco', d.regras?.exigeEndereco !== false, modoEmp === 'ambos' ? 'Presencial só com o endereço do cliente' : 'Só agendar com o endereço do cliente')}</div>
      <p class="rotulo" style="margin:0">O CRM só marca sozinho quando ficar combinado <b>dia e horário</b> (pergunta como "atende hoje?" não marca) — pela IA, pelo cliente aceitando uma proposta, ou quando <b>você</b> confirma por mensagem ("agendado sábado às 9h").${d.regras?.exigeEndereco !== false ? ' Com esta opção ligada, também precisa do <b>endereço</b> do cliente na conversa (rua e número, CEP ou localização do WhatsApp); sem ele, a IA pede o endereço e você recebe um aviso. Agendar à mão ou pela etiqueta Agendado continua livre.' : ''}</p>
    </div>
    ${horas ? `<div class="card" id="card-horarios-ia"></div>` : ''}
    <div class="chips ag-abas">${[['proximos', `Próximos (${d.proximos.length})`], ['passados', `Passados (${d.passados.length})`], ['cancelados', `Cancelados (${d.cancelados.length})`]].map(([k, r]) => `<button type="button" class="chip-filtro ${k === aba ? 'ativo' : ''}" data-ag-aba="${k}">${r}</button>`).join('')}</div>
    ${modoEmp !== 'presencial' || temOnline ? `<div class="chips ag-tipos">${[['todos', 'Todos'], ['presencial', '📍 Presencial'], ['online', '💻 Online']].map(([k, r]) => `<button type="button" class="chip-filtro ${k === tipo ? 'ativo' : ''}" data-ag-tipo="${k}">${r}</button>`).join('')}</div>` : ''}
    <div id="ag-conteudo"></div>`;
  $$('[data-ag-tipo]').forEach((b) => { b.onclick = () => { tipo = b.dataset.agTipo; try { localStorage.setItem('ag-tipo', tipo); } catch { /* sem armazenamento */ } $$('[data-ag-tipo]').forEach((x) => x.classList.toggle('ativo', x === b)); desenhar(); }; });
  $$('[data-ag-modo]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`empresas/${id}/agenda-regras`, { method: 'PUT', body: { modo: b.dataset.agModo } });
        aviso({ presencial: 'Atendimento presencial.', online: 'Atendimento online: a IA não pede mais endereço.', ambos: 'Presencial e online: a IA pergunta como o cliente prefere.' }[b.dataset.agModo]);
        paginaAgenda(id, new URLSearchParams({ aba }));
      } catch (err) { aviso(err.message, true); }
    };
  });
  $('#ag-link-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`empresas/${id}/agenda-regras`, { method: 'PUT', body: { link: e.target.elements.link.value.trim() } });
      aviso(e.target.elements.link.value.trim() ? 'Link salvo: a IA manda quando confirmar um agendamento online.' : 'Link apagado.');
    } catch (err) { aviso(err.message, true); }
  });
  $$('[data-ag-aba]').forEach((b) => { b.onclick = () => { aba = b.dataset.agAba; $$('[data-ag-aba]').forEach((x) => x.classList.toggle('ativo', x === b)); desenhar(); }; });
  $('#ag-exige-endereco').onchange = async (e) => {
    try {
      await api(`empresas/${id}/agenda-regras`, { method: 'PUT', body: { exigeEndereco: e.target.checked } });
      aviso(e.target.checked ? 'Ligado: só agenda com o endereço do cliente.' : 'Desligado: agenda sem exigir endereço.');
      paginaAgenda(id, new URLSearchParams({ aba }));
    } catch (err) { e.target.checked = !e.target.checked; aviso(err.message, true); }
  };
  let filtro = { chave: 'mes', de: '', ate: '' };
  try { filtro = { ...filtro, ...JSON.parse(localStorage.getItem('previsao-filtro') || '{}') }; } catch { /* sem preferência salva */ }
  const PRESETS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Este mês'], ['proximo', 'Próximo mês'], ['tudo', 'Tudo à frente'], ['datas', 'Escolher datas']];
  const desenharPrevisao = () => {
    const per = periodoPrevisao(filtro.chave, filtro.de, filtro.ate);
    const r = somaPrevisao(d, per);
    const fmt = (iso) => iso === '9999-12-31' ? 'em diante' : iso.split('-').reverse().join('/');
    $('#ag-previsao').innerHTML = `
      <div class="ag-prev-topo">
        <div><span class="rotulo">💰 Previsão de faturamento · ${per.de === per.ate ? fmt(per.de) : `${fmt(per.de)} ${per.ate === '9999-12-31' ? 'em diante' : `a ${fmt(per.ate)}`}`}</span>
          <b class="ag-prev-valor">${brl(r.aEntrar)}</b>
          <span class="rotulo">${r.n} agendamento${r.n === 1 ? '' : 's'} a fazer${r.semValor ? ` · <span class="aviso-texto">${r.semValor} sem valor (clique no 💰 do card)</span>` : ''}${r.incertos ? ` · ${r.incertos} com várias opções — confira` : ''}</span></div>
        ${r.nFeitos ? `<div class="ag-prev-feito"><span class="rotulo">Já realizados no período</span><b>${brl(r.realizado)}</b><span class="rotulo">${r.nFeitos} atendimento${r.nFeitos === 1 ? '' : 's'}</span></div>` : ''}
      </div>
      <div class="chips" style="margin-top:12px">${PRESETS.map(([k, t]) => `<button type="button" class="chip-filtro ${filtro.chave === k ? 'ativo' : ''}" data-prev="${k}">${t}</button>`).join('')}</div>
      ${filtro.chave === 'datas' ? `<div class="campos" style="margin-top:10px"><div class="campo"><label>De</label><input type="date" id="prev-de" value="${esc(per.de)}"></div><div class="campo"><label>Até</label><input type="date" id="prev-ate" value="${esc(per.ate)}"></div></div>` : ''}
      ${r.semData ? `<p class="rotulo" style="margin:8px 0 0">${r.semData} agendamento(s) com "data a combinar" não entram na conta.</p>` : ''}
      <p class="rotulo" style="margin:8px 0 0">O valor de cada agendamento é lido sem IA: o que você digitou no card, um preço na descrição ou o último preço combinado na conversa.</p>`;
    const guardar = () => { try { localStorage.setItem('previsao-filtro', JSON.stringify(filtro)); } catch { /* sem armazenamento */ } };
    $$('[data-prev]').forEach((b) => { b.onclick = () => { filtro.chave = b.dataset.prev; if (filtro.chave === 'datas' && !filtro.de) Object.assign(filtro, periodoPrevisao('mes')); guardar(); desenharPrevisao(); }; });
    const mudarData = () => { filtro.de = $('#prev-de').value; filtro.ate = $('#prev-ate').value; if (filtro.ate && filtro.de > filtro.ate) filtro.ate = filtro.de; guardar(); desenharPrevisao(); };
    $('#prev-de')?.addEventListener('change', mudarData);
    $('#prev-ate')?.addEventListener('change', mudarData);
  };
  desenharPrevisao();
  // 💰 do card: colocar ou corrigir o valor (vazio = volta a ler da conversa)
  $('#ag-conteudo').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ag-valor]');
    if (!b) return;
    const x = [...d.proximos, ...d.passados].find((y) => y.id === b.dataset.agValor);
    if (!x) return;
    abrirModal(`
      <h2>💰 Valor do agendamento</h2>
      <p class="rotulo">${esc(x.nome || telefoneBonito(x.telefone) || 'Cliente')}${x.quando ? ` · ${esc(new Date(x.quando).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}` : ''}</p>
      ${x.valor && x.valorOrigem !== 'manual' ? `<p class="texto-modal">O CRM leu <b>${brl(x.valor)}</b> (${esc(ORIGEM_VALOR[x.valorOrigem] || '')})${x.valorTrecho ? `: “${esc(x.valorTrecho)}”` : ''}.</p>` : ''}
      <form id="f-valor-ag"><div class="campo"><label>Valor (R$)</label><input name="valor" inputmode="decimal" placeholder="Ex.: 450 ou 1.250,00" value="${x.valorOrigem === 'manual' ? esc(String(x.valor).replace('.', ',')) : ''}"></div>
        <div class="acoes"><button class="primario" type="submit">Salvar</button>${x.valorOrigem === 'manual' ? '<button type="button" id="valor-auto">Voltar a ler da conversa</button>' : ''}<button type="button" data-fechar>Cancelar</button></div></form>`, (m, fechar) => {
      const enviar = async (valor) => {
        try {
          const r = await api(`leads/${x.leadId}/agendamentos/${x.id}/valor`, { method: 'PUT', body: { valor } });
          Object.assign(x, { valor: r.valor, valorOrigem: r.origem || '', valorIncerto: Boolean(r.incerto), valorTrecho: r.trecho || '' });
          fechar(); desenhar(); desenharPrevisao(); aviso('Valor salvo.');
        } catch (err) { aviso(err.message, true); }
      };
      $('#f-valor-ag', m).onsubmit = (e) => { e.preventDefault(); const v = e.target.valor.value.trim(); if (!v) return aviso('Digite o valor.', true); enviar(v); };
      $('#valor-auto', m)?.addEventListener('click', () => enviar(null));
    });
  });
  desenhar();
  if (horas) desenharHorariosIa(id, horas);
}

// Galeria das fotos que o cliente mandou (ex.: o volante): foto grande, miniaturas e setas
function galeriaFotos(fotos, nome) {
  let i = 0;
  abrirModal(`
    <div class="galeria">
      <div class="galeria-topo"><h2>📷 Fotos de ${esc(nome)}</h2><button type="button" class="galeria-fechar" data-fechar aria-label="Fechar">✕</button></div>
      <div class="galeria-palco">
        <button type="button" class="galeria-seta" data-ir="-1" aria-label="Foto anterior" ${fotos.length > 1 ? '' : 'hidden'}>‹</button>
        <a id="galeria-link" target="_blank" rel="noopener" title="Abrir em tamanho original"><img id="galeria-img" alt="Foto enviada pelo cliente"></a>
        <button type="button" class="galeria-seta" data-ir="1" aria-label="Próxima foto" ${fotos.length > 1 ? '' : 'hidden'}>›</button>
      </div>
      <p class="galeria-legenda" id="galeria-legenda"></p>
      ${fotos.length > 1 ? `<div class="galeria-miniaturas">${fotos.map((f, n) => `<button type="button" data-foto="${n}" aria-label="Foto ${n + 1}"><img src="${esc(f.url)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
    </div>`, (m) => {
    m.classList.add('modal-galeria');
    const mostrar = (n) => {
      i = (n + fotos.length) % fotos.length;
      const f = fotos[i];
      $('#galeria-img', m).src = f.url;
      $('#galeria-link', m).href = f.url;
      $('#galeria-legenda', m).innerHTML = `<span>${i + 1} de ${fotos.length} · ${esc(new Date(f.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</span>${f.descricao ? `<span class="galeria-desc">👁️ ${esc(f.descricao)}</span>` : ''}`;
      $$('[data-foto]', m).forEach((b) => b.classList.toggle('ativa', Number(b.dataset.foto) === i));
    };
    $$('[data-ir]', m).forEach((b) => { b.onclick = () => mostrar(i + Number(b.dataset.ir)); });
    $$('[data-foto]', m).forEach((b) => { b.onclick = () => mostrar(Number(b.dataset.foto)); });
    m.closest('.fundo-modal')?.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') mostrar(i + 1); if (e.key === 'ArrowLeft') mostrar(i - 1); });
    mostrar(0);
  });
}

// 🤖 Horários que a IA pode agendar: você libera os horários; a IA só marca nos livres
function desenharHorariosIa(id, h) {
  const card = $('#card-horarios-ia');
  if (!card) return;
  const sp = (iso, o) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...o });
  const dias = [];
  for (const v of h.vagas) {
    const k = sp(v.quando, { weekday: 'short', day: '2-digit', month: '2-digit' });
    if (!dias.length || dias[dias.length - 1].k !== k) dias.push({ k, vagas: [] });
    dias[dias.length - 1].vagas.push(v);
  }
  const livres = h.vagas.filter((v) => v.livre && !v.passou).length;
  const hojeIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  card.innerHTML = `
    <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">🤖 Horários que a IA pode agendar</h2>${interruptor('hia-ativo', h.ativo, h.ativo ? 'Ligado' : 'Desligado')}</div>
    <p class="rotulo" style="margin:0 0 10px">${h.ativo
      ? `<b>Ligado:</b> na conversa, a IA só marca o cliente num horário <b>livre</b> desta lista (${livres} livre${livres === 1 ? '' : 's'} agora) e nunca dois no mesmo horário. Sem horário livre, ela não agenda e continua atendendo normalmente. Agendamento feito à mão ocupa o horário sozinho.`
      : '<b>Desligado:</b> a IA não usa esta lista (agenda como antes, quando o cliente confirma um horário).'}</p>
    <div class="hia-form">
      <div class="campo"><label>Dia</label><input type="date" id="hia-dia" value="${hojeIso}" min="${hojeIso}"></div>
      <div class="campo"><label>Horários (um ou vários: 09:00, 10:30, 14:00)</label><input type="text" id="hia-horas" placeholder="09:00, 14:00" inputmode="numeric"></div>
      <button type="button" class="primario" id="hia-add">Adicionar</button>
    </div>
    <div class="hia-form">
      <div class="campo" style="flex:2"><label>Só agendar clientes destas localidades (vazio = todos)</label><input type="text" id="hia-locais" value="${esc(h.localidades)}" placeholder="Ex.: Petrópolis, Teresópolis, Itaipava"></div>
      <div class="campo"><label>Cada atendimento ocupa</label><select id="hia-dur">${[30, 45, 60, 90, 120, 180, 240].map((m) => `<option value="${m}" ${m === h.duracao ? 'selected' : ''}>${m < 60 ? `${m} min` : `${m / 60} h`.replace('.5', ',5')}</option>`).join('')}</select></div>
      <button type="button" id="hia-salvar">Salvar</button>
    </div>
    ${dias.length ? dias.map((d) => `<div class="hia-dia"><b>${esc(d.k)}</b><div class="chips">${d.vagas.map((v) => `<span class="hia-vaga ${v.passou ? 'passou' : v.livre ? 'livre' : 'ocupado'}" title="${v.livre ? 'Livre para a IA marcar' : `Ocupado${v.ocupadoPor?.nome ? ` · ${esc(v.ocupadoPor.nome)}` : ''}`}">${sp(v.quando, { hour: '2-digit', minute: '2-digit' })} · ${v.passou ? 'passou' : v.livre ? 'livre' : `ocupado${v.ocupadoPor?.nome ? ` (${esc(v.ocupadoPor.nome.split(' ')[0])})` : ''}`}<button type="button" class="link-botao" data-hia-tirar="${esc(v.id)}" aria-label="Tirar horário" title="Tirar da lista">✕</button></span>`).join('')}</div></div>`).join('') : '<p class="rotulo" style="margin:8px 0 0">Nenhum horário cadastrado ainda.</p>'}`;
  const recarregar = (novo) => desenharHorariosIa(id, novo);
  $('#hia-ativo').onchange = async (e) => {
    try { recarregar(await api(`empresas/${id}/horarios-ia`, { method: 'PUT', body: { ativo: e.target.checked } })); aviso(e.target.checked ? 'A IA só agenda nos horários livres da lista.' : 'Lista de horários desligada.'); } catch (err) { e.target.checked = !e.target.checked; aviso(err.message, true); }
  };
  $('#hia-salvar').onclick = async (e) => {
    try { recarregar(await comEspera(e.currentTarget, () => api(`empresas/${id}/horarios-ia`, { method: 'PUT', body: { localidades: $('#hia-locais').value, duracao: Number($('#hia-dur').value) } }))); aviso('Salvo.'); } catch (err) { aviso(err.message, true); }
  };
  $('#hia-add').onclick = async (e) => {
    const dia = $('#hia-dia').value;
    const horas = $('#hia-horas').value.split(/[,;\s]+/).map((x) => x.trim().replace(/h$/i, ':00').replace(/^(\d{1,2})h(\d{2})$/i, '$1:$2')).filter(Boolean).map((x) => (/^\d{1,2}$/.test(x) ? `${x}:00` : x));
    if (!dia || !horas.length || horas.some((x) => !/^\d{1,2}:\d{2}$/.test(x))) return aviso('Escolha o dia e escreva os horários assim: 09:00, 14:30', true);
    try {
      const r = await comEspera(e.currentTarget, () => api(`empresas/${id}/horarios-ia/vagas`, { method: 'POST', body: { quandos: horas.map((x) => `${dia}T${x.padStart(5, '0')}`) } }));
      recarregar(r);
      aviso(`${r.adicionados} horário(s) adicionado(s).${r.ignorados ? ` ${r.ignorados} já estava(m) na lista ou já passou.` : ''}`);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-hia-tirar]', card).forEach((b) => {
    b.onclick = async () => {
      try { recarregar(await api(`empresas/${id}/horarios-ia/vagas/${b.dataset.hiaTirar}`, { method: 'DELETE' })); } catch (err) { aviso(err.message, true); }
    };
  });
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
  return `<span class="mini-midia ${extra}" title="${esc(o.nome)} · ${esc(o.numero ? `#MIDIA_${o.numero}` : codMidia(o.codigo))}">${o.capa ? `<img src="${esc(o.capa)}" alt="" loading="lazy">` : `<span>${icone}</span>`}${o.tipo === 'video' ? '<i>▶</i>' : o.tipo === 'album' ? `<i>${o.quantidade || ''}</i>` : ''}</span>`;
}

// "1.234,50" → 1234.5 (vazio → null)
function lerValorBr(s) {
  let v = String(s ?? '').replace(/[^\d.,]/g, '');
  if (!v) return null;
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// "Custo R$ 45,00 · Margem R$ 105,00 (70%)"
function textoMargem(x) {
  const preco = x.preco ?? x.precoAte;
  const valor = Math.round((preco - x.custo) * 100) / 100;
  const pct = preco > 0 ? Math.round((valor / preco) * 100) : 0;
  return `<span class="rotulo">Custo ${esc(brl(x.custo))} · Margem </span><b class="${valor >= 0 ? 'margem-ok' : 'margem-ruim'}">${esc(brl(valor))} (${pct}%)</b>`;
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
              ${x.custo != null ? `<div class="cat-margem">${textoMargem(x)}</div>` : ''}
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
  const x = item || { tipo: 'servico', nome: '', categoria: '', preco: null, precoAte: null, precoObs: '', custo: null, duracao: '', descricao: '', midias: [], ativo: true };
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
        <div class="campo"><label>Custo para você (R$) ${ajuda('Quanto você gasta para entregar 1 unidade (material, capa, linha…). Só aparece aqui no painel: a IA e o cliente nunca veem. Entra no lucro do Faturamento.')}</label><input name="custo" inputmode="decimal" value="${esc(num(x.custo))}" placeholder="Ex.: 45,00"><span class="rotulo" id="cat-margem-viva"></span></div>
        <div class="campo"><label>${x.tipo === 'produto' ? 'Prazo de entrega' : 'Duração / prazo'}</label><input name="duracao" maxlength="80" value="${esc(x.duracao)}" placeholder="Ex.: 2 horas · fica pronto no mesmo dia"></div>
        <div class="campo"><label>Categoria <span class="rotulo">— opcional</span></label><input name="categoria" maxlength="60" value="${esc(x.categoria)}" list="cat-categorias" placeholder="Ex.: Serviços, Produtos, Pacotes"><datalist id="cat-categorias">${categorias.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="campo largo"><label>Detalhes para a IA usar ${ajuda('O que está incluso, materiais, cores, garantia, condições. Só o que for verdade: a IA usa isto para responder.')}</label><textarea name="descricao" maxlength="1500" style="min-height:90px" placeholder="Ex.: Couro legítimo, costura à mão, cores preto e caramelo, garantia de 1 ano.">${esc(x.descricao)}</textarea></div>
      </div>
      <div class="campo">
        <label>Mídias deste item <span class="rotulo" id="cat-qtd"></span> ${ajuda('Fotos, vídeos ou álbuns que mostram este serviço/produto. A IA manda quando o cliente falar dele.')}</label>
        ${opcoes.length ? `<input id="cat-busca-midia" placeholder="🔎 Filtrar mídias" style="margin-bottom:8px">
        <div class="seletor-midias">${opcoes.map((o) => `<button type="button" class="opcao-midia ${escolhidas.has(o.codigo) ? 'marcada' : ''}" data-codigo="${esc(o.codigo)}" data-busca="${esc(`${o.nome} ${o.codigo}`.toLowerCase())}">${miniaturaMidia(o)}<span class="opcao-nome">${esc(o.nome)}</span><span class="opcao-check">✓</span></button>`).join('')}</div>`
        : `<p class="rotulo">Nenhuma mídia na biblioteca ainda. <a href="${rotaEmpresa(id, 'midias')}">Subir fotos e vídeos</a></p>`}
      </div>
      <label class="linha-check" style="margin-top:10px"><input type="checkbox" name="ativo" ${x.ativo ? 'checked' : ''}> A IA oferece este item</label>
      <div class="acoes"><button type="submit" class="primario">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    const qtd = () => { const q = $('#cat-qtd', m); if (q) q.textContent = escolhidas.size ? `· ${escolhidas.size} escolhida(s)` : ''; };
    qtd();
    // margem na hora, enquanto digita o preço e o custo
    const f = $('#f-cat', m);
    const margemViva = () => {
      const el = $('#cat-margem-viva', m);
      const v = { preco: lerValorBr(f.elements.preco.value), precoAte: lerValorBr(f.elements.precoAte.value), custo: lerValorBr(f.elements.custo.value) };
      el.innerHTML = v.custo != null && (v.preco ?? v.precoAte) != null ? textoMargem(v) : '';
    };
    ['preco', 'precoAte', 'custo'].forEach((n) => f.elements[n].addEventListener('input', margemViva));
    margemViva();
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

// Lista as mídias e álbuns com foto; ao clicar, o código entra no prompt onde está o cursor.
// Mídia "a configurar" NÃO sai, mesmo citada no prompt (só as ativas).
async function escolherMidiaParaPrompt(id, area) {
  let todas, albuns;
  try { [todas, albuns] = await Promise.all([api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`).catch(() => [])]); } catch (err) { return aviso(err.message, true); }
  const itens = [
    ...albuns.map((a) => ({ codigo: a.codigo, numero: a.numero, nome: a.nome, tipo: 'album', capa: (todas.find((m) => m.albumId === a.id && m.tipo === 'image') || {}).url, status: 'álbum' })),
    ...todas.filter((m) => !m.pastaId && !m.albumId).map((m) => ({ codigo: m.codigo, numero: m.numero, nome: m.nome, tipo: m.tipo, capa: m.tipo === 'image' ? m.url : '', status: m.soFollowup ? 'só follow-up' : m.pronta === false ? 'a configurar' : 'pronta', quando: m.descricao || '' }))
  ];
  abrirModal(`
    <h2>📎 Inserir mídia no prompt</h2>
    <p class="rotulo">Clique na mídia: o código entra no prompt onde está o cursor (ex.: <i>"quando perguntarem do completo, mande ${esc(itens[0] ? codNum(itens[0]) : '#MIDIA_1')}"</i>). Depois clique em Salvar.</p>
    <input type="search" id="busca-midia-prompt" placeholder="Buscar pelo nome ou código" style="margin:6px 0 10px">
    <div class="grade-escolha" id="lista-midia-prompt">
      ${itens.map((x) => `<button type="button" class="escolha" data-cod="${esc(codNum(x))}" data-busca="${esc(`${x.nome} ${codNum(x)} ${codMidia(x.codigo)}`.toLowerCase())}">${x.capa ? `<img src="${esc(x.capa)}" alt="">` : `<span class="escolha-icone">${x.tipo === 'album' ? '🗂️' : ICONE_TIPO[x.tipo] || '📎'}</span>`}<b>${esc(x.nome)}</b><span class="rotulo">${esc(codNum(x))}</span><span class="etiqueta ${x.status === 'pronta' ? 'ok' : x.status === 'a configurar' ? 'aviso' : ''}">${esc(x.status)}</span></button>`).join('') || '<p class="rotulo">Nenhuma mídia cadastrada.</p>'}
    </div>
    <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
    $('#busca-midia-prompt', m).oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('[data-busca]', m).forEach((b) => { b.hidden = q && !b.dataset.busca.includes(q); });
    };
    $$('[data-cod]', m).forEach((b) => {
      b.onclick = () => {
        const cod = b.dataset.cod;
        const ini = area.selectionStart ?? area.value.length;
        const fim = area.selectionEnd ?? ini;
        const antes = area.value.slice(0, ini);
        const espaco = antes && !/\s$/.test(antes) ? ' ' : '';
        area.value = `${antes}${espaco}${cod} ${area.value.slice(fim)}`;
        const pos = ini + espaco.length + cod.length + 1;
        area.focus();
        area.setSelectionRange(pos, pos);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        fechar();
        aviso(`${cod} colocado no prompt. Clique em Salvar para valer.`);
      };
    });
  });
}

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
        <div class="campo"><label>Chave global da Evolution API</label><input id="chave-global" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="cole a chave global"></div>
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
    <form class="card" id="f-ritmo" data-pronto="ok" data-resumo="${esc(resumoTempoIa(w))}">
      <div class="cfg-rapido"><label for="rapido-primeira">⏱️ Responder a 1ª mensagem de cliente novo:</label><select id="rapido-primeira">${TEMPOS_PRIMEIRA.map(([v, n]) => `<option value="${v}" ${Number(w.esperaPrimeiraSeg || 0) === v ? 'selected' : ''}>${v ? n : 'na hora'}</option>`).join('')}</select></div>
      <h2 style="margin:0 0 6px">⏱️ Tempo de resposta da IA</h2>
      <p class="rotulo" style="margin:0 0 12px">Tudo o que define quanto tempo a IA leva para responder fica aqui.</p>
      <h3 class="titulo-bloco">1. Velocidade das respostas</h3>
      <p class="rotulo" style="margin:0 0 8px">Quanto a IA espera e quanto tempo fica "digitando…" antes de cada resposta. Mais lento parece mais humano.</p>
      <div class="opcoes-ritmo">
        ${[['rapido', '⚡ Rápido', 'responde em ~3 s'], ['humanizado', '🙂 Humanizado', 'espera ~8 s e digita no ritmo de uma pessoa'], ['lento', '🐢 Mais lento', 'espera ~25 s, bem calmo'], ['humano', '🧑 Bem humano', 'espera 20–45 s, marca como lida, digita cada frase no ritmo dela e “procura” a foto antes de mandar']].map(([v, n, d]) => `<label class="opcao-ritmo"><input type="radio" name="velocidade" value="${v}" ${(w.velocidade || 'humanizado') === v ? 'checked' : ''}><span><b>${n}</b><small>${d}</small></span></label>`).join('')}
      </div>
      <h3 class="titulo-bloco">2. Primeira mensagem de um cliente novo</h3>
      <div class="campos">
        <div class="campo"><label>Responder a 1ª mensagem de quem chama pela primeira vez depois de ${ajuda('Só para quem chama pela primeira vez. Ex.: 2 minutos, para não parecer robô. As próximas mensagens seguem a velocidade acima.')}</label>
          <select name="esperaPrimeiraSeg">${TEMPOS_PRIMEIRA.map(([v, n]) => `<option value="${v}" ${Number(w.esperaPrimeiraSeg || 0) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <h3 class="titulo-bloco">3. Pausas entre as partes da resposta</h3>
      <p class="rotulo" style="margin:0 0 8px">Cada linha da resposta sai como uma mensagem separada e cada mídia sai no lugar em que a IA escreveu o código. Entre um envio e outro o cliente vê "digitando…" por estes segundos:</p>
      <div class="campos">
        <div class="campo"><label>Antes de uma mídia (s)</label><input type="number" min="0" max="120" name="esperaAntesMidiaSeg" value="${w.esperaAntesMidiaSeg ?? 3}"></div>
        <div class="campo"><label>Depois da mídia, antes do texto (s)</label><input type="number" min="0" max="120" name="esperaDepoisMidiaSeg" value="${w.esperaDepoisMidiaSeg ?? 10}"></div>
        <div class="campo"><label>Entre um texto e outro (s)</label><input type="number" min="0" max="120" name="esperaEntreTextosSeg" value="${w.esperaEntreTextosSeg ?? 5}"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar tempos</button></div>
    </form>
    <form class="card" id="f-avisos-erro" data-pronto="${w.whatsappAvisos ? 'ok' : 'off'}" data-resumo="${w.whatsappAvisos ? `Avisos para ${esc(telefoneBonito(w.whatsappAvisos))}` : 'Nenhum número cadastrado (opcional)'}">
      <h2 style="margin:0 0 6px">🔔 Avisos de erro no seu WhatsApp</h2>
      <p class="rotulo" style="margin:0 0 10px">Se algo der errado (IA sem crédito, WhatsApp desconectado, mídia que não saiu), o CRM manda um aviso para este número. No máximo 1 aviso do mesmo tipo a cada 30 minutos.</p>
      <div class="linha-form"><input name="whatsappAvisos" value="${esc(telefoneBonito(w.whatsappAvisos || ''))}" placeholder="Seu número pessoal com DDD (opcional)"><button type="submit">Salvar</button></div>
    </form>
    <form class="card" id="f-fotos-clientes" data-pronto="${w.fotosObservar || w.etiquetaFoto ? 'ok' : 'off'}" data-resumo="${esc([w.fotosObservar ? 'repara em: ' + w.fotosObservar : 'descrição padrão', w.etiquetaFoto ? 'etiqueta: ' + ((emp.etiquetas || []).find((t) => t.id === w.etiquetaFoto)?.nome || '') : ''].filter(Boolean).join(' · ').slice(0, 90))}">
      <h2 style="margin:0 0 6px">📷 Fotos dos clientes</h2>
      <p class="rotulo" style="margin:0 0 10px">Quando o cliente manda uma foto, uma IA barata descreve numa linha (o que é, estado, se é foto real, print ou da internet) e a IA do WhatsApp responde com base nisso. Várias fotos seguidas: só a 1ª é descrita; a mesma foto de novo não gasta IA; foto encaminhada ou print de tela são avisados sem IA.</p>
      <div class="campo"><label>Nas fotos, repare também em (opcional) ${ajuda('O que importa no seu ramo. Ex.: oficina — "estado do volante, material, se tem comandos"; estética — "região e tipo de pele"; reforma — "tamanho do ambiente e material".')}</label><input name="fotosObservar" maxlength="300" value="${esc(w.fotosObservar || '')}" placeholder="Ex.: estado de conservação, material, marca e modelo"></div>
      <div class="campo"><label>Etiqueta quando o cliente manda foto (opcional) ${ajuda('Marca o cliente no CRM na 1ª foto que ele mandar. Se a equipe tirar a etiqueta, ela não volta.')}</label><select name="etiquetaFoto"><option value="">— nenhuma —</option>${(emp.etiquetas || []).map((t) => `<option value="${esc(t.id)}" ${t.id === w.etiquetaFoto ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></div>
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
    <div class="card" data-cfg="ia-agendados" data-pronto="ok" data-resumo="${emp.iaComCompradores ? 'IA atende quem comprou' : 'Quem comprou: IA desligada'} · ${emp.iaComAgendados ? 'IA atende quem agendou' : 'quem agendou: IA desligada'}">
      <h2 style="margin:0 0 8px">🛍️ Quem já comprou e quem agendou</h2>
      <div class="cabecalho" style="margin-bottom:4px;padding-right:0"><b>IA para quem já comprou</b>${interruptor('ia-compradores', emp.iaComCompradores === true, emp.iaComCompradores ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0 0 12px">${emp.iaComCompradores
        ? '<b>Ligado:</b> a IA continua atendendo quem já comprou (bom para quem vende de novo sempre: loja, restaurante, salão…), com follow-up e automações.'
        : '<b>Desligado (padrão):</b> quem já comprou fica com a IA desligada — sem respostas, follow-up e automações (só avaliação e comentário no anúncio). Liga de novo em cada conversa se quiser.'}</p>
      <div class="cabecalho" style="margin-bottom:4px;padding-right:0"><b>IA para quem agendou</b>${interruptor('ia-agendados', emp.iaComAgendados === true, emp.iaComAgendados ? 'Ligado' : 'Desligado')}</div>
      <p class="rotulo" style="margin:0">${emp.iaComAgendados
        ? '<b>Ligado:</b> quem agendou continua sendo atendido pela IA e recebe as sequências feitas para quem agendou.'
        : '<b>Desligado (padrão):</b> quem agendou fica com a IA desligada e sem follow-up, até você ligar na conversa.'}</p>
    </div>
    <div class="card" id="card-horario-ia"><p class="rotulo">Carregando horário da IA…</p></div>
    <div class="card" id="card-eventos-ia"><p class="rotulo">Carregando avisos internos…</p></div>
    <div class="card" id="card-log-ia-caixa" data-pronto="ok" data-abrir="Ver" data-titulo="Log das respostas da IA" data-resumo="o que a IA escreveu, as mídias e os erros de cada resposta"><div id="card-log-ia"><p class="rotulo">Carregando log das respostas…</p></div></div>
    ${w.configurado ? '<div class="card" id="card-aviso-agenda"><p class="rotulo">Carregando aviso de agendamento…</p></div><div class="card" id="card-lista-negra"><p class="rotulo">Carregando lista negra…</p></div>' : ''}
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
            <li>📎 envia as <a href="${rotaEmpresa(id, 'midias')}">fotos, álbuns e links</a> quando o cliente pede</li>
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
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { velocidade: f.elements.velocidade.value, esperaPrimeiraSeg: Number(f.elements.esperaPrimeiraSeg.value), esperaAntesMidiaSeg: Number(f.elements.esperaAntesMidiaSeg.value), esperaDepoisMidiaSeg: Number(f.elements.esperaDepoisMidiaSeg.value), esperaEntreTextosSeg: Number(f.elements.esperaEntreTextosSeg.value) } }));
      aviso('Tempos de resposta salvos.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  };
  $('#rapido-primeira').onchange = async (e) => {
    const sel = e.target;
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { esperaPrimeiraSeg: Number(sel.value) } });
      $('#f-ritmo select[name=esperaPrimeiraSeg]').value = sel.value;
      const card = $('#f-ritmo');
      card.dataset.resumo = resumoTempoIa({ ...w, esperaPrimeiraSeg: Number(sel.value), velocidade: card.elements.velocidade.value });
      marcarPronto(card, 'ok', card.dataset.resumo);
      aviso(`1ª mensagem de cliente novo: ${sel.options[sel.selectedIndex].text}.`);
    } catch (err) { aviso(err.message, true); }
  };
  $('#f-fotos-clientes').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { fotosObservar: f.elements.fotosObservar.value, etiquetaFoto: f.elements.etiquetaFoto.value } }));
      aviso('Fotos dos clientes: salvo.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  };
  $('#f-avisos-erro').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { whatsappAvisos: f.elements.whatsappAvisos.value } }));
      aviso('Número dos avisos salvo.');
      recarregar();
    } catch (err) { aviso(err.message, true); }
  };
  $('#zap-sincronizar')?.addEventListener('click', () => modalSincronizar(id, recarregar));
  if (w.configurado) { cartaoAvisoAgendamento(id); cartaoListaNegra(id); }
  $('#ia-para-manual').onchange = (e) => trocarIaParaManual(id, e.target, recarregar);
  cartaoHorarioIa(id);
  cartaoEventosIa(id);
  cartaoLogIa(id);
  // 📎 Inserir mídia no prompt: escolhe na lista e o código certo entra onde está o cursor
  const areaPrompt = $('textarea[name=promptWhatsapp]');
  if (areaPrompt && !$('#inserir-midia-prompt')) {
    const bt = document.createElement('button');
    bt.type = 'button';
    bt.className = 'pequeno inserir-midia';
    bt.id = 'inserir-midia-prompt';
    bt.textContent = '📎 Inserir mídia no prompt';
    areaPrompt.before(bt);
    bt.onclick = () => escolherMidiaParaPrompt(id, areaPrompt);
  }
  // o prompt cita mídia sem conexão certa? avisa aqui também
  api(`empresas/${id}/midias/prompt`).then((r) => {
    const citados = r.citados || [];
    const area = $('textarea[name=promptWhatsapp]');
    if (!citados.length || !area || location.hash !== aqui) return;
    const faltam = citados.filter((c) => !c.existe);
    const d = document.createElement('div');
    d.className = faltam.length ? 'det-aviso' : 'rotulo';
    d.id = 'aviso-midias-prompt';
    d.innerHTML = `Mídias citadas neste prompt: <b>${citados.length}</b> — ${citados.map((c) => `<span class="codigo-chip">${esc(c.codigo)}</span> ${c.existe ? '✓' : '✕ não existe no cadastro'}`).join(' · ')}${faltam.length ? ` <a href="${rotaEmpresa(id, 'midias')}">Ver em Mídias →</a>` : ''}`;
    area.closest('.campo').after(d);
  }).catch(() => {});
  $('#ia-compradores').onchange = async (e) => {
    const ligar = e.target.checked;
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { iaComCompradores: ligar } });
      aviso(ligar ? 'A IA volta a atender quem já comprou.' : 'Quem já comprou fica com a IA desligada.');
      recarregar();
    } catch (err) {
      e.target.checked = !ligar;
      aviso(err.message, true);
    }
  };
  $('#ia-agendados').onchange = async (e) => {
    const ligar = e.target.checked;
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: { iaComAgendados: ligar } });
      aviso(ligar ? 'A IA volta a atender quem agendou.' : 'Quem agendou fica com a IA desligada.');
      recarregar();
    } catch (err) {
      e.target.checked = !ligar;
      aviso(err.message, true);
    }
  };
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
      <div class="campo" style="margin-top:12px"><label>API Key</label><input name="apiKey" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="vazio = manter a atual (${esc(w.apiKeyFinal)})"></div>
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

// ---------------------------------------------------------------- lead externo (webhook)
// Deixa outro sistema seu (ex.: o cadastro de teste grátis de outro produto)
// criar um lead aqui direto, por um link com senha — sem precisar de código
// novo a cada empresa. Qualquer empresa pode ligar isso na própria tela.
async function paginaLeadExterno(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const cfg = emp.leadExterno || {};
  const ligado = !!cfg.habilitado;
  const urlWebhook = cfg.segredo ? `${sessao.urlPublica}/api/public/lead-externo/${emp.id}/${cfg.segredo}` : '';
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Lead externo</h1><p class="sub">Outro sistema seu cria um lead aqui direto, por um link com senha</p></div>${interruptor('lead-ext-ligar', ligado, ligado ? 'Ligado' : 'Desligado')}</div>
    ${balao('Para que serve', 'Se você tem outro site, app ou cadastro (ex.: um teste grátis de outro produto seu), ele pode chamar o link abaixo com nome, telefone e e-mail da pessoa — o CRM cria o lead na hora, já na etapa que você escolher, e manda a mensagem de boas-vindas pelo WhatsApp se você configurar uma. O resto (o que acontece depois, tipo lembrar de vender no dia 15) você configura normalmente em Automações.')}
    ${ligado ? '' : balao('Desligado', 'Enquanto estiver desligado, o link não funciona (responde como se não existisse). Ligue no botão acima quando quiser usar.', 'aviso')}
    ${ligado && urlWebhook ? `
    <div class="card" data-cfg="lead-externo-link" data-pronto="ok" data-resumo="Link pronto pra usar">
      <h2>Link do webhook</h2>
      ${passos([
        'Copie o link abaixo.',
        'No seu outro sistema, configure pra mandar um <code>POST</code> pra esse link quando alguém se cadastrar, com um JSON <code>{"nome": "...", "telefone": "...", "email": "..."}</code> (telefone com DDD é obrigatório).',
        'Pronto — cada cadastro de lá vira um lead aqui, na hora.'
      ])}
      <div class="codigo">${esc(urlWebhook)}</div>
      <div class="acoes">
        <button type="button" class="primario" id="lead-ext-copiar">Copiar link</button>
        <button type="button" class="perigo" id="lead-ext-novo-segredo">Gerar novo link (invalida o antigo)</button>
      </div>
    </div>` : ''}
    <form class="card" id="f-lead-externo" data-pronto="${cfg.etapaDestino ? 'ok' : ''}" data-resumo="${cfg.etapaDestino ? `Entra em "${esc(cfg.etapaDestino)}"` : 'Escolha a etapa de entrada'}">
      <h2>Como o lead entra</h2>
      <div class="campos">
        <div class="campo"><label>Etapa de entrada ${ajuda('Em que etapa do funil o lead já chega. Ex.: uma etapa só pra "Teste grátis iniciado", separada das demais.')}</label>
          <select name="etapaDestino"><option value="">— primeira etapa do funil —</option>${(emp.etapas || []).map((e) => `<option value="${esc(e)}" ${e === cfg.etapaDestino ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>
      </div>
      <div class="campo largo"><label>Mensagem de boas-vindas pelo WhatsApp (opcional) ${ajuda('Manda na hora, assim que o lead chega — não espera a automação (que só roda a partir de 1h). Deixe vazio pra não mandar nada.')}</label>
        <textarea name="mensagemBoasVindas" placeholder="Ex.: Oi! Seu teste grátis de 15 dias já começou 🎉 Qualquer dúvida é só chamar aqui.">${esc(cfg.mensagemBoasVindas)}</textarea></div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
    </form>`;
  $('#lead-ext-ligar').onchange = async (e) => {
    try {
      await api(`empresas/${id}/lead-externo`, { method: 'PUT', body: { habilitado: e.target.checked } });
      aviso(e.target.checked ? 'Lead externo ligado.' : 'Lead externo desligado.');
      paginaLeadExterno(id).then(() => montarMenu(rotaEmpresa(id, 'lead-externo')));
    } catch (err) { aviso(err.message, true); }
  };
  $('#lead-ext-copiar')?.addEventListener('click', () => copiar(urlWebhook));
  $('#lead-ext-novo-segredo')?.addEventListener('click', async () => {
    if (!confirm('O link atual para de funcionar. Confirma?')) return;
    try {
      await api(`empresas/${id}/lead-externo`, { method: 'PUT', body: { gerarNovoSegredo: true } });
      aviso('Novo link gerado.');
      paginaLeadExterno(id);
    } catch (err) { aviso(err.message, true); }
  });
  $('#f-lead-externo').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`empresas/${id}/lead-externo`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('Salvo.');
      paginaLeadExterno(id).then(() => montarMenu(rotaEmpresa(id, 'lead-externo')));
    } catch (err) { aviso(err.message, true); }
  };
}

// ---------------------------------------------------------------- empresa: mídias

const ICONE_TIPO = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄' };

// ---------------------------------------------------------------- 🎤 Áudios
// Gravador do painel: grava pelo microfone, deixa ouvir antes de salvar e regravar à vontade.
// aoSalvar(blob, mimetype) só é chamado quando a pessoa aprova o que ouviu.
function montarGravador(el, { comCampos = false, textoSalvar = '💾 Salvar áudio', aoSalvar }) {
  const podeGravar = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const tipoGravacao = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  let gravacao = null; // { blob, tipo, url }
  let rec = null;
  let fluxo = null;
  let relogio = null;
  let trava = null; // tela acesa enquanto grava (celular)
  let medidor = null; // { ctx, raf }
  const aoEsconder = () => { if (document.hidden && rec?.state === 'recording') parar(); }; // bloqueou o celular: guarda o que gravou
  const parar = () => {
    clearInterval(relogio);
    if (rec && rec.state !== 'inactive') rec.stop();
    fluxo?.getTracks().forEach((t) => t.stop());
    fluxo = null;
    trava?.release?.().catch(() => {});
    trava = null;
    if (medidor) { cancelAnimationFrame(medidor.raf); medidor.ctx.close().catch(() => {}); medidor = null; }
    document.removeEventListener('visibilitychange', aoEsconder);
  };
  // barrinha que mexe com a voz: mostra que o microfone está pegando
  const ligarMedidor = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !fluxo) return;
      const ctx = new Ctx();
      ctx.resume?.().catch(() => {}); // celular: o toque já passou quando o microfone liberou
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(fluxo).connect(an);
      const dados = new Uint8Array(an.fftSize);
      medidor = { ctx, raf: 0 };
      const passo = () => {
        an.getByteTimeDomainData(dados);
        let pico = 0;
        for (const v of dados) pico = Math.max(pico, Math.abs(v - 128));
        const barra = $('.grav-nivel span', el);
        if (barra) barra.style.width = `${Math.min(100, Math.round((pico / 128) * 160))}%`;
        medidor.raf = requestAnimationFrame(passo);
      };
      passo();
    } catch { /* sem medidor: grava igual */ }
  };
  const campos = () => (comCampos ? `
    <div class="campos" style="margin-top:10px">
      <div class="campo"><label>Nome do áudio</label><input name="nome" maxlength="80" placeholder="Ex.: Explicação do revestimento completo"></div>
      <div class="campo"><label>Quando a IA manda ${ajuda('Ex.: "quando o cliente perguntar como é o serviço completo". Sem isso o áudio fica guardado, mas a IA ainda não usa.')}</label><input name="descricao" maxlength="300" placeholder="Ex.: quando perguntarem como funciona o completo"></div>
    </div>
    <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="ativa" checked> <b>Ativa</b> — a IA já pode mandar (precisa do "quando a IA manda")</label>` : '');
  const desenhar = (estado, seg = 0) => {
    if (estado === 'gravando') {
      el.innerHTML = `<div class="gravador gravando">
        <div class="grav-status"><span class="ponto-gravando"></span> <b>Gravando</b> <span class="grav-tempo" id="grav-tempo">0:00</span></div>
        <div class="grav-nivel" aria-hidden="true"><span></span></div>
        <div class="acoes grav-acoes"><button type="button" class="primario grav-grande" id="grav-parar">⏹️ Parar e ouvir</button><button type="button" id="grav-cancelar">Cancelar</button></div></div>`;
      $('#grav-parar', el).onclick = () => parar();
      $('#grav-cancelar', el).onclick = () => { gravacao = null; if (rec) rec.onstop = null; parar(); desenhar('inicio'); };
      return;
    }
    if (estado === 'ouvir') {
      el.innerHTML = `<div class="gravador"><p class="rotulo" style="margin:0 0 6px">🎧 Ouça antes de salvar:</p>
        <audio controls src="${gravacao.url}" style="width:100%"></audio>
        <form id="grav-form">${campos()}
          <div class="acoes grav-acoes"><button type="submit" class="primario grav-grande">${textoSalvar}</button><button type="button" id="grav-de-novo">🔄 Gravar de novo</button><button type="button" id="grav-descartar">Descartar</button></div>
        </form></div>`;
      $('#grav-de-novo', el).onclick = () => { URL.revokeObjectURL(gravacao.url); gravacao = null; comecar(); };
      $('#grav-descartar', el).onclick = () => { URL.revokeObjectURL(gravacao.url); gravacao = null; desenhar('inicio'); };
      $('#grav-form', el).onsubmit = async (e) => {
        e.preventDefault();
        const botao = e.submitter || $('#grav-form button[type=submit]', el);
        try {
          await comEspera(botao, () => aoSalvar(gravacao.blob, gravacao.tipo, e.target), 'Salvando…');
          URL.revokeObjectURL(gravacao.url);
          gravacao = null;
        } catch (err) { aviso(err.message, true); }
      };
      return;
    }
    el.innerHTML = `<div class="gravador">
      ${podeGravar ? '<button type="button" class="primario grav-grande" id="grav-comecar">🎙️ Toque para gravar</button>' : '<p class="rotulo aviso-texto">Este navegador não deixa gravar. Use o Chrome (computador ou Android) ou o Safari atualizado — ou envie um arquivo de áudio.</p>'}
      <label class="botao-arquivo">📁 Enviar arquivo de áudio<input type="file" accept="audio/*" id="grav-arquivo" hidden></label>
      <p class="rotulo" style="margin:8px 0 0">Grave, ouça e só depois salve. Pode regravar quantas vezes quiser.</p></div>`;
    if (podeGravar) $('#grav-comecar', el).onclick = comecar;
    $('#grav-arquivo', el).onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (!/^audio\//.test(f.type) && !/\.(mp3|ogg|opus|m4a|aac|wav|weba|webm)$/i.test(f.name)) return aviso('Escolha um arquivo de áudio (mp3, ogg, m4a, wav…).', true);
      gravacao = { blob: f, tipo: f.type || 'audio/mpeg', url: URL.createObjectURL(f) };
      desenhar('ouvir');
      const nome = $('input[name=nome]', el);
      if (nome && !nome.value) nome.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 80);
    };
  };
  async function comecar() {
    try {
      fluxo = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      aviso('Não consegui usar o microfone. Libere o microfone para este site (cadeado ao lado do endereço) e tente de novo.', true);
      return desenhar('inicio');
    }
    const tipo = tipoGravacao();
    const pedacos = [];
    rec = new MediaRecorder(fluxo, tipo ? { mimeType: tipo } : undefined);
    rec.ondataavailable = (e) => { if (e.data?.size) pedacos.push(e.data); };
    rec.onstop = () => {
      const t = rec.mimeType || tipo || 'audio/webm';
      const blob = new Blob(pedacos, { type: t });
      if (!blob.size) { aviso('A gravação ficou vazia. Tente de novo.', true); return desenhar('inicio'); }
      gravacao = { blob, tipo: t, url: URL.createObjectURL(blob) };
      desenhar('ouvir');
    };
    rec.start(1000);
    const inicio = Date.now();
    desenhar('gravando');
    ligarMedidor();
    navigator.vibrate?.(30);
    navigator.wakeLock?.request?.('screen').then((t) => { trava = t; }).catch(() => {});
    document.addEventListener('visibilitychange', aoEsconder);
    relogio = setInterval(() => {
      const s = Math.floor((Date.now() - inicio) / 1000);
      const t = $('#grav-tempo', el);
      if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 300) parar(); // 5 minutos no máximo
      if (!el.isConnected) { if (rec) rec.onstop = null; parar(); } // saiu da página gravando
    }, 500);
  }
  desenhar('inicio');
}

// manda a gravação para o servidor (vira áudio de voz do WhatsApp). midiaId: regrava aquela mídia
async function enviarGravacao(empresaId, blob, tipo, { nome = '', descricao = '', ativa = true, midiaId = '' } = {}) {
  const qs = new URLSearchParams({ tipo: tipo || blob.type || '', ...(nome ? { nome } : {}), ...(descricao ? { descricao } : {}), ...(ativa ? {} : { ativa: 'nao' }), ...(midiaId ? { midiaId } : {}) });
  const r = await fetch(`api/empresas/${empresaId}/midias/gravacao?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.erro || 'Não consegui salvar o áudio.');
  return corpo;
}

// Endereço antigo (#/…/audios): os áudios ficam dentro de Mídias, na aba 🎤 Áudios
function paginaAudios(id) {
  try { sessionStorage.setItem(`midias_aba_${id}`, 'audios'); } catch { /* ok */ }
  location.replace(rotaEmpresa(id, 'midias'));
}

// Aba 🎤 Áudios de Mídias: gravar, ouvir antes de salvar, regravar e dizer quando a IA manda.
// alvo: onde desenhar; recarregar: redesenha a página de Mídias depois de salvar
function montarAudios(id, alvo, todas, recarregar) {
  const audios = todas.filter((m) => m.tipo === 'audio' && !m.pastaId).sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
  const desligada = (m) => m.pausada === true || (m.pronta === false && Boolean((m.descricao || '').trim()));
  const situacao = (m) => (m.soFollowup ? ['fup', '🔁 Só no follow-up'] : desligada(m) ? ['off', '⛔ Desligado — não sai'] : m.pronta === false ? ['off', '⚪ A IA ainda não usa — falta o "quando a IA manda"'] : ['ok', '✅ Ativo — a IA manda']);
  const tempo = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');
  const cartao = (m) => {
    const [cls, txt] = situacao(m);
    return `<div class="card midia audio-card" data-audio="${esc(m.id)}">
      <div class="audio-topo"><button type="button" class="codigo-num" data-copiar="${esc(codNum(m))}" title="Copiar o código para colar no prompt">${esc(codNum(m))} <span>⧉ copiar</span></button>${m.duracao ? `<span class="rotulo">⏱️ ${tempo(m.duracao)}</span>` : ''}</div>
      <strong>${esc(m.nome)}</strong>
      <span class="midia-uso ${cls}">${txt}</span>
      <audio class="midia-audio" controls preload="none" src="${esc(m.url)}"></audio>
      <label class="linha-check"><input type="checkbox" data-au-ativo="${esc(m.id)}" ${m.pronta !== false && !desligada(m) ? 'checked' : ''}> <b>Ativo</b> (desmarcado = não sai de jeito nenhum)</label>
      <form class="midia-desc" data-au-quando="${esc(m.id)}"><input name="descricao" maxlength="300" value="${esc(m.descricao || '')}" placeholder="Quando a IA manda (ex.: quando perguntarem do completo)"><button type="submit" class="pequeno">Salvar</button></form>
      <form class="midia-fala" data-au-fala="${esc(m.id)}">
        <label class="rotulo">🗣️ O que o áudio fala ${m.falaAuto ? '<span class="etiqueta">transcrito pela IA — confira</span>' : ''}</label>
        <textarea name="fala" rows="2" maxlength="2000" placeholder="A IA usa isso para saber o conteúdo e não repetir por escrito">${esc(m.fala || '')}</textarea>
        <span class="acoes-fala"><button type="submit" class="pequeno">Salvar</button><button type="button" class="pequeno" data-au-transcrever="${esc(m.id)}">✨ Transcrever</button></span>
      </form>
      <div class="acoes" style="margin-top:8px"><button type="button" class="pequeno" data-au-regravar="${esc(m.id)}">🎙️ Regravar</button><button type="button" class="pequeno perigo" data-au-apagar="${esc(m.id)}">Apagar</button></div>
    </div>`;
  };
  alvo.innerHTML = `<div class="pagina-audios">
    <p class="rotulo" style="margin:4px 0 10px">🎤 Grave aqui mesmo, ouça antes de salvar e diga quando a IA manda. O cliente recebe como <b>áudio de voz gravado na hora</b> (vê "gravando áudio…"), nunca como encaminhado.</p>
    <div class="card"><h3 style="margin-top:0">🎙️ Novo áudio</h3><div id="gravador-novo"></div></div>
    <h3>Seus áudios <span class="rotulo">(${audios.length})</span></h3>
    <p class="rotulo" style="margin-top:-6px">Para a IA mandar num momento certo do roteiro, cite o código no prompt (ex.: "depois de saber o carro, mande o áudio ${esc(audios[0] ? codNum(audios[0]) : '#MIDIA_12')}"). Teste A/B, etapas e revezamento: abra o áudio nas outras abas de Mídias → Editar.</p>
    ${audios.length ? `<div class="grade-midias">${audios.map(cartao).join('')}</div>` : '<div class="card vazio">Nenhum áudio ainda. Grave o primeiro aqui em cima 👆</div>'}</div>`;

  montarGravador($('#gravador-novo', alvo), {
    comCampos: true,
    aoSalvar: async (blob, tipo, f) => {
      const ativa = f.elements.ativa.checked;
      const descricao = f.elements.descricao.value.trim();
      const nova = await enviarGravacao(id, blob, tipo, { nome: f.elements.nome.value.trim(), descricao, ativa });
      aviso(`Áudio ${nova.codigoVisivel} salvo.${ativa && !descricao ? ' Falta o "quando a IA manda" para a IA usar.' : ''}`);
      recarregar();
    }
  });
  const achar = (mid) => audios.find((x) => x.id === mid);
  const atualizar = (m, corpo) => api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: corpo });
  $$('[data-copiar]', alvo).forEach((b) => { b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copiar).then(() => aviso(`Código ${b.dataset.copiar} copiado.`)).catch(() => aviso(b.dataset.copiar)); }; });
  $$('[data-au-ativo]', alvo).forEach((c) => {
    c.onchange = async () => {
      const m = achar(c.dataset.auAtivo);
      if (c.checked && !(m.descricao || '').trim() && !(await confirmar({ titulo: 'Sem "quando a IA manda"?', texto: 'Sem essa regra a IA decide sozinha quando mandar (ou só manda quando o prompt citar o código). Ativar assim mesmo?', botao: 'Ativar' }))) { c.checked = false; return; }
      try {
        await atualizar(m, { pronta: c.checked });
        aviso(c.checked ? 'Áudio ativo.' : 'Áudio desligado: não sai de jeito nenhum (nem pelo prompt, follow-up ou automações).');
        recarregar();
      } catch (err) { c.checked = !c.checked; aviso(err.message, true); }
    };
  });
  $$('[data-au-quando]', alvo).forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await comEspera(f.querySelector('button'), () => atualizar(achar(f.dataset.auQuando), { descricao: f.elements.descricao.value.trim() }));
        aviso('Salvo.');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-au-fala]', alvo).forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await comEspera(f.querySelector('button[type=submit]'), () => atualizar(achar(f.dataset.auFala), { fala: f.elements.fala.value.trim() }));
        aviso('Salvo: a IA já sabe o que este áudio fala.');
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-au-transcrever]', alvo).forEach((b) => {
    b.onclick = async () => {
      try {
        await comEspera(b, () => api(`empresas/${id}/midias/${b.dataset.auTranscrever}/transcrever`, { method: 'POST', body: {} }), 'Ouvindo…');
        aviso('Pronto: a IA escreveu o que o áudio fala. Confira e corrija se precisar.');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-au-apagar]', alvo).forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar({ titulo: 'Apagar este áudio?', texto: 'A IA não vai mais conseguir enviá-lo.', botao: 'Apagar', perigo: true }))) return;
      try {
        await api(`empresas/${id}/midias/${b.dataset.auApagar}`, { method: 'DELETE' });
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
  });
  // 🎙️ Regravar: grava de novo no lugar (mesmo código, mesma configuração); o antigo é apagado
  $$('[data-au-regravar]', alvo).forEach((b) => {
    b.onclick = () => {
      const m = achar(b.dataset.auRegravar);
      abrirModal(`<h2>🎙️ Regravar ${esc(codNum(m))}</h2><p class="rotulo">"${esc(m.nome)}" — o áudio novo fica no lugar deste, com o mesmo código e a mesma configuração. O antigo é apagado e não vai mais.</p><div id="gravador-troca"></div><div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (modal, fechar) => {
        montarGravador($('#gravador-troca', modal), {
          textoSalvar: '💾 Usar este no lugar',
          aoSalvar: async (blob, tipo) => {
            await enviarGravacao(id, blob, tipo, { midiaId: m.id, nome: m.nome });
            fechar();
            aviso(`${codNum(m)} regravado. Daqui em diante vai só o novo.`);
            recarregar();
          }
        });
      });
    };
  });
}

async function paginaMidias(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const [todas, albuns, { assuntos: ASSUNTOS }, noPrompt, logsErro, botPrincipal] = await Promise.all([api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`), api(`empresas/${id}/assuntos-midia`), api(`empresas/${id}/midias/prompt`).catch(() => null), api(`empresas/${id}/logs-ia?soErros=1&limite=20`).catch(() => []), principalDa(id).catch(() => null)]);
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
      ${noPrompt ? `<div class="rotulo midias-no-prompt"><b>Mídias citadas no prompt do WhatsApp: ${noPrompt.citados.length}</b>${noPrompt.citados.length ? `<ul>${noPrompt.citados.map((c) => `<li><span class="codigo-chip">${esc(c.codigo)}</span> ${c.existe ? `✓ cadastrada${c.nome ? ` (${esc(c.nome)})` : ''}` : '<span class="erro-envio">✕ não existe no cadastro</span>'}</li>`).join('')}</ul>` : ' — nenhum código #MIDIA_ no prompt.'}</div>` : ''}
      ${(noPrompt?.pendencias || []).length ? `<div class="det-aviso pend-resumo">💡 ${noPrompt.pendencias.length} trecho(s) do prompt para revisar (frases que falam de foto/vídeo sem código, ou código a conectar). <button type="button" class="pequeno" id="resolver-prompt">Revisar</button></div>` : ''}
      ${errosRecentes.length ? `<div class="det-erro forte">✕ ${errosRecentes.length} resposta(s) com problema de mídia nos últimos 3 dias:<ul>${errosRecentes.slice(0, 5).map((l) => `<li><span class="rotulo">${esc(data(l.em))}${l.cliente ? ` · ${esc(l.cliente)}` : ''}</span> — ${esc(l.erros.join(' · '))}</li>`).join('')}</ul><a href="${rotaEmpresa(id, 'whatsapp')}">Ver o log completo →</a></div>` : ''}
    </div>

    <div class="card" id="biblioteca">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🖼️ Suas fotos, vídeos e arquivos</h2><span class="barra"><label class="botao primario">📤 Adicionar (vários de uma vez)<input type="file" id="mais-midias" multiple hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label></span></div>
      <label class="soltar" id="soltar"><span class="soltar-texto">📁 Arraste vários arquivos aqui — fotos, vídeos (até 200 MB cada, qualidade original), PDFs e áudios</span></label>
      <div id="fila-envio"></div>
      <div class="assuntos-midia" id="assuntos-midia"></div>
      <div class="chips abas-midia" id="abas-midia"></div>
      <div class="chips filtro-assunto" id="filtro-assunto"></div>
      <div class="barra-selecao" id="barra-selecao" hidden></div>
      <div id="grade-biblioteca"></div>
    </div>

    ${pastas.length ? `<div class="card" data-cfg="drive" data-pronto="ok" data-resumo="${pastas.length} pasta(s) antiga(s) do Drive">
      <h2>📁 Pastas antigas do Google Drive</h2>
      <p class="rotulo" style="margin-top:-6px">Enviar pelo Google Drive não existe mais no CRM — use <b>📤 Adicionar</b> lá em cima. Estas pastas conectadas antes continuam com as fotos que já estão aqui; você pode editar ou remover.</p>
      <div class="lista-pastas">
        ${pastas.map((p) => {
          const fotos = todas.filter((m) => m.pastaId === p.id);
          return `
          <div class="pasta">
            <div class="pasta-fotos">${fotos.slice(0, 4).map((m) => (m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`)).join('') || '<span>📁</span>'}</div>
            <div class="pasta-info"><strong>${esc(p.nome)} ${p.codigo ? `<button type="button" class="codigo-chip" data-copiar="${esc(codNum(p))}" title="Copiar código">${esc(codNum(p))} ⧉</button>` : ''}</strong><span class="rotulo">${p.total || 0} arquivos · ${esc(p.descricao || 'sem instrução de quando mandar')}</span><span class="rotulo">Sincronizada ${data(p.ultimaSincronia)}${p.falhas?.length ? ` · ${p.falhas.length} arquivo(s) não baixaram` : ''}</span></div>
            <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-editar-pasta="${esc(p.id)}">Editar</button><button type="button" class="pequeno perigo" data-tirar-pasta="${esc(p.id)}">Remover</button></div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <div class="card" data-cfg="rapidas" data-pronto="${(emp.respostasRapidas || []).length ? 'ok' : 'off'}" data-resumo="${(emp.respostasRapidas || []).length ? `${emp.respostasRapidas.length} atalho(s)` : 'Nenhum atalho ainda'}">
      <div class="cabecalho" style="margin-bottom:6px;padding-right:0"><h2 style="margin:0">⚡ Respostas rápidas com mídia</h2><button type="button" class="primario pequeno" id="abrir-rapidas">Gerenciar</button></div>
      <p class="rotulo" style="margin:0 0 10px">Atalhos como <b>/preco</b> e <b>/catalogo</b> que mandam texto + foto, PDF ou álbum de uma vez — na aba Conversas${emp.atalhosNoCelular !== false ? ' e digitando no WhatsApp do celular' : ''}.</p>
      ${(emp.respostasRapidas || []).length ? `<div class="tabela-wrap"><table><thead><tr><th>Atalho</th><th>Manda</th><th class="esconde-mobile">Quando usar</th></tr></thead><tbody>${emp.respostasRapidas.map((r) => `<tr><td><b>/${esc(r.atalho)}</b></td><td>${esc((r.texto || '').slice(0, 70))}${(r.texto || '').length > 70 ? '…' : ''}${r.midia ? ` <span class="codigo-chip">${esc(codMidia(r.midia))}</span>` : ''}${r.auto ? ` <span class="etiqueta ok" title="Responde sozinha quando o cliente escrever: ${esc(r.gatilhos)}">🤖 sozinha</span>` : ''}</td><td class="esconde-mobile rotulo">${esc(r.quando || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<span class="rotulo">Nenhuma ainda.</span>'}
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
  // (enviar por link do Google Drive saiu do CRM)
  if ($('#midia-por-link')) $('#midia-por-link').onclick = () => {
    abrirModal(`
      <h2>🔗 Mídia por link do Google Drive</h2>
      <p class="rotulo" style="margin:0 0 10px">No Drive: botão direito no arquivo → <b>Compartilhar</b> → "Qualquer pessoa com o link" → <b>Copiar link</b>. O CRM converte para o link de download direto, baixa e guarda o arquivo.</p>
      <form id="f-midia-link">
        <div class="campo"><label>Link do arquivo *</label><input name="link" required placeholder="https://drive.google.com/file/d/…/view"></div>
        <div class="campos" style="margin-top:10px">
          <div class="campo"><label>Nome *</label><input name="nome" required placeholder="Ex.: Vídeo do serviço completo"></div>
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
  if ($('#f-drive')) $('#f-drive').onsubmit = async (e) => {
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
    configurar: { nome: '⚪ A IA ainda não usa', filtro: (m) => m.pronta === false && !m.soFollowup && !citada(m) },
    // todas as que a IA já pode mandar (fotos, vídeos, documentos e áudios), para revisar/editar
    prontas: { nome: '✅ A IA usa', filtro: (m) => (m.pronta !== false || citada(m)) && !m.soFollowup && !m.pastaId },
    fotos: { nome: '📷 Fotos', filtro: (m) => m.pronta !== false && !m.soFollowup && m.tipo === 'image' },
    videos: { nome: '🎬 Vídeos', filtro: (m) => m.pronta !== false && !m.soFollowup && m.tipo === 'video' },
    // todos os áudios (ativos, desligados e a configurar): a aba tem o gravador
    audios: { nome: '🎤 Áudios', filtro: (m) => m.tipo === 'audio' && !m.pastaId },
    docs: { nome: '📄 Documentos', filtro: (m) => m.pronta !== false && !m.soFollowup && !['image', 'video', 'audio'].includes(m.tipo) },
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
  const taxa = (g) => (g.clientes ? `${Math.round((g.compraram / g.clientes) * 100)}%` : '—');
  const placarAB = (ab) => {
    const a = ab.audio || {}, t = ab.texto || {};
    const lider = a.clientes >= 10 && t.clientes >= 10 ? (a.compraram / a.clientes > t.compraram / t.clientes ? 'audio' : t.compraram / t.clientes > a.compraram / a.clientes ? 'texto' : '') : '';
    return `<div class="placar-ab">
      <div class="${lider === 'audio' ? 'lider' : ''}"><span class="rotulo">🎤 Áudio</span><b>${taxa(a)}</b><span class="rotulo">${a.compraram || 0} de ${a.clientes || 0} compraram${a.clientes ? ` · ${a.receberam || 0} já receberam o áudio` : ''}</span></div>
      <div class="${lider === 'texto' ? 'lider' : ''}"><span class="rotulo">💬 Texto</span><b>${taxa(t)}</b><span class="rotulo">${t.compraram || 0} de ${t.clientes || 0} compraram</span></div>
    </div>${a.clientes + t.clientes < 20 ? '<span class="rotulo">Com poucos clientes o resultado ainda varia muito: espere pelo menos uns 20 em cada grupo para decidir.</span>' : ''}`;
  };
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
  // a IA usa esta mídia? (citada no prompt, com descrição, ou marcada pronta)
  const citadas = new Set((noPrompt?.citados || []).filter((c) => c.existe).map((c) => c.codigo));
  // desligada pelo dono: não sai de jeito nenhum (nem citada no prompt) — igual ao servidor
  const desligada = (m) => m.pausada === true || (m.pronta === false && Boolean((m.descricao || '').trim()));
  const citada = (m) => !desligada(m) && m.pronta !== false && (citadas.has(codNum(m)) || citadas.has(codMidia(m.codigo)));
  const citadaInativa = (m) => m.pronta === false && (citadas.has(codNum(m)) || citadas.has(codMidia(m.codigo)));
  const statusIa = (m) => m.aprendidaDoClone && !m.donoConfirmou && !desligada(m)
    ? '<span class="midia-uso fup">🧬 Cópia guardada pelo Clone (de um arquivo que você mandou à mão) — a IA só usa quando o Clone estiver atendendo. Para a IA usar sempre, abra Editar e salve como Ativa.</span>'
    : desligada(m)
    ? '<span class="midia-uso off">⛔ Desligada — não sai de jeito nenhum (nem pela IA, nem pelo follow-up/automações). Só se você mandar à mão.</span>'
    : m.soFollowup
    ? '<span class="midia-uso fup">🔁 Só no follow-up</span>'
    : citada(m)
      ? '<span class="midia-uso ok">📌 Está no prompt — a IA manda quando o prompt pedir</span>'
      : m.pronta !== false
        ? `<span class="midia-uso ok">✅ A IA manda ${m.descricao ? 'quando combinar com a descrição' : 'quando ajudar o cliente'}</span>`
        : citadaInativa(m)
          ? `<span class="midia-uso off">⚠️ O prompt cita <b>${esc(codNum(m))}</b>, mas ela está "a configurar": <b>não sai</b>. Ative (Editar → Ativa) ou troque o código no prompt.</span>`
          : '<span class="midia-uso off">⚪ A configurar — não sai. Escreva o "quando enviar" e marque Ativa.</span>';
  const cartao = (m) => `
    <div class="card midia ${selecionadas.has(m.id) ? 'selecionada' : ''} ${m.pronta === false && !citada(m) && !m.soFollowup ? 'a-configurar' : ''}">
      <label class="midia-check" title="Selecionar"><input type="checkbox" data-sel="${esc(m.id)}" ${selecionadas.has(m.id) ? 'checked' : ''}></label>
      <a class="midia-previa" href="${esc(m.url)}" target="_blank" rel="noopener">${previa(m)}</a>
      <button type="button" class="codigo-num" data-copiar="${esc(codNum(m))}" title="Copiar o código para colar no prompt">${esc(codNum(m))} <span>⧉ copiar</span></button>
      <strong>${esc(m.nome)}</strong>
      ${statusIa(m)}
      ${m.tipo === 'audio' ? `<audio class="midia-audio" controls preload="none" src="${esc(m.url)}"></audio>
      <form class="midia-fala" data-fala="${esc(m.id)}">
        <label class="rotulo">🗣️ O que o áudio fala ${m.falaAuto ? '<span class="etiqueta">transcrito pela IA — confira</span>' : ''}</label>
        <textarea name="fala" rows="3" maxlength="2000" placeholder="Escreva o que o áudio fala (a IA usa isso para saber o conteúdo e não repetir por escrito)">${esc(m.fala || '')}</textarea>
        <span class="acoes-fala"><button type="submit" class="pequeno">Salvar</button><button type="button" class="pequeno" data-transcrever="${esc(m.id)}" title="A IA ouve o áudio e escreve o que ele fala">✨ Transcrever</button></span>
      </form>
      <div class="ab-audio ${m.abTexto ? 'ligado' : ''}">
        <label class="linha-check"><input type="checkbox" data-ab="${esc(m.id)}" ${m.abTexto ? 'checked' : ''}> <b>🧪 Teste A/B: áudio x texto</b></label>
        <span class="rotulo">Metade dos clientes recebe este áudio; a outra metade recebe o mesmo conteúdo escrito pela IA. Cada cliente fica sempre no mesmo grupo.</span>
        ${m.abTexto && !m.fala ? '<span class="rotulo aviso-texto">⚠️ Preencha "o que o áudio fala": é esse o texto que o grupo "texto" recebe.</span>' : ''}
        ${m.ab ? placarAB(m.ab) : ''}
      </div>` : ''}
      ${m.tipo === 'audio' && !m.soFollowup ? '<label class="rotulo" style="margin-top:6px">⏱️ Quando enviar</label>' : ''}
      ${m.soFollowup ? '' : `<form class="midia-desc" data-desc="${esc(m.id)}">
        <input name="descricao" maxlength="300" value="${esc(m.descricao || '')}" placeholder="Descrição (opcional): quando a IA deve mandar">
        <button type="submit" class="pequeno" title="Salvar a descrição">Salvar</button>
      </form>`}
      ${albumDe(m) ? `<span class="rotulo">🗂️ No álbum ${esc(albumDe(m).nome)}</span>` : ''}
      ${m.etapas?.length ? `<span class="rotulo">Só na etapa: ${chipEtapas(m.etapas)}</span>` : ''}
      ${(m.assuntos || []).length ? `<span class="rotulo">${chipsAssuntos({ ...m, soFollowup: false })}</span>` : ''}
      ${statusVideo(m)}
      <span class="rotulo">${m.tamanho < 100 * 1024 ? `${Math.max(1, Math.round(m.tamanho / 1024))} KB` : `${(m.tamanho / 1024 / 1024).toFixed(1)} MB`}${duracaoTxt(m.duracao)}${m.umaVezPorConversa === false ? ' · pode repetir' : ''}${m.legenda ? ' · 💬 legenda' : ''}${m.revezar ? ` · 🔁 reveza com ${esc(lista.filter((x) => x.id !== m.id && x.revezar === m.revezar).map((x) => codNum(x)).join(', '))}` : ''}</span>
      <div class="acoes" style="margin-top:8px"><button class="pequeno" data-editar="${esc(m.id)}">Editar</button>${m.pastaId ? '' : `<button class="pequeno" data-trocar="${esc(m.id)}" title="Sobe um arquivo novo no lugar deste: mesmo código e mesma configuração. O antigo é apagado e não vai mais.">🔁 Trocar arquivo</button>`}<button class="pequeno perigo" data-apagar="${esc(m.id)}">Apagar</button></div>
    </div>`;
  const cartaoAlbum = (a) => {
    const itens = lista.filter((m) => m.albumId === a.id);
    return `
    <div class="pasta">
      <div class="pasta-fotos">${itens.slice(0, 4).map((m) => (m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : `<span>${ICONE_TIPO[m.tipo] || '📎'}</span>`)).join('') || '<span>🗂️</span>'}</div>
      <div class="pasta-info"><strong>${esc(a.nome)} <button type="button" class="codigo-chip" data-copiar="${esc(codNum(a))}" title="Copiar código">${esc(codNum(a))} ⧉</button></strong><span class="rotulo">${itens.length} ${itens.length === 1 ? 'arquivo' : 'arquivos'}${itens.some((m) => m.pronta === false || m.processando) ? ` · <span class="aviso-texto">⚠️ só ${itens.filter((m) => m.pronta !== false && !m.processando).length} pronta(s) — a IA manda só as prontas</span>` : ''} · ${a.descricao ? `quando: ${esc(a.descricao)}` : '<span class="aviso-texto">⚠️ falta dizer quando enviar</span>'}</span>${a.etapas?.length ? `<span class="rotulo">Só na etapa: ${chipEtapas(a.etapas)}</span>` : ''}${(a.assuntos || []).length || a.soFollowup ? `<span class="rotulo">${chipsAssuntos(a)}</span>` : ''}</div>
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
    if (aba === 'audios') {
      // 🎤 Áudios: gravador + cartões próprios (os outros botões da biblioteca não valem aqui)
      try { sessionStorage.setItem(`midias_aba_${id}`, 'audios'); } catch { /* ok */ }
      grade.innerHTML = '<div id="aba-audios"></div>';
      montarAudios(id, $('#aba-audios'), lista, () => paginaMidias(id));
    } else if (aba === 'albuns') {
      grade.innerHTML = `<p class="rotulo" style="margin:4px 0 12px">Álbum = várias mídias que a IA manda juntas (até 10). Selecione as mídias nas outras abas e use <b>Pôr no álbum</b>, ou crie aqui.</p>
        <div class="acoes" style="margin:0 0 12px"><button type="button" class="primario pequeno" id="novo-album">+ Novo álbum</button></div>
        <div class="lista-pastas">${albuns.filter(passaAssunto).map(cartaoAlbum).join('') || '<p class="rotulo">Nenhum álbum aqui.</p>'}</div>`;
    } else {
      const itens = lista.filter((m) => grupos[aba].filtro(m) && passaAssunto(m));
      grade.innerHTML = (aba === 'followup' ? `<p class="rotulo" style="margin:4px 0 10px">🔁 Estas mídias <b>só saem no follow-up</b> (escolha nos passos da aba <a href="${rotaEmpresa(id, 'followup')}">Follow-up</a>). A IA <b>nunca</b> manda estas na conversa. Para mover para cá: selecione e use <b>Uso → Só no follow-up</b>, ou envie arquivos com esta aba aberta.</p>` : '') +
        (itens.length ? `<div class="grade-midias">${itens.map(cartao).join('')}</div>` : `<p class="rotulo" style="padding:12px 0">${aba === 'configurar' ? 'Nada para configurar. 🎉' : aba === 'prontas' ? 'Nenhuma mídia pronta ainda — configure as da aba "A configurar".' : 'Nenhuma aqui ainda.'}</p>`);
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
    // 🔁 Trocar arquivo: o novo fica no lugar do antigo (mesmo código) — só o novo vai daqui em diante
    $$('[data-trocar]').forEach((b) => {
      b.onclick = () => {
        const m = lista.find((x) => x.id === b.dataset.trocar);
        if (!m) return;
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = m.tipo === 'image' ? 'image/*' : m.tipo === 'video' ? 'video/*' : m.tipo === 'audio' ? 'audio/*' : '';
        inp.onchange = async () => {
          const f = inp.files?.[0];
          if (!f) return;
          if (!(await confirmar({ titulo: `Trocar o arquivo de ${codNum(m)}?`, texto: `"${m.nome}" passa a ser "${f.name}". O código ${codNum(m)} e a configuração continuam; o arquivo antigo é apagado e não vai mais para ninguém.`, botao: 'Trocar' }))) return;
          b.disabled = true;
          b.textContent = 'Enviando…';
          try {
            const r = await fetch(`api/empresas/${id}/midias/${m.id}/arquivo?arquivo=${encodeURIComponent(f.name)}&tipo=${encodeURIComponent(f.type)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
            const corpo = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(corpo.erro || 'Não consegui trocar o arquivo.');
            aviso(`Arquivo de ${codNum(m)} trocado. Daqui em diante vai só o novo.`);
            paginaMidias(id);
          } catch (err) {
            aviso(err.message, true);
            b.disabled = false;
            b.textContent = '🔁 Trocar arquivo';
          }
        };
        inp.click();
      };
    });
    // descrição na hora (opcional): escreveu, a IA já pode usar a mídia
    $$('[data-fala]').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const m = lista.find((x) => x.id === f.dataset.fala);
        try {
          const r = await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: { fala: f.elements.fala.value.trim() } }));
          Object.assign(m, { fala: r.fala, falaAuto: r.falaAuto });
          aviso('Salvo: a IA já sabe o que este áudio fala.');
          desenharBiblioteca();
        } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-ab]').forEach((c) => {
      c.onchange = async () => {
        const m = lista.find((x) => x.id === c.dataset.ab);
        try {
          const r = await api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: { abTexto: c.checked } });
          Object.assign(m, { abTexto: r.abTexto });
          aviso(c.checked ? 'Teste A/B ligado: os próximos clientes são divididos entre áudio e texto.' : 'Teste A/B desligado: o áudio volta a ir para todos.');
          desenharBiblioteca();
        } catch (err) { c.checked = !c.checked; aviso(err.message, true); }
      };
    });
    $$('[data-transcrever]').forEach((b) => {
      b.onclick = async () => {
        const m = lista.find((x) => x.id === b.dataset.transcrever);
        try {
          const r = await comEspera(b, () => api(`empresas/${id}/midias/${m.id}/transcrever`, { method: 'POST', body: {} }), 'Ouvindo…');
          Object.assign(m, { fala: r.fala, falaAuto: r.falaAuto, duracao: r.duracao });
          aviso('Pronto: a IA escreveu o que o áudio fala. Confira e corrija se precisar.');
          desenharBiblioteca();
        } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-desc]').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const m = lista.find((x) => x.id === f.dataset.desc);
        const descricao = f.elements.descricao.value.trim();
        try {
          const r = await comEspera(f.querySelector('button'), () => api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: { descricao } }));
          Object.assign(m, { descricao: r.descricao, pronta: r.pronta });
          aviso(descricao ? `Descrição salva: a IA já pode mandar ${codNum(m)}.` : 'Descrição apagada.');
          desenharBiblioteca();
        } catch (err) { aviso(err.message, true); }
      };
    });
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
          <div class="campo"><label>Código de texto (opcional) ${ajuda(`Use o número ${codNum(m)} no prompt — é o mais simples. Este código de texto também funciona (para quem já usava). Formato #MIDIA_ + MAIÚSCULAS e _.`)}</label><input name="codigo" required value="${esc(codMidia(m.codigo))}" style="text-transform:uppercase"></div>
        </div>
        <p class="rotulo" style="margin:6px 0 0">Código para o prompt: <b class="codigo-num-txt">${esc(codNum(m))}</b> · Tipo: <b>${esc(TIPO_MIDIA_TXT[m.tipo] || m.tipo)}</b>${m.origemLink ? ` · veio do link <a href="${esc(m.origemLink)}" target="_blank" rel="noopener">Google Drive</a>` : ''}</p>
        ${camposQuando(m)}
        ${m.tipo === 'audio' ? '' : `<div class="campo" style="margin-top:12px"><label>Legenda (opcional) ${ajuda('Texto que vai junto com a foto/vídeo/documento no WhatsApp.')}</label><input name="legenda" value="${esc(m.legenda || '')}" maxlength="1000" placeholder="Ex.: Resultado do serviço completo ✨"></div>`}
        <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="umaVez" ${m.umaVezPorConversa === false ? '' : 'checked'}> Enviar <b>uma vez por conversa</b> (a IA não repete para o mesmo cliente)</label>
        ${(() => {
          const outras = lista.filter((x) => x.id !== m.id && x.tipo === m.tipo);
          const par = m.revezar ? lista.find((x) => x.id !== m.id && x.revezar === m.revezar) : null;
          return outras.length ? `<div class="campo" style="margin-top:12px"><label>🔁 Revezar com ${ajuda('Quando a IA pedir esta mídia (ou a outra), o CRM alterna entre as duas: o 1º cliente recebe uma, o próximo cliente recebe a outra, e assim por diante. O mesmo cliente nunca recebe as duas.')}</label><select name="revezarCom"><option value="">— não revezar —</option>${outras.map((x) => `<option value="${esc(x.id)}" ${par && par.id === x.id ? 'selected' : ''}>${esc(codNum(x))} · ${esc(x.nome)}</option>`).join('')}</select><small>Ex.: dois vídeos do serviço completo — cada cliente novo recebe um, alternando. Ao ligar, as duas ficam <b>ativas</b> e a que estava sem configurar copia o "quando enviar", etapas e assuntos da outra.</small></div>` : '';
        })()}
        <div class="campo" style="margin-top:12px"><label>Álbum</label><select name="albumId"><option value="">— nenhum —</option>${albuns.map((a) => `<option value="${esc(a.id)}" ${a.id === m.albumId ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select></div>
        <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="pronta" ${m.pronta === false ? '' : 'checked'}> <b>Ativa</b> — a IA já pode enviar (desmarcada = desligada: não sai de jeito nenhum, nem pelo prompt, follow-up ou automações)</label>
        <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (modal, fechar) => {
      $('#f-ed-midia', modal).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        if (f.elements.pronta.checked && !f.elements.descricao.value.trim() && !f.elements.albumId.value) {
          if (!(await confirmar({ titulo: 'Sem "quando enviar"?', texto: 'Sem essa regra a IA decide sozinha quando mandar. Quer salvar assim mesmo?', botao: 'Salvar assim' }))) return;
        }
        try {
          await api(`empresas/${id}/midias/${m.id}`, { method: 'PUT', body: { nome: f.elements.nome.value, codigo: f.elements.codigo.value, descricao: f.elements.descricao.value, etapas: lerEtapas(f), ...lerAssuntos(f), albumId: f.elements.albumId.value, pronta: f.elements.pronta.checked, umaVezPorConversa: f.elements.umaVez.checked, ...(f.elements.legenda ? { legenda: f.elements.legenda.value } : {}), ...(f.elements.revezarCom ? { revezarCom: f.elements.revezarCom.value } : {}) } });
          fechar();
          const novoPar = f.elements.revezarCom?.value && !(m.revezar && lista.some((x) => x.id === f.elements.revezarCom.value && x.revezar === m.revezar));
          aviso(novoPar ? 'Revezamento ligado: as duas mídias estão ativas e com as mesmas regras de envio.' : 'Mídia salva.');
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
  let etiquetas = emp.etiquetas.map((t) => ({ ...t }));
  let etapas = emp.etapas.slice();
  const CORES = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Etiquetas e etapas</h1><p class="sub">Como os seus leads ficam organizados</p></div></div>
    <div class="duas-colunas">
      <div class="card">
        <h2>Etiquetas</h2>
        ${balao('Para que servem?', 'Marcam o cliente com uma característica: <i>Agendado</i>, <i>Orçamento enviado</i>, <i>Cliente VIP</i>… Você filtra os leads por elas e escolhe <b>para quem fazer disparos</b>. As IAs também podem colocar etiquetas sozinhas. São só do CRM: as etiquetas do WhatsApp do celular não mudam.')}
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
        <input type="color" value="${esc(t.cor || '#64748b')}" data-cor="${i}" title="Cor">
        <input value="${esc(t.nome)}" data-nome="${i}" placeholder="Nome da etiqueta" maxlength="40">
        <button type="button" class="pequeno perigo" data-tirar="${i}" title="Apagar">✕</button>
      </div>`).join('') || '<p class="rotulo">Nenhuma etiqueta. Clique em <b>+ Nova etiqueta</b>.</p>';
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
  $('#add-etapa').onclick = () => {
    etapas.push('');
    desenharEtapas();
    $$('[data-etapa]').pop()?.focus();
  };
  $('#add-etiqueta').onclick = () => {
    etiquetas.push({ nome: '', cor: CORES[etiquetas.length % CORES.length] });
    desenharEtiquetas();
    $$('[data-nome]').pop()?.focus();
  };
  $('#salvar-etiquetas').onclick = async (e) => {
    const ficam = etiquetas.filter((t) => t.nome.trim());
    const apagadas = emp.etiquetas.filter((t) => !ficam.some((x) => x.id === t.id));
    if (apagadas.length && !(await confirmar({ titulo: 'Apagar etiquetas?', texto: `<b>${apagadas.map((t) => esc(t.nome)).join(', ')}</b> some(m) do CRM e dos clientes marcados com ela(s).`, botao: 'Salvar', perigo: true }))) return;
    try {
      const r = await comEspera(e.target, () => api(`empresas/${id}/etiquetas`, { method: 'PUT', body: { etiquetas: ficam } }));
      emp.etiquetas = r.etiquetas;
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

// Onde os tokens foram nos últimos 7 dias: por tarefa e por modelo, com o custo estimado
const NOME_TAREFA_IA = { resposta: '💬 Respostas no WhatsApp', site: '🌐 Chat do site', evento: '⏰ Avisos internos (sem resposta, follow-up com IA)', followup: '🔁 Follow-up e automações com IA', foto: '🖼️ Fotos dos clientes', audio: '🎤 Áudios dos clientes', comprovante: '🧾 Comprovantes', 'sugestao-midia': '📎 Sugestão de mídia (removida)', agenda: '📅 Detector de agendamento', 'aviso-agendamento': '📣 Aviso de agendamento', aprendizado: '📚 Aprendizado diário', catalogo: '🛍️ Catálogo (sugerir itens)', 'conferir-prompt': '✅ Atualizar e conferir', 'sugestao-equipe': '✍️ Sugestão de resposta (removida)', teste: '🧪 Testes', outros: 'Outros' };
// Tokens divididos: respostas aos clientes × reconhecimento do CRM (fotos, áudios, comprovantes, agenda…)
const TAREFAS_RESPOSTA = new Set(['resposta', 'site', 'followup', 'evento']);
function cartaoRespostasXCrm(hoje, semana) {
  const somar = (u, resp) => {
    const r = { tokens: 0, chamadas: 0, itens: [] };
    for (const [k, x] of Object.entries(u?.porTarefa || {})) {
      if (TAREFAS_RESPOSTA.has(k) !== resp) continue;
      r.tokens += x.tokens || 0;
      r.chamadas += x.chamadas || 0;
      r.itens.push([k, x]);
    }
    r.itens.sort((a, b) => b[1].tokens - a[1].tokens);
    return r;
  };
  const lado = (titulo, icone, resp, dica) => {
    const h = somar(hoje, resp);
    const s7 = somar(semana, resp);
    const total = somar(hoje, true).tokens + somar(hoje, false).tokens;
    const pct = total ? Math.round((h.tokens / total) * 100) : 0;
    return `<div class="rxc-lado">
      <div class="rxc-topo"><span class="rxc-icone">${icone}</span><div><b>${titulo}</b><span class="rotulo">${dica}</span></div></div>
      <div class="rxc-num"><b>${numeroCurto(h.tokens)}</b><span class="rotulo">tokens hoje · ${h.chamadas} chamada${h.chamadas === 1 ? '' : 's'}${total ? ` · ${pct}%` : ''}${resp && h.chamadas ? ` · média ${numeroCurto(Math.round(h.tokens / h.chamadas))} por resposta` : ''}</span></div>
      <div class="rxc-barra"><span style="width:${pct}%"></span></div>
      <p class="rotulo" style="margin:6px 0 0">7 dias: <b>${numeroCurto(s7.tokens)}</b> tokens em ${s7.chamadas} chamada${s7.chamadas === 1 ? '' : 's'}</p>
      ${h.itens.length ? `<ul class="rxc-lista">${h.itens.map(([k, x]) => `<li><span>${esc(NOME_TAREFA_IA[k] || k)}</span><span>${x.chamadas}× · ${numeroCurto(x.tokens)}</span></li>`).join('')}</ul>` : '<p class="rotulo" style="margin:6px 0 0">Nada hoje.</p>'}
    </div>`;
  };
  return `<div class="card">
    <h2 style="margin:0 0 4px">🧮 Tokens hoje: respostas × reconhecimento do CRM</h2>
    <p class="rotulo" style="margin:0 0 12px">Cada resposta manda para a IA as instruções, a lista de mídias e o fim da conversa — por isso uma resposta pesa bem mais que uma leitura de foto. Enxugar as instruções e as descrições das mídias é o que mais economiza.</p>
    <div class="rxc">${lado('Respostas aos clientes', '💬', true, 'WhatsApp, chat do site, follow-up e avisos com IA')}${lado('Reconhecimento do CRM', '🔎', false, 'fotos, áudios, comprovantes, agenda, avisos e conferências')}</div>
  </div>`;
}

function tabelaGastoIa(u) {
  const linhas = (obj, nome) => Object.entries(obj || {}).sort((a, b) => (b[1].custo || 0) - (a[1].custo || 0) || b[1].tokens - a[1].tokens).map(([k, x]) => `<tr><td>${esc(nome(k))}</td><td class="num">${(x.chamadas || 0).toLocaleString('pt-BR')}</td><td class="num">${numeroCurto(x.tokens)}</td><td class="num esconde-mobile">${numeroCurto(x.cache)}</td><td class="num">${x.custo ? (x.custo < 0.01 ? '&lt; US$ 0.01' : `US$ ${x.custo.toFixed(2)}`) : '—'}</td></tr>`).join('');
  const porTarefa = linhas(u?.porTarefa, (k) => NOME_TAREFA_IA[k] || k);
  const porModelo = linhas(u?.porModelo, (k) => k);
  const cab = (t) => `<thead><tr><th>${t}</th><th class="num">Chamadas</th><th class="num">Tokens</th><th class="num esconde-mobile">Cache</th><th class="num">Custo est.</th></tr></thead>`;
  return `<div class="card tokens-tabela">
      <h2 style="margin:0 0 8px">🔎 Para onde foram os tokens (7 dias)</h2>
      ${porTarefa ? `<div class="tabela-wrap"><table>${cab('Tarefa')}<tbody>${porTarefa}</tbody></table></div>
      <div class="tabela-wrap" style="margin-top:12px"><table>${cab('Modelo')}<tbody>${porModelo}</tbody></table></div>
      <p class="rotulo" style="margin:10px 0 0">Custo estimado pelos preços de tabela (entrada, saída e cache). Modelos sem preço cadastrado (ex.: Gemini 3) aparecem sem custo — os tokens estão certos.</p>` : '<p class="rotulo" style="margin:0">Ainda sem dados por tarefa — aparecem a partir das próximas chamadas à IA.</p>'}
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
        : (emp.motores?.length ? emp.motores.map((m) => m.provedor) : [bot?.provedor || 'anthropic']).includes(provedor)
          ? '<span class="etiqueta off">⚠️ Sem chave — a IA não responde. Cole a chave aqui embaixo</span>'
          : '<span class="etiqueta off">Sem chave — cadastre a da empresa</span>';
    // pronto (tem chave) ou opcional (não é a IA principal): vira uma linha; a principal sem chave fica aberta
    // IA que está na ordem (1ª, 2ª ou 3ª) e sem chave: fica aberta e em vermelho — sem ela a IA não responde
    const naOrdem = (emp.motores?.length ? emp.motores.map((m) => m.provedor) : [bot?.provedor || 'anthropic']).includes(provedor);
    const principalSemChave = !c.propria && !c.usaPadrao && naOrdem;
    const pronto = c.propria || c.usaPadrao ? 'ok' : principalSemChave ? '' : 'off';
    const resumo = c.propria ? `Chave da empresa · termina em ${c.final}` : c.usaPadrao ? 'Usando a chave do administrador' : 'Sem chave · opcional (para usar como reserva)';
    return `
      <div class="card" data-cfg="chave-${provedor}" data-titulo="${esc(NOME_PROVEDOR[provedor])}" data-pronto="${pronto}" data-resumo="${esc(resumo)}">
        <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">${NOME_PROVEDOR[provedor]} ${extra}</h2>${situacao}</div>
        <details ${principalSemChave ? 'open' : ''}><summary>Como conseguir a chave</summary>${passos(passosCriar)}</details>
        <form data-provedor="${provedor}" style="margin-top:12px">
          <div class="campo"><label>${c.propria ? 'Trocar chave' : 'Cole a chave aqui'}</label><input name="${campo}" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${esc(dica)}"></div>
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
  const g = emp.chaves.gemini || {};
  const gv = emp.chaves.geminiVerificacoes || {};
  const gr = emp.chaves.geminiReserva || {};
  const gr2 = emp.chaves.geminiReserva2 || {};
  const gr3 = emp.chaves.geminiReserva3 || {};
  const modeloAtual = (emp.motores || []).find((m) => m.provedor === 'gemini')?.modelo || '';
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Chave da IA</h1><p class="sub">Chave do Gemini (Google) desta empresa — e, se quiser, uma 2ª só para as verificações. Os tokens saem da conta de cada chave.</p></div></div>
    <div class="card">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🔑 Gemini (Google)</h2>${g.propria ? `<span><span class="etiqueta ok">✓ Chave salva</span> <span class="rotulo">termina em ${esc(g.final)}</span></span>` : '<span class="etiqueta off">⚠️ Sem chave — a IA não responde</span>'}</div>
      <details ${g.propria ? '' : 'open'}><summary>Como conseguir a chave</summary>${passos([
        'Entre em <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> com a conta Google da empresa.',
        'Clique em <b>Create API key</b> (Criar chave de API) e depois no botão de <b>copiar</b> da chave (ela começa com <code>AIza</code> ou <code>AQ.</code>).',
        'Cole aqui embaixo e clique em <b>Salvar e testar</b>.'
      ])}</details>
      <form data-provedor="gemini" style="margin-top:12px">
        <div class="campo"><label>${g.propria ? 'Trocar a chave (cole a nova)' : 'Cole a chave aqui'}</label><input name="geminiApiKey" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="AIza… ou AQ.…"></div>
        <div class="acoes">
          <button class="primario" type="submit">Salvar e testar</button>
          ${g.propria ? '<button type="button" data-testar>Testar</button><button type="button" class="perigo" data-remover>Excluir chave</button>' : ''}
        </div>
      </form>
      ${g.propria ? `
      <div class="campos" style="margin-top:14px;align-items:end">
        <div class="campo largo"><label>Modelo do Gemini ${ajuda('A lista vem da sua chave: só aparece o que a conta do Google tem. Flash é rápido e barato (recomendado); Pro pensa mais e custa mais; Lite é o mais barato.')}</label>
          <select id="prov-gemini" hidden><option value="gemini" selected>gemini</option></select>
          <select id="modelo-gemini"><option value="${esc(modeloAtual)}">${esc(modeloAtual || '—')}</option></select>
          <small id="aviso-modelo-gemini" class="rotulo"></small></div>
      </div>
      <div class="acoes"><button type="button" id="salvar-modelo-gemini">Salvar modelo</button></div>` : ''}
      ${reserva ? `<p class="rotulo" style="margin:10px 0 0">Último problema: ${data(reserva.em)} — ${esc((reserva.falhas || []).join('; '))}</p>` : ''}
    </div>
    ${cartaoEsperandoIa(emp, id) || '<p class="rotulo" style="margin:0 0 12px">⏳ Esperando token da IA: <b>0 clientes</b> — ninguém na fila.</p>'}
    <div class="card">
      <h2 style="margin:0 0 6px">🛟 Chaves reserva <span class="rotulo" style="font-weight:400">(opcionais)</span></h2>
      <p class="rotulo" style="margin:0 0 6px">Quando a chave principal <b>bater no limite grátis ou ficar sem crédito</b>, a IA continua respondendo com a 1ª reserva — e, se ela também acabar, com a 2ª e depois a 3ª. <b>A conversa continua igual</b>: o histórico e o prompt ficam no CRM, então qualquer chave que responder sabe tudo o que já foi falado. Quando a principal voltar, o CRM volta a usar ela sozinho.</p>
      <p class="rotulo" style="margin:0 0 10px">⚠️ Cada uma tem que ser de <b>outra conta Google</b> (ou outro projeto no AI Studio). O limite grátis do Google é por projeto: chaves do mesmo projeto dividem o mesmo limite e não adiantam. A chave das verificações (abaixo) continua separada e não entra aqui.</p>
      ${rotacaoDeHoje(emp)}
      ${[['geminiApiKeyReserva', 'reserva', gr, '1ª reserva'], ['geminiApiKeyReserva2', 'reserva2', gr2, '2ª reserva'], ['geminiApiKeyReserva3', 'reserva3', gr3, '3ª reserva']].map(([campo, qual, g2, nome]) => `
      <form class="f-chave-reserva" data-qual="${qual}" style="margin-top:10px">
        <div class="campo"><label>${nome} ${g2.propria ? `<span class="etiqueta ok">✓ salva</span> <span class="rotulo">termina em ${esc(g2.final)}</span>` : '<span class="rotulo">— não cadastrada</span>'}</label><input name="${campo}" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${g2.propria ? 'cole outra para trocar' : 'AIza… ou AQ.…'}"></div>
        <div class="acoes">
          <button class="primario" type="submit">Salvar e testar</button>
          ${g2.propria ? '<button type="button" data-testar-reserva>Testar</button><button type="button" class="perigo" data-excluir-reserva>Excluir</button>' : ''}
        </div>
      </form>`).join('')}
    </div>
    <div class="card">
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">🔎 Chave das verificações <span class="rotulo" style="font-weight:400">(opcional)</span></h2>${gv.propria ? `<span><span class="etiqueta ok">✓ Chave salva</span> <span class="rotulo">termina em ${esc(gv.final)}</span></span>` : '<span class="etiqueta">Usando a chave principal</span>'}</div>
      <p class="rotulo" style="margin:0 0 10px">Uma 2ª chave do Gemini (pode ser de outra conta Google) só para o que o CRM confere sozinho: <b>fotos, comprovantes, áudios, detector de agendamento, "Atualizar e conferir" e aprendizado</b>. As conversas com o cliente continuam na chave principal. Assim os limites de uso das duas somam. Se ela falhar, o CRM usa a principal naquela hora.</p>
      <form id="f-chave-verif">
        <div class="campo"><label>${gv.propria ? 'Trocar a chave das verificações' : 'Cole a 2ª chave aqui'}</label><input name="geminiApiKeyVerificacoes" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="AIza… ou AQ.…"></div>
        <div class="acoes">
          <button class="primario" type="submit">Salvar e testar</button>
          ${gv.propria ? '<button type="button" id="testar-verif">Testar</button><button type="button" class="perigo" id="excluir-verif">Excluir</button>' : ''}
        </div>
      </form>
    </div>
    <div class="card">
      <h2 style="margin:0 0 8px">📊 Gasto de hoje</h2>
      <div class="grade-resumo" style="margin:0">
        ${numeroCard('Tokens hoje', numeroCurto(u.total))}
        ${numeroCard('Chamadas à IA', (u.chamadas || 0).toLocaleString('pt-BR'))}
        ${numeroCard('Vindos do cache (≈90% mais barato)', numeroCurto(u.cache))}
      </div>
    </div>
    ${cartaoRespostasXCrm(emp.usoHoje, emp.uso7d)}
    ${tabelaGastoIa(emp.uso7d)}`;

  $$('.f-chave-reserva').forEach((f) => {
    const qual = f.dataset.qual;
    const testar = async () => {
      try {
        const r = await api(`empresas/${id}/chaves/testar`, { method: 'POST', body: { provedor: 'gemini', qual } });
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
          await testar();
        }, 'Testando…');
        paginaChave(id);
      } catch (err) { aviso(err.message, true); }
    };
    f.querySelector('[data-testar-reserva]')?.addEventListener('click', testar);
    f.querySelector('[data-excluir-reserva]')?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Excluir esta chave reserva?', texto: 'Ela deixa de responder quando a principal bater no limite.', botao: 'Excluir', perigo: true }))) return;
      try { await api(`empresas/${id}/chaves`, { method: 'PUT', body: { remover: [`gemini-${qual}`] } }); paginaChave(id); } catch (err) { aviso(err.message, true); }
    });
  });

  if ($('#f-chave-verif')) {
    const testarVerif = async () => {
      try {
        const r = await api(`empresas/${id}/chaves/testar`, { method: 'POST', body: { provedor: 'gemini', qual: 'verificacoes' } });
        aviso(r.mensagem);
      } catch (err) { aviso(err.message, true); }
    };
    $('#f-chave-verif').onsubmit = async (e) => {
      e.preventDefault();
      const dados = formParaObjeto(e.target);
      if (!dados.geminiApiKeyVerificacoes) return aviso('Cole a chave antes de salvar.', true);
      try {
        await comEspera(e.target.querySelector('button[type=submit]'), async () => {
          await api(`empresas/${id}/chaves`, { method: 'PUT', body: dados });
          await testarVerif();
        }, 'Testando…');
        paginaChave(id);
      } catch (err) { aviso(err.message, true); }
    };
    $('#testar-verif')?.addEventListener('click', testarVerif);
    $('#excluir-verif')?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Excluir a chave das verificações?', texto: 'As verificações voltam a usar a chave principal.', botao: 'Excluir', perigo: true }))) return;
      try { await api(`empresas/${id}/chaves`, { method: 'PUT', body: { remover: ['gemini-verificacoes'] } }); paginaChave(id); } catch (err) { aviso(err.message, true); }
    });
  }

  if ($('#modelo-gemini')) {
    ligarSeletorModelo(null, id, $('#prov-gemini'), $('#modelo-gemini'), $('#aviso-modelo-gemini'));
    $('#salvar-modelo-gemini').onclick = async (e) => {
      const modelo = $('#modelo-gemini').value;
      if (!modelo || modelo === 'carregando…') return aviso('Espere a lista de modelos carregar.', true);
      try {
        await comEspera(e.target, async () => {
          await api(`empresas/${id}/motores`, { method: 'PUT', body: { motores: [{ provedor: 'gemini', modelo }] } });
          const r = await api(`empresas/${id}/chaves/testar`, { method: 'POST', body: { provedor: 'gemini' } }).catch((err) => ({ erro: err.message }));
          aviso(r.erro || r.mensagem, Boolean(r.erro));
        }, 'Testando…');
        paginaChave(id);
      } catch (err) { aviso(err.message, true); }
    };
  }

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
  if ($('#salvar-motores')) $('#salvar-motores').onclick = async (e) => {
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
          // a chave do Gemini vira a IA da empresa (o servidor escolhe o modelo que a chave tem)
          await api(`empresas/${id}/chaves`, { method: 'PUT', body: dados });
          await testar();
        }, 'Testando…');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
    $('[data-testar]', f)?.addEventListener('click', testar);
    $('[data-remover]', f)?.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Excluir a chave?', texto: 'Sem chave, a IA desta empresa para de responder até você colar outra.', botao: 'Excluir', perigo: true }))) return;
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
// a cidade lida na conversa já está como etiqueta do cliente (ex.: etiqueta "Vassouras")? mostra só a etiqueta
const simplesLocal = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function localJaEtiqueta(l, etiquetas) {
  if (!l?.local?.texto || !l.etiquetas?.length || !etiquetas?.length) return false;
  const partes = l.local.texto.split(' - ')[0].split(',').map(simplesLocal).filter(Boolean);
  return (l.etiquetas || []).some((tid) => { const t = etiquetas.find((x) => x.id === tid); return t && partes.includes(simplesLocal(t.nome)); });
}
function chipLocal(l, classe = '', etiquetas = null) {
  if (!l?.local?.texto || localJaEtiqueta(l, etiquetas)) return '';
  return `<span class="etiqueta chip-local ${classe}" title="Localização: ${esc(l.local.origem || '')}">📍 ${esc(l.local.texto)}</span>`;
}

// 🔥 chance de venda (sem IA): selo com os motivos no "title"
function seloTemperatura(t, curto = false) {
  if (!t || !['quente', 'morno'].includes(t.nivel)) return '';
  return `<span class="etiqueta selo-temp ${t.nivel}" title="${esc(`Chance de venda: ${t.rotulo} (${t.pontos} pontos)\n${(t.motivos || []).join('\n')}`)}">${curto ? t.rotulo.split(' ')[0] : esc(t.rotulo)}</span>`;
}

function chipsDoLead(l, etiquetas) {
  return (l.etiquetas || []).map((tid) => etiquetas.find((t) => t.id === tid)).filter(Boolean).map((t) => chipEtiqueta(t)).join('');
}

function cartaoLead(l, etiquetas) {
  const ultima = l.ultimaMensagem ? `${l.ultimaMensagem.papel === 'visitante' ? '' : l.ultimaMensagem.papel === 'equipe' ? 'Equipe: ' : 'IA: '}${l.ultimaMensagem.texto}` : '';
  return `
    <a class="cartao-lead" href="#/leads/${esc(l.id)}" draggable="true" data-lead="${esc(l.id)}">
      <span class="cartao-topo"><span class="cartao-quem">${avatarLead(l, 'mini')}<strong>${esc(nomeDoLead(l))}</strong> ${seloTemperatura(l.temperatura, true)}</span>${l.precisaHumano ? '<span class="etiqueta off">chamou a equipe</span>' : ''}</span>
      ${l.etiquetas?.length || l.local?.texto ? `<span class="chips">${chipLocal(l, '', etiquetas)}${chipsDoLead(l, etiquetas)}</span>` : ''}
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
                <td class="esconde-mobile"><span class="chips">${chipLocal(l, '', etiquetas)}${chipsDoLead(l, etiquetas) || (l.local?.texto && !localJaEtiqueta(l, etiquetas) ? '' : '<span class="rotulo">—</span>')}</span></td>
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
      if (await confirmar({ titulo: `Apagar ${n} lead${n === 1 ? '' : 's'}?`, texto: 'Os leads e as conversas somem <b>para sempre</b> (mensagens, fotos, áudios, agendamentos). Não dá para desfazer. Se algum desses números escrever de novo, começa do zero.', botao: 'Apagar de vez', perigo: true })) lote({ apagar: true }, 'Leads apagados.');
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
    <div class="cabecalho"><div class="lead-quem">${l.fotoUrl ? `<a href="${esc(l.fotoUrl)}" target="_blank" rel="noopener" title="Ver a foto">${avatarLead(l, 'grande')}</a>` : avatarLead(l, 'grande')}<div><h1>${esc(nomeDoLead(l))}</h1><p class="sub">${esc(l.etapa)}${l.local?.texto && !localJaEtiqueta(l, l.etiquetasEmpresa) ? ` · <span title="Localização: ${esc(l.local.origem || '')}">📍 ${esc(l.local.texto)}</span>` : ''} · desde ${data(l.criadoEm)}${l.noWhatsapp ? ` · <button type="button" class="link-botao" id="atualizar-foto" title="Buscar a foto de perfil do WhatsApp de novo">🔄 ${l.fotoUrl ? 'atualizar foto' : 'buscar foto'}</button>` : ''}</p></div></div><div class="barra"><button type="button" id="registrar-venda">💰 Registrar venda</button><button type="button" id="marcar-agendamento">📅 Agendamento</button>${l.podeReceber ? `<a class="botao primario" href="${rotaEmpresa(l.empresaId, 'conversas')}?lead=${esc(l.id)}">💬 Abrir conversa</a>` : ''}<a class="botao" href="${rotaEmpresa(l.empresaId, 'leads')}">← Leads</a></div></div>
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
            <div class="chips escolher-etiquetas">${l.etiquetasEmpresa.map((t) => `<button type="button" class="chip-filtro ${etiquetasLead.has(t.id) ? 'ativo' : ''}" data-tag="${esc(t.id)}" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}</button>`).join('') || `<a class="rotulo" href="${rotaEmpresa(l.empresaId, 'organizar')}">Criar etiquetas</a>`}</div>
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
    if (!(await confirmar({ titulo: 'Apagar este lead?', texto: 'O lead e a conversa somem <b>para sempre</b> (mensagens, fotos, áudios, agendamentos). Não dá para desfazer. Se o número escrever de novo, começa do zero.', botao: 'Apagar de vez', perigo: true }))) return;
    try {
      await api(`leads/${leadId}`, { method: 'DELETE', body: {} });
      aviso('Lead apagado.');
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

// Aba Disparos em massa: menu do lado esquerdo (seções) e abas em cima (dentro de cada seção)
const MENU_DISPAROS = [
  ['lista', '📊', 'Meus disparos', ''],
  ['campanhas', '🎯', 'Campanhas', 'campanhas'],
  ['novo', '🚀', 'Novo disparo', 'novo'],
  ['mensagens', '💬', 'Mensagens e ranking', 'mensagens'],
  ['listas', '📋', 'Listas de contatos', 'listas'],
  ['seguranca', '🛡️', 'Segurança', 'seguranca'],
  ['cobranca', '💰', 'Cobranças', 'cobranca']
];
function cascaDisparos(id, ativo, html, abas = null) {
  const menu = MENU_DISPAROS.map(([k, ic, nome, rota]) => `<a class="disp-item ${k === ativo ? 'ativo' : ''}" href="${rotaEmpresa(id, rota ? `disparos/${rota}` : 'disparos')}"><span class="disp-ic">${ic}</span><span>${nome}</span></a>`).join('');
  const topo = abas ? `<nav class="disp-abas">${abas.map(([href, nome, on]) => `<a class="disp-aba ${on ? 'ativo' : ''}" href="${href}">${nome}</a>`).join('')}</nav>` : '';
  return `<div class="disp-casca"><nav class="disp-menu" aria-label="Disparos em massa">${menu}</nav><div class="disp-corpo">${topo}${html}</div></div>`;
}

// 🔢 ordem de envio da lista (o servidor ordena igual)
const ORDENS_ENVIO = [['arquivo', '📄 Na ordem do arquivo'], ['menos-aval', '💬 Menos avaliações primeiro (nenhuma antes)'], ['mais-aval', '💬 Mais avaliações primeiro'], ['nota-baixa', '⭐ Menor nota primeiro (sem nota antes)'], ['nota-alta', '⭐ Maior nota primeiro'], ['prioridade-site', '🎯 Prioridade para vender site (sem site e mais movimento antes)'], ['cidade', '📍 Por cidade (A-Z)'], ['nome', '🔤 Por nome (A-Z)']];

// 🔁 follow-up da campanha (quem não respondeu): a 1ª e as que tiverem texto
function passosFupDoForm(f) {
  return [1, 2, 3].map((i) => {
    const sufixo = i === 1 ? '' : String(i);
    return { dias: Number(f[`lembrete${sufixo}Dias`]) || 3, mensagem: String(f[`lembrete${sufixo}Mensagem`] || '').trim() };
  }).filter((p, i) => i === 0 || p.mensagem);
}

// <input type="datetime-local"> usa a hora local sem fuso: "2026-10-29T09:00"
function paraDatetimeLocal(dt) {
  const z = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${z(dt.getMonth() + 1)}-${z(dt.getDate())}T${z(dt.getHours())}:${z(dt.getMinutes())}`;
}
function sugestaoDeHorario(horarioComercial = true) {
  const t = new Date(Date.now() + 3600000);
  t.setMinutes(0, 0, 0);
  if (horarioComercial && (t.getHours() >= 20 || t.getHours() < 8)) {
    if (t.getHours() >= 20) t.setDate(t.getDate() + 1);
    t.setHours(8);
  }
  return t;
}
// "hoje 14:30 · em 12 min" / "amanhã 08:00" / "30/10 08:00"
function quandoEnvio(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  const hora = t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hoje = new Date();
  const amanha = new Date(Date.now() + 864e5);
  const dia = t.toDateString() === hoje.toDateString() ? 'hoje' : t.toDateString() === amanha.toDateString() ? 'amanhã' : t.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const min = Math.round((t - Date.now()) / 60000);
  const falta = min <= 0 ? 'agora' : min < 60 ? `em ${min} min` : min < 24 * 60 ? `em ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : '';
  return `${dia} ${hora}${falta ? ` <span class="rotulo">· ${falta}</span>` : ''}`;
}
// ⏭️ tabela da fila (previsão): próximos contatos e a hora que deve sair cada um
function tabelaFila(itens, { comDisparo = false, id } = {}) {
  return `<div class="tabela-wrap"><table class="fila-envios"><thead><tr><th>#</th><th>Previsto</th><th>Contato</th>${comDisparo ? '<th class="esconde-mobile">Disparo</th>' : ''}</tr></thead><tbody>${itens.map((x, i) => `<tr><td class="rotulo">${i + 1}</td><td style="white-space:nowrap">${x.em ? quandoEnvio(x.em) : '<span class="etiqueta">⏸ pausado</span>'}</td><td><a href="#/leads/${esc(x.leadId)}">${esc(x.nome || 'Lead')}</a>${x.versao ? ` <span class="etiqueta">versão ${esc(x.versao)}</span>` : ''}${comDisparo ? `<span class="so-mobile rotulo"><br>${esc(x.disparo)}</span>` : ''}</td>${comDisparo ? `<td class="esconde-mobile"><a href="${rotaEmpresa(id, `disparos/${x.disparoId}`)}">${esc(x.disparo)}</a></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

// 🕐 mudar a hora do 1º envio de um disparo já criado (ou de quando continua)
function modalHoraDisparo(id, d, depois) {
  const atual = d.status === 'agendado' && d.agendadoPara ? new Date(d.agendadoPara) : sugestaoDeHorario(d.horarioComercial);
  const fechar = abrirModal(`
    <h2>🕐 Quando começa</h2>
    <div class="texto-modal"><p>Escolha a data e a hora do ${d.enviado ? 'próximo envio' : '1º envio'}. Os outros saem em seguida, com o intervalo do disparo${d.horarioComercial ? ', só das 8h às 20h' : ''}.</p>
      <div class="campo"><label>Data e hora</label><input type="datetime-local" id="nova-hora" value="${paraDatetimeLocal(atual)}" min="${paraDatetimeLocal(new Date())}"></div>
      <p class="erro-caixa" id="erro-hora" hidden></p></div>
    <div class="acoes"><button type="button" class="primario" id="salvar-hora">🕐 Agendar</button><button type="button" id="agora-hora">▶ Começar agora</button><button type="button" data-fechar>Voltar</button></div>`, (m) => {
    const enviar = async (botao, valor) => {
      const err = $('#erro-hora', m);
      err.hidden = true;
      let iso = null;
      if (valor !== null) {
        const t = new Date(valor);
        if (!valor || Number.isNaN(t.getTime())) { err.textContent = 'Escolha a data e a hora.'; err.hidden = false; return; }
        if (t.getTime() < Date.now() - 60000) { err.textContent = 'Esse horário já passou. Escolha um daqui para frente.'; err.hidden = false; return; }
        iso = t.toISOString();
      }
      try {
        await comEspera(botao, () => api(`empresas/${id}/disparos/${d.id}/agendamento`, { method: 'PUT', body: { agendadoPara: iso } }));
        fechar();
        aviso(iso ? `Agendado para ${new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Começou!');
        depois();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    $('#salvar-hora', m).onclick = (e) => enviar(e.currentTarget, $('#nova-hora', m).value);
    $('#agora-hora', m).onclick = (e) => enviar(e.currentTarget, null);
  });
}

async function paginaDisparos(id, params = new URLSearchParams()) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const todos = await api(`empresas/${id}/disparos`);
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  // 🗂️ cada situação no seu bloco (testes ficam à parte, para não misturar)
  const GRUPOS = [
    ['enviando', '▶️ Enviando agora', (d) => !d.teste && d.status === 'enviando'],
    ['agendados', '🕐 Agendados', (d) => !d.teste && d.status === 'agendado'],
    ['pausados', '⏸️ Pausados', (d) => !d.teste && d.status === 'pausado'],
    ['concluidos', '✅ Terminados', (d) => !d.teste && ['concluido', 'cancelado'].includes(d.status)],
    ['testes', '🧪 Testes', (d) => d.teste]
  ];
  const aba = GRUPOS.some(([k]) => k === params.get('aba')) ? params.get('aba') : 'todos';
  const conta = (k) => todos.filter(GRUPOS.find((g) => g[0] === k)[2]).length;
  const abas = [['todos', 'Todos', todos.filter((d) => !d.teste).length], ...GRUPOS.map(([k, nome]) => [k, nome, conta(k)])]
    .filter(([k, , n]) => k === 'todos' || n || k === aba)
    .map(([k, nome, n]) => [`${rotaEmpresa(id, 'disparos')}${k === 'todos' ? '' : `?aba=${k}`}`, `${nome} <span class="rotulo">${n}</span>`, k === aba]);
  // ⏭️ fila de todos os disparos ativos juntos (os pausados não entram: só saem quando continuar)
  const fila = todos.filter((d) => ['enviando', 'agendado'].includes(d.status)).flatMap((d) => (d.proximos || []).filter((x) => x.em).map((x) => ({ ...x, disparo: d.nome, disparoId: d.id }))).sort((a, b) => (a.em < b.em ? -1 : 1)).slice(0, 10);
  const situacao = (d) => {
    if (d.status === 'agendado') return `🕐 Começa ${quandoEnvio(d.agendadoPara)}`;
    if (d.status === 'pausado') return `⏸️ ${esc(d.motivoPausa || 'Pausado')}`;
    if (d.status === 'enviando') return d.aguardandoAmanha ? '🌙 Bateu o limite de hoje — continua amanhã' : d.aguardandoHorario ? '🌙 Fora do horário — continua às 8h' : d.proximos?.[0]?.em ? `⏭️ Próximo envio: ${quandoEnvio(d.proximos[0].em)}` : '▶️ Enviando…';
    if (d.status === 'cancelado') return `Cancelado ${d.concluidoEm ? `em ${esc(dataCurta(d.concluidoEm))}` : ''}`;
    return `Terminou ${d.concluidoEm ? `em ${esc(dataCurta(d.concluidoEm))}` : ''}`;
  };
  const cartao = (d) => {
    const pct = d.total ? Math.round(((d.enviado + d.erro + d.ignorado) / d.total) * 100) : 0;
    const taxa = d.enviado ? Math.round((d.responderam / d.enviado) * 100) : 0;
    return `
    <article class="disp-card st-${esc(d.status)}" data-disparo="${esc(d.id)}">
      <header><div class="disp-card-nome"><b>${esc(d.nome)}</b><span class="rotulo">${d.campanhaNome ? `🎯 ${esc(d.campanhaNome)} · ` : ''}${d.prospeccao ? '🛡️ prospecção · ' : ''}criado ${esc(dataCurta(d.criadoEm))}</span></div>${statusDisparo(d)}</header>
      <div class="disp-card-numeros">
        <span><b>${d.enviado}</b> de ${d.total} enviados</span>
        <span><b>${d.responderam}</b> responderam${d.enviado ? ` <small>(${taxa}%)</small>` : ''}</span>
        ${d.erro + d.ignorado ? `<span><b>${d.erro + d.ignorado}</b> com erro / de fora</span>` : ''}
        ${d.prospeccao && ['enviando', 'pausado'].includes(d.status) ? `<span>hoje <b>${d.hoje}/${d.limiteHoje}</b></span>` : ''}
      </div>
      <div class="progresso"><span style="width:${pct}%"></span></div>
      <p class="disp-card-situacao">${situacao(d)}</p>
      <div class="disp-card-acoes">
        ${d.status === 'enviando' || d.status === 'agendado' ? `<button type="button" data-acao-disp="pausar" data-id="${esc(d.id)}">⏸️ Pausar</button>` : ''}
        ${d.status === 'pausado' ? `<button type="button" class="primario" data-acao-disp="retomar" data-id="${esc(d.id)}">▶️ Continuar</button>` : ''}
        ${['enviando', 'agendado', 'pausado'].includes(d.status) && d.pendente ? `<button type="button" data-hora-disp="${esc(d.id)}">🕐 Horário</button>` : ''}
        <a class="botao" href="${rotaEmpresa(id, `disparos/${d.id}`)}">👁️ Detalhes</a>
        <button type="button" class="perigo" data-apagar-disp="${esc(d.id)}" title="Excluir disparo">🗑️ Excluir</button>
      </div>
    </article>`;
  };
  const blocos = (aba === 'todos' ? GRUPOS.filter(([k]) => k !== 'testes') : GRUPOS.filter(([k]) => k === aba))
    .map(([k, nome, f]) => [k, nome, todos.filter(f)])
    .filter(([, , l]) => l.length);
  const nTestes = conta('testes');
  conteudo.innerHTML = cascaDisparos(id, 'lista', `
    <div class="cabecalho"><div><h1>Meus disparos</h1><p class="sub">Cada disparo no seu bloco: enviando, agendados, pausados e terminados. Pause, continue ou exclua por aqui.</p></div>${emp.whatsapp?.configurado ? `<a class="botao primario" href="${rotaEmpresa(id, 'disparos/novo')}">+ Novo disparo</a>` : ''}</div>
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `Os disparos saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    ${fila.length && ['todos', 'enviando', 'agendados'].includes(aba) ? `<details class="card fila-geral" ${sessionStorage.getItem('fila-fechada') === '1' ? '' : 'open'}><summary><b>⏭️ Próximos ${fila.length} envios</b> <span class="rotulo">(previsão · atualiza sozinho)</span></summary>${tabelaFila(fila, { comDisparo: true, id })}<p class="rotulo" style="margin:8px 0 0">O horário é uma previsão: o intervalo entre mensagens é sorteado e quem não tem WhatsApp sai da fila.</p></details>` : ''}
    ${blocos.length ? blocos.map(([k, nome, l]) => `<section class="disp-bloco"><h2>${nome} <span class="rotulo">${l.length}</span></h2><div class="disp-grade">${l.map(cartao).join('')}</div></section>`).join('') : `<div class="card vazio">${todos.length ? 'Nenhum disparo aqui.' : 'Nenhum disparo ainda. Clique em "+ Novo disparo".'}</div>`}
    ${aba === 'todos' && nTestes ? `<p class="rotulo"><a href="${rotaEmpresa(id, 'disparos?aba=testes')}">🧪 Ver ${nTestes} ${nTestes === 1 ? 'disparo de teste' : 'disparos de teste'}</a></p>` : ''}`, abas);
  const recarregar = () => paginaDisparos(id, params);
  $('.fila-geral')?.addEventListener('toggle', (e) => { try { sessionStorage.setItem('fila-fechada', e.target.open ? '0' : '1'); } catch { /* sem sessionStorage */ } });
  $$('[data-acao-disp]').forEach((b) => {
    b.onclick = async () => {
      try {
        await comEspera(b, () => api(`empresas/${id}/disparos/${b.dataset.id}/${b.dataset.acaoDisp}`, { method: 'POST' }));
        aviso(b.dataset.acaoDisp === 'pausar' ? 'Disparo pausado. Ninguém mais recebe até você clicar em Continuar.' : 'Disparo continuando.');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-hora-disp]').forEach((b) => { b.onclick = () => modalHoraDisparo(id, todos.find((d) => d.id === b.dataset.horaDisp), recarregar); });
  $$('[data-apagar-disp]').forEach((b) => {
    b.onclick = async () => {
      const d = todos.find((x) => x.id === b.dataset.apagarDisp);
      const ativo = ['enviando', 'agendado', 'pausado'].includes(d.status);
      if (!(await confirmar({ titulo: `Excluir "${d.nome}"?`, texto: `${ativo ? `<p><b>Ele para agora</b>: ${d.pendente} ${d.pendente === 1 ? 'contato que ainda não recebeu não vai receber' : 'contatos que ainda não receberam não vão receber'}.</p>` : ''}<p>As mensagens que já saíram continuam nas conversas, e quem já recebeu continua fora dos próximos disparos de prospecção (o CRM nunca repete). A campanha não é apagada.</p>`, botao: 'Excluir disparo', perigo: true }))) return;
      try {
        await api(`empresas/${id}/disparos/${d.id}`, { method: 'DELETE' });
        aviso('Disparo excluído.');
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
  });
  // clicar no cartão (fora dos botões) abre os detalhes
  $$('.disp-card').forEach((c) => { c.onclick = (e) => { if (!e.target.closest('button, a')) location.hash = rotaEmpresa(id, `disparos/${c.dataset.disparo}`); }; });
  clearInterval(atualizador); // a página se redesenha sozinha: um relógio só (antes somava um a cada volta)
  if (todos.some((d) => ['enviando', 'agendado'].includes(d.status))) {
    const aqui = location.hash;
    // não redesenha com uma janela aberta (confirmar excluir, mudar horário)
    atualizador = setInterval(() => { if (location.hash === aqui && !document.querySelector('.fundo-modal')) recarregar().catch(() => {}); }, 8000);
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

// ➕ Novo disparo sem tipo escolhido: primeiro a pergunta (contatos novos ou clientes)
async function paginaEscolherDisparo(id, campanha = false) {
  const emp = await definirEmpresaAtual(id);
  const rota = (q) => `${rotaEmpresa(id, campanha ? 'disparos/campanhas/nova' : 'disparos/novo')}?${q}`;
  conteudo.innerHTML = cascaDisparos(id, campanha ? 'campanhas' : 'novo', `
    <div class="cabecalho"><div><h1>${campanha ? '🎯 Nova campanha' : '➕ Novo disparo'}</h1><p class="sub">${campanha ? 'A campanha é para quem?' : 'Para quem você vai mandar?'}</p></div></div>
    ${campanha ? '' : `<a class="card escolha-campanha" href="${rotaEmpresa(id, 'disparos/campanhas')}">🎯 <b>Usar uma campanha pronta</b> <span class="rotulo">— mensagens, lembrete e roteiro já configurados; aí é só escolher a lista</span></a>`}
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `Os disparos saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    <div class="escolha-disparo">
      <a class="card escolha-tipo" href="${rota('modo=prospeccao')}"><span class="escolha-ic">🛡️</span><b>Contatos novos (prospecção)</b><span class="rotulo">Gente que ainda não conhece a empresa: uma lista importada (ex.: Google Maps). Sai devagar, com limite por dia, para proteger o número.</span><span class="botao primario">Escolher</span></a>
      <a class="card escolha-tipo" href="${rota('modo=clientes')}"><span class="escolha-ic">📣</span><b>Meus clientes e leads</b><span class="rotulo">Quem já conversou com você: promoção, aviso, reativar quem sumiu. Filtra por etapa, etiqueta ou origem.</span><span class="botao">Escolher</span></a>
    </div>
    <p class="rotulo" style="margin-top:12px">Mensalidade e cobrança ficam em <a href="${rotaEmpresa(id, 'disparos/cobranca')}">💰 Cobranças</a>. As mensagens que mais fazem o cliente responder ficam em <a href="${rotaEmpresa(id, 'disparos/mensagens')}">💬 Mensagens e ranking</a>.</p>`);
}

async function paginaNovoDisparo(id, params = new URLSearchParams()) {
  const hashDaPagina = location.hash;
  let temEscolhidos = false;
  try { temEscolhidos = Boolean(JSON.parse(sessionStorage.getItem('disparo_leads') || '[]').length); } catch { temEscolhidos = false; }
  // 🎯 editarCampanha ('nova' ou o id): a mesma tela, mas configura e SALVA a campanha (sem lista).
  // campanha (id): dispara uma campanha pronta — vem tudo preenchido, falta a lista.
  const editarCampanha = params.get('editarCampanha') || '';
  const modoCampanha = Boolean(editarCampanha);
  const campanhaPedida = editarCampanha && editarCampanha !== 'nova' ? editarCampanha : params.get('campanha') || '';
  if (editarCampanha === 'nova' && !params.get('modo')) return paginaEscolherDisparo(id, true);
  // 🚀 disparo SEMPRE a partir de uma campanha: sem campanha escolhida, primeiro escolhe (ou cria)
  if (!modoCampanha && !campanhaPedida) return paginaEscolherCampanhaParaDisparo(id, params, temEscolhidos);
  const campanha = campanhaPedida ? await api(`empresas/${id}/disparos-campanhas/${encodeURIComponent(campanhaPedida)}`).catch(() => null) : null;
  if (campanhaPedida && !campanha) { aviso('Campanha não encontrada.', true); location.hash = rotaEmpresa(id, 'disparos/campanhas'); return; }
  const emp = await definirEmpresaAtual(id);
  const [lista, albuns, ld, salvas] = await Promise.all([api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`), api(`empresas/${id}/disparos-listas`).catch(() => ({ listas: [], seguranca: {} })), api(`empresas/${id}/disparos-mensagens`).then((r) => (r.mensagens || []).filter((m) => !m.antiga)).catch(() => [])]);
  // 🛡️ prospecção: contatos que ainda não conhecem a empresa (lista importada)
  const listaPedida = params.get('lista') || '';
  const prospeccao = campanha ? campanha.tipo !== 'clientes' : params.get('modo') === 'prospeccao' || Boolean(listaPedida);
  const seg = ld.seguranca || {};
  const listas = ld.listas || [];
  // ritmos prontos: prospecção usa os da aba Segurança; disparo comum (quem já conhece a empresa) é mais rápido
  const perfisEnvio = prospeccao
    ? [['novo', '🐣 Número novo', 'Chip novo ou parado há tempo (até 30 dias de uso)'], ['recomendado', '🛡️ Recomendado', 'Equilíbrio entre segurança e velocidade'], ['aquecido', '🔥 Número aquecido', 'Número com mais de 3 meses de conversas normais']].map(([pid, nome, texto]) => ({ id: pid, nome, texto, ...(ld.perfis?.[pid] || seg) }))
    : [['seguro', '🛡️ Bem seguro', 'Lista grande ou número com pouco uso', 60, 150], ['recomendado', '✅ Recomendado', 'Clientes e leads que já falaram com você', 30, 75], ['rapido', '⚡ Rápido', 'Só para poucos contatos que conversam com você sempre', 15, 35]].map(([pid, nome, texto, mi, ma]) => ({ id: pid, nome, texto, intervaloMin: mi, intervaloMax: ma }));
  const perfilInicial = prospeccao ? seg.perfil || 'recomendado' : 'recomendado';
  const valoresIniciais = perfisEnvio.find((pf) => pf.id === perfilInicial) || (prospeccao ? seg : perfisEnvio[1]);
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
  // editar campanha: os 5 passos; disparar campanha: só quem recebe e revisar (o resto vem da campanha)
  const ORDEM = modoCampanha ? [1, 2, 3, 4, 5] : [1, 5];
  const NOMES_PASSO = modoCampanha ? { 1: 'Nome', 2: 'Mensagem', 3: 'Quando responderem', 4: 'Ritmo e horário', 5: 'Salvar' } : { 1: 'Quem recebe', 5: 'Nome, quando e enviar' };
  const numPasso = (n) => ORDEM.indexOf(n) + 1;
  const tipoTexto = prospeccao ? 'contatos novos (prospecção)' : 'meus clientes e leads';
  const filtrosComuns = `
          <div class="campo"><label>Etapas ${ajuda('Nenhuma marcada = todas as etapas.')}</label><div class="chips">${emp.etapas.map((e) => `<label class="chip-check"><input type="checkbox" name="etapa" value="${esc(e)}"><span>${esc(e)}</span></label>`).join('')}</div></div>
          <div class="campo" style="margin-top:12px"><label>Etiquetas ${ajuda('Recebe quem tiver pelo menos uma das etiquetas marcadas. Nenhuma marcada = qualquer etiqueta.')}</label><div class="chips">${emp.etiquetas.map((t) => `<label class="chip-check" style="--cor:${esc(t.cor)}"><input type="checkbox" name="etiqueta" value="${esc(t.id)}"><span><span class="bolinha-cor"></span>${esc(t.nome)}</span></label>`).join('') || '<span class="rotulo">Nenhuma etiqueta criada.</span>'}</div></div>
          <div class="campo" style="margin-top:12px"><label>De onde veio</label><select name="origem"><option value="todos">Todos</option><option value="site">Site</option><option value="whatsapp">WhatsApp</option><option value="manual">Cadastrados / importados</option></select></div>`;
  const campoLista = `<div class="campo"><label>${prospeccao ? 'Qual lista de contatos?' : 'Lista de contatos'} ${ajuda('Listas importadas em 📋 Listas de contatos (aqui na aba Disparos).')}</label><select name="listaId"><option value="">${prospeccao ? '— escolha uma lista —' : '— qualquer —'}</option>${listas.map((l) => `<option value="${esc(l.id)}" ${l.id === listaPedida ? 'selected' : ''}>${esc(l.nome)} (${l.contatos} contatos)</option>`).join('')}</select>${prospeccao && !listas.length ? `<small>Nenhuma lista ainda. <a href="${rotaEmpresa(id, 'disparos/listas?aba=importar')}">Importar uma lista</a></small>` : ''}</div>
    <div class="categorias-lista" id="categorias-lista" hidden><span class="rotulo">🗂️ Mandar só para:</span><input type="hidden" name="siteCat" value="${esc(['nenhum', 'social', 'semproprio', 'proprio'].includes(params.get('site')) ? params.get('site') : '')}"><div class="chips" id="chips-categoria"></div>
      <label class="linha-check"><input type="checkbox" name="soCelular" ${params.get('cel') === '1' ? 'checked' : ''}> 📱 Só celular (tira os telefones fixos)</label>
      <div class="campo" style="margin-top:6px"><label>🔢 Quem recebe primeiro ${ajuda('A ordem em que a lista sai. Na prospecção, com limite por dia, os primeiros são os que recebem nos primeiros dias.')}</label><select name="ordem">${ORDENS_ENVIO.map(([v, t]) => `<option value="${v}" ${(params.get('ordem') || 'arquivo') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="rotulo" id="primeiros-fila"></div></div>`;
  conteudo.innerHTML = cascaDisparos(id, modoCampanha || campanha ? 'campanhas' : 'novo', `
    ${modoCampanha
      ? `<div class="cabecalho"><div><a class="rotulo" href="${rotaEmpresa(id, 'disparos/campanhas')}">← Campanhas</a><h1>🎯 ${campanha ? 'Editar campanha' : 'Nova campanha'}</h1><p class="sub">Para ${tipoTexto}. Configure tudo agora; <b>a lista você escolhe na hora de disparar</b>. Nada é enviado aqui.</p></div></div>`
      : campanha
        ? `<div class="cabecalho"><div><a class="rotulo" href="${rotaEmpresa(id, 'disparos/campanhas')}">← Campanhas</a><h1>🚀 Disparar: ${esc(campanha.nome)}</h1><p class="sub">Escolha quem recebe, dê um nome e confira. Mensagens, lembrete, roteiro e ritmo vêm da campanha (para mudar, use ✏️ Editar campanha). <b>Nada é enviado até você clicar em enviar.</b></p></div></div>`
        : `<div class="cabecalho"><div><h1>${prospeccao ? '🛡️ Disparo para contatos novos' : '📣 Disparo para meus clientes'}</h1><p class="sub">${prospeccao ? 'Para quem ainda não conhece a empresa: sai devagar, com limite por dia, para proteger o seu número' : 'Para leads e clientes que já conversaram com você'}. <b>Nada é enviado até o passo 5.</b></p></div></div>`}
    ${campanha && !modoCampanha ? `<div class="card resumo-campanha"><div><span class="rotulo">Campanha</span><br><b>🎯 ${esc(campanha.nome)}</b> <span class="rotulo">· ${campanha.tipo === 'clientes' ? 'meus clientes' : 'contatos novos'} · ${campanha.mensagens.length} ${campanha.mensagens.length === 1 ? 'mensagem' : 'versões revezando'} · ${campanha.roteiro ? 'prompt próprio' : 'usa o prompt principal'} · ${campanha.lembrete?.ativo ? `lembrete em ${campanha.lembrete.dias} d` : 'sem lembrete'} · ${campanha.iaLigada === false ? '<b>⛔ IA desligada</b>' : '🤖 IA ligada'}</span></div><div class="acoes"><a class="botao pequeno" href="${rotaEmpresa(id, `disparos/campanhas/${encodeURIComponent(campanha.id)}`)}">✏️ Editar campanha</a><a class="botao pequeno" href="${rotaEmpresa(id, 'disparos/novo')}${listaPedida ? `?lista=${encodeURIComponent(listaPedida)}` : ''}">Trocar</a></div></div>` : ''}
    <ol class="disp-passos" id="disp-passos">${ORDEM.map((n) => `<li><button type="button" data-ir-passo="${n}"><span class="passo-num">${numPasso(n)}</span><span>${NOMES_PASSO[n]}</span></button></li>`).join('')}</ol>
    <form id="f-disparo" class="editor">
      <div>
        <div class="card" data-passo="1">
          ${modoCampanha ? `<h2><span class="passo-num">1</span> Nome da campanha</h2>
          <div class="campo"><label>Nome *</label><input name="campanhaNome" maxlength="80" value="${esc(campanha?.nome || '')}" placeholder="Ex.: Guinchos sem site — oferta de site"></div>
          <p class="rotulo">Tipo: <b>${tipoTexto}</b>. Depois de salvar, é só clicar em <b>🚀 Disparar</b> na campanha e escolher a lista.</p>
          <div hidden>` : ''}
          <h2 ${modoCampanha ? 'hidden' : ''}><span class="passo-num">1</span> Quem vai receber esta campanha?</h2>
          ${leadIds.length ? `${balao(`${leadIds.length} contatos escolhidos na lista`, `<a href="${rotaEmpresa(id, `disparos/novo?campanha=${encodeURIComponent(campanhaPedida)}`)}" id="limpar-escolha">Usar filtros em vez disso</a>`, 'ok')}` : prospeccao ? `${campoLista}<details style="margin-top:12px"><summary>Mais filtros (etapa, etiqueta, origem)</summary><div style="margin-top:10px">${filtrosComuns}</div></details>` : `${filtrosComuns}<details style="margin-top:12px"><summary>Só de uma lista de contatos importada</summary><div style="margin-top:10px">${campoLista}</div></details>`}
          <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="pularJaDisparados" checked ${prospeccao ? 'disabled' : ''}> Não mandar para quem já recebeu disparo em massa ${prospeccao ? '<span class="rotulo">(sempre ligado na prospecção)</span>' : ajuda('Quem já recebeu qualquer disparo antes fica de fora deste — vale também para contatos que aparecem de novo em outra lista. Desmarcado, o CRM só avisa quantos já receberam.')}</label>
          <div class="contagem" id="contagem">Calculando…</div>
          ${modoCampanha ? '</div>' : ''}
          <div class="disp-nav"><span></span><button type="button" class="primario" data-proximo>Continuar →</button></div>
        </div>
        <div class="card" data-passo="2">
          <h2><span class="passo-num">2</span> O que vai ser enviado?</h2>
          <div class="campo">
            <label>Mensagem * ${ajuda('Cadastre até 10 versões: o CRM reveza entre os contatos (1º recebe a A, 2º a B…) e mostra em 💬 Mensagens e ranking qual faz mais gente responder.')}</label>
            <div class="versoes-msg" id="versoes-msg"></div>
            ${salvas.length ? `<select id="usar-salva" class="pequeno-select"><option value="">📚 Usar uma das minhas mensagens…</option>${salvas.slice().sort((a, b) => taxaMsg(b) - taxaMsg(a)).map((m) => `<option value="${esc(m.id)}">${m.enviados ? `${taxaMsg(m)}% responderam · ` : ''}${esc(m.nome || m.texto.replace(/\s+/g, ' ').slice(0, 70))}${m.campanhas?.length ? ` · em ${m.campanhas.length} ${m.campanhas.length === 1 ? 'campanha' : 'campanhas'}` : ''}</option>`).join('')}</select>` : ''}
            <p class="rotulo" style="margin:6px 0 6px">Sai exatamente o que você escrever (o disparo não usa IA). Toque para colocar no texto:</p>
            <div class="botoes-variavel"><button type="button" class="pequeno" data-inserir="{Oi|Olá|E aí}" title="Cada pessoa recebe uma das opções">👋 Saudação variada</button><button type="button" class="pequeno" data-inserir="{nome}" title="Nome do contato (na lista do PDF, é o nome da empresa dele)">👤 Nome do contato</button>${prospeccao ? '<button type="button" class="pequeno" data-inserir="{empresa_contato}" title="Nome da empresa do contato (da lista importada)">🏢 Empresa do contato</button><button type="button" class="pequeno" data-inserir="{cidade}">📍 Cidade</button>' : ''}<button type="button" class="pequeno" data-inserir="{empresa}" title="O nome da SUA empresa">🏷️ Nome da minha empresa</button></div>
            <textarea name="mensagem" required style="min-height:140px" placeholder="${prospeccao ? '{Oi|Olá|Boa tarde}! Vi que a {empresa_contato} ainda não tem site. Posso te mostrar uma ideia rápida?' : '{Oi|Olá} {nome}! Tudo bem? Esta semana temos 20% de desconto. Quer que eu te mande os detalhes?'}"></textarea>
            <small>O nome de uma empresa só aparece se você colocar <code>{empresa}</code> (a sua) ou <code>{empresa_contato}</code> (a do contato).</small>
            ${prospeccao ? '<p class="rotulo aviso-texto" id="aviso-prospeccao" style="margin:6px 0 0">Para quem não conhece você, a 1ª mensagem deve ser <b>curta e sem link</b> e terminar com uma pergunta (ex.: "posso te mandar os detalhes?"). É a que menos vira denúncia.</p>' : ''}
          </div>
          <details style="margin-top:12px"><summary>📎 Fotos, vídeos e arquivos (opcional)</summary><div class="campo" style="margin-top:8px"><label>Até 5 ${ajuda('A primeira foto/vídeo/PDF leva a mensagem como legenda; as outras vão logo depois. Álbum manda as fotos dele.')}</label>
            <div class="midias-fup" id="disp-midias"></div>
            <div class="linha-form" style="margin-top:6px;flex-wrap:wrap">
              <select id="disp-add-midia"><option value="">+ Escolher da biblioteca…</option>${albuns.filter((a) => a.quantidade).length ? `<optgroup label="Álbuns">${albuns.filter((a) => a.quantidade).map((a) => `<option value="${esc(a.id)}">🗂️ ${esc(a.nome)} (${a.quantidade})</option>`).join('')}</optgroup>` : ''}<optgroup label="Mídias">${lista.filter((m) => !m.pastaId).map((m) => `<option value="${esc(m.id)}">${ICONE_TIPO[m.tipo] || '📎'} ${esc(m.nome)}</option>`).join('')}</optgroup></select>
              <label class="botao pequeno">📤 Enviar arquivo novo<input type="file" id="disp-novo" multiple hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label>
            </div>
            <div id="disp-envio" class="rotulo"></div>
            <div id="disp-perso" class="caixa-perso" hidden>
              <label class="linha-check"><input type="checkbox" name="persoAtivo"> ✍️ Escrever o nome do contato na 1ª foto ${ajuda('Cada pessoa recebe a foto com uma faixa e o nome da empresa dela (ex.: "Feito para Guincho Martins"). A faixa entra embaixo (ou em cima) da foto, sem cobrir nada.')}</label>
              <div id="disp-perso-campos" hidden>
                <div class="campos" style="margin-top:8px">
                  <div class="campo"><label>Texto da faixa ${ajuda('{empresa_contato} = nome da empresa do contato (da lista). {nome} = nome do contato. {cidade} = cidade dele. Nome muito comprido é cortado.')}</label><input name="persoTexto" value="Feito para {empresa_contato}" maxlength="120"></div>
                  <div class="campo"><label>Onde</label><select name="persoPosicao"><option value="baixo">Embaixo da foto</option><option value="cima">Em cima da foto</option></select></div>
                </div>
                <div class="campos">
                  <div class="campo"><label>Cor da faixa</label><input type="color" name="persoFundo" value="#111827"></div>
                  <div class="campo"><label>Cor da linha</label><input type="color" name="persoDestaque" value="#facc15"></div>
                </div>
                <small>A prévia ao lado mostra como fica para o 1º contato.</small>
              </div>
            </div></div>
            <small>Arquivo novo fica guardado em <a href="${rotaEmpresa(id, 'midias')}">Mídias</a> (em "a configurar": a IA só usa depois que você configurar).</small></details>
          <div class="campos" style="margin-top:12px">
            <div class="campo"><label>📌 Ao enviar, colocar na etapa ${ajuda('Quando o disparo sair para o contato, o lead vai para esta etapa do funil. Quem já está numa etapa mais adiante (ex.: já comprou) não volta.')}</label><select name="envEtapa"><option value="">— não mudar —</option>${emp.etapas.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')}</select></div>
            <div class="campo"><label>e a etiqueta</label><select name="envEtiqueta"><option value="">— nenhuma —</option>${emp.etiquetas.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select></div>
          </div>
          <small class="rotulo">Quando responderem, dá para mover para outra etapa no próximo passo.</small>

          <div class="disp-nav"><button type="button" data-voltar>← Voltar</button><button type="button" class="primario" data-proximo>Continuar →</button></div>
        </div>
        <div class="card" data-passo="3">
          <h2><span class="passo-num">3</span> E quando responderem?</h2>
          ${balao('Prompt próprio da campanha', 'Quem responder a esta campanha é atendido <b>só por este prompt</b>: o prompt principal da empresa, o "Sobre a empresa", o catálogo e o clone <b>não valem</b> nessas conversas. Escreva aqui tudo que a IA precisa: quem você é, o que oferece, preço, passos da conversa e objeções. Deixou vazio: atende pelo prompt principal.', 'dica')}
          ${modoCampanha ? `<label class="linha-check interruptor-ia"><input type="checkbox" name="iaCampanha" ${campanha?.iaLigada === false ? '' : 'checked'}> 🤖 <b>A IA responde quem responder a esta campanha</b> ${ajuda('Desligado: quem responder aos disparos desta campanha fica para a equipe (a IA não responde). Dá para ligar e desligar a qualquer hora, também no cartão da campanha — vale na hora, até para disparos que já estão rodando.')}</label>` : ''}
          <div class="campo"><label>🧠 Prompt da campanha ${ajuda('É o único prompt que a IA segue nas conversas desta campanha. Editou aqui, vale na hora, até para disparos que já estão rodando.')}</label>
            <textarea name="roteiro" maxlength="12000" style="min-height:260px" placeholder="${prospeccao ? 'Ex.: Se pedir o exemplo, mande o vídeo #MIDIA_… do modelo de site. Pergunte se ele já pensou em aparecer no Google. Preço: a partir de R$ … Objetivo: marcar uma ligação rápida de 10 minutos ou mandar a proposta.' : 'Ex.: Se quiser os detalhes da promoção, explique as condições e ofereça um horário. Objetivo: fechar o pedido.'}"></textarea><small class="rotulo" id="roteiro-conta"></small></div>
          <div class="campos" style="margin-top:10px">
            <div class="campo"><label>Mover para a etapa ${ajuda('Quando a pessoa responder a este disparo, o lead vai para esta etapa do funil (uma vez).')}</label><select name="respEtapa"><option value="">— não mudar —</option>${emp.etapas.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')}</select></div>
            <div class="campo"><label>Pôr a etiqueta</label><select name="respEtiqueta"><option value="">— nenhuma —</option>${emp.etiquetas.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select></div>
          </div>
          <div class="caixa-followup">
            <h3>🔁 Follow-up de quem <u>não respondeu</u> ${ajuda('Só para quem não respondeu nada e com quem ninguém falou depois. Para sozinho quando a pessoa responde (aí a IA assume). Respeita o horário comercial e, na prospecção, conta no limite do dia. Editou a campanha? Vale também para os disparos dela que estão rodando.')}</h3>
            <label class="linha-check"><input type="checkbox" name="lembreteAtivo" ${prospeccao ? 'checked' : ''}> Mandar mensagens de follow-up (até 3)</label>
            <div id="campos-lembrete" ${prospeccao ? '' : 'hidden'}>
              <div class="passo-fup"><div class="campo"><label>1ª mensagem · dias depois do disparo</label><select name="lembreteDias">${[1, 2, 3, 4, 5, 7, 10, 14, 21, 30].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} ${n === 1 ? 'dia' : 'dias'}</option>`).join('')}</select></div>
                <div class="campo"><label>Texto ${ajuda('Curta, sem repetir a primeira. Aceita {Oi|Olá}, {nome} e {empresa_contato}.')}</label><textarea name="lembreteMensagem" maxlength="1000" style="min-height:60px">{Oi|Olá}! Conseguiu ver minha mensagem? {😊|🙂}</textarea></div></div>
              <div class="passo-fup"><div class="campo"><label>2ª mensagem · dias depois da 1ª <span class="rotulo">(vazio = não manda)</span></label><select name="lembrete2Dias">${[1, 2, 3, 4, 5, 7, 10, 14, 21, 30].map((n) => `<option value="${n}" ${n === 4 ? 'selected' : ''}>${n} ${n === 1 ? 'dia' : 'dias'}</option>`).join('')}</select></div>
                <div class="campo"><label>Texto</label><textarea name="lembrete2Mensagem" maxlength="1000" style="min-height:60px" placeholder="Ex.: {Oi|Olá}! Fiz um modelo rapidinho pra te mostrar como ficaria, quer ver?"></textarea></div></div>
              <div class="passo-fup"><div class="campo"><label>3ª mensagem · dias depois da 2ª <span class="rotulo">(vazio = não manda)</span></label><select name="lembrete3Dias">${[1, 2, 3, 4, 5, 7, 10, 14, 21, 30].map((n) => `<option value="${n}" ${n === 7 ? 'selected' : ''}>${n} ${n === 1 ? 'dia' : 'dias'}</option>`).join('')}</select></div>
                <div class="campo"><label>Texto</label><textarea name="lembrete3Mensagem" maxlength="1000" style="min-height:60px" placeholder="Ex.: Vou deixar por aqui pra não incomodar. Se um dia precisar, é só chamar! 👋"></textarea></div></div>
            </div>
            <h3 style="margin-top:14px">💬 Quem <u>respondeu</u> e depois sumiu</h3>
            <select name="followupGeral"><option value="sim">Entra no follow-up geral da empresa (aba 🔁 Follow-up)</option><option value="nao">Não mandar follow-up automático (a IA e a equipe cuidam)</option></select>
          </div>
          <div class="disp-nav"><button type="button" data-voltar>← Voltar</button><button type="button" class="primario" data-proximo>Continuar →</button></div>
        </div>
        <div class="card" data-passo="4">
          <h2><span class="passo-num">4</span> Em que ritmo e quando?</h2>
          <p class="rotulo" style="margin:0 0 10px">O CRM manda <b>uma mensagem por vez</b>, com uma pausa sorteada entre elas, para o WhatsApp não bloquear o número.${prospeccao ? ' Na prospecção também tem limite por dia: o resto continua sozinho nos dias seguintes.' : ''} Na dúvida, deixe o <b>Recomendado</b>.</p>
          <div class="campo"><label>Ritmo de envio</label><div class="perfis-envio">${perfisEnvio.map((pf) => `<label class="perfil-envio"><input type="radio" name="perfilEnvio" value="${pf.id}" ${pf.id === perfilInicial ? 'checked' : ''}><span><b>${pf.nome}</b>${pf.id === 'recomendado' ? ' <span class="etiqueta ok">recomendado</span>' : ''}<span class="rotulo">${pf.texto}</span><span class="perfil-numeros">${textoPerfil(pf, prospeccao)}</span></span></label>`).join('')}</div></div>
          <details id="disp-personalizar" style="margin-top:10px" ${perfilInicial === 'personalizado' ? 'open' : ''}><summary>⚙️ Personalizar os números</summary>
            ${prospeccao ? `<div class="campos" style="margin-top:8px">
              <div class="campo"><label>Limite no 1º dia</label><input name="limiteInicial" type="number" min="5" max="500" value="${esc(valoresIniciais.limiteInicial)}"></div>
              <div class="campo"><label>Aumenta por dia</label><input name="aumentoDia" type="number" min="0" max="200" value="${esc(valoresIniciais.aumentoDia)}"></div>
              <div class="campo"><label>Máximo por dia</label><input name="tetoDia" type="number" min="5" max="1000" value="${esc(valoresIniciais.tetoDia)}"></div>
            </div>` : ''}
            <div class="campos" style="margin-top:8px">
              <div class="campo"><label>Intervalo mínimo</label><input name="intMin" type="number" min="1" step="any" value="${esc(valoresIniciais.intervaloMin)}"></div>
              <div class="campo"><label>Intervalo máximo</label><input name="intMax" type="number" min="1" step="any" value="${esc(valoresIniciais.intervaloMax)}"></div>
              <div class="campo"><label>Em</label><select name="intUnidade"><option value="s">segundos</option><option value="min">minutos</option><option value="h">horas</option></select></div>
            </div>
            <small>Ex.: de hora em hora = mínimo 1 e máximo 1 em <b>horas</b> (ou 50 a 70 minutos, que parece mais natural). Mínimo ${prospeccao ? '45 segundos' : '10 segundos'}, máximo 12 horas.</small>
          </details>
          <p class="rotulo" id="disp-estimativa" style="margin:8px 0 0"></p>

          <label class="linha-check" style="margin-top:12px"><input type="checkbox" name="horarioComercial" checked> Enviar só em horário comercial (8h às 20h)</label>
          <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="rodapeSair" checked> Colocar "responda SAIR para não receber mais" no final</label>
          <div class="disp-nav"><button type="button" data-voltar>← Voltar</button><button type="button" class="primario" data-proximo>Revisar →</button></div>
        </div>
        <div class="card" data-passo="5">
          <h2><span class="passo-num">${numPasso(5)}</span> ${modoCampanha ? 'Confira e salve' : 'Nome, quando e enviar'}</h2>
          <div ${modoCampanha ? 'hidden' : ''}>
            <div class="campo"><label>Nome do disparo (só para você)</label><input name="nome" maxlength="100" placeholder="Ex.: Guinchos PR · semana 1"></div>
            <div class="campos">
              <div class="campo"><label>Começar</label><select name="quando"><option value="agora">Agora</option><option value="agendar">Agendar…</option></select></div>
              <div class="campo" id="campo-agenda" hidden><label>Data e hora</label><input type="datetime-local" name="agendadoPara"></div>
            </div>
          </div>
          <div id="disp-revisao"></div>
          <div class="caixa-teste">
            <b>🧪 Testar antes com o seu número</b>
            <p class="rotulo" style="margin:4px 0 8px">Manda a mensagem <b>agora</b> só para este número. Responda do celular como se fosse o cliente: a IA continua com o roteiro. Não conta no ranking nem na campanha.</p>
            <div class="linha-form" style="flex-wrap:wrap"><input name="testeNumero" type="tel" inputmode="tel" placeholder="Seu WhatsApp com DDD" style="flex:1;min-width:180px"><select id="teste-versao"></select><button type="button" id="enviar-teste">Enviar teste agora</button></div>
            <div id="teste-resultado"></div>
          </div>
          <div id="disp-risco" class="risco-caixa"></div>
          <div id="disp-erro" style="margin-top:10px"></div>
          <div class="disp-nav"><button type="button" data-voltar>← Voltar</button>${modoCampanha ? '<button type="submit" class="primario grande-botao" id="salvar-campanha">💾 Salvar campanha</button><button type="button" id="enviar-disparo" hidden disabled></button>' : '<button type="submit" class="primario grande-botao" id="enviar-disparo" disabled>📣 Iniciar disparo</button>'}</div>
        </div>
      </div>
      <div>
        <div class="card teste whatsapp previa-disparo">
          <div class="cab"><span>Prévia no WhatsApp</span></div>
          <div class="chat" id="previa"><div class="msg acao-ia">Escreva a mensagem para ver a prévia.</div></div>
        </div>
      </div>
    </form>`);

  const form = $('#f-disparo');
  // 🔁 versões da mensagem (até 10): a caixa de texto edita a versão escolhida
  const versoes = [''];
  const idsVersoes = [null]; // id da mensagem da biblioteca de cada versão (null = texto novo)
  try {
    const pedidas = JSON.parse(sessionStorage.getItem('disparo_mensagens') || '[]').slice(0, 10);
    sessionStorage.removeItem('disparo_mensagens');
    if (pedidas.length) { versoes.splice(0, 1, ...pedidas.map((x) => (typeof x === 'string' ? x : x.texto))); idsVersoes.splice(0, 1, ...pedidas.map((x) => (typeof x === 'string' ? null : x.id || null))); }
  } catch { /* sem sessionStorage */ }
  let vAtiva = 0;
  const caixaMsg = form.elements.mensagem;
  caixaMsg.value = versoes[0];
  const comTexto = () => versoes.map((v) => v.trim()).filter(Boolean);
  function desenharVersoes() {
    const letras = versoes.map((v, i) => `<button type="button" class="chip-filtro ${i === vAtiva ? 'ativo' : ''}" data-versao="${i}" title="${esc(v.slice(0, 120))}">Versão ${String.fromCharCode(65 + i)}${v.trim() ? '' : ' (vazia)'}</button>`).join('');
    $('#versoes-msg').innerHTML = `${letras}${versoes.length < 10 ? '<button type="button" class="chip-filtro" id="versao-nova">+ Nova versão</button>' : ''}${versoes.length > 1 ? `<button type="button" class="pequeno perigo" id="versao-tirar" title="Tirar a versão ${String.fromCharCode(65 + vAtiva)}">✕ Tirar ${String.fromCharCode(65 + vAtiva)}</button>` : ''}${versoes.length > 1 ? `<span class="rotulo">${comTexto().length} versões revezando entre os contatos</span>` : ''}`;
    $$('[data-versao]').forEach((b) => { b.onclick = () => irVersao(Number(b.dataset.versao)); });
    $('#versao-nova')?.addEventListener('click', () => { versoes.push(''); idsVersoes.push(null); irVersao(versoes.length - 1); });
    $('#versao-tirar')?.addEventListener('click', () => { versoes.splice(vAtiva, 1); idsVersoes.splice(vAtiva, 1); irVersao(Math.max(0, vAtiva - 1)); });
  }
  function irVersao(i) {
    vAtiva = Math.min(versoes.length - 1, Math.max(0, i));
    caixaMsg.value = versoes[vAtiva];
    desenharVersoes();
    agendarPrevia();
    caixaMsg.focus();
  }
  caixaMsg.addEventListener('input', () => { versoes[vAtiva] = caixaMsg.value; if (!caixaMsg.value.trim() || versoes[vAtiva].length < 2) desenharVersoes(); });
  $('#usar-salva')?.addEventListener('change', (e) => {
    const m = salvas.find((x) => x.id === e.target.value);
    e.target.value = '';
    if (!m) return;
    if (idsVersoes.includes(m.id) || versoes.some((v) => v.trim() === m.texto.trim())) return aviso('Essa mensagem já está nas versões.');
    if (versoes[vAtiva].trim() && versoes.length < 10) { versoes.push(m.texto); idsVersoes.push(m.id); irVersao(versoes.length - 1); } else { versoes[vAtiva] = m.texto; idsVersoes[vAtiva] = m.id; irVersao(vAtiva); }
  });
  form.noValidate = true; // conferimos no JS e mostramos o erro (o navegador travava calado em campo escondido)
  // intervalo em segundos, qualquer que seja a unidade escolhida (segundos, minutos ou horas)
  const intervalos = (f = formParaObjeto(form)) => {
    const mult = { s: 1, min: 60, h: 3600 }[f.intUnidade] || 1;
    const mi = Math.round((Number(String(f.intMin).replace(',', '.')) || 0) * mult);
    return { mi, ma: Math.max(mi, Math.round((Number(String(f.intMax).replace(',', '.')) || 0) * mult)) };
  };
  // quantos dias leva: limite do dia (prospecção) e quantas cabem no horário com esse intervalo
  const diasPara = (f, qtd) => {
    const { mi, ma } = intervalos(f);
    const porDiaNoRelogio = Math.max(1, Math.floor(((f.horarioComercial ? 12 : 24) * 3600) / Math.max(1, (mi + ma) / 2)));
    let n = 0, falta = qtd, lim = Number(f.limiteInicial) || 20;
    while (falta > 0 && n < 3650) { falta -= Math.min(prospeccao ? Math.min(lim, Number(f.tetoDia) || 80) : Infinity, porDiaNoRelogio); lim += Number(f.aumentoDia) || 0; n++; }
    return n;
  };
  const mostrarErro = (msg) => { const caixa = $('#disp-erro'); if (caixa) caixa.innerHTML = msg ? `<div class="erro-caixa">${esc(msg)}</div>` : ''; if (msg) aviso(msg, true); };
  const filtro = () => {
    const pularJaDisparados = Boolean($('input[name=pularJaDisparados]', form)?.checked);
    if (leadIds.length) return { leadIds, pularJaDisparados };
    const f = formParaObjeto(form);
    return {
      pularJaDisparados,
      etapas: $$('input[name=etapa]:checked', form).map((c) => c.value),
      etiquetas: $$('input[name=etiqueta]:checked', form).map((c) => c.value),
      origem: f.origem,
      listaId: f.listaId || '',
      site: f.listaId ? f.siteCat || '' : '',
      ordem: f.listaId ? f.ordem || '' : '',
      soCelular: Boolean(f.listaId && f.soCelular)
    };
  };
  let total = 0;
  let espera = null;
  let passo = 1;
  let ultimaPrevia = null; // a última conta de quem recebe (para a revisão)
  async function atualizarPrevia() {
    if (!form.isConnected) return;
    const f = formParaObjeto(form);
    try {
      const r = await api(`empresas/${id}/disparos/previa`, { method: 'POST', body: { filtro: filtro(), mensagem: f.mensagem, rodapeSair: f.rodapeSair, prospeccao } });
      if (!form.isConnected) return;
      total = r.total;
      ultimaPrevia = r;
      // 🗂️ categorias da lista (tem site / não tem): escolhe e a conta muda na hora
      const caixaCat = $('#categorias-lista');
      if (caixaCat) {
        caixaCat.hidden = !r.categorias;
        if (r.categorias) {
          const atual = form.elements.siteCat.value;
          $('#chips-categoria').innerHTML = [['', 'Todos', r.categorias.todos], ['nenhum', '🚫 Sem site nem rede social', r.categorias.nenhum], ['social', '📱 Só Instagram/Facebook', r.categorias.social], ['semproprio', '🎯 Sem site próprio (os dois)', r.categorias.semproprio], ['proprio', '🌐 Já têm site', r.categorias.proprio]]
            .map(([k, nome, n]) => `<button type="button" class="chip-filtro ${atual === k ? 'ativo' : ''}" data-cat="${k}">${nome} <span class="rotulo">${n}</span></button>`).join('');
          $$('[data-cat]', caixaCat).forEach((b) => { b.onclick = () => { form.elements.siteCat.value = b.dataset.cat; atualizarPrevia(); }; });
          const SITE = { nenhum: '🚫 sem site', social: '📱 só Instagram/Facebook', proprio: '🌐 tem site' };
          $('#primeiros-fila').innerHTML = r.primeiros?.length ? `<b>Primeiros da fila:</b><ol class="primeiros-fila">${r.primeiros.map((x) => `<li>${esc(x.nome || 'Contato')} <span>· ${x.nota ? `⭐ ${esc(String(x.nota).replace('.', ','))}` : 'sem nota'} · ${x.avaliacoes ? `${esc(x.avaliacoes)} avaliações` : 'nenhuma avaliação'} · ${SITE[x.site]}${x.cidade ? ` · ${esc(x.cidade)}` : ''}</span></li>`).join('')}</ol>` : '';
        }
      }
      $('#contagem').innerHTML = r.total
        ? `<strong>${r.total} ${r.total === 1 ? 'pessoa vai' : 'pessoas vão'} receber</strong><span class="rotulo">${r.nomes.map(esc).join(', ')}${r.total > r.nomes.length ? '…' : ''}</span>${r.semNumero || r.sairam ? `<span class="rotulo">${r.semNumero ? `${r.semNumero} sem WhatsApp` : ''}${r.semNumero && r.sairam ? ' · ' : ''}${r.sairam ? `${r.sairam} pediram para não receber ou estão na lista negra` : ''} (ficam de fora)</span>` : ''}${r.jaDisparados ? `<span class="rotulo aviso-texto">⚠️ ${r.jaDisparados} ${r.jaDisparados === 1 ? 'já recebeu' : 'já receberam'} disparo em massa antes${r.pulouJaDisparados ? (r.jaDisparados === 1 ? ' (fica de fora)' : ' (ficam de fora)') : (r.jaDisparados === 1 ? ' e vai receber de novo' : ' e vão receber de novo')}</span>` : ''}`
        : `<strong>Ninguém nesse filtro</strong><span class="rotulo">${r.jaDisparados && r.pulouJaDisparados ? `Todos os ${r.jaDisparados} já receberam disparo em massa. Desmarque "Não mandar para quem já recebeu" para mandar de novo.` : 'Mude as etapas ou etiquetas.'}</span>`;
      const itens = escolhidas.map(itemDe).filter(Boolean);
      const perso = personalizacao();
      const srcFoto = (m, i) => (i === 0 && perso ? `api/empresas/${id}/disparos/previa-imagem?${new URLSearchParams({ midiaId: escolhidas[0], leadId: r.primeiroId || '', texto: perso.texto, posicao: perso.posicao, fundo: perso.fundo, destaque: perso.destaque })}` : m.url);
      $('#previa').innerHTML = r.exemplo
        ? `${itens.map((m, i) => `<div class="msg bot midia-previa-msg">${m.tipo === 'image' ? `<img src="${esc(srcFoto(m, i))}" alt="">` : `${m.icone} ${esc(m.nome)}`}</div>`).join('')}<div class="msg bot">${esc(r.exemplo).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')}</div><div class="msg acao-ia">${versoes.length > 1 ? `Versão ${String.fromCharCode(65 + vAtiva)} · ` : ''}Exemplo com o primeiro contato da lista. Cada pessoa recebe com o próprio nome.</div>`
        : '<div class="msg acao-ia">Escreva a mensagem para ver a prévia.</div>';
      atualizarRisco();
      if (passo === 5) desenharRevisao();
      if (r.maximo && r.total > r.maximo) $('#contagem').insertAdjacentHTML('beforeend', `<span class="erro-caixa">São ${r.total} contatos e o máximo é ${r.maximo} por disparo. Divida a lista (ex.: por cidade ou etiqueta) e faça mais de um disparo.</span>`);
      $('#enviar-disparo').disabled = !(r.total && comTexto().length) || (r.maximo && r.total > r.maximo);
      $('#enviar-disparo').textContent = r.total ? `📣 Enviar para ${r.total} ${r.total === 1 ? 'pessoa' : 'pessoas'}` : '📣 Iniciar disparo';
    } catch (err) {
      if (!form.isConnected) return;
      $('#contagem').innerHTML = `<span class="erro-caixa">${esc(err.message)}</span>`;
    }
  }
  // 🌡️ termômetro de risco de bloqueio: confere a mensagem e o ritmo escolhidos
  function atualizarRisco() {
    if (!form.isConnected) return;
    const f = formParaObjeto(form);
    const msg = String(f.mensagem || '');
    const { mi, ma } = intervalos(f);
    const media = (mi + ma) / 2;
    const itens = [];
    const add = (nivel, txt) => itens.push([nivel, txt]);
    if (prospeccao) {
      add(media >= 90 ? 0 : media >= 50 ? 1 : 2, `Intervalo de ${textoPerfil({ intervaloMin: mi, intervaloMax: ma })}${media < 50 ? ' — curto para quem não conhece você' : ''}`);
      const teto = Number(f.tetoDia) || 0;
      add(Number(f.limiteInicial) <= 20 && teto <= 100 ? 0 : teto <= 200 ? 1 : 2, `Até ${esc(f.limiteInicial)} no 1º dia, máximo ${esc(teto)} por dia`);
      add(/https?:\/\/|www\.|\.com\b|\.br\b/i.test(msg) ? 2 : 0, /https?:\/\/|www\.|\.com\b|\.br\b/i.test(msg) ? 'Tem link na 1ª mensagem — é o que mais vira denúncia' : 'Sem link na mensagem');
      add(escolhidas.length ? 1 : 0, escolhidas.length ? (personalizacao() ? 'Foto com o nome do contato — chama atenção, mas arquivo na 1ª mensagem pesa um pouco' : 'Tem foto/arquivo na 1ª mensagem — só texto é o mais seguro') : 'Só texto');
      add(/\?\s*$/.test(msg.trim()) || /\?[^?]{0,40}$/.test(msg.trim()) ? 0 : 1, 'Termina com uma pergunta (ex.: "posso te mandar os detalhes?")');
    } else {
      add(media >= 45 ? 0 : media >= 25 ? 1 : 2, `Intervalo de ${textoPerfil({ intervaloMin: mi, intervaloMax: ma })}`);
      add(total > 300 && media < 60 ? 2 : total > 150 ? 1 : 0, `${total} ${total === 1 ? 'pessoa' : 'pessoas'} neste disparo${total > 150 ? ' — muitas de uma vez; divida por etiqueta/etapa ou use o ritmo "Bem seguro"' : ''}`);
    }
    if (!msg.trim()) itens.splice(2); // sem mensagem: fica só o ritmo (os 2 primeiros)
    if (msg.trim()) add(/\{[^{}|]+\|[^{}]+\}/.test(msg) ? 0 : 1, /\{[^{}|]+\|[^{}]+\}/.test(msg) ? 'Mensagem com variação ({Oi|Olá}) — cada um recebe um texto diferente' : 'Use variação {Oi|Olá|E aí} para as mensagens não saírem iguais');
    if (msg.trim()) add(/\{(nome|empresa_contato)\}/.test(msg) ? 0 : 1, /\{(nome|empresa_contato)\}/.test(msg) ? 'Mensagem com o nome da pessoa/empresa' : 'Coloque {nome} ou {empresa_contato} para personalizar');
    if (msg.trim()) add(msg.length > 600 ? 1 : 0, msg.length > 600 ? 'Mensagem longa — curta funciona melhor' : 'Tamanho da mensagem ok');
    add(f.rodapeSair ? 0 : 1, f.rodapeSair ? 'Tem o "responda SAIR"' : 'Sem o "responda SAIR" — quem não quer receber acaba denunciando');
    add(f.horarioComercial ? 0 : 1, f.horarioComercial ? 'Só em horário comercial' : 'Fora do horário comercial também');
    add(form.elements.pularJaDisparados?.checked ? 0 : 1, form.elements.pularJaDisparados?.checked ? 'Não repete para quem já recebeu disparo' : 'Vai mandar de novo para quem já recebeu disparo');
    const pontos = itens.reduce((s, [n]) => s + n, 0);
    const [cor, nome] = !msg.trim() ? ['vazio', 'Escreva a mensagem para calcular'] : itens.some(([n]) => n === 2) || pontos >= 5 ? ['alto', '🔴 Risco alto de bloqueio'] : pontos >= 2 ? ['medio', '🟡 Risco médio'] : ['baixo', '🟢 Risco baixo'];
    $('#disp-risco').innerHTML = `<div class="risco-topo"><b>🌡️ Risco de bloqueio</b> <span class="risco-selo risco-${cor}">${nome}</span></div><details ${cor === 'baixo' ? '' : 'open'}><summary class="rotulo">${cor === 'baixo' ? 'Ver o que foi conferido' : 'O que melhorar'}</summary><ul class="lista-simples risco-itens">${itens.map(([n, t]) => `<li>${['✅', '⚠️', '❌'][n]} ${t}</li>`).join('')}</ul></details>`;
    // quanto tempo leva
    let est = '';
    if (total) {
      const n = diasPara(f, total);
      const minutos = Math.round((total * media) / 60);
      est = prospeccao || n > 1
        ? `⏱️ ${total} contatos: mais ou menos <b>${n} ${n === 1 ? 'dia' : 'dias'}</b> (uma mensagem a cada ${textoPerfil({ intervaloMin: mi, intervaloMax: ma }).replace(' entre mensagens', '')}${f.horarioComercial ? ', só das 8h às 20h' : ''}).`
        : `⏱️ ${total} ${total === 1 ? 'pessoa' : 'pessoas'}: mais ou menos <b>${minutos < 60 ? `${Math.max(1, minutos)} min` : `${(minutos / 60).toFixed(1).replace('.', ',')} h`}</b>.`;
    }
    $('#disp-estimativa').innerHTML = modoCampanha ? '' : est;
  }
  const agendarPrevia = () => {
    clearTimeout(espera);
    espera = setTimeout(atualizarPrevia, 350);
    const av = $('#aviso-prospeccao');
    if (av) av.classList.toggle('texto-erro', /https?:\/\/|www\./i.test(form.elements.mensagem.value));
  };
  // ✍️ foto com o nome do contato: só quando a 1ª mídia é foto
  const personalizacao = () => {
    const f = formParaObjeto(form);
    if (!f.persoAtivo || itemDe(escolhidas[0])?.tipo !== 'image') return null;
    return { ativo: true, texto: f.persoTexto || 'Feito para {empresa_contato}', posicao: f.persoPosicao, fundo: f.persoFundo, destaque: f.persoDestaque };
  };
  const contarRoteiro = () => { const n = form.elements.roteiro.value.length; $('#roteiro-conta').textContent = `${n.toLocaleString('pt-BR')} de 12.000 letras`; };
  form.elements.roteiro.addEventListener('input', contarRoteiro);
  form.elements.persoAtivo.onchange = (e) => { $('#disp-perso-campos').hidden = !e.target.checked; };
  form.elements.lembreteAtivo.onchange = (e) => { $('#campos-lembrete').hidden = !e.target.checked; };
  function desenharEscolhidas() {
    $('#disp-perso').hidden = itemDe(escolhidas[0])?.tipo !== 'image';
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
  // 👣 um passo por vez: 1 quem recebe → 2 mensagem → 3 quando responderem → 4 ritmo → 5 revisar e enviar
  const irPara = (n) => {
    passo = ORDEM.includes(n) ? n : ORDEM[0];
    $$('[data-passo]', form).forEach((c) => { c.hidden = Number(c.dataset.passo) !== passo; });
    $$('#disp-passos li').forEach((li, i) => { li.classList.toggle('ativo', ORDEM[i] === passo); li.classList.toggle('feito', ORDEM[i] < passo); });
    if (passo === 5) desenharRevisao();
    const topo = $('#disp-passos');
    if (topo && topo.getBoundingClientRect().top < 0) topo.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const podeIr = (n) => {
    if (modoCampanha) {
      if (n > 1 && !form.elements.campanhaNome.value.trim()) { aviso('Dê um nome para a campanha.', true); form.elements.campanhaNome.focus(); return false; }
      if (n > 2 && !comTexto().length) { aviso('Escreva a mensagem.', true); form.elements.mensagem.focus(); return false; }
      return true;
    }
    if (n > 1 && !ultimaPrevia) { aviso('Ainda contando quem vai receber… tente de novo em um segundo.', true); return false; }
    const fl = filtro();
    if (n > 1 && prospeccao && !leadIds.length && !fl.listaId && !fl.etapas.length && !fl.etiquetas.length && fl.origem === 'todos') { aviso('Escolha a lista de contatos que vai receber.', true); form.elements.listaId?.focus(); return false; }
    if (n > 1 && !total) { aviso('Ninguém vai receber assim: escolha a lista ou mude os filtros.', true); return false; }
    if (n > 2 && !comTexto().length) { aviso('Escreva a mensagem.', true); form.elements.mensagem.focus(); return false; }
    return true;
  };
  const vizinho = (d) => ORDEM[Math.min(ORDEM.length - 1, Math.max(0, ORDEM.indexOf(passo) + d))];
  const voltarPara = (n) => { if (ORDEM.includes(n)) irPara(n); };
  $$('[data-proximo]', form).forEach((b) => { b.onclick = () => { const n = vizinho(1); if (podeIr(n)) irPara(n); }; });
  $$('[data-voltar]', form).forEach((b) => { b.onclick = () => irPara(vizinho(-1)); });
  $$('[data-ir-passo]').forEach((b) => { b.onclick = () => { const n = Number(b.dataset.irPasso); if (n <= passo || podeIr(n)) irPara(n); }; });
  function desenharRevisao() {
    const f = formParaObjeto(form);
    const selTeste = $('#teste-versao');
    if (selTeste) { const antes = selTeste.value; selTeste.innerHTML = comTexto().map((v, i) => `<option value="${i}">Versão ${String.fromCharCode(65 + i)}</option>`).join(''); selTeste.hidden = comTexto().length < 2; if (antes) selTeste.value = antes; }
    const pf = perfisEnvio.find((x) => x.id === f.perfilEnvio);
    const { mi, ma } = intervalos(f);
    const itens = escolhidas.map(itemDe).filter(Boolean);
    const r = ultimaPrevia || {};
    const pular = form.elements.pularJaDisparados?.checked;
    const protecoes = [pular && 'não repete para quem já recebeu disparo', f.rodapeSair && '"responda SAIR" no final', prospeccao && 'confere se o número tem WhatsApp', prospeccao && 'pausa sozinho se der erro seguido'].filter(Boolean);
    $('#disp-revisao').innerHTML = `<dl class="revisao">
      ${modoCampanha ? `<dt>🎯 Campanha</dt><dd><b>${esc(f.campanhaNome || '')}</b> · ${tipoTexto}<br><span class="rotulo">A lista é escolhida na hora de disparar.</span></dd><dt hidden></dt><dd hidden>` : `${campanha ? `<dt>🎯 Campanha</dt><dd>${esc(campanha.nome)}</dd>` : ''}<dt>👥 Para</dt><dd>`}<b>${total} ${total === 1 ? 'pessoa' : 'pessoas'}</b>${f.listaId && f.ordem && f.ordem !== 'arquivo' ? ` <span class="etiqueta">${esc((ORDENS_ENVIO.find(([v]) => v === f.ordem) || [])[1] || '')}</span>` : ''}${f.listaId && (f.siteCat || f.soCelular) ? ` <span class="etiqueta">${esc([{ nenhum: '🚫 sem site nem rede social', social: '📱 só Instagram/Facebook', semproprio: '🎯 sem site próprio', proprio: '🌐 já têm site' }[f.siteCat], f.soCelular ? '📱 só celular' : ''].filter(Boolean).join(' · '))}</span>` : ''}${r.nomes?.length ? `<br><span class="rotulo">${r.nomes.map(esc).join(', ')}${total > r.nomes.length ? '…' : ''}</span>` : ''}${r.jaDisparados ? `<br><span class="rotulo aviso-texto">⚠️ ${r.jaDisparados} já ${r.jaDisparados === 1 ? 'recebeu' : 'receberam'} disparo antes ${pular ? '(fica de fora)' : '(vai receber de novo)'}</span>` : ''}</dd>
      ${comTexto().length > 1 ? `<dt>🔁 Versões</dt><dd><b>${comTexto().length} versões</b> revezando${modoCampanha ? ' entre os contatos' : ` (cada uma vai para ${Math.ceil(total / comTexto().length)} pessoas mais ou menos)`}<br><span class="rotulo">${comTexto().map((v, i) => `${String.fromCharCode(65 + i)}: ${esc(v.replace(/\s+/g, ' ').slice(0, 60))}${v.length > 60 ? '…' : ''}`).join('<br>')}</span></dd>` : ''}
      <dt>💬 Mensagem</dt><dd><div class="revisao-msg">${esc(r.exemplo || f.mensagem).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')}</div><span class="rotulo">Exemplo com o 1º contato${itens.length ? ` · + ${itens.length} ${itens.length === 1 ? 'arquivo' : 'arquivos'}: ${itens.map((m) => esc(m.nome)).join(', ')}` : ' · só texto'}</span></dd>
      <dt>⏱️ Ritmo</dt><dd><b>${pf ? pf.nome : '⚙️ Personalizado'}</b> · ${textoPerfil({ intervaloMin: mi, intervaloMax: ma, limiteInicial: f.limiteInicial, aumentoDia: f.aumentoDia, tetoDia: f.tetoDia }, prospeccao)}${modoCampanha ? '' : `<br><span class="rotulo">${$('#disp-estimativa').innerHTML}</span>`}</dd>
      <dt ${modoCampanha ? 'hidden' : ''}>🕐 Quando</dt><dd ${modoCampanha ? 'hidden' : ''}>${f.quando === 'agendar' && f.agendadoPara ? `Agendado para <b>${esc(new Date(f.agendadoPara).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}</b>` : '<b>Começa quando você clicar em enviar</b>'}${f.horarioComercial ? ' · só em horário comercial (8h às 20h)' : ' · a qualquer hora'}</dd>
      ${modoCampanha && !f.iaCampanha ? '<dt>🤖 IA</dt><dd><b>Desligada</b> nesta campanha: quem responder fica para a equipe</dd>' : ''}
      ${f.envEtapa || f.envEtiqueta ? `<dt>📌 Ao enviar</dt><dd>${f.envEtapa ? `Vai para a etapa <b>${esc(f.envEtapa)}</b>` : ''}${f.envEtapa && f.envEtiqueta ? ' · ' : ''}${f.envEtiqueta ? `etiqueta <b>${esc(emp.etiquetas.find((t) => t.id === f.envEtiqueta)?.nome || '')}</b>` : ''}</dd>` : ''}
      <dt>💬 Quando responderem</dt><dd>${f.roteiro?.trim() ? `A IA segue <b>só o prompt da campanha</b>: <span class="rotulo">${esc(f.roteiro.trim().slice(0, 160))}${f.roteiro.trim().length > 160 ? '…' : ''}</span>` : 'Sem prompt da campanha: a IA atende pelo prompt principal da empresa'}${f.respEtapa ? `<br>Vai para a etapa <b>${esc(f.respEtapa)}</b>` : ''}${f.respEtiqueta ? `<br>Ganha a etiqueta <b>${esc(emp.etiquetas.find((t) => t.id === f.respEtiqueta)?.nome || '')}</b>` : ''}</dd>
      <dt>🔁 Follow-up</dt><dd>${f.lembreteAtivo ? passosFupDoForm(f).map((p, i) => `${i + 1}ª: <b>${p.dias} ${p.dias === 1 ? 'dia' : 'dias'}</b> depois ${i ? 'da anterior' : 'do disparo'} <span class="rotulo">— ${esc(p.mensagem.slice(0, 80))}</span>`).join('<br>') : 'Sem follow-up para quem não responder'}<br><span class="rotulo">Quem responder e sumir: ${f.followupGeral === 'nao' ? 'sem follow-up automático' : 'follow-up geral da empresa'}</span></dd>
      ${personalizacao() ? `<dt>✍️ Foto</dt><dd>A 1ª foto vai com <b>${esc(personalizacao().texto)}</b> escrito</dd>` : ''}
      ${protecoes.length ? `<dt>🛡️ Proteções</dt><dd>${protecoes.join(' · ')}</dd>` : ''}
    </dl><p class="rotulo" style="margin:8px 0 0">Depois de começar, dá para pausar ou cancelar a qualquer momento.</p>`;
  }
  // 🎯 campanha: tudo preenchido (editar a campanha ou disparar com ela)
  if (campanha) {
    const el = form.elements;
    const vsCamp = campanha.versoes?.length ? campanha.versoes : (campanha.mensagens || []).map((t) => ({ texto: t }));
    versoes.splice(0, versoes.length, ...(vsCamp.length ? vsCamp.slice(0, 10).map((v) => v.texto) : ['']));
    idsVersoes.splice(0, idsVersoes.length, ...(vsCamp.length ? vsCamp.slice(0, 10).map((v) => v.msgId || null) : [null]));
    caixaMsg.value = versoes[0];
    for (const mid of campanha.midiaIds || []) if (itemDe(mid) && !escolhidas.includes(mid)) escolhidas.push(mid);
    desenharEscolhidas();
    if (campanha.personalizar?.ativo) {
      el.persoAtivo.checked = true;
      $('#disp-perso-campos').hidden = false;
      el.persoTexto.value = campanha.personalizar.texto || el.persoTexto.value;
      el.persoPosicao.value = campanha.personalizar.posicao || 'baixo';
      el.persoFundo.value = campanha.personalizar.fundo || el.persoFundo.value;
      el.persoDestaque.value = campanha.personalizar.destaque || el.persoDestaque.value;
    }
    el.roteiro.value = campanha.roteiro || '';
    contarRoteiro();
    el.respEtapa.value = campanha.aoResponder?.etapa || '';
    el.envEtapa.value = campanha.aoEnviar?.etapa || '';
    el.envEtiqueta.value = campanha.aoEnviar?.etiquetaId || '';
    el.respEtiqueta.value = campanha.aoResponder?.etiquetaId || '';
    el.lembreteAtivo.checked = Boolean(campanha.lembrete?.ativo);
    $('#campos-lembrete').hidden = !campanha.lembrete?.ativo;
    if (campanha.lembrete) {
      el.lembreteDias.value = String(campanha.lembrete.dias || 3);
      el.lembreteMensagem.value = campanha.lembrete.mensagem || el.lembreteMensagem.value;
      (campanha.lembrete.mais || []).forEach((m, i) => { el[`lembrete${i + 2}Dias`].value = String(m.dias); el[`lembrete${i + 2}Mensagem`].value = m.mensagem; });
    }
    el.followupGeral.value = campanha.followupGeral === false ? 'nao' : 'sim';
    el.horarioComercial.checked = campanha.horarioComercial !== false;
    el.rodapeSair.checked = campanha.rodapeSair !== false;
    $$('input[name=perfilEnvio]', form).forEach((r) => { r.checked = r.value === campanha.perfilEnvio; });
    if (campanha.intervaloMin) { el.intMin.value = campanha.intervaloMin; el.intMax.value = campanha.intervaloMax || campanha.intervaloMin; el.intUnidade.value = 's'; }
    for (const k of ['limiteInicial', 'aumentoDia', 'tetoDia']) if (el[k] && campanha[k] !== undefined && campanha[k] !== null) el[k].value = campanha[k];
    if (!modoCampanha && el.nome) el.nome.value = `${campanha.nome} · ${new Date().toLocaleDateString('pt-BR')}`.slice(0, 100);
  }
  irPara(1);
  desenharVersoes();
  $$('input[name=perfilEnvio]', form).forEach((r) => {
    r.onchange = () => {
      const pf = perfisEnvio.find((x) => x.id === r.value);
      if (!pf) return;
      form.elements.intMin.value = pf.intervaloMin;
      form.elements.intMax.value = pf.intervaloMax;
      form.elements.intUnidade.value = 's';
      if (prospeccao) ['limiteInicial', 'aumentoDia', 'tetoDia'].forEach((k) => { form.elements[k].value = pf[k]; });
      atualizarRisco();
    };
  });
  $$('#disp-personalizar input, #disp-personalizar select', form).forEach((i) => { i.addEventListener('input', () => { $$('input[name=perfilEnvio]', form).forEach((r) => { r.checked = false; }); }); });
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
  form.elements.quando.onchange = (e) => {
    const agendar = e.target.value === 'agendar';
    $('#campo-agenda').hidden = !agendar;
    const campo = form.elements.agendadoPara;
    campo.min = paraDatetimeLocal(new Date());
    // já vem preenchido (próxima hora cheia; de noite, 8h do dia seguinte): no celular o campo vazio confunde
    if (agendar && !campo.value) campo.value = paraDatetimeLocal(sugestaoDeHorario(form.elements.horarioComercial?.checked !== false));
    if (agendar) campo.focus();
  };
  $('#limpar-escolha')?.addEventListener('click', (e) => { e.preventDefault(); paginaNovoDisparo(id, new URLSearchParams([['campanha', campanhaPedida]])); });

  // tudo do disparo menos quem recebe (é o que a campanha guarda)
  const configDoForm = (f) => {
    const { mi, ma } = intervalos(f);
    return {
      mensagem: comTexto()[0] || '',
      mensagens: comTexto(),
      versoes: versoes.map((t, i) => ({ texto: t.trim(), msgId: idsVersoes[i] || null })).filter((v) => v.texto),
      midiaIds: escolhidas,
      intervaloMin: mi,
      intervaloMax: ma,
      horarioComercial: f.horarioComercial,
      rodapeSair: f.rodapeSair,
      roteiro: f.roteiro || '',
      aoResponder: { etapa: f.respEtapa || '', etiquetaId: f.respEtiqueta || '' },
      aoEnviar: { etapa: f.envEtapa || '', etiquetaId: f.envEtiqueta || '' },
      lembrete: { ativo: Boolean(f.lembreteAtivo), dias: Number(f.lembreteDias) || 3, mensagem: f.lembreteMensagem || '', mais: passosFupDoForm(f).slice(1) },
      followupGeral: f.followupGeral !== 'nao',
      personalizar: personalizacao() || { ativo: false },
      perfilEnvio: f.perfilEnvio || '',
      ...(prospeccao ? { limiteInicial: f.limiteInicial, aumentoDia: f.aumentoDia, tetoDia: f.tetoDia } : {})
    };
  };
  // 🧪 teste para um número: manda agora e a IA responde quando o número escrever
  try { form.elements.testeNumero.value = localStorage.getItem('disparo_teste_numero') || ''; } catch { /* sem localStorage */ }
  $('#enviar-teste').onclick = (e) => enviarTesteDisparo(id, e.currentTarget, { ...configDoForm(formParaObjeto(form)), nome: form.elements.nome?.value || form.elements.campanhaNome?.value || '', ...(campanha ? { campanhaId: campanha.id } : {}) }, form.elements.testeNumero.value, Number($('#teste-versao').value) || 0, $('#teste-resultado'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = formParaObjeto(form);
    mostrarErro('');
    const { mi, ma } = intervalos(f);
    const piso = prospeccao ? 45 : 10;
    if (mi < piso) { voltarPara(4); return mostrarErro(`O intervalo mínimo é ${piso} segundos${modoCampanha ? '' : ' (ajuste em ✏️ Editar campanha)'}.`); }
    if (ma > 12 * 3600) { voltarPara(4); return mostrarErro(`O intervalo máximo é 12 horas${modoCampanha ? '' : ' (ajuste em ✏️ Editar campanha)'}.`); }
    if (modoCampanha) {
      if (!f.campanhaNome?.trim()) { irPara(1); return mostrarErro('Dê um nome para a campanha.'); }
      if (!comTexto().length) { irPara(2); return mostrarErro('Escreva a mensagem.'); }
      try {
        await api(campanha ? `empresas/${id}/disparos-campanhas/${campanha.id}` : `empresas/${id}/disparos-campanhas`, { method: campanha ? 'PUT' : 'POST', body: { ...configDoForm(f), nome: f.campanhaNome, tipo: prospeccao ? 'prospeccao' : 'clientes', iaLigada: Boolean(f.iaCampanha) } });
        aviso('Campanha salva!');
        location.hash = rotaEmpresa(id, 'disparos/campanhas');
      } catch (err) { mostrarErro(`Não foi salva: ${err.message}`); }
      return;
    }
    const min = mi;
    const max = ma;
    const agendado = f.quando === 'agendar' && f.agendadoPara ? new Date(f.agendadoPara) : null;
    if (f.quando === 'agendar' && (!agendado || Number.isNaN(agendado.getTime()))) return mostrarErro('Escolha a data e a hora do agendamento.');
    if (agendado && agendado.getTime() < Date.now() - 60000) return mostrarErro('A data do agendamento já passou. Escolha uma data futura.');
    if (ultimaPrevia?.maximo && total > ultimaPrevia.maximo) return mostrarErro(`São ${total} contatos e o máximo é ${ultimaPrevia.maximo} por disparo. Divida a lista e faça mais de um disparo.`);
    const minutos = Math.round((total * ((min + max) / 2)) / 60);
    if (prospeccao && !f.listaId && !leadIds.length && !(await confirmar({ titulo: 'Prospecção sem lista?', texto: 'Você não escolheu uma lista de contatos: vai para todos os leads do filtro. Continuar assim?', botao: 'Continuar' }))) return;
    // prospecção: quantos dias leva com o limite por dia (aquecendo)
    const dias = diasPara(f, total);
    if (prospeccao) {
      const okP = await confirmar({
        titulo: `Prospecção para ${total} ${total === 1 ? 'contato' : 'contatos'}?`,
        texto: `<p>${agendado ? `Começa em <b>${esc(agendado.toLocaleString('pt-BR'))}</b>.` : 'Começa agora.'} Com ${esc(f.limiteInicial)} no 1º dia (+${esc(f.aumentoDia)} por dia, até ${esc(f.tetoDia)}), leva mais ou menos <b>${dias} ${dias === 1 ? 'dia' : 'dias'}</b>${f.horarioComercial ? ', só em horário comercial' : ''}.</p><p>Quem não tem WhatsApp fica de fora sozinho, e se ${esc(seg.freioErros || 3)} envios seguidos falharem o disparo pausa.</p>`,
        botao: agendado ? 'Agendar' : 'Começar'
      });
      if (!okP) return;
    }
    const ok = prospeccao || await confirmar({
      titulo: `Enviar para ${total} ${total === 1 ? 'pessoa' : 'pessoas'}?`,
      texto: `<p>${agendado ? `Começa em <b>${esc(agendado.toLocaleString('pt-BR'))}</b>.` : 'Começa agora.'} Leva mais ou menos <b>${minutos < 60 ? `${Math.max(1, minutos)} min` : `${(minutos / 60).toFixed(1).replace('.', ',')} h`}</b>${f.horarioComercial ? ' (só em horário comercial)' : ''}.</p><p class="rotulo">Dá para pausar ou cancelar a qualquer momento.</p>`,
      botao: agendado ? 'Agendar' : 'Começar agora'
    });
    if (!ok) return;
    try {
      const d = await api(`empresas/${id}/disparos`, {
        method: 'POST',
        body: {
          ...configDoForm(f),
          nome: f.nome,
          filtro: filtro(),
          intervaloMin: min,
          intervaloMax: max,
          agendadoPara: agendado ? agendado.toISOString() : null,
          ...(campanha ? { campanhaId: campanha.id } : {}),
          ...(prospeccao ? { prospeccao: true } : {})
        }
      });
      aviso(agendado ? 'Disparo agendado!' : 'Disparo iniciado!');
      location.hash = rotaEmpresa(id, `disparos/${d.id}`);
    } catch (err) { mostrarErro(`Não foi criado: ${err.message}`); }
  };
}

// 🔎 Filtros das empresas (prévia do PDF e ficha da lista): site, telefone, nota, avaliações, cidade, ramo
const REDE_SOCIAL = /instagram\.|facebook\.|fb\.com|fb\.me|linktr\.ee|wa\.me|whatsapp\.|tiktok\.|ifood\.|goo\.gl|bit\.ly|linkbio|beacons\.ai/i;
// sem link de site mas a lista diz "Tem site? Sim": conta como site próprio
const tipoSite = (c) => (!c.site ? (c.temSite === 'sim' ? 'proprio' : 'nenhum') : REDE_SOCIAL.test(c.site) ? 'social' : 'proprio');
const ehFixoContato = (c) => Boolean(c.fixo || c.analise?.fixo);
const ramoDe = (c) => String(c.categorias || c.ramo || '').split(',')[0].trim();
const OPCOES_FILTRO_EMPRESA = {
  site: [['', '🌐 Site: todos'], ['semproprio', 'Sem site próprio'], ['nenhum', 'Sem site nem rede social'], ['social', 'Só Instagram/Facebook…'], ['proprio', 'Com site próprio']],
  tel: [['', '📞 Telefone: todos'], ['cel', 'Só celular'], ['fixo', 'Só fixo']],
  nota: [['', '⭐ Nota: qualquer'], ['45', '4,5 ou mais'], ['40', '4,0 ou mais'], ['baixa', 'Abaixo de 4,0'], ['sem', 'Sem nota']],
  aval: [['', '💬 Avaliações: qualquer'], ['p', 'Até 50 (pouco movimento)'], ['m', '50 a 500'], ['g', 'Mais de 500 (muito movimento)']]
};
// 🎯 Prioridade por objetivo (sem IA: só os dados que vieram na lista)
//  site: sem site nenhum > só Instagram/Facebook; movimentado (muitas avaliações) primeiro
//  reputacao (avaliações no Google): nota mais baixa e poucas avaliações primeiro
const OBJETIVOS_EMPRESA = [['', '📋 Só ver a lista'], ['site', '🌐 Vender site'], ['reputacao', '⭐ Vender avaliações no Google']];
const ORDENS_EMPRESA = [['prioridade', '🎯 Prioridade'], ['mais-aval', '💬 Mais avaliações'], ['menos-aval', '💬 Menos avaliações'], ['nota-alta', '⭐ Maior nota'], ['nota-baixa', '⭐ Menor nota'], ['nome', '🔤 Nome A-Z']];
const numAval = (c) => Number(c.avaliacoes || 0);
const numNota = (c) => (c.nota ? Number(c.nota) : null);
function prioridadeEmpresa(c, objetivo) {
  const av = numAval(c);
  const nota = numNota(c);
  const mov = av >= 500 ? `${av.toLocaleString('pt-BR')} avaliações (muito movimento)` : av >= 50 ? `${av.toLocaleString('pt-BR')} avaliações` : av ? `só ${av} avaliações` : 'sem avaliações';
  if (objetivo === 'site') {
    const t = tipoSite(c);
    if (t === 'proprio') return { nivel: 'baixa', pontos: 0, motivo: 'já tem site próprio' };
    const pontos = (t === 'nenhum' ? 1000 : 600) + Math.min(av, 5000) / 10 + (nota || 0);
    const nivel = (t === 'nenhum' && av >= 20) || (t === 'social' && av >= 200) ? 'alta' : 'media';
    return { nivel, pontos, motivo: `${t === 'nenhum' ? 'sem site nem rede social' : 'só tem Instagram/Facebook'} · ${mov}` };
  }
  if (objetivo === 'reputacao') {
    const pontos = (nota === null ? 3 : 5 - nota) * 200 + Math.max(0, 100 - av);
    const nivel = nota === null || nota < 4 || av < 20 ? 'alta' : nota < 4.5 || av < 100 ? 'media' : 'baixa';
    return { nivel, pontos, motivo: `${nota === null ? 'sem nota no Google' : `nota ${String(nota).replace('.', ',')}`} · ${mov}` };
  }
  return null;
}
function ordenarEmpresas(lista, sel) {
  const ordem = sel.ordem || (sel.objetivo ? 'prioridade' : '');
  const por = {
    // nível primeiro (alta → média → baixa), depois os pontos dentro do nível
    prioridade: (a, b) => {
      const chave = (c) => { const p = prioridadeEmpresa(c, sel.objetivo); return p ? { alta: 3, media: 2, baixa: 1 }[p.nivel] * 1e6 + p.pontos : 0; };
      return chave(b) - chave(a);
    },
    'mais-aval': (a, b) => numAval(b) - numAval(a),
    'menos-aval': (a, b) => numAval(a) - numAval(b),
    'nota-alta': (a, b) => (numNota(b) ?? -1) - (numNota(a) ?? -1),
    'nota-baixa': (a, b) => (numNota(a) ?? 99) - (numNota(b) ?? 99),
    nome: (a, b) => String(a.empresa || a.nome || '').localeCompare(String(b.empresa || b.nome || ''), 'pt-BR')
  }[ordem];
  return por && (ordem !== 'prioridade' || sel.objetivo) ? lista.slice().sort(por) : lista;
}
const seloPrioridade = (c, objetivo) => {
  const p = prioridadeEmpresa(c, objetivo);
  if (!p) return '';
  const [cls, nome] = { alta: ['prio-alta', '🔥 Prioridade alta'], media: ['prio-media', '🟡 Prioridade média'], baixa: ['prio-baixa', '⚪ Prioridade baixa'] }[p.nivel];
  return `<span class="etiqueta ${cls}">${nome} — ${esc(p.motivo)}</span>`;
};
// 📊 leitura rápida da lista
function raioXLista(contatos) {
  if (!contatos.length) return '';
  const n = (f) => contatos.filter(f).length;
  const notas = contatos.map(numNota).filter((x) => x !== null);
  const media = notas.length ? (notas.reduce((a, b) => a + b, 0) / notas.length).toFixed(1).replace('.', ',') : '—';
  const pct = (x) => `${Math.round((x / contatos.length) * 100)}%`;
  const semProprio = n((c) => tipoSite(c) !== 'proprio');
  const itens = [
    ['🌐', n((c) => tipoSite(c) === 'proprio'), 'com site próprio'],
    ['📱', n((c) => tipoSite(c) === 'social'), 'só Instagram/Facebook'],
    ['🚫', n((c) => tipoSite(c) === 'nenhum'), 'sem site nem rede social'],
    ['⭐', media, `nota média${notas.length < contatos.length ? ` (${contatos.length - notas.length} sem nota)` : ''}`],
    ['📉', n((c) => numNota(c) !== null && numNota(c) < 4), 'com nota abaixo de 4,0'],
    ['✉️', n((c) => c.email), 'com e-mail']
  ];
  return `<div class="raio-x"><b>📊 Raio-X da lista</b> <span class="rotulo">— ${semProprio} de ${contatos.length} (${pct(semProprio)}) não têm site próprio</span><div class="raio-x-itens">${itens.map(([ic, v, t]) => `<span><b>${ic} ${v}</b> ${t}</span>`).join('')}</div></div>`;
}

function barraFiltrosEmpresa(contatos, sel) {
  const unicos = (f) => [...new Set(contatos.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const cidades = unicos((c) => c.cidade);
  const ramos = unicos(ramoDe);
  const select = (k, opcoes) => `<select data-fe="${k}" class="${sel[k] ? 'ativo' : ''}">${opcoes.map(([v, t]) => `<option value="${esc(v)}" ${sel[k] === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const objetivo = `<div class="objetivo-empresa"><span class="rotulo">🎯 O que você vai vender?</span>${OBJETIVOS_EMPRESA.map(([v, t]) => `<button type="button" class="chip-filtro ${(sel.objetivo || '') === v ? 'ativo' : ''}" data-objetivo="${v}">${t}</button>`).join('')}<label class="rotulo ordem-empresa">Ordenar: ${select('ordem', [...(sel.objetivo ? [] : [['', 'Como veio no arquivo']]), ...ORDENS_EMPRESA.filter(([v]) => v !== 'prioridade' || sel.objetivo)])}</label></div>`;
  return `${raioXLista(contatos)}${objetivo}<div class="filtros-empresa">${select('site', OPCOES_FILTRO_EMPRESA.site)}${select('tel', OPCOES_FILTRO_EMPRESA.tel)}${contatos.some((c) => c.nota) ? select('nota', OPCOES_FILTRO_EMPRESA.nota) : ''}${contatos.some((c) => c.avaliacoes) ? select('aval', OPCOES_FILTRO_EMPRESA.aval) : ''}${cidades.length > 1 ? select('cidade', [['', '📍 Cidade: todas'], ...cidades.map((x) => [x, x])]) : ''}${ramos.length > 1 ? select('ramo', [['', '🏷️ Ramo: todos'], ...ramos.map((x) => [x, x])]) : ''}${['site', 'tel', 'nota', 'aval', 'cidade', 'ramo'].some((k) => sel[k]) ? '<button type="button" class="pequeno" data-fe-limpar>✕ Limpar filtros</button>' : ''}</div>`;
}
function passaFiltroEmpresa(c, sel) {
  const t = tipoSite(c);
  if (sel.site === 'semproprio' && t === 'proprio') return false;
  if (sel.site && sel.site !== 'semproprio' && t !== sel.site) return false;
  if (sel.tel === 'cel' && ehFixoContato(c)) return false;
  if (sel.tel === 'fixo' && !ehFixoContato(c)) return false;
  const nota = c.nota ? Number(c.nota) : null;
  if (sel.nota === '45' && !(nota >= 4.5)) return false;
  if (sel.nota === '40' && !(nota >= 4)) return false;
  if (sel.nota === 'baixa' && !(nota !== null && nota < 4)) return false;
  if (sel.nota === 'sem' && nota !== null) return false;
  const av = c.avaliacoes ? Number(c.avaliacoes) : 0;
  if (sel.aval === 'p' && av > 50) return false;
  if (sel.aval === 'm' && (av <= 50 || av > 500)) return false;
  if (sel.aval === 'g' && av <= 500) return false;
  if (sel.cidade && c.cidade !== sel.cidade) return false;
  if (sel.ramo && ramoDe(c) !== sel.ramo) return false;
  return true;
}
function ligarFiltrosEmpresa(raiz, sel, redesenhar) {
  $$('[data-fe]', raiz).forEach((x) => { x.onchange = () => { sel[x.dataset.fe] = x.value; redesenhar(); }; });
  const limpar = $('[data-fe-limpar]', raiz);
  if (limpar) limpar.onclick = () => { ['site', 'tel', 'nota', 'aval', 'cidade', 'ramo'].forEach((k) => { sel[k] = ''; }); redesenhar(); };
  // objetivo: já filtra e ordena por prioridade (vender site → só quem não tem site próprio)
  $$('[data-objetivo]', raiz).forEach((b) => {
    b.onclick = () => {
      const o = b.dataset.objetivo;
      if (sel.objetivo === 'site' && o !== 'site' && sel.site === 'semproprio') sel.site = '';
      sel.objetivo = o;
      sel.ordem = o ? 'prioridade' : '';
      if (o === 'site') sel.site = 'semproprio';
      redesenhar();
    };
  });
}

// números de um ritmo de envio, em palavras
function textoPerfil(pf, prospeccao) {
  const um = (s) => String(Math.round(s * 10) / 10).replace('.', ',');
  const min = (s) => (s >= 3600 ? `${um(s / 3600)} h` : s >= 60 ? `${um(s / 60)} min` : `${s} s`);
  return `${min(pf.intervaloMin)} a ${min(pf.intervaloMax)} entre mensagens${prospeccao ? ` · ${pf.limiteInicial} no 1º dia, +${pf.aumentoDia}/dia até ${pf.tetoDia}` : ''}`;
}

// Cartão de uma empresa da lista: dados (nota, endereço, site, mapa…) e os avisos
const dataCurta = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
function linkDoMapa(c) {
  if (c.mapsUrl && /^https:\/\//.test(c.mapsUrl)) return c.mapsUrl;
  const onde = [c.empresa || c.nome, c.endereco, c.bairro, c.cidade, c.estado].filter(Boolean).join(', ');
  return onde ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(onde)}` : '';
}
function avisoDisparos(disparos, quem = 'Já recebeu') {
  if (!disparos?.length) return '';
  const [d] = disparos;
  return `<span class="etiqueta aviso" title="${esc(disparos.map((x) => `${x.nome} (${dataCurta(x.em)})`).join(' · '))}">⚠️ ${quem} disparo em ${esc(dataCurta(d.em))}: ${esc(d.nome)}${disparos.length > 1 ? ` +${disparos.length - 1}` : ''}</span>`;
}
function cartaoContato(c, chips = '') {
  const cortado = (k) => (c.cortados || []).includes(k);
  const site = c.site ? (cortado('site') || !/^https?:\/\//i.test(c.site)
    ? `<span title="Veio cortado no PDF">🌐 ${esc(c.site.replace(/^https?:\/\/(www\.)?/i, ''))}…</span>`
    : `<a href="${esc(c.site)}" target="_blank" rel="noopener noreferrer">🌐 ${esc(c.site.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))}</a>`) : '';
  const mapa = linkDoMapa(c);
  const local = [c.endereco ? `${esc(c.endereco)}${cortado('endereco') ? '…' : ''}` : '', esc(c.bairro || ''), [c.cidade, c.estado].filter(Boolean).map(esc).join(' - ')].filter(Boolean).join(', ');
  return `<div class="contato-card">
    <div class="contato-topo"><strong>${esc(c.empresa || c.nome || 'Sem nome')}${cortado('empresa') ? '…' : ''}</strong>${c.nota ? `<span class="contato-nota">⭐ ${esc(String(c.nota).replace('.', ','))}${c.avaliacoes ? ` <span class="rotulo">(${esc(Number(c.avaliacoes).toLocaleString('pt-BR'))})</span>` : ''}</span>` : ''}</div>
    ${c.nome && c.empresa && c.nome !== c.empresa ? `<div class="rotulo">👤 ${esc(c.nome)}</div>` : ''}
    <div class="contato-linha">📞 <b>${esc((c.analise ? c.telefone : telefoneBonito(c.telefone)) || '—')}</b>${c.fixo || c.analise?.fixo ? ' <span class="rotulo">(fixo)</span>' : ''}</div>
    ${local ? `<div class="contato-linha">📍 ${local}</div>` : ''}
    ${c.ramo || c.categorias ? `<div class="contato-linha rotulo">🏷️ ${esc(c.categorias || c.ramo)}</div>` : ''}
    ${c.email ? `<div class="contato-linha">✉️ ${esc(c.email)}</div>` : ''}
    ${site || mapa ? `<div class="contato-linha contato-links">${site}${mapa ? `<a href="${esc(mapa)}" target="_blank" rel="noopener noreferrer">🗺️ Ver no mapa</a>` : ''}</div>` : ''}
    ${chips ? `<div class="chips contato-chips">${chips}</div>` : ''}
  </div>`;
}
// avisos da prévia (antes de importar)
function chipsDaAnalise(a) {
  const lead = a.lead ? `<a href="#/leads/${esc(a.lead.id)}">${esc(a.lead.nome || 'lead')}</a>` : '';
  const SIT = {
    novo: '<span class="etiqueta ok">✅ novo — vai entrar</span>',
    existe: `<span class="etiqueta">👤 já está no CRM: ${lead}${a.lead?.lista ? ` (lista ${esc(a.lead.lista)})` : a.lead?.etapa ? ` (${esc(a.lead.etapa)})` : ''} — não entra de novo</span>`,
    repetido: '<span class="etiqueta">🔁 repetido no arquivo</span>',
    fixo: '<span class="etiqueta off">☎️ telefone fixo — fica de fora (marque "Incluir telefone fixo")</span>',
    invalido: '<span class="etiqueta off">sem telefone válido</span>'
  };
  return [
    SIT[a.situacao] || '',
    avisoDisparos(a.disparos, a.parecido && !a.lead ? 'Mesma empresa já recebeu' : 'Já recebeu'),
    a.parecido ? `<span class="etiqueta aviso">⚠️ empresa com o mesmo nome já no CRM com outro número: <a href="#/leads/${esc(a.parecido.id)}">${esc(a.parecido.nome || 'ver')}</a></span>` : '',
    a.lead?.respondeu ? '<span class="etiqueta">💬 já conversou</span>' : '',
    a.lead?.naoDisparar ? '<span class="etiqueta off">🚫 pediu para não receber</span>' : ''
  ].join('');
}

// 📋 Listas de contatos (aba Disparos): importar PDF/planilha/CSV e ver as listas
async function paginaListasContatos(id, params = new URLSearchParams()) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/disparos-listas`);
  const ver = params.get('ver');
  if (ver) return paginaDetalheLista(id, ver, d, params);
  const aba = params.get('aba') === 'importar' || !d.listas.length ? 'importar' : 'listas';
  const abas = [[rotaEmpresa(id, 'disparos/listas'), `Minhas listas <span class="rotulo">${d.listas.length}</span>`, aba === 'listas'], [`${rotaEmpresa(id, 'disparos/listas')}?aba=importar`, '⬆️ Importar lista', aba === 'importar']];
  if (location.hash !== hashDaPagina) return;
  const htmlListas = d.listas.length ? `
    <div class="card tabela-wrap"><table>
      <thead><tr><th>Lista</th><th>Contatos</th><th class="esconde-mobile">Já receberam disparo</th><th class="esconde-mobile">Responderam</th><th class="esconde-mobile">Sem WhatsApp / saíram</th><th></th></tr></thead>
      <tbody>${d.listas.map((l) => `<tr class="clicavel" data-ver-lista="${esc(l.id)}">
        <td><strong>${esc(l.nome)}</strong><br><span class="rotulo">${esc(data(l.criadoEm))} · ${l.importados} importados${l.fixos ? ` · ${l.fixos} fixos de fora` : ''}${l.repetidos ? ` · ${l.repetidos} já existiam` : ''}</span></td>
        <td>${l.contatos}</td>
        <td class="esconde-mobile">${l.disparados || 0}</td>
        <td class="esconde-mobile">${l.responderam}</td>
        <td class="esconde-mobile">${l.semWhatsapp} / ${l.sairam}</td>
        <td style="white-space:nowrap"><a class="botao pequeno" href="${rotaEmpresa(id, `disparos/listas?ver=${encodeURIComponent(l.id)}`)}">👁️ Ver</a> <a class="botao pequeno primario" href="${rotaEmpresa(id, `disparos/novo?lista=${encodeURIComponent(l.id)}`)}">🚀 Disparar</a> <button type="button" class="pequeno perigo" data-apagar-lista="${esc(l.id)}" title="Apagar lista">✕</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="card vazio">Nenhuma lista ainda.</div>';
  const htmlImportar = `
    <div class="card">
      <h2 style="margin-top:0">⬆️ Importar lista de contatos</h2>
      ${balao('Como trazer a lista', 'Envie o arquivo: <b>CSV</b>, <b>JSON</b> ou <b>PDF</b> (ex.: o que você baixa no Apify / Google Maps Scraper). O CRM separa cada empresa com nome, telefone, nota, endereço, cidade, site e categorias. Também dá para copiar da planilha e colar <b>com a linha de títulos</b>. Antes de importar você vê cada contato separado e o aviso de quem <b>já recebeu disparo</b>. <i>Excel (.xlsx): baixe como CSV.</i>')}
      <div class="campos">
        <div class="campo"><label>Nome da lista *</label><input id="lista-nome" maxlength="80" placeholder="Ex.: Restaurantes de Miguel Pereira"></div>
        <div class="campo"><label>Etiqueta (opcional)</label><select id="lista-etiqueta"><option value="">Nenhuma</option>${(emp.etiquetas || []).map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select></div>
      </div>
      <div class="acoes" style="margin-top:10px"><label class="botao primario">📄 Enviar arquivo (CSV, JSON ou PDF)<input type="file" id="lista-arquivo" hidden accept=".csv,.json,.jsonl,.txt,.pdf,.tsv,text/csv,application/json,text/plain,application/pdf"></label></div>
      <details style="margin-top:10px" id="lista-colar"><summary>📋 Ou colar a planilha</summary>
        <textarea id="lista-texto" style="margin-top:8px;min-height:160px;font-family:ui-monospace,monospace;font-size:13px;width:100%" placeholder="Empresa	Nome	Telefone	Cidade	Ramo&#10;Lava Rápido Sol	João	(21) 98888-0001	Niterói	lava-jato"></textarea>
      </details>
      <label class="linha-check" style="margin-top:10px"><input type="checkbox" id="lista-fixos" checked> Incluir telefone fixo ${ajuda('Algumas empresas usam WhatsApp Business no número fixo. No disparo de prospecção o CRM confere antes de mandar: quem não tem WhatsApp fica de fora.')}</label>
      <div id="lista-previa"></div>
      <p class="rotulo" style="margin:10px 0 0">Use listas de <b>contato comercial de empresas</b>, com uma oferta que faça sentido para elas. Quem responder SAIR não recebe mais. Para lista fria, prefira um número separado do principal.</p>
      <div class="acoes"><button type="button" class="primario" id="lista-importar" disabled>Importar</button></div>
    </div>`;
  conteudo.innerHTML = cascaDisparos(id, 'listas', `
    <div class="cabecalho"><div><h1>📋 Listas de contatos</h1><p class="sub">Contatos para disparo de prospecção — cada empresa vira um lead com telefone, endereço, nota e site</p></div></div>
    ${aba === 'importar' ? htmlImportar : htmlListas}`, abas);
  $$('tr[data-ver-lista]').forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a,button')) return; location.hash = rotaEmpresa(id, `disparos/listas?ver=${encodeURIComponent(tr.dataset.verLista)}`); }; });
  $$('[data-apagar-lista]').forEach((b) => {
    b.onclick = async () => {
      const l = d.listas.find((x) => x.id === b.dataset.apagarLista);
      if (!(await confirmar({ titulo: `Apagar a lista "${l.nome}"?`, texto: `Os contatos dela que <b>nunca responderam</b> saem do CRM. Quem respondeu continua nos Leads/Conversas.`, botao: 'Apagar', perigo: true }))) return;
      try { const r = await api(`empresas/${id}/disparos-listas/${l.id}`, { method: 'DELETE' }); aviso(`Lista apagada: ${r.removidos} contato(s) saíram${r.ficaram ? `, ${r.ficaram} que conversaram ficaram` : ''}.`); paginaListasContatos(id, params); } catch (err) { aviso(err.message, true); }
    };
  });
  if (aba !== 'importar') return;

  let contatos = []; // já analisados pelo servidor (novo, já existe, já recebeu disparo…)
  let origem = '';
  let filtroPrevia = 'todos';
  const selEmp = {};
  const filtrados = () => contatos.filter((c) => passaFiltroEmpresa(c, selEmp));
  const filtroAtivo = () => Object.values(selEmp).some(Boolean);
  const novos = () => filtrados().filter((c) => c.analise.situacao === 'novo');
  const desenhar = () => {
    const box = $('#lista-previa');
    if (!box) return;
    const n = novos().length;
    $('#lista-importar').disabled = !n;
    $('#lista-importar').textContent = n ? `Importar ${n} contato${n === 1 ? '' : 's'} novo${n === 1 ? '' : 's'}${filtroAtivo() ? ' (só os do filtro)' : ''}` : 'Importar';
    if (!contatos.length) { box.innerHTML = ''; return; }
    const conta = (f) => contatos.filter(f).length;
    const jaDisp = (c) => c.analise.disparos.length > 0;
    const FILTROS = [['todos', 'Todos', () => true], ['novo', '✅ Novos', (c) => c.analise.situacao === 'novo'], ['disparo', '⚠️ Já receberam disparo', jaDisp], ['existe', '👤 Já no CRM', (c) => c.analise.situacao === 'existe'], ['fixo', '☎️ Fixos', (c) => c.analise.fixo], ['fora', 'Ficam de fora', (c) => c.analise.situacao !== 'novo']];
    const nDisp = conta(jaDisp);
    const base = filtrados();
    const visiveis = ordenarEmpresas(base.filter((FILTROS.find((f) => f[0] === filtroPrevia) || FILTROS[0])[2]), selEmp);
    box.innerHTML = `
      <div class="previa-resumo">
        <div><strong>${contatos.length}</strong><span class="rotulo">encontrados${origem ? ` no ${esc(origem)}` : ''}</span></div>
        <div><strong>${n}</strong><span class="rotulo">novos (vão entrar)</span></div>
        <div><strong>${conta((c) => c.analise.situacao === 'existe')}</strong><span class="rotulo">já no CRM</span></div>
        <div class="${nDisp ? 'aviso-num' : ''}"><strong>${nDisp}</strong><span class="rotulo">já receberam disparo</span></div>
        <div><strong>${conta((c) => c.analise.fixo)}</strong><span class="rotulo">telefone fixo</span></div>
      </div>
      ${nDisp ? balao(`${nDisp} ${nDisp === 1 ? 'empresa já recebeu' : 'empresas já receberam'} disparo em massa`, 'Elas estão marcadas com ⚠️ abaixo, com a data e o nome do disparo. Quem já está no CRM não entra de novo nesta lista, e no disparo você pode marcar para <b>não mandar de novo</b> para quem já recebeu.', 'aviso') : ''}
      <h3 style="margin:14px 0 0">🔎 Separar as empresas</h3>
      ${barraFiltrosEmpresa(contatos, selEmp)}
      ${filtroAtivo() ? `<p class="rotulo" style="margin:0">Filtro: <b>${base.length} de ${contatos.length}</b> empresas. Só as do filtro entram na lista.</p>` : ''}
      <div class="chips" style="margin:12px 0">${FILTROS.map(([k, nome, f]) => `<button type="button" class="chip-filtro ${k === filtroPrevia ? 'ativo' : ''}" data-filtro-previa="${k}">${nome} <span class="rotulo">${base.filter(f).length}</span></button>`).join('')}</div>
      <div class="contato-grid">${visiveis.slice(0, 300).map((c) => cartaoContato(c, seloPrioridade(c, selEmp.objetivo) + chipsDaAnalise(c.analise))).join('') || '<p class="rotulo">Nenhum contato neste filtro.</p>'}</div>
      ${visiveis.length > 300 ? `<p class="rotulo">Mostrando 300 de ${visiveis.length}.</p>` : ''}`;
    $$('[data-filtro-previa]', box).forEach((b) => { b.onclick = () => { filtroPrevia = b.dataset.filtroPrevia; desenhar(); }; });
    ligarFiltrosEmpresa(box, selEmp, desenhar);
  };
  const analisarTexto = async () => {
    const txt = $('#lista-texto').value;
    origem = 'texto colado';
    if (!txt.trim()) { contatos = []; desenhar(); return; }
    const r = await api(`empresas/${id}/disparos-listas/ler-texto`, { method: 'POST', body: { texto: txt, incluirFixos: $('#lista-fixos').checked } });
    contatos = r.contatos;
    desenhar();
    if (!contatos.length) $('#lista-previa').innerHTML = '<p class="rotulo texto-erro">Não achei telefones. Confira se tem a coluna de telefone (com DDD).</p>';
  };
  // arquivo: PDF, CSV ou JSON — o servidor lê e já diz quem é novo / já recebeu disparo
  let arquivoAtual = null;
  const lerArquivo = async (arq) => {
    $('#lista-previa').innerHTML = `<p class="rotulo">📄 Lendo ${esc(arq.name)} e separando os contatos…</p>`;
    const r = await fetch(`api/empresas/${id}/disparos-listas/arquivo?nome=${encodeURIComponent(arq.name)}${$('#lista-fixos').checked ? '&fixos=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arq });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || (r.status === 413 ? 'O arquivo é grande demais (máximo 40 MB).' : 'Não consegui ler o arquivo.'));
    contatos = j.contatos;
    origem = j.formato === 'PDF' ? `PDF (${j.paginas} página${j.paginas === 1 ? '' : 's'})` : `${j.formato || 'arquivo'} ${esc(arq.name)}`;
    desenhar();
  };
  let espera = null;
  $('#lista-texto').addEventListener('input', () => { arquivoAtual = null; clearTimeout(espera); espera = setTimeout(() => analisarTexto().catch((err) => aviso(err.message, true)), 400); });
  $('#lista-fixos').onchange = () => (arquivoAtual ? lerArquivo(arquivoAtual) : analisarTexto()).catch((err) => aviso(err.message, true));
  $('#lista-arquivo').onchange = async (e) => {
    const arq = e.target.files[0];
    e.target.value = '';
    if (!arq) return;
    if (arq.size > 40 * 1024 * 1024) return aviso('O arquivo tem mais de 40 MB. No Apify, baixe sem as avaliações (reviews) ou em partes.', true);
    arquivoAtual = arq;
    if (!$('#lista-nome').value) $('#lista-nome').value = arq.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').slice(0, 80);
    try { await lerArquivo(arq); } catch (err) { $('#lista-previa').innerHTML = `<p class="texto-erro">${esc(err.message)}</p>`; contatos = []; $('#lista-importar').disabled = true; }
  };
  $('#lista-importar').onclick = async (e) => {
    const nome = $('#lista-nome').value.trim();
    if (!nome) return aviso('Dê um nome para a lista.', true);
    try {
      const enviar = filtrados().map(({ analise, ...c }) => c);
      const r = await comEspera(e.currentTarget, () => api(`empresas/${id}/disparos-listas`, { method: 'POST', body: { nome, etiquetaId: $('#lista-etiqueta').value, incluirFixos: $('#lista-fixos').checked, contatos: enviar } }), 'Importando…');
      aviso(`${r.importados} importados${r.fixos ? ` · ${r.fixos} fixos de fora` : ''}${r.repetidos ? ` · ${r.repetidos} já existiam` : ''}${r.jaDisparados ? ` (${r.jaDisparados} desses já tinham recebido disparo)` : ''}${r.invalidos ? ` · ${r.invalidos} sem telefone válido` : ''}.`);
      location.hash = rotaEmpresa(id, `disparos/listas?ver=${encodeURIComponent(r.id)}`);
    } catch (err) { aviso(err.message, true); }
  };
}

// 👁️ Uma lista: a ficha de cada empresa (dados + o que já aconteceu: disparo, resposta…)
async function paginaDetalheLista(id, listaId, d, params) {
  const hashDaPagina = location.hash;
  const r = await api(`empresas/${id}/disparos-listas/${encodeURIComponent(listaId)}`);
  if (location.hash !== hashDaPagina) return;
  const l = r.lista;
  const abas = [[rotaEmpresa(id, 'disparos/listas'), `Minhas listas <span class="rotulo">${d.listas.length}</span>`, true], [`${rotaEmpresa(id, 'disparos/listas')}?aba=importar`, '⬆️ Importar lista', false]];
  const jaDisp = (c) => c.disparos.length > 0;
  const FILTROS = [['todos', 'Todos', () => true], ['nao', '⏳ Não receberam disparo', (c) => !jaDisp(c) && !c.naoDisparar], ['ja', '📣 Já receberam', jaDisp], ['resp', '💬 Responderam', (c) => c.respondeu], ['semzap', '❌ Sem WhatsApp', (c) => c.temWhatsapp === false], ['sair', '🚫 Pediram para sair', (c) => c.naoDisparar]];
  let filtro = FILTROS.some((f) => f[0] === params.get('f')) ? params.get('f') : 'todos';
  let busca = '';
  const selEmp = {};
  const chips = (c) => [
    c.disparos.length ? avisoDisparos(c.disparos) : '<span class="etiqueta">⏳ ainda não recebeu disparo</span>',
    c.temWhatsapp === true ? '<span class="etiqueta ok">✅ tem WhatsApp</span>' : c.temWhatsapp === false ? '<span class="etiqueta off">❌ sem WhatsApp</span>' : '',
    c.respondeu ? '<span class="etiqueta ok">💬 respondeu</span>' : '',
    c.naoDisparar ? '<span class="etiqueta off">🚫 pediu para não receber</span>' : '',
    c.parecido ? `<span class="etiqueta aviso">⚠️ mesmo nome de empresa com outro número: <a href="#/leads/${esc(c.parecido.id)}">${esc(c.parecido.nome || 'ver')}</a>${c.parecido.disparos?.length ? ` (recebeu disparo em ${esc(dataCurta(c.parecido.disparos[0].em))})` : ''}</span>` : '',
    `<a class="etiqueta" href="#/leads/${esc(c.id)}">abrir lead${c.etapa ? ` · ${esc(c.etapa)}` : ''} →</a>`
  ].join('');
  conteudo.innerHTML = cascaDisparos(id, 'listas', `
    <div class="cabecalho"><div><a class="rotulo" href="${rotaEmpresa(id, 'disparos/listas')}">← Minhas listas</a><h1>📋 ${esc(l.nome)}</h1><p class="sub">${l.contatos} contatos · importada em ${esc(data(l.criadoEm))}</p></div><a class="botao primario" href="${rotaEmpresa(id, `disparos/novo?lista=${encodeURIComponent(l.id)}`)}">🚀 Disparar para esta lista</a></div>
    <div class="previa-resumo">
      <div><strong>${l.contatos}</strong><span class="rotulo">contatos</span></div>
      <div class="${l.disparados ? 'aviso-num' : ''}"><strong>${l.disparados || 0}</strong><span class="rotulo">já receberam disparo</span></div>
      <div><strong>${l.responderam}</strong><span class="rotulo">responderam</span></div>
      <div><strong>${l.semWhatsapp}</strong><span class="rotulo">sem WhatsApp</span></div>
      <div><strong>${l.sairam}</strong><span class="rotulo">pediram para sair</span></div>
    </div>
    ${(() => {
      const livres = r.contatos.filter((c) => !jaDisp(c) && !c.naoDisparar && c.temWhatsapp !== false);
      const n = (f) => livres.filter(f).length;
      const cats = [['nenhum', '🚫 Sem site nem rede social', (c) => tipoSite(c) === 'nenhum'], ['social', '📱 Só Instagram/Facebook', (c) => tipoSite(c) === 'social'], ['semproprio', '🎯 Sem site próprio (os dois)', (c) => tipoSite(c) !== 'proprio'], ['proprio', '🌐 Já têm site', (c) => tipoSite(c) === 'proprio']];
      return `<div class="card categorias-lista-card"><h2 style="margin:0 0 4px">🗂️ Separar por categoria e disparar</h2><p class="rotulo" style="margin:0 0 10px">Contam só quem ainda não recebeu disparo e tem WhatsApp. Clique para disparar só para aquele grupo — a lista continua inteira aqui.</p><div class="cat-botoes">${cats.map(([k, nome, f]) => `<a class="cat-botao ${n(f) ? '' : 'vazio'}" href="${rotaEmpresa(id, `disparos/novo?lista=${encodeURIComponent(l.id)}&site=${k}`)}"><b>${n(f)}</b><span>${nome}</span><small>🚀 Disparar</small></a>`).join('')}</div></div>`;
    })()}
    <div class="linha-form" style="margin:12px 0;flex-wrap:wrap"><input id="busca-lista" placeholder="🔎 Buscar por nome, cidade, telefone…" style="flex:1;min-width:200px"></div>
    <div id="filtros-empresa-lista"></div>
    <div class="chips" id="filtros-lista" style="margin-bottom:12px"></div>
    <div id="disparar-filtrados" style="margin-bottom:12px"></div>
    <div class="contato-grid" id="grade-lista"></div>`, abas);
  const desenhar = () => {
    const q = busca.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const f = (FILTROS.find((x) => x[0] === filtro) || FILTROS[0])[2];
    const base = r.contatos.filter((c) => passaFiltroEmpresa(c, selEmp));
    $('#filtros-empresa-lista').innerHTML = barraFiltrosEmpresa(r.contatos, selEmp);
    ligarFiltrosEmpresa($('#filtros-empresa-lista'), selEmp, desenhar);
    const lista = ordenarEmpresas(base, selEmp).filter(f).filter((c) => !q || [c.empresa, c.nome, c.cidade, c.endereco, c.bairro, c.telefone, c.ramo, c.categorias].join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(q) || String(c.telefone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§'));
    // os botões de categoria levam a ordem escolhida aqui (ex.: menos avaliações primeiro)
    const ordemEnvio = selEmp.ordem && selEmp.ordem !== 'prioridade' ? selEmp.ordem : selEmp.objetivo === 'site' ? 'prioridade-site' : selEmp.objetivo === 'reputacao' ? 'nota-baixa' : '';
    $$('.cat-botao').forEach((a) => { const u = new URL(a.href); const q = new URLSearchParams(u.hash.split('?')[1] || ''); if (ordemEnvio) q.set('ordem', ordemEnvio); else q.delete('ordem'); a.href = `${u.hash.split('?')[0]}?${q}`; });
    $('#filtros-lista').innerHTML = FILTROS.map(([k, nome, fx]) => `<button type="button" class="chip-filtro ${k === filtro ? 'ativo' : ''}" data-filtro="${k}">${nome} <span class="rotulo">${base.filter(fx).length}</span></button>`).join('');
    // disparar só para os que estão na tela (e nunca receberam disparo)
    const alvo = lista.filter((c) => !jaDisp(c) && !c.parecido?.disparos?.length && !c.naoDisparar && c.temWhatsapp !== false);
    const filtrando = Boolean(q) || filtro !== 'todos' || Object.values(selEmp).some(Boolean);
    $('#disparar-filtrados').innerHTML = filtrando ? (alvo.length ? `<button type="button" class="primario" id="btn-disparar-filtrados">🛡️ Disparar só para estes ${alvo.length} ${alvo.length === 1 ? 'contato' : 'contatos'}</button> <span class="rotulo">${selEmp.objetivo || selEmp.ordem ? 'na ordem da tela (o primeiro recebe primeiro) · ' : ''}quem já recebeu disparo fica de fora</span>` : '<span class="rotulo">Ninguém aqui para disparar (todos já receberam, saíram ou não têm WhatsApp).</span>') : '';
    const bt = $('#btn-disparar-filtrados');
    if (bt) bt.onclick = () => { try { sessionStorage.setItem('disparo_leads', JSON.stringify(alvo.map((c) => c.id))); } catch { /* sem sessionStorage */ } location.hash = rotaEmpresa(id, 'disparos/novo'); };
    $$('[data-filtro]').forEach((b) => { b.onclick = () => { filtro = b.dataset.filtro; desenhar(); }; });
    $('#grade-lista').innerHTML = lista.slice(0, 500).map((c) => cartaoContato(c, seloPrioridade(c, selEmp.objetivo) + chips(c))).join('') || '<p class="rotulo">Nenhum contato aqui.</p>';
  };
  $('#busca-lista').addEventListener('input', (e) => { busca = e.target.value.trim(); desenhar(); });
  desenhar();
}

// 💰 Disparo de cobrança: clientes com mensalidade recebem a cobrança no vencimento (Pix/link)
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nomeMes = (comp) => `${MES_CURTO[Number(comp.slice(5, 7)) - 1]}/${comp.slice(2, 4)}`;
const diaMes = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

async function paginaCobranca(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  let d = await api(`empresas/${id}/cobrancas`);
  if (location.hash !== hashDaPagina) return;
  let editando = null; // id do cliente no formulário ('novo' = cadastro)

  const statusDe = (c) => {
    const s = c.situacao;
    const chips = [];
    // o mês de agora já pago (a tela passou para o próximo): continua aparecendo
    if (s.competencia !== d.mes && (c.pagos || {})[d.mes]) chips.push(`<span class="etiqueta ok">✅ ${nomeMes(d.mes)} pago</span>`);
    if (c.ativo === false) chips.push('<span class="etiqueta">⏸️ Pausado</span>');
    else if (s.pago) chips.push(`<span class="etiqueta ok">✅ ${nomeMes(s.competencia)} pago</span>`);
    else if (s.enviado) chips.push(`<span class="etiqueta ${s.atrasado ? 'aviso' : ''}">📤 Cobrança de ${nomeMes(s.competencia)} enviada ${diaMes(s.enviado.em.slice(0, 10))}${s.atrasado ? ' — em aberto' : ''}</span>`);
    else chips.push(`<span class="etiqueta">⏳ Cobra em ${diaMes(s.diaEnvio)} (vence ${diaMes(s.vencimento)})</span>`);
    for (const k of s.emAberto || []) chips.push(`<button type="button" class="etiqueta aviso chip-botao" data-pago-mes="${esc(k)}" data-cli="${esc(c.id)}" title="Clique para marcar como pago">⚠️ ${nomeMes(k)} em aberto · marcar pago</button>`);
    if (c.ultimoErro) chips.push(`<span class="etiqueta off" title="${esc(c.ultimoErro.motivo)}">❌ A cobrança não saiu: ${esc(c.ultimoErro.motivo.slice(0, 60))}</span>`);
    return chips.join('');
  };
  const formCliente = (c = {}) => `
    <form class="cob-form" id="f-cob-cliente">
      <h3 style="margin:0 0 8px">${c.id ? '✏️ Editar cliente' : '➕ Novo cliente de cobrança'}</h3>
      <div class="campos">
        <div class="campo"><label>Nome *</label><input name="nome" required maxlength="120" value="${esc(c.nome || '')}" placeholder="Ex.: Ana Souza"></div>
        <div class="campo"><label>WhatsApp com DDD *</label><input name="telefone" required inputmode="tel" value="${esc(c.telefone ? telefoneBonito(c.telefone) : '')}" placeholder="(24) 99999-9999"></div>
      </div>
      <div class="campos">
        <div class="campo"><label>Valor da mensalidade (R$) *</label><input name="valor" required inputmode="decimal" value="${c.valor ? esc(String(c.valor).replace('.', ',')) : ''}" placeholder="150,00"></div>
        <div class="campo"><label>Vence todo dia *</label><select name="diaVencimento">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${Number(c.diaVencimento || 10) === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>
      </div>
      <div class="campo"><label>O que é (opcional)</label><input name="descricao" maxlength="120" value="${esc(c.descricao || '')}" placeholder="Ex.: plano mensal do CRM"><small>Aparece na mensagem: "mensalidade <b>de plano mensal do CRM</b>".</small></div>
      <details style="margin-top:8px" ${c.link ? 'open' : ''}><summary>Link de pagamento só deste cliente (opcional)</summary><div class="campo" style="margin-top:6px"><input name="link" maxlength="500" value="${esc(c.link || '')}" placeholder="https://… (se vazio, usa o link padrão)"></div></details>
      <div class="acoes"><button type="button" data-cancelar-cli>Cancelar</button><button type="submit" class="primario">${c.id ? 'Salvar' : 'Adicionar cliente'}</button></div>
    </form>`;

  function desenhar() {
    const cfg = d.config;
    const semPagamento = !cfg.pix && !cfg.link && !d.clientes.some((c) => c.link);
    const t = d.totais;
    const lista = d.clientes.slice().sort((a, b) => (a.ativo === false) - (b.ativo === false) || a.situacao.diaEnvio.localeCompare(b.situacao.diaEnvio));
    conteudo.innerHTML = cascaDisparos(id, 'cobranca', `
      <div class="cabecalho"><div><h1>💰 Disparo de cobrança</h1><p class="sub">Cadastre os clientes com mensalidade: todo mês, no vencimento, o CRM manda a cobrança pelo WhatsApp com o Pix ou o link de pagamento</p></div></div>
      ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `As cobranças saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
      ${semPagamento ? balao('Falta dizer como o cliente paga', 'Coloque a <b>chave Pix</b> e/ou o <b>link de pagamento</b> em "Mensagem e pagamento", aqui embaixo.', 'aviso') : ''}
      <div class="previa-resumo">
        <div><strong>${t.ativos}</strong><span class="rotulo">clientes ativos</span></div>
        <div><strong>${brl(t.mensal)}</strong><span class="rotulo">por mês</span></div>
        <div><strong>${t.enviadasMes}</strong><span class="rotulo">cobranças enviadas em ${nomeMes(d.mes)}</span></div>
        <div><strong>${t.pagasMes}</strong><span class="rotulo">pagas em ${nomeMes(d.mes)} (${brl(t.recebidoMes)})</span></div>
      </div>
      <div class="card">
        <div class="cob-topo"><h2 style="margin:0">👥 Clientes de cobrança</h2>${editando === 'novo' ? '' : '<button type="button" class="primario" data-novo-cli>+ Adicionar cliente</button>'}</div>
        ${editando === 'novo' ? formCliente() : ''}
        ${lista.length ? `<div class="contato-grid" style="margin-top:12px">${lista.map((c) => (editando === c.id ? `<div class="contato-card">${formCliente(c)}</div>` : `
          <div class="contato-card ${c.ativo === false ? 'cob-pausado' : ''}">
            <div class="contato-topo"><strong>${esc(c.nome)}</strong><span class="contato-nota">${brl(c.valor)}</span></div>
            <div class="contato-linha">📞 ${esc(telefoneBonito(c.telefone))}</div>
            <div class="contato-linha">📅 Vence todo dia <b>${c.diaVencimento}</b>${c.descricao ? ` · ${esc(c.descricao)}` : ''}</div>
            <div class="chips contato-chips">${statusDe(c)}</div>
            <div class="cob-acoes">
              ${c.situacao.competencia !== d.mes && (c.pagos || {})[d.mes] ? `<button type="button" class="pequeno" data-desfazer-mes="${esc(d.mes)}" data-cli="${esc(c.id)}">↩️ Desfazer ${nomeMes(d.mes)} pago</button>` : ''}
              ${c.ativo === false ? '' : c.situacao.pago ? `<button type="button" class="pequeno" data-pago="0" data-cli="${esc(c.id)}">↩️ Desfazer pago</button>` : `<button type="button" class="pequeno primario" data-pago="1" data-cli="${esc(c.id)}">✅ Marcar ${nomeMes(c.situacao.competencia)} pago</button>`}
              ${c.ativo === false ? '' : `<button type="button" class="pequeno" data-enviar-cli="${esc(c.id)}">📤 Enviar agora</button>`}
              <button type="button" class="pequeno" data-editar-cli="${esc(c.id)}">✏️ Editar</button>
              <button type="button" class="pequeno" data-ativo="${c.ativo === false ? '1' : '0'}" data-cli="${esc(c.id)}">${c.ativo === false ? '▶️ Retomar' : '⏸️ Pausar'}</button>
              <button type="button" class="pequeno perigo" data-apagar-cli="${esc(c.id)}" title="Tirar da cobrança">✕</button>
            </div>
          </div>`)).join('')}</div>` : editando === 'novo' ? '' : '<p class="rotulo" style="margin:12px 0 0">Nenhum cliente ainda. Clique em "+ Adicionar cliente".</p>'}
      </div>
      <form class="card" id="f-cob-config">
        <h2 style="margin-top:0">✉️ Mensagem e pagamento</h2>
        <div class="editor-cob">
          <div>
            <div class="campos">
              <div class="campo"><label>Chave Pix</label><input name="pix" maxlength="140" value="${esc(cfg.pix)}" placeholder="CNPJ, e-mail, celular ou chave aleatória"></div>
              <div class="campo"><label>Nome de quem recebe (opcional)</label><input name="pixNome" maxlength="80" value="${esc(cfg.pixNome)}" placeholder="Ex.: Loja X Ltda"></div>
            </div>
            <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="pixSeparado" ${cfg.pixSeparado ? 'checked' : ''}> Mandar a chave Pix numa mensagem separada ${ajuda('Assim o cliente segura o dedo na mensagem e copia só a chave.')}</label>
            <div class="campo" style="margin-top:10px"><label>Link de pagamento (opcional)</label><input name="link" maxlength="500" value="${esc(cfg.link)}" placeholder="https://… (Mercado Pago, PagSeguro, Asaas…)"></div>
            <div class="campo" style="margin-top:12px"><label>Mensagem</label>
              <div class="botoes-variavel"><button type="button" class="pequeno" data-var="{nome}">👤 Nome</button><button type="button" class="pequeno" data-var="{valor}">💵 Valor</button><button type="button" class="pequeno" data-var="{vencimento}">📅 Vencimento</button><button type="button" class="pequeno" data-var="{descricao}" title="vira ' de plano mensal…' (o que você escreveu no cliente)">📝 O que é</button><button type="button" class="pequeno" data-var="{pagamento}" title="o link e/ou o aviso da chave Pix">💳 Como pagar</button><button type="button" class="pequeno" data-var="{Olá|Oi}">👋 Saudação variada</button></div>
              <textarea name="mensagem" style="min-height:150px">${esc(cfg.mensagem)}</textarea>
              <small>Sai exatamente esse texto (sem IA), trocando as partes entre chaves. Se tirar o <code>{pagamento}</code>, o Pix/link vai no fim mesmo assim. <a href="#" data-msg-padrao>Voltar para a mensagem padrão</a></small>
            </div>
            <div class="campos" style="margin-top:12px">
              <div class="campo"><label>Quando cobrar</label><select name="diasAntes">${[0, 1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${cfg.diasAntes === n ? 'selected' : ''}>${n ? `${n} dia${n === 1 ? '' : 's'} antes do vencimento` : 'No dia do vencimento'}</option>`).join('')}</select></div>
              <div class="campo"><label>A partir de que horas</label><select name="hora">${Array.from({ length: 13 }, (_, i) => i + 7).map((h) => `<option value="${h}" ${cfg.hora === h ? 'selected' : ''}>${h}h</option>`).join('')}</select></div>
            </div>
            <label class="linha-check" style="margin-top:10px"><input type="checkbox" name="iaResponde" ${cfg.iaResponde ? 'checked' : ''}> A IA responde quando o cliente responder a cobrança ${ajuda('Desmarcado (recomendado): a IA fica pausada na conversa do cliente de cobrança e a equipe atende ("paguei", "posso pagar dia 15?"…).')}</label>
            <div class="acoes"><button type="submit" class="primario">Salvar mensagem e pagamento</button></div>
          </div>
          <div class="card teste whatsapp previa-disparo cob-previa">
            <div class="cab"><span>Prévia no WhatsApp</span></div>
            <div class="chat">${d.exemplo.map((t) => `<div class="msg bot">${esc(t).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')}</div>`).join('')}<div class="msg acao-ia">Exemplo com ${d.clientes[0] ? 'o primeiro cliente' : 'um cliente de teste'}. Atualiza quando você salva.</div></div>
          </div>
        </div>
      </form>
      <div class="card"><h2 style="margin-top:0">Como funciona</h2><ul class="lista-simples">
        <li>📅 Todo mês, no dia de cobrar (a partir do horário escolhido), o CRM manda a mensagem para cada cliente ativo — <b>uma vez por mês</b>.</li>
        <li>✅ Marcou <b>pago</b> antes do dia? Aquele mês não é cobrado.</li>
        <li>⏸️ <b>Pausar</b> para de cobrar o cliente até você retomar.</li>
        <li>💬 A mensagem aparece na conversa do cliente em Conversas; quando ele responder, ${cfg.iaResponde ? 'a IA responde' : '<b>a equipe atende</b> (a IA fica pausada nessa conversa)'}.</li>
        <li>🆕 Cliente cadastrado depois do dia de cobrar do mês começa a ser cobrado no mês seguinte (ou use "📤 Enviar agora").</li>
      </ul></div>`);
    ligar();
  }

  const recarregar = (r) => { d = r; editando = null; desenhar(); };
  function ligar() {
    $('[data-novo-cli]')?.addEventListener('click', () => { editando = 'novo'; desenhar(); $('#f-cob-cliente [name=nome]')?.focus(); });
    $('[data-cancelar-cli]')?.addEventListener('click', () => { editando = null; desenhar(); });
    const fc = $('#f-cob-cliente');
    if (fc) fc.onsubmit = async (e) => {
      e.preventDefault();
      const body = formParaObjeto(fc);
      try {
        const r = await comEspera(fc.querySelector('[type=submit]'), () => api(editando === 'novo' ? `empresas/${id}/cobrancas/clientes` : `empresas/${id}/cobrancas/clientes/${editando}`, { method: editando === 'novo' ? 'POST' : 'PUT', body }), 'Salvando…');
        aviso(editando === 'novo' ? 'Cliente adicionado à cobrança.' : 'Cliente salvo.');
        recarregar(r);
      } catch (err) { aviso(err.message, true); }
    };
    $$('[data-editar-cli]').forEach((b) => { b.onclick = () => { editando = b.dataset.editarCli; desenhar(); }; });
    $$('[data-pago]').forEach((b) => { b.onclick = async () => { try { recarregar(await api(`empresas/${id}/cobrancas/clientes/${b.dataset.cli}/pago`, { method: 'POST', body: { pago: b.dataset.pago === '1' } })); aviso(b.dataset.pago === '1' ? 'Marcado como pago.' : 'Pagamento desfeito.'); } catch (err) { aviso(err.message, true); } }; });
    $$('[data-pago-mes]').forEach((b) => { b.onclick = async () => { try { recarregar(await api(`empresas/${id}/cobrancas/clientes/${b.dataset.cli}/pago`, { method: 'POST', body: { pago: true, competencia: b.dataset.pagoMes } })); aviso(`${nomeMes(b.dataset.pagoMes)} marcado como pago.`); } catch (err) { aviso(err.message, true); } }; });
    $$('[data-desfazer-mes]').forEach((b) => { b.onclick = async () => { try { recarregar(await api(`empresas/${id}/cobrancas/clientes/${b.dataset.cli}/pago`, { method: 'POST', body: { pago: false, competencia: b.dataset.desfazerMes } })); aviso('Pagamento desfeito.'); } catch (err) { aviso(err.message, true); } }; });
    $$('[data-ativo]').forEach((b) => { b.onclick = async () => { try { recarregar(await api(`empresas/${id}/cobrancas/clientes/${b.dataset.cli}`, { method: 'PUT', body: { ativo: b.dataset.ativo === '1' } })); } catch (err) { aviso(err.message, true); } }; });
    $$('[data-apagar-cli]').forEach((b) => {
      b.onclick = async () => {
        const c = d.clientes.find((x) => x.id === b.dataset.apagarCli);
        if (!(await confirmar({ titulo: `Tirar ${c.nome} da cobrança?`, texto: 'Ele para de receber as cobranças. A conversa dele continua em Conversas.', botao: 'Tirar', perigo: true }))) return;
        try { recarregar(await api(`empresas/${id}/cobrancas/clientes/${c.id}`, { method: 'DELETE' })); } catch (err) { aviso(err.message, true); }
      };
    });
    $$('[data-enviar-cli]').forEach((b) => {
      b.onclick = async () => {
        const c = d.clientes.find((x) => x.id === b.dataset.enviarCli);
        const ja = c.situacao.enviado;
        if (!(await confirmar({ titulo: `Mandar a cobrança para ${c.nome} agora?`, texto: `<p>Vai a cobrança de <b>${nomeMes(c.situacao.competencia)}</b> (${brl(c.valor)}, vence ${diaMes(c.situacao.vencimento)}) para ${esc(telefoneBonito(c.telefone))}.</p>${ja ? `<p class="aviso-texto">Ela já foi enviada em ${diaMes(ja.em.slice(0, 10))}. Vai de novo.</p>` : '<p class="rotulo">No dia de cobrar ela não vai de novo.</p>'}`, botao: 'Mandar agora' }))) return;
        try { recarregar(await comEspera(b, () => api(`empresas/${id}/cobrancas/clientes/${c.id}/enviar`, { method: 'POST', body: {} }), 'Enviando…')); aviso('Cobrança enviada.'); } catch (err) { aviso(err.message, true); }
      };
    });
    const fcfg = $('#f-cob-config');
    $$('[data-var]', fcfg).forEach((b) => {
      b.onclick = () => {
        const t = fcfg.elements.mensagem;
        const pos = t.selectionStart ?? t.value.length;
        t.value = t.value.slice(0, pos) + b.dataset.var + t.value.slice(t.selectionEnd ?? pos);
        t.focus();
      };
    });
    $('[data-msg-padrao]', fcfg).onclick = (e) => { e.preventDefault(); fcfg.elements.mensagem.value = d.padrao; };
    fcfg.onsubmit = async (e) => {
      e.preventDefault();
      const f = formParaObjeto(fcfg);
      try {
        const r = await comEspera(fcfg.querySelector('[type=submit]'), () => api(`empresas/${id}/cobrancas/config`, { method: 'PUT', body: { ...f, pixSeparado: Boolean(f.pixSeparado), iaResponde: Boolean(f.iaResponde) } }), 'Salvando…');
        d = r;
        aviso('Mensagem e pagamento salvos.');
        desenhar();
      } catch (err) { aviso(err.message, true); }
    };
  }
  desenhar();
}

// 🛡️ Segurança dos disparos de prospecção (padrões de cada novo disparo)
async function paginaSegurancaDisparo(id) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  const { seguranca: s, perfis = {} } = await api(`empresas/${id}/disparos-listas`);
  if (location.hash !== hashDaPagina) return;
  const PERFIS_SEG = [['novo', '🐣 Número novo', 'Chip novo ou parado há tempo (até 30 dias de uso). O mais seguro.'], ['recomendado', '🛡️ Recomendado', 'Equilíbrio entre segurança e velocidade. Bom para a maioria.'], ['aquecido', '🔥 Número aquecido', 'Número com mais de 3 meses de conversas normais e sem bloqueio.']].map(([pid, nome, texto]) => ({ id: pid, nome, texto, ...(perfis[pid] || s) }));
  conteudo.innerHTML = cascaDisparos(id, 'seguranca', `
    <div class="cabecalho"><div><h1>🛡️ Segurança</h1><p class="sub">Como a prospecção (contatos que não conhecem a empresa) manda devagar para o número não ser bloqueado</p></div></div>
    <form class="card" id="f-seg">
      <h2 style="margin-top:0">Escolha o perfil do seu número</h2>
      <p class="rotulo" style="margin:0 0 10px">Na dúvida, fique no <b>Recomendado</b>. Vale para os próximos disparos de prospecção (dá para trocar em cada disparo).</p>
      <div class="perfis-envio">${PERFIS_SEG.map((pf) => `<label class="perfil-envio"><input type="radio" name="perfil" value="${pf.id}" ${s.perfil === pf.id ? 'checked' : ''}><span><b>${pf.nome}</b>${pf.id === 'recomendado' ? ' <span class="etiqueta ok">recomendado</span>' : ''}<span class="rotulo">${pf.texto}</span><span class="perfil-numeros">${textoPerfil(pf, true)}</span></span></label>`).join('')}
        <label class="perfil-envio"><input type="radio" name="perfil" value="personalizado" ${s.perfil === 'personalizado' ? 'checked' : ''}><span><b>⚙️ Personalizado</b><span class="rotulo">Você escolhe os números abaixo.</span></span></label></div>
      <details id="seg-numeros" style="margin-top:12px" ${s.perfil === 'personalizado' ? 'open' : ''}><summary>Ver / mudar os números</summary>
      <h2>Limite por dia (aquecimento)</h2>
      <p class="rotulo" style="margin:0 0 10px">Número novo ou parado precisa "aquecer": começa com pouco e sobe um pouco a cada dia. O que passar do limite continua sozinho no dia seguinte.</p>
      <div class="campos">
        <div class="campo"><label>1º dia</label><input name="limiteInicial" type="number" min="5" max="500" value="${esc(s.limiteInicial)}"></div>
        <div class="campo"><label>Aumenta por dia</label><input name="aumentoDia" type="number" min="0" max="200" value="${esc(s.aumentoDia)}"></div>
        <div class="campo"><label>Máximo por dia</label><input name="tetoDia" type="number" min="5" max="1000" value="${esc(s.tetoDia)}"></div>
      </div>
      <h2>Intervalo entre mensagens (segundos)</h2>
      <div class="campos">
        <div class="campo"><label>Mínimo (pelo menos 45)</label><input name="intervaloMin" type="number" min="45" max="43200" value="${esc(s.intervaloMin)}"></div>
        <div class="campo"><label>Máximo</label><input name="intervaloMax" type="number" min="45" max="43200" value="${esc(s.intervaloMax)}"></div>
      </div>
      <small>60 = 1 minuto · 3600 = 1 hora · máximo 43200 (12 horas). No Novo disparo dá para escolher direto em minutos ou horas.</small>
      <h2>Freio automático</h2>
      <div class="campos"><div class="campo"><label>Pausar depois de quantos envios seguidos com erro</label><input name="freioErros" type="number" min="2" max="20" value="${esc(s.freioErros)}"></div></div>
      </details>
      <div class="acoes"><button type="submit" class="primario">Salvar</button></div>
    </form>
    <div class="card">
      <h2 style="margin-top:0">O que o CRM faz em toda prospecção</h2>
      <ul class="lista-simples">
        <li>✅ Confere se o número <b>tem WhatsApp</b> antes de mandar — quem não tem fica de fora e não conta no limite</li>
        <li>✅ Tira contatos <b>repetidos</b> (mesmo número) já na importação; telefone fixo entra, e quem não tem WhatsApp fica de fora na hora do envio</li>
        <li>✅ <b>Nunca repete:</b> quem já recebeu disparo em massa fica de fora, mesmo se aparecer de novo em outra lista (também a mesma empresa com outro número)</li>
        <li>✅ <b>Limite por dia</b> com aquecimento e intervalo sorteado entre as mensagens</li>
        <li>✅ Só em <b>horário comercial</b> (se marcado no disparo)</li>
        <li>✅ <b>Freio:</b> pausa sozinho e avisa no sininho se os envios começarem a falhar</li>
        <li>✅ Quem responde <b>SAIR</b> não recebe mais</li>
      </ul>
      <h2>O que só você pode fazer</h2>
      <ul class="lista-simples">
        <li>📱 Use um <b>número separado</b> do principal da empresa</li>
        <li>✍️ 1ª mensagem <b>curta, sem link e sem foto</b>, terminando com uma pergunta</li>
        <li>🎯 Oferta que faça sentido para quem recebe (lista do mesmo ramo/cidade)</li>
        <li>⏸️ Se o freio pausar, espere algumas horas antes de continuar</li>
      </ul>
    </div>`);
  const fSeg = $('#f-seg');
  $$('input[name=perfil]', fSeg).forEach((r) => {
    r.onchange = () => {
      const pf = PERFIS_SEG.find((x) => x.id === r.value);
      if (pf) ['limiteInicial', 'aumentoDia', 'tetoDia', 'intervaloMin', 'intervaloMax', 'freioErros'].forEach((k) => { fSeg.elements[k].value = pf[k]; });
      else $('#seg-numeros').open = true;
    };
  });
  $$('#seg-numeros input', fSeg).forEach((i) => i.addEventListener('input', () => { fSeg.querySelector('input[name=perfil][value=personalizado]').checked = true; }));
  $('#f-seg').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`empresas/${id}/disparos-seguranca`, { method: 'PUT', body: formParaObjeto(e.target) }); aviso('Segurança salva. Vale para os próximos disparos de prospecção.'); paginaSegurancaDisparo(id); } catch (err) { aviso(err.message, true); }
  };
}

// 🚀 Disparar = escolher a campanha (ou criar uma) → depois quem recebe, nome e quando
async function paginaEscolherCampanhaParaDisparo(id, params, temEscolhidos) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const [{ campanhas = [] }, ld] = await Promise.all([api(`empresas/${id}/disparos-campanhas`), api(`empresas/${id}/disparos-listas`).catch(() => ({ listas: [] }))]);
  if (location.hash !== hashDaPagina) return;
  const listaPedida = params.get('lista') || '';
  const lista = (ld.listas || []).find((l) => l.id === listaPedida);
  const extra = `${listaPedida ? `&lista=${encodeURIComponent(listaPedida)}` : ''}${params.get('site') ? `&site=${encodeURIComponent(params.get('site'))}` : ''}${params.get('ordem') ? `&ordem=${encodeURIComponent(params.get('ordem'))}` : ''}${params.get('cel') ? '&cel=1' : ''}`;
  const ordenadas = campanhas.slice().sort((a, b) => ((b.ultimoDisparoEm || b.atualizadoEm || '') > (a.ultimoDisparoEm || a.atualizadoEm || '') ? 1 : -1));
  conteudo.innerHTML = cascaDisparos(id, 'novo', `
    <div class="cabecalho"><div><h1>🚀 Novo disparo</h1><p class="sub">1º escolha a <b>campanha</b> (mensagens, lembrete e o que a IA faz). Depois você escolhe quem recebe e quando.</p></div><a class="botao" href="${rotaEmpresa(id, 'disparos/campanhas/nova')}">+ Criar campanha</a></div>
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `Os disparos saem pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar o WhatsApp</a>`, 'aviso')}
    ${lista ? balao(`Lista: ${esc(lista.nome)}`, 'Escolha a campanha que vai para esta lista.', 'ok') : ''}
    ${temEscolhidos ? balao('Contatos escolhidos', 'Escolha a campanha que vai para os contatos que você marcou.', 'ok') : ''}
    ${ordenadas.length ? `<div class="campanhas">${ordenadas.map((c) => `
      <a class="card campanha escolha-tipo" href="${rotaEmpresa(id, `disparos/novo?campanha=${encodeURIComponent(c.id)}${extra}`)}">
        <div class="campanha-topo"><div><b class="campanha-nome">🎯 ${esc(c.nome)}</b><br><span class="rotulo">${c.tipo === 'clientes' ? '📣 meus clientes' : '🛡️ contatos novos'} · ${c.mensagens.length} ${c.mensagens.length === 1 ? 'mensagem' : 'versões revezando'}</span></div></div>
        <span class="rotulo">💬 ${esc(c.mensagens[0].replace(/\s+/g, ' ').slice(0, 80))}${c.mensagens[0].length > 80 ? '…' : ''}</span>
        <span class="rotulo">${c.disparos ? `${taxaMsg(c)}% responderam em ${c.disparos} ${c.disparos === 1 ? 'disparo' : 'disparos'}` : 'Ainda não foi disparada'}</span>
        <span class="botao primario">Usar esta campanha →</span>
      </a>`).join('')}</div>` : `<div class="card vazio"><p><b>Primeiro crie uma campanha.</b></p><p class="rotulo">Nela ficam as mensagens (até 10 versões), a foto, o que a IA faz quando responderem, o lembrete e o ritmo. Depois é só escolher a lista e disparar.</p><a class="botao primario" href="${rotaEmpresa(id, 'disparos/campanhas/nova')}">+ Criar a primeira campanha</a></div>`}`);
}

// 🧪 manda o disparo de teste e mostra o resultado (no Novo disparo e no cartão da campanha)
async function enviarTesteDisparo(id, botao, config, numero, versao, caixa) {
  if (String(numero || '').replace(/\D/g, '').length < 10) { caixa.innerHTML = '<div class="erro-caixa">Digite o seu WhatsApp com DDD.</div>'; return; }
  if (!config.mensagens?.length) { caixa.innerHTML = '<div class="erro-caixa">Escreva a mensagem antes de testar.</div>'; return; }
  try { localStorage.setItem('disparo_teste_numero', numero); } catch { /* sem localStorage */ }
  try {
    const r = await comEspera(botao, () => api(`empresas/${id}/disparos/teste`, { method: 'POST', body: { ...config, numero, versao } }), 'Enviando…');
    caixa.innerHTML = r.enviado
      ? `${balao(`Teste enviado (versão ${esc(r.versao)}) para +${esc(r.numero)}`, `Agora responda do seu celular como se fosse o cliente (ex.: "sim", "quanto custa?"). A IA vai continuar com o roteiro. <a href="#/leads/${esc(r.leadId)}">Abrir a conversa no CRM</a>${r.avisos.length ? `<br><b>⚠️ ${r.avisos.map(esc).join('<br>⚠️ ')}</b>` : ''}`, r.avisos.length ? 'aviso' : 'ok')}`
      : `<div class="erro-caixa">Não foi enviado: ${esc(r.erro || 'erro no WhatsApp')}</div>`;
  } catch (err) {
    caixa.innerHTML = `<div class="erro-caixa">${esc(err.message)}</div>`;
  }
}

// 🎯 Campanhas: configuração guardada (mensagens, lembrete, roteiro, ritmo); dispara escolhendo a lista
async function paginaCampanhas(id) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const { campanhas = [] } = await api(`empresas/${id}/disparos-campanhas`);
  if (location.hash !== hashDaPagina) return;
  const lista = campanhas.slice().sort((a, b) => ((b.ultimoDisparoEm || b.atualizadoEm || '') > (a.ultimoDisparoEm || a.atualizadoEm || '') ? 1 : -1));
  const etapaOuEtiqueta = (c, k = 'aoResponder') => [c[k]?.etapa && `vai para "${c[k].etapa}"`, c[k]?.etiquetaId && `etiqueta "${(emp.etiquetas || []).find((t) => t.id === c[k].etiquetaId)?.nome || '?'}"`].filter(Boolean).join(' e ');
  conteudo.innerHTML = cascaDisparos(id, 'campanhas', `
    <div class="cabecalho"><div><h1>🎯 Campanhas</h1><p class="sub">Monte a campanha uma vez (mensagens, lembrete, o que a IA faz quando responderem) e dispare para as listas que quiser</p></div><a class="botao primario" href="${rotaEmpresa(id, 'disparos/campanhas/nova')}">+ Nova campanha</a></div>
    ${lista.length ? `<div class="campanhas">${lista.map((c) => `
      <div class="card campanha">
        <div class="campanha-topo"><div><b class="campanha-nome">${esc(c.nome)}</b><br><span class="rotulo">${c.tipo === 'clientes' ? '📣 meus clientes' : '🛡️ contatos novos'} · ${c.mensagens.length} ${c.mensagens.length === 1 ? 'mensagem' : 'versões revezando'}</span></div>${c.ativos ? `<span class="etiqueta ok">${c.ativos} em andamento</span>` : ''}</div>
        <button type="button" class="interruptor ${c.iaLigada === false ? 'desligado' : 'ligado'}" data-ia-campanha="${esc(c.id)}" title="Liga ou desliga a IA para quem responder a esta campanha (vale na hora)">${c.iaLigada === false ? '⛔ IA desligada — a equipe atende · ligar' : '🤖 IA respondendo · desligar'}</button>
        <ul class="campanha-itens">
          <li>💬 ${esc(c.mensagens[0].replace(/\s+/g, ' ').slice(0, 90))}${c.mensagens[0].length > 90 ? '…' : ''}</li>
          ${c.midiaIds?.length ? `<li>📎 ${c.midiaIds.length} ${c.midiaIds.length === 1 ? 'mídia' : 'mídias'}${c.personalizar?.ativo ? ' · 1ª foto com o nome do contato' : ''}</li>` : ''}
          <li>🧠 ${c.roteiro ? 'Prompt próprio da campanha' : 'Sem prompt próprio (usa o prompt principal)'}${etapaOuEtiqueta(c) ? ` · quem responde ${etapaOuEtiqueta(c)}` : ''}</li>
          ${etapaOuEtiqueta(c, 'aoEnviar') ? `<li>📌 Ao enviar: ${etapaOuEtiqueta(c, 'aoEnviar')}</li>` : ''}
          <li>🔁 ${c.lembrete?.ativo ? `follow-up: ${1 + (c.lembrete.mais || []).length} ${(c.lembrete.mais || []).length ? 'mensagens' : 'mensagem'} para quem não respondeu (${[c.lembrete.dias, ...(c.lembrete.mais || []).map((m) => m.dias)].map((n) => `${n}d`).join(' → ')})` : 'sem follow-up para quem não respondeu'}${c.followupGeral === false ? ' · quem responder e sumir: sem follow-up geral' : ''}</li>
        </ul>
        <div class="campanha-numeros">${c.disparos ? `<b>${taxaMsg(c)}% responderam</b> · ${c.responderam} de ${c.enviados} · ${c.disparos} ${c.disparos === 1 ? 'disparo' : 'disparos'}` : '<span class="rotulo">Ainda não foi disparada</span>'}</div>
        <div class="acoes"><a class="botao primario" href="${rotaEmpresa(id, `disparos/novo?campanha=${encodeURIComponent(c.id)}`)}">🚀 Disparar</a><a class="botao" href="${rotaEmpresa(id, `disparos/campanhas/${encodeURIComponent(c.id)}`)}">✏️ Editar</a><button type="button" data-testar-campanha="${esc(c.id)}">🧪 Testar</button><button type="button" data-duplicar="${esc(c.id)}">⧉ Duplicar</button><button type="button" class="perigo" data-apagar-campanha="${esc(c.id)}">🗑️</button></div>
      </div>`).join('')}</div>` : `<div class="card vazio"><p>Nenhuma campanha ainda.</p><p class="rotulo">Exemplo: "Guinchos sem site" com 3 versões da mensagem, a foto do modelo com o nome de cada empresa, lembrete em 3 dias e o roteiro do que a IA faz quando responderem. Depois é só disparar para cada lista nova.</p><a class="botao primario" href="${rotaEmpresa(id, 'disparos/campanhas/nova')}">+ Criar a primeira campanha</a></div>`}`);
  $$('[data-ia-campanha]').forEach((b) => {
    b.onclick = async () => {
      const c = lista.find((x) => x.id === b.dataset.iaCampanha);
      const ligar = c.iaLigada === false;
      if (!ligar && !(await confirmar({ titulo: `Desligar a IA em "${c.nome}"?`, texto: '<p>Quem responder aos disparos desta campanha (inclusive os que já estão rodando) <b>não recebe resposta da IA</b>: fica para a equipe responder.</p><p class="rotulo">Dá para ligar de novo a qualquer hora.</p>', botao: 'Desligar a IA' }))) return;
      try { await api(`empresas/${id}/disparos-campanhas/${c.id}/ia`, { method: 'PUT', body: { ligada: ligar } }); aviso(ligar ? 'IA ligada nesta campanha.' : 'IA desligada nesta campanha.'); paginaCampanhas(id); } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-testar-campanha]').forEach((b) => {
    b.onclick = () => {
      const c = lista.find((x) => x.id === b.dataset.testarCampanha);
      let salvo = '';
      try { salvo = localStorage.getItem('disparo_teste_numero') || ''; } catch { salvo = ''; }
      abrirModal(`<h2>🧪 Testar "${esc(c.nome)}"</h2><p class="rotulo">A mensagem sai <b>agora</b> só para este número. Responda do celular como se fosse o cliente: a IA continua com o roteiro da campanha.</p>
        <div class="campo"><label>Seu WhatsApp com DDD</label><input id="t-num" type="tel" inputmode="tel" value="${esc(salvo)}"></div>
        ${c.mensagens.length > 1 ? `<div class="campo"><label>Qual versão</label><select id="t-ver">${c.mensagens.map((m, i) => `<option value="${i}">Versão ${String.fromCharCode(65 + i)}: ${esc(m.replace(/\s+/g, ' ').slice(0, 50))}…</option>`).join('')}</select></div>` : ''}
        <div class="acoes"><button type="button" class="primario" id="t-enviar">Enviar teste agora</button><button type="button" data-fechar>Fechar</button></div><div id="t-res"></div>`, (m) => {
        $('#t-enviar', m).onclick = (e) => enviarTesteDisparo(id, e.currentTarget, { ...c, campanhaId: c.id, nome: c.nome }, $('#t-num', m).value, Number($('#t-ver', m)?.value) || 0, $('#t-res', m));
      });
    };
  });
  $$('[data-duplicar]').forEach((b) => {
    b.onclick = async () => {
      const c = lista.find((x) => x.id === b.dataset.duplicar);
      try { await api(`empresas/${id}/disparos-campanhas`, { method: 'POST', body: { ...c, nome: `${c.nome} (cópia)`.slice(0, 80) } }); aviso('Campanha duplicada.'); paginaCampanhas(id); } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-apagar-campanha]').forEach((b) => {
    b.onclick = async () => {
      const c = lista.find((x) => x.id === b.dataset.apagarCampanha);
      if (!(await confirmar({ titulo: `Apagar a campanha "${c.nome}"?`, texto: 'Os disparos que já foram feitos com ela continuam como estão (e os que estão em andamento continuam enviando).', botao: 'Apagar', perigo: true }))) return;
      try { await api(`empresas/${id}/disparos-campanhas/${c.id}`, { method: 'DELETE' }); paginaCampanhas(id); } catch (err) { aviso(err.message, true); }
    };
  });
}

const taxaMsg = (m) => (m.enviados ? Math.round((m.responderam / m.enviados) * 100) : 0);
const POUCOS_ENVIOS = 30; // com menos que isso por mensagem, o ranking ainda muda muito

// 💬 Mensagens salvas e o ranking de qual faz mais gente responder (todos os disparos somados)
async function paginaMensagensDisparo(id) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  const r = await api(`empresas/${id}/disparos-mensagens`);
  if (location.hash !== hashDaPagina) return;
  let verAntigas = false;
  try { verAntigas = sessionStorage.getItem('ranking_antigas') === '1'; } catch { verAntigas = false; }
  const antigas = (r.mensagens || []).filter((m) => m.antiga);
  const lista = (r.mensagens || []).filter((m) => verAntigas || !m.antiga).sort((a, b) => (a.antiga ? 1 : 0) - (b.antiga ? 1 : 0) || (b.enviados ? 1 : 0) - (a.enviados ? 1 : 0) || taxaMsg(b) - taxaMsg(a) || b.enviados - a.enviados);
  const confiaveis = lista.filter((m) => !m.antiga && m.enviados >= POUCOS_ENVIOS);
  const lider = confiaveis.length > 1 ? confiaveis.reduce((x, y) => (taxaMsg(y) > taxaMsg(x) ? y : x)) : null;
  const maior = Math.max(1, ...lista.map(taxaMsg));
  conteudo.innerHTML = cascaDisparos(id, 'mensagens', `
    <div class="cabecalho"><div><h1>💬 Mensagens e ranking</h1><p class="sub">Suas mensagens de disparo e quantas pessoas responderam a cada uma (somando todos os disparos)</p></div></div>
    ${balao('Como descobrir a melhor mensagem', `No <b>Novo disparo</b>, cadastre de 2 a 10 versões da mensagem. O CRM reveza: o 1º contato recebe a versão A, o 2º a B, e assim por diante. Aqui aparece qual faz mais gente responder. Com menos de ${POUCOS_ENVIOS} envios por mensagem o resultado ainda muda muito.`, 'dica')}
    <div class="card">
      <h2 style="margin-top:0">+ Nova mensagem</h2>
      <form id="f-msg-nova" class="editor-simples">
        <div class="campo"><label>Nome (só para você, opcional)</label><input name="nome" maxlength="60" placeholder="Ex.: Curta com pergunta"></div>
        <div class="campo"><label>Mensagem</label><textarea name="texto" maxlength="3000" style="min-height:90px" placeholder="{Oi|Olá}! Vi a {empresa_contato} no Google. Posso te mandar um exemplo?"></textarea><small>Aceita {Oi|Olá}, {nome}, {empresa_contato} e {cidade}.</small></div>
        <button type="submit" class="primario">Salvar mensagem</button>
      </form>
    </div>
    ${lista.length ? `<div class="card">
      <div class="linha-form" style="justify-content:space-between;flex-wrap:wrap"><h2 style="margin:0">🏆 Ranking</h2><button type="button" class="primario" id="usar-escolhidas" disabled>🎯 Criar campanha com as marcadas</button></div>
      ${antigas.length ? `<label class="linha-check rotulo" style="margin-top:6px"><input type="checkbox" id="ver-antigas" ${verAntigas ? 'checked' : ''}> Mostrar versões antigas (${antigas.length}) — mensagens que já tinham sido enviadas e depois foram editadas</label>` : ''}
      <div class="ranking-msgs">${lista.map((m, i) => `
        <div class="ranking-msg ${m === lider ? 'lider' : ''}">
          <label class="linha-check" ${m.antiga ? 'style="visibility:hidden"' : ''}><input type="checkbox" data-escolher="${esc(m.id)}" ${m.antiga ? 'disabled' : ''}></label>
          <div class="ranking-corpo">
            <div class="ranking-topo"><b>${m.antiga ? '🕓' : m.enviados ? `${i + 1}º` : '—'}</b> ${m === lider ? '<span class="etiqueta ok">🏆 a melhor até agora</span>' : ''}${m.antiga ? '<span class="etiqueta">versão antiga (foi editada)</span>' : ''}${m.nome ? ` <b>${esc(m.nome)}</b>` : ''}</div>
            <div class="ranking-texto">${esc(m.texto)}</div>
            <div class="ranking-barra"><span style="width:${Math.round((taxaMsg(m) / maior) * 100)}%"></span></div>
            <span class="rotulo">${m.enviados ? `<b>${taxaMsg(m)}% responderam</b> · ${m.responderam} de ${m.enviados} · em ${m.disparos} ${m.disparos === 1 ? 'disparo' : 'disparos'}${m.enviados < POUCOS_ENVIOS ? ' · ainda poucos envios' : ''}` : 'ainda não foi enviada'}</span>
            <div class="uso-campanhas">${m.campanhas?.length ? `🎯 Usada em: ${m.campanhas.map((c) => `<a class="etiqueta" href="${rotaEmpresa(id, `disparos/campanhas/${encodeURIComponent(c.id)}`)}">${esc(c.nome)}</a>`).join(' ')}` : `<span class="rotulo">${m.antiga ? 'Fica só no histórico' : 'Não está em nenhuma campanha'}</span>`}</div>
          </div>
          <div class="ranking-acoes"><button type="button" class="pequeno" data-editar-msg="${esc(m.id)}">✏️</button><button type="button" class="pequeno perigo" data-apagar-msg="${esc(m.id)}">🗑️</button></div>
        </div>`).join('')}</div>
    </div>` : '<div class="card vazio">Nenhuma mensagem ainda. Salve uma acima ou faça um disparo: as mensagens usadas entram aqui sozinhas.</div>'}`);
  $('#f-msg-nova').onsubmit = async (e) => {
    e.preventDefault();
    const f = formParaObjeto(e.target);
    try { await api(`empresas/${id}/disparos-mensagens`, { method: 'POST', body: f }); aviso('Mensagem salva.'); paginaMensagensDisparo(id); } catch (err) { aviso(err.message, true); }
  };
  const marcadas = () => $$('[data-escolher]:checked').map((c) => lista.find((m) => m.id === c.dataset.escolher)).filter(Boolean);
  $$('[data-escolher]').forEach((c) => { c.onchange = () => { const n = marcadas().length; $('#usar-escolhidas').disabled = !n || n > 10; $('#usar-escolhidas').textContent = n > 10 ? 'Máximo 10 versões' : `🎯 Criar campanha com ${n ? `as ${n} marcadas` : 'as marcadas'}`; }; });
  $('#usar-escolhidas')?.addEventListener('click', () => {
    try { sessionStorage.setItem('disparo_mensagens', JSON.stringify(marcadas().map((m) => ({ texto: m.texto, id: m.id })))); } catch { /* sem sessionStorage */ }
    location.hash = rotaEmpresa(id, 'disparos/campanhas/nova');
  });
  $('#ver-antigas')?.addEventListener('change', (e) => { try { sessionStorage.setItem('ranking_antigas', e.target.checked ? '1' : '0'); } catch { /* sem sessionStorage */ } paginaMensagensDisparo(id); });
  $$('[data-editar-msg]').forEach((b) => {
    b.onclick = () => {
      const m = lista.find((x) => x.id === b.dataset.editarMsg);
      abrirModal(`<h2>Editar mensagem</h2><form id="f-msg-editar"><div class="campo"><label>Nome</label><input name="nome" maxlength="60" value="${esc(m.nome || '')}"></div><div class="campo"><label>Mensagem</label><textarea name="texto" maxlength="3000" style="min-height:120px">${esc(m.texto)}</textarea>${m.campanhas?.length ? `<small>Muda também nas campanhas: <b>${m.campanhas.map((c) => esc(c.nome)).join(', ')}</b>.</small><br>` : ''}${m.enviados ? '<small>Já foi enviada: mudando o texto, o ranking começa do zero para o texto novo (o antigo fica em "versões antigas" com os números dele).</small>' : ''}</div><div class="acoes"><button type="submit" class="primario">Salvar</button></div></form>`, (fundo, fechar) => {
        $('#f-msg-editar', fundo).onsubmit = async (e) => {
          e.preventDefault();
          try { await api(`empresas/${id}/disparos-mensagens/${m.id}`, { method: 'PUT', body: formParaObjeto(e.target) }); fechar(); paginaMensagensDisparo(id); } catch (err) { aviso(err.message, true); }
        };
      });
    };
  });
  $$('[data-apagar-msg]').forEach((b) => {
    b.onclick = async () => {
      const m = lista.find((x) => x.id === b.dataset.apagarMsg);
      if (!(await confirmar({ titulo: 'Apagar esta mensagem?', texto: `<p>Ela sai da lista e do ranking.${m?.campanhas?.length ? ` <b>Também sai das campanhas: ${m.campanhas.map((c) => esc(c.nome)).join(', ')}.</b>` : ''}</p><p class="rotulo">Os disparos que já usaram continuam como estão.</p>`, botao: 'Apagar', perigo: true }))) return;
      try { await api(`empresas/${id}/disparos-mensagens/${b.dataset.apagarMsg}`, { method: 'DELETE' }); paginaMensagensDisparo(id); } catch (err) { aviso(err.message, true); }
    };
  });
}

async function paginaDisparo(id, disparoId) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  const d = await api(`empresas/${id}/disparos/${disparoId}`);
  const ST = { pendente: ['na fila', ''], enviado: ['enviado', 'ok'], erro: ['erro', 'off'], ignorado: ['ficou de fora', ''], cancelado: ['cancelado', ''] };
  if (location.hash !== hashDaPagina) return; // o usuário já foi para outra página
  conteudo.innerHTML = cascaDisparos(id, 'lista', `
    <div class="cabecalho"><div><h1>${esc(d.nome)}</h1><p class="sub">${statusDisparo(d)} ${d.agendadoPara && d.status === 'agendado' ? `começa em ${data(d.agendadoPara)}` : ''}</p></div><a class="botao" href="${rotaEmpresa(id, 'disparos')}">← Disparos</a></div>
    ${d.status === 'pausado' && d.motivoPausa ? balao('Disparo pausado', esc(d.motivoPausa), 'aviso') : ''}
    ${d.status === 'agendado' && d.agendadoPara ? balao(`🕐 Agendado para ${esc(new Date(d.agendadoPara).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}`, 'Está tudo certo: começa sozinho nessa hora. Você pode pausar ou cancelar antes, aqui embaixo.', 'ok') : ''}
    ${d.status === 'enviando' && d.aguardandoHorario ? balao('Esperando o horário comercial', 'Os envios continuam sozinhos a partir das 8h.', 'dica') : ''}
    ${d.prospeccao ? balao(`🛡️ Prospecção · hoje ${d.hoje} de ${d.limiteHoje}`, `${d.status === 'enviando' && d.aguardandoAmanha ? '<b>Bateu o limite de hoje</b> — continua sozinho amanhã, com um pouco mais. ' : ''}Limite: ${d.prospeccaoCfg?.limiteInicial} no 1º dia, +${d.prospeccaoCfg?.aumentoDia} por dia, até ${d.prospeccaoCfg?.tetoDia}/dia. Sem WhatsApp (ficaram de fora): <b>${d.semWhatsapp}</b>. Freio: pausa se ${d.prospeccaoCfg?.freioErros} envios seguidos falharem.`, d.aguardandoAmanha ? 'dica' : 'ok') : ''}
    <div class="grade-resumo">
      ${numeroCard('Total', d.total)}
      ${numeroCard('Enviados', d.enviado)}
      ${numeroCard('Responderam', d.responderam)}
      ${numeroCard('Com erro / de fora', d.erro + d.ignorado)}
      ${d.followup ? numeroCard('🔁 Follow-ups enviados', d.lembretes || 0) : ''}
      ${d.followup ? numeroCard('Responderam ao follow-up', d.responderamLembrete || 0) : ''}
    </div>
    <div class="card">
      ${barraProgresso(d)}
      <p class="rotulo" style="margin:8px 0 0">${d.proximos?.[0]?.em ? `Próximo envio: ${quandoEnvio(d.proximos[0].em)}` : ''}</p>
      <div class="acoes">
        ${['enviando', 'agendado', 'pausado'].includes(d.status) && d.pendente ? `<button type="button" id="mudar-hora">🕐 ${d.status === 'agendado' ? 'Mudar horário' : 'Agendar horário'}</button>` : ''}
        ${['enviando', 'agendado'].includes(d.status) ? '<button type="button" data-acao="pausar">⏸ Pausar</button>' : ''}
        ${d.status === 'pausado' ? '<button type="button" class="primario" data-acao="retomar">▶ Continuar</button>' : ''}
        ${!['concluido', 'cancelado'].includes(d.status) ? '<button type="button" class="perigo" data-acao="cancelar">Cancelar disparo</button>' : ''}
        <button type="button" class="perigo" id="apagar-disparo" style="margin-left:auto">🗑️ Apagar disparo</button>
      </div>
    </div>
    ${d.proximos?.length ? `<div class="card"><h2 style="margin-top:0">⏭️ Próximos ${d.proximos.length} envios <span class="rotulo">(previsão${['enviando', 'agendado'].includes(d.status) ? ' · atualiza sozinho' : ''})</span></h2>${d.status === 'pausado' ? '<p class="rotulo">Pausado: estes são os próximos da fila. Saem quando você clicar em ▶ Continuar ou agendar um horário.</p>' : ''}${tabelaFila(d.proximos)}<p class="rotulo" style="margin:8px 0 0">Faltam <b>${d.pendente}</b> na fila. O horário é uma previsão: o intervalo entre mensagens é sorteado${d.prospeccao ? ', o limite do dia joga o resto para o dia seguinte' : ''} e quem não tem WhatsApp sai da fila.</p></div>` : ''}
    ${d.porVersao ? (() => {
      const lider = d.porVersao.every((v) => v.enviados >= 10) ? d.porVersao.reduce((x, y) => (taxaMsg(y) > taxaMsg(x) ? y : x)) : null;
      return `<div class="card"><h2 style="margin-top:0">🔁 Qual versão faz mais gente responder</h2><div class="ranking-msgs">${d.porVersao.map((v) => `<div class="ranking-msg ${v === lider ? 'lider' : ''}"><div class="ranking-corpo"><div class="ranking-topo"><b>Versão ${v.letra}</b> ${v === lider ? '<span class="etiqueta ok">🏆 na frente</span>' : ''}</div><div class="ranking-texto">${esc(v.texto)}</div><div class="ranking-barra"><span style="width:${taxaMsg(v)}%"></span></div><span class="rotulo"><b>${taxaMsg(v)}% responderam</b> · ${v.responderam} de ${v.enviados} enviados</span></div></div>`).join('')}</div><p class="rotulo" style="margin:8px 0 0">${lider ? 'Com mais envios o resultado fica mais certo.' : 'Ainda poucos envios por versão: espere pelo menos 10 de cada para comparar.'} O ranking de todos os disparos fica em <a href="${rotaEmpresa(id, 'disparos/mensagens')}">💬 Mensagens e ranking</a>.</p></div>`;
    })() : ''}
    <div class="duas-colunas">
      <div class="card"><h2>Mensagem${(d.versoes || []).length > 1 ? 's' : ''}</h2><div class="conversa">${(d.versoes || []).length > 1 ? d.versoes.map((v, i) => `<div class="msg bot"><b>${String.fromCharCode(65 + i)}:</b> ${esc(v.texto)}</div>`).join('') : `<div class="msg bot">${esc(d.mensagem)}</div>`}${(d.followup || []).map((p, i) => `<div class="msg bot">🔁 <b>${i + 1}º follow-up</b> <span class="rotulo">(${p.dias} ${p.dias === 1 ? 'dia' : 'dias'} depois ${i ? 'do anterior' : 'do disparo'})</span><br>${esc(p.mensagem)}</div>`).join('')}</div><p class="rotulo">Intervalo de ${textoPerfil({ intervaloMin: d.intervaloMin, intervaloMax: d.intervaloMax }).replace(' entre mensagens', '')}${d.horarioComercial ? ' · só em horário comercial' : ''}${d.rodapeSair ? ' · com opção SAIR' : ''}${d.personalizar ? ` · 1ª foto com "${esc(d.personalizar.texto)}"` : ''}${d.followup ? ` · ${d.followup.length} follow-up${d.followup.length > 1 ? 's' : ''} para quem não responder` : ''} · criado por ${esc(d.criadoPor || '—')}</p>
        ${d.roteiro || d.aoResponder ? `<h2 style="margin-top:14px">Quando responderem</h2>${d.roteiro ? `<p style="white-space:pre-wrap">${esc(d.roteiro)}</p>` : ''}${d.aoResponder?.etapa ? `<p class="rotulo">Vai para a etapa <b>${esc(d.aoResponder.etapa)}</b></p>` : ''}${d.aoResponder?.etiquetaId ? `<p class="rotulo">Ganha a etiqueta <b>${esc((empresaAtual?.dados?.etiquetas || []).find((t) => t.id === d.aoResponder.etiquetaId)?.nome || 'escolhida')}</b></p>` : ''}` : ''}</div>
      <div class="card tabela-wrap" style="max-height:480px;overflow:auto">
        <table>
          <thead><tr><th>Contato</th><th>Situação</th></tr></thead>
          <tbody>${d.destinatarios.map((x) => `<tr><td><a href="#/leads/${esc(x.leadId)}">${esc(x.nome || x.numero || 'Lead')}</a>${x.nome && x.numero ? `<br><span class="rotulo">${esc(telefoneBonito(x.numero))}</span>` : ''}</td><td><span class="etiqueta ${ST[x.status]?.[1] || ''}">${ST[x.status]?.[0] || x.status}</span>${x.lembrete === 'enviado' ? ` <span class="etiqueta">🔁 ${x.lembretesEnviados > 1 ? `${x.lembretesEnviados} follow-ups` : 'follow-up'}</span>` : ''}${x.erro ? `<br><span class="rotulo">${esc(x.erro)}</span>` : ''}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`);
  $$('[data-acao]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.acao === 'cancelar' && !(await confirmar({ titulo: 'Cancelar o disparo?', texto: 'Quem ainda não recebeu não vai receber. Não dá para retomar depois.', botao: 'Cancelar disparo', perigo: true }))) return;
      try {
        await api(`empresas/${id}/disparos/${disparoId}/${b.dataset.acao}`, { method: 'POST' });
        paginaDisparo(id, disparoId);
      } catch (err) { aviso(err.message, true); }
    };
  });
  $('#mudar-hora')?.addEventListener('click', () => modalHoraDisparo(id, d, () => paginaDisparo(id, disparoId)));
  $('#apagar-disparo')?.addEventListener('click', async () => {
    const ativo = ['enviando', 'agendado', 'pausado'].includes(d.status);
    if (!(await confirmar({ titulo: 'Apagar este disparo?', texto: `${ativo ? '<p><b>Ele para agora</b>: quem ainda não recebeu não vai receber.</p>' : ''}<p>As mensagens que já saíram continuam nas conversas. Quem já recebeu este disparo continua fora dos próximos disparos de prospecção (o CRM nunca repete).</p><p>Depois é só criar um novo em <b>Novo disparo</b>.</p>`, botao: 'Apagar', perigo: true }))) return;
    try {
      await api(`empresas/${id}/disparos/${disparoId}`, { method: 'DELETE' });
      location.hash = rotaEmpresa(id, 'disparos');
    } catch (err) { aviso(err.message, true); }
  });
  clearInterval(atualizador); // a página se redesenha sozinha: um relógio só (antes somava um a cada volta)
  if (['enviando', 'agendado'].includes(d.status)) {
    const aqui = location.hash;
    atualizador = setInterval(() => { if (location.hash === aqui && !document.querySelector('.fundo-modal')) paginaDisparo(id, disparoId).catch(() => {}); }, 6000);
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

// muda quando um tique muda (e a cada minuto enquanto algo espera confirmação)
function assinaturaEntrega(l) {
  const ultimas = l.mensagens.slice(-40);
  const esperando = ultimas.some((m) => m.entrega === 'enviando');
  return `${ultimas.map((m) => (m.entrega || '-')[0]).join('')}${esperando ? Math.floor(Date.now() / 60000) : ''}`;
}

// Tiques como no WhatsApp, pela confirmação que o WhatsApp devolve:
// 🕓 aguardando · ✓ saiu · ✓✓ entregue · ✓✓ azul lida · ⚠️ não foi
function htmlEntrega(m) {
  const e = m.entrega;
  if (!e || m.canal !== 'whatsapp') return ' <span class="checks lida">✓✓</span>'; // antigas e chat do site
  if (e === 'lida') return ' <span class="checks lida" title="Lida pelo cliente">✓✓</span>';
  if (e === 'entregue') return ' <span class="checks" title="Entregue no celular do cliente">✓✓</span>';
  if (e === 'servidor') return ' <span class="checks" title="Enviada (o celular do cliente ainda não recebeu)">✓</span>';
  if (e === 'erro') return ' <span class="entrega-erro" title="O WhatsApp não conseguiu entregar. Mande de novo.">⚠️ não enviada</span>';
  // sem confirmação do WhatsApp depois de 3 minutos: avisa em vez de fingir que foi
  if (Date.now() - new Date(m.em).getTime() > 3 * 60 * 1000) return ' <span class="entrega-erro" title="O WhatsApp não confirmou o envio. Confira no celular ou mande de novo.">⚠️ sem confirmação</span>';
  return ' <span class="enviando" title="Aguardando o WhatsApp confirmar">🕓</span>';
}

// Uma mensagem no balão, do lado certo (cliente à esquerda, empresa à direita)
function htmlMensagem(m, leadId, anterior, comStart = true) {
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
  return `<div class="msg ${lado}${seguida ? '' : ' cauda'}" title="${esc(data(m.em))}">${menu}${topo ? `<span class="msg-origem">${esc(topo)}</span>` : ''}${htmlAnexo(m, leadId)}${textoVisivel ? `<span class="msg-texto">${formatarWhats(textoVisivel)}</span>` : ''}${m.whatsapp ? '<em class="msg-nota">→ Ofereceu continuar no WhatsApp</em>' : ''}${m.envio === 'erro' ? `<em class="msg-nota erro-envio">⚠️ Não foi enviado: ${esc(m.erroEnvio || 'erro no WhatsApp')}</em>` : m.comoArquivo ? '<em class="msg-nota">Foi como arquivo (qualidade original)</em>' : ''}${!saida && m.papel === 'visitante' && comStart ? `<button type="button" class="msg-start" data-ia-start="${esc(leadId)}" title="A IA lê o que o cliente mandou e começa o atendimento agora">▶ Start</button>` : ''}<span class="msg-rodape">${hora}${m.envio === 'enviando' ? ' <span class="enviando" title="Enviando pelo WhatsApp">⏳</span>' : m.envio === 'erro' ? '' : saida ? htmlEntrega(m) : ''}</span></div>`;
}

// O que o modo clone aprendeu (dá para apagar exemplos ruins)
async function modalClone(empresaId, depois) {
  const r = await api(`empresas/${empresaId}/clone`);
  abrirModal(`
    <h2>🧬 O que o clone aprendeu</h2>
    <p class="rotulo">Respostas (manuais e, se ligado, da IA 🤖) de conversas que viraram venda. Na hora de responder, a IA usa as mais parecidas com o que o cliente disse. Tire as que não representam o seu jeito.</p>
    <div class="lista-clone">${r.exemplos.map((ex) => `
      <div class="exemplo-clone" data-ex="${esc(ex.id)}">
        <div class="rotulo">Cliente: ${esc(ex.cliente)}</div>
        <div><b>${ex.autor === 'ia' ? '🤖 IA' : 'Você'}:</b> ${esc(ex.resposta || '(só mandou mídia)')}${(ex.midias || []).length ? ` <span class="etiqueta">🖼️ ${ex.midias.map(esc).join(', ')}</span>` : ''}</div>
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
    semResposta3h: '2º aviso de silêncio (ex.: 3 h). Se o 1º também estiver ligado, conta de novo a partir da resposta da IA ao 1º.',
    followup1: 'Primeira retomada feita pela IA, com o contexto da conversa. Se você usa o Follow-up sem IA, deixe este desligado para não mandar dois.'
  };
  const comFollowup = c.dispararComFollowup === true;
  c = Object.fromEntries(Object.entries(c).filter(([, e]) => e && typeof e === 'object' && e.tag));
  const ligados = Object.values(c).filter((e) => e.ativo).length;
  el.dataset.cfg = 'eventos-ia';
  el.dataset.pronto = ligados ? 'ok' : 'off';
  el.dataset.resumo = `${ligados} de ${Object.keys(c).length} ligados`;
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
      <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="dispararComFollowup" ${comFollowup ? 'checked' : ''}> Disparar [SEM_RESPOSTA], [SEM_RESPOSTA_3H] e [FOLLOWUP_1] mesmo quando o <b>Follow-up sem IA</b> já vai cuidar do cliente <span class="rotulo">(desmarcado = o Follow-up tem prioridade e não manda em dobro)</span></label>
      <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
    </form>`;
  marcarPronto(el, el.dataset.pronto, el.dataset.resumo);
  $('#f-eventos-ia').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const corpo = {};
    for (const k of Object.keys(c)) corpo[k] = { ativo: f.elements[`${k}-ativo`].checked, ...(f.elements[`${k}-minutos`] ? { minutos: Number(f.elements[`${k}-minutos`].value) } : {}) };
    corpo.dispararComFollowup = f.elements.dispararComFollowup.checked;
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
  const caixa = $('#card-log-ia-caixa');
  if (caixa && !soErros) marcarPronto(caixa, 'ok', `${lista.length} resposta(s) recente(s) · ${comErro ? `⚠️ ${comErro} com problema` : 'nenhuma com problema'}`);
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
  // desligar faz a IA continuar respondendo depois das suas mensagens: confirma (evita clique sem querer)
  if (!parar && !(await confirmar({ titulo: 'A IA vai continuar respondendo?', texto: 'Desligado, a IA <b>continua</b> respondendo o cliente mesmo depois que você manda uma mensagem manual (pelo painel ou pelo celular). Ligado, ela para e você assume.', botao: 'Deixar a IA continuar' }))) {
    chk.checked = true;
    return;
  }
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

// copiar o fbclid do bloco 📣 Meta Ads da conversa
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-copiar-fbclid]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copiarFbclid).then(() => aviso('fbclid copiado.')).catch(() => aviso(b.dataset.copiarFbclid));
});

// ▶ Start: a IA lê a conversa e começa o atendimento agora (tira a pausa desta conversa)
document.addEventListener('click', async (e) => {
  const botao = e.target.closest?.('[data-ia-start]');
  if (!botao) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    await comEspera(botao, () => api(`leads/${botao.dataset.iaStart}/ia-start`, { method: 'POST', body: {} }), '…');
    aviso('▶ A IA está lendo a conversa e vai responder agora (com o ritmo configurado de "digitando…").');
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
function quandoBrasilia(iso, comDia = true, semHora = false) {
  const d = new Date(iso);
  const f = (o) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...o });
  return `${comDia ? `${f({ weekday: 'short' })} ` : ''}${f({ day: '2-digit', month: '2-digit' })}${semHora ? ' · horário a combinar' : ` às ${f({ hour: '2-digit', minute: '2-digit' })}`}`;
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
  const realizado = t.status === 'realizado';
  const titulo = t.status === 'remarcado' ? 'HORÁRIO TROCADO' : cancelado ? 'AGENDAMENTO CANCELADO' : concluido ? 'AGENDAMENTO CONCLUÍDO (VENDA)' : realizado ? 'AGENDAMENTO REALIZADO' : 'AGENDADO';
  return `<div class="wa-ticket agendamento${cancelado ? ' cancelado' : ''}" role="note">
    <span class="ticket-icone" aria-hidden="true">${cancelado ? '🗓️' : '📅'}</span>
    <div class="ticket-corpo"><b>${titulo}</b><span class="ticket-info">${t.quando ? esc(quandoBrasilia(t.quando, true, t.semHora)) : esc(t.quandoTexto || 'data a combinar')}${t.descricao ? ` · ${esc(t.descricao)}` : ''}</span>
    ${!cancelado && t.trecho ? `<span class="ticket-trecho">“${esc(t.trecho)}”</span>` : ''}
    <small>${cancelado ? esc(QUEM_CANCELOU[t.canceladoPor] || 'cancelado') + (t.motivoCancelamento && !/^(remarcado|cancelado pela equipe)$/.test(t.motivoCancelamento) ? ` · ${esc(t.motivoCancelamento)}` : '') : esc(QUEM[t.por] || 'marcado pela equipe')} · ${hora}${cancelado || concluido || realizado ? '' : ` · <button type="button" class="link-botao" data-cancelar-ag="${esc(t.id)}" data-detectado="${t.por === 'detectado' ? '1' : ''}">${t.por === 'detectado' ? 'não era isso, desfazer' : 'cancelar'}</button>`} · <button type="button" class="link-botao" data-excluir-ag="${esc(t.id)}" title="O agendamento está errado: some de tudo">excluir</button></small></div>
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
  // ▶ Start vale para a conversa toda: aparece só na última mensagem do cliente
  const ultimaDoCliente = mensagens.findLast((m) => m.papel === 'visitante');
  for (const m of mensagens) {
    avisosAte(m.em);
    separador(m.em);
    html += htmlMensagem(m, leadId, anterior, m === ultimaDoCliente);
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

// a pessoa está olhando a tela do CRM? (aba na frente e com foco)
const estaOlhando = () => document.visibilityState === 'visible' && document.hasFocus();

// Faixa na conversa: o que vai sair para o cliente e quando (com cronômetro)
// Por que o follow-up não sai para este cliente (fica visível na conversa em vez de "sumir")
function linhaFollowupParado(l) {
  const m = l.followupMotivo;
  if (!m || (l.proximosEnvios || []).some((p) => p.tipo === 'followup')) return '';
  const desligadoGeral = m === 'desligado';
  const texto = desligadoGeral ? 'o follow-up está <b>desligado</b> na empresa — nada é programado (nem o automático, nem o colocado à mão)' : esc(m);
  return `<div class="proximo fup-parado"><span class="relogio">⏸️</span><span class="proximo-texto"><b>Follow-up${l.followupManual ? ' (à mão)' : ''}:</b> não vai sair · <span class="rotulo">${texto}</span></span>${desligadoGeral ? `<a class="pequeno botao" href="${rotaEmpresa(l.empresaId, 'followup')}">Ligar o follow-up</a>` : ''}</div>`;
}

function htmlProximos(l) {
  const lista = l.proximosEnvios || [];
  const parado = linhaFollowupParado(l);
  if (!lista.length) return parado ? `<div class="proximos-envios">${parado}</div>` : '';
  // avaliação no Google / comentário no anúncio: "Enviar agora" (a contagem para e a automação não manda de novo)
  const pedido = (p) => (p.receita === 'avaliacao' || p.receita === 'comentario' ? p.receita : '');
  return `<div class="proximos-envios">${lista.map((p) => `
    <div class="proximo ${p.porIa ? 'por-ia' : ''}" ${p.quando ? `title="${esc(new Date(p.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}"` : ''}>
      <span class="relogio">${p.quando ? '⏳' : pedido(p) === 'avaliacao' ? '⭐' : '💬'}</span>
      ${p.quando ? `<b class="contagem" data-contagem="${esc(p.quando)}">${textoContagem(p.quando)}</b>` : '<b class="contagem">manual</b>'}
      <span class="proximo-texto"><b>${esc(p.titulo)}</b>${p.detalhe ? ` · <span class="rotulo">${esc(p.detalhe.slice(0, 90))}</span>` : ''}${p.quando ? ` <span class="rotulo">(${esc(new Date(p.quando).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))})</span>` : ''}</span>
      ${pedido(p) ? `<button type="button" class="pequeno primario" data-pedido-agora="${esc(pedido(p))}">Enviar agora</button>` : ''}
      ${p.tipo === 'pedido' ? '' : `<button type="button" class="link-botao" ${p.tipo === 'agendada' ? `data-cancelar="${esc(p.id)}"` : `data-pular-automacao="${esc(p.id)}"`}>${p.tipo === 'agendada' ? 'cancelar' : 'não enviar'}</button>`}
    </div>`).join('')}${parado}</div>`;
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
  $$('[data-pedido-agora]', raiz).forEach((b) => {
    b.onclick = async () => {
      const tipo = b.dataset.pedidoAgora;
      const nome = tipo === 'avaliacao' ? 'o pedido de avaliação no Google' : 'o pedido de comentário no anúncio';
      if (!(await confirmar({ titulo: 'Enviar agora?', texto: `Manda ${nome} para o cliente agora pelo WhatsApp. A contagem para e a automação não manda de novo.`, botao: 'Enviar agora' }))) return;
      try {
        await comEspera(b, () => api(`leads/${leadId}/pedido`, { method: 'POST', body: { tipo } }), 'Enviando…');
        aviso('Enviado! A automação deste pedido não manda de novo para este cliente.');
      } catch (err) { aviso(err.message, true); }
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

// Marcar agendamento pela equipe (dia/hora e valor já vêm da conversa quando ela tem)
async function modalAgendamento(leadId, depois) {
  const paraCampo = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const amanha = new Date(Date.now() + 24 * 3600 * 1000);
  amanha.setHours(9, 0, 0, 0);
  let sug = {};
  try { sug = await api(`leads/${leadId}/agendamentos/sugestao`); } catch { /* sem sugestão: campos em branco */ }
  const local = paraCampo(sug.quando ? new Date(sug.quando) : amanha);
  const valorTexto = sug.valor ? String(sug.valor).replace('.', ',') : '';
  abrirModal(`
    <h2>📅 Marcar agendamento</h2>
    <p class="rotulo" style="margin-top:-4px">Aparece como aviso na conversa. A IA também marca sozinha quando o cliente confirma dia e horário — e você pode escrever <b>"agendamento confirmado"</b> na conversa que o CRM lança com o que tiver.</p>
    <form id="f-ag">
      <div class="campo"><label>Dia e horário${sug.quando ? ' <span class="rotulo">(da conversa)</span>' : ''}</label><input type="datetime-local" name="quando" value="${local}" required></div>
      ${sug.modoEmpresa === 'ambos' ? `<div class="campo" style="margin-top:10px"><label>Tipo</label><select name="modo"><option value="presencial">📍 Presencial</option><option value="online">💻 Online (videochamada, ligação, digital)</option></select></div>` : ''}
      <div class="campo" style="margin-top:10px"><label>O que foi agendado</label><input name="descricao" maxlength="200" placeholder="${sug.modoEmpresa === 'online' ? 'Ex.: Reunião de briefing do site, consultoria, aula' : 'Ex.: Revestimento completo, instalação, consulta'}"></div>
      ${sug.modoEmpresa && sug.modoEmpresa !== 'presencial' ? `<div class="campo" id="campo-link-ag" style="margin-top:10px" ${sug.modoEmpresa === 'ambos' ? 'hidden' : ''}><label>🔗 Link da reunião <span class="rotulo">(opcional)</span></label><input name="link" type="url" maxlength="300" value="${esc(sug.link || '')}" placeholder="https://meet.google.com/…"></div>` : ''}
      <div class="campo" style="margin-top:10px"><label>Valor (R$)${sug.valor ? ' <span class="rotulo">(da conversa — confira)</span>' : ''}</label><input name="valor" inputmode="decimal" value="${esc(valorTexto)}" placeholder="Ex.: 250">${sug.valorTrecho ? `<small class="rotulo">${esc(sug.valorTrecho)}</small>` : ''}</div>
      <div class="acoes"><button class="primario" type="submit">Marcar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    const selModo = $('select[name=modo]', m);
    if (selModo) selModo.onchange = () => { $('#campo-link-ag', m).hidden = selModo.value !== 'online'; };
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

// Excluir = o agendamento está errado: some de tudo (agenda, conversa, etiqueta, etapa, avisos).
// Cancelar = o cliente ou você desmarcou: fica no histórico como cancelado.
async function excluirAgendamento(leadId, agId) {
  if (!(await confirmar({ titulo: 'Excluir este agendamento?', texto: 'Use quando o agendamento está ERRADO. Ele some de tudo: da agenda, da conversa, a etiqueta Agendado e a etapa voltam como antes, e os avisos dele saem do sininho. Se o número de aviso já tinha recebido, ele recebe que não vale. O cliente não recebe nada. (Se o cliente desmarcou, use Cancelar.)', botao: 'Excluir agendamento', perigo: true, voltar: 'Voltar' }))) return false;
  try {
    await api(`leads/${leadId}/agendamentos/${agId}/excluir`, { method: 'POST', body: {} });
    aviso('Agendamento excluído.');
    return true;
  } catch (err) {
    aviso(err.message, true);
    return false;
  }
}

function ligarCancelarAgendamento(raiz, leadId, depois) {
  $$('[data-excluir-ag]', raiz).forEach((b) => {
    b.onclick = async () => { if (await excluirAgendamento(leadId, b.dataset.excluirAg)) depois?.(); };
  });
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
          <button type="button" class="chip-filtro" data-filtro="quentes" title="Alta chance de venda (sem IA): perguntou de horário/preço, mandou endereço, disse que quer…">🔥 Quentes</button>
          <button type="button" class="chip-filtro" data-filtro="vendas">✅ Vendas concluídas</button>
          <button type="button" class="chip-filtro" data-filtro="iaAtiva" title="Conversas em que a IA está respondendo">🤖 IA ativa</button>
          <button type="button" class="chip-filtro" data-filtro="iaPausada" title="Conversas em que a IA está pausada (a equipe atende)">✋ IA pausada</button>
          <button type="button" class="chip-filtro" data-filtro="arquivadas" title="Arquivadas ou apagadas no WhatsApp">🗄️</button>
          <button type="button" class="chip-filtro" data-filtro="listaNegra" title="Lista negra: ninguém (nem a IA) manda nada para eles">🚫</button>
        </div>
        ${(emp.etiquetas || []).length ? `<div class="inbox-filtros filtro-etiquetas">${emp.etiquetas.map((t) => `<button type="button" class="chip-filtro" style="--cor:${esc(t.cor)}" data-fetiqueta="${esc(t.id)}" title="Só conversas com a etiqueta ${esc(t.nome)}"><span class="bolinha-cor"></span>${esc(t.nome)}</button>`).join('')}</div>` : ''}
        <div id="lista-conversas" class="lista-conversas"><p class="rotulo" style="padding:16px">Carregando…</p></div>
      </aside>
      <section class="inbox-chat" id="inbox-chat">
        <div class="inbox-vazio">${ICONES.leads}<p><b>Escolha uma conversa</b><br><span class="rotulo">As novas mensagens aparecem sozinhas.</span></p></div>
      </section>
    </div>`;

  // 🗑️ apaga a conversa de vez (com confirmação)
  async function apagarConversa(leadId) {
    const c = lista.find((x) => x.id === leadId) || leadAberto;
    if (!(await confirmar({ titulo: 'Apagar esta conversa de vez?', texto: `A conversa com <b>${esc(nomeDoLead(c || {}))}</b> some <b>para sempre</b>: mensagens, fotos, áudios, agendamentos e follow-ups dela. <b>Não dá para desfazer.</b><br><br>Se esse número mandar mensagem de novo, começa uma conversa nova, do zero — a IA não lembra de nada do que foi falado. As vendas continuam no Faturamento. O WhatsApp do celular não é mexido.`, botao: 'Apagar de vez', perigo: true }))) return;
    try {
      await api(`leads/${leadId}`, { method: 'DELETE', body: {} });
      aviso('Conversa apagada.');
      if (abertoId === leadId) {
        abertoId = '';
        leadAberto = null;
        $('#inbox')?.classList.remove('com-chat');
        history.replaceState(null, '', rotaEmpresa(id, 'conversas'));
        const area = $('#inbox-chat');
        if (area) area.innerHTML = `<div class="inbox-vazio">${ICONES.leads}<p><b>Conversa apagada</b><br><span class="rotulo">Se o cliente escrever de novo, começa do zero.</span></p></div>`;
      }
      carregarLista();
    } catch (err) { aviso(err.message, true); }
  }

  function desenharLista() {
    const el = $('#lista-conversas');
    if (!el) return;
    el.innerHTML = lista.length
      ? lista.map((c) => `
        <div class="item-conversa-caixa">
        <button type="button" class="apagar-conversa" data-apagar-conversa="${esc(c.id)}" title="Apagar conversa" aria-label="Apagar conversa">🗑️</button>
        <button type="button" class="item-conversa ${c.id === abertoId ? 'ativo' : ''}" data-lead="${esc(c.id)}">
          ${avatarLead(c)}
          <span class="item-meio">
            <span class="item-linha"><strong>${esc(nomeDoLead(c))} ${seloTemperatura(c.temperatura, true)}</strong><span class="rotulo item-hora">${horaCurta(c.ultimaEm)}</span></span>
            <span class="item-linha"><span class="rotulo item-previa">${c.ultimaMensagem ? `${c.ultimaMensagem.papel === 'visitante' ? '' : c.ultimaMensagem.papel === 'equipe' ? 'Você: ' : 'IA: '}${esc(c.ultimaMensagem.texto)}` : ''}</span>${c.naoLidas ? `<span class="bolha-nao-lida">${c.naoLidas}</span>` : ''}</span>
            <span class="item-linha item-tags">${c.proximoEnvio ? `<span class="etiqueta ticket-chip contagem-chip" title="${esc(c.proximoEnvio.titulo)}">⏳ <span data-contagem="${esc(c.proximoEnvio.quando)}" data-curto="1">${textoContagem(c.proximoEnvio.quando, true)}</span></span>` : ''}${c.destaque?.tipo === 'agendamento' ? `<span class="etiqueta ticket-chip ag">📅 ${esc(quandoBrasilia(c.destaque.quando, false, c.destaque.semHora))}</span>` : c.destaque?.tipo === 'venda' ? '<span class="etiqueta ticket-chip venda">✅ Venda</span>' : ''}${c.precisaHumano ? '<span class="etiqueta off">esperando você</span>' : c.iaPausada ? '<span class="etiqueta">IA pausada</span>' : ''}${chipLocal(c)}${chipsDoLead(c, emp.etiquetas)}</span>
          </span>
        </button>
        </div>`).join('')
      : `<p class="rotulo" style="padding:16px">${filtro === 'listaNegra' ? 'Ninguém na lista negra.' : busca || filtro !== 'todas' || filtroEtiqueta ? 'Nada encontrado.' : 'Nenhuma conversa ainda.'}</p>`;
    $$('.item-conversa', el).forEach((b) => { b.onclick = () => abrir(b.dataset.lead); });
    $$('[data-apagar-conversa]', el).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); apagarConversa(b.dataset.apagarConversa); }; });
    ligarRelogio();
  }

  async function carregarLista() {
    lista = await api(`empresas/${id}/conversas?${new URLSearchParams({ filtro, busca, etiqueta: filtroEtiqueta })}`);
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
        <div class="chat-quem"><a class="chat-nome" href="#/leads/${esc(l.id)}" title="Ver o perfil do lead"><strong>${esc(nomeDoLead(l))}</strong></a> ${seloTemperatura(l.temperatura)}<span class="rotulo">${esc(telefoneBonito(l.telefone)) || (l.noWhatsapp ? 'número oculto pelo WhatsApp' : 'sem WhatsApp')}</span>${l.local?.texto && !localJaEtiqueta(l, emp.etiquetas) ? `<span class="rotulo chat-local" title="Localização: ${esc(l.local.origem || '')}">📍 ${esc(l.local.texto)}</span>` : ''}</div>
        <select id="chat-etapa" title="Etapa do funil">${l.etapas.map((e) => `<option ${e === l.etapa ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
        ${interruptor('chat-ia', !l.iaPausada, 'IA')}
        ${l.noWhatsapp ? `<span title="Follow-up automático deste cliente (mensagens prontas, sem IA)">${interruptor('chat-fup', !l.followupDesligado, '🔁 Follow-up')}</span>` : ''}
        <span class="chat-acoes"><button type="button" class="pequeno ${l.vendaConcluida ? 'primario' : ''}" id="chat-concluida" title="${l.vendaConcluida ? 'Tirar de Vendas concluídas' : 'Mover para a aba Vendas concluídas'}">${l.vendaConcluida ? '✅ Venda concluída' : '✅ Mover para Vendas concluídas'}</button>
        <button type="button" class="pequeno" id="chat-arquivar" title="${l.arquivado ? 'Voltar para a lista' : 'Arquivar aqui e no WhatsApp do celular'}">${l.arquivado ? '📤 Desarquivar' : '🗄️ Arquivar'}</button>
        <button type="button" class="pequeno ${l.listaNegra ? 'primario' : ''}" id="chat-lista-negra" title="${l.listaNegra ? 'Tirar da lista negra' : 'Lista negra: ninguém (nem a IA) manda mais nada para este cliente'}">${l.listaNegra ? '✅ Desbloquear' : '🚫 Lista negra'}</button>
        <button type="button" class="pequeno perigo" id="chat-apagar" title="Apagar conversa de vez" aria-label="Apagar conversa">🗑️</button></span>
      </header>
      <div class="chat-etiquetas">🏷️ ${(l.etiquetas || []).map((tid) => emp.etiquetas.find((t) => t.id === tid)).filter(Boolean).map((t) => `<span class="chip-etq" style="--cor:${esc(t.cor)}"><span class="bolinha-cor"></span>${esc(t.nome)}<button type="button" class="x-chip" data-tirar-etq="${esc(t.id)}" title="Tirar etiqueta">✕</button></span>`).join('')}
        ${emp.etiquetas.some((t) => !(l.etiquetas || []).includes(t.id)) ? `<select id="chat-add-etq" class="pequeno-select"><option value="">+ etiqueta</option>${emp.etiquetas.filter((t) => !(l.etiquetas || []).includes(t.id)).map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select>` : ''}
        ${l.erroEtiquetaZap ? `<span class="rotulo aviso-texto" title="${esc(l.erroEtiquetaZap.msg)}">⚠️ não consegui marcar no WhatsApp</span>` : ''}</div>
      ${l.listaNegra ? '<div class="chat-aviso perigo-aviso">🚫 <b>Na lista negra.</b> Nada é enviado para este cliente — nem pela IA, automações, follow-up, disparos ou por você. As mensagens dele continuam aparecendo aqui.</div>' : ''}
      ${l.arquivado ? `<div class="chat-aviso">🗄️ Conversa ${esc(l.arquivadoPor || 'arquivada')}. Se o cliente mandar mensagem, ela volta sozinha para a lista.</div>` : ''}
      ${linhaOrigem(l.origemSite)}
      ${linhaMeta(l.metaAds)}
      ${htmlPedidos(l)}
      ${l.iaReiniciadaEm ? `<div class="chat-aviso">🔄 Aprendizado desta conversa reiniciado em ${esc(data(l.iaReiniciadaEm))}: a IA só lê as mensagens daqui para frente. <button type="button" class="link-botao" id="chat-reiniciar-desfazer">Desfazer</button></div>` : ''}
      ${l.iaDesligadaPor ? `<div class="chat-aviso">${{ venda: '💰', agenda: '📅', empresa: '🏢' }[l.iaDesligadaPor] || '🤖'} ${esc(l.iaPausadaMotivo || 'IA desligada nesta conversa.')}${l.iaDesligadaPor === 'empresa' ? '' : ' <button type="button" class="pequeno" id="ligar-ia-desligada">Ligar a IA</button>'}</div>` : ''}
      ${l.precisaHumano ? `<div class="chat-aviso">👤 A IA chamou você para este cliente. Responda e depois devolva para a IA se quiser.</div>` : ''}
      ${l.iaStatus && !l.iaDesligadaPor && l.iaStatus.tipo !== 'respondeu' && l.mensagens[l.mensagens.length - 1]?.papel === 'visitante' ? `<div class="chat-ia-status ${l.iaStatus.tipo}">${l.iaStatus.tipo === 'aguardando' ? '🕗 <b>A IA responde quando abrir o horário:</b>' : l.iaStatus.tipo === 'aguardando-ia' ? '⏳ <b>Esperando a IA voltar:</b>' : '🤖 <b>A IA não respondeu:</b>'} ${esc(l.iaStatus.motivo)}${l.iaPausada ? ' <button type="button" class="pequeno" id="devolver-ia">Devolver para a IA</button>' : emp.ativa === false && ehAdmin() ? ` <button type="button" class="pequeno" data-reativar="${esc(id)}">Reativar a empresa</button>` : ''}</div>` : ''}
      <div class="conversa chat-mensagens" id="chat-mensagens">${htmlConversa(l.mensagens, l.id, l.tickets) || '<p class="rotulo">Sem mensagens.</p>'}</div>
      ${htmlProximos(l)}
      ${l.podeReceber ? `
      <form class="chat-envio" id="chat-envio">
        <div class="sugestoes-rapidas" id="sugestoes-rapidas" hidden></div>
        <div class="chat-ferramentas">
          <label class="botao pequeno" title="Enviar foto, vídeo, áudio ou PDF do computador — ou arraste os arquivos para a conversa, ou cole com Ctrl+V">📎 Arquivo<input type="file" id="chat-arquivo" hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></label>
          <button type="button" class="pequeno" id="chat-biblioteca" title="Mídias e álbuns cadastrados">🖼️ Mídias</button>
          <button type="button" class="pequeno" id="chat-rapidas" title="Respostas prontas (ou digite /)">⚡ Respostas</button>
          <button type="button" class="pequeno" id="chat-reiniciar-ia" title="A IA esquece o que leu desta conversa e começa do zero a partir da próxima mensagem">🔄 Reiniciar aprendizado da conversa</button>
          <button type="button" class="pequeno" id="chat-agendar" title="Mandar uma mensagem mais tarde">🕒 Mandar depois</button>
          ${l.vendaConcluida ? '<button type="button" class="pequeno" id="chat-venda" title="Lançar outra venda deste cliente (compra repetida)">➕ Outra venda</button>' : ''}
          <button type="button" class="pequeno" id="chat-agendamento" title="Marcar agendamento com o cliente">📅 Agendamento</button>
        </div>
        <div class="rapida-pendente" id="rapida-pendente" hidden></div>
        <div class="chat-linha">
          <textarea id="chat-texto" rows="1" placeholder="${telaDeToque() ? 'Mensagem (/ = respostas prontas)' : 'Escreva uma mensagem… (Enter envia, / para respostas prontas)'}"></textarea>
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
    assinaturaAberta = `${leadAberto.mensagens.length}|${leadAberto.atualizadoEm}|${leadAberto.tickets?.length || 0}|${leadAberto.mensagens.filter((m) => m.apagada).length}|${leadAberto.listaNegra}|${(leadAberto.etiquetas || []).join()}|${leadAberto.erroEtiquetaZap?.em || ''}|${assinaturaEntrega(leadAberto)}`;
    if (rolar) desenharChat();
    // abriu a conversa (e está olhando): fica lida aqui e no WhatsApp (tiques azuis no celular do cliente)
    if (document.visibilityState === 'visible') api(`leads/${leadId}/lido`, { method: 'POST' }).catch(() => {});
    if (leadAberto.naoLidas) {
      const item = lista.find((c) => c.id === leadId);
      if (item) item.naoLidas = 0;
      desenharLista();
    }
  }

  async function recarregarAberto() {
    if (!abertoId) return;
    const l = await api(`leads/${abertoId}`);
    const assinatura = `${l.mensagens.length}|${l.atualizadoEm}|${l.tickets?.length || 0}|${l.mensagens.filter((m) => m.apagada).length}|${l.listaNegra}|${(l.etiquetas || []).join()}|${l.erroEtiquetaZap?.em || ''}|${assinaturaEntrega(l)}`;
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
    // chegou mensagem com a conversa aberta: só fica lida se você está OLHANDO (aba na frente e com
    // foco) — CRM aberto esquecido em outra aba/computador não marca nada como lido
    if (estaOlhando() && (l.naoLidas || l.mensagens[l.mensagens.length - 1]?.papel === 'visitante')) api(`leads/${abertoId}/lido`, { method: 'POST' }).catch(() => {});
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
    $('#ligar-ia-desligada')?.addEventListener('click', async (e) => {
      try {
        await comEspera(e.currentTarget, () => api(`leads/${abertoId}`, { method: 'PUT', body: { iaPausada: false } }), '…');
        aviso('IA ligada nesta conversa. Ela volta a responder este cliente.');
        assinaturaAberta = '';
        recarregarAberto();
      } catch (err) { aviso(err.message, true); }
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
    // conversa sem WhatsApp: soltar arquivo aqui não manda nada (tira o que a conversa anterior ligou)
    const ac = $('#inbox-chat');
    if (ac) { ac.ondragenter = ac.ondragover = ac.ondragleave = ac.ondrop = null; ac.classList.remove('soltando'); }
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
      // no celular (sem Shift) o Enter pula linha, como no WhatsApp; envia pelo botão
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !telaDeToque()) {
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
    // manda um arquivo do computador (botão 📎, arrastar e soltar ou Ctrl+V); a legenda vai só no 1º
    const enviarDoPc = async (arquivo, { comLegenda = true, ultimo = true } = {}) => {
      if (arquivo.size > 200 * 1024 * 1024) { aviso(`"${arquivo.name}" tem ${(arquivo.size / 1048576).toFixed(0)} MB. O máximo é 200 MB — divida o vídeo em partes.`, true); return false; }
      const legenda = arquivo.type.startsWith('audio/') || !comLegenda ? '' : campo.value.trim();
      const botao = $('#chat-enviar');
      const leadId = abertoId;
      try {
        await comEspera(botao, async () => {
          // sobe em pedaços (arquivo grande, qualidade original) e depois manda pelo WhatsApp
          const ini = await api(`leads/${leadId}/arquivo/envio`, { method: 'POST', body: { arquivo: arquivo.name, tamanho: arquivo.size, tipo: arquivo.type || '' } });
          await subirEmPedacos(arquivo, ini, (pct) => { botao.innerHTML = `<span class="girando"></span> ${pct}%`; });
          botao.innerHTML = '<span class="girando"></span> Enviando…';
          await api(`leads/${leadId}/arquivo/envio/${ini.envioId}/concluir`, { method: 'POST', body: { legenda, manterIa: $('#chat-manter-ia')?.checked } });
        }, 'Enviando…');
        if (legenda) campo.value = '';
        if (ultimo) {
          aviso('Arquivo recebido. Enviando pelo WhatsApp na qualidade original — aparece ✓ quando chegar.');
          await recarregarAberto();
          carregarLista();
        }
        return true;
      } catch (err) { aviso(`${arquivo.name}: ${err.message}`, true); return false; }
    };
    // vários de uma vez (arrastou ou colou): confirma antes e manda um por vez, na ordem
    const enviarVarios = async (arquivos) => {
      const lista = [...arquivos].filter((f) => f && f.size > 0);
      if (!lista.length) return;
      const nomeCliente = esc(nomeDoLead(leadAberto || {}));
      const tam = (f) => (f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`);
      const legenda = campo.value.trim();
      if (!(await confirmar({
        titulo: lista.length === 1 ? 'Enviar este arquivo?' : `Enviar ${lista.length} arquivos?`,
        texto: `Para <b>${nomeCliente}</b> pelo WhatsApp:<br>${lista.slice(0, 10).map((f) => `• ${esc(f.name || 'imagem colada')} <span class="rotulo">(${tam(f)})</span>`).join('<br>')}${lista.length > 10 ? `<br>… e mais ${lista.length - 10}` : ''}${legenda ? `<br><br>Legenda: <i>${esc(legenda.slice(0, 120))}</i>` : ''}`,
        botao: 'Enviar'
      }))) return;
      for (const [i, f] of lista.entries()) {
        const ok = await enviarDoPc(f, { comLegenda: i === 0, ultimo: i === lista.length - 1 });
        if (!ok && i < lista.length - 1) { await recarregarAberto().catch(() => {}); break; }
      }
    };
    $('#chat-arquivo').onchange = async (e) => {
      const arquivo = e.target.files[0];
      e.target.value = '';
      if (arquivo) await enviarDoPc(arquivo);
    };
    // 🖱️ arrastar arquivos do computador e soltar na conversa
    const areaChat = $('#inbox-chat');
    const temArquivo = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    areaChat.ondragenter = (e) => { if (temArquivo(e)) { e.preventDefault(); areaChat.classList.add('soltando'); } };
    areaChat.ondragover = (e) => { if (temArquivo(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; areaChat.classList.add('soltando'); } };
    areaChat.ondragleave = (e) => { if (!areaChat.contains(e.relatedTarget)) areaChat.classList.remove('soltando'); };
    areaChat.ondrop = (e) => {
      if (!temArquivo(e)) return;
      e.preventDefault();
      areaChat.classList.remove('soltando');
      enviarVarios(e.dataTransfer.files);
    };
    areaChat.dataset.soltar = `Solte para enviar a ${nomeDoLead(leadAberto || {})}`;
    // 📋 colar imagem/arquivo (Ctrl+V) na caixa de mensagem
    campo.onpaste = (e) => {
      const arquivos = [...(e.clipboardData?.files || [])];
      if (!arquivos.length) return; // texto: cola normal
      e.preventDefault();
      enviarVarios(arquivos.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `imagem-colada-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
    };
    $('#chat-biblioteca').onclick = async () => {
      const lista = await api(`empresas/${id}/midias`);
      // todas as mídias, inclusive as de dentro das pastas do Drive (com o nome da pasta)
      const pastas = Object.fromEntries((emp.drivePastas || []).map((p) => [p.id, p.nome]));
      const avulsas = [...lista.filter((m) => !m.pastaId), ...lista.filter((m) => m.pastaId)];
      const albuns = (emp.drivePastas || []).filter((p) => p.total);
      // busca sem IA: nome, código, "quando enviar", assuntos e legenda (sem acento e sem maiúscula)
      const chave = (...t) => t.flat().filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const miniatura = (m) => (m.tipo === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">`
        : m.tipo === 'video' ? `<span class="mini-video">${m.capa ? `<img src="${esc(m.capa)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="mini-play">▶</span></span>`
        : `<span class="escolha-icone">${ICONE_TIPO[m.tipo] || '📎'}</span>`);
      abrirModal(`
        <h2>Enviar da biblioteca</h2>
        ${!avulsas.length && !albuns.length ? `<p class="rotulo">Nenhuma mídia cadastrada. <a href="${rotaEmpresa(id, 'midias')}">Cadastrar mídias</a></p>` : `<input type="search" id="busca-midia-chat" placeholder="Buscar mídia: nome, código ou carro (ex.: corolla, couro, 20)" autocomplete="off" style="width:100%;margin-bottom:10px">`}
        <div class="grade-escolha" id="grade-midia-chat">
          ${albuns.map((p) => `<button type="button" class="escolha" data-nome="${esc(p.nome)}" data-busca="${esc(chave(p.nome, 'album'))}"><span class="escolha-icone">📁</span><b>${esc(p.nome)}</b><span class="rotulo">álbum · ${p.total} arquivos</span></button>`).join('')}
          ${avulsas.map((m) => `<button type="button" class="escolha" data-nome="${esc(m.codigo || m.nome)}" data-busca="${esc(chave(m.nome, m.codigoVisivel, m.codigo, m.descricao, m.assuntos || [], m.legenda, m.tipo === 'video' ? 'video' : '', pastas[m.pastaId] || ''))}">${miniatura(m)}<b>${m.tipo === 'video' ? '🎬 ' : ''}${esc(m.nome)}</b><span class="rotulo">${esc(m.codigoVisivel || codNum(m))}${m.pastaId ? ` · 📁 ${esc(pastas[m.pastaId] || 'pasta')}` : ''}${m.processando ? ' · ⏳ convertendo' : ''}</span></button>`).join('')}
        </div>
        <p class="rotulo" id="busca-midia-vazia" hidden>Nenhuma mídia com esse nome.</p>
        <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
        const busca = $('#busca-midia-chat', m);
        if (busca) {
          busca.focus();
          busca.oninput = () => {
            const termos = chave(busca.value).split(/\s+/).filter(Boolean);
            let visiveis = 0;
            $$('[data-busca]', m).forEach((b) => {
              const ok = termos.every((t) => b.dataset.busca.includes(t) || b.dataset.busca.includes(`#midia_${t}`));
              b.hidden = !ok;
              if (ok) visiveis++;
            });
            $('#busca-midia-vazia', m).hidden = visiveis > 0;
          };
        }
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
    $('#chat-rapidas').onclick = () => modalRespostasRapidas(emp, escolherRapida);
    const recarregarJa = () => { assinaturaAberta = ''; recarregarAberto(); carregarLista(); };
    $('#chat-venda')?.addEventListener('click', () => modalVenda({ id }, null, abertoId, recarregarJa, { cliente: leadAberto.nome }));
    $('#chat-agendamento').onclick = () => modalAgendamento(abertoId, recarregarJa);
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
  // voltou para a aba com uma conversa aberta: agora sim fica lida
  const aoVoltar = () => {
    if (!location.hash.startsWith(aqui)) return void (window.removeEventListener('focus', aoVoltar), document.removeEventListener('visibilitychange', aoVoltar));
    if (abertoId && estaOlhando() && leadAberto && (leadAberto.naoLidas || leadAberto.mensagens[leadAberto.mensagens.length - 1]?.papel === 'visitante')) {
      api(`leads/${abertoId}/lido`, { method: 'POST' }).then(() => { leadAberto.naoLidas = 0; const item = lista.find((c) => c.id === abertoId); if (item) { item.naoLidas = 0; desenharLista(); } }).catch(() => {});
    }
  };
  window.addEventListener('focus', aoVoltar);
  document.addEventListener('visibilitychange', aoVoltar);
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
    ...albunsRr.filter((a) => a.quantidade).map((a) => ({ nome: a.codigo, rotulo: `🗂️ ${a.nome} (álbum) · ${codNum(a)}` })),
    ...(emp.drivePastas || []).filter((p) => p.total).map((p) => ({ nome: p.codigo || p.nome, rotulo: `📁 ${p.nome} (Drive) · #${p.codigo || ''}` })),
    ...todas.filter((m) => !m.pastaId).map((m) => ({ nome: m.codigo, rotulo: `${ICONE_TIPO[m.tipo] || '📎'} ${m.nome} · ${codNum(m)}` }))
  ];
  const casa = (o, r) => o.nome === r.midia || o.rotulo.includes(` ${r.midia} `);
  abrirModal(`
    <h2>Respostas rápidas</h2>
    ${balao('Texto + foto/catálogo com um atalho', `Ex.: <b>/preco</b> manda a tabela de preços, <b>/catalogo</b> manda o álbum de fotos. Use aqui na aba Conversas${emp.atalhosNoCelular !== false ? ' <b>e também no WhatsApp do celular</b>: digite <b>/preco</b> na conversa do cliente e o CRM troca pelo texto + mídia' : ''}.`)}
    ${balao('🤖 Responder sozinha (sem IA, sem gastar tokens)', 'Marque em perguntas que sempre têm a mesma resposta (endereço, horário, Pix, catálogo) e escreva as frases que o cliente costuma usar. Quando a mensagem dele for curta e bater com <b>uma</b> resposta só, o CRM manda a resposta pronta (texto + mídia) sem chamar a IA. Mensagem longa, com foto/áudio ou que bate com mais de uma resposta: a IA responde normalmente. A mesma resposta não sai de novo para o mesmo cliente em 24 h.')}
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
          <label class="linha-check" style="margin-top:6px"><input type="checkbox" data-auto="${i}" ${r.auto ? 'checked' : ''}> 🤖 Responder sozinha, <b>sem IA</b>, quando o cliente escrever:</label>
          <input data-gatilhos="${i}" value="${esc(r.gatilhos || '')}" placeholder="frases do cliente, separadas por vírgula — ex.: endereço, onde fica, localização" maxlength="300" ${r.auto ? '' : 'style="opacity:.6"'}>
        </div>`).join('') || '<p class="rotulo">Nenhuma resposta rápida ainda.</p>';
      $$('[data-quando]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.quando].quando = el.value; }; });
      $$('[data-gatilhos]', m).forEach((el) => { el.oninput = () => { lista[el.dataset.gatilhos].gatilhos = el.value; }; });
      $$('[data-auto]', m).forEach((el) => { el.onchange = () => { lista[el.dataset.auto].auto = el.checked; desenhar(); }; });
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

// Follow-up que puxa agendamento: cada mensagem oferece horário ({horarios}) em vez de "ficou alguma dúvida?"
const MODELO_FUP_AGENDAR = () => [
  { id: '', horas: 3, midiaPrimeiro: false, midias: [], textos: [
    '{Oi|Olá} {nome}! Consigo te encaixar {horarios}. Qual fica melhor pra você? 😊',
    '{nome}, consigo te atender {horarios}. Quer que eu já deixe reservado pra você?'
  ] },
  { id: '', horas: 24, midiaPrimeiro: false, midias: [], textos: [
    '{nome}, pra você não ficar sem horário: consigo {horarios}. Me diz o melhor dia que eu já marco ✅',
    '{Oi|Olá} {nome}! Bora deixar agendado? Consigo {horarios}. É só responder com o dia 🙂'
  ] },
  { id: '', horas: 48, midiaPrimeiro: false, midias: [], textos: [
    '{nome}, a agenda dos próximos dias está enchendo. Consigo te encaixar {horarios} — quer que eu segure um horário pra você?',
    '{Oi|Olá} {nome}! Ainda dá pra garantir: consigo {horarios}. Te reservo um?'
  ] },
  { id: '', horas: 96, midiaPrimeiro: false, midias: [], textos: [
    '{Oi|Olá} {nome}, vou parar de te chamar pra não incomodar 🙏 Quando quiser agendar é só mandar um oi aqui que eu te encaixo!',
    '{nome}, fico à disposição! Quando for o momento, me chama aqui que eu vejo um horário pra você 😉'
  ] }
];

// Seção 🔁 Follow-up: mensagens prontas, SEM IA — lista simples + editor com prévia do WhatsApp
async function secaoFollowup(id, emp, el, editar = null) {
  if (!el?.isConnected) return;
  const [d, todas, albuns] = await Promise.all([api(`empresas/${id}/followup`), api(`empresas/${id}/midias`), api(`empresas/${id}/albuns`)]);
  if (!el.isConnected) return;
  // o que dá para anexar: mídias soltas, álbuns e pastas do Drive (pelo código), com miniatura
  const capa = (itens) => itens.find((m) => m.tipo === 'image')?.url || '';
  const opcoes = [
    ...todas.filter((m) => !m.pastaId && !m.albumId).map((m) => ({ codigo: m.codigo, nome: m.nome, tipo: m.tipo, url: m.tipo === 'image' ? m.url : '', soFollowup: m.soFollowup })),
    ...albuns.map((a) => ({ codigo: a.codigo, numero: a.numero, nome: a.nome, tipo: 'album', url: capa(todas.filter((m) => m.albumId === a.id)), soFollowup: a.soFollowup, qtd: todas.filter((m) => m.albumId === a.id).length })),
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
      <p class="rotulo" style="margin:-4px 0 8px">O número no canto é a ordem de envio. Dá para mudar a ordem depois, com ↑ ↓.</p>
      <div class="grade-escolha-midia" id="fm-grade"></div>
      <p class="rotulo" style="margin:10px 0 0">Nova mídia? Envie em <a href="${rotaEmpresa(id, 'midias')}">Mídias</a>, na aba <b>🔁 Só follow-up</b>.</p>
      <div class="acoes"><button type="button" data-fechar>Cancelar</button><button type="button" class="primario" id="fm-ok">Usar selecionadas</button></div>`, (m, fechar) => {
      const desenhar = () => {
        const n = (f) => opcoes.filter((o) => f === 'todas' || o.soFollowup).length;
        $('#fm-filtro', m).innerHTML = [['fup', '🔁 Só follow-up'], ['todas', 'Todas']].map(([k, t]) => `<button type="button" class="chip-filtro ${filtro === k ? 'ativo' : ''}" data-f="${k}">${t} <b>${n(k)}</b></button>`).join('');
        const lista = opcoes.filter((o) => filtro === 'todas' || o.soFollowup);
        $('#fm-grade', m).innerHTML = lista.map((o) => `<button type="button" class="item-escolha-midia ${escolhidas.has(o.codigo) ? 'marcada' : ''}" data-c="${esc(o.codigo)}" title="${esc(o.nome || '')}">${miniatura(o)}<span class="nome-mini">${esc(o.nome || 'Sem nome')}${o.qtd ? ` (${o.qtd})` : ''}</span><span class="cod-mini">${esc(codNum(o))}</span>${escolhidas.has(o.codigo) ? `<span class="check-mini" title="Ordem de envio">${[...escolhidas].indexOf(o.codigo) + 1}</span>` : ''}</button>`).join('') || `<p class="rotulo">${filtro === 'fup' ? 'Nenhuma mídia marcada como "Só follow-up" ainda. Veja em "Todas" ou envie em Mídias.' : 'Nenhuma mídia cadastrada.'}</p>`;
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
    return esc(String(t || '').replace(/\{([^{}]*\|[^{}]*)\}/g, (_, o) => o.split('|')[0]).replace(/\{(primeiro_)?nome\}/gi, nome || 'João').replace(/\{nome_completo\}/gi, nome || 'João').replace(/\{empresa\}/gi, emp.nome || '').replace(/\{horarios\}/gi, 'no sábado às 9h ou 14h, ou na segunda às 10h'))
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
        ${(d.sequencias || []).filter((q) => q.ativa && q.inicio?.tipo === 'sem_resposta').length > 1 ? '<p class="aviso-texto" style="margin:6px 0">⚠️ Há mais de uma sequência de "parou de responder" ligada: o cliente recebe as mensagens das duas. Deixe ligada só a que você quer usar.</p>' : ''}
        <div class="lista-seq-fup">${(d.sequencias || []).map((q, si) => {
          const mt = d.metricas?.[q.id] || { receberam: 0, responderam: 0, agendaram: 0, compraram: 0, porPasso: {} };
          const pct = (a) => (mt.receberam ? ` (${Math.round((a / mt.receberam) * 100)}%)` : '');
          const passosQueTrouxeram = Object.entries(mt.porPasso || {}).filter(([, v]) => v.agendaram || v.compraram).map(([n, v]) => `msg ${n}: ${v.agendaram ? `${v.agendaram} agendou` : ''}${v.agendaram && v.compraram ? ' · ' : ''}${v.compraram ? `${v.compraram} comprou` : ''}`).join(' · ');
          return `
          <div class="seq-fup-linha seq-fup-cartao ${q.ativa ? '' : 'desligada'}">
            <div class="seq-fup-topo">${interruptor(`seq-ativa-${si}`, q.ativa, q.ativa ? 'Ligada' : 'Desligada')}<b>${esc(q.nome)}</b></div>
            <div class="seq-fup-info"><span class="rotulo">${esc(quandoTxt(q))}${q.paraQuem === 'quente' ? ' · <b>só 🔥 quentes</b>' : q.paraQuem === 'morno' ? ' · <b>🔥 quentes e 🌤️ mornos</b>' : ''} · ${q.passos.length} ${q.passos.length === 1 ? 'mensagem' : 'mensagens'}: ${q.passos.map((p) => tempoTxt(p.horas)).join(' → ')}${d.porSequencia?.[q.id] ? ` · ${d.porSequencia[q.id]} na fila` : ''}</span>
              <span class="seq-fup-numeros" title="Últimos 30 dias. Agendou/comprou conta para a última mensagem de follow-up que o cliente recebeu antes.">📊 30 dias: <b>${mt.receberam}</b> receberam · <b>${mt.responderam}</b> responderam${pct(mt.responderam)} · <b>${mt.agendaram}</b> agendaram${pct(mt.agendaram)} · <b>${mt.compraram}</b> compraram${pct(mt.compraram)}</span>
              ${passosQueTrouxeram ? `<span class="rotulo">🎯 Quem trouxe: ${esc(passosQueTrouxeram)}</span>` : ''}</div>
            <div class="seq-fup-midias">${[...new Set(q.passos.flatMap((p) => p.midias))].slice(0, 4).map((c) => miniatura(porCodigo[c], `title="${esc(porCodigo[c]?.nome || c)}"`)).join('')}</div>
            <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-testar-seq="${si}">📤 Testar</button><button type="button" class="pequeno primario" data-editar-seq="${si}">Editar</button></div>
          </div>`;
        }).join('')}</div>
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
    // ligar/desligar cada sequência direto no cartão (igual às automações)
    (d.sequencias || []).forEach((q, si) => {
      const chave = $(`#seq-ativa-${si}`, el);
      if (!chave) return;
      chave.onchange = async () => {
        const seqs = (d.sequencias || []).map(copiar);
        seqs[si].ativa = chave.checked;
        try {
          await api(`empresas/${id}/followup`, { method: 'PUT', body: { sequencias: seqs } });
          aviso(chave.checked ? `"${q.nome}" ligada.` : `"${q.nome}" desligada: ninguém recebe até você ligar de novo.`);
          secaoFollowup(id, emp, el);
        } catch (err) { chave.checked = !chave.checked; aviso(err.message, true); }
      };
    });
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
        <div class="campo largo"><label>Buscar cliente</label><input type="search" id="cf-busca" placeholder="Nome ou número com DDD — ex.: (21) 99999-9999" autocomplete="off"></div>
        <div class="campo"><label>Sequência</label><select id="cf-seq">${seqs.map((q) => `<option value="${esc(q.id)}">${esc(q.nome)} (${q.passos.length} mensagens)</option>`).join('')}</select></div>
      </div>
      <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="cf-ja"> Mandar a 1ª mensagem já (sem esperar o tempo dela)</label>
      <p class="rotulo" id="cf-titulo" style="margin:10px 0 4px">Conversas recentes</p>
      <div id="cf-lista" style="max-height:52vh;overflow:auto"><p class="rotulo"><span class="girando"></span> Carregando…</p></div>
      <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (m, fechar) => {
      let t = null;
      let pedido = 0;
      const lista = $('#cf-lista', m);
      const carregar = async (q) => {
        const n = ++pedido;
        $('#cf-titulo', m).textContent = q ? 'Resultado da busca' : 'Conversas recentes';
        try {
          const r = await api(`empresas/${id}/followup/buscar?q=${encodeURIComponent(q)}`);
          if (n !== pedido) return;
          lista.innerHTML = r.length ? `<ul class="fila-fup">${r.map((x) => `<li>
              <span><b>${esc(x.nome)}</b> <span class="rotulo">· ${x.escondido ? 'número escondido pelo WhatsApp' : esc(telefoneBonito(x.telefone))}${x.etapa ? ` · ${esc(x.etapa)}` : ''}${x.atualizadoEm ? ` · ${esc(data(x.atualizadoEm))}` : ''}</span>
                ${x.ultima ? `<br><span class="rotulo">“${esc(x.ultima)}”</span>` : ''}
                ${x.naFila ? `<br><span class="rotulo">⏳ já na fila (${esc(x.sequencia)})</span>` : ''}${x.desligado ? '<br><span class="rotulo">🚫 follow-up desativado (colocar reativa)</span>' : ''}${x.bloqueio ? `<br><span class="rotulo">🚫 ${esc(x.bloqueio)}</span>` : ''}</span>
              ${x.bloqueio ? '' : `<button type="button" class="pequeno primario" data-colocar="${esc(x.leadId)}">Colocar</button>`}</li>`).join('')}</ul>`
            : `<p class="rotulo">${q ? 'Nenhuma conversa com esse nome ou número. O cliente precisa ter mandado mensagem no WhatsApp da empresa pelo menos uma vez.' : 'Nenhuma conversa ainda.'}</p>`;
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
        } catch (err) { if (n === pedido) lista.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; }
      };
      $('#cf-busca', m).focus();
      $('#cf-busca', m).oninput = (e) => {
        clearTimeout(t);
        const q = e.target.value.trim();
        t = setTimeout(() => carregar(q.length >= 2 || /\d{3}/.test(q) ? q : ''), 300);
      };
      carregar('');
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
              <div class="campo"><label>Para quem ${ajuda('Chance de venda calculada sem IA: soma pontos quando o cliente pergunta de horário/dia (+3), preço (+2), diz que quer (+2), manda endereço (+2), foto (+1), fala de um serviço seu (+1), conversa bastante (+1), veio de anúncio (+1); perde quando diz que vai pensar/achou caro (−2), some por dias ou cancelou. 🔥 Quente = 6 pontos ou mais · 🌤️ Morno = 3 a 5. Quem já agendou ou comprou não entra.')}</label><select id="q-para"><option value="todos" ${(q.paraQuem || 'todos') === 'todos' ? 'selected' : ''}>Todos os clientes</option><option value="quente" ${q.paraQuem === 'quente' ? 'selected' : ''}>🔥 Só os quentes (alta chance de venda)</option><option value="morno" ${q.paraQuem === 'morno' ? 'selected' : ''}>🔥 Quentes e 🌤️ mornos</option></select></div>
            </div>
            <label class="linha-check" style="margin-top:4px"><input type="checkbox" id="q-ativa" ${q.ativa ? 'checked' : ''}> Ligada</label>
            <details style="margin-top:6px"><summary class="rotulo">Mais opções</summary>
              ${etiquetas.length ? `<div class="campo" style="margin-top:8px"><label>Só para quem tem a etiqueta (nenhuma = todos)</label><div class="chips">${etiquetas.map((t) => `<label class="chip-check" style="--cor:${esc(t.cor)}"><input type="checkbox" data-so-etq value="${esc(t.id)}" ${q.soEtiquetas.includes(t.id) ? 'checked' : ''}><span><span class="bolinha-cor"></span>${esc(t.nome)}</span></label>`).join('')}</div></div>` : ''}
              <div class="campo" style="margin-top:6px"><label>Só para quem está nas etapas (nenhuma = todas)</label><div class="chips">${etapas.map((e) => `<label class="chip-check"><input type="checkbox" data-so-etapa value="${esc(e)}" ${q.soEtapas.includes(e) ? 'checked' : ''}><span>${esc(e)}</span></label>`).join('')}</div></div>
              <label class="linha-check" style="margin-top:6px"><input type="checkbox" id="q-parar" ${q.pararAoResponder !== false ? 'checked' : ''}> Parar se o cliente responder</label>
            </details>
            <h3 style="margin:14px 0 6px">Mensagens</h3>
            <p class="rotulo" style="margin:-2px 0 8px"><code>{nome}</code> = nome do cliente · <code>{horarios}</code> = os próximos horários livres que você cadastrou em <a href="${rotaEmpresa(id, 'agenda')}">Agendamentos</a> (ex.: "no sábado às 9h ou 14h"; sem nenhum cadastrado vira "ainda essa semana") · <code>{Oi|Olá}</code> sorteia uma.</p>
            <div id="q-passos"></div>
            <div class="acoes" style="margin-top:4px"><button type="button" id="q-add">+ Mensagem</button><button type="button" id="q-modelo-agenda" title="Troca as mensagens desta sequência por 4 mensagens que oferecem horário">📅 Usar modelo que puxa agendamento</button>${nova ? '' : '<button type="button" class="perigo" id="q-apagar">Apagar sequência</button>'}</div>
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
          ${p.midias.length ? `<ol class="lista-midias-fup">${p.midias.map((c, j) => { const o = porCodigo[c]; return `<li class="midia-fup-item">
            <span class="midia-fup-ordem">${j + 1}</span>${o ? miniatura(o) : '<span class="mini-icone">⚠️</span>'}
            <span class="midia-fup-info"><span class="midia-fup-nome">${o ? esc(o.nome || 'Sem nome') + (o.qtd ? ` (${o.qtd})` : '') : 'Mídia apagada — tire daqui'}</span><span class="rotulo">${esc(o ? codNum(o) : c)}</span></span>
            <span class="midia-fup-acoes">${j ? `<button type="button" class="icone-botao" data-midia-subir="${i}:${j}" title="Enviar antes">↑</button>` : ''}${j < p.midias.length - 1 ? `<button type="button" class="icone-botao" data-midia-descer="${i}:${j}" title="Enviar depois">↓</button>` : ''}<button type="button" class="icone-botao perigo" data-tirar-midia="${i}:${j}" title="Tirar">✕</button></span>
          </li>`; }).join('')}</ol>` : ''}
          <div class="msg-fup-midias">
            <button type="button" class="botao pequeno" data-add-midia="${i}">＋ 🖼️ ${p.midias.length ? 'Trocar mídias' : 'Escolher mídias'}</button>
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
      $$('[data-midia-subir]', el).forEach((x) => { x.onclick = () => { const [i, j] = ij(x.dataset.midiaSubir); const m = q.passos[i].midias; [m[j - 1], m[j]] = [m[j], m[j - 1]]; desenharPassos(); }; });
      $$('[data-midia-descer]', el).forEach((x) => { x.onclick = () => { const [i, j] = ij(x.dataset.midiaDescer); const m = q.passos[i].midias; [m[j + 1], m[j]] = [m[j], m[j + 1]]; desenharPassos(); }; });
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
    $('#q-para').onchange = (e) => { q.paraQuem = e.target.value; };
    $('#q-ativa').onchange = (e) => { q.ativa = e.target.checked; };
    $('#q-parar').onchange = (e) => { q.pararAoResponder = e.target.checked; };
    $$('[data-so-etq]', el).forEach((x) => { x.onchange = () => { q.soEtiquetas = x.checked ? [...q.soEtiquetas, x.value] : q.soEtiquetas.filter((v) => v !== x.value); }; });
    $$('[data-so-etapa]', el).forEach((x) => { x.onchange = () => { q.soEtapas = x.checked ? [...q.soEtapas, x.value] : q.soEtapas.filter((v) => v !== x.value); }; });
    $('#pv-nome').oninput = (e) => { nomeEx = e.target.value || 'João'; $('#pv-nome-topo').textContent = nomeEx; atualizarPrevia(); };
    // modelo pronto: cada mensagem oferece horários de verdade ({horarios}) e pede para escolher
    $('#q-modelo-agenda').onclick = async () => {
      if (q.passos.some((p) => p.textos.some((t) => t.trim()) || p.midias.length) && !(await confirmar({ titulo: 'Usar o modelo que puxa agendamento?', texto: 'As mensagens desta sequência são trocadas por 4 mensagens que oferecem os próximos horários livres ({horarios}) e pedem para o cliente escolher: depois de 3 horas, 1 dia, 3 dias e 7 dias. As mídias que você escolheu continuam na 2ª mensagem. Você pode editar tudo antes de salvar.', botao: 'Usar o modelo' }))) return;
      const midiasAntes = [...new Set(q.passos.flatMap((p) => p.midias))].slice(0, 5);
      q.passos = MODELO_FUP_AGENDAR().map((p, i) => ({ ...p, midias: i === 1 ? midiasAntes : [] }));
      desenharPassos();
      aviso('Modelo colocado. Confira a prévia e clique em Salvar.');
    };
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
    ${balao('📣 Disparo em massa tem o follow-up dele', `Quem recebeu um disparo e <b>nunca respondeu</b> não entra aqui: recebe o follow-up da campanha (até 3 mensagens), em <a href="${rotaEmpresa(id, 'disparos/campanhas')}">🎯 Campanhas</a> → Editar → passo da mensagem. Quem <b>respondeu e depois sumiu</b> entra aqui, a não ser que a campanha diga "Não mandar follow-up automático".`, 'dica')}
    ${emp.whatsapp?.configurado ? '' : balao('Conecte o WhatsApp primeiro', `O follow-up sai pelo WhatsApp da empresa. <a href="${rotaEmpresa(id, 'whatsapp')}">Conectar</a>`, 'aviso')}
    <div class="card horario-auto" id="card-horario-envio"><p class="rotulo">Carregando horário…</p></div>
    <div id="secao-followup"><div class="card"><p class="rotulo">Carregando follow-up…</p></div></div>
    <p class="rotulo">🖼️ Mídias para os passos: em <a href="${rotaEmpresa(id, 'midias')}">Mídias</a>, aba <b>🔁 Só follow-up</b> (a IA nunca manda essas na conversa).</p>`;
  secaoFollowup(id, emp, $('#secao-followup'));
  cartaoHorarioEnvio(id);
}

// 🕗 Horário dos envios automáticos (follow-up e automações): liga/desliga e de que hora a que hora
async function cartaoHorarioEnvio(id) {
  const el = $('#card-horario-envio');
  if (!el) return;
  let h;
  try { h = await api(`empresas/${id}/horarios`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  el.innerHTML = `
    <form id="f-horario-envio" class="horario-form">
      <label class="linha-check" style="margin:0"><input type="checkbox" name="envioLigado" ${h.envioLigado ? 'checked' : ''}> <b>Só enviar no horário</b> (Brasília) <span class="rotulo">— vale para o follow-up e todas as automações</span></label>
      <div class="horario-linha">das <input type="time" name="inicio" value="${esc(h.envio.inicio)}" required> às <input type="time" name="fim" value="${esc(h.envio.fim)}" required> <button type="submit" class="pequeno primario">Salvar</button></div>
      <p class="rotulo" style="margin:6px 0 0">Fora do horário nada sai. No follow-up a contagem <b>pausa quando fecha e continua quando abre</b> (ex.: passo de 3 h, cliente parou 19h → 1 h hoje + 2 h amanhã → sai 10h). Passos de 1 dia ou mais contam dias corridos e, se caírem fora do horário, saem quando abrir.</p>
    </form>`;
  const f = $('#f-horario-envio');
  const salvar = async () => {
    try {
      await api(`empresas/${id}/horarios`, { method: 'PUT', body: { envioLigado: f.elements.envioLigado.checked, envio: { inicio: f.elements.inicio.value, fim: f.elements.fim.value } } });
      aviso(f.elements.envioLigado.checked ? `Envios automáticos só das ${f.elements.inicio.value} às ${f.elements.fim.value}.` : 'Envios automáticos a qualquer hora.');
    } catch (err) { aviso(err.message, true); }
  };
  f.onsubmit = (e) => { e.preventDefault(); salvar(); };
  f.elements.envioLigado.onchange = salvar;
}

// 🕗 Horário da IA responder (aba IA do WhatsApp)
async function cartaoHorarioIa(id) {
  const el = $('#card-horario-ia');
  if (!el) return;
  let h;
  try { h = await api(`empresas/${id}/horarios`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  el.dataset.cfg = 'horario-ia';
  el.innerHTML = `
    <h2 style="margin:0 0 6px">🕗 Horário da IA responder</h2>
    <p class="rotulo" style="margin:0 0 10px">Mensagem que chega fora do horário <b>fica esperando</b>: a IA responde quando o horário abrir (alguns clientes por minuto, quem esperou mais primeiro). Se a equipe responder antes, a IA não responde. Desligado = a IA responde a qualquer hora.</p>
    <form id="f-horario-ia" class="horario-form">
      <label class="linha-check" style="margin:0"><input type="checkbox" name="ativo" ${h.ia.ativo ? 'checked' : ''}> <b>A IA só responde no horário</b> (Brasília)</label>
      <div class="horario-linha">das <input type="time" name="inicio" value="${esc(h.ia.inicio)}" required> às <input type="time" name="fim" value="${esc(h.ia.fim)}" required> <button type="submit" class="pequeno primario">Salvar</button></div>
      ${h.ia.esperando ? `<p class="rotulo" style="margin:6px 0 0">⏳ ${h.ia.esperando} cliente(s) esperando o horário abrir.</p>` : ''}
      ${h.ia.esperandoCredito ? `<p class="rotulo" style="margin:6px 0 0">⏳ ${h.ia.esperandoCredito} cliente(s) esperando a IA voltar (sem crédito ou no limite) — ela responde sozinha quando voltar.</p>` : ''}
    </form>`;
  marcarPronto(el, h.ia.ativo ? 'ok' : 'off', h.ia.ativo ? `${h.ia.inicio}–${h.ia.fim}` : 'Responde a qualquer hora');
  $('#f-horario-ia').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/horarios`, { method: 'PUT', body: { ia: { ativo: f.elements.ativo.checked, inicio: f.elements.inicio.value, fim: f.elements.fim.value } } }));
      aviso(f.elements.ativo.checked ? `A IA responde das ${f.elements.inicio.value} às ${f.elements.fim.value}.` : 'A IA responde a qualquer hora.');
      cartaoHorarioIa(id);
    } catch (err) { aviso(err.message, true); }
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

    <div class="card horario-auto" id="card-horario-envio"><p class="rotulo">Carregando horário…</p></div>

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
      ${d.receitas.map((r) => {
        // receita já ligada: controla a automação dela aqui mesmo (pausar/ligar e editar)
        const regra = r.jaTem ? d.regras.find((x) => x.receita === r.id) : null;
        return `
        <div class="card receita ${regra ? (regra.ativa ? 'ligada' : 'pausada') : ''}">
          <strong>${esc(r.nome)}</strong>
          <p class="rotulo">${esc(r.explicacao)}</p>
          ${regra ? `
            <div class="receita-controle">${interruptor(`receita-regra-${regra.id}`, regra.ativa, regra.ativa ? '<b>Ligada</b>' : '<b>Pausada</b>')}</div>
            <div class="rotulo" style="margin:6px 0">${regra.numeros.leadsAtingidos} receberam · ${regra.numeros.responderam} responderam · ${regra.numeros.prontosAgora} na fila</div>
            <div class="acoes" style="margin:0"><button type="button" class="pequeno" data-editar="${esc(regra.id)}">✏️ Editar</button></div>`
          : r.jaTem ? '<span class="etiqueta ok">✓ Na sua lista</span>' : `<button type="button" class="primario pequeno" data-receita="${esc(r.id)}">Ligar</button>`}
        </div>`;
      }).join('')}
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
    const naReceita = $(`#receita-regra-${r.id}`);
    if (naReceita) naReceita.onchange = async (e) => {
      try {
        await api(`empresas/${id}/automacoes/${r.id}`, { method: 'PUT', body: { ativa: e.target.checked } });
        aviso(e.target.checked ? `"${r.nome}" ligada.` : `"${r.nome}" pausada: ninguém recebe até você ligar de novo.`);
        paginaAutomacoes(id);
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
  cartaoHorarioEnvio(id);
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
      <p class="rotulo" style="margin:12px 0 0">Quem parou de responder é com o 🔁 Follow-up, no topo da página. O horário dos envios (no topo da página) é o mesmo para tudo.</p>
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
          ${ehAdmin() && (e.contas || []).length ? `<div class="cartao-empresa-contas rotulo">👤 ${e.contas.map((u) => `${esc(u.email)}${u.ativo ? '' : ' (bloqueado)'}`).join(', ')}</div>` : ''}
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
            ${e.ativa === false ? `<span class="etiqueta off">${(e.contas || []).length ? 'Conta desativada' : 'Pausada'}</span>` : ''}
            ${(e.dicas || []).some((x) => x.nivel === 'erro') ? '<span class="etiqueta off">Precisa de atenção</span>' : ''}${e.alertasNaoLidos ? `<span class="etiqueta aviso">${e.alertasNaoLidos} ${e.alertasNaoLidos === 1 ? 'alerta' : 'alertas'}</span>` : ''}
            <span class="abrir-seta" aria-hidden="true">→</span>
            </span>
          </div>
        </a>
        ${ehAdmin() ? `<button type="button" class="cartao-acesso ${e.ativa === false ? 'reativar' : ''}" data-acesso-empresa="${esc(e.id)}" data-ativar="${e.ativa === false ? '1' : ''}">${e.ativa === false ? '✅ Reativar conta' : '🚫 Desativar conta'}</button>` : ''}
        </div>`).join('')}
      ${ehAdmin() ? '<button type="button" class="cartao-empresa nova-empresa" id="nova-cartao"><span class="mais">+</span><strong>Nova empresa</strong><span class="rotulo">Cadastre um cliente e configure em minutos</span></button>' : ''}
    </div>`;
}

// ---------------------------------------------------------------- empresa: faturamento

// 📈 Aba Meta Ads: tudo de Meta Ads fica aqui
async function paginaMetaAds(id) {
  const hashDaPagina = location.hash;
  await definirEmpresaAtual(id);
  if (location.hash !== hashDaPagina) return;
  const ABAS = [['resumo', '📊 Resumo'], ['vendas', '💰 Vendas'], ['caminho', '🧭 Do anúncio ao WhatsApp'], ['config', '⚙️ Configurar']];
  let aba = 'resumo';
  try { aba = sessionStorage.getItem(`meta_aba_${id}`) || 'resumo'; } catch { /* ok */ }
  if (!ABAS.some(([k]) => k === aba)) aba = 'resumo';
  conteudo.innerHTML = `
    <div class="cabecalho"><div><h1>Meta Ads</h1><p class="sub">As vendas do CRM vão para a sua campanha do Facebook/Instagram</p></div></div>
    <nav class="abas-meta" role="tablist">${ABAS.map(([k, t]) => `<button type="button" role="tab" class="aba-meta ${k === aba ? 'ativa' : ''}" data-aba-meta="${k}" aria-selected="${k === aba}">${t}</button>`).join('')}</nav>
    <section data-painel-meta="resumo" ${aba === 'resumo' ? '' : 'hidden'}><div class="card" id="meta-resumo"><p class="rotulo">Carregando…</p></div></section>
    <section data-painel-meta="vendas" ${aba === 'vendas' ? '' : 'hidden'}><div class="card" id="card-meta-vendas"><p class="rotulo">Carregando vendas…</p></div></section>
    <section data-painel-meta="caminho" ${aba === 'caminho' ? '' : 'hidden'}><div class="card" id="meta-caminho"><p class="rotulo">Carregando…</p></div><div class="card tabela-wrap" id="card-meta-clientes"><p class="rotulo" style="padding:16px">Carregando clientes…</p></div></section>
    <section data-painel-meta="config" ${aba === 'config' ? '' : 'hidden'}><div class="card" id="card-meta-ads"><p class="rotulo">Carregando Meta Ads…</p></div></section>`;
  $$('[data-aba-meta]').forEach((b) => {
    b.onclick = () => irAbaMeta(id, b.dataset.abaMeta);
  });
  cartaoMetaAds(id);
}

// troca a aba da página Meta Ads (fica lembrada nesta sessão)
function irAbaMeta(id, aba) {
  $$('[data-aba-meta]').forEach((x) => { const sim = x.dataset.abaMeta === aba; x.classList.toggle('ativa', sim); x.setAttribute('aria-selected', String(sim)); });
  $$('[data-painel-meta]').forEach((x) => { x.hidden = x.dataset.painelMeta !== aba; });
  try { sessionStorage.setItem(`meta_aba_${id}`, aba); } catch { /* ok */ }
}

// Código do site, desta empresa: pega o fbclid de quem chega pelo anúncio e liga à conversa do WhatsApp
function codigoSiteMeta(empresaId, comChat) {
  return `<script src="${sessao.urlPublica}/chat.js" data-empresa="${empresaId}"${comChat ? '' : ' data-chat="nao"'} async></script>`;
}
function blocoCodigoSiteMeta(id, site, chegadas) {
  const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const v = site.visto || {};
  const item = (ok, html) => `<li>${ok === true ? '✅' : ok === false ? '❌' : '⚠️'} ${html}</li>`;
  const checagens = [
    item(site.assistente, site.assistente ? `Rastreio pronto (usa o WhatsApp do assistente)${site.chatLigado ? '' : ' — o chat da IA do site está desligado, então só rastreia, sem janelinha'}` : `Falta um assistente — crie em <a href="${rotaEmpresa(id, 'site')}">IA do site</a> (pode deixar só para rastrear)`),
    site.assistente ? item(site.whatsapp, site.whatsapp ? 'Número do WhatsApp configurado' : `Falta o número do WhatsApp no assistente do site — em <a href="${rotaEmpresa(id, 'site')}">IA do site</a>`) : '',
    item(true, site.dominios?.length ? `Funciona nos sites: <b>${esc(site.dominios.join(', '))}</b>` : 'Funciona em qualquer site (nenhum domínio restrito)'),
    v.bloqueado && (!v.ok || v.bloqueado.em > v.ok.em) ? item(false, `O site <b>${esc(v.bloqueado.host || '?')}</b> carregou o código em ${esc(quando(v.bloqueado.em))}, mas foi recusado: ${v.bloqueado.motivo === 'sem-assistente' ? 'a empresa não tem assistente do site ativo' : 'esse site não está na lista de domínios do assistente (IA do site)'}`) : '',
    v.ok ? item(true, `Código instalado: o site <b>${esc(v.ok.host || '?')}</b> carregou em ${esc(quando(v.ok.em))}`) : item(null, 'Ainda não vi o código rodando no site (desde a última atualização do CRM). Depois de instalar, abra o site uma vez e recarregue esta página.'),
    item(chegadas ? true : null, `${chegadas || 0} cliente(s) chegaram pelo site com o código nos últimos 30 dias`)
  ].join('');
  return `<div class="card-interno" id="codigo-site-meta" style="margin-top:14px">
    <h3 class="titulo-bloco" style="margin:0 0 6px">📋 Código do site — desta empresa</h3>
    <p class="rotulo" style="margin:0 0 8px">Cole esta linha no seu site, antes de <code>&lt;/body&gt;</code>, em todas as páginas que recebem o anúncio (uma vez só). Ela guarda o <b>fbclid</b> de quem chega pelo anúncio e, quando o cliente toca no botão do WhatsApp do site, a mensagem leva o código do atendimento e o CRM liga o clique à conversa.</p>
    <label class="linha-check"><input type="checkbox" id="meta-codigo-chat"> Mostrar também a janelinha de chat da IA no site</label>
    <div class="utm-valor" style="margin-top:6px"><code id="meta-codigo-texto" style="word-break:break-all">${esc(codigoSiteMeta(id, false))}</code><button type="button" class="pequeno" id="meta-codigo-copiar">Copiar</button></div>
    <p class="rotulo" style="margin:6px 0 0">Se o site já tem o código da IA do site (com <code>data-empresa="${esc(id)}"</code>), não precisa colar de novo.</p>
    <ul class="lista-checagem" style="margin:8px 0 0;padding-left:4px;list-style:none">${checagens}</ul>
    <h4 style="margin:14px 0 6px">🔎 Testar meu site</h4>
    <p class="rotulo" style="margin:0 0 6px">Depois de colar o código e publicar o site, digite o endereço da página do anúncio e teste: o CRM abre a página e confere se o código está lá, se o site está liberado e se o botão do WhatsApp é do mesmo número.</p>
    <form id="f-testar-site" class="utm-valor"><input name="url" style="flex:1;min-width:0" placeholder="www.seusite.com.br/pagina-do-anuncio" value="${esc(site.teste?.url || (site.dominios?.[0] ? `https://${site.dominios[0]}` : v.ok?.host && v.ok.host !== 'localhost' ? `https://${v.ok.host}` : ''))}"><button type="submit" class="primario">Testar</button></form>
    <div id="resultado-teste-site">${resultadoTesteSite(site.teste)}</div>
  </div>`;
}
function resultadoTesteSite(t) {
  if (!t) return '';
  const quando = new Date(t.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `<div class="meta-status ${t.ok ? 'ok' : 'erro'}" style="margin-top:8px"><b>${t.ok ? '✅ Código instalado no site' : '⚠️ Falta acertar no site'}</b><span>${esc(t.host)} · testado ${esc(quando)}</span></div>
    <ul class="lista-checagem" style="margin:6px 0 0;padding-left:4px;list-style:none">${(t.itens || []).map((i) => `<li>${i.ok === true ? '✅' : i.ok === false ? '❌' : '⚠️'} ${esc(i.texto)}</li>`).join('')}</ul>`;
}
function ligarCodigoSiteMeta(id) {
  const chk = $('#meta-codigo-chat');
  const txt = $('#meta-codigo-texto');
  if (!chk || !txt) return;
  chk.onchange = () => { txt.textContent = codigoSiteMeta(id, chk.checked); };
  $('#meta-codigo-copiar').onclick = () => {
    navigator.clipboard?.writeText(txt.textContent).then(() => aviso('Código do site copiado. Cole antes de </body> no seu site.')).catch(() => aviso(txt.textContent));
  };
  const ft = $('#f-testar-site');
  if (ft) ft.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await comEspera(ft.querySelector('button'), () => api(`empresas/${id}/meta-ads/testar-site`, { method: 'POST', body: { url: ft.elements.url.value } }));
      $('#resultado-teste-site').innerHTML = resultadoTesteSite(r);
    } catch (err) { aviso(err.message, true); }
  };
  $$('[data-ir-codigo-meta]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); irAbaMeta(id, 'config'); setTimeout(() => $('#codigo-site-meta')?.scrollIntoView({ behavior: 'smooth' }), 50); }; });
}

// 🧭 Do anúncio ao WhatsApp: quantos cliques no WhatsApp do site viraram conversa (e levaram o clique)
const PARAMETROS_UTM = 'utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}';
function caminhoDoAnuncio(m) {
  const c = m.caminho?.doAnuncio || {};
  const t = m.caminho?.todos || {};
  const chegaram = (c.pelaMensagem || 0) + (c.pelaHora || 0);
  const taxa = c.cliques ? Math.round((chegaram / Math.max(1, c.cliques - (c.esperando || 0))) * 100) : null;
  return `<div class="meta-caminho">
    <p style="margin:0 0 6px"><b>🧭 Do anúncio ao WhatsApp (30 dias)</b></p>
    ${c.cliques ? `<p style="margin:0 0 4px">Pessoas que vieram do anúncio e clicaram no WhatsApp do site: <b>${c.cliques}</b> · chegaram como conversa (levando o clique para a Meta): <b>${chegaram}</b>${c.pelaHora ? ` (${c.pelaHora} sem o código, ligadas pelo horário do clique)` : ''}${c.esperando ? ` · ${c.esperando} ainda podem chegar` : ''} · <b class="${c.perdidos ? 'aviso-texto' : ''}">não chegaram: ${c.perdidos || 0}</b>${taxa != null ? ` · <b>${taxa}%</b> de aproveitamento` : ''}.</p>
    <p style="margin:0 0 4px" class="rotulo">"Não chegaram" = clicou no botão do WhatsApp do site e a mensagem não veio (desistiu, ou mandou de outro jeito, ou apagou o código e mais de uma pessoa clicou no mesmo horário). Esses clientes, se comprarem, vão sem o clique.</p>`
      : `<p style="margin:0 0 4px">${t.cliques ? `${t.cliques} clique(s) no WhatsApp do site nos últimos 30 dias, mas <b>nenhum veio de anúncio</b> (sem o fbclid no endereço).` : 'Ainda não houve clique no WhatsApp do site registrado desde esta atualização.'} Confira se o anúncio leva para o site com o código do CRM instalado.</p>`}
    <p style="margin:8px 0 4px"><b>Para saber a campanha e o anúncio de cada cliente</b>, cole isto no anúncio, em <b>Rastreamento → Parâmetros de URL</b> (a Meta troca as {{…}} pelo nome certo):</p>
    <div class="utm-copiar"><code>${esc(PARAMETROS_UTM)}</code><button type="button" class="pequeno" data-copiar="${esc(PARAMETROS_UTM)}">Copiar</button></div>
    <p style="margin:4px 0 0" class="rotulo">Isso mostra no CRM de qual campanha/anúncio veio cada lead. Quem liga a venda à campanha para a Meta é o clique (fbclid), que a Meta já coloca sozinha no link do anúncio.</p>
  </div>`;
}

// 📋 Vendas para a Meta: cada venda de cliente do anúncio, os critérios (✓/✗) e se foi enviada
function cartaoVendasMeta(id, m) {
  const el = $('#card-meta-vendas');
  if (!el) return;
  const hora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const env = m.envio || {};
  const STATUS = {
    enviada: ['ok', '✅ Enviada com o clique do anúncio'],
    'enviada-sem-clique': ['aviso', '📨 Recebida pela Meta, sem o clique'],
    'enviada-mensagem': ['ok', '💬 Enviada — campanha de mensagem'],
    teste: ['aviso', '🧪 Só em Eventos de teste'],
    'sem-confirmacao': ['erro', '⚠️ Meta não confirmou o recebimento'],
    pronta: ['aviso', '🕐 Pronta — vai no próximo envio'],
    esperando: ['aviso', '⏳ Esperando'],
    erro: ['erro', '⚠️ Erro ao enviar'],
    'nao-vai': ['off', '⛔ Não vai'],
    desligado: ['off', '⚪ Envio desligado']
  };
  const lista = (itens) => itens.map(([n, ok]) => `<span class="${ok ? 'crit-ok' : 'crit-falta'}">${ok ? '✓' : '✗'} ${esc(n)}</span>`).join(' ');
  const linhas = (m.criterios || []).map((v) => {
    const [cls, rotulo] = STATUS[v.status] || ['off', v.status];
    return `<tr>
      <td style="white-space:nowrap">${esc(hora(v.em))}<br>${v.leadId ? `<a href="#/leads/${esc(v.leadId)}">${esc(v.cliente || 'Cliente')}</a>` : esc(v.cliente || '—')}<br><b>${brl(v.valor)}</b>${v.campanha ? `<div class="rotulo campanha-venda">${v.campanha.via === 'mensagem' ? '💬' : '🌐'} ${blocoCampanha(v.campanha, true) || (v.campanha.via === 'mensagem' ? 'campanha de mensagem' : 'campanha para o site')}</div>` : ''}<div class="rotulo">${esc(v.origemValor || '')}</div>${v.valorEnviado != null && Number(v.valorEnviado) !== Number(v.valor) ? `<div class="rotulo">foi para a Meta: <b>${brl(v.valorEnviado)}</b></div>` : ''}</td>
      <td class="crit">${lista(v.obrigatorios)}<div class="rotulo" style="margin-top:3px">extras: ${lista(v.extras)}</div></td>
      <td><span class="etiqueta-status ${cls}">${rotulo}</span><div class="rotulo" style="margin-top:3px">${esc(v.situacao)}</div></td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="cabecalho" style="margin-bottom:6px"><div><h2 style="margin:0">Vendas para a Meta</h2><p class="sub" style="margin:2px 0 0">${m.todasVendas ? 'Vendas dos últimos 30 dias' : 'Vendas de clientes que vieram do anúncio (30 dias)'}, o que cada uma tem e se foi enviada.</p></div>
      <button type="button" id="meta-enviar-agora" ${m.pronto ? '' : 'disabled'}>Enviar agora</button></div>
    <p class="rotulo" style="margin:0 0 10px">⏱️ Envio de hora em hora${env.ultimo ? ` · último: <b>${esc(hora(env.ultimo))}</b>${env.enviadasNoUltimo != null ? ` (${env.enviadasNoUltimo} venda${env.enviadasNoUltimo === 1 ? '' : 's'})` : ''} · próximo: ~<b>${esc(hora(env.proximo))}</b>` : ' · ainda não rodou desde esta atualização'}${m.pronto ? '' : ' · <span class="aviso-texto">envio desligado ou falta configurar</span>'}</p>
    <p class="rotulo" style="margin:0 0 8px">⏳ Venda com comprovante espera 3 h e venda sem comprovante (IA, frase, à mão) espera 6 h antes de ir: dá tempo de o comprovante chegar e corrigir o valor, e os pagamentos do mesmo cliente no mesmo dia (sinal + restante) vão juntos como <b>uma</b> compra com o valor somado.</p>
    <p class="rotulo" style="margin:0 0 8px">${m.todasVendas ? 'Modo <b>todas as vendas</b>: para ir é preciso confirmada · com valor · telefone · até 7 dias (prazo da Meta). O clique do anúncio e os extras ajudam a Meta a ligar a venda ao anúncio.' : 'Para ir é preciso <b>todos</b> estes: confirmada · com valor · veio do anúncio (campanha para o site com o clique, ou campanha de mensagem do WhatsApp) · telefone · até 30 dias do anúncio · até 7 dias (prazo da Meta). Os extras ajudam a Meta a reconhecer o cliente.'}</p>
    <details class="meta-legenda">
      <summary><b>Como ler o status</b></summary>
      <p style="margin:0 0 4px">✅ <b>Enviada com o clique do anúncio</b>: a Meta confirmou o recebimento e tem o clique, então liga a venda à campanha (aparece como compra no Gerenciador de Anúncios, se a venda for até 7 dias depois do clique — prazo padrão da Meta).</p>
      <p style="margin:0 0 4px">📨 <b>Recebida pela Meta, sem o clique</b>: a Meta confirmou o recebimento e a compra está no <b>Gerenciador de Eventos</b> (Pixel → Visão geral → Purchase). Ela só entra como compra da <b>campanha</b> se a Meta reconhecer o cliente (pelo telefone e nome) entre quem viu ou clicou no anúncio — às vezes reconhece, às vezes não. Acontece quando o cliente não chegou pelo botão de WhatsApp do site (ou mandou a mensagem de outro jeito).</p>
      <p style="margin:0 0 4px">💬 <b>Enviada — campanha de mensagem</b>: cliente que veio de anúncio que abre o WhatsApp direto. Esse tipo de anúncio não tem o clique do site; a venda vai com o telefone do cliente (o mesmo que mandou a mensagem pelo anúncio) e a Meta liga à campanha quando reconhece a pessoa.</p>
      <p style="margin:0">🧪 <b>Só em Eventos de teste</b>: foi com o código de teste e não conta na campanha. ⚠️ <b>Erro</b> ou <b>Meta não confirmou</b>: não foi; o CRM tenta de novo.</p>
      ${m.enviadas ? `<p style="margin:6px 0 0">Nos registros: <b>${m.enviadasComClique || 0}</b> com o clique do site · <b>${m.enviadasMensagem || 0}</b> de campanha de mensagem · <b>${m.enviadasSemClique || 0}</b> sem o clique${m.semConfirmacao ? ` · <b>${m.semConfirmacao}</b> sem confirmação` : ''}.</p>` : ''}
    </details>
    ${linhas ? `<div class="tabela-wrap"><table><thead><tr><th>Venda</th><th>Critérios</th><th>Status</th></tr></thead><tbody>${linhas}</tbody></table></div>` : '<p class="rotulo">Nenhuma venda de cliente que veio do anúncio nos últimos 30 dias.</p>'}
    ${m.semClique ? `<p class="rotulo" style="margin:8px 0 0">${m.semClique} venda(s) confirmada(s) nos últimos 30 dias de clientes <b>sem</b> o clique do anúncio — não entram (não vieram pelo site com o código ou não vieram de anúncio).</p>` : ''}`;
  $('#meta-enviar-agora').onclick = async (e) => {
    try {
      const r = await comEspera(e.currentTarget, () => api(`empresas/${id}/meta-ads/enviar-agora`, { method: 'POST' }));
      aviso(r.enviadas ? `${r.enviadas} venda(s) enviada(s) para a Meta agora.` : 'Nenhuma venda pronta para enviar agora.');
      cartaoMetaAds(id);
    } catch (err) { aviso(err.message, true); }
  };
}

// 📈 Meta Ads: vendas de quem veio de anúncio do Facebook/Instagram vão para o Pixel (API de Conversões)
async function cartaoMetaAds(id) {
  const el = $('#card-meta-ads');
  if (!el) return;
  let m;
  try { m = await api(`empresas/${id}/meta-ads`); } catch (err) { el.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`; return; }
  if (!el.isConnected) return;
  const t = m.testes || {};
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const enviadas = m.enviadas || 0;
  const status = !m.pixelId || !m.tokenSalvo ? ['off', '⚪ Falta configurar', 'Cole o ID do Pixel e o token abaixo.']
    : !m.ativo ? ['erro', '⛔ Desligado', 'Nenhuma venda está indo para a Meta. Marque "Enviar vendas para a campanha" e salve.']
    : m.codigoTeste ? ['aviso', '🧪 Em modo teste', 'As vendas vão só para "Eventos de teste" e NÃO contam na campanha. Apague o código de teste e salve.']
    : t.conexao && !t.conexao.ok ? ['erro', '⚠️ A Meta recusou', t.conexao.erro || 'Teste a conexão.']
    : ['ok', '✅ Enviando vendas para a campanha', `${enviadas} venda(s) recebida(s) pela Meta: ${m.enviadasComClique || 0} de campanha para o site (com o clique), ${m.enviadasMensagem || 0} de campanha de mensagem e ${m.enviadasSemClique || 0} sem o clique. Funciona sozinho com os dois tipos de campanha. As vendas prontas vão de hora em hora.`];
  const ajudaMeta = (titulo, html) => `<details class="meta-ajuda"><summary>❓ ${titulo}</summary><div class="rotulo">${html}</div></details>`;
  const semSite = !m.chegadasDoSite30d && !m.clientesComClique;
  const avisoSemSite = semSite ? `<div class="balao balao-aviso" style="margin:10px 0 0"><span class="balao-icone">⚠️</span><div><strong>O CRM ainda não recebe o clique do anúncio (fbclid)</strong><div class="balao-texto">Nos últimos 30 dias nenhum cliente chegou pelo seu site com o código do CRM. Sem ele, o CRM não sabe quem veio do anúncio de site. Instale o código do CRM no site (uma linha, uma vez só): veja <a href="#" data-ir-codigo-meta>Código do site</a> em Configurar. (Campanha de mensagem funciona sem o código.)</div></div></div>` : '';
  const resumo = $('#meta-resumo');
  if (resumo) {
    const c = m.caminho?.doAnuncio || {};
    const chegaram = (c.pelaMensagem || 0) + (c.pelaHora || 0);
    const taxa = c.cliques ? `${Math.round((chegaram / Math.max(1, c.cliques - (c.esperando || 0))) * 100)}%` : '—';
    resumo.innerHTML = `
      <div class="meta-status ${status[0]}"><b>${status[1]}</b><span>${status[2]}</span></div>
      ${avisoSemSite}
      <div class="grade-resumo compacta meta-numeros">
        ${numeroCard('Vendas na Meta com o clique do site', m.enviadasComClique || 0)}
        ${numeroCard('Vendas na Meta de campanha de mensagem', m.enviadasMensagem || 0)}
        ${numeroCard('Clientes do anúncio (30 dias)', (m.clientesComClique || 0) + (m.clientesMensagem || 0))}
        ${numeroCard('Cliques do anúncio que viraram conversa', taxa)}
      </div>
      ${(m.vendasPorCampanha || []).length ? '' : '<p class="rotulo" style="margin:12px 0 0">Ainda não há vendas confirmadas nos últimos 30 dias para mostrar por campanha.</p>'}
      ${(m.vendasPorCampanha || []).length ? `<div class="meta-caminho"><p style="margin:0 0 6px"><b>📊 Vendas por campanha e anúncio (30 dias)</b></p><div class="tabela-wrap" style="margin:0"><table><thead><tr><th>Campanha</th><th>Anúncio</th><th class="num">Vendas</th><th class="num">Valor</th><th class="num">Na Meta</th></tr></thead><tbody>${m.vendasPorCampanha.map((g) => `<tr><td>${g.via === 'mensagem' ? '💬 ' : g.via === 'site' ? '🌐 ' : ''}${esc(g.campanha)}</td><td>${esc(g.anuncio || '—')}</td><td class="num">${g.vendas}</td><td class="num">${brl(g.valor)}</td><td class="num">${g.naMeta}</td></tr>`).join('')}</tbody></table></div>${m.vendasPorCampanha.some((g) => g.soNumeros) ? '<p class="rotulo" style="margin:6px 0 0">"nº …" é o número (ID) da campanha na Meta. Com o UTM de nomes no anúncio, aparece o nome.</p>' : ''}</div>` : ''}
      <p class="rotulo" style="margin:12px 0 0">Veja cada venda em <a href="#" data-ir-aba="vendas">Vendas</a> · de onde vêm os clientes em <a href="#" data-ir-aba="caminho">Do anúncio ao WhatsApp</a> · Pixel, token e código do site em <a href="#" data-ir-aba="config">Configurar</a>.</p>`;
    $$('[data-ir-aba]', resumo).forEach((a) => { a.onclick = (e) => { e.preventDefault(); irAbaMeta(id, a.dataset.irAba); }; });
  }
  const caminho = $('#meta-caminho');
  if (caminho) {
    caminho.innerHTML = caminhoDoAnuncio(m);
    $$('[data-copiar]', caminho).forEach((b) => { b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copiar).then(() => aviso('Copiado. Cole no anúncio, em Parâmetros de URL.')).catch(() => aviso(b.dataset.copiar)); }; });
  }
  el.innerHTML = `
    <div class="meta-status ${status[0]} compacto"><b>${status[1]}</b></div>
    ${avisoSemSite}

    ${blocoCodigoSiteMeta(id, m.site || {}, m.chegadasDoSite30d)}

    <form id="f-meta-ads" style="margin-top:14px">
      <label class="linha-check meta-ligar"><input type="checkbox" name="ativo" ${m.ativo ? 'checked' : ''}> <b>Enviar vendas para a campanha</b></label>
      <label class="linha-check" style="margin-top:8px"><input type="checkbox" name="todasVendas" ${m.todasVendas ? 'checked' : ''}> <b>Enviar todas as vendas válidas</b> (também as sem o clique do anúncio)</label>
      <p class="rotulo" style="margin:6px 0 0">${m.todasVendas ? 'Vai toda venda <b>confirmada, com valor e com telefone</b>. Com o clique do anúncio (fbclid) a Meta liga a venda ao clique exato; sem ele, reconhece o cliente pelo <b>telefone</b> e só conta para a campanha se ele viu ou clicou num anúncio seu. Mais vendas = mais inteligência para a campanha.' : 'Vai a venda <b>confirmada, com valor e com telefone</b> de cliente que veio do anúncio — funciona sozinho com os <b>dois tipos de campanha</b>: <b>para o site</b> (lead/landing page: o CRM guarda o clique, fbclid) e <b>de mensagem</b> (anúncio que abre o WhatsApp: o CRM reconhece a mensagem do anúncio e manda pelo telefone). Marque a opção acima para mandar também as vendas de quem não veio de anúncio (a Meta reconhece pelo telefone).'}</p>
      <div class="campos" style="margin-top:10px">
        <div class="campo"><label>ID do Pixel</label><input name="pixelId" value="${esc(m.pixelId)}" inputmode="numeric" placeholder="só números"></div>
        <div class="campo"><label>Token da API de Conversões</label><input name="token" type="password" autocomplete="new-password" placeholder="${m.tokenSalvo ? `salvo — termina em …${esc(m.tokenFim)} (cole outro para trocar)` : 'cole o token'}"></div>
      </div>
      <div class="acoes">
        <button type="submit" class="primario">Salvar</button>
        <button type="button" id="testar-meta" ${m.pixelId && m.tokenSalvo ? '' : 'disabled'}>Testar conexão</button>
      </div>
      ${t.conexao ? `<p class="rotulo" style="margin:4px 0 0">Último teste: ${t.conexao.ok ? `✅ a Meta aceitou (${quando(t.conexao.em)})` : `<span class="texto-erro">${esc(t.conexao.erro)}</span>`}</p>` : ''}
      <details class="meta-ajuda" ${m.codigoTeste ? 'open' : ''}><summary>🧪 Testar antes com "Eventos de teste" (opcional)</summary>
        <div class="campo" style="margin-top:8px"><label>Código de teste ${ajuda('Pixel → Eventos de teste → código tipo TEST12345. Com ele, as vendas vão só para Eventos de teste e NÃO contam na campanha — apague depois de testar.')}</label><input name="codigoTeste" value="${esc(m.codigoTeste)}" placeholder="TEST12345 (apague depois de testar)"></div>
        <div class="acoes"><button type="button" id="compra-teste-meta" ${m.pixelId && m.tokenSalvo && m.codigoTeste ? '' : 'disabled'}>Enviar compra de teste</button></div>
        ${t.evento ? `<p class="rotulo" style="margin:0">${t.evento.ok ? `✅ compra de teste enviada ${quando(t.evento.em)} — confira em "Eventos de teste" no Pixel` : `<span class="texto-erro">${esc(t.evento.erro)}</span>`}</p>` : ''}
      </details>
    </form>

    <h3 class="titulo-bloco" style="margin-top:18px">Como fazer</h3>
    ${ajudaMeta('Onde acho o ID do Pixel', 'Entre em <a href="https://business.facebook.com/events_manager2" target="_blank" rel="noopener">Gerenciador de Eventos</a> → <b>Fontes de dados</b> → clique no Pixel do seu site → o <b>número</b> embaixo do nome. Tem que ser o <b>mesmo Pixel que está no seu site</b>.')}
    ${ajudaMeta('Como gerar o token', 'No Gerenciador de Eventos, abra o Pixel → <b>Configurações</b> → desça até <b>API de Conversões</b> → <b>Gerar token de acesso</b>. Copie o token inteiro e cole aqui. Use uma conta que seja <b>administradora</b> do negócio.')}
    ${ajudaMeta('Como ligar à campanha', '<ol><li>No <a href="https://adsmanager.facebook.com" target="_blank" rel="noopener">Gerenciador de Anúncios</a>, abra a campanha → o <b>conjunto de anúncios</b>.</li><li>Em <b>Conversão</b> / <b>Conjunto de dados</b>, escolha <b>este mesmo Pixel</b>.</li><li>Para a campanha aprender a vender, use o objetivo <b>Vendas</b> com o evento <b>Compra</b>. Campanha de <b>Leads/Tráfego</b> também recebe as compras — elas aparecem nas colunas, mas a Meta não otimiza para elas.</li><li>Nada mais: o CRM manda a <b>Compra</b> com o valor para esse Pixel, e a Meta liga a venda ao anúncio que a pessoa viu ou clicou.</li></ol>')}
    ${ajudaMeta('Onde vejo as vendas na campanha', 'No Gerenciador de Anúncios → <b>Colunas</b> → <b>Personalizar colunas</b> → marque <b>Compras</b> e <b>Valor de conversão de compras</b>. Pode levar algumas horas. No Gerenciador de Eventos → seu Pixel → <b>Visão geral</b>, o evento <b>Purchase</b> aparece com a origem <b>Servidor</b>.')}
    ${ajudaMeta('Quais vendas vão e quando', 'As vendas <b>confirmadas, com valor, de cliente que clicou no anúncio e com telefone</b>, de hora em hora (ou na hora, no botão Enviar agora). Cada venda vai uma vez só. A Meta só aceita vendas dos <b>últimos 7 dias</b> — ao ligar, as dos últimos 7 dias vão na hora. O telefone e o nome vão <b>criptografados</b>. Venda de cliente sem telefone (contato escondido do WhatsApp) não vai, porque a Meta não teria como reconhecer.')}

    `;
  const lc = $('#card-meta-clientes');
  if (lc && !m.clientes.length) lc.remove();
  else if (lc) lc.innerHTML = `<div class="cabecalho" style="padding:16px 16px 0;margin-bottom:8px"><h2 style="margin:0">Clientes que vieram de anúncio (30 dias)</h2></div>
    ${m.clientes.length ? `<table><thead><tr><th>Clicou</th><th>Cliente</th><th class="esconde-mobile">Campanha</th><th>Comprou?</th></tr></thead><tbody>${m.clientes.map((c) => `<tr><td style="white-space:nowrap">${esc(quando(c.clicouEm))}</td><td><a href="#/leads/${esc(c.id)}">${esc(c.nome || 'Cliente')}</a><br><code class="rotulo" title="${esc(c.fbclid || '')}">fbclid ${esc(String(c.fbclid || '').slice(0, 10))}…</code></td><td class="esconde-mobile rotulo">${esc(c.campanha || '—')}</td><td>${c.comprou ? `<span class="etiqueta ok">✓ ${brl(c.comprou)}</span>` : '<span class="rotulo">ainda não</span>'}</td></tr>`).join('')}</tbody></table>` : '<p class="rotulo" style="padding:0 16px 16px">Nenhum cliente com clique de anúncio do Facebook/Instagram nos últimos 30 dias. Eles aparecem aqui quando chegam no site pelo anúncio e chamam no WhatsApp pelo botão do site.</p>'}`;
  ligarCodigoSiteMeta(id);
  cartaoVendasMeta(id, m);
  const f = $('#f-meta-ads');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const corpo = { ativo: f.elements.ativo.checked, todasVendas: f.elements.todasVendas.checked, pixelId: f.elements.pixelId.value, codigoTeste: f.elements.codigoTeste.value };
    if (f.elements.token.value.trim()) corpo.token = f.elements.token.value.trim();
    try {
      await comEspera(f.querySelector('button[type=submit]'), () => api(`empresas/${id}/meta-ads`, { method: 'PUT', body: corpo }));
      aviso(corpo.ativo ? (corpo.codigoTeste ? 'Salvo em MODO TESTE: as vendas não contam na campanha até você apagar o código de teste.' : 'Ligado: as vendas prontas vão para a campanha de hora em hora.') : 'Salvo (desligado): nenhuma venda vai para a Meta.');
      cartaoMetaAds(id);
    } catch (err) { aviso(err.message, true); }
  };
  $('#testar-meta').onclick = async (e) => {
    try {
      const r = await comEspera(e.currentTarget, () => api(`empresas/${id}/meta-ads/testar`, { method: 'POST' }));
      aviso('Conexão ok: a Meta aceitou um evento de teste neste Pixel (não conta na campanha).');
    } catch (err) { aviso(err.message, true); }
    cartaoMetaAds(id);
  };
  $('#compra-teste-meta').onclick = async (e) => {
    try {
      await comEspera(e.currentTarget, () => api(`empresas/${id}/meta-ads/compra-teste`, { method: 'POST' }));
      aviso('Compra de teste enviada. Abra "Eventos de teste" no Pixel: em até 1 minuto aparece uma Compra (Purchase) de 1 BRL.');
    } catch (err) { aviso(err.message, true); }
    cartaoMetaAds(id);
  };
}

async function paginaFaturamento(id, params) {
  const hashDaPagina = location.hash;
  const emp = await definirEmpresaAtual(id);
  const mes = params.get('mes') || '';
  // período da lista de vendas: o que veio no link, senão o último escolhido (fica lembrado)
  let lembrado = {};
  try { lembrado = JSON.parse(localStorage.getItem('faturamento-periodo') || '{}'); } catch { /* sem preferência */ }
  const chavePer = mes ? 'datas' : params.get('periodo') || lembrado.chave || 'tudo';
  const per = mes
    ? (() => { const [a, m] = mes.split('-').map(Number); return { de: `${mes}-01`, ate: `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}` }; })()
    : periodoVendas(chavePer, params.get('de') || lembrado.de, params.get('ate') || lembrado.ate);
  const [d, gd] = await Promise.all([api(`empresas/${id}/faturamento?${new URLSearchParams({ de: per.de, ate: per.ate })}`), api(`empresas/${id}/gastos?${new URLSearchParams(mes ? { mes } : per.de ? { de: per.de, ate: per.ate } : { tudo: '1' })}`).catch(() => null)]);
  const r = d.resumo;
  const cfg = d.config;
  const variacao = r.mesAnterior ? Math.round(((r.mes - r.mesAnterior) / r.mesAnterior) * 100) : null;
  const maxDia = Math.max(...r.porDia.map((x) => x.total), 0);
  const topo = maxDia ? Math.ceil(maxDia / 10 ** Math.floor(Math.log10(maxDia))) * 10 ** Math.floor(Math.log10(maxDia)) : 100;
  const iMaior = r.porDia.findIndex((x) => x.total === maxDia && maxDia > 0);
  const rotuloPeriodo = per.de ? (per.de === per.ate ? per.de.split('-').reverse().join('/') : `${per.de.split('-').reverse().join('/')} a ${per.ate.split('-').reverse().join('/')}`) : 'Todo o período';
  const ROTULO_ORIGEM = { texto: '📄 lido do PDF', ocr: '📷 lido da foto', ia: '✨ lido pela IA', manual: '✍️ lançada à mão', 'ia-conversa': '🤖 fechada pela IA na conversa', equipe: '👤 marcada pela equipe', frase: '💬 frase de venda da equipe' };

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

    <div class="card filtro-periodo" id="filtro-periodo">
      <h2 style="margin:0 0 8px">📅 Período</h2>
        <div class="chips">${PERIODOS_VENDAS.map(([k, t]) => `<button type="button" class="chip-filtro ${chavePer === k ? 'ativo' : ''}" data-per-venda="${k}">${t}</button>`).join('')}</div>
        ${chavePer === 'datas' ? `<div class="campos" style="margin-top:10px"><div class="campo"><label>De</label><input type="date" id="venda-de" value="${esc(per.de)}"></div><div class="campo"><label>Até</label><input type="date" id="venda-ate" value="${esc(per.ate)}"></div></div>` : ''}
      <p class="rotulo" style="margin:8px 0 0">Vale para o quadro de faturamento, gastos e lucro e para a lista de vendas. Os números de Hoje / 7 dias / Este mês e o gráfico ficam sempre iguais.</p>
    </div>

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

    ${gd ? htmlGastos(gd, mes ? null : rotuloPeriodo) : ''}

    <p class="rotulo">📈 Vendas de quem veio de anúncio do Facebook/Instagram vão para a Meta pela aba <a href="${rotaEmpresa(id, 'meta-ads')}">Meta Ads</a>.</p>
    <div class="card tabela-wrap">
      <div style="padding:16px 16px 0">
        <h2 style="margin:0 0 8px">Vendas</h2>
        <div class="periodo-vendas">
          <div><span class="rotulo">${esc(rotuloPeriodo)}</span><b>${brl(d.periodo.total)}</b></div>
          <div><span class="rotulo">Vendas confirmadas</span><b>${d.periodo.vendas}</b></div>
          <div><span class="rotulo">Ticket médio</span><b>${brl(d.periodo.ticket)}</b></div>
          ${d.periodo.custo ? `<div><span class="rotulo">Custo dos produtos</span><b>${brl(d.periodo.custo)}</b></div><div><span class="rotulo">Lucro das vendas</span><b class="margem-ok">${brl(d.periodo.lucro)}</b>${d.periodo.semCusto ? `<span class="rotulo">${d.periodo.semCusto} venda(s) sem custo</span>` : ''}</div>` : ''}
          ${d.periodo.aConferir ? `<div><span class="rotulo">A conferir</span><b class="aviso-texto">${d.periodo.aConferir}</b></div>` : ''}
        </div>
      </div>
      <table>
        <thead><tr><th>Data</th><th>Cliente</th><th>Valor</th><th class="esconde-mobile">Como entrou</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          ${d.vendas.length ? d.vendas.map((v) => `
            <tr class="${v.status === 'cancelada' ? 'cancelada' : ''}">
              <td style="white-space:nowrap">${data(v.data)}</td>
              <td>${v.leadId ? `<a href="#/leads/${esc(v.leadId)}">${esc(v.cliente || v.leadNome || 'Cliente')}</a>` : esc(v.cliente || v.pagador || '—')}${v.descricao ? `<br><span class="rotulo">${esc(v.descricao)}</span>` : ''}</td>
              <td style="white-space:nowrap"><b>${brl(v.valor)}</b><br><span class="rotulo">${esc(v.forma)}</span>${v.custoInfo ? `<br><span class="rotulo" title="${esc(v.custoInfo.item ? `Custo de ${v.custoInfo.item}` : 'Custo da venda')}${v.custoInfo.estimado ? ' (estimado pelo preço — escolha o produto em Editar para confirmar)' : ''}">custo ${brl(v.custoInfo.custo)}${v.custoInfo.estimado ? '*' : ''} · lucro <b class="${v.valor - v.custoInfo.custo >= 0 ? 'margem-ok' : 'margem-ruim'}">${brl(Math.round((v.valor - v.custoInfo.custo) * 100) / 100)}</b></span>` : ''}</td>
              <td class="esconde-mobile rotulo">${ROTULO_ORIGEM[v.lidoPor] || esc(v.lidoPor || '—')}${v.comprovanteUrl ? `<br><a href="${esc(v.comprovanteUrl)}" target="_blank" rel="noopener">ver comprovante</a>` : ''}</td>
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

  // período das vendas: muda o link (dá para voltar) e fica lembrado para a próxima vez
  const irPeriodo = (chave, de = '', ate = '') => {
    try { localStorage.setItem('faturamento-periodo', JSON.stringify({ chave, de, ate })); } catch { /* sem armazenamento */ }
    location.hash = `${rotaEmpresa(id, 'faturamento')}?${new URLSearchParams(chave === 'datas' ? { periodo: chave, de, ate } : { periodo: chave })}`;
  };
  $$('[data-per-venda]').forEach((b) => { b.onclick = () => (b.dataset.perVenda === 'datas' ? irPeriodo('datas', per.de || periodoVendas('7d').de, per.ate || periodoVendas('7d').ate) : irPeriodo(b.dataset.perVenda)); });
  const mudarDatas = () => irPeriodo('datas', $('#venda-de').value, $('#venda-ate').value);
  $('#venda-de')?.addEventListener('change', mudarDatas);
  $('#venda-ate')?.addEventListener('change', mudarDatas);
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
function htmlGastos(gd, rotuloPeriodo = null) {
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
      <div class="cabecalho" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">💸 Faturamento e gastos · ${esc(rotuloPeriodo || nomeMes)}</h2>
        <div class="barra"><button type="button" class="pequeno" id="gastos-categorias">Categorias</button><button type="button" class="primario pequeno" id="novo-gasto">+ Lançar gasto</button></div></div>
      ${grupo}
      <div class="grade-resumo gastos-numeros">
        ${numeroCard('Faturamento', brl(r.faturamento))}
        ${r.custoVendas ? numeroCard('Custo dos produtos', brl(r.custoVendas), 'gasto') : ''}
        ${numeroCard('Gastos', brl(r.gastos), 'gasto')}
        ${numeroCard(r.lucro >= 0 ? 'Sobrou (lucro)' : 'Faltou (prejuízo)', brl(r.lucro), r.lucro >= 0 ? 'lucro' : 'prejuizo')}
      </div>
      ${r.porCategoria.length ? `<h3 style="margin:14px 0 8px">Gastos por categoria</h3><div class="gastos-categorias">${r.porCategoria.map((x) => `<div class="cat-gasto"><span class="cat-nome">${esc(x.categoria)}</span><span class="cat-barra"><span style="width:${maior ? Math.max(3, (x.total / maior) * 100) : 0}%"></span></span><b>${brl(x.total)}</b><span class="rotulo">${r.gastos ? Math.round((x.total / r.gastos) * 100) : 0}%</span></div>`).join('')}</div>` : `<p class="rotulo" style="margin:12px 0 0">Nenhum gasto ${rotuloPeriodo ? 'neste período' : 'neste mês'} ainda.</p>`}
      ${gd.gastos.length ? `<details class="gastos-lista" style="margin-top:12px"><summary>Ver os ${gd.gastos.length} gasto(s) ${rotuloPeriodo ? 'do período' : 'do mês'}</summary>
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
        <div class="campo"><label>Produto/serviço ${ajuda('Escolha da sua lista de Serviços e preços: o custo dele entra no lucro.')}</label><select name="itemId"><option value="">— nenhum —</option>${v?.itemId ? `<option value="${esc(v.itemId)}" selected>${esc(v.itemNome || 'Produto escolhido')}</option>` : ''}</select></div>
        <div class="campo"><label>Custo desta venda (R$) ${ajuda('Vem do produto escolhido. Pode mudar (ex.: vendeu 2 unidades). Vazio = usa o custo do produto.')}</label><input name="custo" inputmode="decimal" value="${v?.custo != null ? esc(String(v.custo).replace('.', ',')) : ''}" placeholder="${v?.custoInfo?.estimado ? esc(`${brl(v.custoInfo.custo)} (estimado)`) : 'opcional'}"></div>
        <div class="campo largo"><label>O que foi vendido (opcional)</label><input name="descricao" value="${esc(v?.descricao || '')}" placeholder="Ex.: o que foi vendido"></div>
      </div>
      <p class="rotulo" id="venda-lucro" style="margin:4px 0 0"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button>${v ? '<button type="button" class="perigo" id="apagar-venda" style="margin-left:auto">Apagar</button>' : ''}</div>
    </form>`, (m, fechar) => {
    // produtos/serviços do catálogo: escolher preenche o valor (se vazio) e o custo
    const fv = $('#f-venda', m);
    let itens = [];
    const lucroVivo = () => {
      const valor = lerValorBr(fv.elements.valor.value);
      const item = itens.find((x) => x.id === fv.elements.itemId.value);
      const custo = lerValorBr(fv.elements.custo.value) ?? item?.custo ?? null;
      $('#venda-lucro', m).innerHTML = valor != null && custo != null ? `Lucro desta venda: <b class="${valor - custo >= 0 ? 'margem-ok' : 'margem-ruim'}">${esc(brl(Math.round((valor - custo) * 100) / 100))}</b>` : '';
    };
    api(`empresas/${emp.id}/catalogo`).then((d) => {
      itens = d.itens || [];
      const sel = fv.elements.itemId;
      sel.insertAdjacentHTML('beforeend', itens.filter((x) => x.id !== v?.itemId || !sel.querySelector(`option[value="${CSS.escape(x.id)}"]`)).map((x) => `<option value="${esc(x.id)}" ${x.id === v?.itemId ? 'selected' : ''}>${esc(x.nome)}${x.custo != null ? ` · custo ${esc(brl(x.custo))}` : ''}</option>`).join(''));
      lucroVivo();
    }).catch(() => {});
    fv.elements.itemId.addEventListener('change', () => {
      const item = itens.find((x) => x.id === fv.elements.itemId.value);
      if (item) {
        if (!fv.elements.valor.value && (item.preco ?? item.precoAte) != null) fv.elements.valor.value = String(item.preco ?? item.precoAte).replace('.', ',');
        fv.elements.custo.value = item.custo != null ? String(item.custo).replace('.', ',') : '';
        if (!fv.elements.descricao.value) fv.elements.descricao.value = item.nome;
      }
      lucroVivo();
    });
    fv.elements.valor.addEventListener('input', lucroVivo);
    fv.elements.custo.addEventListener('input', lucroVivo);
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
  const nome = c.nome || 'o operador';
  const aprende = c.ativo === true;
  const atende = aprende && c.responder === true;
  const feito = Math.min(c.conversas, c.meta);
  const linha = (ligado, titulo, sim, nao) => `<div class="clone-situacao ${ligado ? 'sim' : 'nao'}"><b>${titulo}</b><span>${ligado ? sim : nao}</span></div>`;
  el.innerHTML = `
    <div class="card clone-card ${aprende ? 'ligado' : ''}">
      <h2 style="margin:0 0 10px">🧬 Clone${c.nome ? `: ${esc(c.nome)}` : ''}</h2>
      <div class="clone-situacoes">
        ${linha(aprende, '📚 Aprendendo', `SIM · ${c.conversas} venda(s) · ${c.total} resposta(s) guardadas`, 'NÃO · não guarda nada novo')}
        ${linha(atende, `🗣️ Atendendo igual ${c.nome ? `a ${esc(c.nome)}` : 'ao operador'}`, 'SIM · a IA responde no jeito das vendas', 'NÃO · a IA segue só o seu prompt')}
      </div>

      <div class="clone-chave">
        ${interruptor('clone-ativo', aprende, '<b>Aprender com as vendas</b>')}
        <p class="rotulo">Lê as conversas que <b>viraram venda</b> e guarda como foi respondido (texto, fotos e vídeos). Continua aprendendo a cada venda. <b>Não gasta IA</b> e não muda o atendimento.</p>
      </div>
      <div class="clone-chave">
        ${interruptor('clone-responder', atende, `<b>Atender igual ${c.nome ? `a ${esc(c.nome)}` : 'ao operador'}</b>`)}
        <p class="rotulo"><b>Ligado:</b> a IA usa os exemplos das vendas parecidas para responder no mesmo jeito (tom, preço, como fecha). <b>Desligado:</b> a IA segue só o seu prompt.${c.completo ? '' : ` Funciona melhor a partir de ${c.meta} vendas (agora: ${feito}).`}</p>
      </div>

      <details class="clone-ajustes"><summary>⚙️ Ajustes</summary>
        <form id="f-clone" class="linha-form" style="flex-wrap:wrap;margin:10px 0"><input name="nome" maxlength="40" value="${esc(c.nome)}" placeholder="Nome do operador (ex.: Teodósio)"><button type="submit">Salvar nome</button></form>
        ${interruptor('clone-da-ia', c.aprenderDaIa, 'Aprender também com as vendas que a IA fez (as suas respostas continuam valendo mais)')}
        <p class="rotulo" style="margin:8px 0 0">${c.manuais ?? c.total} resposta(s) suas · ${c.daIa || 0} da IA${c.midiasAprendidas ? ` · ${c.midiasAprendidas} mídia(s) guardadas na biblioteca` : ''}</p>
        <div class="acoes" style="margin-top:10px">
          <a class="botao" href="api/empresas/${esc(id)}/clone/arquivo">⬇️ Baixar o que aprendeu</a>
          ${c.total ? '<button type="button" id="ver-clone">Ver / tirar exemplos</button>' : ''}
        </div>
      </details>
    </div>`;
  const salvarClone = async (corpo, msg) => {
    try { await api(`empresas/${id}/clone`, { method: 'PUT', body: corpo }); aviso(msg); cartaoClone(id); } catch (err) { aviso(err.message, true); cartaoClone(id); }
  };
  $('#clone-ativo').onchange = (e) => salvarClone(e.target.checked ? { ativo: true } : { ativo: false, responder: false }, e.target.checked ? 'Aprendendo com as vendas (sem mudar o atendimento).' : 'Parou de aprender. O atendimento segue só o seu prompt.');
  $('#clone-responder').onchange = (e) => salvarClone(e.target.checked ? { responder: true, ativo: true } : { responder: false }, e.target.checked ? `A IA passa a atender igual ${c.nome ? `a ${c.nome}` : 'ao operador'}.` : 'A IA segue só o seu prompt (o clone continua aprendendo).');
  $('#clone-da-ia').onchange = (e) => salvarClone({ aprenderDaIa: e.target.checked }, e.target.checked ? 'Aprende também com as vendas que a IA fez.' : 'Aprende só com as suas respostas.');
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
    ${lista.some((u) => u.pendente) ? `<div class="card pendentes-aprovacao"><h2 style="margin:0 0 4px">🆕 Contas aguardando aprovação (${lista.filter((u) => u.pendente).length})</h2><p class="rotulo" style="margin:0 0 12px">Criadas pela página de cadastro, com o e-mail já confirmado. Ao aprovar, a pessoa recebe um e-mail e já pode entrar.</p>
      ${lista.filter((u) => u.pendente).map((u) => `<div class="linha-pendente"><div><b>${esc(u.nome)}</b> · ${esc(u.empresaNome || '—')}<br><span class="rotulo">${esc(u.email)} · ${esc(data(u.criadoEm))}</span></div><span class="acoes-pendente"><button class="primario pequeno" data-aprovar="${esc(u.id)}">Aprovar</button><button class="pequeno perigo" data-recusar="${esc(u.id)}">Recusar</button></span></div>`).join('')}</div>` : ''}
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
              <td>${u.pendente ? '<span class="etiqueta aviso">Aguardando</span>' : u.ativo ? '<span class="etiqueta ok">Ativo</span>' : '<span class="etiqueta off">Bloqueado</span>'}${u.cadastroProprio ? ' <span class="rotulo" title="Criou a conta pela página de cadastro">· cadastro</span>' : ''}</td>
              <td style="white-space:nowrap"><button class="pequeno" data-editar="${esc(u.id)}">Editar</button>${u.id !== sessao.usuario.id && !u.pendente ? ` <button class="pequeno ${u.ativo ? 'perigo' : 'primario'}" data-bloquear="${esc(u.id)}" data-ativar="${u.ativo ? '' : '1'}">${u.ativo ? 'Bloquear' : 'Desbloquear'}</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  $('#novo').onclick = () => modalUsuario(null, empresas);
  $$('[data-bloquear]').forEach((b) => {
    b.onclick = async () => {
      const u = lista.find((x) => x.id === b.dataset.bloquear);
      const ativar = b.dataset.ativar === '1';
      if (!ativar && !(await confirmar({ titulo: `Bloquear ${esc(u?.email || '')}?`, texto: 'A pessoa sai do painel na hora e não consegue mais entrar. Nada é apagado e dá para desbloquear quando quiser. (Para parar também a IA da empresa, use "Desativar" no cartão da empresa.)', botao: 'Bloquear', perigo: true }))) return;
      try {
        await comEspera(b, () => api(`usuarios/${b.dataset.bloquear}/ativo`, { method: 'POST', body: { ativo: ativar } }));
        aviso(ativar ? 'Acesso liberado.' : 'Acesso bloqueado.');
        paginaUsuarios();
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-aprovar]').forEach((b) => {
    b.onclick = async () => {
      try {
        await comEspera(b, () => api(`usuarios/${b.dataset.aprovar}/aprovar`, { method: 'POST', body: {} }));
        aviso('Conta aprovada. A pessoa recebeu um e-mail avisando.');
        paginaUsuarios();
      } catch (err) { aviso(err.message, true); }
    };
  });
  $$('[data-recusar]').forEach((b) => {
    b.onclick = async () => {
      const u = lista.find((x) => x.id === b.dataset.recusar);
      if (!(await confirmar({ titulo: `Recusar ${esc(u?.email || '')}?`, texto: 'A conta e a empresa criada junto com ela (ainda vazia) são apagadas. A pessoa não recebe aviso e pode se cadastrar de novo.', botao: 'Recusar', perigo: true }))) return;
      try {
        await api(`usuarios/${b.dataset.recusar}/recusar`, { method: 'POST', body: {} });
        aviso('Cadastro recusado.');
        paginaUsuarios();
      } catch (err) { aviso(err.message, true); }
    };
  });
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
        <div class="campo"><label>${c[id].configurada ? 'Trocar chave' : 'Chave de API'}</label><input name="${campo}" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${esc(dica)}"><small>Crie em <a href="${onde}" target="_blank" rel="noopener">${onde.replace('https://', '')}</a>.</small></div>
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
        <div class="campo largo"><label>Chave global (AUTHENTICATION_API_KEY) ${ajuda('É a chave do servidor da Evolution (a mesma EVOLUTION_API_KEY do .env do DingDong Tracking). Não é a API Key de uma instância.')}</label><input name="evolutionApiKey" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${c.evolutionChave.configurada ? `salva — termina em ${esc(c.evolutionChave.final)} (deixe vazio para manter)` : 'cole a chave global'}"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button>${c.evolutionChave.origem === 'painel' ? '<button type="button" class="perigo" id="remover-evo">Remover chave</button>' : ''}</div>
    </form>
    <h2 style="margin-top:24px">Chaves de IA</h2>
    ${balao('Cada empresa usa a própria chave', 'Não existe chave geral: cada empresa cadastra a sua em <b>IAs e chaves</b> e paga só o que ela gasta. Empresa sem chave fica sem IA até você cadastrar.')}`;

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
    barra.innerHTML = `<span class="cfg-ok ${estado === 'off' ? 'off' : ''}">${estado === 'off' ? '○' : '✓'}</span><span class="cfg-titulo">${esc(titulo)}</span><span class="cfg-resumo">${rec ? esc(resumo || (estado === 'off' ? 'Desligado' : 'Configurado')) : ''}</span><span class="cfg-abrir">${rec ? card.dataset.abrir || (estado === 'off' ? 'Configurar' : 'Editar') : 'Recolher'}</span>`;
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
        disparos: () => (partes[3] === 'novo' ? paginaNovoDisparo(id, params) : partes[3] === 'mensagens' ? paginaMensagensDisparo(id) : partes[3] === 'campanhas' ? (partes[4] ? paginaNovoDisparo(id, new URLSearchParams([...params, ['editarCampanha', partes[4]]])) : paginaCampanhas(id)) : partes[3] === 'listas' ? paginaListasContatos(id, params) : partes[3] === 'seguranca' ? paginaSegurancaDisparo(id) : partes[3] === 'cobranca' ? paginaCobranca(id) : partes[3] ? paginaDisparo(id, partes[3]) : paginaDisparos(id, params)),
        ia: () => paginaCerebro(id),
        catalogo: () => paginaCatalogo(id),
        site: () => paginaSite(id),
        whatsapp: () => paginaWhatsapp(id),
        midias: () => paginaMidias(id),
        audios: () => paginaAudios(id),
        organizar: () => paginaOrganizar(id),
        chave: () => paginaChave(id),
        'lead-externo': () => paginaLeadExterno(id),
        'meta-ads': () => paginaMetaAds(id)
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
  if (sessao.usuario.trocarSenha) {
    location.href = 'login#nova-senha';
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
