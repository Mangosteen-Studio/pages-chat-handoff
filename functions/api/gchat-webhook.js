// /functions/api/gchat-webhook.js
// Google Chat calls this when someone @mentions the app in a space.
// Set the app's HTTP endpoint URL to:
//   https://<your-site>/api/gchat-webhook?token=<GCHAT_APP_TOKEN>
import { CONFIG } from "../_lib/config.js";
import { getDb, getSessionByThread, insertMessage, json, setAiMode } from "../_lib/db.js";
import { safeEqual, verifyGoogleChatToken } from "../_lib/google-auth.js";

// Without this check anyone could POST fake "agent" messages into visitor chats.
// GCHAT_APP_TOKEN checks the shared token in the URL; GCHAT_AUDIENCE checks the token Google
// signs every request with. Set at least one; when both are set, both must pass.
// Returns null when the request is allowed, otherwise a reason for the logs.
async function rejectReason(request, env, payload) {
  if (!env.GCHAT_APP_TOKEN && !env.GCHAT_AUDIENCE) return "neither GCHAT_APP_TOKEN nor GCHAT_AUDIENCE is set";

  if (env.GCHAT_APP_TOKEN) {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!(await safeEqual(token, env.GCHAT_APP_TOKEN))) return "bad ?token";
  }

  if (env.GCHAT_AUDIENCE) {
    const bearer =
      /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "")?.[1] ||
      payload?.authorizationEventObject?.systemIdToken;
    try {
      return await verifyGoogleChatToken(bearer, {
        audience: env.GCHAT_AUDIENCE,
        serviceAccount: env.GCHAT_SERVICE_ACCOUNT || undefined,
      });
    } catch (err) {
      return `couldn't verify Google's token: ${err.message}`;
    }
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  const payload = await request.json().catch(() => null);

  const reason = await rejectReason(request, env, payload);
  if (reason) {
    console.warn("gchat-webhook: rejected request:", reason);
    return new Response("Unauthorized", { status: 401 });
  }

  // Classic Chat apps send payload.message; Workspace add-on Chat apps nest it under payload.chat
  const message = payload?.message || payload?.chat?.messagePayload?.message;
  const reply = (text) => {
    if (!text) return json({});
    return json(
      payload?.chat
        ? { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } }
        : { text }
    );
  };

  // ADDED_TO_SPACE, REMOVED_FROM_SPACE, bot messages, etc.
  if (!message?.thread?.name || message.sender?.type === "BOT") return reply();

  try {
    const db = await getDb(env);
    const session = await getSessionByThread(db, message.thread.name);
    if (!session) {
      console.warn("gchat-webhook: no chat session for thread", message.thread.name);
      return reply(
        `⚠️ I can't tell which visitor this is for. Hit *Reply* on the visitor's message and start with @${CONFIG.chatAppName}. (Chats older than ${CONFIG.retentionDays} days expire.)`
      );
    }

    // argumentText is the message with the @app mention stripped
    const cleanReplyText = (message.argumentText ?? message.text ?? "").trim();
    if (!cleanReplyText) return reply();

    if (cleanReplyText.toLowerCase() === "/ai") {
      await setAiMode(db, session.id, true);
      return reply("🤖 AI Assistant re-enabled for this thread.");
    }

    // A human replied: AI stops talking and the message goes to the visitor's widget
    await setAiMode(db, session.id, false);
    await insertMessage(db, session.id, {
      sender: "agent",
      agentName: message.sender?.displayName?.split(" ")[0] || "Team",
      text: cleanReplyText,
    });
    return reply();
  } catch (err) {
    console.error("gchat-webhook failed:", err);
    return reply("⚠️ Couldn't deliver that to the website visitor. Check the Pages Functions logs.");
  }
}
