# Secretaria de eventos (WhatsApp)

Bot de WhatsApp para Tomi: busca eventos, manda un resumen diario y ejecuta pedidos (agendar en Google Calendar, preparar y enviar mails desde Gmail). Usa Baileys (WhatsApp Web no oficial) y la API de Claude. Corre en Railway con un volumen en `/data`.

## Variables de entorno

| Variable | Qué es |
|---|---|
| `ANTHROPIC_API_KEY` | API key de console.anthropic.com |
| `OWNER_NUMBER` | Número principal de Tomi, solo dígitos con código de país (ej. `59899123456`). Solo se le responde a ese número. |
| `ADMIN_SECRET` | Clave para abrir `/qr`, `/google/auth` y `/digest` |
| `PUBLIC_URL` | URL pública del servicio en Railway |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Cliente OAuth (tipo "Aplicación web") con redirect `PUBLIC_URL/google/callback` |
| `DATA_DIR` | `/data` (volumen) |
| `TZ` | `America/Montevideo` |
| `MODEL` | Opcional, por defecto `claude-sonnet-5-5` |
| `DIGEST_CRON` | Opcional, por defecto `40 10 * * *` (10:40) |

## Rutas

- `GET /` estado
- `GET /qr?key=ADMIN_SECRET` QR para vincular el número alternativo
- `GET /google/auth?key=ADMIN_SECRET` conectar Gmail y Calendar
- `POST /digest?key=ADMIN_SECRET` forzar el resumen diario

## Ajustes

Perfil, fuentes y reglas de la secretaria: `src/prompt.js`. Las notas que guarda la secretaria quedan en `/data/notas.md`.
