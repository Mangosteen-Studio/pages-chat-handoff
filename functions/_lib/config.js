// Everything site-specific on the server side lives here. The bot's facts live in
// knowledge.txt next to this file. Widget text and colors are set on the <script> tag
// and with CSS variables (see the README).

export const CONFIG = {
  // Shown in Google Chat alerts ("New Handoff chat") and used as the assistant's identity.
  appName: "Handoff",

  // Offered to visitors when the team is pinged, the chat errors, or a chat hits its limit.
  // Leave "" to never mention an email.
  contactEmail: "hello@example.com",

  // Optional link the AI points people to when it fits (demo booking, signup, docs). "" to skip.
  demoUrl: "",

  // The first reply in every chat starts with this unless the model already said hi.
  greeting: "Hey there!",

  // Asked after the first answer, unless the visitor already used one of roleKeywords.
  // Set roleQuestion to "" to skip it.
  roleQuestion: "Quick question so I can point you the right way: are you a developer, a founder, or something else?",
  roleKeywords: ["developer", "engineer", "dev", "founder", "ceo", "cto", "marketer", "marketing", "designer", "agency"],

  // The Google Chat app's name, exactly as teammates @mention it in the space.
  chatAppName: "Customer",

  // Cloudflare Workers AI model. 70B costs ~80 neurons per reply (~125 free replies/day).
  // "@cf/meta/llama-3.1-8b-instruct-fp8-fast" gets you ~6x more free replies.
  aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  // Used only when GEMINI_API_KEY is set and Workers AI errors or runs out of free neurons.
  geminiModel: "gemini-2.5-flash",

  maxMessageLength: 1000,
  maxVisitorMessages: 30, // per chat
  // Session IDs come from the browser, so the real abuse limit is per IP (stored only as a hash).
  maxMessagesPerIpPerHour: 60,
  maxPointedContextLength: 200, // characters of the element a visitor pointed at
  retentionDays: 7,
};
