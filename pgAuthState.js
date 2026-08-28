// pgAuthState.js
// A Postgres-backed replacement for Baileys' useMultiFileAuthState.
// Necessary on Render (and any host with ephemeral disk) because local
// files get wiped on every restart/redeploy, forcing a QR re-scan.

const { proto } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS baileys_auth (
      session_id TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value JSONB,
      PRIMARY KEY (session_id, key_name)
    );
  `);
}

async function usePostgresAuthState(pool, sessionId = 'default') {
  await ensureTable(pool);

  const readData = async (key) => {
    const res = await pool.query(
      'SELECT value FROM baileys_auth WHERE session_id = $1 AND key_name = $2',
      [sessionId, key]
    );
    if (res.rows.length === 0) return null;
    // Stored as text so BufferJSON can revive Buffers/Uint8Arrays correctly
    return JSON.parse(JSON.stringify(res.rows[0].value), BufferJSON.reviver);
  };

  const writeData = async (key, value) => {
    const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO baileys_auth (session_id, key_name, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, key_name)
       DO UPDATE SET value = EXCLUDED.value`,
      [sessionId, key, json]
    );
  };

  const removeData = async (key) => {
    await pool.query(
      'DELETE FROM baileys_auth WHERE session_id = $1 AND key_name = $2',
      [sessionId, key]
    );
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}

module.exports = { usePostgresAuthState };
