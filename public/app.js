// Painel do CRM: páginas por hash, no mesmo estilo do painel DingDong
// (menu lateral; dentro de cada empresa: Painel, Assistente IA, Conversas,
// Chave de IA, Conversões e Instalar no site).
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
    html += item(rotaEmpresa(id, 'assistentes'), 'Assistente IA');
    html += item(rotaEmpresa(id, 'conversas'), 'Conversas');
    html += item(rotaEmpresa(id, 'chave'), 'Chave de IA');
    html += item(rotaEmpresa(id, 'conversoes'), 'Conversões (Meta / Google)');
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
      <div class="card"><div class="rotulo">Conversas (7 dias)</div><div class="numero">${r.conversas7d}</div></div>
      <div class="card"><div class="rotulo">Leads pro WhatsApp (7 dias)</div><div class="numero">${r.leads7d}</div></div>
      <div class="card"><div class="rotulo">Mensagens hoje</div><div class="numero">${r.mensagensHoje}</div></div>
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
    <p class="descricao">Cada empresa tem a própria IA (chave e assistente), as próprias conversões do Meta/Google Ads e um código para o site.</p>
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
      texto: 'Ensinar a IA: serviços, preços, horários e dúvidas comuns',
      href: principal ? `#/assistentes/${principal.id}` : rotaEmpresa(id, 'assistentes')
    },
    {
      feito: Boolean(emp.conversoes.metaPixelId || emp.conversoes.googleSendTo),
      texto: 'Conferir as conversões do Meta Ads e do Google Ads',
      href: rotaEmpresa(id, 'conversoes')
    },
    {
      feito: r.conversas7d > 0,
      texto: 'Colar o código no site (aparece como feito quando chegar a primeira conversa)',
      href: rotaEmpresa(id, 'instalar')
    }
  ];
  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>${esc(emp.nome)}</h1>
      ${ehAdmin() ? '<button type="button" id="editar-emp">Editar empresa</button>' : ''}
    </div>
    <div class="grade-resumo">
      <div class="card"><div class="rotulo">Conversas (7 dias)</div><div class="numero">${r.conversas7d}</div></div>
      <div class="card"><div class="rotulo">Leads pro WhatsApp (7 dias)</div><div class="numero">${r.leads7d}</div></div>
      <div class="card"><div class="rotulo">Mensagens hoje</div><div class="numero">${r.mensagensHoje}</div></div>
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

// ---------------------------------------------------------------- empresa: conversões

