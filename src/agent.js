// Loop de Claude con herramientas.
import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from './prompt.js';
import { getHistory, addNote } from './store.js';
import * as g from './google.js';

const client = new Anthropic(); // usa ANTHROPIC_API_KEY
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const MAX_STEPS = 15;

const tools = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
  {
    name: 'fetch_url',
    description: 'Descarga una página web y devuelve su texto (sin HTML). Útil para leer agendas de eventos y páginas de Luma.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'calendar_list_events',
    description: 'Lista eventos del Google Calendar de Tomi entre dos fechas (ISO 8601).',
    input_schema: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'Inicio, ej. 2026-11-10T00:00:00-03:00' },
        time_max: { type: 'string', description: 'Fin, ej. 2026-11-17T23:59:00-03:00' },
        query: { type: 'string', description: 'Texto a buscar (opcional)' },
      },
      required: ['time_min', 'time_max'],
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Crea un evento en el Google Calendar de Tomi.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 con hora local, ej. 2026-12-02T09:00:00' },
        end: { type: 'string', description: 'ISO 8601; si no se sabe, 2 horas después del inicio' },
        all_day: { type: 'boolean' },
        location: { type: 'string' },
        description: { type: 'string', description: 'Link del evento, cómo entrar, contacto, qué destacar' },
      },
      required: ['summary', 'start'],
    },
  },
  {
    name: 'gmail_search',
    description: 'Busca mails en el Gmail de Tomi (sintaxis de búsqueda de Gmail).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, max: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'gmail_create_draft',
    description: 'Crea un borrador de mail en el Gmail de Tomi. No lo envía.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        cc: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_send_draft',
    description: 'Envía un borrador ya creado. SOLO después de que Tomi confirmó explícitamente ese borrador.',
    input_schema: {
      type: 'object',
      properties: { draft_id: { type: 'string' } },
      required: ['draft_id'],
    },
  },
  {
    name: 'save_note',
    description: 'Guarda una nota persistente (eventos avisados, pedidos enviados, contactos, preferencias de Tomi).',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

async function fetchUrl({ url }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (secretaria-bot)' },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return { status: res.status, texto: text.slice(0, 15000) };
}

const handlers = {
  fetch_url: fetchUrl,
  calendar_list_events: g.listEvents,
  calendar_create_event: g.createEvent,
  gmail_search: g.searchEmails,
  gmail_create_draft: g.createDraft,
  gmail_send_draft: g.sendDraft,
  save_note: async ({ text }) => {
    addNote(text);
    return { guardado: true };
  },
};

/**
 * Corre a Claude con el historial + el mensaje nuevo y devuelve el texto final.
 */
export async function runAgent(userText) {
  const history = getHistory().map(({ role, content }) => ({ role, content }));
  // La API exige alternancia y que empiece con 'user'.
  const messages = [];
  for (const m of history) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else messages.push({ ...m });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') last.content += `\n\n${userText}`;
  else messages.push({ role: 'user', content: userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: systemPrompt(),
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'pause_turn') continue; // búsqueda web larga: seguir

    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    }

    const results = [];
    for (const tu of toolUses) {
      let content;
      let is_error = false;
      try {
        const out = await handlers[tu.name](tu.input);
        content = JSON.stringify(out).slice(0, 20000);
      } catch (err) {
        content = `Error: ${err.message}`;
        is_error = true;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Me trabé con este pedido (demasiados pasos). ¿Me lo pedís de nuevo más concreto?';
}
