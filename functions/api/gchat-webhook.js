// /functions/api/gchat-webhook.js
// Google Chat calls this when someone @mentions the app in a space.
// Set the app's HTTP endpoint URL to:
//   https://<your-site>/api/gchat-webhook?token=<GCHAT_APP_TOKEN>
import { CONFIG } from "../_lib/config.js";
import { getDb, getSessionByThread, insertMessage, json, setAiMode } from "../_lib/db.js";

export async function onRequestPost({ request, env }) {
  // Without this check anyone could POST fake "agent" messages into visitor chats.
  const token = new URL(request.url).searchParams.get("token");
  if (!env.GCHAT_APP_TOKEN || token !== env.GCHAT_APP_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = await request.json().catch(() => null);
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
