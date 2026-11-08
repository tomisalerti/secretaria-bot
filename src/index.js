// "Cartero" de WhatsApp para la secretaria de eventos de Tomi.
// Recibe los mensajes de Tomi en el número alternativo, los guarda en una bandeja,
// y manda por WhatsApp lo que la secretaria (Claude, con tareas programadas) le indique.
import express from 'express';
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
import { readJson, writeJson, dataPath } from './store.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'America/Montevideo';
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, ''); // ej. 59899123456
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const AUTH_DIR = dataPath('wa-auth');
const ACK_TEXT =
  process.env.ACK_TEXT ||
  '📥 Anotado. Lo veo en la próxima revisión (cada hora en punto, de 8 a 23) y te respondo por acá. Si es urgente, pedímelo en la app de Claude.';

if (!ADMIN_SECRET || !OWNER) log.error('Faltan ADMIN_SECRET u OWNER_NUMBER en las variables de entorno.');

let sock = null;
let lastQr = null;
let connected = false;
let ownerChat = readJson('owner-chat.json', null); // jid real del chat con Tomi (puede ser un LID)

// ---------------- Bandeja ----------------
// inbox.json: [{ id, at, text, status: 'nuevo' | 'leido' }]
const INBOX = 'inbox.json';
const OUTBOX = 'outbox.json';

function addToInbox(id, text) {
  const inbox = readJson(INBOX, []);
  inbox.push({ id, at: new Date().toISOString(), text, status: 'nuevo' });
  writeJson(INBOX, inbox.slice(-200));
}

function logOutgoing(text) {
  const out = readJson(OUTBOX, []);
  out.push({ at: new Date().toISOString(), text });
  writeJson(OUTBOX, out.slice(-100));
}

const local = (iso) => new Date(iso).toLocaleString('es-UY', { timeZone: TZ });

// ---------------- WhatsApp ----------------
const numberOf = (jid) => (jid || '').split('@')[0].split(':')[0];

function isOwner(key) {
  const candidates = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt];
  if (candidates.some((j) => j && j.endsWith('@s.whatsapp.net') && numberOf(j) === OWNER)) return true;
  return Boolean(ownerChat && key.remoteJid === ownerChat);
}

function textOf(m) {
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || null;
}

async function sendToOwner(text) {
  if (!sock || !connected) throw new Error('WhatsApp no está conectado');
  const jid = ownerChat || OWNER_JID;
  const chunks = text.match(/[\s\S]{1,3500}(?=\n|$)|[\s\S]{1,3500}/g) || [text];
  for (const c of chunks) await sock.sendMessage(jid, { text: c });
  logOutgoing(text);
}

async function handleIncoming(msg) {
  const key = msg.key;
  if (key.fromMe || isJidGroup(key.remoteJid) || key.remoteJid === 'status@broadcast') return;
  if (!isOwner(key)) {
    log.info({ from: key.remoteJid, alt: key.remoteJidAlt }, 'Mensaje ignorado (no es de Tomi)');
    return;
  }
  if (ownerChat !== key.remoteJid) {
    ownerChat = key.remoteJid;
    writeJson('owner-chat.json', ownerChat);
  }
  // Ubicación compartida (fija o en tiempo real): se guarda para el mensaje de buen día.
  const loc = msg.message?.locationMessage || msg.message?.liveLocationMessage;
  if (loc?.degreesLatitude != null) {
    writeJson('ubicacion.json', {
      lat: loc.degreesLatitude,
      lon: loc.degreesLongitude,
      nombre: loc.name || loc.address || null,
      en_vivo: Boolean(msg.message?.liveLocationMessage),
      at: new Date().toISOString(),
    });
    log.info('Ubicación actualizada');
    return;
  }
  const text = textOf(msg.message);
  if (!text) {
    await sock.sendMessage(key.remoteJid, { text: 'Por ahora solo leo texto 🙏 (los audios y fotos sin texto todavía no).' });
    return;
  }
  const hadPending = readJson(INBOX, []).some((m) => m.status === 'nuevo');
  addToInbox(key.id, text);
  if (!hadPending) await sock.sendMessage(key.remoteJid, { text: ACK_TEXT });
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
    for (const m of messages) {
      log.info({ type, from: m.key.remoteJid, alt: m.key.remoteJidAlt, fromMe: m.key.fromMe }, 'Mensaje recibido');
    }
    if (type !== 'notify') return;
    for (const m of messages) await handleIncoming(m).catch((err) => log.error({ err }, 'Error procesando mensaje'));
  });
}

