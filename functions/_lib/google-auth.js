// Verifies the token Google Chat signs every request with (Authorization: Bearer …).
// https://developers.google.com/workspace/chat/verify-requests-from-chat
//
// GCHAT_AUDIENCE picks the mode, matching "Authentication Audience" in the Chat API config:
// - a URL: Google sends an OIDC ID token whose audience is that endpoint URL, signed for
//   GCHAT_SERVICE_ACCOUNT (chat@system.gserviceaccount.com, or the add-on's own account)
// - digits: Google sends a JWT self-signed by chat@system.gserviceaccount.com whose audience
//   is that project number (classic Chat apps only)

const CHAT_SYSTEM_ACCOUNT = "chat@system.gserviceaccount.com";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const ID_TOKEN_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const PROJECT_KEYS_URL = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_SYSTEM_ACCOUNT}`;
const CLOCK_SKEW_S = 60;
const DEFAULT_KEY_TTL_MS = 60 * 60 * 1000;

// Signing keys, cached per isolate and refetched when they expire or a token names an unknown key.
const keyCache = new Map(); // url -> { keys: Map<kid, CryptoKey>, expiresAt }

const textEncoder = new TextEncoder();

function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function loadKeys(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch Google signing keys (${res.status})`);
  const { keys = [] } = await res.json();
  const imported = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
    );
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1]);
  const entry = { keys: imported, expiresAt: Date.now() + (maxAge ? maxAge * 1000 : DEFAULT_KEY_TTL_MS) };
  keyCache.set(url, entry);
  return entry;
}

async function getKey(url, kid) {
  let entry = keyCache.get(url);
  if (!entry || entry.expiresAt < Date.now() || !entry.keys.has(kid)) entry = await loadKeys(url);
  return entry.keys.get(kid);
}

// Returns null when the token is valid, otherwise a short reason (for logs, never for the caller).
export async function verifyGoogleChatToken(token, { audience, serviceAccount = CHAT_SYSTEM_ACCOUNT, now = Date.now() }) {
  if (!token) return "missing bearer token";
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed token";

  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return "malformed token";
  }
  if (header.alg !== "RS256" || !header.kid) return "unexpected token algorithm";

  const projectMode = /^\d+$/.test(audience);
  const key = await getKey(projectMode ? PROJECT_KEYS_URL : ID_TOKEN_KEYS_URL, header.kid);
  if (!key) return "unknown signing key";

  const signed = textEncoder.encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), signed))) {
    return "bad signature";
  }

  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp < nowS - CLOCK_SKEW_S) return "token expired";
  if (typeof claims.iat === "number" && claims.iat > nowS + CLOCK_SKEW_S) return "token issued in the future";
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return "wrong audience";

  if (projectMode) {
    if (claims.iss !== CHAT_SYSTEM_ACCOUNT) return "wrong issuer";
  } else {
    if (!GOOGLE_ISSUERS.includes(claims.iss)) return "wrong issuer";
    if (claims.email !== serviceAccount || claims.email_verified !== true) return "wrong signer";
  }
  return null;
}

// Constant-time string comparison (both sides are hashed first, so lengths always match).
export async function safeEqual(a, b) {
  const [da, db] = await Promise.all(
    [a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(String(s)))))
  );
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}
