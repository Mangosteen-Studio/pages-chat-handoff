# pages-chat-handoff

Free AI chat for any site on Cloudflare Pages. When the AI can't help, the chat hands off to your team in Google Chat. Your replies go straight back to the visitor's chat window. Visitors can also point at the part of the page they're asking about.

- **The AI answers first.** Workers AI replies using only what you put in one text file. Gemini is an optional fallback.
- **Handoff is deterministic.** "Can I talk to a person?", the person button, or anything the knowledge doesn't cover pings your Google Chat space, in a thread for that visitor. The visitor is only told the team has it once Google Chat actually accepts the message.
- **Your team replies from Google Chat.** @mention the app in the visitor's thread and the reply lands in their chat within seconds. `@YourApp /ai` gives the chat back to the AI.
- **Point.** Visitors click Point, then click anything on the page. That element's text goes along with the question, to the AI and to your team.

It's about 1,000 lines of plain JavaScript: no framework, no build step, no dependencies beyond wrangler.

## What it costs

$0 on Cloudflare, as long as you stay inside the free tiers:

| Piece | Free tier |
| --- | --- |
| Pages + Pages Functions | Workers free plan (100k requests/day) |
| D1 | Free tier; transcripts are deleted after 7 days |
| Workers AI | 10,000 neurons/day. About 125 replies on the default Llama 3.3 70B, roughly 6x that on Llama 3.1 8B |
| Google Chat | Needs a Google Workspace account you already pay for. Personal Gmail can't create Chat apps or webhooks |

When the daily neurons run out, Workers AI errors. Then the chat falls back to Gemini if you set a key, or hands off to your team if you didn't. It never silently breaks.

## Try it locally (2 minutes)

```bash
npm install
npm run dev
```

Open http://localhost:8788. The AI binding is off in `npm run dev`, so every message tries to hand off. Until you add a Google Chat webhook to `.dev.vars`, the visitor is told the team couldn't be reached, which is exactly what production does when Google Chat is down. To get real AI answers, run `npm run dev:ai` instead. It uses your `wrangler login` and spends your account's free neurons, even locally.

## Setup (about 10 minutes)

You need a Cloudflare Pages project, Node 22+ (current wrangler requires it), and a Google Workspace account with Google Chat. Your Workspace admin has to allow incoming webhooks and Chat apps.

### 1. Copy the files into your site

- `functions/` goes at the root of your Pages project: the folder you deploy from, or the repo root with Git integration. If you already have a `functions/` folder, merge `api/chat.js`, `api/gchat-webhook.js` and `_lib/` into it.
- `public/chat-widget.js` goes in whatever folder your site serves at `/` (`public/`, `static/`, `out/`…).
- Add the script tag before `</body>`:

```html
<script src="/chat-widget.js" defer data-name="Acme" data-email="hello@acme.com"></script>
```

