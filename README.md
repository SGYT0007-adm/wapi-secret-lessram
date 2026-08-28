# Baileys WhatsApp API (minimal, Render-ready)

A minimal WhatsApp HTTP API built directly on [Baileys](https://github.com/WhiskeySockets/Baileys) —
no bundled dashboard, no Redis, no browser engine. Session data is stored in Postgres
so it survives restarts on hosts with ephemeral disk (like Render's free tier).

## Web console

A single-page dashboard is served at `/` — open it in a browser, paste in your `API_KEY`,
and manage the whole connection from there:

- Live connection status (polls every 3s)
- QR code to scan when a device needs linking
- Linked device ID once connected, with an "Unlink" button
- A form to send a message
- A session activity log (client-side, clears on refresh)

The key is stored in the browser's `localStorage` only — it's sent as the `apikey` header
on every request, same as the raw API. No separate login system.

## Endpoints

All endpoints require an `apikey` header (or `?apikey=` query param for `/qr`, since it's
loaded via an `<img>` tag) matching your `API_KEY` env var.

- `GET /status` — connection status (`connecting`, `qr`, `connected`, `disconnected`)
- `GET /qr` — returns the current QR code as a PNG image (scan with WhatsApp: Linked Devices)
- `GET /me` — the linked device's WhatsApp ID, once connected
- `POST /logout` — unlinks the current device and immediately starts a fresh session (new QR)
- `POST /send` — send a text message
  ```json
  { "number": "15551234567", "message": "hello" }
  ```
  `number` can be a bare phone number (country code, no `+` or spaces) or a full JID.

## Local setup

```bash
npm install
cp .env.example .env   # fill in API_KEY and DATABASE_CONNECTION_URI
npm start
```

Then open `http://localhost:10000` in a browser, enter your `API_KEY`, and scan the QR
code shown in the console.

## Deploying on Render

1. Push this project to a Git repo (GitHub/GitLab), **without** a committed `.env` file.
2. In Render: New → Web Service → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. In the service's **Environment** tab, set:
   - `API_KEY` — a strong random string (`openssl rand -hex 32`)
   - `DATABASE_CONNECTION_URI` — your Render Postgres connection string
   - Render sets `PORT` automatically; you don't need to set it yourself.
4. Deploy. Once live, open the service's URL in a browser — that's the console. Enter your
   `API_KEY`, scan the QR code, and it'll flip to "connected" once linked.

## Notes on Render free tier

- **Cold starts**: free services spin down after 15 min idle. WhatsApp needs a persistent
  connection to receive messages in real time — while asleep, you will NOT receive
  incoming messages, and the socket will need to reconnect on wake. For anything beyond
  testing, an always-on paid plan (Starter, ~$7/mo) is effectively required.
- **Memory**: this app has no browser engine, so it stays well under the 512MB free-tier
  cap on its own. If you add heavy logic to `messages.upsert`, keep an eye on memory anyway.
- **Re-linking**: if you see `Logged out. Clear the baileys_auth table to re-link.` in the
  logs, run `DELETE FROM baileys_auth WHERE session_id = 'default';` in your Postgres DB,
  redeploy, and re-scan the QR code.

## Extending

- Add real message-handling logic inside the `messages.upsert` listener in `index.js`.
- To run multiple WhatsApp numbers from one deployment, call `usePostgresAuthState(pool, 'some-other-id')`
  with a different `sessionId` per number and manage multiple `sock` instances.
