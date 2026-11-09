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

/**
 * Arranca el buzón.
 * deps: { send(text), clima(), impact({mark}), history(), connected() , log }
 */
export function startBuzon(deps, { everyMs = 15000, estadoEveryMs = 15 * 60e3 } = {}) {
  const { log } = deps;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const outs = (await buzonList('out:')).sort((a, b) => a.name.localeCompare(b.name));
      for (const o of outs) {
        if (o.value) await deps.send(o.value);
        await buzonDel(o.name);
        log.info({ chars: (o.value || '').length }, 'Buzón: mensaje enviado por WhatsApp');
      }
      if (outs.length) await buzonPut('estado:history', await deps.history());
      const cmds = await buzonList('cmd:');
      for (const c of cmds) {
        if (c.name === 'cmd:impact-mark') {
          await buzonPut('estado:impact', await deps.impact({ mark: true }));
          log.info('Buzón: ventas de Impact marcadas como vistas');
        }
        await buzonDel(c.name);
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