Then edit `functions/_lib/config.js` (names, email, greeting) and `functions/_lib/knowledge.txt` (what the bot knows). See [Configure](#configure).

### 2. Create the database

```bash
npx wrangler d1 create chat-handoff
```

You don't need migrations. Tables are created on the first request.

### 3. Add the bindings

In the Cloudflare dashboard, open Workers & Pages → your project → Settings → Bindings, and add:

- **D1 database**, variable name `CHAT_DB`, pointing at `chat-handoff`
- **Workers AI**, variable name `AI`

Do this for Production, and for Preview too if you use preview deployments. Bindings take effect on the next deployment.

> Don't add a `wrangler.toml` with `pages_build_output_dir` just for this. Once that file exists it's the source of truth for every binding and variable. The dashboard goes read-only, and anything not in the file is dropped.

### 4. Create the space webhook (site → Google Chat)

In Google Chat, create a space for site chats (or use an existing one). Click the space name → Apps & integrations → Webhooks → Add. Name it after your site and copy the URL. Treat the whole URL as a secret: anyone with it can post into your space.

### 5. Create the Chat app (Google Chat → site)

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project in your Workspace organization and enable the **Google Chat API**.
2. Generate the token that protects the endpoint:
   ```bash
   openssl rand -hex 24
   ```
3. Go to Google Chat API → Configuration and fill it in:
   - **App name:** whatever your team will @mention, e.g. `Customer`. It must match `chatAppName` in `config.js`.
   - **Avatar URL** and **description:** anything.
   - **Interactive features:** on, with "Join spaces and group conversations" checked.
   - **Connection settings:** HTTP endpoint URL. If it's built as a Google Workspace add-on, choose the option to use one common HTTP endpoint URL for all triggers. Set it to `https://<your-site>/api/gchat-webhook?token=<the token from step 2>`
   - **Visibility:** you and the people who'll answer chats.
4. Back in the space: Apps & integrations → Add apps → your app.

The endpoint accepts both the classic Chat app payload and the Workspace add-on payload, so either build works.

### 6. Set the secrets

```bash
npx wrangler pages secret put GCHAT_SPACE_WEBHOOK_URL --project-name <your-project>
npx wrangler pages secret put GCHAT_APP_TOKEN --project-name <your-project>
# optional fallback when Workers AI errors or runs out of neurons
npx wrangler pages secret put GEMINI_API_KEY --project-name <your-project>
```

These commands set Production. Add Preview values under Settings → Variables and Secrets if you need them.

### 7. Deploy and test

Deploy the way you normally do, or run `npm run deploy` for this demo. Then:

1. Ask something your knowledge file covers. The AI should answer.
2. Click the person button, or type "can I talk to a human?". A thread should appear in your space, tagged @all.
3. In Google Chat, hit **Reply** on that message and type `@Customer it's me, what's up?`. It should show up in the visitor's chat within a few seconds.
4. Send `@Customer /ai` in the thread to hand the chat back to the AI.

If the Google Chat secrets are missing, or Google rejects the post, the chat still works. The visitor is told the team couldn't be reached and pointed at your contact email, and the AI stays on instead of leaving them waiting.

## Testing the Google Chat loop locally

Google can't reach localhost, so expose your dev server with a Cloudflare quick tunnel (`brew install cloudflared`):

```bash
cp .dev.vars.example .dev.vars   # fill in the webhook URL and token
npm run dev                      # terminal 1
npm run tunnel                   # terminal 2
```

The tunnel prints a `https://<random>.trycloudflare.com` URL. Set the Chat app's endpoint to `https://<random>.trycloudflare.com/api/gchat-webhook?token=<token>`. The URL changes every time the tunnel restarts. Switch the endpoint back to production when you're done, or production replies will stop arriving.

`npm run dev` runs without AI, so every message hands off. That's exactly what you want for testing this loop.

## Configure

**Server: `functions/_lib/config.js`**

| Key | What it does |
| --- | --- |
| `appName` | Used in Google Chat alerts ("New Acme chat") and as the assistant's identity |
| `contactEmail` | Offered on handoff, on errors, and when a chat hits its limit. `""` hides it |
| `demoUrl` | Optional link the AI points people to (demo, signup, docs) |
| `greeting` | Prepended to the first reply unless the model already said hi |
| `roleQuestion`, `roleKeywords` | Asked after the first answer, unless the visitor already mentioned one of the keywords. `""` turns it off |
| `chatAppName` | Your Google Chat app's name, used in the "start with @…" hints |
| `aiModel`, `geminiModel` | Workers AI model and Gemini fallback model |
| `maxMessageLength`, `maxVisitorMessages`, `maxMessagesPerIpPerHour`, `maxPointedContextLength`, `retentionDays` | Limits |

**Widget: `data-*` attributes on the script tag**

| Attribute | Default |
| --- | --- |
| `data-name` | `Chat`. Used in labels ("Ask Acme") |
| `data-ai-name` | `<name> AI`. Shown on AI messages |
| `data-email` | none. Shown in the handoff note and error messages. Usually the same as `contactEmail` |
| `data-placeholder` | `Ask anything, or point at the page…` |
| `data-api` | `/api/chat` |

**Look: CSS variables.** Set them on `:root` and they win over the defaults:

```css
:root {
  --pc-accent: #e11d48;          /* buttons, visitor bubbles, the Point highlight */
  --pc-accent-text: #ffffff;     /* text on the accent color */
  --pc-bg: rgba(20, 20, 23, 0.92);
  --pc-text: #f4f4f5;
  --pc-muted: #a1a1aa;
  --pc-ai: #fbbf24;              /* status light while the AI is answering */
  --pc-human: #34d399;           /* status light and border once your team is on */
  --pc-error: #f87171;
  --pc-font: "Inter", sans-serif;   /* load the font on your page as usual */
  --pc-font-mono: "IBM Plex Mono", monospace;
}
```

For a light theme, flip `--pc-bg` and `--pc-text`. Every border and tint is derived from those two.

## Teaching the bot

`functions/_lib/knowledge.txt` is the only thing the model knows about you. Write it as plain text in whatever structure you like: voice, facts, pricing, and a "hand off when" section for the cases where you want a person to answer (pricing talks, security reviews, billing).

The rules the code depends on live in `functions/api/chat.js`, not in the knowledge file: short plain-text replies, no greeting, the `[HANDOFF]` marker, and ignoring prompt injection. That way, rewriting the knowledge can't break handoff. Asking for a person is also caught in code before the model runs, so that never depends on the model behaving. Only explicit asks count ("can I talk to someone", "live agent", the person button), so a question like "is this human-reviewed?" stays with the AI.

Edit the file and redeploy. The model repeats whatever is in it, so keep it current when pricing or features change.

## How it works

```
visitor ──POST /api/chat──▶ D1 (append-only messages)
                           ├─▶ Workers AI ─(error)─▶ Gemini ─(error)─▶ handoff
                           └─▶ space incoming webhook, threadKey = session id
                                  (thread name saved, so replies can find the visitor)

teammate: Reply + @App ──▶ Google Chat ──POST /api/gchat-webhook?token=…──▶ D1, AI paused

widget ──GET /api/chat (polls)──▶ new messages
```

- Messages are insert-only rows, so a visitor's message and a team reply arriving at the same moment can't overwrite each other.
- A handoff waits for Google Chat to accept the post before telling the visitor anyone was pinged. Plain AI answers are mirrored in the background, so visitors never wait on Google for those.
- The widget only polls while a chat is live: every 3.5s during a handoff, 15s otherwise. It stops after 20 idle minutes or when the tab is hidden. Visitors who never type never call the API.
- The bar renders in a shadow root, so your site's CSS can't break it. The only thing it adds to your DOM is the Point highlight and pin.
- Visitor and AI text is escaped before it goes to Google Chat, so nobody can inject `@all` mentions or links into your space.

## Known limits

- **Team replies must @mention the app, as a Reply in the visitor's thread.** Google Chat only sends @mentioned messages to apps in a space. Plain replies, and messages in the space's main box, never reach the site.
- **It doesn't run on projects with a `_worker.js`.** If your build output has a `_worker.js` (next-on-pages does, and so do some other framework adapters), Cloudflare ignores the `functions/` folder. You'd need to route `/api/chat` and `/api/gchat-webhook` inside that worker yourself. Static exports, including Next.js `output: "export"`, work fine.
- **A custom `_routes.json` has to include `/api/*`,** or the functions never run.
- **The endpoint is protected by a shared token in the URL.** Anyone with the full Chat app endpoint URL can post replies as your team, so keep it private. To rotate it, change `GCHAT_APP_TOKEN` and the endpoint URL together. Google also signs each request with a bearer token; verifying that would be stronger, and it isn't implemented.
- **Rate limiting is basic.** Session IDs come from the browser, so the real limit is per IP: 60 messages an hour by default (`maxMessagesPerIpPerHour`). Counts live in D1 under a truncated hash of the IP, never the raw address, and are cleared after a day. That stops casual abuse; for anything heavier, add a Cloudflare WAF rate-limiting rule on `/api/chat`.
- **Polling, not websockets.** Expect a few seconds between your reply and the visitor seeing it.
- **Transcripts are readable by anyone holding the session ID.** It's a random UUID stored in the visitor's browser, and chats are deleted after `retentionDays`. You're also storing visitor messages in D1 and in Google Chat, so mention that in your privacy policy.
- **It's an LLM.** Low temperature and a strict brief keep it on script, but it can still be wrong. Keep `knowledge.txt` tight.

## License

[MIT](LICENSE)