// ---------------- Servidor web ----------------
// Todas las rutas aceptan GET (para que Claude pueda usarlas con su herramienta de lectura web)
// y POST con JSON. Todas requieren ?key=ADMIN_SECRET.
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const param = (req, name) => req.body?.[name] ?? req.query[name];

function requireSecret(req, res, next) {
  if (!ADMIN_SECRET || param(req, 'key') !== ADMIN_SECRET) return res.status(401).send('No autorizado');
  res.set('Cache-Control', 'no-store');
  next();
}

app.get('/', (_req, res) => res.json({ ok: true, whatsapp: connected ? 'conectado' : 'desconectado' }));

// Mensajes nuevos de Tomi. Los marca como leídos al devolverlos.
app.all('/inbox', requireSecret, (req, res) => {
  const inbox = readJson(INBOX, []);
  const nuevos = inbox.filter((m) => m.status === 'nuevo');
  if (param(req, 'peek') !== '1') {
    for (const m of inbox) if (m.status === 'nuevo') m.status = 'leido';
    writeJson(INBOX, inbox);
  }
  const lines = nuevos.map((m) => `[${local(m.at)}] ${m.text}`);
  res.type('text/plain').send(
    `WHATSAPP: ${connected ? 'conectado' : 'DESCONECTADO'}\nMENSAJES_NUEVOS: ${nuevos.length}\n\n` +
      (lines.join('\n\n') || '(no hay mensajes nuevos)')
  );
});

// Conversación reciente (mensajes de Tomi y respuestas enviadas), para tener contexto.
app.all('/history', requireSecret, (_req, res) => {
  const items = [
    ...readJson(INBOX, []).map((m) => ({ at: m.at, who: 'Tomi', text: m.text })),
    ...readJson(OUTBOX, []).map((m) => ({ at: m.at, who: 'Secretaria', text: m.text })),
  ]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-30);
  res.type('text/plain').send(items.map((i) => `[${local(i.at)}] ${i.who}: ${i.text}`).join('\n\n') || '(vacío)');
});

// Enviar un WhatsApp a Tomi.
app.all('/send', requireSecret, async (req, res) => {
  const text = param(req, 'text');
  if (!text) return res.status(400).send('Falta text');
  try {
    await sendToOwner(String(text));
    res.type('text/plain').send(`ENVIADO OK (${String(text).length} caracteres)`);
  } catch (err) {
    res.status(503).type('text/plain').send(`NO ENVIADO: ${err.message}`);
  }
});

// Envío en partes, para mensajes largos (la herramienta web de Claude limita el largo de la URL).
//   /c?k=KEY&b=LOTE&n=1&msg=texto   guarda la parte n del lote
//   /f?k=KEY&b=LOTE               une las partes en orden y manda el mensaje
const batches = new Map();
const shortSecret = (req, res, next) => {
  if (!ADMIN_SECRET || param(req, 'k') !== ADMIN_SECRET) return res.status(401).send('No autorizado');
  res.set('Cache-Control', 'no-store');
  next();
};

app.all('/c', shortSecret, (req, res) => {
  const b = String(param(req, 'b') || '');
  const n = Number(param(req, 'n'));
  const t = param(req, 'msg') ?? param(req, 't');
  if (!b || !Number.isInteger(n) || t === undefined) return res.status(400).send(`Faltan b, n o msg (recibí: ${Object.keys(req.query).join(',')})`);
  if (!batches.has(b)) batches.set(b, { parts: new Map(), at: Date.now() });
  batches.get(b).parts.set(n, String(t));
  res.type('text/plain').send(`OK parte ${n} del lote ${b} (${batches.get(b).parts.size} partes)`);
});