async function paginaConversoes(id) {
  const emp = await definirEmpresaAtual(id);
  const c = emp.conversoes;
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Conversões</h1></div>
    <p class="descricao">Quando o visitante sai do chat para o WhatsApp (o lead qualificado pela IA), o chat dispara automaticamente as conversões abaixo no navegador dele. Uma vez por conversa, para não contar em dobro.</p>
    <form id="f-conv">
      <div class="card">
        <h2>Meta Ads</h2>
        <label class="linha-check"><input type="checkbox" name="metaLead" ${c.metaLead ? 'checked' : ''}> Disparar o evento <strong>Lead</strong> no Meta Ads</label>
        <div class="campos" style="margin-top:14px">
          <div class="campo"><label>Pixel ID (opcional)</label><input name="metaPixelId" inputmode="numeric" value="${esc(c.metaPixelId)}" placeholder="123456789012345">
            <small>Se o site já tem o pixel da Meta instalado, pode deixar vazio — o evento vai para ele. Preencha para mandar para um pixel específico (ou se o site não tiver pixel).</small></div>
        </div>
      </div>
      <div class="card">
        <h2>Google Ads</h2>
        <label class="linha-check"><input type="checkbox" name="googleLead" ${c.googleLead ? 'checked' : ''}> Disparar a conversão de <strong>Lead</strong> no Google Ads</label>
        <div class="campos" style="margin-top:14px">
          <div class="campo"><label>Rótulo da conversão (send_to)</label><input name="googleSendTo" value="${esc(c.googleSendTo)}" placeholder="AW-123456789/AbCdEfGhIjk">
            <small>No Google Ads: Metas → Conversões → Nova ação de conversão → Site → configurar manualmente (categoria "Lead"). Copie o valor de <code>send_to</code> do trecho do evento. Sem o rótulo, o chat manda o evento <code>generate_lead</code> para o Google (dá para importar como conversão via GA4).</small></div>
          <div class="campo"><label>Valor do lead (opcional)</label><input name="valor" inputmode="decimal" value="${c.valor || ''}" placeholder="0,00"><small>Enviado junto nas duas plataformas, em R$.</small></div>
        </div>
      </div>
      <div class="card">
        <h2>Google Tag Manager</h2>
        <p class="rotulo" style="margin:0">Se o site usa o GTM, o chat também manda o evento <code>dingdong_lead</code> para o <code>dataLayer</code> — dá para criar gatilhos com ele.</p>
      </div>
      <div class="acoes"><button class="primario" type="submit">Salvar</button></div>
    </form>`;
  $('#f-conv').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const salva = await api(`empresas/${id}/conversoes`, { method: 'PUT', body: formParaObjeto(e.target) });
      empresaAtual = { id: salva.id, nome: salva.nome, dados: salva };
      aviso('Conversões salvas.');
    } catch (err) { aviso(err.message, true); }
  };
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
            <div class="campo largo"><label>Regras extras (opcional)</label><textarea name="regras" placeholder="Ex.: Sempre pergunte o modelo do carro antes de passar o preço.">${esc(b.regras)}</textarea></div>
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
          ${novo ? '' : `<a class="botao" href="${rotaEmpresa(empresaId, 'conversas')}">Ver conversas</a>`}
          ${novo ? '' : '<button type="button" class="perigo" id="excluir" style="margin-left:auto">Excluir</button>'}
        </div>
        ${novo ? '' : `<details style="margin-top:16px"><summary class="rotulo">Código só deste assistente (avançado)</summary><div class="codigo" style="margin-top:8px">${esc(codigoIncorporacao(b))}</div></details>`}
      </form>

      <div class="card teste">
        <div class="cab"><span>Testar conversa</span><button type="button" class="pequeno" id="limpar">Limpar</button></div>
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
      const r = await api(`bots/${b.id}/testar`, { method: 'POST', body: { bot: formParaObjeto(form), mensagens: historico } });
      // mesmo *negrito* que o widget mostra no site
      esperando.innerHTML = esc(r.resposta).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
      historico.push({ papel: 'assistente', texto: r.resposta });
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

// ---------------------------------------------------------------- empresa: conversas

function etiquetasConversao(c) {
  if (!c.lead) return '—';
  const x = c.conversoes || {};
  const partes = [x.meta && 'Meta', x.google && 'Google'].filter(Boolean);
  return `<span class="etiqueta ok">Lead</span>${partes.length ? ` <span class="rotulo">${partes.join(' + ')}</span>` : ''}`;
}

async function paginaConversas(id, params) {
  await definirEmpresaAtual(id);
  const soLeads = params.get('leads') === '1';
  const qs = new URLSearchParams({ empresaId: id });
  if (soLeads) qs.set('soLeads', '1');
  const lista = await api(`conversas?${qs}`);
  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>Conversas</h1>
      <label class="linha-check"><input type="checkbox" id="f-leads" ${soLeads ? 'checked' : ''}> Só quem foi pro WhatsApp</label>
    </div>
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Quando</th><th>Primeira mensagem</th><th class="esconde-mobile">Msgs</th><th>WhatsApp</th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((c) => `
            <tr class="clicavel" data-id="${esc(c.id)}">
              <td style="white-space:nowrap">${data(c.atualizadoEm)}</td>
              <td>${esc(c.primeiraMensagem) || '—'}</td>
              <td class="esconde-mobile">${c.mensagens}</td>
              <td style="white-space:nowrap">${etiquetasConversao(c)}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="vazio">Nenhuma conversa ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  $('#f-leads').onchange = (e) => { location.hash = rotaEmpresa(id, 'conversas') + (e.target.checked ? '?leads=1' : ''); };
  conteudo.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => { location.hash = `#/conversas/${tr.dataset.id}`; }; });
}

async function paginaConversa(id) {
  const c = await api(`conversas/${id}`);
  await definirEmpresaAtual(c.empresaId);
  const x = c.conversoes || {};
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Conversa</h1><a class="botao" href="${rotaEmpresa(c.empresaId, 'conversas')}">← Voltar</a></div>
    <div class="card">
      <p style="margin:0 0 4px"><strong>Assistente:</strong> ${esc(c.botNome)}</p>
      <p style="margin:0 0 4px"><strong>Início:</strong> ${data(c.criadoEm)} · <strong>Última mensagem:</strong> ${data(c.atualizadoEm)}</p>
      <p style="margin:0 0 4px"><strong>Página:</strong> ${c.pagina ? esc(c.pagina) : '—'}</p>
      <p style="margin:0"><strong>Foi pro WhatsApp:</strong> ${c.lead ? `sim (${data(c.leadEm)}) · Meta Ads: ${x.meta ? 'disparado' : 'não'} · Google Ads: ${x.google ? 'disparado' : 'não'}` : 'não'}</p>
    </div>
    <div class="conversa">
      ${c.mensagens.map((m) => `
        <div class="msg ${m.papel === 'visitante' ? 'eu' : 'bot'}">${esc(m.texto)}${m.whatsapp ? `<br><em style="color:#0a7a3a">→ Ofereceu WhatsApp: "${esc(m.whatsapp)}"</em>` : ''}<small>${data(m.em)}</small></div>`).join('')}
    </div>`;
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
        assistentes: () => paginaAssistentes(id),
        conversas: () => paginaConversas(id, params),
        chave: () => paginaChave(id),
        conversoes: () => paginaConversoes(id),
        instalar: () => paginaInstalar(id)
      };
      if (!paginas[sub]) return void (location.hash = rotaEmpresa(id));
      await paginas[sub]();
    } else {
      if (ehAdmin() && !['assistentes', 'conversas'].includes(partes[0])) empresaAtual = null;
      switch (partes[0]) {
        case undefined: await paginaInicio(); break;
        case 'empresas': await paginaEmpresas(); break;
        case 'assistentes':
          await paginaAssistente(partes[1] || 'novo', params);
          ativo = rotaEmpresa(empresaAtual?.id, 'assistentes');
          break;
        case 'conversas':
          await paginaConversa(partes[1]);
          ativo = rotaEmpresa(empresaAtual?.id, 'conversas');
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
