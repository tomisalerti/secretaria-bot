// Canal por mail entre el bot y la secretaria (Claude), para no depender de links.
//  - Hacia Claude: el bot DEPOSITA los mensajes (WhatsApp de Tomi, datos de la mañana) por IMAP
//    en la etiqueta "Secretaria" de la casilla de Tomi (Railway bloquea SMTP, IMAP sí funciona).
//  - Desde Claude: Claude manda un mail a la casilla del bot (BOT_EMAIL) con la clave en el asunto;
//    el bot lo lee por IMAP, manda el cuerpo por WhatsApp y borra el mail.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const BOT_EMAIL = process.env.BOT_EMAIL;
const BOT_EMAIL_PASS = (process.env.BOT_EMAIL_PASS || '').replace(/\s/g, '');
const OWNER_IMAP_USER = process.env.OWNER_IMAP_USER; // ej. tomi@ruffiweb.com
const OWNER_IMAP_PASS = (process.env.OWNER_IMAP_PASS || '').replace(/\s/g, '');
const OWNER_FOLDER = process.env.OWNER_FOLDER || 'Secretaria';
const MAIL_KEY = process.env.MAIL_KEY || process.env.ADMIN_SECRET;
const ALLOWED_FROM = (process.env.MAIL_ALLOWED_FROM || 'tomi@ruffiweb.com').toLowerCase().split(',');

export const mailEnabled = Boolean(BOT_EMAIL && BOT_EMAIL_PASS);
export const deliveryEnabled = Boolean(OWNER_IMAP_USER && OWNER_IMAP_PASS);

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

function imap(user, pass) {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
}

function encodeHeader(v) {
  return /[^\x00-\x7F]/.test(v) ? `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=` : v;
}

/** Deja un mensaje sin leer en la etiqueta "Secretaria" de la casilla de Tomi. */
export async function sendMail(subject, text) {
  if (!deliveryEnabled) throw new Error('Falta OWNER_IMAP_USER u OWNER_IMAP_PASS');
  const raw = [
    `From: Secretaria WhatsApp <${BOT_EMAIL || OWNER_IMAP_USER}>`,
    `To: ${OWNER_IMAP_USER}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@secretaria-bot>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  const client = imap(OWNER_IMAP_USER, OWNER_IMAP_PASS);
  try {
    await withTimeout(client.connect(), 20000, 'conectar casilla de Tomi');
    try {
      await client.mailboxCreate(OWNER_FOLDER);
    } catch {
      /* ya existe */
    }
    await withTimeout(client.append(OWNER_FOLDER, raw, [], new Date()), 20000, 'depositar mail');
    await client.logout();
  } catch (err) {
    try {
      client.close();
    } catch {}
    throw err;
  }
}

function cleanBody(text) {
  const out = [];
  for (const l of (text || '').replace(/\r/g, '').split('\n')) {
    if (/^On .+wrote:$/.test(l) || /^El .+escribió:$/.test(l) || /^-{2,}\s*Original/.test(l)) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** Revisa la casilla del bot y manda por WhatsApp cada mail válido de Claude. */
export function startMailPoller(onMessage, log, everyMs = 20000) {
  if (!mailEnabled) {
    log.warn('Canal por mail desactivado: faltan BOT_EMAIL o BOT_EMAIL_PASS');
    return;
  }
  let running = false;
  let firstTickLogged = false;
  const work = async () => {
    const client = imap(BOT_EMAIL, BOT_EMAIL_PASS);
    try {
      await client.connect();
      // Si Gmail mandó algún mail de Claude a Spam, lo devuelvo a la bandeja de entrada.
      try {
        const junk = (await client.list()).find((b) => b.specialUse === '\\Junk');
        if (junk) {
          const l2 = await client.getMailboxLock(junk.path);
          try {
            const spam = (await client.search({ subject: MAIL_KEY }, { uid: true })) || [];
            if (spam.length) {
              await client.messageMove(spam, 'INBOX', { uid: true });
              log.info({ n: spam.length }, 'Mails de Claude rescatados de Spam');
            }
          } finally {
            l2.release();
          }
        }
      } catch (err) {
        log.warn({ err: err.message }, 'No pude revisar Spam');
      }
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Buscar por la clave (texto único) evita tocar cualquier otro mail de la casilla.
        const uids = (await client.search({ seen: false, subject: MAIL_KEY }, { uid: true })) || [];
        if (!firstTickLogged) {
          firstTickLogged = true;
          log.info({ pendientes: uids.length }, 'Casilla del bot revisada por primera vez');
        }
        for (const uid of uids) {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const mail = await simpleParser(msg.source);
          const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
          if (!ALLOWED_FROM.includes(from)) {
            log.warn({ from }, 'Mail con clave pero de remitente no permitido: lo borro');
            await client.messageDelete(uid, { uid: true });
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
      try {
        client.close();
      } catch {}
      throw err;
    }
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await withTimeout(work(), 90000, 'revisar casilla del bot');
    } catch (err) {
      log.error({ err: err.message }, 'Error revisando la casilla del bot');
    } finally {
      running = false;
    }
  };
  setInterval(tick, everyMs);
  tick();
}
