// index.js
// Minimal Baileys WhatsApp API server.
// - Persists session in Postgres (see pgAuthState.js) so it survives Render restarts.
// - Exposes GET /qr to fetch the current QR code (as an image) to scan.
// - Exposes POST /send to send a text message, protected by a simple API key header.

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { usePostgresAuthState } = require('./pgAuthState');

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY; // set this in Render env vars
const DATABASE_URL = process.env.DATABASE_CONNECTION_URI;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_CONNECTION_URI env var. Exiting.');
  process.exit(1);
}
if (!API_KEY) {
  console.error('Missing API_KEY env var. Exiting.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres requires SSL
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock;
let latestQR = null;
let connectionStatus = 'connecting';

function requireApiKey(req, res, next) {
  const key = req.headers['apikey'] || req.query.apikey;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing apikey header' });
  }
  next();
}

async function startSock() {
  const { state, saveCreds } = await usePostgresAuthState(pool, 'default');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'error' }), // keep logs quiet — saves noise/memory
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'qr';
      console.log('New QR code generated — fetch it at GET /qr');
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      latestQR = null;
      console.log('WhatsApp connection open.');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startSock();
      } else {
        console.log('Logged out. Clear the baileys_auth table to re-link.');
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    // Hook your message-handling logic here.
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      console.log('Incoming message from', msg.key.remoteJid);
    }
  });
}

// --- HTTP routes ---

app.get('/status', requireApiKey, (req, res) => {
  res.json({ status: connectionStatus });
});

app.get('/me', requireApiKey, (req, res) => {
  if (connectionStatus !== 'connected' || !sock?.user) {
    return res.status(409).json({ error: 'Not connected' });
  }
  res.json({ id: sock.user.id, name: sock.user.name || null });
});

app.post('/logout', requireApiKey, async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    await pool.query("DELETE FROM baileys_auth WHERE session_id = 'default'");
    connectionStatus = 'disconnected';
    latestQR = null;
    res.json({ success: true });
    startSock(); // immediately begin a fresh session so a new QR is generated
  } catch (err) {
    console.error('Logout failed:', err);
    res.status(500).json({ error: 'Failed to log out' });
  }
});

app.get('/qr', requireApiKey, async (req, res) => {
  if (!latestQR) {
    return res.status(404).json({ error: 'No QR available (already connected, or not generated yet)' });
  }
  const dataUrl = await QRCode.toDataURL(latestQR);
  const img = Buffer.from(dataUrl.split(',')[1], 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(img);
});

app.post('/send', requireApiKey, async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: 'Body must include { number, message }' });
  }
  if (connectionStatus !== 'connected') {
    return res.status(409).json({ error: 'WhatsApp not connected yet', status: connectionStatus });
  }
  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error('Send failed:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startSock();
});
