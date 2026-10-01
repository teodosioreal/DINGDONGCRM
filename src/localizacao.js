// localizacao.js — de onde o cliente é, LIDO NA CONVERSA (nunca pelo DDD).
//
// 1) O CRM lê as mensagens do cliente, sem IA e sem custo: "sou de Petrópolis",
//    "moro em Itaipava", "aqui em Niterói", "tô no Quitandinha", "bairro Centro"…
//    Cidades conhecidas (todo o RJ, distritos de Petrópolis, capitais e cidades
//    grandes) saem com o nome certo e a UF.
// 2) A IA também marca [[LOCAL: …]] quando o cliente diz onde está.
// 3) A equipe pode corrigir à mão no perfil do lead (vale mais que tudo).
// Aparece como etiqueta 📍 na conversa, no funil e no perfil do lead.

const { salvar, agora } = require('./db');

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Cidades e lugares conhecidos → como mostrar
const RJ = 'Angra dos Reis|Aperibé|Araruama|Areal|Armação dos Búzios|Búzios|Arraial do Cabo|Barra do Piraí|Barra Mansa|Belford Roxo|Bom Jardim|Bom Jesus do Itabapoana|Cabo Frio|Cachoeiras de Macacu|Cambuci|Campos dos Goytacazes|Cantagalo|Carapebus|Cardoso Moreira|Carmo|Casimiro de Abreu|Comendador Levy Gasparian|Conceição de Macabu|Cordeiro|Duas Barras|Duque de Caxias|Engenheiro Paulo de Frontin|Guapimirim|Iguaba Grande|Itaboraí|Itaguaí|Italva|Itaocara|Itaperuna|Itatiaia|Japeri|Laje do Muriaé|Macaé|Macuco|Magé|Mangaratiba|Maricá|Mendes|Mesquita|Miguel Pereira|Miracema|Natividade|Nilópolis|Niterói|Nova Friburgo|Nova Iguaçu|Paracambi|Paraíba do Sul|Paraty|Paty do Alferes|Petrópolis|Pinheiral|Piraí|Porciúncula|Porto Real|Quatis|Queimados|Quissamã|Resende|Rio Bonito|Rio Claro|Rio das Flores|Rio das Ostras|Rio de Janeiro|Santa Maria Madalena|Santo Antônio de Pádua|São Fidélis|São Francisco de Itabapoana|São Gonçalo|São João da Barra|São João de Meriti|São José de Ubá|São José do Vale do Rio Preto|São Pedro da Aldeia|São Sebastião do Alto|Sapucaia|Saquarema|Seropédica|Silva Jardim|Sumidouro|Tanguá|Teresópolis|Trajano de Moraes|Três Rios|Valença|Varre-Sai|Vassouras|Volta Redonda'
  .split('|')
  .map((c) => [c, `${c} - RJ`]);
const PETROPOLIS = 'Itaipava|Corrêas|Correas|Araras|Nogueira|Pedro do Rio|Secretário|Cascatinha|Quitandinha|Valparaíso|Bingen|Mosela|Alto da Serra|Samambaia|Vale do Cuiabá|Fazenda Inglesa|Duarte da Silveira|Coronel Veiga|Bonfim'
  .split('|')
  .map((b) => [b, `${b === 'Correas' ? 'Corrêas' : b}, Petrópolis - RJ`]);
