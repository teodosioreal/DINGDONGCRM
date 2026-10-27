// imagem-personalizada.js — escreve um texto (ex.: "Site de exemplo para Guincho Martins") numa
// faixa embaixo da foto, para cada contato do disparo receber a imagem com o próprio nome.
// A faixa é acrescentada abaixo da foto (a foto não é coberta). Sem IA e sem programa externo:
// só JavaScript (jimp), então funciona em qualquer servidor.

const POSICOES = ['baixo', 'cima'];

// nomes do Google Maps costumam ser enormes ("Guincho X - Auto Socorro 24h - Transporte de…"):
// na imagem vai só o começo
function nomeCurto(nome, max = 40) {
  let s = String(nome || '').replace(/\s+/g, ' ').trim();
  s = s.split(/\s[-–—|•·]\s|\s*\|\s*|,\s/)[0].trim() || s;
  if (s.length <= max) return s;
  const corte = s.slice(0, max + 1).lastIndexOf(' ');
  return `${s.slice(0, corte > 15 ? corte : max).trim()}...`;
}

// a fonte só tem os caracteres do português (Latin-1): o resto vira o parecido ou sai
const TROCAS = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '-', '·': '-' };
function textoDaFonte(texto, font) {
  const tem = (ch) => Boolean(font.chars?.[ch]);
  let saida = '';
  for (const ch of String(texto || '')) {
    if (tem(ch)) saida += ch;
    else if (TROCAS[ch]) saida += TROCAS[ch];
    else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (base && [...base].every(tem)) saida += base;
    }
  }
  return saida.replace(/\s+/g, ' ').trim();
}

const cor = (hex, alfa = 'ff') => {
  const h = String(hex || '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(h) ? parseInt(`${h}${alfa}`, 16) : null;
};

// caminho (ou Buffer) da foto → Buffer JPEG com a faixa e o texto
async function gerar(origem, texto, { posicao = 'baixo', fundo = '#111827', destaque = '#facc15' } = {}) {
  const { Jimp, loadFont, measureText, HorizontalAlign, VerticalAlign } = require('jimp');
  const fontes = require('jimp/fonts');
  const foto = await Jimp.read(origem);
  // foto enorme: reduz (o WhatsApp comprime de qualquer jeito)
  if (foto.bitmap.width > 1600) foto.resize({ w: 1600 });
  const W = foto.bitmap.width;
  const H = foto.bitmap.height;
  const margem = Math.round(W * 0.05);
  const util = W - margem * 2;
  // a maior letra que cabe em até 2 linhas
  let font = null;
  let linhas = 1;
  let frase = '';
  for (const tam of W >= 900 ? ['SANS_64_WHITE', 'SANS_32_WHITE', 'SANS_16_WHITE'] : ['SANS_32_WHITE', 'SANS_16_WHITE']) {
    font = await loadFont(fontes[tam]);
    frase = textoDaFonte(texto, font);
    const largura = measureText(font, frase);
    linhas = largura <= util ? 1 : 2;
    if (largura <= util * 1.85) break;
  }
  if (!frase) throw new Error('Texto vazio para a imagem.');
  const alturaLinha = font.common.lineHeight;
  const faixa = Math.round(alturaLinha * linhas + alturaLinha * 0.9);
  const tira = Math.max(4, Math.round(W / 160)); // linha colorida que separa a foto da faixa
  const tela = new Jimp({ width: W, height: H + faixa + tira, color: cor(fundo) ?? 0x111827ff });
  const emCima = posicao === 'cima';
  tela.composite(foto, 0, emCima ? faixa + tira : 0);
  tela.composite(new Jimp({ width: W, height: tira, color: cor(destaque) ?? 0xfacc15ff }), 0, emCima ? faixa : H);
  tela.print({
    font,
    x: margem,
    y: emCima ? 0 : H + tira,
    text: { text: frase, alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.MIDDLE },
    maxWidth: util,
    maxHeight: faixa
  });
  return tela.getBuffer('image/jpeg', { quality: 88 });
}

module.exports = { gerar, nomeCurto, POSICOES };
