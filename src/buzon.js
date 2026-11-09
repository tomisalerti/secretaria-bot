// Buzón en Cloudflare KV (vía un Worker) entre el bot y la secretaria (Claude).
// Reemplaza el canal por mail: Claude lee y escribe el KV con su conector de Cloudflare,
// y el bot habla con el mismo KV a través del Worker.
//
// Claves:
//   out:<ts>              mensaje que Claude quiere mandar a Tomi por WhatsApp (el bot lo manda y lo borra)
//   in:<ts>               mensaje que Tomi mandó por WhatsApp (Claude lo lee y lo borra)
//   cmd:impact-mark       Claude pide marcar como vistas las ventas de Impact (el bot lo hace y lo borra)
//   estado:clima          clima en la última ubicación (lo actualiza el bot)
//   estado:impact         ventas de Holafly (lo actualiza el bot)
//   estado:history        conversación reciente (lo actualiza el bot)
//   estado:bot            estado del WhatsApp y hora de la última actualización
//
// Claves (sin listados: Cloudflare KV gratis permite solo 1.000 listados por día):
//   out          JSON [{id, text}] con mensajes que Claude quiere mandar a Tomi (el bot los manda y borra la clave)
//   in           JSON [{id, at, text}] con mensajes de Tomi (el bot agrega; Claude lee, resuelve y borra la clave)
//   cmd          texto "impact-mark" para marcar ventas de Impact como vistas (el bot lo hace y borra la clave)
//   estado:clima / estado:impact / estado:history / estado:bot   (los actualiza el bot)

const URL_BASE = (process.env.BUZON_URL || 'https://secretaria-buzon.pilcha.workers.dev').replace(/\/$/, '');
const KEY = process.env.ADMIN_SECRET;

async function call(method, path, body) {
  const r = await fetch(URL_BASE + path, {
    method,
    headers: { 'x-key': KEY, 'content-type': 'text/plain; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) throw new Error(`buzón ${method} ${path}: ${r.status}`);
  return r;
}

export const buzonPut = (key, text) => call('PUT', `/kv/${encodeURIComponent(key)}`, String(text));
export const buzonDel = (key) => call('DELETE', `/kv/${encodeURIComponent(key)}`);
export async function buzonList(prefix) {
  const r = await call('GET', `/list?prefix=${encodeURIComponent(prefix)}`);
  return r ? r.json() : [];
}

import { readJson, writeJson } from './store.js';
import crypto from 'node:crypto';

export async function buzonGet(key) {
  const r = await call('GET', `/kv/${encodeURIComponent(key)}`);
  return r ? r.text() : null;
}

function parseLista(raw) {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : [j];
    return arr.map((x) => (typeof x === 'string' ? { text: x } : x));
  } catch {
    return [{ text: raw }];
  }
}
const hash = (t) => crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 12);

/** Agrega un mensaje de Tomi a la clave "in". */
export async function buzonAgregarEntrada(text, at) {
  const lista = parseLista(await buzonGet('in'));
  lista.push({ id: `${Date.now()}`, at, text });
  await buzonPut('in', JSON.stringify(lista.slice(-50)));
}

/**
 * Arranca el buzón.
 * deps: { send(text), clima(), impact({mark}), history(), connected(), log }
 */
export function startBuzon(deps, { everyMs = 15000, estadoEveryMs = 30 * 60e3 } = {}) {
  const { log } = deps;
  let busy = false;
  // Ids ya enviados (KV puede devolver un valor viejo hasta ~60 s después de borrarlo).
  const enviados = new Set(readJson('buzon-enviados.json', []));
  const recordar = (id) => {
    enviados.add(id);
    writeJson('buzon-enviados.json', [...enviados].slice(-500));
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const raw = await buzonGet('out');
      if (raw) {
        const lista = parseLista(raw);
        let mandados = 0;
        for (const m of lista) {
          const id = m.id || hash(m.text);
          if (enviados.has(id) || !m.text) continue;
          await deps.send(m.text);
          recordar(id);
          mandados++;
          log.info({ chars: m.text.length }, 'Buzón: mensaje enviado por WhatsApp');
        }
        await buzonDel('out');
        if (mandados) await buzonPut('estado:history', await deps.history());
      }
      const cmd = await buzonGet('cmd');
      if (cmd && cmd.includes('impact-mark')) {
        await buzonDel('cmd');
        await buzonPut('estado:impact', await deps.impact({ mark: true }));
        log.info('Buzón: ventas de Impact marcadas como vistas');
      }
    } catch (err) {
      log.error({ err: err.message }, 'Error revisando el buzón');
    } finally {
      busy = false;
    }
  };

  const publicarEstado = async () => {
    const ahora = new Date().toISOString();
    const partes = [
      ['estado:clima', () => deps.clima()],
      ['estado:impact', () => deps.impact({ mark: false })],
      ['estado:history', () => deps.history()],
    ];
    for (const [k, f] of partes) {
      try {
        await buzonPut(k, await f());
      } catch (err) {
        await buzonPut(k, `ERROR: ${err.message}`).catch(() => {});
      }
    }
    await buzonPut('estado:bot', `WHATSAPP: ${deps.connected() ? 'conectado' : 'DESCONECTADO'}\nACTUALIZADO: ${ahora}`).catch(() => {});
  };

  setInterval(tick, everyMs);
  setInterval(() => publicarEstado().catch((e) => log.error({ err: e.message }, 'Error publicando estado')), estadoEveryMs);
  tick();
  publicarEstado().catch((e) => log.error({ err: e.message }, 'Error publicando estado'));
  return { publicarEstado };
}
