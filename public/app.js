// Painel do CRM: páginas simples por hash (#/empresas, #/assistentes/…).
'use strict';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const conteudo = $('#conteudo');
let sessao = null; // { usuario, empresa, iaConfigurada, modelos, urlPublica }

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

const semIaConfigurada = () => !sessao.provedores.some((p) => p.configurado);

function modalCodigo(empresa) {
  const codigo = codigoEmpresa(empresa.id);
  abrirModal(`
    <h2>Código da ${esc(empresa.nome)}</h2>
    <p>Cole <strong>uma vez</strong> no site, no cabeçalho (<code>&lt;head&gt;</code>) ou no rodapé (antes de <code>&lt;/body&gt;</code>). O botão do chat aparece sozinho em todas as páginas.</p>
    <div class="codigo">${esc(codigo)}</div>
    <div class="acoes"><button type="button" class="primario" id="copiar-emp">Copiar código</button>${empresa.principalBotId ? `<a class="botao" href="#/assistentes/${esc(empresa.principalBotId)}">Configurar a IA</a>` : ''}<button type="button" data-fechar>Fechar</button></div>
    <details style="margin-top:14px">
      <summary><strong>Onde colar em cada plataforma</strong></summary>
      <ul style="padding-left:20px;margin:10px 0 0">
        <li><strong>WordPress:</strong> instale o plugin <em>WPCode</em> → Code Snippets → Header &amp; Footer → cole em <em>Header</em> ou <em>Footer</em> → Salvar.</li>
        <li><strong>Lovable:</strong> no chat do projeto, peça: <em>"adicione este script em todas as páginas do site"</em> e cole o código.</li>
        <li><strong>Wix:</strong> Configurações → Código personalizado → + Adicionar código → cole, escolha "Todas as páginas" e "Head" ou "Body – fim".</li>
        <li><strong>Shopify / Nuvemshop / outros:</strong> procure "código personalizado", "scripts" ou edite o tema e cole antes de <code>&lt;/body&gt;</code>.</li>
        <li><strong>HTML puro:</strong> cole antes de <code>&lt;/body&gt;</code> em cada página (ou no template comum).</li>
      </ul>
      <p class="rotulo">Para usar em mais de um site da mesma empresa, cadastre os domínios em "Sites autorizados" do assistente.</p>
    </details>`, (m) => {
    $('#copiar-emp', m).onclick = () => copiar(codigo);
  });
}

// ---------------------------------------------------------------- páginas

