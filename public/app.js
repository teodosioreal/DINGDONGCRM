// Painel do CRM: páginas por hash, no mesmo estilo do painel DingDong
// (menu lateral; dentro de cada empresa: Painel, Leads, Assistente IA, WhatsApp,
// Mídias, Chave de IA e Instalar no site).
'use strict';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const conteudo = $('#conteudo');
let sessao = null; // { usuario, empresa, provedores, urlPublica }
let empresaAtual = null; // { id, nome } da empresa aberta no menu

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
  if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
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

const ehAdmin = () => sessao?.usuario.papel === 'admin';

function formParaObjeto(form) {
  const dados = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    dados[el.name] = el.type === 'checkbox' ? el.checked : el.value;
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
  fundo.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', fechar));
  aoMontar?.(fundo, fechar);
  fundo.querySelector('input, select, textarea')?.focus();
  return fechar;
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    aviso('Copiado!');
  } catch {
    aviso('Não consegui copiar. Selecione o texto e copie manualmente.', true);
  }
}

function codigoEmpresa(empresaId) {
  return `<script src="${sessao.urlPublica}/chat.js" data-empresa="${empresaId}" async></script>`;
}

function codigoIncorporacao(bot) {
  return `<script src="${sessao.urlPublica}/chat.js" data-bot="${bot.id}" async></script>`;
}

const NOME_PROVEDOR = { anthropic: 'Claude (Anthropic)', gemini: 'Gemini (Google)' };
const rotaEmpresa = (id, sub = '') => `#/empresas/${id}${sub ? `/${sub}` : ''}`;

// ---------------------------------------------------------------- tema e menu

const ICONE_SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.4-6.4-1.4 1.4M6.4 17.6 5 19m13.4 0-1.4-1.4M6.4 6.4 5 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z"/></svg>';
const ICONE_LUA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

