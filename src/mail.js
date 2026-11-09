// Canal por mail entre el bot y la secretaria (Claude), para no depender de links.
//  - El bot le manda a Tomi (OWNER_EMAIL) los WhatsApp que él escribe y los datos de la mañana.
//  - Claude le manda mails a la casilla del bot (BOT_EMAIL) con asunto "[WA <clave>]";
//    el bot los lee por IMAP, manda el cuerpo por WhatsApp y borra el mail.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const BOT_EMAIL = process.env.BOT_EMAIL;
const BOT_EMAIL_PASS = (process.env.BOT_EMAIL_PASS || '').replace(/\s/g, '');
export const OWNER_EMAIL = process.env.OWNER_EMAIL || 'tomi+secretaria@ruffiweb.com';
const MAIL_KEY = process.env.MAIL_KEY || process.env.ADMIN_SECRET;
const ALLOWED_FROM = (process.env.MAIL_ALLOWED_FROM || 'tomi@ruffiweb.com').toLowerCase().split(',');

export const mailEnabled = Boolean(BOT_EMAIL && BOT_EMAIL_PASS);

let transport = null;
function smtp() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: BOT_EMAIL, pass: BOT_EMAIL_PASS },
    });
  }
  return transport;
}

export async function sendMail(subject, text) {
  if (!mailEnabled) return;
  await smtp().sendMail({ from: `Secretaria WhatsApp <${BOT_EMAIL}>`, to: OWNER_EMAIL, subject, text });
}

// Quita del cuerpo lo citado de mails anteriores y firmas típicas.
function cleanBody(text) {
  const lines = (text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^On .+wrote:$/.test(l) || /^El .+escribió:$/.test(l) || /^-{2,}\s*Original/.test(l)) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

/**
 * Revisa la casilla del bot cada `everyMs` y llama a onMessage(texto) por cada mail válido.
 * Si onMessage tira error, el mail queda sin leer para reintentar.
 */
export function startMailPoller(onMessage, log, everyMs = 20000) {
  if (!mailEnabled) {
    log.warn('Canal por mail desactivado: faltan BOT_EMAIL o BOT_EMAIL_PASS');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: BOT_EMAIL, pass: BOT_EMAIL_PASS },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ seen: false, subject: '[WA' }, { uid: true });
        for (const uid of uids || []) {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const mail = await simpleParser(msg.source);
          const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
          const subject = mail.subject || '';
          const okKey = MAIL_KEY && subject.includes(MAIL_KEY);
          if (!ALLOWED_FROM.includes(from) || !okKey) {
            log.warn({ from, subject: subject.slice(0, 40) }, 'Mail ignorado (remitente o clave inválidos)');
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }
          const body = cleanBody(mail.text || '');
          if (body) await onMessage(body);
          await client.messageDelete(uid, { uid: true });
          log.info({ chars: body.length }, 'Mail convertido en WhatsApp');
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      log.error({ err: err.message }, 'Error revisando la casilla del bot');
      try {
        await client.close();
      } catch {}
    } finally {
      running = false;
    }
  };
  setInterval(tick, everyMs);
  tick();
}
