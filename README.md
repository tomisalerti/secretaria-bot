# Secretaria de eventos — cartero de WhatsApp

Servidor que conecta el número alternativo de WhatsApp de Tomi (Baileys, vinculado como dispositivo) y hace de cartero:

- Guarda en una bandeja los mensajes que Tomi le escribe y le contesta un acuse de recibo.
- Manda por WhatsApp a Tomi lo que le pida la secretaria (Claude, con tareas programadas en claude.ai que revisan la bandeja cada hora y mandan el resumen diario de eventos).

No usa ninguna API de IA paga. Corre en Railway con un volumen en `/data`.

## Variables de entorno

| Variable | Qué es |
|---|---|
| `OWNER_NUMBER` | Número principal de Tomi, solo dígitos con código de país (ej. `59899123456`). Solo se aceptan mensajes de ese número. |
| `ADMIN_SECRET` | Clave requerida en todas las rutas (`?key=`) |
| `DATA_DIR` | `/data` |
| `TZ` | `America/Montevideo` |
| `ACK_TEXT` | Opcional: texto del acuse de recibo |

## Rutas (GET o POST, todas con `?key=ADMIN_SECRET`)

- `/qr` QR para vincular el número alternativo
- `/inbox` mensajes nuevos de Tomi (los marca como leídos; `&peek=1` para no marcarlos)
- `/history` últimos 30 mensajes de la conversación
- `/send?text=...` manda un WhatsApp a Tomi