app.all('/f', shortSecret, async (req, res) => {
  const b = String(param(req, 'b') || '');
  const batch = batches.get(b);
  if (!batch) return res.status(404).send(`No existe el lote ${b}`);
  const text = [...batch.parts.entries()].sort((x, y) => x[0] - y[0]).map(([, t]) => t).join('');
  try {
    await sendToOwner(text);
    batches.delete(b);
    res.type('text/plain').send(`ENVIADO OK lote ${b}: ${batch.parts.size} partes`);
  } catch (err) {
    res.status(503).type('text/plain').send(`NO ENVIADO: ${err.message}`);
  }
});

// Limpia lotes abandonados cada hora.
setInterval(() => {
  for (const [b, v] of batches) if (Date.now() - v.at > 3 * 3600e3) batches.delete(b);
}, 3600e3);

// Última ubicación que compartió Tomi por WhatsApp.
app.all('/loc', requireSecret, (_req, res) => {
  const u = readJson('ubicacion.json', null);
  if (!u) return res.type('text/plain').send('SIN_UBICACION');
  res.type('text/plain').send(
    `LAT: ${u.lat}\nLON: ${u.lon}\nNOMBRE: ${u.nombre || '-'}\nEN_VIVO: ${u.en_vivo ? 'si' : 'no'}\nACTUALIZADA: ${local(u.at)}`
  );
});

// Clima en la última ubicación compartida (o Montevideo si no hay o es vieja).
const WMO = {
  0: 'despejado', 1: 'mayormente despejado', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'niebla', 48: 'niebla', 51: 'llovizna débil', 53: 'llovizna', 55: 'llovizna intensa',
  61: 'lluvia débil', 63: 'lluvia', 65: 'lluvia fuerte', 71: 'nieve débil', 73: 'nieve', 75: 'nieve fuerte',
  80: 'chaparrones', 81: 'chaparrones', 82: 'chaparrones fuertes', 95: 'tormenta', 96: 'tormenta con granizo', 99: 'tormenta con granizo',
};

app.all('/clima', requireSecret, async (_req, res) => {
  try {
    const u = readJson('ubicacion.json', null);
    const fresh = u && Date.now() - new Date(u.at).getTime() < 36 * 3600e3;
    const lat = fresh ? u.lat : -34.9011;
    const lon = fresh ? u.lon : -56.1645;
    let lugar = fresh ? u.nombre : 'Montevideo, Uruguay';
    if (fresh && !lugar) {
      const g = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=es`,
        { headers: { 'User-Agent': 'secretaria-bot (tomisalerti.com)' }, signal: AbortSignal.timeout(10000) }
      ).then((r) => r.json());
      const a = g.address || {};
      lugar = [a.city || a.town || a.village || a.county || a.state, a.country].filter(Boolean).join(', ') || g.display_name;
    }
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code` +
        `&hourly=precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
        `&timezone=auto&forecast_days=1`,
      { signal: AbortSignal.timeout(10000) }
    ).then((r) => r.json());
    const h = w.hourly;
    const tramo = (from, to) => {
      const probs = h.precipitation_probability.slice(from, to);
      return Math.max(...probs);
    };
    res.type('text/plain').send(
      [
        `UBICACION: ${lugar}${fresh ? (u.en_vivo ? ' (ubicación en tiempo real)' : ' (última ubicación compartida)') : ' (por defecto: no compartió ubicación en las últimas 36 h)'}`,
        `TEMPERATURA_AHORA: ${Math.round(w.current.temperature_2m)} °C, ${WMO[w.current.weather_code] || 'código ' + w.current.weather_code}`,
        `HOY: máxima ${Math.round(w.daily.temperature_2m_max[0])} °C, mínima ${Math.round(w.daily.temperature_2m_min[0])} °C, ${WMO[w.daily.weather_code[0]] || ''}`,
        `PROBABILIDAD_DE_LLUVIA: mañana (6-12 h) ${tramo(6, 12)}%, tarde (12-19 h) ${tramo(12, 19)}%, noche (19-24 h) ${tramo(19, 24)}%`,
      ].join('\n')
    );
  } catch (err) {
    res.status(502).type('text/plain').send(`ERROR_CLIMA: ${err.message}`);
  }
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

app.listen(PORT, () => log.info(`Servidor en puerto ${PORT}`));
startWhatsApp().catch((err) => log.error({ err }, 'No pude iniciar WhatsApp'));