async function paginaInicio() {
  const r = await api('resumo');
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Olá, ${esc(sessao.usuario.nome.split(' ')[0])}</h1></div>
    ${semIaConfigurada() ? `<p class="alerta">Nenhuma chave de IA configurada ainda. ${ehAdmin() ? 'Cadastre a do Claude ou a do Gemini em <a href="#/configuracoes">Configurações</a>.' : 'Peça ao administrador para configurar.'} Os assistentes não respondem até isso ser feito.</p>` : ''}
    <div class="grade-resumo">
      ${ehAdmin() ? `<div class="card"><div class="numero">${r.empresas}</div><div class="rotulo">Empresas</div></div>` : ''}
      <div class="card"><div class="numero">${r.assistentes}</div><div class="rotulo">Assistentes</div></div>
      <div class="card"><div class="numero">${r.conversas7d}</div><div class="rotulo">Conversas (7 dias)</div></div>
      <div class="card"><div class="numero">${r.leads7d}</div><div class="rotulo">Foram pro WhatsApp (7 dias)</div></div>
      <div class="card"><div class="numero">${r.mensagensHoje}</div><div class="rotulo">Mensagens hoje</div></div>
    </div>
    <div class="card">
      <h2>Como funciona</h2>
      <ol style="margin:0;padding-left:20px">
        ${ehAdmin() ? '<li>Cadastre a chave do Claude ou do Gemini em <a href="#/configuracoes">Configurações</a> (uma vez só).</li><li>Cadastre a <a href="#/empresas">empresa</a> do cliente — o assistente dela já é criado junto.</li>' : ''}
        <li>Clique em <strong>Configurar a IA</strong> e escreva tudo o que ela precisa saber (serviços, preços, horários, dúvidas comuns). Teste na lateral.</li>
        <li>Pegue o <strong>código da empresa</strong> e cole uma vez no cabeçalho ou rodapé do site (WordPress, Lovable, Wix, HTML…).</li>
        <li>Acompanhe as conversas e quem foi para o WhatsApp em <a href="#/conversas">Conversas</a>.</li>
      </ol>
    </div>`;
}

// ---------- empresas

async function paginaEmpresas() {
  const lista = await api('empresas');
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Empresas</h1><button class="primario" id="nova">+ Nova empresa</button></div>
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Nome</th><th>Nicho</th><th class="esconde-mobile">WhatsApp</th><th>Assistentes</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((e) => `
            <tr>
              <td><strong>${esc(e.nome)}</strong></td>
              <td>${esc(e.nicho) || '—'}</td>
              <td class="esconde-mobile">${esc(e.whatsapp) || '—'}</td>
              <td><a href="#/assistentes?empresa=${esc(e.id)}">${e.assistentes}</a></td>
              <td>${e.ativa ? '<span class="etiqueta ok">Ativa</span>' : '<span class="etiqueta off">Pausada</span>'}</td>
              <td style="white-space:nowrap">
                <button class="pequeno primario" data-codigo="${esc(e.id)}">Código</button>
                ${e.principalBotId ? `<a class="botao pequeno" href="#/assistentes/${esc(e.principalBotId)}">Configurar IA</a>` : ''}
                <button class="pequeno" data-editar="${esc(e.id)}">Editar</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="6" class="vazio">Nenhuma empresa ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  $('#nova').onclick = () => modalEmpresa();
  conteudo.querySelectorAll('[data-editar]').forEach((b) => {
    b.onclick = () => modalEmpresa(lista.find((e) => e.id === b.dataset.editar));
  });
  conteudo.querySelectorAll('[data-codigo]').forEach((b) => {
    b.onclick = () => modalCodigo(lista.find((e) => e.id === b.dataset.codigo));
  });
}

