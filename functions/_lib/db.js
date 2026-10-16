// D1 storage shared by /api/chat and /api/gchat-webhook.
// Messages are insert-only rows, so the visitor's POST and the Google Chat
// webhook never overwrite each other's writes.
import { CONFIG } from "./config.js";

const RETENTION_MS = CONFIG.retentionDays * 24 * 60 * 60 * 1000;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, ai_mode INTEGER NOT NULL DEFAULT 1, gchat_thread TEXT, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_chat_sessions_thread ON chat_sessions (gchat_thread)",
  "CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sender TEXT NOT NULL, agent_name TEXT, is_ai INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, element_context TEXT, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages (created_at)",
  "CREATE TABLE IF NOT EXISTS chat_rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chat_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

// Pages Functions have no cron, so expired rows are purged on the next request instead,
// at most this often per isolate. Reads also skip anything past retention, so an expired
// chat is never shown even if nobody has visited since.
const PURGE_EVERY_MS = 10 * 60 * 1000;

// Tables are created on first use per isolate, so setup is just "create a D1
// database and bind it as CHAT_DB". Re-running is harmless (IF NOT EXISTS).
let schemaReady = false;
let lastPurge = 0;

export async function getDb(env) {
  if (!env.CHAT_DB) throw new Error("CHAT_DB (D1) binding is missing");
  const db = env.CHAT_DB;
  if (!schemaReady) {
    await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
    schemaReady = true;
  }
  if (Date.now() - lastPurge > PURGE_EVERY_MS) {
    lastPurge = Date.now();
    await purgeExpired(db);
  }
  return db;
}

const retentionCutoff = () => Date.now() - RETENTION_MS;

function purgeExpired(db) {
  const cutoff = retentionCutoff();
  return db.batch([
    db.prepare("DELETE FROM chat_messages WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM chat_sessions WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM chat_rate_limits WHERE window_start < ?").bind(Date.now() - 24 * 60 * 60 * 1000),
  ]);
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function getSession(db, sessionId) {
  return db
    .prepare("SELECT * FROM chat_sessions WHERE id = ? AND created_at >= ?")
    .bind(sessionId, retentionCutoff())
    .first();
}

export function getSessionByThread(db, threadName) {
  return db
    .prepare("SELECT * FROM chat_sessions WHERE gchat_thread = ? AND created_at >= ?")
    .bind(threadName, retentionCutoff())
    .first();
}

// A visitor whose old session expired keeps the same id in their browser, so an expired
// row with that id (and its leftover messages) is reset instead of being reused.
export async function createSession(db, sessionId) {
  const cutoff = retentionCutoff();
  await db.batch([
    db
      .prepare("DELETE FROM chat_messages WHERE session_id = ? AND EXISTS (SELECT 1 FROM chat_sessions WHERE id = ? AND created_at < ?)")
      .bind(sessionId, sessionId, cutoff),
    db
      .prepare(
        "INSERT INTO chat_sessions (id, ai_mode, created_at) VALUES (?, 1, ?) " +
          "ON CONFLICT(id) DO UPDATE SET ai_mode = 1, gchat_thread = NULL, created_at = excluded.created_at " +
          "WHERE chat_sessions.created_at < ?"
      )
      .bind(sessionId, Date.now(), cutoff),
  ]);
}

// Fixed-window counter: returns true once `key` has gone over `limit` in the current window.
export async function overRateLimit(db, key, limit, windowMs) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await db
    .prepare(
      "INSERT INTO chat_rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, " +
        "window_start = excluded.window_start RETURNING count"
    )
    .bind(key, windowStart)
    .first();
  return row.count > limit;
}

// Rate-limit keys are an HMAC of the IP under a random per-database secret, created on first
// use. A plain hash wouldn't do: there are few enough IPv4 addresses to hash them all and
// match the table. Without the secret, the stored keys can't be traced back to an IP.
let ipKeyPromise = null;

function getIpKey(db) {
  ipKeyPromise ??= (async () => {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    await db.prepare("INSERT OR IGNORE INTO chat_settings (key, value) VALUES ('ip_hash_secret', ?)").bind(random).run();
    const { value } = await db.prepare("SELECT value FROM chat_settings WHERE key = 'ip_hash_secret'").first();
    return crypto.subtle.importKey("raw", new TextEncoder().encode(value), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })().catch((err) => {
    ipKeyPromise = null; // let the next request retry
    throw err;
  });
  return ipKeyPromise;
}

export async function hashIp(db, ip) {
  const mac = await crypto.subtle.sign("HMAC", await getIpKey(db), new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(mac).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function setAiMode(db, sessionId, aiMode) {
  return db.prepare("UPDATE chat_sessions SET ai_mode = ? WHERE id = ?").bind(aiMode ? 1 : 0, sessionId).run();
}

export function setGoogleThread(db, sessionId, threadName) {
  return db
    .prepare("UPDATE chat_sessions SET gchat_thread = ? WHERE id = ? AND gchat_thread IS NULL")
    .bind(threadName, sessionId)
    .run();
}

export async function listMessages(db, sessionId, limit = 100) {
  const { results } = await db
    .prepare(
      "SELECT * FROM (SELECT *, rowid AS seq FROM chat_messages WHERE session_id = ? AND created_at >= ? ORDER BY created_at DESC, seq DESC LIMIT ?) ORDER BY created_at, seq"
    )
    .bind(sessionId, retentionCutoff(), limit)
    .all();
  return results.map(toClientMessage);
}

export async function insertMessage(db, sessionId, { sender, text, agentName = null, isAi = false, elementContext = null }) {
  const row = {
    id: crypto.randomUUID(),
    session_id: sessionId,
    sender,
    agent_name: agentName,
    is_ai: isAi ? 1 : 0,
    text,
    element_context: elementContext,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO chat_messages (id, session_id, sender, agent_name, is_ai, text, element_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(row.id, row.session_id, row.sender, row.agent_name, row.is_ai, row.text, row.element_context, row.created_at)
    .run();
  return toClientMessage(row);
}

function toClientMessage(row) {
  return {
    id: row.id,
    sender: row.sender,
    agentName: row.agent_name,
    isAi: Boolean(row.is_ai),
    text: row.text,
    elementContext: row.element_context,
    timestamp: row.created_at,
  };
}