const OUTRAS = [
  ['São Paulo', 'São Paulo - SP'], ['Campinas', 'Campinas - SP'], ['Guarulhos', 'Guarulhos - SP'], ['Belo Horizonte', 'Belo Horizonte - MG'], ['BH', 'Belo Horizonte - MG'],
  ['Juiz de Fora', 'Juiz de Fora - MG'], ['Brasília', 'Brasília - DF'], ['Salvador', 'Salvador - BA'], ['Curitiba', 'Curitiba - PR'], ['Porto Alegre', 'Porto Alegre - RS'],
  ['Recife', 'Recife - PE'], ['Fortaleza', 'Fortaleza - CE'], ['Florianópolis', 'Florianópolis - SC'], ['Goiânia', 'Goiânia - GO'], ['Manaus', 'Manaus - AM'],
  ['Belém', 'Belém - PA'], ['São Luís', 'São Luís - MA'], ['Maceió', 'Maceió - AL'], ['Natal', 'Natal - RN'], ['João Pessoa', 'João Pessoa - PB'], ['Aracaju', 'Aracaju - SE'],
  ['Teresina', 'Teresina - PI'], ['Cuiabá', 'Cuiabá - MT'], ['Campo Grande', 'Campo Grande - MS'], ['Vila Velha', 'Vila Velha - ES'], ['Uberlândia', 'Uberlândia - MG'],
  ['Copacabana', 'Copacabana, Rio de Janeiro - RJ'], ['Barra da Tijuca', 'Barra da Tijuca, Rio de Janeiro - RJ'], ['Tijuca', 'Tijuca, Rio de Janeiro - RJ'],
  ['Icaraí', 'Icaraí, Niterói - RJ'], ['Rio', 'Rio de Janeiro - RJ']
];
const CONHECIDOS = [...PETROPOLIS, ...RJ, ...OUTRAS]
  .map(([nome, mostrar]) => ({ chave: sem(nome), mostrar }))
  .sort((a, b) => b.chave.length - a.chave.length); // o mais específico primeiro ("Rio das Ostras" antes de "Rio")

// Palavras que aparecem depois de "sou de", "estou em"… e NÃO são lugar
const NAO_LUGAR = new Set(
  'casa|trabalho|duvida|acordo|manha|tarde|noite|novo|nova|confianca|longe|perto|um|uma|o|a|os|as|isso|aqui|la|ai|viagem|ferias|horario|familia|fora|outra|outro|outro estado|cidade|interior|rua|onde|lugar|reuniao|consulta|atendimento|duvidas|boa|bom|pouco|tempo|pe|carro|loja|empresa|mercado|hospital|escola|faculdade|igreja|academia|praia|shopping|centro comercial|frente|cima|baixo|pressa|folga|ferias|licenca|dia|semana|mes|ano|hoje|amanha|vez|serie|minha|meu|sua|seu|tua|teu|nossa|nosso|que|qual|quem|como|ver|olhar|saber|saida|chegada|cliente|clientes|aguardo|espera|correria|onibus|metro|uber|caminho|estrada|ponto|fila|banho|almoco|janta|cama|servico|plantao|banco|medico|dentista|reuniao|aula|curso|obra|transito|engarrafamento|hospital|feira|evento|festa|igreja|culto|missa|treino|jogo|area|ramo|setor|duvida ainda|grupo|chamada|ligacao'.split('|')
);