function modalEmpresa(emp) {
  abrirModal(`
    <h2>${emp ? 'Editar empresa' : 'Nova empresa'}</h2>
    <form id="f-emp">
      <div class="campos">
        <div class="campo largo"><label>Nome *</label><input name="nome" required value="${esc(emp?.nome)}"></div>
        <div class="campo"><label>Nicho / ramo</label><input name="nicho" placeholder="Ex.: estética automotiva" value="${esc(emp?.nicho)}"></div>
        <div class="campo"><label>WhatsApp da empresa</label><input name="whatsapp" placeholder="5521999999999" value="${esc(emp?.whatsapp)}"><small>Com DDI e DDD, só números.</small></div>
        <div class="campo"><label>Responsável</label><input name="responsavel" value="${esc(emp?.responsavel)}"></div>
        ${emp ? '' : '<div class="campo largo"><label>Site(s) da empresa</label><input name="sites" placeholder="madarashops.com.br, meusite.lovable.app"><small>Só nesses sites o chat vai aparecer. Pode deixar vazio e preencher depois no assistente.</small></div>'}
        <div class="campo largo"><label>Observações internas</label><textarea name="observacoes">${esc(emp?.observacoes)}</textarea></div>
        <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativa" ${emp?.ativa === false ? '' : 'checked'}> Empresa ativa (desmarque para pausar todos os assistentes dela)</label></div>
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
        const body = formParaObjeto(e.target);
        const salva = await api(emp ? `empresas/${emp.id}` : 'empresas', { method: emp ? 'PUT' : 'POST', body });
        fechar();
        aviso(emp ? 'Empresa salva.' : 'Empresa criada com o assistente principal.');
        await paginaEmpresas();
        if (!emp) modalCodigo(salva);
      } catch (err) { aviso(err.message, true); }
    };
    const excluir = $('#excluir', m);
    if (excluir) excluir.onclick = async () => {
      if (!confirm(`Excluir "${emp.nome}"? Isso apaga também os assistentes, as conversas e os usuários dessa empresa.`)) return;
      try {
        await api(`empresas/${emp.id}`, { method: 'DELETE' });
        fechar();
        aviso('Empresa excluída.');
        paginaEmpresas();
      } catch (err) { aviso(err.message, true); }
    };
  });
}

// ---------- assistentes

async function paginaAssistentes(params) {
  const filtro = params.get('empresa');
  const [bots, empresas] = await Promise.all([api(`bots${filtro ? `?empresaId=${encodeURIComponent(filtro)}` : ''}`), api('empresas')]);
  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>Assistentes</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${ehAdmin() && empresas.length ? `<select id="filtro" style="width:auto"><option value="">Todas as empresas</option>${empresas.map((e) => `<option value="${esc(e.id)}" ${e.id === filtro ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}</select>` : ''}
        <a class="botao primario" href="#/assistentes/novo${filtro ? `?empresa=${esc(filtro)}` : ''}">+ Novo assistente</a>
      </div>
    </div>
    ${ehAdmin() && !empresas.length ? '<p class="alerta">Cadastre uma <a href="#/empresas">empresa</a> antes de criar um assistente.</p>' : ''}
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Assistente</th>${ehAdmin() ? '<th>Empresa</th>' : ''}<th class="esconde-mobile">Sites autorizados</th><th>Hoje</th><th>Status</th></tr></thead>
        <tbody>
          ${bots.length ? bots.map((b) => `
            <tr class="clicavel" data-id="${esc(b.id)}">
              <td><strong>${esc(b.nome)}</strong><br><span class="rotulo">${esc(b.nomeAssistente) || '—'}</span></td>
              ${ehAdmin() ? `<td>${esc(b.empresaNome)}</td>` : ''}
              <td class="esconde-mobile">${b.dominios?.length ? esc(b.dominios.join(', ')) : '<span class="rotulo">qualquer site</span>'}</td>
              <td>${b.mensagensHoje} / ${b.limiteDiario}</td>
              <td>${b.ativo ? '<span class="etiqueta ok">Ativo</span>' : '<span class="etiqueta off">Pausado</span>'}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="vazio">Nenhum assistente ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  const sel = $('#filtro');
  if (sel) sel.onchange = () => { location.hash = sel.value ? `#/assistentes?empresa=${sel.value}` : '#/assistentes'; };
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
  const [bot, empresas] = await Promise.all([novo ? Promise.resolve(null) : api(`bots/${id}`), api('empresas')]);
  const b = bot || {
    empresaId: params.get('empresa') || (empresas.length === 1 ? empresas[0].id : ''),
    cor: '#008069',
    posicao: 'direita',
    provedor: (sessao.provedores.find((p) => p.configurado) || sessao.provedores[0]).id,
    modelo: '',
    limiteDiario: 500,
    limiteConversa: 40,
    ativo: true,
    conhecimento: MODELO_CONHECIMENTO
  };

  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>${novo ? 'Novo assistente' : esc(b.nome)}</h1>
      <a href="#/assistentes">← Voltar</a>
    </div>
    ${novo ? '' : `
    <div class="card">
      <h2>Código para colar no site</h2>
      <p class="rotulo" style="margin-top:-6px">Cole uma vez no cabeçalho (<code>&lt;head&gt;</code>) ou no rodapé do site. É o código da empresa: ${b.principal ? 'este é o assistente principal, então é ele que aparece' : 'ele mostra este assistente nos sites cadastrados abaixo em "Sites autorizados"; nos demais, mostra o assistente principal'}.</p>
      <div class="codigo" id="codigo">${esc(codigoEmpresa(b.empresaId))}</div>
      <div class="acoes"><button type="button" id="copiar">Copiar código</button><a class="botao" href="#/conversas?bot=${esc(b.id)}">Ver conversas</a></div>
      <details style="margin-top:12px"><summary class="rotulo">Código só deste assistente (avançado)</summary><div class="codigo" style="margin-top:8px">${esc(codigoIncorporacao(b))}</div></details>
    </div>`}
    <div class="editor">
      <form id="f-bot" class="card">
        <h2>Identificação</h2>
        <div class="campos">
          <div class="campo"><label>Nome interno *</label><input name="nome" required value="${esc(b.nome)}" placeholder="Ex.: Site Madara Volantes"></div>
          ${ehAdmin() ? `<div class="campo"><label>Empresa *</label><select name="empresaId" required><option value="">Escolha…</option>${empresas.map((e) => `<option value="${esc(e.id)}" ${e.id === b.empresaId ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}</select></div>` : ''}
          <div class="campo"><label>Nome que aparece no chat</label><input name="nomeAssistente" value="${esc(b.nomeAssistente)}" placeholder="Ex.: Madara Volantes"></div>
          <div class="campo"><label>Foto (URL da imagem)</label><input name="avatarUrl" value="${esc(b.avatarUrl)}" placeholder="https://…/logo.png"></div>
          <div class="campo"><label>Cor do topo</label><input type="color" name="cor" value="${esc(b.cor || '#008069')}"></div>
          <div class="campo"><label>Posição do botão</label><select name="posicao"><option value="direita" ${b.posicao !== 'esquerda' ? 'selected' : ''}>Canto direito</option><option value="esquerda" ${b.posicao === 'esquerda' ? 'selected' : ''}>Canto esquerdo</option></select></div>
        </div>

        <h2 style="margin-top:22px">Conversa</h2>
        <div class="campos">
          <div class="campo largo"><label>Mensagem de boas-vindas</label><input name="boasVindas" value="${esc(b.boasVindas)}" placeholder="Olá! 👋 Como posso te ajudar?"></div>
          <div class="campo largo"><label>Balão de chamada (opcional)</label><input name="chamada" value="${esc(b.chamada)}" placeholder="Tire suas dúvidas por aqui! 💬"><small>Aparece ao lado do botão alguns segundos depois de abrir o site.</small></div>
          <div class="campo largo"><label>Tom de voz</label><input name="tom" value="${esc(b.tom)}" placeholder="simpático, próximo e profissional"></div>
          <div class="campo largo">
            <label>Tudo o que o assistente precisa saber *</label>
            <textarea class="grande" name="conhecimento">${esc(b.conhecimento)}</textarea>
            <small>Serviços, preços, região atendida, horários, prazos, garantia, formas de pagamento, dúvidas comuns. O assistente não inventa nada fora disso.</small>
          </div>
          <div class="campo largo"><label>Regras extras (opcional)</label><textarea name="regras" placeholder="Ex.: Nunca dê desconto. Sempre pergunte o modelo do carro antes de passar o preço.">${esc(b.regras)}</textarea></div>
        </div>

        <h2 style="margin-top:22px">WhatsApp</h2>
        <div class="campos">
          <div class="campo"><label>Número que recebe os clientes</label><input name="whatsapp" value="${esc(b.whatsapp)}" placeholder="Vazio = usa o da empresa"></div>
          <div class="campo"><label>Mensagem padrão do botão do topo</label><input name="mensagemWhatsappPadrao" value="${esc(b.mensagemWhatsappPadrao)}" placeholder="Olá! Vim pelo site."></div>
        </div>

        <h2 style="margin-top:22px">Segurança e limites</h2>
        <div class="campos">
          <div class="campo largo"><label>Sites autorizados</label><input name="dominios" value="${esc((b.dominios || []).join(', '))}" placeholder="madarashops.com.br, madara-volantes-landing.lovable.app"><small>Separe por vírgula. Subdomínios entram automaticamente. Vazio = qualquer site (não recomendado).</small></div>
          ${ehAdmin() ? `
          <div class="campo"><label>IA que responde</label><select name="provedor">${sessao.provedores.map((p) => `<option value="${esc(p.id)}" ${p.id === (b.provedor || 'anthropic') ? 'selected' : ''}>${esc(p.nome)}${p.configurado ? '' : ' — sem chave'}</option>`).join('')}</select></div>
          <div class="campo"><label>Modelo</label><select name="modelo"><option value="${esc(b.modelo)}">${esc(b.modelo)}</option></select><small id="aviso-modelo"></small></div>
          <div class="campo"><label>Limite de mensagens por dia</label><input type="number" min="1" name="limiteDiario" value="${esc(b.limiteDiario)}"></div>
          <div class="campo"><label>Limite de mensagens por conversa</label><input type="number" min="1" name="limiteConversa" value="${esc(b.limiteConversa)}"></div>` : ''}
          <div class="campo largo"><label class="linha-check"><input type="checkbox" name="ativo" ${b.ativo === false ? '' : 'checked'}> Assistente ativo</label></div>
          <div class="campo largo"><label class="linha-check"><input type="checkbox" name="principal" ${b.principal ? 'checked' : ''}> Assistente principal da empresa (usado pelo código da empresa quando o site não está ligado a outro assistente)</label></div>
        </div>

        <div class="acoes">
          <button class="primario" type="submit">${novo ? 'Criar assistente' : 'Salvar alterações'}</button>
          ${novo ? '' : '<button type="button" class="perigo" id="excluir" style="margin-left:auto">Excluir</button>'}
        </div>
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
    if (!selProvedor) return;
    const atual = manterAtual ? selModelo.value : '';
    selModelo.innerHTML = '<option>carregando…</option>';
    try {
      const r = await api(`ia/modelos?provedor=${encodeURIComponent(selProvedor.value)}`);
      const lista = r.modelos.slice();
      if (atual && !lista.some((m) => m.id === atual)) lista.unshift({ id: atual, nome: `${atual} (atual)` });
      selModelo.innerHTML = lista.map((m) => `<option value="${esc(m.id)}">${esc(m.id === m.nome ? m.id : `${m.nome} — ${m.id}`)}</option>`).join('');
      const preferido = atual || (selProvedor.value === 'gemini' ? lista.find((m) => /flash/.test(m.id) && !/lite|preview|exp/.test(m.id))?.id : lista[0]?.id);
      if (preferido) selModelo.value = preferido;
      $('#aviso-modelo').textContent = r.aviso ? `Não consegui listar os modelos da sua chave (${r.aviso}). Mostrando sugestões.` : r.daChave ? 'Lista de modelos disponíveis na sua chave do Google.' : '';
    } catch (err) {
      aviso(err.message, true);
    }
  }
  if (selProvedor) {
    carregarModelos(true);
    selProvedor.onchange = () => carregarModelos(false);
  }
  $('#copiar')?.addEventListener('click', () => copiar(codigoEmpresa(b.empresaId)));

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const salvo = await api(novo ? 'bots' : `bots/${b.id}`, { method: novo ? 'POST' : 'PUT', body: formParaObjeto(form) });
      aviso(novo ? 'Assistente criado! Agora copie o código para o site.' : 'Alterações salvas.');
      if (novo) location.hash = `#/assistentes/${salvo.id}`;
      else paginaAssistente(salvo.id, params);
    } catch (err) { aviso(err.message, true); }
  };

  $('#excluir')?.addEventListener('click', async () => {
    if (!confirm(`Excluir o assistente "${b.nome}" e todas as conversas dele? O código colado nos sites para de funcionar.`)) return;
    try {
      await api(`bots/${b.id}`, { method: 'DELETE' });
      aviso('Assistente excluído.');
      location.hash = '#/assistentes';
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

// ---------- conversas

async function paginaConversas(params) {
  const botId = params.get('bot') || '';
  const soLeads = params.get('leads') === '1';
  const qs = new URLSearchParams();
  if (botId) qs.set('botId', botId);
  if (soLeads) qs.set('soLeads', '1');
  const [lista, bots] = await Promise.all([api(`conversas?${qs}`), api('bots')]);
  conteudo.innerHTML = `
    <div class="cabecalho">
      <h1>Conversas</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="f-bot" style="width:auto"><option value="">Todos os assistentes</option>${bots.map((x) => `<option value="${esc(x.id)}" ${x.id === botId ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select>
        <label class="linha-check"><input type="checkbox" id="f-leads" ${soLeads ? 'checked' : ''}> Só quem foi pro WhatsApp</label>
      </div>
    </div>
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Quando</th><th>Primeira mensagem</th><th class="esconde-mobile">Assistente</th><th>Msgs</th><th>WhatsApp</th></tr></thead>
        <tbody>
          ${lista.length ? lista.map((c) => `
            <tr class="clicavel" data-id="${esc(c.id)}">
              <td style="white-space:nowrap">${data(c.atualizadoEm)}</td>
              <td>${esc(c.primeiraMensagem) || '—'}</td>
              <td class="esconde-mobile">${esc(c.botNome)}</td>
              <td>${c.mensagens}</td>
              <td>${c.lead ? '<span class="etiqueta ok">Sim</span>' : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="vazio">Nenhuma conversa ainda.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  const atualizar = () => {
    const p = new URLSearchParams();
    if ($('#f-bot').value) p.set('bot', $('#f-bot').value);
    if ($('#f-leads').checked) p.set('leads', '1');
    location.hash = `#/conversas${p.toString() ? `?${p}` : ''}`;
  };
  $('#f-bot').onchange = atualizar;
  $('#f-leads').onchange = atualizar;
  conteudo.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => { location.hash = `#/conversas/${tr.dataset.id}`; }; });
}

async function paginaConversa(id) {
  const c = await api(`conversas/${id}`);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Conversa</h1><a href="#/conversas">← Voltar</a></div>
    <div class="card">
      <p style="margin:0 0 4px"><strong>Assistente:</strong> ${esc(c.botNome)}</p>
      <p style="margin:0 0 4px"><strong>Início:</strong> ${data(c.criadoEm)} · <strong>Última mensagem:</strong> ${data(c.atualizadoEm)}</p>
      <p style="margin:0 0 4px"><strong>Página:</strong> ${c.pagina ? esc(c.pagina) : '—'}</p>
      <p style="margin:0"><strong>Foi pro WhatsApp:</strong> ${c.lead ? `sim (${data(c.leadEm)})` : 'não'}</p>
    </div>
    <div class="conversa">
      ${c.mensagens.map((m) => `
        <div class="msg ${m.papel === 'visitante' ? 'eu' : 'bot'}">${esc(m.texto)}${m.whatsapp ? `<br><em style="color:#0a7a3a">→ Ofereceu WhatsApp: "${esc(m.whatsapp)}"</em>` : ''}<small>${data(m.em)}</small></div>`).join('')}
    </div>`;
}

// ---------- usuários

async function paginaUsuarios() {
  const [lista, empresas] = await Promise.all([api('usuarios'), api('empresas')]);
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Usuários</h1><button class="primario" id="novo">+ Novo usuário</button></div>
    <p class="rotulo">Administradores veem tudo. Usuários de empresa só veem e editam os assistentes e conversas da própria empresa.</p>
    <div class="card tabela-wrap">
      <table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Acesso</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${lista.map((u) => `
            <tr>
              <td>${esc(u.nome)}</td>
              <td>${esc(u.email)}</td>
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

// ---------- configurações (chaves de IA)

async function paginaConfiguracoes() {
  const c = await api('config');
  const linha = (id, nome, campo, onde, dica) => `
    <div class="card">
      <h2>${nome}</h2>
      <p style="margin-top:-4px">${c[id].configurada ? `<span class="etiqueta ok">Configurada</span> <span class="rotulo">termina em ${esc(c[id].final)} · salva no ${esc(c[id].origem)}</span>` : '<span class="etiqueta off">Sem chave</span>'}</p>
      <form data-provedor="${id}">
        <div class="campo"><label>${c[id].configurada ? 'Trocar chave' : 'Chave de API'}</label><input name="${campo}" type="password" autocomplete="off" placeholder="${esc(dica)}"><small>Crie em <a href="${onde}" target="_blank" rel="noopener">${onde.replace('https://', '')}</a>.</small></div>
        <div class="acoes">
          <button class="primario" type="submit">Salvar</button>
          ${c[id].configurada ? '<button type="button" data-testar>Testar chave</button>' : ''}
          ${c[id].origem === 'painel' ? '<button type="button" class="perigo" data-remover>Remover do painel</button>' : ''}
        </div>
      </form>
    </div>`;
  conteudo.innerHTML = `
    <div class="cabecalho"><h1>Configurações</h1></div>
    <p class="rotulo">Cadastre uma ou as duas. Em cada assistente você escolhe qual IA responde. A chave fica só no servidor — nunca vai para o site do cliente.</p>
    ${linha('anthropic', 'Claude (Anthropic)', 'anthropicApiKey', 'https://console.anthropic.com', 'sk-ant-…')}
    ${linha('gemini', 'Gemini (Google)', 'geminiApiKey', 'https://aistudio.google.com/apikey', 'AIza…')}`;

  conteudo.querySelectorAll('form[data-provedor]').forEach((f) => {
    const provedor = f.dataset.provedor;
    const recarregar = async () => {
      sessao = await api('auth/eu');
      paginaConfiguracoes();
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const dados = formParaObjeto(f);
      if (!Object.values(dados)[0]) return aviso('Cole a chave antes de salvar.', true);
      try {
        await api('config', { method: 'PUT', body: dados });
        aviso('Chave salva. Testando…');
        try {
          const r = await api('config/testar', { method: 'POST', body: { provedor } });
          aviso(r.mensagem);
        } catch (err) { aviso(err.message, true); }
        recarregar();
      } catch (err) { aviso(err.message, true); }
    };
    $('[data-testar]', f)?.addEventListener('click', async () => {
      try {
        const r = await api('config/testar', { method: 'POST', body: { provedor } });
        aviso(r.mensagem);
      } catch (err) { aviso(err.message, true); }
    });
    $('[data-remover]', f)?.addEventListener('click', async () => {
      if (!confirm('Remover esta chave do painel? Assistentes que usam essa IA param de responder (a menos que exista uma chave no .env).')) return;
      try {
        await api('config', { method: 'PUT', body: { remover: [provedor] } });
        recarregar();
      } catch (err) { aviso(err.message, true); }
    });
  });
}

// ---------- minha conta

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

  document.querySelectorAll('#menu a').forEach((a) => {
    const alvo = a.getAttribute('href').slice(2);
    a.classList.toggle('ativo', (partes[0] || '') === alvo);
  });

  conteudo.innerHTML = '<p class="rotulo">Carregando…</p>';
  try {
    switch (partes[0]) {
      case undefined: return await paginaInicio();
      case 'empresas': return ehAdmin() ? await paginaEmpresas() : paginaInicio();
      case 'assistentes': return partes[1] ? await paginaAssistente(partes[1], params) : await paginaAssistentes(params);
      case 'conversas': return partes[1] ? await paginaConversa(partes[1]) : await paginaConversas(params);
      case 'usuarios': return ehAdmin() ? await paginaUsuarios() : paginaInicio();
      case 'configuracoes': return ehAdmin() ? await paginaConfiguracoes() : paginaInicio();
      case 'conta': return paginaConta();
      default: location.hash = '#/';
    }
  } catch (err) {
    conteudo.innerHTML = `<p class="alerta">${esc(err.message)}</p>`;
  }
}

async function iniciar() {
  try {
    sessao = await api('auth/eu');
  } catch {
    return;
  }
  $('#nome-usuario').textContent = sessao.usuario.nome;
  if (!ehAdmin()) document.querySelectorAll('[data-admin]').forEach((el) => el.remove());
  $('#sair').onclick = async () => {
    await api('auth/sair', { method: 'POST' }).catch(() => {});
    location.href = 'login';
  };
  window.addEventListener('hashchange', rotear);
  rotear();
}

iniciar();
