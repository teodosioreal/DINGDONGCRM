/*!
 * Widget de chat (assistente virtual estilo WhatsApp).
 * Uso (no <head> ou antes de </body>):
 *   <script src="https://odingdong.tech/crm/chat.js" data-empresa="emp_xxx" async></script>
 * ou, para fixar um assistente específico:
 *   <script src="https://odingdong.tech/crm/chat.js" data-bot="bot_xxx" async></script>
 */
(function () {
  'use strict';

  var script =
    document.currentScript ||
    (function () {
      var todos = document.querySelectorAll('script[data-bot], script[data-empresa]');
      return todos[todos.length - 1];
    })();
  if (!script) return;

  var botFixo = script.getAttribute('data-bot');
  var empresaId = script.getAttribute('data-empresa');
  if (!botFixo && !empresaId) return;
  var marca = botFixo || empresaId;
  if (window.__ddcrm && window.__ddcrm[marca]) return; // já carregado nesta página
  window.__ddcrm = window.__ddcrm || {};
  window.__ddcrm[marca] = true;

  var base = script.src.replace(/\/chat\.js(\?.*)?$/, '');
  // definidos depois que o servidor diz qual assistente atende este site
  var botId = null;
  var chaveLocal = null;
  var memoria = null;

  // ---------------------------------------------------------------- estado local

  function ler() {
    try {
      return JSON.parse(localStorage.getItem(chaveLocal)) || {};
    } catch (e) {
      return {};
    }
  }
  function gravar(dados) {
    try {
      localStorage.setItem(chaveLocal, JSON.stringify(dados));
    } catch (e) {
      /* navegação anônima ou bloqueada: segue sem guardar */
    }
  }

  function carregarMemoria() {
    memoria = ler();
    if (!memoria.visitanteId) {
      memoria.visitanteId = 'vis_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    memoria.mensagens = memoria.mensagens || [];
    // conversa guardada há mais de 24h começa de novo
    if (memoria.ultimaEm && Date.now() - memoria.ultimaEm > 24 * 3600 * 1000) {
      memoria.mensagens = [];
      memoria.conversaId = null;
    }
  }

  // ---------------------------------------------------------------- utilidades

  function el(tag, classe, texto) {
    var n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texto != null) n.textContent = texto;
    return n;
  }

  function hora(ts) {
    var d = new Date(ts || Date.now());
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // Texto seguro com *negrito* e links clicáveis (sem innerHTML)
  function formatar(alvo, texto) {
    var linhas = String(texto).split('\n');
    linhas.forEach(function (linha, i) {
      if (i > 0) alvo.appendChild(document.createElement('br'));
      var partes = linha.split(/(\*[^*\n]+\*|https?:\/\/[^\s]+)/g);
      partes.forEach(function (p) {
        if (!p) return;
        if (/^\*[^*]+\*$/.test(p)) {
          alvo.appendChild(el('strong', null, p.slice(1, -1)));
        } else if (/^https?:\/\//.test(p)) {
          var a = el('a', null, p);
          a.href = p;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          alvo.appendChild(a);
        } else {
          alvo.appendChild(document.createTextNode(p));
        }
      });
    });
  }

  function iconeWhatsapp(tamanho) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', tamanho);
    svg.setAttribute('height', tamanho);
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute(
      'd',
      'M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.2h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.83c2.16 0 4.19.84 5.72 2.37a8.03 8.03 0 0 1 2.37 5.71c0 4.46-3.63 8.09-8.1 8.09-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.05 8.05 0 0 1-1.24-4.28c0-4.46 3.64-8.09 8.12-8.09Zm4.47 10.24c-.07-.12-.27-.2-.57-.35-.3-.15-1.78-.88-2.06-.98-.27-.1-.47-.15-.67.15-.2.3-.77.98-.95 1.18-.17.2-.35.22-.65.07-.3-.14-1.27-.47-2.42-1.49-.9-.8-1.5-1.79-1.67-2.09-.18-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.06 2.87 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.78-.73 2.03-1.43.25-.7.25-1.3.17-1.43Z'
    );
    svg.appendChild(path);
    return svg;
  }

  function pedir(caminho, corpo) {
    var opcoes = corpo
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), keepalive: true }
      : {};
    return fetch(base + caminho, opcoes).then(function (r) {
      return r.json().then(
        function (dados) {
          return { ok: r.ok, dados: dados };
        },
        function () {
          return { ok: false, dados: {} };
        }
      );
    });
  }

  // ---------------------------------------------------------------- estilos

  var CSS =
    ':host{all:initial}[hidden]{display:none!important}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.raiz{position:fixed;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;gap:12px}' +
    '.raiz.direita{right:20px;align-items:flex-end}.raiz.esquerda{left:20px;align-items:flex-start}' +
    '.botao{width:60px;height:60px;border-radius:50%;border:0;background:#25d366;color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .15s;position:relative}' +
    '.botao:hover{transform:scale(1.06)}.botao:focus-visible{outline:3px solid #0b57d0;outline-offset:3px}' +
    '.selo{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#ff3b30;color:#fff;font-size:12px;font-weight:700;display:grid;place-items:center;padding:0 5px;border:2px solid #fff}' +
    '.balao-chamada{max-width:250px;background:#fff;color:#111b21;border-radius:12px;padding:10px 32px 10px 12px;font-size:14px;line-height:1.35;box-shadow:0 6px 20px rgba(0,0,0,.18);position:relative;cursor:pointer;animation:sobe .3s ease}' +
    '.balao-chamada .x{position:absolute;top:4px;right:6px;border:0;background:none;color:#667781;font-size:16px;cursor:pointer;line-height:1;padding:4px}' +
    '.janela{width:370px;height:560px;max-height:calc(100vh - 110px);background:#efeae2;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3);animation:sobe .2s ease}' +
    '@keyframes sobe{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
    '.topo{display:flex;align-items:center;gap:10px;padding:10px 12px;color:#fff}' +
    '.avatar{width:40px;height:40px;border-radius:50%;background:#dfe5e7;color:#54656f;display:grid;place-items:center;font-weight:700;font-size:16px;overflow:hidden;flex-shrink:0}' +
    '.avatar img{width:100%;height:100%;object-fit:cover}' +
    '.titulo{flex:1;min-width:0}.titulo b{display:block;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.titulo span{font-size:12px;opacity:.85}' +
    '.acao{border:0;background:none;color:#fff;cursor:pointer;padding:6px;border-radius:50%;display:grid;place-items:center;text-decoration:none}' +
    '.acao:hover{background:rgba(255,255,255,.15)}' +
    '.corpo{flex:1;overflow-y:auto;padding:12px 10px 6px;display:flex;flex-direction:column;gap:4px;' +
    'background-color:#efeae2;background-image:radial-gradient(rgba(0,0,0,.035) 1px,transparent 1px);background-size:18px 18px}' +
    '.aviso{align-self:center;background:#ffeecd;color:#54656f;font-size:12px;padding:6px 10px;border-radius:8px;margin:0 0 8px;text-align:center;max-width:90%}' +
    '.msg{max-width:82%;padding:6px 8px 4px 9px;border-radius:8px;font-size:14.2px;line-height:1.4;color:#111b21;box-shadow:0 1px .5px rgba(0,0,0,.13);word-wrap:break-word;white-space:normal}' +
    '.msg.bot{align-self:flex-start;background:#fff;border-top-left-radius:0}' +
    '.msg.eu{align-self:flex-end;background:#d9fdd3;border-top-right-radius:0}' +
    '.msg a{color:#027eb5}' +
    '.hora{display:block;text-align:right;font-size:11px;color:#667781;margin-top:2px}' +
    '.cta{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:9px 14px;border-radius:20px;margin:4px 0 6px;box-shadow:0 1px 2px rgba(0,0,0,.15)}' +
    '.cta:hover{filter:brightness(.95)}' +
    '.digitando{align-self:flex-start;background:#fff;border-radius:8px;border-top-left-radius:0;padding:10px 12px;display:flex;gap:4px}' +
    '.digitando i{width:7px;height:7px;border-radius:50%;background:#8696a0;animation:pula 1.2s infinite}' +
    '.digitando i:nth-child(2){animation-delay:.15s}.digitando i:nth-child(3){animation-delay:.3s}' +
    '@keyframes pula{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}' +
    '.rodape{display:flex;align-items:flex-end;gap:8px;padding:8px;background:#f0f2f5}' +
    '.rodape textarea{flex:1;resize:none;border:0;border-radius:20px;padding:10px 14px;font-size:15px;max-height:110px;outline:none;background:#fff;color:#111b21;line-height:1.35}' +
    '.enviar{width:42px;height:42px;border-radius:50%;border:0;color:#fff;cursor:pointer;display:grid;place-items:center;flex-shrink:0}' +
    '.enviar:disabled{opacity:.5;cursor:default}' +
    '.marca{text-align:center;font-size:10.5px;color:#8696a0;padding:0 0 6px;background:#f0f2f5}' +
    // Celular: janela grande o bastante para conversar, mas sem cobrir a tela toda
    // (o site continua visível em cima e o botão verde embaixo fecha a janela).
    '@media (max-width:480px){' +
    '.raiz{bottom:14px}.raiz.direita{right:12px}.raiz.esquerda{left:12px}' +
    '.janela{width:calc(100vw - 24px);height:72vh;height:min(72dvh,560px);max-height:calc(100vh - 96px);max-height:calc(100dvh - 96px);border-radius:14px}' +
    '.botao{width:54px;height:54px}' +
    '.rodape textarea{font-size:16px}' + // 16px evita o zoom automático do iPhone ao digitar
    '.raiz.aberta .balao-chamada{display:none}}' +
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}';

  // ---------------------------------------------------------------- montagem

  function quandoPronto(fn) {
    // o script pode estar no <head>: espera o <body> existir
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  var rotaConfig = botFixo
    ? '/api/public/bots/' + encodeURIComponent(botFixo)
    : '/api/public/empresas/' + encodeURIComponent(empresaId);

  pedir(rotaConfig)
    .then(function (r) {
      if (!r.ok) {
        if (window.console) console.warn('[chat] assistente indisponível:', r.dados && r.dados.erro);
        return;
      }
      botId = r.dados.id;
      chaveLocal = 'ddcrm_' + botId;
      carregarMemoria();
      quandoPronto(function () {
        montar(r.dados);
      });
    })
    .catch(function () {
      /* servidor fora do ar: o site segue normal, sem o botão */
    });

  function montar(cfg) {
    var posicao = script.getAttribute('data-posicao') || cfg.posicao || 'direita';
    var cor = cfg.cor || '#008069';

    var host = document.createElement('div');
    host.setAttribute('data-ddcrm', botId);
    document.body.appendChild(host);
    var sombra = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var estilo = document.createElement('style');
    estilo.textContent = CSS;
    sombra.appendChild(estilo);

    var raiz = el('div', 'raiz ' + (posicao === 'esquerda' ? 'esquerda' : 'direita'));
    sombra.appendChild(raiz);

    // Janela
    var janela = el('div', 'janela');
    janela.setAttribute('role', 'dialog');
    janela.setAttribute('aria-label', 'Conversa com ' + cfg.nomeAssistente);
    janela.hidden = true;

    var topo = el('div', 'topo');
    topo.style.background = cor;
    var avatar = el('div', 'avatar');
    if (cfg.avatarUrl) {
      var img = document.createElement('img');
      img.src = cfg.avatarUrl;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      avatar.textContent = (cfg.nomeAssistente || '?').trim().charAt(0).toUpperCase();
    }
    var titulo = el('div', 'titulo');
    titulo.appendChild(el('b', null, cfg.nomeAssistente));
    titulo.appendChild(el('span', null, 'Assistente virtual · online'));
    topo.appendChild(avatar);
    topo.appendChild(titulo);
    if (cfg.whatsappUrl) {
      var linkZap = el('a', 'acao');
      linkZap.href = cfg.whatsappUrl;
      linkZap.target = '_blank';
      linkZap.rel = 'noopener noreferrer';
      linkZap.title = 'Falar com a equipe no WhatsApp';
      linkZap.setAttribute('aria-label', 'Falar com a equipe no WhatsApp');
      linkZap.appendChild(iconeWhatsapp(22));
      linkZap.addEventListener('click', function () {
        registrarLead();
      });
      topo.appendChild(linkZap);
    }
    var fechar = el('button', 'acao', '✕');
    fechar.type = 'button';
    fechar.style.fontSize = '18px';
    fechar.setAttribute('aria-label', 'Fechar conversa');
    topo.appendChild(fechar);

    var corpo = el('div', 'corpo');
    corpo.setAttribute('aria-live', 'polite');
    corpo.appendChild(el('div', 'aviso', 'Você está conversando com um assistente virtual. Para falar com uma pessoa, use o botão do WhatsApp.'));

    var rodape = el('form', 'rodape');
    var campo = document.createElement('textarea');
    campo.rows = 1;
    campo.placeholder = 'Digite uma mensagem';
    campo.setAttribute('aria-label', 'Mensagem');
    campo.maxLength = 1000;
    var enviar = el('button', 'enviar');
    enviar.type = 'submit';
    enviar.style.background = cor;
    enviar.setAttribute('aria-label', 'Enviar');
    enviar.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M1.9 20.6 22.5 12 1.9 3.4l-.01 6.7L16.6 12 1.89 13.9z"/></svg>';
    rodape.appendChild(campo);
    rodape.appendChild(enviar);

    janela.appendChild(topo);
    janela.appendChild(corpo);
    janela.appendChild(rodape);
    janela.appendChild(el('div', 'marca', 'Respostas geradas por IA · podem conter erros'));

    // Balão de chamada + botão flutuante
    var chamada = null;
    if (cfg.chamada && !memoria.chamadaFechada) {
      chamada = el('div', 'balao-chamada');
      chamada.appendChild(document.createTextNode(cfg.chamada));
      var xChamada = el('button', 'x', '×');
      xChamada.type = 'button';
      xChamada.setAttribute('aria-label', 'Fechar aviso');
      chamada.appendChild(xChamada);
      chamada.hidden = true;
      xChamada.addEventListener('click', function (e) {
        e.stopPropagation();
        chamada.hidden = true;
        memoria.chamadaFechada = true;
        gravar(memoria);
      });
      chamada.addEventListener('click', abrir);
      setTimeout(function () {
        if (janela.hidden && chamada) chamada.hidden = false;
      }, 4000);
    }

    var botao = el('button', 'botao');
    botao.type = 'button';
    botao.setAttribute('aria-label', 'Abrir conversa com ' + cfg.nomeAssistente);
    botao.appendChild(iconeWhatsapp(32));
    var selo = el('span', 'selo', '1');
    if (memoria.mensagens.length > 0) selo.hidden = true;
    botao.appendChild(selo);

    raiz.appendChild(janela);
    if (chamada) raiz.appendChild(chamada);
    raiz.appendChild(botao);

    // ------------------------------------------------------------ comportamento

    var ocupado = false;

    function rolar() {
      corpo.scrollTop = corpo.scrollHeight;
    }

    function adicionarMensagem(papel, texto, ts) {
      var m = el('div', 'msg ' + (papel === 'visitante' ? 'eu' : 'bot'));
      formatar(m, texto);
      m.appendChild(el('span', 'hora', hora(ts)));
      corpo.appendChild(m);
      rolar();
    }

    function adicionarBotaoZap(url) {
      var a = el('a', 'cta');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(iconeWhatsapp(18));
      a.appendChild(document.createTextNode('Continuar no WhatsApp'));
      a.addEventListener('click', registrarLead);
      corpo.appendChild(a);
      rolar();
    }

    // ---------------------------------------------------------- conversões

    var conv = cfg.conversoes || {};

    function carregarScript(src) {
      var s = document.createElement('script');
      s.async = true;
      s.src = src;
      document.head.appendChild(s);
    }

    // Meta Ads: usa o pixel que o site já tem; se não tiver e a empresa cadastrou
    // o Pixel ID, carrega o pixel oficial da Meta só para este evento.
    function dispararMeta(eventId) {
      if (!conv.metaLead) return false;
      if (typeof window.fbq !== 'function') {
        if (!conv.metaPixelId) return false;
        /* código oficial do pixel da Meta (fbevents.js) */
        var n = (window.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        });
        if (!window._fbq) window._fbq = n;
        n.push = n;
        n.loaded = true;
        n.version = '2.0';
        n.queue = [];
        carregarScript('https://connect.facebook.net/en_US/fbevents.js');
      }
      var dados = { content_name: cfg.nomeAssistente, content_category: 'chat_ia' };
      if (conv.valor) {
        dados.value = conv.valor;
        dados.currency = conv.moeda || 'BRL';
      }
      if (conv.metaPixelId) {
        window.fbq('init', conv.metaPixelId);
        window.fbq('trackSingle', conv.metaPixelId, 'Lead', dados, { eventID: eventId });
      } else {
        window.fbq('track', 'Lead', dados, { eventID: eventId });
      }
      return true;
    }

    // Google Ads: conversão com o rótulo cadastrado (AW-.../...). Carrega o gtag
    // se o site não tiver. Sem rótulo, manda o evento padrão generate_lead
    // (dá para importar como conversão no Google Ads via GA4).
    function dispararGoogle(eventId) {
      if (!conv.googleLead) return false;
      var sendTo = conv.googleSendTo || '';
      var contaAds = sendTo.split('/')[0];
      if (typeof window.gtag !== 'function') {
        if (!sendTo) return false;
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () {
          window.dataLayer.push(arguments);
        };
        window.gtag('js', new Date());
        carregarScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(contaAds));
      }
      var dados = { transaction_id: eventId, transport_type: 'beacon' };
      if (conv.valor) {
        dados.value = conv.valor;
        dados.currency = conv.moeda || 'BRL';
      }
      if (sendTo) {
        window.gtag('config', contaAds);
        dados.send_to = sendTo;
        window.gtag('event', 'conversion', dados);
      } else {
        window.gtag('event', 'generate_lead', dados);
      }
      return true;
    }

    // Google Tag Manager: evento para quem prefere configurar as tags por lá
    function avisarGtm(eventId) {
      if (!window.dataLayer || typeof window.dataLayer.push !== 'function') return false;
      window.dataLayer.push({ event: 'dingdong_lead', dingdong_event_id: eventId, dingdong_assistente: cfg.nomeAssistente });
      return true;
    }

    // Chamado quando o visitante vai do chat para o WhatsApp. Dispara uma vez
    // por conversa, para não contar o mesmo lead duas vezes.
    function registrarLead() {
      var chaveConversa = memoria.conversaId || 'sem-conversa';
      memoria.leads = memoria.leads || {};
      if (memoria.leads[chaveConversa]) return;
      memoria.leads[chaveConversa] = Date.now();
      gravar(memoria);

      var eventId = 'dd_' + chaveConversa + '_' + Date.now().toString(36);
      var disparou = { meta: false, google: false, gtm: false };
      // medição nunca pode travar o clique: cada uma isolada
      try { disparou.meta = dispararMeta(eventId); } catch (e) {}
      try { disparou.google = dispararGoogle(eventId); } catch (e) {}
      try { disparou.gtm = avisarGtm(eventId); } catch (e) {}

      if (memoria.conversaId) {
        pedir('/api/public/lead', {
          botId: botId,
          conversaId: memoria.conversaId,
          meta: disparou.meta,
          google: disparou.google,
          gtm: disparou.gtm
        }).catch(function () {});
      }
    }

    function desenharHistorico() {
      adicionarMensagem('assistente', cfg.boasVindas, memoria.mensagens.length ? memoria.mensagens[0].em : Date.now());
      memoria.mensagens.forEach(function (m) {
        adicionarMensagem(m.papel, m.texto, m.em);
        if (m.whatsappUrl) adicionarBotaoZap(m.whatsappUrl);
      });
    }

    function abrir() {
      janela.hidden = false;
      raiz.classList.add('aberta');
      botao.setAttribute('aria-expanded', 'true');
      selo.hidden = true;
      if (chamada) chamada.hidden = true;
      if (!corpo.querySelector('.msg')) desenharHistorico();
      rolar();
      setTimeout(function () {
        campo.focus();
      }, 50);
    }

    function fecharJanela() {
      janela.hidden = true;
      raiz.classList.remove('aberta');
      botao.setAttribute('aria-expanded', 'false');
      botao.focus();
    }

    botao.addEventListener('click', function () {
      if (janela.hidden) abrir();
      else fecharJanela();
    });
    fechar.addEventListener('click', fecharJanela);
    sombra.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !janela.hidden) fecharJanela();
    });

    campo.addEventListener('input', function () {
      campo.style.height = 'auto';
      campo.style.height = Math.min(campo.scrollHeight, 110) + 'px';
    });
    campo.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        rodape.requestSubmit ? rodape.requestSubmit() : rodape.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    rodape.addEventListener('submit', function (e) {
      e.preventDefault();
      var texto = campo.value.trim();
      if (!texto || ocupado) return;
      ocupado = true;
      enviar.disabled = true;
      campo.value = '';
      campo.style.height = 'auto';

      var agora = Date.now();
      adicionarMensagem('visitante', texto, agora);
      memoria.mensagens.push({ papel: 'visitante', texto: texto, em: agora });
      memoria.ultimaEm = agora;
      gravar(memoria);

      var digitando = el('div', 'digitando');
      digitando.appendChild(el('i'));
      digitando.appendChild(el('i'));
      digitando.appendChild(el('i'));
      corpo.appendChild(digitando);
      rolar();

      pedir('/api/public/chat', {
        botId: botId,
        visitanteId: memoria.visitanteId,
        conversaId: memoria.conversaId || null,
        mensagem: texto,
        pagina: location.href.slice(0, 300)
      })
        .then(function (r) {
          var d = r.dados || {};
          if (d.conversaId) memoria.conversaId = d.conversaId;
          var resposta = r.ok ? d.resposta : d.erro || 'Não consegui responder agora.';
          var url = d.whatsappUrl || null;
          digitando.remove();
          adicionarMensagem('assistente', resposta, Date.now());
          if (url) adicionarBotaoZap(url);
          memoria.mensagens.push({ papel: 'assistente', texto: resposta, whatsappUrl: url, em: Date.now() });
          memoria.mensagens = memoria.mensagens.slice(-40);
          memoria.ultimaEm = Date.now();
          gravar(memoria);
        })
        .catch(function () {
          digitando.remove();
          adicionarMensagem('assistente', 'Sem conexão no momento. Tente de novo em instantes.', Date.now());
          if (cfg.whatsappUrl) adicionarBotaoZap(cfg.whatsappUrl);
        })
        .then(function () {
          ocupado = false;
          enviar.disabled = false;
          campo.focus();
        });
    });
  }
})();
