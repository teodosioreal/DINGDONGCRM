// disparos.js — disparos em massa pelo WhatsApp para os leads da empresa.
//
// Cuidados para o número não ser bloqueado pelo WhatsApp:
//  - só envia para quem já é lead da empresa (nunca para listas compradas);
//  - uma mensagem por vez, com intervalo aleatório entre elas;
//  - variações de texto ({Oi|Olá}) e o nome da pessoa ({nome});
//  - por padrão só envia em horário comercial;
//  - quem responde SAIR não recebe mais (e o CRM confirma);
//  - se a conexão cair, o disparo pausa sozinho (sem perder a fila).
// Quando o lead responde, a IA do WhatsApp continua a conversa normalmente — seguindo o roteiro
// do disparo, se tiver — e o lead pode ir sozinho para uma etapa/etiqueta. Quem não responde pode
// receber UM lembrete depois de alguns dias. A 1ª foto pode ir com o nome de cada contato escrito.

const { estado, salvar, novoId, agora } = require('./db');
const { texto } = require('./util');
const leads = require('./leads');
const midias = require('./midias');
const whatsapp = require('./whatsapp');

const MAX_DESTINATARIOS = 2000;
const MAX_DESTINATARIOS_PROSPECCAO = 5000; // listas grandes: saem aos poucos, com limite por dia
const maxDestinatarios = (prospeccao) => (prospeccao ? MAX_DESTINATARIOS_PROSPECCAO : MAX_DESTINATARIOS);
const INTERVALO_MINIMO = 8; // segundos
const INTERVALO_MAXIMO = 12 * 60 * 60; // até 12 h entre uma mensagem e outra
const HORA_INICIO = 8;
const HORA_FIM = 20;

const timers = new Map();

function erro(mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { status });
}

// ---------------------------------------------------------------- quem recebe

function normalizarFiltro(f = {}) {
  const lista = (v) => (Array.isArray(v) ? v.map((x) => texto(x, 80)).filter(Boolean) : []);
  return {
    etapas: lista(f.etapas),
    etiquetas: lista(f.etiquetas),
    origem: ['site', 'whatsapp', 'manual'].includes(f.origem) ? f.origem : 'todos',
    leadIds: lista(f.leadIds),
    listaId: texto(f.listaId, 60), // lista de contatos importada na aba Disparos
    pularJaDisparados: f.pularJaDisparados === true // não manda de novo para quem já recebeu disparo em massa
  };
}

function destinatariosPara(empresa, filtroBruto) {
  const filtro = normalizarFiltro(filtroBruto);
  const vistos = new Set();
  const saida = [];
  const lista = estado.conversas
    .filter((c) => c.empresaId === empresa.id)
    .sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1));
  let semNumero = 0;
  let sairam = 0;
  let jaDisparados = 0;
  const { jaRecebeuDisparo } = require('./prospeccao');
  for (const c of lista) {
    if (filtro.leadIds.length && !filtro.leadIds.includes(c.id)) continue;
    if (filtro.etapas.length && !filtro.etapas.includes(c.etapa)) continue;
    if (filtro.etiquetas.length && !(c.etiquetas || []).some((t) => filtro.etiquetas.includes(t))) continue;
    if (filtro.origem !== 'todos' && (c.origem || 'site') !== filtro.origem) continue;
    if (filtro.listaId && c.prospeccao?.listaId !== filtro.listaId) continue;
    if (c.naoDisparar || leads.naListaNegra(empresa, c)) {
      sairam++;
      continue;
    }
    const destino = whatsapp.destinoDoLead(c);
    if (!destino) {
      semNumero++;
      continue;
    }
    if (vistos.has(destino)) continue;
    const recebeu = jaRecebeuDisparo(c);
    if (recebeu) jaDisparados++;
    if (recebeu && filtro.pularJaDisparados) continue;
    vistos.add(destino);
    saida.push({ leadId: c.id, nome: c.nome || '', destino });
  }
  // contatos escolhidos na tela (ex.: lista em ordem de prioridade): saem nessa ordem
  if (filtro.leadIds.length) {
    const pos = new Map(filtro.leadIds.map((x, i) => [x, i]));
    saida.sort((a, b) => pos.get(a.leadId) - pos.get(b.leadId));
  }
  return { filtro, destinatarios: saida, semNumero, sairam, jaDisparados };
}

// ---------------------------------------------------------------- texto

