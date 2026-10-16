// Tests for Google Chat request verification. Run with: npm test
// Google's key endpoints are stubbed with a locally generated key.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { safeEqual, verifyGoogleChatToken } from "../functions/_lib/google-auth.js";

const ENDPOINT = "https://example.com/api/gchat-webhook?token=abc";
const ADDON_ACCOUNT = "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
const KID = "test-key";
let privateKey;

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const encodeJson = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

async function sign(claims, header = { alg: "RS256", kid: KID }) {
  const body = `${encodeJson(header)}.${encodeJson(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const idClaims = (extra = {}) => ({
  iss: "https://accounts.google.com",
  aud: ENDPOINT,
  email: "chat@system.gserviceaccount.com",
  email_verified: true,
  iat: nowS(),
  exp: nowS() + 3600,
  ...extra,
});

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  privateKey = pair.privateKey;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: KID, alg: "RS256" };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "public, max-age=3600" } });
});

test("accepts a valid ID token from Chat", async () => {
  assert.equal(await verifyGoogleChatToken(await sign(idClaims()), { audience: ENDPOINT }), null);
});

test("accepts a valid ID token from a Workspace add-on when its account is configured", async () => {
  const token = await sign(idClaims({ email: ADDON_ACCOUNT }));
  assert.equal(await verifyGoogleChatToken(token, { audience: ENDPOINT, serviceAccount: ADDON_ACCOUNT }), null);
  assert.equal(await verifyGoogleChatToken(token, { audience: ENDPOINT }), "wrong signer");
});

test("rejects tokens for another audience", async () => {
  const token = await sign(idClaims({ aud: "https://attacker.example/hook" }));
  assert.equal(await verifyGoogleChatToken(token, { audience: ENDPOINT }), "wrong audience");
});

test("rejects expired tokens", async () => {
  const token = await sign(idClaims({ exp: nowS() - 600 }));
  assert.equal(await verifyGoogleChatToken(token, { audience: ENDPOINT }), "token expired");
});

test("rejects unverified or wrong signer emails", async () => {
  assert.equal(await verifyGoogleChatToken(await sign(idClaims({ email_verified: false })), { audience: ENDPOINT }), "wrong signer");
  assert.equal(await verifyGoogleChatToken(await sign(idClaims({ email: "someone@gmail.com" })), { audience: ENDPOINT }), "wrong signer");
});

test("rejects a wrong issuer", async () => {
  assert.equal(await verifyGoogleChatToken(await sign(idClaims({ iss: "https://evil.example" })), { audience: ENDPOINT }), "wrong issuer");
});

test("rejects tampered payloads and other algorithms", async () => {
  const [h, , s] = (await sign(idClaims())).split(".");
  const forged = `${h}.${encodeJson(idClaims({ email: "x@y.z" }))}.${s}`;
  assert.equal(await verifyGoogleChatToken(forged, { audience: ENDPOINT }), "bad signature");
  assert.equal(await verifyGoogleChatToken(await sign(idClaims(), { alg: "none", kid: KID }), { audience: ENDPOINT }), "unexpected token algorithm");
  assert.equal(await verifyGoogleChatToken(await sign(idClaims(), { alg: "RS256", kid: "other" }), { audience: ENDPOINT }), "unknown signing key");
  assert.equal(await verifyGoogleChatToken("not-a-jwt", { audience: ENDPOINT }), "malformed token");
  assert.equal(await verifyGoogleChatToken(undefined, { audience: ENDPOINT }), "missing bearer token");
});

test("project-number mode checks the self-signed Chat issuer", async () => {
  const claims = { iss: "chat@system.gserviceaccount.com", aud: "1234567890", iat: nowS(), exp: nowS() + 3600 };
  assert.equal(await verifyGoogleChatToken(await sign(claims), { audience: "1234567890" }), null);
  assert.equal(
    await verifyGoogleChatToken(await sign({ ...claims, iss: "https://accounts.google.com" }), { audience: "1234567890" }),
    "wrong issuer"
  );
});

test("safeEqual compares exactly", async () => {
  assert.equal(await safeEqual("abc", "abc"), true);
  assert.equal(await safeEqual("abc", "abd"), false);
  assert.equal(await safeEqual("", "abc"), false);
});
