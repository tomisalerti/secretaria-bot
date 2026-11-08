// Acceso a Google Calendar y Gmail con OAuth (token guardado en el volumen).
import { google } from 'googleapis';
import { readJson, writeJson } from './store.js';

const TOKEN_FILE = 'google-token.json';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];
const TZ = process.env.TZ || 'America/Montevideo';

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !PUBLIC_URL) return null;
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${PUBLIC_URL.replace(/\/$/, '')}/google/callback`
  );
  client.on('tokens', (tokens) => {
    const prev = readJson(TOKEN_FILE, {});
    writeJson(TOKEN_FILE, { ...prev, ...tokens });
  });
  return client;
}

export function googleAuthUrl() {
  const client = oauthClient();
  if (!client) throw new Error('Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o PUBLIC_URL');
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state: process.env.ADMIN_SECRET });
}

export async function handleGoogleCallback(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  writeJson(TOKEN_FILE, tokens);
}

export function googleConnected() {
  return Boolean(readJson(TOKEN_FILE, null)?.refresh_token);
}

function authed() {
  const tokens = readJson(TOKEN_FILE, null);
  const client = oauthClient();
  if (!client || !tokens?.refresh_token) {
    throw new Error('Google no está conectado todavía. Tomi tiene que abrir /google/auth en el servidor.');
  }
  client.setCredentials(tokens);
  return client;
}

// ---------------- Calendar ----------------
export async function listEvents({ time_min, time_max, query }) {
  const calendar = google.calendar({ version: 'v3', auth: authed() });
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date(time_min).toISOString(),
    timeMax: new Date(time_max).toISOString(),
    q: query || undefined,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });
  return (res.data.items || []).map((e) => ({
    id: e.id,
    titulo: e.summary,
    inicio: e.start?.dateTime || e.start?.date,
    fin: e.end?.dateTime || e.end?.date,
    lugar: e.location,
  }));
}

export async function createEvent({ summary, start, end, location, description, all_day }) {
  const calendar = google.calendar({ version: 'v3', auth: authed() });
  const timeObj = (v) => (all_day ? { date: v.slice(0, 10) } : { dateTime: v, timeZone: TZ });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      location,
      description,
      start: timeObj(start),
      end: timeObj(end || start),
    },
  });
  return { id: res.data.id, link: res.data.htmlLink };
}

// ---------------- Gmail ----------------
function encodeHeader(value) {
  return /[^\x00-\x7F]/.test(value) ? `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=` : value;
}

function buildRaw({ to, subject, body, cc }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64'),
  ].filter((l) => l !== null);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export async function searchEmails({ query, max = 10 }) {
  const gmail = google.gmail({ version: 'v1', auth: authed() });
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: Math.min(max, 20) });
  const out = [];
  for (const m of res.data.messages || []) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const h = Object.fromEntries((msg.data.payload?.headers || []).map((x) => [x.name, x.value]));
    out.push({ id: m.id, de: h.From, para: h.To, asunto: h.Subject, fecha: h.Date, resumen: msg.data.snippet });
  }
  return out;
}

export async function createDraft({ to, subject, body, cc }) {
  const gmail = google.gmail({ version: 'v1', auth: authed() });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: buildRaw({ to, subject, body, cc }) } },
  });
  return { draft_id: res.data.id };
}

export async function sendDraft({ draft_id }) {
  const gmail = google.gmail({ version: 'v1', auth: authed() });
  const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draft_id } });
  return { enviado: true, message_id: res.data.id };
}
