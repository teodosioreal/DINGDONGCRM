// email.js — envio de e-mails do sistema (código de cadastro, recuperar senha,
// conta liberada) pelo Resend (resend.com). Sem RESEND_API_KEY, em teste local
// (COOKIE_SECURE=false) o e-mail só aparece no console; em produção, recusa.

const config = require('./config');

const configurado = () => Boolean(config.resendApiKey && config.emailRemetente);
// teste local sem chave: o código aparece no console do servidor
const modoConsole = () => !configurado() && !config.cookieSeguro;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Moldura simples com a marca DingDong (funciona nos principais leitores de e-mail)
function moldura(titulo, corpoHtml) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px 24px">
<tr><td style="font-size:20px;font-weight:700;padding-bottom:4px">DingDong</td></tr>
<tr><td style="font-size:13px;color:#6b7280;padding-bottom:20px">CRM · assistentes de IA</td></tr>
<tr><td style="font-size:17px;font-weight:700;padding-bottom:12px">${esc(titulo)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55">${corpoHtml}</td></tr>
</table>
<p style="font-size:12px;color:#9ca3af;margin:16px 0 0">Você recebeu este e-mail porque ele foi usado no DingDong CRM.<br>Se não foi você, é só ignorar.</p>
</td></tr></table></body></html>`;
}

async function enviar({ para, assunto, titulo, html, texto }) {
  if (modoConsole()) {
    console.log(`[e-mail · só no console] para ${para} · ${assunto}\n${texto}`);
    return { console: true };
  }
  if (!configurado()) throw Object.assign(new Error('O envio de e-mail ainda não está configurado. Fale com o suporte.'), { status: 503 });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailRemetente, to: [para], subject: assunto, html: moldura(titulo || assunto, html), text: texto }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    console.error(`[e-mail] Resend respondeu ${r.status}: ${detalhe.slice(0, 300)}`);
    throw Object.assign(new Error('Não conseguimos enviar o e-mail agora. Tente de novo em alguns minutos.'), { status: 502 });
  }
  return r.json().catch(() => ({}));
}

function codigo(para, cod, motivo) {
  const linhas = {
    cadastro: ['Confirme seu e-mail', 'Use este código para terminar de criar sua conta no DingDong CRM:'],
    senha: ['Crie uma nova senha', 'Use este código para criar uma nova senha no DingDong CRM:']
  }[motivo];
  return enviar({
    para,
    assunto: `${cod} é o seu código do DingDong CRM`,
    titulo: linhas[0],
    html: `<p style="margin:0 0 16px">${linhas[1]}</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:0 0 16px">${esc(cod)}</p><p style="margin:0;color:#6b7280;font-size:13px">O código vale por 10 minutos. Não passe este código para ninguém.</p>`,
    texto: `${linhas[1]}\n\n${cod}\n\nO código vale por 10 minutos. Não passe este código para ninguém.`
  });
}

module.exports = { enviar, codigo, configurado, modoConsole, esc };