function ajustarBotaoTema() {
  const escuro = document.documentElement.classList.contains('dark');
  const b = $('#tema');
  b.innerHTML = escuro ? ICONE_SOL : ICONE_LUA;
  b.title = escuro ? 'Mudar para o modo claro' : 'Mudar para o modo escuro';
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

// Monta o menu lateral. `ativo` é o href do item que deve ficar destacado.
function montarMenu(ativo) {
  const item = (href, rotulo) => `<a class="item-menu${href === ativo ? ' ativo' : ''}" href="${href}">${esc(rotulo)}</a>`;
  let html = '';
  if (ehAdmin()) {
    html += item('#/', 'Visão geral');
    html += item('#/empresas', 'Empresas');
  }
  if (empresaAtual) {
    const id = empresaAtual.id;
    html += `<p class="titulo-grupo">${esc(empresaAtual.nome)}</p>`;
    html += item(rotaEmpresa(id), 'Painel');
    html += item(rotaEmpresa(id, 'leads'), 'Leads');
    html += item(rotaEmpresa(id, 'assistentes'), 'Assistente IA');
    html += item(rotaEmpresa(id, 'whatsapp'), 'WhatsApp');
    html += item(rotaEmpresa(id, 'midias'), 'Mídias');
    html += item(rotaEmpresa(id, 'chave'), 'Chave de IA');
    html += item(rotaEmpresa(id, 'instalar'), 'Instalar no site');
  }
  if (ehAdmin()) {
    html += '<p class="titulo-grupo">Administração</p>';
    html += item('#/usuarios', 'Usuários');
    html += item('#/configuracoes', 'Chave padrão (opcional)');
  }
  $('#menu').innerHTML = html;
  document.querySelectorAll('.lateral a').forEach((a) => {
    a.classList.toggle('ativo', a.getAttribute('href') === ativo);
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

// ---------------------------------------------------------------- visão geral (admin)

async function paginaInicio() {
  const [r, empresas] = await Promise.all([api('resumo'), api('empresas')]);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Visão geral</h1></div>
    <div class="grade-resumo">
      <div class="card"><div class="rotulo">Empresas</div><div class="numero">${r.empresas}</div></div>
      <div class="card"><div class="rotulo">Leads novos (7 dias)</div><div class="numero">${r.leads7d}</div></div>
      <div class="card"><div class="rotulo">Chegaram no WhatsApp (7 dias)</div><div class="numero">${r.noWhatsapp7d}</div></div>
      <div class="card"><div class="rotulo">Esperando a equipe</div><div class="numero">${r.aguardandoEquipe}</div></div>
    </div>
    <h2>Empresas</h2>
    ${tabelaEmpresas(empresas)}
    ${empresas.length ? '' : '<p class="rotulo">Comece em <a href="#/empresas">Empresas → + Nova empresa</a>.</p>'}`;
  ligarTabelaEmpresas();
}

function statusIa(e) {
  const algum = Object.values(e.chaves || {}).some((c) => c.funciona);
  return algum ? '<span class="etiqueta ok">IA ok</span>' : '<span class="etiqueta off">Sem chave de IA</span>';
}

function tabelaEmpresas(lista) {
  return `
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Empresa</th><th class="esconde-mobile">Nicho</th><th>IA</th><th>Status</th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((e) => `
            <tr class="clicavel" data-empresa="${esc(e.id)}">
              <td><strong>${esc(e.nome)}</strong></td>
              <td class="esconde-mobile">${esc(e.nicho) || '—'}</td>
              <td>${statusIa(e)}</td>
              <td>${e.ativa ? '<span class="etiqueta ok">Ativa</span>' : '<span class="etiqueta off">Pausada</span>'}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="vazio">Nenhuma empresa ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function ligarTabelaEmpresas() {
  conteudo.querySelectorAll('tr[data-empresa]').forEach((tr) => {
    tr.onclick = () => { location.hash = rotaEmpresa(tr.dataset.empresa); };
  });
}

// ---------------------------------------------------------------- empresas (admin)

async function paginaEmpresas() {
  const lista = await api('empresas');
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Empresas</h1><button class="primario" id="nova">+ Nova empresa</button></div>
    <p class="descricao">Cada empresa tem as próprias IAs (site e WhatsApp), a própria chave de IA, o funil de leads e um código para o site.</p>
    ${tabelaEmpresas(lista)}`;
  $('#nova').onclick = () => modalEmpresa();
  ligarTabelaEmpresas();
}

function modalEmpresa(emp) {
  abrirModal(`
    <h2>${emp ? 'Editar empresa' : 'Nova empresa'}</h2>
    <form id="f-emp">
      <div class="campos">
        <div class="campo largo"><label>Nome *</label><input name="nome" required value="${esc(emp?.nome)}"></div>
        <div class="campo"><label>Nicho / ramo</label><input name="nicho" placeholder="Ex.: estética automotiva" value="${esc(emp?.nicho)}"></div>
        <div class="campo"><label>WhatsApp da empresa</label><input name="whatsapp" placeholder="(21) 99999-9999" value="${esc(emp?.whatsapp)}"><small>Para onde o chat manda o cliente.</small></div>
        <div class="campo"><label>Responsável</label><input name="responsavel" value="${esc(emp?.responsavel)}"></div>
        ${emp ? '' : '<div class="campo largo"><label>Site(s) da empresa</label><input name="sites" placeholder="madarashops.com.br, meusite.lovable.app"><small>Só nesses sites o chat vai aparecer. Pode preencher depois no assistente.</small></div>'}
        <div class="campo largo"><label>Observações internas</label><textarea name="observacoes">${esc(emp?.observacoes)}</textarea></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativa" ${emp?.ativa === false ? '' : 'checked'}> Empresa ativa (desmarque para pausar o chat dela)</label></div>
      </div>
      <div class="acoes">
        <button class="primario" type="submit">Salvar</button>
        <button type="button" data-fechar>Cancelar</button>
        ${emp ? '<button type="button" class="perigo" id="excluir" style="margin-left:auto">Excluir</button>' : ''}
      </div>
    </form>`, (m, fechar) => {
    $('#f-emp', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const salva = await api(emp ? `empresas/${emp.id}` : 'empresas', { method: emp ? 'PUT' : 'POST', body: formParaObjeto(e.target) });
        fechar();
        aviso(emp ? 'Empresa salva.' : 'Empresa criada. Agora siga o passo a passo.');
        empresaAtual = null;
        location.hash = rotaEmpresa(salva.id);
        if (emp) rotear();
      } catch (err) { aviso(err.message, true); }
    };
    const excluir = $('#excluir', m);
    if (excluir) excluir.onclick = async () => {
      if (!confirm(`Excluir "${emp.nome}"? Isso apaga também os assistentes, as conversas e os usuários dessa empresa.`)) return;
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

// ---------------------------------------------------------------- empresa: painel

async function paginaEmpresa(id) {
  const [emp, r, bots] = await Promise.all([definirEmpresaAtual(id), api(`resumo?empresaId=${encodeURIComponent(id)}`), api(`bots?empresaId=${encodeURIComponent(id)}`)]);
  const principal = bots.find((b) => b.principal) || bots[0];
  const provedor = principal?.provedor || 'anthropic';
  const passos = [
    {
      feito: Boolean(emp.chaves?.[provedor]?.funciona),
      texto: `Cadastrar a chave de IA (${NOME_PROVEDOR[provedor]})`,
      href: rotaEmpresa(id, 'chave')
    },
    {
      feito: Boolean(principal && (principal.conhecimento || '').trim().length > 80),
      texto: 'Ensinar a IA: conhecimento da empresa e instruções do site e do WhatsApp',
      href: principal ? `#/assistentes/${principal.id}` : rotaEmpresa(id, 'assistentes')
    },
    {
      feito: Boolean(emp.whatsapp?.configurado),
      texto: 'Conectar o WhatsApp (a IA do WhatsApp continua o atendimento do site)',
      href: rotaEmpresa(id, 'whatsapp')
    },
    {
      feito: emp.totalMidias > 0,
      texto: 'Cadastrar mídias que a IA pode enviar (fotos, vídeos, PDFs, áudios) — opcional',
      href: rotaEmpresa(id, 'midias')
    },
    {
      feito: Object.keys(r.porEtapa).length > 0,
      texto: 'Colar o código no site (aparece como feito quando chegar o primeiro lead)',
      href: rotaEmpresa(id, 'instalar')
    }
  ];
  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>${esc(emp.nome)}</h1>
      ${ehAdmin() ? '<button type="button" id="editar-emp">Editar empresa</button>' : ''}
    </div>
    <div class="grade-resumo">
      <div class="card"><div class="rotulo">Leads novos (7 dias)</div><div class="numero">${r.leads7d}</div></div>
      <div class="card"><div class="rotulo">Chegaram no WhatsApp (7 dias)</div><div class="numero">${r.noWhatsapp7d}</div></div>
      <div class="card"><div class="rotulo">Esperando a equipe</div><div class="numero">${r.aguardandoEquipe}</div></div>
    </div>
    <div class="card">
      <div class="cabecalho" style="margin-bottom:12px"><h2 style="margin:0">Funil</h2><a class="botao pequeno" href="${rotaEmpresa(id, 'leads')}">Ver leads</a></div>
      <div class="funil">
        ${emp.etapas.map((e) => `<a class="funil-etapa" href="${rotaEmpresa(id, 'leads')}"><span class="rotulo">${esc(e)}</span><strong>${r.porEtapa[e] || 0}</strong></a>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2>Passo a passo</h2>
      <ul class="checklist">
        ${passos.map((p, i) => `<li class="${p.feito ? 'feito' : ''}"><span class="bola">${p.feito ? '✓' : i + 1}</span><a href="${p.href}">${esc(p.texto)}</a></li>`).join('')}
      </ul>
    </div>`;
  $('#editar-emp')?.addEventListener('click', () => modalEmpresa(emp));
}

// ---------------------------------------------------------------- empresa: chave de IA

async function paginaChave(id) {
  const emp = await definirEmpresaAtual(id);
  const bloco = (provedor, campo, onde, dica) => {
    const c = emp.chaves[provedor];
    const situacao = c.propria
      ? `<span class="etiqueta ok">Chave da empresa</span> <span class="rotulo">termina em ${esc(c.final)}</span>`
      : c.usaPadrao
        ? '<span class="etiqueta">Usando a chave padrão</span> <span class="rotulo">cadastre a da empresa para ela pagar a própria IA</span>'
        : '<span class="etiqueta off">Sem chave</span>';
    return `
      <div class="card">
        <h2>${NOME_PROVEDOR[provedor]}</h2>
        <p style="margin-top:-4px">${situacao}</p>
        <form data-provedor="${provedor}">
          <div class="campo"><label>${c.propria ? 'Trocar chave' : 'Chave de API'}</label><input name="${campo}" type="password" autocomplete="off" placeholder="${esc(dica)}"><small>Crie em <a href="${onde}" target="_blank" rel="noopener">${onde.replace('https://', '')}</a>.</small></div>
          <div class="acoes">
            <button class="primario" type="submit">Salvar</button>
            ${c.funciona ? '<button type="button" data-testar>Testar</button>' : ''}
            ${c.propria ? '<button type="button" class="perigo" data-remover>Remover</button>' : ''}
          </div>
        </form>
      </div>`;
  };
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Chave de IA</h1></div>
    <p class="descricao">Cada empresa usa a própria chave: o custo das conversas cai na conta dela. Basta uma das duas — no assistente você escolhe qual IA responde. A chave fica só no servidor e nunca aparece no site.</p>
    ${bloco('gemini', 'geminiApiKey', 'https://aistudio.google.com/apikey', 'AIza…')}
    ${bloco('anthropic', 'anthropicApiKey', 'https://console.anthropic.com', 'sk-ant-…')}`;

  conteudo.querySelectorAll('form[data-provedor]').forEach((f) => {
    const provedor = f.dataset.provedor;
    const recarregar = () => { empresaAtual = null; paginaChave(id); };
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
        await api(`empresas/${id}/chaves`, { method: 'PUT', body: dados });
        aviso('Chave salva. Testando…');
        await testar();
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
    $('[data-testar]', f)?.addEventListener('click', testar);
    $('[data-remover]', f)?.addEventListener('click', async () => {
      if (!confirm('Remover a chave desta empresa? Se o assistente usar essa IA, ele para de responder (a menos que exista uma chave padrão).')) return;
      try {
        await api(`empresas/${id}/chaves`, { method: 'PUT', body: { remover: [provedor] } });
        recarregar();
      } catch (err) { aviso(err.message, true); }
    });
  });
}

// ---------------------------------------------------------------- empresa: WhatsApp

async function paginaWhatsapp(id) {
  await definirEmpresaAtual(id);
  const w = await api(`empresas/${id}/whatsapp`);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>WhatsApp</h1></div>
    <p class="descricao">A IA do WhatsApp responde os clientes no número da empresa. Quem veio do chat do site chega com o código do atendimento, e a IA continua de onde a IA do site parou, com todo o histórico. Se alguém da equipe responder pelo celular ou pelo painel, a IA para naquele lead.</p>
    <form class="card" id="f-zap">
      <h2>Conexão (Evolution API)</h2>
      <div class="campos">
        <div class="campo largo"><label>Endereço da Evolution API</label><input name="evolutionUrl" value="${esc(w.evolutionUrl)}" placeholder="https://api.seudominio.com"></div>
        <div class="campo"><label>Nome da instância</label><input name="instancia" value="${esc(w.instancia)}" placeholder="madara-volantes"></div>
        <div class="campo"><label>API key da instância</label><input name="apiKey" type="password" autocomplete="off" placeholder="${w.apiKeyFinal ? `salva (termina em ${esc(w.apiKeyFinal)}) — deixe vazio para manter` : 'cole a API key'}"></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="iaAtiva" ${w.iaAtiva ? 'checked' : ''}> IA responde no WhatsApp</label><small>Desmarque para só registrar as conversas no CRM, sem a IA responder.</small></div>
      </div>
      <div class="acoes">
        <button class="primario" type="submit">Salvar</button>
        ${w.configurado ? '<button type="button" id="zap-status">Ver conexão</button><button type="button" id="zap-qr">Conectar (QR code)</button><button type="button" id="zap-webhook">Ligar o webhook automaticamente</button>' : ''}
      </div>
      <div id="zap-resultado" style="margin-top:14px"></div>
    </form>
    <div class="card">
      <h2>Webhook</h2>
      <p class="rotulo" style="margin-top:-6px">O botão "Ligar o webhook automaticamente" configura isto na Evolution. Se preferir fazer à mão, use esta URL com o evento <code>MESSAGES_UPSERT</code>:</p>
      <div class="codigo">${esc(w.webhook)}</div>
      <p class="rotulo" style="margin:10px 0 0">Não compartilhe esta URL: ela tem um código secreto da empresa.</p>
    </div>`;
  const resultado = $('#zap-resultado');
  $('#f-zap').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`empresas/${id}/whatsapp`, { method: 'PUT', body: formParaObjeto(e.target) });
      aviso('WhatsApp salvo.');
      paginaWhatsapp(id);
    } catch (err) { aviso(err.message, true); }
  };
  const acao = async (nome, desenhar) => {
    resultado.innerHTML = '<p class="rotulo">Aguarde…</p>';
    try {
      desenhar(await api(`empresas/${id}/whatsapp/${nome}`, { method: 'POST' }));
    } catch (err) {
      resultado.innerHTML = `<p class="erro-caixa">${esc(err.message)}</p>`;
    }
  };
  $('#zap-status')?.addEventListener('click', () => acao('status', (r) => {
    const ok = r.estado === 'open';
    resultado.innerHTML = `<p>${ok ? '<span class="etiqueta ok">Conectado</span>' : `<span class="etiqueta off">${esc(r.estado)}</span> — use "Conectar (QR code)"`}</p>`;
  }));
  $('#zap-qr')?.addEventListener('click', () => acao('qrcode', (r) => {
    resultado.innerHTML = r.base64
      ? `<p class="rotulo">No celular da empresa: WhatsApp → Aparelhos conectados → Conectar aparelho → escaneie:</p><img alt="QR code do WhatsApp" src="${esc(r.base64.startsWith('data:') ? r.base64 : `data:image/png;base64,${r.base64}`)}" style="width:260px;max-width:100%;background:#fff;padding:8px;border-radius:8px">`
      : '<p>Nenhum QR code: a instância provavelmente já está conectada. Clique em "Ver conexão".</p>';
  }));
  $('#zap-webhook')?.addEventListener('click', () => acao('webhook', () => {
    resultado.innerHTML = '<p><span class="etiqueta ok">Webhook ligado</span> As mensagens do WhatsApp já chegam no CRM.</p>';
  }));
}

// ---------------------------------------------------------------- empresa: mídias

const ICONE_TIPO = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄' };

async function paginaMidias(id) {
  await definirEmpresaAtual(id);
  const lista = await api(`empresas/${id}/midias`);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Mídias</h1></div>
    <p class="descricao">Fotos, vídeos, PDFs e áudios que a IA do WhatsApp pode enviar. O <strong>nome</strong> e a <strong>descrição</strong> dizem para a IA quando usar cada um — ex.: "Fotos volantes couro" / "quando o cliente pedir fotos do revestimento em couro". Até 16 MB por arquivo.</p>
    <form class="card" id="f-midia">
      <h2>Adicionar mídia</h2>
      <div class="campos">
        <div class="campo largo"><label>Arquivo *</label><input type="file" name="arquivo" required accept="image/*,video/mp4,audio/*,.pdf,.doc,.docx,.xls,.xlsx"></div>
        <div class="campo"><label>Nome *</label><input name="nome" required placeholder="Ex.: Tabela de preços"></div>
        <div class="campo"><label>Quando a IA deve enviar</label><input name="descricao" placeholder="Ex.: quando o cliente pedir os preços"></div>
      </div>
      <div class="acoes"><button class="primario" type="submit">Enviar arquivo</button></div>
    </form>
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Mídia</th><th class="esconde-mobile">Quando enviar</th><th>Tamanho</th><th></th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((m) => `
            <tr>
              <td>${ICONE_TIPO[m.tipo] || '📎'} <a href="${esc(m.url)}" target="_blank" rel="noopener"><strong>${esc(m.nome)}</strong></a><br><span class="rotulo">${esc(m.arquivo)}</span></td>
              <td class="esconde-mobile">${esc(m.descricao) || '—'}</td>
              <td style="white-space:nowrap">${(m.tamanho / 1024 / 1024).toFixed(1)} MB</td>
              <td style="white-space:nowrap"><button class="pequeno" data-editar="${esc(m.id)}">Editar</button> <button class="pequeno perigo" data-apagar="${esc(m.id)}">Apagar</button></td>
            </tr>`).join('') : '<tr><td colspan="4" class="vazio">Nenhuma mídia ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  $('#f-midia').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const arquivo = f.elements.arquivo.files[0];
    if (!arquivo) return;
    if (arquivo.size > 16 * 1024 * 1024) return aviso('Arquivo maior que 16 MB (limite do WhatsApp).', true);
    const botao = f.querySelector('button[type=submit]');
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      const qs = new URLSearchParams({ arquivo: arquivo.name, nome: f.elements.nome.value, descricao: f.elements.descricao.value, tipo: arquivo.type || '' });
      const r = await fetch(`api/empresas/${id}/midias?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arquivo });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
      aviso('Mídia adicionada.');
      paginaMidias(id);
    } catch (err) {
      aviso(err.message, true);
      botao.disabled = false;
      botao.textContent = 'Enviar arquivo';
    }
  };
  conteudo.querySelectorAll('[data-apagar]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Apagar esta mídia? A IA não vai mais conseguir enviá-la.')) return;
      try {
        await api(`empresas/${id}/midias/${b.dataset.apagar}`, { method: 'DELETE' });
        paginaMidias(id);
      } catch (err) { aviso(err.message, true); }
    };
  });
  conteudo.querySelectorAll('[data-editar]').forEach((b) => {
    b.onclick = () => {
      const m = lista.find((x) => x.id === b.dataset.editar);
      abrirModal(`
        <h2>Editar mídia</h2>
        <form id="f-ed-midia">
          <div class="campo"><label>Nome</label><input name="nome" required value="${esc(m.nome)}"></div>
          <div class="campo" style="margin-top:12px"><label>Quando a IA deve enviar</label><input name="descricao" value="${esc(m.descricao)}"></div>
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

// ---------------------------------------------------------------- empresa: instalar no site

async function paginaInstalar(id) {
  const emp = await definirEmpresaAtual(id);
  const codigo = codigoEmpresa(emp.id);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Instalar no site</h1></div>
    <p class="descricao">Cole <strong>uma vez</strong> no cabeçalho (<code>&lt;head&gt;</code>) ou no rodapé (antes de <code>&lt;/body&gt;</code>). O botão do chat aparece sozinho em todas as páginas. Depois, qualquer mudança na IA é feita aqui no painel — o código continua o mesmo.</p>
    <div class="card">
      <div class="codigo" id="codigo">${esc(codigo)}</div>
      <div class="acoes"><button type="button" class="primario" id="copiar">Copiar código</button></div>
    </div>
    <div class="card">
      <h2>Onde colar em cada plataforma</h2>
      <ul style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:6px">
        <li><strong>WordPress:</strong> plugin <em>WPCode</em> → Code Snippets → Header &amp; Footer → cole em <em>Header</em> ou <em>Footer</em> → Salvar.</li>
        <li><strong>Lovable:</strong> no chat do projeto, peça <em>"adicione este script em todas as páginas do site"</em> e cole o código.</li>
        <li><strong>Wix:</strong> Configurações → Código personalizado → + Adicionar código → "Todas as páginas", em "Head" ou "Body – fim".</li>
        <li><strong>Shopify / Nuvemshop / outros:</strong> "código personalizado" / "scripts", ou no tema, antes de <code>&lt;/body&gt;</code>.</li>
        <li><strong>HTML:</strong> no <code>&lt;head&gt;</code> ou antes de <code>&lt;/body&gt;</code>.</li>
      </ul>
      <p class="rotulo" style="margin:12px 0 0">O chat só aparece nos sites autorizados no assistente (Assistente IA → Sites autorizados).</p>
    </div>`;
  $('#copiar').onclick = () => copiar(codigo);
}

// ---------------------------------------------------------------- empresa: assistentes

async function paginaAssistentes(id) {
  await definirEmpresaAtual(id);
  const bots = await api(`bots?empresaId=${encodeURIComponent(id)}`);
  if (bots.length === 1) {
    // o caso comum: um assistente só — abre direto nele
    location.replace(`#/assistentes/${bots[0].id}`);
    return;
  }
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Assistente IA</h1><a class="botao primario" href="#/assistentes/novo?empresa=${esc(id)}">+ Novo assistente</a></div>
    <p class="descricao">O principal é o que aparece no site. Crie outros só se a empresa tiver mais de um site com atendimento diferente.</p>
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Assistente</th><th class="esconde-mobile">IA</th><th class="esconde-mobile">Sites</th><th>Hoje</th><th>Status</th></tr></thead>
        <tbody>
          ${bots.length ? bots.map((b) => `
            <tr class="clicavel" data-id="${esc(b.id)}">
              <td><strong>${esc(b.nome)}</strong>${b.principal ? ' <span class="etiqueta">principal</span>' : ''}</td>
              <td class="esconde-mobile">${esc(NOME_PROVEDOR[b.provedor] || '')}</td>
              <td class="esconde-mobile">${b.dominios?.length ? esc(b.dominios.join(', ')) : '<span class="rotulo">qualquer site</span>'}</td>
              <td>${b.mensagensHoje} / ${b.limiteDiario}</td>
              <td>${b.ativo ? '<span class="etiqueta ok">Ativo</span>' : '<span class="etiqueta off">Pausado</span>'}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="vazio">Nenhum assistente ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  conteudo.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => { location.hash = `#/assistentes/${tr.dataset.id}`; }; });
}

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

async function paginaAssistente(id, params) {
  const novo = id === 'novo';
  const bot = novo ? null : await api(`bots/${id}`);
  const empresaId = bot?.empresaId || params.get('empresa') || sessao.usuario.empresaId;
  const emp = await definirEmpresaAtual(empresaId);
  const provedorComChave = ['gemini', 'anthropic'].find((p) => emp?.chaves?.[p]?.funciona) || 'anthropic';
  const b = bot || {
    empresaId,
    cor: '#008069',
    posicao: 'direita',
    provedor: provedorComChave,
    modelo: '',
    limiteDiario: 500,
    limiteConversa: 40,
    ativo: true,
    conhecimento: MODELO_CONHECIMENTO
  };
  const statusChave = (p) => (emp?.chaves?.[p]?.funciona ? '' : ' — sem chave');

  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>${novo ? 'Novo assistente' : esc(b.nome)}</h1>
      <a href="${rotaEmpresa(empresaId, 'instalar')}" class="botao">Código para o site</a>
    </div>
    ${emp && !emp.chaves?.[b.provedor || 'anthropic']?.funciona ? `<p class="alerta">A empresa ainda não tem chave do ${NOME_PROVEDOR[b.provedor || 'anthropic']}. <a href="${rotaEmpresa(empresaId, 'chave')}">Cadastrar chave de IA</a> — sem ela o chat não responde.</p>` : ''}
    <div class="editor">
      <form id="f-bot" class="card">
        <h2>Qual IA responde</h2>
        <div class="campos">
          <div class="campo"><label>IA</label><select name="provedor">${['gemini', 'anthropic'].map((p) => `<option value="${p}" ${p === (b.provedor || 'anthropic') ? 'selected' : ''}>${NOME_PROVEDOR[p]}${statusChave(p)}</option>`).join('')}</select></div>
          <div class="campo"><label>Modelo</label><select name="modelo"><option value="${esc(b.modelo)}">${esc(b.modelo)}</option></select><small id="aviso-modelo"></small></div>
        </div>

        <div class="secao">
          <h2>Identificação</h2>
          <div class="campos">
            <div class="campo"><label>Nome interno *</label><input name="nome" required value="${esc(b.nome)}" placeholder="Ex.: Assistente principal"></div>
            <div class="campo"><label>Nome que aparece no chat</label><input name="nomeAssistente" value="${esc(b.nomeAssistente)}" placeholder="Ex.: Madara Volantes"></div>
            <div class="campo"><label>Foto (URL da imagem)</label><input name="avatarUrl" value="${esc(b.avatarUrl)}" placeholder="https://…/logo.png"></div>
            <div class="campo"><label>Cor do topo do chat</label><input type="color" name="cor" value="${esc(b.cor || '#008069')}"></div>
            <div class="campo"><label>Posição do botão</label><select name="posicao"><option value="direita" ${b.posicao !== 'esquerda' ? 'selected' : ''}>Canto direito</option><option value="esquerda" ${b.posicao === 'esquerda' ? 'selected' : ''}>Canto esquerdo</option></select></div>
            ${ehAdmin() ? `<input type="hidden" name="empresaId" value="${esc(empresaId)}">` : ''}
          </div>
        </div>

        <div class="secao">
          <h2>Conversa</h2>
          <div class="campos">
            <div class="campo largo"><label>Mensagem de boas-vindas</label><input name="boasVindas" value="${esc(b.boasVindas)}" placeholder="Olá! 👋 Como posso te ajudar?"></div>
            <div class="campo largo"><label>Balão de chamada (opcional)</label><input name="chamada" value="${esc(b.chamada)}" placeholder="Tire suas dúvidas por aqui! 💬"><small>Aparece ao lado do botão alguns segundos depois de abrir o site.</small></div>
            <div class="campo largo"><label>Tom de voz</label><input name="tom" value="${esc(b.tom)}" placeholder="simpático, próximo e profissional"></div>
            <div class="campo largo">
              <label>Tudo o que a IA precisa saber *</label>
              <textarea class="grande" name="conhecimento">${esc(b.conhecimento)}</textarea>
              <small>Serviços, preços, região atendida, horários, prazos, garantia, formas de pagamento, dúvidas comuns. A IA não inventa nada fora disso.</small>
            </div>
            <div class="campo largo"><label>Instruções da IA do site</label><textarea name="regras" placeholder="Ex.: Descubra o modelo do carro e o serviço que o cliente quer. Quando ele quiser agendar, mande para o WhatsApp.">${esc(b.regras)}</textarea><small>Como a IA do chat do site deve conduzir a conversa e quando passar para o WhatsApp.</small></div>
            <div class="campo largo"><label>Instruções da IA do WhatsApp</label><textarea name="promptWhatsapp" placeholder="Ex.: Continue o atendimento do site. Envie as fotos do serviço escolhido, combine dia e bairro e, quando o cliente confirmar, chame a equipe.">${esc(b.promptWhatsapp)}</textarea><small>A IA do WhatsApp continua o que a IA do site começou. Aqui você diz como ela segue: que mídias mandar, quando mudar a etapa, quando chamar alguém da equipe.</small></div>
          </div>
        </div>

        <div class="secao">
          <h2>WhatsApp</h2>
          <div class="campos">
            <div class="campo"><label>Número que recebe os clientes</label><input name="whatsapp" value="${esc(b.whatsapp)}" placeholder="Vazio = usa o da empresa"></div>
            <div class="campo"><label>Mensagem do botão do topo do chat</label><input name="mensagemWhatsappPadrao" value="${esc(b.mensagemWhatsappPadrao)}" placeholder="Olá! Vim pelo site."></div>
          </div>
        </div>

        <div class="secao">
          <h2>Sites e limites</h2>
          <div class="campos">
            <div class="campo largo"><label>Sites autorizados</label><input name="dominios" value="${esc((b.dominios || []).join(', '))}" placeholder="madarashops.com.br, madara-volantes-landing.lovable.app"><small>Separe por vírgula. Subdomínios entram automaticamente. Vazio = qualquer site (não recomendado).</small></div>
            ${ehAdmin() ? `
            <div class="campo"><label>Limite de mensagens por dia</label><input type="number" min="1" name="limiteDiario" value="${esc(b.limiteDiario)}"></div>
            <div class="campo"><label>Limite de mensagens por conversa</label><input type="number" min="1" name="limiteConversa" value="${esc(b.limiteConversa)}"></div>` : ''}
            <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativo" ${b.ativo === false ? '' : 'checked'}> Assistente ativo</label></div>
            <div class="campo largo"><label class="linha-check"><input type="checkbox" name="principal" ${b.principal || novo ? 'checked' : ''}> Assistente principal da empresa (o que aparece no site)</label></div>
          </div>
        </div>

        <div class="acoes">
          <button class="primario" type="submit">${novo ? 'Criar assistente' : 'Salvar alterações'}</button>
          ${novo ? '' : `<a class="botao" href="${rotaEmpresa(empresaId, 'leads')}">Ver leads</a>`}
          ${novo ? '' : '<button type="button" class="perigo" id="excluir" style="margin-left:auto">Excluir</button>'}
        </div>
        ${novo ? '' : `<details style="margin-top:16px"><summary class="rotulo">Código só deste assistente (avançado)</summary><div class="codigo" style="margin-top:8px">${esc(codigoIncorporacao(b))}</div></details>`}
      </form>

      <div class="card teste">
        <div class="cab"><span>Testar como <select id="canal-teste" style="width:auto;padding:2px 6px;margin-left:4px"><option value="site">IA do site</option><option value="whatsapp">IA do WhatsApp</option></select></span><button type="button" class="pequeno" id="limpar">Limpar</button></div>
        <div class="chat" id="chat"></div>
        <form id="f-teste"><input id="msg-teste" placeholder="${novo ? 'Crie o assistente para testar' : 'Pergunte algo como um cliente…'}" ${novo ? 'disabled' : ''} autocomplete="off"><button class="primario" ${novo ? 'disabled' : ''}>Enviar</button></form>
      </div>
    </div>`;

  const form = $('#f-bot');
  const selProvedor = form.elements.provedor;
  const selModelo = form.elements.modelo;
  async function carregarModelos(manterAtual) {
    const atual = manterAtual ? selModelo.value : '';
    selModelo.innerHTML = '<option>carregando…</option>';
    try {
      const r = await api(`ia/modelos?provedor=${encodeURIComponent(selProvedor.value)}&empresaId=${encodeURIComponent(empresaId)}`);
      const lista = r.modelos.slice();
      if (atual && !lista.some((m) => m.id === atual)) lista.unshift({ id: atual, nome: `${atual} (atual)` });
      selModelo.innerHTML = lista.map((m) => `<option value="${esc(m.id)}">${esc(m.id === m.nome ? m.id : `${m.nome} — ${m.id}`)}</option>`).join('');
      const preferido = atual || (selProvedor.value === 'gemini' ? lista.find((m) => /flash/.test(m.id) && !/lite|preview|exp/.test(m.id))?.id : lista[0]?.id);
      if (preferido) selModelo.value = preferido;
      $('#aviso-modelo').textContent = r.aviso ? `Não consegui listar os modelos da chave (${r.aviso}). Mostrando sugestões.` : r.daChave ? 'Modelos disponíveis na chave do Google da empresa.' : '';
    } catch (err) {
      aviso(err.message, true);
    }
  }
  carregarModelos(true);
  selProvedor.onchange = () => carregarModelos(false);

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const salvo = await api(novo ? 'bots' : `bots/${b.id}`, { method: novo ? 'POST' : 'PUT', body: formParaObjeto(form) });
      aviso(novo ? 'Assistente criado!' : 'Alterações salvas.');
      if (novo) location.hash = `#/assistentes/${salvo.id}`;
      else paginaAssistente(salvo.id, params);
    } catch (err) { aviso(err.message, true); }
  };

  $('#excluir')?.addEventListener('click', async () => {
    if (!confirm(`Excluir o assistente "${b.nome}" e todas as conversas dele?`)) return;
    try {
      await api(`bots/${b.id}`, { method: 'DELETE' });
      aviso('Assistente excluído.');
      location.hash = rotaEmpresa(empresaId);
    } catch (err) { aviso(err.message, true); }
  });

  // Chat de teste (usa o que está no formulário, mesmo sem salvar)
  const chat = $('#chat');
  let historico = [];
  const saudacao = () => form.elements.boasVindas.value || 'Olá! Como posso ajudar?';
  function bolha(classe, texto) {
    const d = document.createElement('div');
    d.className = `msg ${classe}`;
    d.textContent = texto;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }
  function reiniciar() {
    historico = [];
    chat.innerHTML = '';
    bolha('bot', saudacao());
  }
  reiniciar();
  $('#limpar').onclick = reiniciar;

  $('#f-teste').onsubmit = async (e) => {
    e.preventDefault();
    const campo = $('#msg-teste');
    const texto = campo.value.trim();
    if (!texto || novo) return;
    campo.value = '';
    bolha('eu', texto);
    historico.push({ papel: 'visitante', texto });
    const esperando = bolha('bot', 'digitando…');
    const botao = e.target.querySelector('button');
    botao.disabled = true;
    try {
      const r = await api(`bots/${b.id}/testar`, { method: 'POST', body: { bot: formParaObjeto(form), mensagens: historico, canal: $('#canal-teste').value } });
      // mesmo *negrito* que o widget mostra no site
      esperando.innerHTML = esc(r.resposta).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
      historico.push({ papel: 'assistente', texto: r.resposta });
      // ações que a IA pediu (no WhatsApp de verdade elas acontecem sozinhas)
      const acoes = [
        ...(r.midias || []).map((m) => `📎 enviaria a mídia "${m}"`),
        r.etapa ? `➜ moveria o lead para "${r.etapa}"` : '',
        r.humano ? '👤 chamaria uma pessoa da equipe (e pararia de responder)' : ''
      ].filter(Boolean);
      if (acoes.length) {
        const n = document.createElement('div');
        n.className = 'msg acao-ia';
        n.textContent = acoes.join('\n');
        chat.appendChild(n);
        chat.scrollTop = chat.scrollHeight;
      }
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

// ---------------------------------------------------------------- empresa: leads (funil)

const ROTULO_CANAL = { site: '🌐 Site', whatsapp: '🟢 WhatsApp' };

function cartaoLead(l) {
  const quem = l.nome || (l.telefone ? `+${l.telefone}` : 'Visitante do site');
  const ultima = l.ultimaMensagem ? `${l.ultimaMensagem.papel === 'visitante' ? '' : l.ultimaMensagem.papel === 'equipe' ? 'Equipe: ' : 'IA: '}${l.ultimaMensagem.texto}` : '';
  return `
    <a class="cartao-lead" href="#/leads/${esc(l.id)}">
      <strong>${esc(quem)}</strong>
      <span class="rotulo cartao-texto">${esc(ultima)}</span>
      <span class="cartao-rodape">
        ${l.canais.map((c) => `<span class="etiqueta">${ROTULO_CANAL[c] || c}</span>`).join(' ')}
        ${l.precisaHumano ? '<span class="etiqueta off">chamou a equipe</span>' : l.iaPausada ? '<span class="etiqueta">IA pausada</span>' : ''}
        <span class="rotulo" style="margin-left:auto">${data(l.atualizadoEm)}</span>
      </span>
    </a>`;
}

async function paginaLeads(id, params) {
  const emp = await definirEmpresaAtual(id);
  const busca = params.get('busca') || '';
  const lista = await api(`leads?${new URLSearchParams({ empresaId: id, busca })}`);
  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>Leads</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <form id="f-busca" style="display:flex;gap:6px"><input name="busca" value="${esc(busca)}" placeholder="Buscar nome, telefone, mensagem…" style="width:240px"><button type="submit">Buscar</button></form>
        <button type="button" id="editar-etapas">Editar etapas</button>
      </div>
    </div>
    <p class="descricao">Cada atendimento é um lead. A IA do site e a do WhatsApp movem o lead de etapa conforme as instruções; você também pode mover abrindo o lead.</p>
    <div class="quadro">
      ${emp.etapas.map((etapa) => {
        const daEtapa = lista.filter((l) => l.etapa === etapa);
        return `<section class="coluna"><header><span>${esc(etapa)}</span><span class="etiqueta">${daEtapa.length}</span></header>${daEtapa.map(cartaoLead).join('') || '<p class="rotulo vazio-coluna">—</p>'}</section>`;
      }).join('')}
    </div>`;
  $('#f-busca').onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.elements.busca.value.trim();
    location.hash = rotaEmpresa(id, 'leads') + (v ? `?busca=${encodeURIComponent(v)}` : '');
  };
  $('#editar-etapas').onclick = () => abrirModal(`
    <h2>Etapas do funil</h2>
    <p class="rotulo">Uma por linha, na ordem do atendimento. As IAs só usam estas etapas. Leads em etapas apagadas vão para a primeira.</p>
    <form id="f-etapas">
      <textarea name="etapas" style="min-height:200px">${esc(emp.etapas.join('\n'))}</textarea>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Cancelar</button></div>
    </form>`, (m, fechar) => {
    $('#f-etapas', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`empresas/${id}/etapas`, { method: 'PUT', body: { etapas: e.target.elements.etapas.value } });
        fechar();
        paginaLeads(id, params);
      } catch (err) { aviso(err.message, true); }
    };
  });
}

async function paginaLead(leadId) {
  const l = await api(`leads/${leadId}`);
  await definirEmpresaAtual(l.empresaId);
  const quem = l.nome || (l.telefone ? `+${l.telefone}` : 'Visitante do site');
  const papelRotulo = { visitante: 'Cliente', assistente: 'IA', equipe: 'Equipe' };
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>${esc(quem)}</h1><a class="botao" href="${rotaEmpresa(l.empresaId, 'leads')}">← Leads</a></div>
    <div class="lead-grade">
      <div>
        <div class="conversa" id="linha-tempo">
          ${l.mensagens.map((m) => (
            // numa linha só: a bolha usa white-space: pre-wrap (quebras do texto aparecem)
            `<div class="msg ${m.papel === 'visitante' ? 'eu' : m.papel === 'equipe' ? 'equipe' : 'bot'}"><span class="msg-origem">${ROTULO_CANAL[m.canal || 'site'] || ''} · ${papelRotulo[m.papel] || m.papel}</span>${esc(m.texto)}${m.whatsapp ? '<br><em style="color:#0a7a3a">→ Ofereceu continuar no WhatsApp</em>' : ''}<small>${data(m.em)}</small></div>`
          )).join('') || '<p class="rotulo">Sem mensagens.</p>'}
        </div>
        ${l.noWhatsapp ? `
        <form class="card" id="f-responder" style="margin-top:12px">
          <div class="campo"><label>Responder pelo WhatsApp (como equipe)</label><textarea name="texto" required style="min-height:70px" placeholder="Sua mensagem…"></textarea><small>Ao responder, a IA para neste lead para não atropelar você.</small></div>
          <div class="acoes"><button class="primario" type="submit">Enviar</button></div>
        </form>` : '<p class="rotulo" style="margin-top:12px">Este lead ainda não chegou no WhatsApp.</p>'}
      </div>
      <div>
        <div class="card">
          <div class="campo"><label>Etapa</label><select id="etapa">${l.etapas.map((e) => `<option ${e === l.etapa ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>
          <div class="campo" style="margin-top:12px"><label>Nome</label><input id="nome" value="${esc(l.nome)}" placeholder="Nome do cliente"></div>
          <p style="margin:12px 0 0"><strong>Telefone:</strong> ${l.telefone ? `+${esc(l.telefone)}` : '—'}<br><strong>Código:</strong> #${esc(l.codigo)}<br><strong>Veio por:</strong> ${ROTULO_CANAL[l.origem] || l.origem}${l.pagina ? `<br><strong>Página:</strong> <span class="rotulo">${esc(l.pagina)}</span>` : ''}</p>
          <div class="secao" style="margin-top:14px;padding-top:14px">
            <p style="margin:0 0 8px"><strong>IA neste lead:</strong> ${l.iaPausada ? `<span class="etiqueta off">pausada</span> <span class="rotulo">${esc(l.iaPausadaMotivo || '')}</span>` : '<span class="etiqueta ok">respondendo</span>'}</p>
            <button type="button" id="alternar-ia">${l.iaPausada ? 'Devolver para a IA' : 'Pausar a IA (a equipe assume)'}</button>
          </div>
          <div class="campo" style="margin-top:14px"><label>Anotações da equipe</label><textarea id="anotacoes" style="min-height:80px">${esc(l.anotacoes || '')}</textarea></div>
          <div class="acoes"><button class="primario" type="button" id="salvar-lead">Salvar</button><button type="button" class="perigo" id="apagar-lead" style="margin-left:auto">Apagar</button></div>
        </div>
        ${l.etapaHistorico?.length ? `<div class="card"><h2>Histórico de etapas</h2><ul style="margin:0;padding-left:18px">${l.etapaHistorico.slice().reverse().map((h) => `<li><span class="rotulo">${data(h.em)}</span> ${esc(h.de || '—')} → <strong>${esc(h.para)}</strong> <span class="rotulo">(${esc({ 'ia-site': 'IA do site', 'ia-whatsapp': 'IA do WhatsApp', equipe: 'equipe', sistema: 'automático' }[h.por] || h.por)})</span></li>`).join('')}</ul></div>` : ''}
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
  $('#salvar-lead').onclick = () => atualizar({ nome: $('#nome').value, anotacoes: $('#anotacoes').value }, 'Lead salvo.');
  $('#alternar-ia').onclick = () => atualizar({ iaPausada: !l.iaPausada }, l.iaPausada ? 'A IA voltou a responder este lead.' : 'IA pausada neste lead.');
  $('#apagar-lead').onclick = async () => {
    if (!confirm('Apagar este lead e todo o histórico dele?')) return;
    try {
      await api(`leads/${leadId}`, { method: 'DELETE' });
      location.hash = rotaEmpresa(l.empresaId, 'leads');
    } catch (err) { aviso(err.message, true); }
  };
  $('#f-responder')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const botao = e.target.querySelector('button');
    botao.disabled = true;
    try {
      await api(`leads/${leadId}/mensagem`, { method: 'POST', body: { texto: e.target.elements.texto.value } });
      paginaLead(leadId);
    } catch (err) {
      aviso(err.message, true);
      botao.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- usuários (admin)

async function paginaUsuarios() {
  const [lista, empresas] = await Promise.all([api('usuarios'), api('empresas')]);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Usuários</h1><button class="primario" id="novo">+ Novo usuário</button></div>
    <p class="descricao">Administradores veem tudo. Usuários de empresa entram direto na empresa deles e só veem e editam o que é dela (inclusive a chave de IA).</p>
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
  conteudo.querySelectorAll('[data-editar]').forEach((b) => {
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
      if (!confirm(`Excluir o usuário ${u.email}?`)) return;
      try {
        await api(`usuarios/${u.id}`, { method: 'DELETE' });
        fechar();
        paginaUsuarios();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- chave padrão (admin, opcional)

async function paginaConfiguracoes() {
  const c = await api('config');
  const linha = (id, nome, campo, onde, dica) => `
    <div class="card">
      <h2>${nome}</h2>
      <p style="margin-top:-4px">${c[id].configurada ? `<span class="etiqueta ok">Configurada</span> <span class="rotulo">termina em ${esc(c[id].final)} · salva no ${esc(c[id].origem)}</span>` : '<span class="etiqueta">Sem chave padrão</span>'}</p>
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
    <div class="cabecalho"><h1>Chave padrão (opcional)</h1></div>
    <p class="descricao">Cada empresa cadastra a própria chave em <strong>Empresa → Chave de IA</strong>. A chave padrão só é usada pelas empresas que ainda não têm a delas — por exemplo, se você quiser bancar a IA de um cliente. Pode deixar vazia.</p>
    ${linha('gemini', 'Gemini (Google)', 'geminiApiKey', 'https://aistudio.google.com/apikey', 'AIza…')}
    ${linha('anthropic', 'Claude (Anthropic)', 'anthropicApiKey', 'https://console.anthropic.com', 'sk-ant-…')}`;

  conteudo.querySelectorAll('form[data-provedor]').forEach((f) => {
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
      if (!confirm('Remover a chave padrão? Empresas sem chave própria param de responder.')) return;
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
    <div class="cabecalho"><h1>Minha conta</h1></div>
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

async function rotear() {
  const [caminho, query = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const partes = caminho.split('/').filter(Boolean);

  // usuário de empresa: sempre dentro da própria empresa (telas de admin não existem pra ele)
  if (!ehAdmin() && (partes.length === 0 || (partes[0] === 'empresas' && !partes[1]) || ['usuarios', 'configuracoes'].includes(partes[0]))) {
    location.replace(rotaEmpresa(sessao.usuario.empresaId));
    return;
  }

  conteudo.innerHTML = '<p class="rotulo">Carregando…</p>';
  let ativo = `#${caminho}`;
  try {
    if (partes[0] === 'empresas' && partes[1]) {
      const id = partes[1];
      const sub = partes[2] || '';
      const paginas = {
        '': () => paginaEmpresa(id),
        leads: () => paginaLeads(id, params),
        assistentes: () => paginaAssistentes(id),
        whatsapp: () => paginaWhatsapp(id),
        midias: () => paginaMidias(id),
        chave: () => paginaChave(id),
        instalar: () => paginaInstalar(id)
      };
      if (!paginas[sub]) return void (location.hash = rotaEmpresa(id));
      await paginas[sub]();
    } else {
      if (ehAdmin() && !['assistentes', 'leads'].includes(partes[0])) empresaAtual = null;
      switch (partes[0]) {
        case undefined: await paginaInicio(); break;
        case 'empresas': await paginaEmpresas(); break;
        case 'assistentes':
          await paginaAssistente(partes[1] || 'novo', params);
          ativo = rotaEmpresa(empresaAtual?.id, 'assistentes');
          break;
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
  window.addEventListener('hashchange', rotear);
  rotear();
}

iniciar();