// {Oi|Olá|E aí} → escolhe uma; {nome} → primeiro nome; {nome_completo}; {empresa}
function montarMensagem(modelo, lead, empresa) {
  // "nome" que é número de telefone (cliente sem nome salvo) nunca entra na mensagem
  const bruto = String(lead?.nome || '').trim();
  const nomeCompleto = /\p{L}/u.test(bruto) && !/\d{4,}/.test(bruto.replace(/[\s()+-]/g, '')) ? bruto : '';
  // contato de lista importada sem nome de pessoa (o nome é o da empresa): {nome} vira o nome inteiro
  const primeiro = lead?.prospeccao?.empresa && nomeCompleto === lead.prospeccao.empresa ? nomeCompleto : nomeCompleto.split(/\s+/)[0] || '';
  const bot = estado.bots.find((b) => b.empresaId === empresa.id && b.principal) || estado.bots.find((b) => b.empresaId === empresa.id);
  const valores = {
    nome: primeiro,
    primeiro_nome: primeiro,
    nome_completo: nomeCompleto,
    empresa: empresa.nome || '',
    link_avaliacao: bot?.linkAvaliacao || '',
    link_anuncio: bot?.linkAnuncio || '',
    // contatos de lista importada: empresa, cidade e ramo do CONTATO ({empresa} é a sua)
    empresa_contato: lead?.prospeccao?.empresa || '',
    cidade: lead?.prospeccao?.cidade || '',
    ramo: lead?.prospeccao?.ramo || ''
  };
  let t = String(modelo || '').replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opcoes) => {
    const lista = opcoes.split('|');
    return lista[Math.floor(Math.random() * lista.length)];
  });
  t = t.replace(/\{(nome|primeiro_nome|nome_completo|empresa_contato|empresa|link_avaliacao|link_anuncio|cidade|ramo)\}/gi, (_, v) => valores[v.toLowerCase()]);
  // {horarios}: os próximos horários livres de Agendamentos (sem nenhum: "ainda essa semana")
  if (/\{horarios\}/i.test(t)) {
    const h = require('./horarios-ia').textoHorarios(empresa, lead?.id ? lead : null);
    t = t.replace(/\{horarios\}/gi, h);
  }
  // "Oi , tudo bem?" quando não sabemos o nome
  return t.replace(/ +([,!?.])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

const RODAPE_SAIR = 'Para não receber mais mensagens, responda SAIR.';

// ---------------------------------------------------------------- execução

function horaEmSaoPaulo() {
  return Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
}

function dentroDoHorario(d) {
  if (!d.horarioComercial) return true;
  const h = horaEmSaoPaulo();
  return h >= HORA_INICIO && h < HORA_FIM;
}

function agendar(d, ms) {
  clearTimeout(timers.get(d.id));
  const t = setTimeout(() => {
    timers.delete(d.id);
    processar(d.id).catch((err) => console.error(`[disparo ${d.id}]`, err.message));
  }, Math.max(0, Math.min(ms, 60 * 60 * 1000)));
  t.unref?.();
  timers.set(d.id, t);
}

function sorteioIntervalo(d) {
  const min = Math.max(d.prospeccao ? require('./prospeccao').INTERVALO_MINIMO_PROSPECCAO : INTERVALO_MINIMO, d.intervaloMin || 20);
  const max = Math.max(min, d.intervaloMax || 60);
  return (min + Math.random() * (max - min)) * 1000;
}

function pausarPorErro(d, motivo) {
  d.status = 'pausado';
  d.motivoPausa = motivo;
  d.proximoEnvioEm = null;
  salvar();
}

// um envio por vez em cada disparo (gerar a foto personalizada leva um tempinho: o relógio não
// pode mandar para a mesma pessoa de novo enquanto isso)
const emAndamento = new Set();
async function processar(id) {
  if (emAndamento.has(id)) return;
  emAndamento.add(id);
  try {
    return await processarUm(id);
  } finally {
    emAndamento.delete(id);
  }
}

async function processarUm(id) {
  const d = estado.disparos.find((x) => x.id === id);
  if (!d) return;
  if (d.status === 'agendado') {
    const falta = new Date(d.agendadoPara).getTime() - Date.now();
    if (falta > 1000) return agendar(d, falta);
    d.status = 'enviando';
    d.iniciadoEm = d.iniciadoEm || agora();
    salvar();
  }
  if (d.status !== 'enviando') return;
  // intervalo longo (ex.: de hora em hora): o relógio acorda no máximo a cada 1 h — ainda não é a vez
  const falta = d.proximoEnvioEm ? new Date(d.proximoEnvioEm).getTime() - Date.now() : 0;
  if (falta > 1000) return agendar(d, falta);
  const empresa = estado.empresas.find((e) => e.id === d.empresaId);
  if (!empresa) return pausarPorErro(d, 'Empresa não encontrada.');
  if (!whatsapp.configurado(empresa)) return pausarPorErro(d, 'O WhatsApp da empresa não está conectado.');

  if (!dentroDoHorario(d)) {
    d.proximoEnvioEm = null;
    d.aguardandoHorario = true;
    salvar();
    return agendar(d, 10 * 60 * 1000); // confere de novo em 10 minutos
  }
  d.aguardandoHorario = false;

  const item = d.destinatarios.find((x) => x.status === 'pendente');
  if (!item) {
    d.status = 'concluido';
    d.concluidoEm = agora();
    d.proximoEnvioEm = null;
    salvar();
    return;
  }

  const lead = estado.conversas.find((c) => c.id === item.leadId);
  if (!lead || lead.naoDisparar || require('./leads').naListaNegra(null, lead)) {
    item.status = 'ignorado';
    item.erro = !lead ? 'Lead apagado' : lead.naoDisparar ? 'Pediu para não receber' : 'Na lista negra';
    item.em = agora();
    salvar();
    return agendar(d, 500);
  }

  // 🛡️ não repete: a pessoa (ou a mesma empresa com outro número) recebeu outro disparo
  // depois que este foi criado — ex.: duas listas com o mesmo contato disparando juntas
  if (d.filtro?.pularJaDisparados && require('./prospeccao').jaRecebeuDisparo(lead, d.id)) {
    item.status = 'ignorado';
    item.erro = 'Já recebeu outro disparo';
    item.em = agora();
    salvar();
    return agendar(d, 500);
  }

  // 🛡️ modo prospecção: limite do dia (com aquecimento) e só manda para quem tem WhatsApp
  const pros = d.prospeccao ? require('./prospeccao') : null;
  if (pros) {
    const limite = pros.limiteDeHoje(d);
    if (pros.enviadosHoje(d) >= limite) {
      if (!d.aguardandoAmanha) { d.aguardandoAmanha = true; d.proximoEnvioEm = null; salvar(); }
      return agendar(d, 30 * 60 * 1000); // confere de novo; amanhã continua sozinho
    }
    d.aguardandoAmanha = false;
    if (lead.temWhatsapp === false) {
      item.status = 'ignorado';
      item.erro = 'Número sem WhatsApp';
      item.em = agora();
      salvar();
      return agendar(d, 1500);
    }
    if (lead.temWhatsapp !== true) {
      const tem = await pros.temWhatsapp(empresa, item.destino);
      if (tem === false) {
        lead.temWhatsapp = false;
        item.status = 'ignorado';
        item.erro = 'Número sem WhatsApp';
        item.em = agora();
        salvar();
        return agendar(d, 3000 + Math.random() * 3000);
      }
      if (tem) {
        lead.temWhatsapp = true;
        if (typeof tem === 'string' && /@s\.whatsapp\.net$/.test(tem) && !lead.whatsappJid) { lead.whatsappJid = tem; item.destino = tem; }
      }
    }
  }

  // 🔁 versões da mensagem: cada contato recebe a sua (revezando), para ver qual faz mais gente responder
  const versao = d.versoes?.[item.versao] || null;
  const mensagem = montarMensagem(versao?.texto || d.mensagem, lead, empresa) + (d.rodapeSair ? `\n\n${RODAPE_SAIR}` : '');
  const anexos = midiasDoDisparo(empresa, d);
  const [primeira, ...resto] = anexos;
  // 🖼️ a 1ª foto com o nome do contato escrito (se não der, vai a foto normal)
  let personalizada = null;
  if (d.personalizar?.ativo && primeira?.tipo === 'image') {
    const frase = textoDaImagem(d.personalizar.texto, lead, empresa);
    if (frase) {
      personalizada = await require('./imagem-personalizada')
        .gerar(midias.caminhoDoArquivo(primeira), frase, d.personalizar)
        .catch((err) => {
          console.error(`[disparo ${d.id}] imagem personalizada:`, err.message);
          return null;
        });
    }
  }
  try {
    let r;
    if (personalizada) {
      r = await whatsapp.enviarArquivo(empresa, item.destino, { buffer: personalizada, mimetype: 'image/jpeg', nome: primeira.nome || 'imagem', legenda: mensagem });
    } else if (primeira && primeira.tipo !== 'audio') {
      // foto/vídeo/PDF com o texto como legenda: uma mensagem só
      r = await whatsapp.enviarMidia(empresa, item.destino, primeira, mensagem);
    } else {
      r = await whatsapp.enviarTexto(empresa, item.destino, mensagem);
      if (primeira) await whatsapp.enviarMidia(empresa, item.destino, primeira);
    }
    // as outras mídias vão em seguida (a mensagem já saiu: falha aqui não pausa o disparo)
    const falharam = [];
    for (const m of resto) {
      await new Promise((ok) => setTimeout(ok, 1200));
      await whatsapp.enviarMidia(empresa, item.destino, m).catch(() => falharam.push(m.nome));
    }
    if (falharam.length) item.erro = `Não foram: ${falharam.join(', ')}`.slice(0, 200);
    // o WhatsApp devolve o JID de verdade (ex.: sem o 9 extra em números antigos)
    const jidReal = r?.key?.remoteJid;
    if (!lead.whatsappJid && /@s\.whatsapp\.net$/.test(jidReal || '')) lead.whatsappJid = jidReal;
    item.status = 'enviado';
    item.em = agora();
    leads.adicionarMensagem(lead, {
      papel: 'equipe',
      canal: 'whatsapp',
      texto: anexos.length ? `${mensagem}\n[mídia: ${anexos.map((m, i) => (i === 0 && personalizada ? `${m.nome} (com o nome do contato)` : m.nome)).join(', ')}]` : mensagem,
      disparoId: d.id,
      ...(versao ? { disparoVersao: item.versao } : {})
    });
    lead.ultimoDisparoEm = agora();
    if (pros) { pros.contarEnvio(d); d.errosSeguidos = 0; }
  } catch (err) {
    // queda de conexão / servidor fora: pausa sem gastar a fila
    if (!err.status || err.status >= 500 || /connection closed|not connected|disconnected/i.test(err.message)) {
      return pausarPorErro(d, `Pausado: ${err.message}`);
    }
    item.status = 'erro';
    item.erro = /exists|not.*whatsapp|jid/i.test(err.message) ? 'Número sem WhatsApp' : err.message.slice(0, 200);
    item.em = agora();
    // 🛡️ freio: vários envios seguidos falhando é sinal de que o WhatsApp está barrando o número
    if (pros && item.erro !== 'Número sem WhatsApp') {
      d.errosSeguidos = (d.errosSeguidos || 0) + 1;
      if (d.errosSeguidos >= (d.prospeccaoCfg?.freioErros || 3)) {
        d.errosSeguidos = 0;
        require('./alertas').registrar(empresa, `disparo:${d.id}`, `🛡️ Disparo "${d.nome}" pausado pelo freio de segurança: ${d.prospeccaoCfg?.freioErros || 3} envios seguidos falharam. Espere algumas horas antes de continuar.`, { nivel: 'erro' });
        return pausarPorErro(d, `Freio de segurança: ${d.prospeccaoCfg?.freioErros || 3} envios seguidos falharam (último: ${item.erro}). Isso pode ser o WhatsApp barrando o número — espere algumas horas antes de continuar.`);
      }
    }
  }
  const espera = sorteioIntervalo(d);
  d.proximoEnvioEm = new Date(Date.now() + espera).toISOString();
  salvar();
  agendar(d, espera);
}

// Mídias que vão em cada mensagem (álbum vira as fotos dele), na ordem escolhida
const MAX_MIDIAS = 5;
function midiasDoDisparo(empresa, d) {
  const ids = d.midiaIds || (d.midiaId ? [d.midiaId] : []);
  const todas = midias.midiasDa(empresa);
  const saida = [];
  for (const id of ids) {
    const m = todas.find((x) => x.id === id);
    if (m) saida.push(m);
    else if (midias.albunsDa(empresa).some((a) => a.id === id)) saida.push(...todas.filter((x) => x.albumId === id).slice(0, 10));
  }
  // mídia que o dono desligou ("não está pronta") não vai nem no disparo já marcado
  return [...new Set(saida)].filter((m) => !m.processando && !midias.desligadaPeloDono(m)).slice(0, 20);
}

// ---------------------------------------------------------------- operações

function criar(empresa, corpo, usuario) {
  const versoes = versoesDoCorpo(empresa, corpo);
  if (!versoes.length) throw erro('Escreva a mensagem.');
  const mensagem = versoes[0].texto;
  if (!whatsapp.configurado(empresa)) throw erro('Conecte o WhatsApp da empresa antes de fazer disparos.');
  // várias mídias e álbuns (ids da biblioteca); "midiaId" é o formato antigo, de uma só
  const pedidos = [...new Set([...(Array.isArray(corpo.midiaIds) ? corpo.midiaIds : []), corpo.midiaId].map((x) => texto(x, 60)).filter(Boolean))].slice(0, MAX_MIDIAS);
  for (const mid of pedidos) {
    if (!midias.midiasDa(empresa).some((m) => m.id === mid) && !midias.albunsDa(empresa).some((a) => a.id === mid)) throw erro('Mídia não encontrada. Atualize a página e escolha de novo.');
  }
  const personalizar = normalizarPersonalizar(corpo.personalizar);
  if (personalizar) {
    const [primeira] = midiasDoDisparo(empresa, { midiaIds: pedidos });
    if (primeira?.tipo !== 'image') throw erro('Para escrever o nome do contato na imagem, a 1ª mídia do disparo precisa ser uma foto.');
  }
  const prospeccao = corpo.prospeccao === true;
  // prospecção: nunca manda de novo para quem já recebeu disparo em massa
  const { filtro, destinatarios, jaDisparados } = destinatariosPara(empresa, prospeccao ? { ...(corpo.filtro || {}), pularJaDisparados: true } : corpo.filtro);
  if (!destinatarios.length) throw erro(jaDisparados && filtro.pularJaDisparados ? 'Todos desse filtro já receberam disparo em massa. Desmarque "Não mandar para quem já recebeu" para mandar de novo.' : 'Nenhum lead com WhatsApp nesse filtro.');
  if (destinatarios.length > maxDestinatarios(prospeccao)) throw erro(`Esse disparo tem ${destinatarios.length} contatos e o máximo é ${maxDestinatarios(prospeccao)} por disparo. Divida a lista (ex.: filtre por cidade ou etiqueta) e faça mais de um disparo.`);
  const cfgPros = prospeccao ? require('./prospeccao').configDa(empresa) : null;
  // prospecção: os números da aba Segurança (dá para mudar neste disparo)
  const prosCfg = prospeccao ? require('./prospeccao').configDa({ prospeccao: { ...cfgPros, ...Object.fromEntries(['limiteInicial', 'aumentoDia', 'tetoDia'].filter((k) => corpo[k] !== undefined && corpo[k] !== '').map((k) => [k, corpo[k]])) } }) : null;
  const minBase = prospeccao ? require('./prospeccao').INTERVALO_MINIMO_PROSPECCAO : INTERVALO_MINIMO;
  const min = Math.max(minBase, Number(corpo.intervaloMin) || (prospeccao ? cfgPros.intervaloMin : 20));
  const max = Math.max(min, Number(corpo.intervaloMax) || (prospeccao ? cfgPros.intervaloMax : 60));
  let agendadoPara = null;
  if (corpo.agendadoPara) {
    const t = new Date(corpo.agendadoPara);
    if (Number.isNaN(t.getTime())) throw erro('Data de agendamento inválida.');
    if (t.getTime() > Date.now() + 60 * 1000) agendadoPara = t.toISOString();
  }
  for (const v of versoes) v.msgId = guardarMensagem(empresa, v.texto).id;
  const d = {
    id: novoId('dsp'),
    empresaId: empresa.id,
    nome: texto(corpo.nome, 100) || `Disparo de ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
    mensagem,
    midiaIds: pedidos,
    filtro,
    intervaloMin: Math.min(min, INTERVALO_MAXIMO),
    intervaloMax: Math.min(max, INTERVALO_MAXIMO),
    ...(prospeccao ? { prospeccao: true, prospeccaoCfg: prosCfg, enviadosPorDia: {}, errosSeguidos: 0 } : {}),
    horarioComercial: corpo.horarioComercial !== false,
    rodapeSair: corpo.rodapeSair !== false,
    ...extrasDoDisparo(empresa, corpo, personalizar),
    ...(campanhasDa(empresa).some((c) => c.id === corpo.campanhaId) ? { campanhaId: corpo.campanhaId } : {}),
    status: agendadoPara ? 'agendado' : 'enviando',
    agendadoPara,
    versoes,
    // revezando: 1º contato a versão A, 2º a B… (cada versão vai para a mesma quantidade de gente)
    destinatarios: destinatarios.map((x, i) => ({ ...x, status: 'pendente', erro: '', em: null, versao: i % versoes.length })),
    criadoPor: usuario?.email || '',
    criadoEm: agora(),
    iniciadoEm: agendadoPara ? null : agora(),
    concluidoEm: null
  };
  estado.disparos.push(d);
  // guarda só os 200 mais recentes por empresa
  const daEmpresa = estado.disparos.filter((x) => x.empresaId === empresa.id);
  if (daEmpresa.length > 200) {
    const antigos = new Set(daEmpresa.slice(0, daEmpresa.length - 200).filter((x) => !['enviando', 'agendado'].includes(x.status)).map((x) => x.id));
    estado.disparos = estado.disparos.filter((x) => !antigos.has(x.id));
  }
  salvar();
  agendar(d, agendadoPara ? new Date(agendadoPara).getTime() - Date.now() : 1000);
  return d;
}

// ---------------------------------------------------------------- 💬 mensagens salvas e versões

const MAX_VERSOES = 10;
const MAX_MENSAGENS_SALVAS = 100;
const textoIgual = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

function mensagensDa(empresa) {
  if (!Array.isArray(empresa.mensagensDisparo)) empresa.mensagensDisparo = [];
  return empresa.mensagensDisparo;
}

// guarda a mensagem na biblioteca (ou acha a igual que já existe) e devolve o id
// mensagens que valem (as "versões antigas", trocadas por uma edição, ficam só para o histórico)
const ativas = (empresa) => mensagensDa(empresa).filter((m) => !m.substituidaPor);

// a mensagem já saiu em algum disparo de verdade? (então o texto dela não muda mais: o ranking é dela)
function jaEnviada(empresa, m) {
  return estado.disparos.some((d) => d.empresaId === empresa.id && !d.teste && (d.versoes || []).some((v, i) => (v.msgId === m.id || (!v.msgId && textoIgual(v.texto, m.texto))) && (d.destinatarios || []).some((x) => x.status === 'enviado' && (x.versao || 0) === i)));
}

// campanhas que usam cada mensagem (pelo id; campanha antiga sem id: pelo texto)
function usoNasCampanhas(empresa) {
  const uso = new Map();
  for (const c of campanhasDa(empresa)) {
    const vs = c.versoes?.length ? c.versoes : (c.mensagens || []).map((t) => ({ texto: t }));
    for (const v of vs) {
      const m = (v.msgId && mensagensDa(empresa).find((x) => x.id === v.msgId)) || ativas(empresa).find((x) => textoIgual(x.texto, v.texto));
      if (!m) continue;
      const lista = uso.get(m.id) || [];
      if (!lista.some((x) => x.id === c.id)) lista.push({ id: c.id, nome: c.nome });
      uso.set(m.id, lista);
    }
  }
  return uso;
}

// guarda a mensagem na biblioteca (ou acha a igual que já existe) e devolve ela
function guardarMensagem(empresa, textoMsg, nome = '') {
  const lista = mensagensDa(empresa);
  const igual = ativas(empresa).find((m) => textoIgual(m.texto, textoMsg)) || lista.find((m) => textoIgual(m.texto, textoMsg));
  if (igual) return igual;
  const m = { id: novoId('msd'), nome: texto(nome, 60), texto: texto(textoMsg, 3000), criadoEm: agora() };
  lista.push(m);
  // passou do limite: sai a mais antiga que não está em campanha nem foi enviada
  if (lista.length > MAX_MENSAGENS_SALVAS) {
    const uso = usoNasCampanhas(empresa);
    const fora = lista.find((x) => x !== m && !uso.has(x.id) && !jaEnviada(empresa, x));
    if (fora) lista.splice(lista.indexOf(fora), 1);
  }
  return m;
}

// Muda o texto de uma mensagem da biblioteca. Se ela ainda não saiu em disparo, muda ela mesma;
// se já saiu, nasce uma versão nova e a antiga vira "versão antiga" (o ranking dela continua certo).
// Se já existe outra mensagem com o mesmo texto, usa aquela (nada de duplicada).
function mudarTexto(empresa, m, t) {
  if (textoIgual(m.texto, t)) return m;
  const outra = ativas(empresa).find((x) => x !== m && textoIgual(x.texto, t));
  if (outra) return outra;
  if (!jaEnviada(empresa, m)) {
    m.texto = texto(t, 3000);
    m.atualizadoEm = agora();
    return m;
  }
  const nova = { id: novoId('msd'), nome: m.nome || '', texto: texto(t, 3000), criadoEm: agora(), anteriorId: m.id };
  m.substituidaPor = nova.id;
  mensagensDa(empresa).push(nova);
  return nova;
}

// a mensagem mudou de id (versão nova): as campanhas que usavam a antiga passam a usar a nova
function trocarNasCampanhas(empresa, deId, para) {
  for (const c of campanhasDa(empresa)) {
    let mudou = false;
    c.versoes = (c.versoes?.length ? c.versoes : (c.mensagens || []).map((t) => ({ texto: t }))).map((v) => {
      const eDela = v.msgId ? v.msgId === deId : textoIgual(v.texto, mensagensDa(empresa).find((x) => x.id === deId)?.texto);
      if (!eDela) return v;
      mudou = true;
      return { texto: para.texto, msgId: para.id };
    });
    if (mudou) c.mensagens = c.versoes.map((v) => v.texto);
  }
}

// o texto da mensagem mudou (mesmo id): todas as campanhas que usam ela ficam com o texto novo
function sincronizarTexto(empresa, m) {
  for (const c of campanhasDa(empresa)) {
    if (!c.versoes?.some((v) => v.msgId === m.id && v.texto !== m.texto)) continue;
    c.versoes = c.versoes.map((v) => (v.msgId === m.id ? { ...v, texto: m.texto } : v));
    c.mensagens = c.versoes.map((v) => v.texto);
  }
}

// junta mensagens com o MESMO texto (duplicadas de antes): fica a mais antiga e os disparos e
// campanhas passam a apontar para ela — os números somam, nada se perde
function juntarDuplicadas(empresa) {
  const lista = mensagensDa(empresa);
  let mudou = false;
  for (let i = 0; i < lista.length; i++) {
    for (let j = lista.length - 1; j > i; j--) {
      const a = lista[i];
      const b = lista[j];
      if (!textoIgual(a.texto, b.texto)) continue;
      for (const d of estado.disparos) if (d.empresaId === empresa.id) for (const v of d.versoes || []) if (v.msgId === b.id) v.msgId = a.id;
      for (const c of campanhasDa(empresa)) for (const v of c.versoes || []) if (v.msgId === b.id) v.msgId = a.id;
      for (const x of lista) if (x.substituidaPor === b.id) x.substituidaPor = a.id;
      if (!a.nome && b.nome) a.nome = b.nome;
      if (a.substituidaPor && !b.substituidaPor) delete a.substituidaPor;
      lista.splice(j, 1);
      mudou = true;
    }
  }
  if (mudou) salvar();
  return mudou;
}

// versões que vieram da tela (até 10); "mensagem" sozinha = uma versão. Aceita [{ texto, msgId }]
// (da campanha) para o disparo apontar para a mesma mensagem da biblioteca.
function versoesDoCorpo(empresa, corpo) {
  const brutas = Array.isArray(corpo.versoes) && corpo.versoes.length ? corpo.versoes : Array.isArray(corpo.mensagens) && corpo.mensagens.length ? corpo.mensagens : [corpo.mensagem];
  const saida = [];
  for (const b of brutas) {
    const t = texto(typeof b === 'string' ? b : b?.texto, 3000);
    if (!t || saida.some((v) => textoIgual(v.texto, t))) continue;
    const m = typeof b === 'object' && b?.msgId ? mensagensDa(empresa).find((x) => x.id === b.msgId && textoIgual(x.texto, t)) : null;
    saida.push(m ? { texto: t, msgId: m.id } : { texto: t });
    if (saida.length >= MAX_VERSOES) break;
  }
  return saida;
}

// números de cada versão de um disparo: quantos receberam e quantos responderam
function numerosPorVersao(d, leadPorId = null) {
  const versoes = d.versoes || [{ texto: d.mensagem }];
  const nums = versoes.map((v, i) => ({ letra: String.fromCharCode(65 + i), texto: v.texto, msgId: v.msgId || null, enviados: 0, responderam: 0 }));
  for (const x of d.destinatarios || []) {
    if (x.status !== 'enviado') continue;
    const n = nums[x.versao || 0] || nums[0];
    n.enviados++;
    const lead = leadPorId ? leadPorId.get(x.leadId) : estado.conversas.find((c) => c.id === x.leadId);
    if (lead?.mensagens?.some((m) => m.papel === 'visitante' && m.em > x.em)) n.responderam++;
  }
  return nums;
}

// biblioteca com o ranking (somando todos os disparos) e em quais campanhas cada uma está
function mensagensComNumeros(empresa) {
  juntarDuplicadas(empresa);
  const leadPorId = new Map(estado.conversas.filter((c) => c.empresaId === empresa.id).map((c) => [c.id, c]));
  const total = new Map();
  for (const d of estado.disparos.filter((x) => x.empresaId === empresa.id && !x.teste)) {
    for (const n of numerosPorVersao(d, leadPorId)) {
      const id = n.msgId || mensagensDa(empresa).find((m) => textoIgual(m.texto, n.texto))?.id;
      if (!id) continue;
      const t = total.get(id) || { enviados: 0, responderam: 0, disparos: 0 };
      t.enviados += n.enviados;
      t.responderam += n.responderam;
      if (n.enviados) t.disparos++;
      total.set(id, t);
    }
  }
  const uso = usoNasCampanhas(empresa);
  return mensagensDa(empresa).map((m) => ({ ...m, ...(total.get(m.id) || { enviados: 0, responderam: 0, disparos: 0 }), campanhas: uso.get(m.id) || [], antiga: Boolean(m.substituidaPor) }));
}

function salvarMensagem(empresa, b = {}, msgId = null) {
  const t = texto(b.texto, 3000);
  if (!t) throw erro('Escreva a mensagem.');
  if (!msgId) {
    const m = guardarMensagem(empresa, t, b.nome);
    if (b.nome) m.nome = texto(b.nome, 60);
    salvar();
    return m;
  }
  const m = mensagensDa(empresa).find((x) => x.id === msgId);
  if (!m) throw erro('Mensagem não encontrada.', 404);
  const final = mudarTexto(empresa, m, t);
  if (final !== m) trocarNasCampanhas(empresa, m.id, final); // as campanhas acompanham a mensagem editada
  else sincronizarTexto(empresa, m);
  if (b.nome !== undefined) final.nome = texto(b.nome, 60);
  salvar();
  return final;
}

// apagar: sai da biblioteca e das campanhas que usavam (campanha não pode ficar sem mensagem)
function apagarMensagem(empresa, msgId) {
  const lista = mensagensDa(empresa);
  const m = lista.find((x) => x.id === msgId);
  if (!m) throw erro('Mensagem não encontrada.', 404);
  const usam = usoNasCampanhas(empresa).get(m.id) || [];
  for (const u of usam) {
    const c = campanhasDa(empresa).find((x) => x.id === u.id);
    const vs = (c.versoes?.length ? c.versoes : (c.mensagens || []).map((t) => ({ texto: t }))).filter((v) => !(v.msgId ? v.msgId === m.id : textoIgual(v.texto, m.texto)));
    if (!vs.length) throw erro(`Essa é a única mensagem da campanha "${c.nome}". Coloque outra mensagem nela antes de apagar esta.`);
  }
  for (const u of usam) {
    const c = campanhasDa(empresa).find((x) => x.id === u.id);
    c.versoes = (c.versoes?.length ? c.versoes : (c.mensagens || []).map((t) => ({ texto: t }))).filter((v) => !(v.msgId ? v.msgId === m.id : textoIgual(v.texto, m.texto)));
    c.mensagens = c.versoes.map((v) => v.texto);
  }
  lista.splice(lista.indexOf(m), 1);
  salvar();
}

// ---------------------------------------------------------------- 🧪 disparo de teste
// Manda a mensagem do disparo/campanha AGORA para um número escolhido (o seu), com o roteiro da
// IA, a foto com nome e a etapa ao responder valendo. Quando você responder do celular, a IA
// continua como faria com um cliente. Não entra no ranking nem nas contas da campanha.

const MAX_TESTES = 10; // guarda só os últimos testes de cada empresa

async function testar(empresa, corpo = {}, usuario = null) {
  const { numeroWhatsapp } = require('./util');
  const numero = numeroWhatsapp(corpo.numero);
  if (numero.length < 10) throw erro('Digite o número com DDD (ex.: 11 91234-5678).');
  if (!whatsapp.configurado(empresa)) throw erro('Conecte o WhatsApp da empresa antes de testar.');
  const versoes = versoesDoCorpo(empresa, corpo);
  if (!versoes.length) throw erro('Escreva a mensagem.');
  const versao = Math.min(versoes.length - 1, Math.max(0, Math.round(Number(corpo.versao) || 0)));
  const pros = require('./prospeccao');
  const principal = estado.bots.find((b) => b.empresaId === empresa.id && b.principal) || estado.bots.find((b) => b.empresaId === empresa.id);
  // número do WhatsApp de outra empresa sua no CRM: libera só este teste (2 h), nunca dos dois lados
  const ee = require('./entre-empresas');
  const outra = ee.empresaDoNumero(empresa, numero);
  if (outra && ee.testeAoContrario(empresa, outra)) throw erro(`Já tem um teste aberto da empresa "${outra.nome}" para o número desta. Espere 2 h ou teste com outro número (assim as duas IAs não conversam sozinhas).`);
  let lead = pros.indiceDosLeads(empresa).acharNumero(numero);
  if (!lead) lead = leads.criarLead({ empresa, bot: principal, canal: 'manual', nome: 'Teste do disparo', telefone: numero });
  // dados de exemplo para {empresa_contato}, {cidade} e {ramo} (sem mexer nos de um contato de verdade)
  if (!lead.prospeccao?.empresa) lead.prospeccao = { ...(lead.prospeccao || {}), empresa: lead.prospeccao?.empresa || 'Empresa Teste', cidade: lead.prospeccao?.cidade || 'Sua Cidade', ramo: lead.prospeccao?.ramo || 'seu ramo' };
  lead.testeDisparo = true;
  if (outra) lead.testeLiberadoAte = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  // o teste é para ver a IA responder: tira o "não disparar" e a pausa deste número
  delete lead.naoDisparar;
  if (lead.iaPausada) { lead.iaPausada = false; delete lead.iaPausadaMotivo; delete lead.iaPausadaEm; }
  if (lead.iaDesligadaPor === 'empresa') delete lead.iaDesligadaPor;
  const personalizar = normalizarPersonalizar(corpo.personalizar);
  const midiaIds = [...new Set((Array.isArray(corpo.midiaIds) ? corpo.midiaIds : []).map((x) => texto(x, 60)).filter(Boolean))].slice(0, MAX_MIDIAS);
  const { lembrete, ...extras } = extrasDoDisparo(empresa, corpo, personalizar); // lembrete fica de fora do teste
  for (const v of versoes) v.msgId = guardarMensagem(empresa, v.texto).id;
  const d = {
    id: novoId('dsp'),
    empresaId: empresa.id,
    nome: `🧪 Teste${corpo.nome ? ` · ${texto(corpo.nome, 80)}` : ''}`,
    teste: true,
    mensagem: versoes[0].texto,
    versoes,
    midiaIds,
    filtro: normalizarFiltro({ leadIds: [lead.id] }),
    intervaloMin: INTERVALO_MINIMO,
    intervaloMax: INTERVALO_MINIMO,
    horarioComercial: false,
    rodapeSair: corpo.rodapeSair !== false,
    ...extras,
    ...(campanhasDa(empresa).some((c) => c.id === corpo.campanhaId) ? { campanhaId: corpo.campanhaId } : {}),
    status: 'enviando',
    agendadoPara: null,
    destinatarios: [{ leadId: lead.id, nome: lead.nome || '', destino: whatsapp.destinoDoLead(lead) || numero, status: 'pendente', erro: '', em: null, versao }],
    criadoPor: usuario?.email || '',
    criadoEm: agora(),
    iniciadoEm: agora(),
    concluidoEm: null
  };
  estado.disparos.push(d);
  // só os últimos testes ficam guardados
  const testes = estado.disparos.filter((x) => x.empresaId === empresa.id && x.teste);
  if (testes.length > MAX_TESTES) {
    const fora = new Set(testes.slice(0, testes.length - MAX_TESTES).map((x) => x.id));
    estado.disparos = estado.disparos.filter((x) => !fora.has(x.id));
  }
  salvar();
  await processar(d.id);
  const item = d.destinatarios[0];
  const c = whatsapp.configDa(empresa);
  const avisos = [];
  if (outra) avisos.push(`Esse número é o WhatsApp da sua empresa "${outra.nome}" no CRM. Liberei a IA só para este teste, por 2 horas. Lá na "${outra.nome}" a IA continua sem responder esse número, para as duas não conversarem sozinhas.`);
  if (!c.iaAtiva) avisos.push('A IA do WhatsApp está DESLIGADA: ela não vai responder. Ligue em IA do WhatsApp.');
  if (!whatsapp.liberadoNoModoTeste(empresa, lead)) avisos.push('O modo teste da IA está ligado e este número não está na lista de teste: a IA não vai responder. Coloque o número na lista ou desligue o modo teste.');
  return { disparoId: d.id, leadId: lead.id, enviado: item.status === 'enviado', erro: item.erro || d.motivoPausa || '', numero, versao: String.fromCharCode(65 + versao), avisos };
}

// ---------------------------------------------------------------- 🎯 campanhas
// A campanha guarda tudo do disparo MENOS quem recebe: versões da mensagem, mídias, foto com o
// nome, roteiro da IA, etapa/etiqueta ao responder, lembrete e ritmo. Na hora de disparar só
// escolhe a lista (ou filtros), o nome e quando; o disparo leva campanhaId.

const CAMPOS_CAMPANHA = ['iaLigada', 'mensagens', 'versoes', 'midiaIds', 'personalizar', 'roteiro', 'aoResponder', 'lembrete', 'rodapeSair', 'horarioComercial', 'intervaloMin', 'intervaloMax', 'limiteInicial', 'aumentoDia', 'tetoDia', 'perfilEnvio'];

function campanhasDa(empresa) {
  if (!Array.isArray(empresa.campanhasDisparo)) empresa.campanhasDisparo = [];
  return empresa.campanhasDisparo;
}

function salvarCampanha(empresa, b = {}, campanhaId = null) {
  const nome = texto(b.nome, 80);
  if (!nome) throw erro('Dê um nome para a campanha.');
  // versões: { texto, msgId } — a campanha aponta para a mensagem da biblioteca (sem duplicar)
  const brutas = Array.isArray(b.versoes) && b.versoes.length ? b.versoes : (Array.isArray(b.mensagens) ? b.mensagens : []).map((t) => ({ texto: t }));
  const versoes = [];
  for (const v of brutas) {
    const t = texto(typeof v === 'string' ? v : v?.texto, 3000);
    if (!t) continue;
    const ligada = v?.msgId && mensagensDa(empresa).find((x) => x.id === v.msgId);
    const m = ligada ? mudarTexto(empresa, ligada, t) : guardarMensagem(empresa, t);
    if (ligada && m !== ligada) trocarNasCampanhas(empresa, ligada.id, m); // outras campanhas com a mesma mensagem acompanham
    else sincronizarTexto(empresa, m);
    if (!versoes.some((x) => x.msgId === m.id)) versoes.push({ texto: m.texto, msgId: m.id });
    if (versoes.length >= MAX_VERSOES) break;
  }
  if (!versoes.length) throw erro('Escreva pelo menos uma mensagem.');
  const mensagens = versoes.map((v) => v.texto);
  const n = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const dados = {
    nome,
    tipo: b.tipo === 'clientes' ? 'clientes' : 'prospeccao',
    mensagens,
    versoes,
    midiaIds: (Array.isArray(b.midiaIds) ? b.midiaIds : []).map((x) => texto(x, 60)).filter(Boolean).slice(0, MAX_MIDIAS),
    personalizar: normalizarPersonalizar(b.personalizar),
    ...extrasDoDisparo(empresa, b, null),
    rodapeSair: b.rodapeSair !== false,
    horarioComercial: b.horarioComercial !== false,
    intervaloMin: n(b.intervaloMin),
    intervaloMax: n(b.intervaloMax),
    limiteInicial: n(b.limiteInicial),
    aumentoDia: n(b.aumentoDia),
    tetoDia: n(b.tetoDia),
    perfilEnvio: texto(b.perfilEnvio, 30),
    iaLigada: b.iaLigada !== false,
    atualizadoEm: agora()
  };
  const lista = campanhasDa(empresa);
  let c = campanhaId ? lista.find((x) => x.id === campanhaId) : null;
  if (campanhaId && !c) throw erro('Campanha não encontrada.', 404);
  if (c) {
    for (const k of [...CAMPOS_CAMPANHA, 'nome', 'tipo']) delete c[k];
    Object.assign(c, dados);
  } else {
    c = { id: novoId('cmp'), criadoEm: agora(), ...dados };
    lista.push(c);
  }
  salvar();
  return c;
}

function apagarCampanha(empresa, campanhaId) {
  const lista = campanhasDa(empresa);
  const i = lista.findIndex((x) => x.id === campanhaId);
  if (i < 0) throw erro('Campanha não encontrada.', 404);
  lista.splice(i, 1);
  salvar();
}

// campanhas com o resultado de todos os disparos feitos com cada uma
function campanhasComNumeros(empresa) {
  const leadPorId = new Map(estado.conversas.filter((c) => c.empresaId === empresa.id).map((c) => [c.id, c]));
  return campanhasDa(empresa).map((c) => {
    const ds = estado.disparos.filter((d) => d.empresaId === empresa.id && d.campanhaId === c.id && !d.teste);
    let enviados = 0;
    let responderam = 0;
    for (const d of ds) for (const v of numerosPorVersao(d, leadPorId)) { enviados += v.enviados; responderam += v.responderam; }
    const ativos = ds.filter((d) => ['enviando', 'agendado', 'pausado'].includes(d.status)).length;
    return { ...c, disparos: ds.length, ativos, enviados, responderam, ultimoDisparoEm: ds.map((d) => d.criadoEm).sort().pop() || null };
  });
}

// ---------------------------------------------------------------- roteiro, lembrete e imagem

const DIA = 24 * 60 * 60 * 1000;
const LEMBRETE_PADRAO = '{Oi|Olá}! Conseguiu ver minha mensagem? {😊|🙂}';
const TEXTO_IMAGEM_PADRAO = 'Feito para {empresa_contato}';

function normalizarPersonalizar(p) {
  if (!p || p.ativo !== true) return null;
  const hex = (v, def) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : def);
  return {
    ativo: true,
    texto: texto(p.texto, 120) || TEXTO_IMAGEM_PADRAO,
    posicao: require('./imagem-personalizada').POSICOES.includes(p.posicao) ? p.posicao : 'baixo',
    fundo: hex(p.fundo, '#111827'),
    destaque: hex(p.destaque, '#facc15')
  };
}

// roteiro da IA, etapa/etiqueta ao responder e lembrete (só guarda o que foi preenchido)
function extrasDoDisparo(empresa, corpo, personalizar) {
  const extras = {};
  const roteiro = texto(corpo.roteiro, 12000);
  if (roteiro) extras.roteiro = roteiro;
  const a = corpo.aoResponder || {};
  const etapa = a.etapa ? leads.acharEtapa(empresa, a.etapa) : null;
  const etiquetaId = leads.etiquetasDa(empresa).some((t) => t.id === a.etiquetaId) ? a.etiquetaId : '';
  if (etapa || etiquetaId) extras.aoResponder = { etapa: etapa || '', etiquetaId };
  const l = corpo.lembrete || {};
  if (l.ativo === true) extras.lembrete = { ativo: true, dias: Math.min(14, Math.max(1, Math.round(Number(l.dias) || 3))), mensagem: texto(l.mensagem, 1000) || LEMBRETE_PADRAO };
  if (personalizar) extras.personalizar = personalizar;
  return extras;
}

// texto da faixa da imagem; vazio = não personaliza (ex.: "{empresa_contato}" sem nome nenhum)
function textoDaImagem(modelo, lead, empresa) {
  const { nomeCurto } = require('./imagem-personalizada');
  const nomeDoContato = lead.prospeccao?.empresa || lead.nome || '';
  const curto = { ...lead, nome: nomeCurto(lead.nome || ''), prospeccao: { ...(lead.prospeccao || {}), empresa: nomeCurto(nomeDoContato) } };
  const usa = (v) => new RegExp(`\\{${v}\\}`, 'i').test(modelo);
  if ((usa('empresa_contato') || usa('nome') || usa('nome_completo')) && !montarMensagem('{nome_completo}{empresa_contato}', curto, empresa)) return '';
  return montarMensagem(modelo, curto, empresa);
}

// o disparo mais recente que o lead recebeu (vale por 30 dias)
function disparoDoLead(lead) {
  const m = [...(lead?.mensagens || [])].reverse().find((x) => x.disparoId);
  if (!m || Date.now() - new Date(m.em).getTime() > 30 * DIA) return null;
  return estado.disparos.find((x) => x.id === m.disparoId) || null;
}

// 🎯 o que a IA lê quando o cliente responde a um disparo: o roteiro e os dados da lista
// o prompt da campanha (lido na hora: editou a campanha, vale até para disparos já rodando)
function roteiroDo(d) {
  if (!d) return '';
  const empresa = estado.empresas.find((e) => e.id === d.empresaId);
  const c = d.campanhaId && empresa ? campanhasDa(empresa).find((x) => x.id === d.campanhaId) : null;
  return String((c ? c.roteiro : d.roteiro) || '').trim();
}

// 🎯 Conversa que veio de campanha com prompt: a IA obedece SÓ ao prompt da campanha (nada do
// prompt principal, do "Sobre a empresa", catálogo, clone ou aprendizados). Sem prompt na
// campanha: atende como sempre, com os dados do contato.
function contextoDeCampanha(lead) {
  const d = disparoDoLead(lead);
  const roteiro = roteiroDo(d);
  return roteiro ? { roteiroCampanha: roteiro, disparo: paraIa(lead, { semRoteiro: true }) } : { disparo: paraIa(lead) };
}

function paraIa(lead, { semRoteiro = false } = {}) {
  const d = disparoDoLead(lead);
  if (!d) return '';
  const roteiro = semRoteiro ? '' : roteiroDo(d);
  const p = lead.prospeccao || {};
  const dados = [
    p.empresa && `empresa: ${p.empresa}`,
    p.ramo && `ramo: ${p.ramo}`,
    (p.cidade || p.estado) && `cidade: ${[p.cidade, p.estado].filter(Boolean).join(' - ')}`,
    p.nota && `nota no Google: ${p.nota}${p.avaliacoes ? ` (${p.avaliacoes} avaliações)` : ''}`,
    p.temSite && `tem site: ${p.temSite === 'sim' ? 'sim' : 'não'}`,
    p.site && `site: ${p.site}`
  ].filter(Boolean);
  if (!roteiro && !dados.length && !semRoteiro) return '';
  return [
    `Este cliente respondeu a um disparo em massa ("${d.nome}"). A mensagem do disparo está no começo da conversa.`,
    ...(dados.length ? [`Dados do contato (da lista importada, use com naturalidade, sem dizer de onde tirou): ${dados.join('; ')}.`] : []),
    ...(roteiro ? ['Roteiro do dono para quem responde a este disparo (siga para conduzir a conversa):', '<roteiro_do_disparo>', roteiro, '</roteiro_do_disparo>'] : [])
  ].join('\n');
}

// cliente respondeu a um disparo: vai para a etapa/etiqueta escolhida (uma vez por disparo)
function aoResponder(empresa, lead) {
  const d = disparoDoLead(lead);
  if (!d?.aoResponder) return false;
  lead.respondeuDisparos = lead.respondeuDisparos || [];
  if (lead.respondeuDisparos.includes(d.id)) return false;
  lead.respondeuDisparos.push(d.id);
  if (d.aoResponder.etapa) leads.moverEtapa(lead, empresa, d.aoResponder.etapa, 'sistema');
  const tag = d.aoResponder.etiquetaId;
  if (tag && leads.etiquetasDa(empresa).some((t) => t.id === tag) && !(lead.etiquetas || []).includes(tag)) lead.etiquetas = [...(lead.etiquetas || []), tag];
  return true;
}

// 🎯 IA desligada na campanha (botão de emergência): vale para quem veio dos disparos dela,
// inclusive os que já estão rodando (lê a campanha na hora, não a cópia do disparo)
function iaDesligadaPelaCampanha(empresa, lead) {
  const d = disparoDoLead(lead);
  if (!d?.campanhaId) return '';
  const c = campanhasDa(empresa).find((x) => x.id === d.campanhaId);
  return c && c.iaLigada === false ? `A IA está desligada na campanha "${c.nome}": a equipe atende (ligue de novo em Campanhas).` : '';
}

function ligarIaDaCampanha(empresa, campanhaId, ligada) {
  const c = campanhasDa(empresa).find((x) => x.id === campanhaId);
  if (!c) throw erro('Campanha não encontrada.', 404);
  c.iaLigada = ligada !== false;
  salvar();
  return c;
}

// 🛡️ O cliente respondeu a um disparo (a última mensagem da empresa antes da resposta é do
// disparo ou do lembrete): a IA atende. Pausa que veio ANTES do disparo (a equipe tinha falado à
// mão, ou o cliente já tinha comprado/agendado) não vale mais — o disparo reabriu a conversa.
// Pausa DEPOIS do disparo (cliente pediu uma pessoa, a IA chamou a equipe, a equipe respondeu)
// continua valendo. Lista negra e "SAIR" nunca são liberados.
function liberarIaAoResponder(empresa, lead) {
  if (!lead || lead.listaNegra || lead.naoDisparar) return false;
  const msgs = lead.mensagens || [];
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].papel === 'visitante') i--;
  const ultima = msgs[i];
  if (!ultima?.disparoId || Date.now() - new Date(ultima.em).getTime() > 30 * DIA) return false;
  let liberou = false;
  const antiga = lead.iaPausadaEm ? lead.iaPausadaEm <= ultima.em : /^A equipe respondeu|^Cliente de cobrança/.test(lead.iaPausadaMotivo || '');
  if (lead.iaPausada && !lead.iaDesligadaPor && antiga) {
    lead.iaPausada = false;
    lead.precisaHumano = false;
    delete lead.iaPausadaMotivo;
    delete lead.iaPausadaEm;
    liberou = true;
  }
  // comprou/agendou antes do disparo: atende de novo (vale até uma venda nova)
  const iaD = require('./ia-desligada');
  const m = iaD.motivo(empresa, lead);
  if (m && ['venda', 'agenda'].includes(m.por) && lead.iaDesligadaEm && lead.iaDesligadaEm <= ultima.em) {
    iaD.ligadaAMao(lead);
    lead.iaPausada = false;
    delete lead.iaPausadaMotivo;
    delete lead.iaPausadaEm;
    liberou = true;
  }
  if (liberou) console.log(`[disparo ${ultima.disparoId}] cliente respondeu ao disparo: IA liberada na conversa ${lead.id}`);
  return liberou;
}

// 🔔 lembrete: quem recebeu e não respondeu nada em X dias ganha UMA mensagem curta
function situacaoDoLembrete(d, x, lead, agoraMs) {
  if (x.status !== 'enviado' || x.lembrete || !x.em) return null;
  const desde = new Date(x.em).getTime();
  if (agoraMs - desde < d.lembrete.dias * DIA) return null; // ainda não é hora
  if (agoraMs - desde > (d.lembrete.dias + 5) * DIA) return 'vencido'; // CRM ficou parado: não manda tão tarde
  if (!lead || lead.naoDisparar || leads.naListaNegra(null, lead)) return 'pulado';
  const depois = (lead.mensagens || []).filter((m) => m.em > x.em);
  if (depois.some((m) => m.papel === 'visitante')) return 'respondeu';
  // alguém já falou com ele por outro caminho (equipe, IA, outro disparo): não insiste
  if (depois.some((m) => m.papel !== 'visitante' && m.disparoId !== d.id)) return 'pulado';
  return 'enviar';
}

let lembretesRodando = false;
async function rodarLembretes() {
  if (lembretesRodando) return;
  lembretesRodando = true;
  try {
    for (const d of estado.disparos || []) {
      if (!d.lembrete?.ativo || !['enviando', 'concluido'].includes(d.status)) continue;
      if (d.proximoLembreteEm && Date.now() < new Date(d.proximoLembreteEm).getTime()) continue;
      await lembreteDaVez(d).catch((err) => console.error(`[disparo ${d.id}] lembrete:`, err.message));
    }
  } finally {
    lembretesRodando = false;
  }
}

async function lembreteDaVez(d) {
  const empresa = estado.empresas.find((e) => e.id === d.empresaId);
  if (!empresa || !whatsapp.configurado(empresa) || !dentroDoHorario(d)) return;
  const pros = d.prospeccao ? require('./prospeccao') : null;
  if (pros && pros.enviadosHoje(d) >= pros.limiteDeHoje(d)) return; // o lembrete conta no limite do dia
  const agoraMs = Date.now();
  let mudou = false;
  let vez = null;
  for (const x of d.destinatarios) {
    const lead = x.status === 'enviado' && !x.lembrete ? estado.conversas.find((c) => c.id === x.leadId) : null;
    const s = situacaoDoLembrete(d, x, lead, agoraMs);
    if (!s) continue;
    if (s === 'enviar') { vez = { x, lead }; break; }
    x.lembrete = s;
    mudou = true;
  }
  if (!vez) {
    if (mudou) salvar();
    return;
  }
  const { x, lead } = vez;
  const mensagem = montarMensagem(d.lembrete.mensagem, lead, empresa);
  try {
    await whatsapp.enviarTexto(empresa, x.destino, mensagem);
    x.lembrete = 'enviado';
    x.lembreteEm = agora();
    leads.adicionarMensagem(lead, { papel: 'equipe', canal: 'whatsapp', texto: mensagem, disparoId: d.id, lembreteDisparo: true });
    if (pros) pros.contarEnvio(d);
    d.proximoLembreteEm = new Date(Date.now() + sorteioIntervalo(d)).toISOString();
  } catch (err) {
    if (!err.status || err.status >= 500 || /connection closed|not connected|disconnected/i.test(err.message)) {
      d.proximoLembreteEm = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // conexão caiu: tenta depois
    } else {
      x.lembrete = 'erro';
      x.lembreteErro = err.message.slice(0, 200);
    }
  }
  salvar();
}

function pausar(d) {
  if (!['enviando', 'agendado'].includes(d.status)) throw erro('Este disparo não está em andamento.');
  clearTimeout(timers.get(d.id));
  timers.delete(d.id);
  d.status = 'pausado';
  d.motivoPausa = 'Pausado pela equipe';
  d.proximoEnvioEm = null;
  salvar();
}

function retomar(d) {
  if (d.status !== 'pausado') throw erro('Este disparo não está pausado.');
  d.status = 'enviando';
  d.motivoPausa = '';
  d.iniciadoEm = d.iniciadoEm || agora();
  salvar();
  agendar(d, 1000);
}

function cancelar(d) {
  if (['concluido', 'cancelado'].includes(d.status)) throw erro('Este disparo já terminou.');
  clearTimeout(timers.get(d.id));
  timers.delete(d.id);
  d.status = 'cancelado';
  d.concluidoEm = agora();
  d.proximoEnvioEm = null;
  for (const x of d.destinatarios) if (x.status === 'pendente') x.status = 'cancelado';
  salvar();
}

// apagar um disparo agendado/enviando: para antes (quem não recebeu não recebe mais)
function apagar(d) {
  clearTimeout(timers.get(d.id));
  timers.delete(d.id);
  d.status = 'cancelado';
  estado.disparos = estado.disparos.filter((x) => x.id !== d.id);
  salvar();
}

function apagarTodosDa(empresaId) {
  for (const d of estado.disparos.filter((x) => x.empresaId === empresaId)) {
    clearTimeout(timers.get(d.id));
    timers.delete(d.id);
  }
  estado.disparos = estado.disparos.filter((x) => x.empresaId !== empresaId);
}

// Números do disparo para o painel (inclui quantos responderam depois)
function resumo(d) {
  const cont = { pendente: 0, enviado: 0, erro: 0, ignorado: 0, cancelado: 0 };
  let responderam = 0;
  let lembretes = 0;
  let responderamLembrete = 0;
  for (const x of d.destinatarios) {
    if (x.lembrete === 'enviado') {
      lembretes++;
      const lead = estado.conversas.find((c) => c.id === x.leadId);
      if (lead?.mensagens.some((m) => m.papel === 'visitante' && m.em > x.lembreteEm)) responderamLembrete++;
    }
    cont[x.status] = (cont[x.status] || 0) + 1;
    if (x.status === 'enviado') {
      const lead = estado.conversas.find((c) => c.id === x.leadId);
      if (lead?.mensagens.some((m) => m.papel === 'visitante' && m.em > x.em)) responderam++;
    }
  }
  const { destinatarios, ...resto } = d;
  const porVersao = (d.versoes || []).length > 1 ? numerosPorVersao(d) : null;
  const semWhatsapp = destinatarios.filter((x) => x.erro === 'Número sem WhatsApp').length;
  const pros = d.prospeccao ? require('./prospeccao') : null;
  return { ...resto, total: destinatarios.length, ...cont, responderam, semWhatsapp, ...(porVersao ? { porVersao } : {}), ...(d.lembrete ? { lembretes, responderamLembrete } : {}), ...(pros ? { hoje: pros.enviadosHoje(d), limiteHoje: pros.limiteDeHoje(d) } : {}) };
}

// Ao subir o app: continua os disparos que estavam em andamento
let relogioLembretes = null;
function retomarAoIniciar() {
  if (!relogioLembretes) {
    relogioLembretes = setInterval(() => rodarLembretes().catch(() => 0), 60 * 1000);
    relogioLembretes.unref?.();
  }
  for (const d of estado.disparos || []) {
    if (d.status === 'enviando') agendar(d, 5000);
    if (d.status === 'agendado') agendar(d, new Date(d.agendadoPara).getTime() - Date.now());
  }
}

module.exports = {
  RODAPE_SAIR,
  maxDestinatarios,
  INTERVALO_MAXIMO,
  horaEmSaoPaulo,
  HORA_INICIO,
  HORA_FIM,
  destinatariosPara,
  montarMensagem,
  criar,
  pausar,
  retomar,
  cancelar,
  apagar,
  apagarTodosDa,
  resumo,
  retomarAoIniciar,
  paraIa,
  contextoDeCampanha,
  aoResponder,
  liberarIaAoResponder,
  iaDesligadaPelaCampanha,
  ligarIaDaCampanha,
  MAX_VERSOES,
  testar,
  campanhasDa,
  campanhasComNumeros,
  salvarCampanha,
  apagarCampanha,
  mensagensComNumeros,
  salvarMensagem,
  apagarMensagem,
  LEMBRETE_PADRAO,
  TEXTO_IMAGEM_PADRAO,
  textoDaImagem,
  normalizarPersonalizar,
  rodarLembretes, // (testes)
  processar // (testes)
};
