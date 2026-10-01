// localizacao.js — de onde o cliente é, para a equipe e a IA saberem.
//
// 1) Na hora (sem IA, sem custo): pelo DDD do WhatsApp do cliente.
//    Ex.: 5521… → "Rio de Janeiro - RJ". Número de fora do Brasil → o país.
// 2) Mais preciso: quando o cliente diz onde está ("sou de Niterói", "moro no
//    Quitandinha"), a IA marca [[LOCAL: Niterói - RJ]] e isso substitui o DDD.
// 3) A equipe também pode corrigir à mão no perfil do lead.
// Aparece como etiqueta 📍 na conversa, no funil e no perfil do lead.

const { salvar, agora } = require('./db');

// DDD → cidade principal / região e UF
const DDD = {
  11: 'São Paulo - SP', 12: 'São José dos Campos - SP', 13: 'Santos - SP', 14: 'Bauru - SP', 15: 'Sorocaba - SP',
  16: 'Ribeirão Preto - SP', 17: 'São José do Rio Preto - SP', 18: 'Presidente Prudente - SP', 19: 'Campinas - SP',
  21: 'Rio de Janeiro - RJ', 22: 'Campos dos Goytacazes - RJ', 24: 'Petrópolis / Volta Redonda - RJ',
  27: 'Vitória - ES', 28: 'Cachoeiro de Itapemirim - ES',
  31: 'Belo Horizonte - MG', 32: 'Juiz de Fora - MG', 33: 'Governador Valadares - MG', 34: 'Uberlândia - MG',
  35: 'Poços de Caldas - MG', 37: 'Divinópolis - MG', 38: 'Montes Claros - MG',
  41: 'Curitiba - PR', 42: 'Ponta Grossa - PR', 43: 'Londrina - PR', 44: 'Maringá - PR', 45: 'Foz do Iguaçu - PR', 46: 'Francisco Beltrão - PR',
  47: 'Joinville - SC', 48: 'Florianópolis - SC', 49: 'Chapecó - SC',
  51: 'Porto Alegre - RS', 53: 'Pelotas - RS', 54: 'Caxias do Sul - RS', 55: 'Santa Maria - RS',
  61: 'Brasília - DF', 62: 'Goiânia - GO', 63: 'Palmas - TO', 64: 'Rio Verde - GO', 65: 'Cuiabá - MT', 66: 'Rondonópolis - MT',
  67: 'Campo Grande - MS', 68: 'Rio Branco - AC', 69: 'Porto Velho - RO',
  71: 'Salvador - BA', 73: 'Ilhéus - BA', 74: 'Juazeiro - BA', 75: 'Feira de Santana - BA', 77: 'Vitória da Conquista - BA', 79: 'Aracaju - SE',
  81: 'Recife - PE', 82: 'Maceió - AL', 83: 'João Pessoa - PB', 84: 'Natal - RN', 85: 'Fortaleza - CE', 86: 'Teresina - PI',
  87: 'Petrolina - PE', 88: 'Juazeiro do Norte - CE', 89: 'Picos - PI',
  91: 'Belém - PA', 92: 'Manaus - AM', 93: 'Santarém - PA', 94: 'Marabá - PA', 95: 'Boa Vista - RR', 96: 'Macapá - AP',
  97: 'Coari - AM', 98: 'São Luís - MA', 99: 'Imperatriz - MA'
};

// Código do país → país (os mais comuns)
const PAISES = [
  ['351', 'Portugal'], ['54', 'Argentina'], ['595', 'Paraguai'], ['598', 'Uruguai'], ['56', 'Chile'], ['57', 'Colômbia'],
  ['51', 'Peru'], ['591', 'Bolívia'], ['52', 'México'], ['34', 'Espanha'], ['39', 'Itália'], ['44', 'Reino Unido'],
  ['49', 'Alemanha'], ['33', 'França'], ['81', 'Japão'], ['353', 'Irlanda'], ['61', 'Austrália'], ['1', 'EUA / Canadá']
];

function pelaDdd(telefoneOuJid) {
  const n = String(telefoneOuJid || '').split('@')[0].replace(/\D/g, '');
  if (n.length < 10) return null;
  if (n.startsWith('55') && n.length >= 12) {
    const cidade = DDD[Number(n.slice(2, 4))];
    return cidade ? { texto: cidade, fonte: 'ddd' } : null;
  }
  // número salvo sem o 55 (ex.: 21999998888)
  if (n.length === 10 || n.length === 11) {
    const cidade = DDD[Number(n.slice(0, 2))];
    return cidade ? { texto: cidade, fonte: 'ddd' } : null;
  }
  const pais = PAISES.find(([cod]) => n.startsWith(cod));
  return pais ? { texto: pais[1], fonte: 'ddd' } : null;
}

const limpar = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);

// Garante uma localização (pelo DDD) em quem ainda não tem
function garantir(lead) {
  if (lead.localizacao?.texto) return false;
  const l = pelaDdd(lead.whatsappJid || lead.telefone);
  if (!l) return false;
  lead.localizacao = { ...l, em: agora() };
  return true;
}

// O cliente disse onde está (a IA marcou) ou a equipe corrigiu
function definir(lead, texto, fonte) {
  const t = limpar(texto);
  if (!t) return false;
  if (lead.localizacao?.fonte === 'equipe' && fonte === 'ia') return false; // a equipe manda
  if (lead.localizacao?.texto === t) return false;
  lead.localizacao = { texto: t, fonte, em: agora() };
  salvar();
  return true;
}

function paraPainel(lead) {
  garantir(lead);
  const l = lead.localizacao;
  if (!l?.texto) return null;
  const DE_ONDE = { ddd: 'pelo DDD do WhatsApp', ia: 'o cliente disse na conversa', equipe: 'informado pela equipe' };
  return { texto: l.texto, fonte: l.fonte, origem: DE_ONDE[l.fonte] || '' };
}

// Linha para o contexto da IA (ela não repete a pergunta "de onde você é?" se já souber)
function paraIa(lead) {
  garantir(lead);
  const l = lead.localizacao;
  if (!l?.texto) return '';
  return l.fonte === 'ddd'
    ? `- Localização provável do cliente (pelo DDD do telefone, pode não ser exata): ${l.texto}.`
    : `- Localização do cliente: ${l.texto}.`;
}

module.exports = { pelaDdd, garantir, definir, paraPainel, paraIa, DDD };
