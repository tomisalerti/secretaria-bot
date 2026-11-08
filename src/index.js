// Secretaria de eventos por WhatsApp: servidor web + conexión de WhatsApp + resumen diario.
import express from 'express';
import cron from 'node-cron';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { runAgent } from './agent.js';
import { DIGEST_PROMPT } from './prompt.js';
import { appendHistory, dataPath } from './store.js';
import { googleAuthUrl, handleGoogleCallback, googleConnected } from './google.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'America/Montevideo';
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, ''); // ej. 59899123456
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const AUTH_DIR = dataPath('wa-auth');

if (!ADMIN_SECRET || !OWNER) {
  log.error('Faltan ADMIN_SECRET u OWNER_NUMBER en las variables de entorno.');
}

let sock = null;
let lastQr = null;
let connected = false;
let ownerLid = null; // WhatsApp a veces identifica al contacto con un LID en vez del número

// ---------------- WhatsApp ----------------
function numberOf(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

function isOwner(key) {
  const candidates = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt];
  if (candidates.some((j) => j && j.endsWith('@s.whatsapp.net') && numberOf(j) === OWNER)) {
    if (key.remoteJid?.endsWith('@lid')) ownerLid = key.remoteJid;
    return true;
  }
  return Boolean(ownerLid && key.remoteJid === ownerLid);
}

async function sendToOwner(text, jid = OWNER_JID) {
  if (!sock || !connected) throw new Error('WhatsApp no está conectado');
  // WhatsApp corta mensajes muy largos: partir en trozos de ~3500 caracteres.
  const chunks = text.match(/[\s\S]{1,3500}(?=\n|$)|[\s\S]{1,3500}/g) || [text];
  for (const c of chunks) await sock.sendMessage(jid, { text: c });
}

function textOf(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

// Una sola tarea a la vez, para que no se pisen pedidos.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => log.error({ err }, 'Error en tarea'));
  return queue;
}

async function handleIncoming(msg) {
  const key = msg.key;
  if (key.fromMe || isJidGroup(key.remoteJid) || key.remoteJid === 'status@broadcast') return;
  if (!isOwner(key)) {
    log.info({ from: key.remoteJid, alt: key.remoteJidAlt }, 'Mensaje ignorado (no es de Tomi)');
    return;
  }
  const text = textOf(msg.message);
  const replyJid = key.remoteJid;
  if (!text) {
    await sock.sendMessage(replyJid, { text: 'Por ahora solo leo texto 🙏 (audios y fotos sin texto todavía no).' });
    return;
  }
  enqueue(async () => {
    try {
      await sock.sendPresenceUpdate('composing', replyJid);
      const answer = await runAgent(text);
      appendHistory('user', text);
      appendHistory('assistant', answer);
      await sendToOwner(answer || '(sin respuesta)', replyJid);
    } catch (err) {
      log.error({ err }, 'Error respondiendo');
      await sock.sendMessage(replyJid, { text: `Tuve un error: ${err.message}` });
    } finally {
      await sock.sendPresenceUpdate('paused', replyJid).catch(() => {});
    }
  });
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Secretaria'),
    logger: log.child({ module: 'baileys' }, { level: 'warn' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQr = qr;
      log.info('Nuevo QR disponible en /qr');
    }
    if (connection === 'open') {
      connected = true;
      lastQr = null;
      log.info('WhatsApp conectado');
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn('Sesión cerrada desde el celular: borro credenciales y pido QR nuevo');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        log.warn({ code }, 'Conexión cerrada, reconectando');
      }
      setTimeout(startWhatsApp, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) await handleIncoming(m).catch((err) => log.error({ err }));
  });
}

// ---------------- Resumen diario ----------------
async function runDigest() {
  log.info('Corriendo resumen diario');
  const answer = await runAgent(DIGEST_PROMPT);
  appendHistory('user', '[resumen diario automático]');
  appendHistory('assistant', answer);
  await sendToOwner(answer, ownerLid || OWNER_JID);
}

cron.schedule(process.env.DIGEST_CRON || '40 10 * * *', () => enqueue(runDigest), { timezone: TZ });

// ---------------- Servidor web ----------------
const app = express();

function requireSecret(req, res, next) {
  if (!ADMIN_SECRET || req.query.key !== ADMIN_SECRET) return res.status(401).send('No autorizado');
  next();
}

app.get('/', (_req, res) => {
  res.json({ ok: true, whatsapp: connected ? 'conectado' : 'desconectado', google: googleConnected() });
});

app.get('/qr', requireSecret, async (_req, res) => {
  const head = '<meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="10">';
  const style = 'font-family:system-ui;text-align:center;padding:24px';
  if (connected) return res.send(`${head}<div style="${style}"><h2>✅ WhatsApp conectado</h2></div>`);
  if (!lastQr) return res.send(`${head}<div style="${style}"><h2>Generando QR…</h2><p>Se actualiza solo.</p></div>`);
  const img = await QRCode.toDataURL(lastQr, { width: 360 });
  res.send(
    `${head}<div style="${style}"><h2>Escaneá con el WhatsApp del número alternativo</h2>` +
      `<p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p><img src="${img}" alt="QR"/>` +
      `<p>La página se actualiza cada 10 segundos.</p></div>`
  );
});

app.get('/google/auth', requireSecret, (_req, res) => {
  try {
    res.redirect(googleAuthUrl());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/google/callback', async (req, res) => {
  if (!ADMIN_SECRET || req.query.state !== ADMIN_SECRET) return res.status(401).send('No autorizado');
  try {
    await handleGoogleCallback(req.query.code);
    res.send('<div style="font-family:system-ui;padding:24px"><h2>✅ Google conectado</h2><p>Ya podés cerrar esta pestaña.</p></div>');
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.post('/digest', requireSecret, (_req, res) => {
  enqueue(runDigest);
  res.send('Resumen en camino');
});

app.listen(PORT, () => log.info(`Servidor en puerto ${PORT}`));
startWhatsApp().catch((err) => log.error({ err }, 'No pude iniciar WhatsApp'));