const titulo = (t) =>
  String(t)
    .split(/\s+/)
    .map((p, i) => (i > 0 && /^(de|da|do|dos|das|e)$/i.test(p) ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join(' ');

function conhecido(trecho) {
  const t = ` ${sem(trecho).replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  return CONHECIDOS.find((c) => t.includes(` ${c.chave} `)) || null;
}

// Lê UMA mensagem do cliente e diz de onde ele é (ou null)
const GATILHOS = /\b(?:sou|somos|venho|vim)\s+(?:de|da|do|dos|das)\s+|\b(?:moro|moramos|resido|estou|to|tô|tou|estamos)\s+(?:em|no|na|nos|nas|aqui\s+em|aqui\s+no|aqui\s+na)\s+|\baqui\s+(?:em|no|na|de|do|da)\s+|\b(?:bairro|cidade\s+de|regi[aã]o\s+(?:de|da|do)|perto\s+(?:de|da|do))\s+|\bminha\s+cidade\s+(?:é|e)\s+/i;

function detectar(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ');
  if (!t || t.startsWith('[')) return null; // "[o cliente enviou uma foto]" etc.
  const g = t.match(GATILHOS);
  if (!g) return null;
  // o que vem depois do gatilho, até a pontuação ou palavra de ligação
  const resto = t.slice(g.index + g[0].length).split(/[,.;!?\n()]|\s(?:e|mas|só|so|que|pra|para|com|porque|pq|quero|queria|gostaria|vou|vocês|voces|vcs|vc|tem|tenho|ta|tá|está|esta|já|ja|ainda|hoje|amanhã|amanha)\s/i)[0].trim();
  if (!resto) return null;
  const achado = conhecido(resto);
  if (achado) return achado.mostrar;
  const palavras = resto.split(/\s+/).slice(0, 3);
  const limpo = palavras.join(' ').replace(/[^\p{L}\s'-]/gu, '').trim();
  if (!limpo || limpo.length < 3 || NAO_LUGAR.has(sem(limpo)) || NAO_LUGAR.has(sem(palavras[0]))) return null;
  // UF no fim ("petrópolis rj")
  const uf = limpo.match(/\s([a-z]{2})$/i);
  const nome = uf && /^(rj|sp|mg|es|pr|sc|rs|ba|df|go|pe|ce)$/i.test(uf[1]) ? `${titulo(limpo.slice(0, -3))} - ${uf[1].toUpperCase()}` : titulo(limpo);
  return nome.length <= 40 ? nome : null;
}

const limpar = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const FORCA = { equipe: 3, ia: 2, conversa: 1 };

// Guarda a localização; a equipe vale mais que a IA, que vale mais que a leitura automática
function definir(lead, texto, fonte) {
  const t = limpar(texto);
  if (!t) return false;
  const atual = lead.localizacao?.fonte === 'ddd' ? null : lead.localizacao;
  if (atual && (FORCA[atual.fonte] || 0) > (FORCA[fonte] || 0)) return false;
  if (atual?.texto === t && atual.fonte === fonte) return false;
  lead.localizacao = { texto: t, fonte, em: agora() };
  salvar();
  return true;
}

// Lê uma mensagem nova do cliente (chamado ao receber e ao recuperar histórico)
function lerMensagem(lead, texto) {
  // áudio transcrito também vale ("[áudio do cliente]: sou de petrópolis")
  const t = String(texto || '').replace(/^\[(?:áudio|foto) do cliente\]:\s*/i, '');
  const onde = detectar(t);
  return onde ? definir(lead, onde, 'conversa') : false;
}

// Lê a conversa inteira (do mais antigo ao mais novo: vale o que ele disse por último)
function lerConversa(lead) {
  let mudou = false;
  for (const m of lead.mensagens || []) if (m.papel === 'visitante' && !m.apagada && lerMensagem(lead, m.texto)) mudou = true;
  return mudou;
}

// Versões antigas punham a cidade pelo DDD: isso sai
function semDdd(lead) {
  if (lead.localizacao?.fonte === 'ddd') {
    delete lead.localizacao;
    return true;
  }
  return false;
}

function paraPainel(lead) {
  semDdd(lead);
  const l = lead.localizacao;
  if (!l?.texto) return null;
  const DE_ONDE = { conversa: 'o cliente disse na conversa', ia: 'a IA entendeu na conversa', equipe: 'informado pela equipe' };
  return { texto: l.texto, fonte: l.fonte, origem: DE_ONDE[l.fonte] || '' };
}

// Linha para o contexto da IA (ela não repete "de onde você é?" se já souber)
function paraIa(lead) {
  semDdd(lead);
  return lead.localizacao?.texto ? `- Localização do cliente (ele disse na conversa): ${lead.localizacao.texto}.` : '';
}

// compatibilidade: antes "garantir" punha pelo DDD; agora só limpa o antigo
function garantir(lead) {
  return semDdd(lead);
}

// Ao ligar: tira o DDD de todo mundo e lê as conversas que ainda não têm localização
function revisarTodas(estado) {
  let n = 0;
  for (const c of estado.conversas || []) {
    if (semDdd(c)) n++;
    if (!c.localizacao && lerConversa(c)) n++;
  }
  if (n) salvar();
  return n;
}

module.exports = { detectar, definir, lerMensagem, lerConversa, paraPainel, paraIa, garantir, revisarTodas };
