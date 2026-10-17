/**
 * Visual smoke test: runs a fake OpenAI-compatible upstream, points the app's
 * settings at it, then drives the real UI in headless Chromium and captures
 * screenshots of every key screen.
 *
 * Usage: node scripts/shoot.mjs   (backend must be running on :8000)
 */
import http from "node:http";
import { chromium } from "playwright";

const APP = "http://127.0.0.1:8000";
const OUT = "screenshots";

const REPLY = [
  "Here", " are", " three", " things", " to", " check", ":\n\n",
  "1. ", "**The", " NPE", " on", " line", " 42**", " —", " `", "user", ".", "profile", "`",
  " is", " null", " when", " the", " session", " expired", ".\n",
  "2. ", "The", " retry", " loop", " has", " no", " backoff", ".\n",
  "3. ", "Your", " index", " on", " `", "sessions", "(", "user_id", ")`", " is", " unused", ".\n\n",
  "```ts\n", "const profile = user.profile ?? {};\n", "```\n\n",
  "Want", " me", " to", " draft", " the", " patch", "?",
];

const PATCH_REPLY = [
  "Sure", " —", " here", " is", " the", " patch", ":\n\n",
  "```diff\n", "- const profile = user.profile.name;\n",
  "+ const profile = user.profile?.name ?? \"anonymous\";\n", "```\n\n",
  "I", " also", " added", " exponential", " backoff", " to", " the", " retry", " loop", ".",
];

/* --- fake OpenAI-compatible upstream --- */
const upstream = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  if (req.url.startsWith("/v1/models") && req.method === "GET") {
    if (!auth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing key" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "mistral-large-latest" },
          { id: "qwen2.5-coder-32b-instruct" },
          { id: "llama-3.3-70b-versatile" },
          { id: "deepseek-chat" },
        ],
      }),
    );
    return;
  }
  if (req.url.startsWith("/v1/chat/completions")) {
    if (!auth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing key" }));
      return;
    }
    // Read the request body so replies can differ per prompt.
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const wantsPatch = /draft it/i.test(body);
      const reply = wantsPatch ? PATCH_REPLY : REPLY;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      let i = 0;
      const timer = setInterval(() => {
        if (i < reply.length) {
          const payload = JSON.stringify({ choices: [{ delta: { content: reply[i] } }] });
          res.write(`data: ${payload}\n\n`);
          i += 1;
          return;
        }
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        res.end();
      }, 30);
      req.on("aborted", () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;
console.log(`fake upstream on :${port}`);

/* --- point the app at it: save a provider and connect it --- */
const providerRes = await fetch(`${APP}/api/providers`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Screenshots",
    endpoint: `http://127.0.0.1:${port}/v1`,
    api_key: "sk-fake-key-for-screenshots",
    model: "mistral-large-latest",
  }),
});
const provider = await providerRes.json();
console.log("provider:", providerRes.status, provider.id);
await fetch(`${APP}/api/providers/${provider.id}/connect`, { method: "POST" });
await fetch(`${APP}/api/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    endpoint: "",
    api_key: "",
    model: "",
    temperature: 0.4,
    system_prompt: "You are a terse senior engineer.",
    theme: "system",
    stream: true,
    active_provider_id: provider.id,
  }),
});
await fetch(`${APP}/api/sessions`, { method: "DELETE" });

/* --- drive the UI --- */
const browser = await chromium.launch();
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("PAGE ERROR:", m.text());
});
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", e.message));

await page.goto(APP, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await shot(page, "01-empty-light");

// send a message and watch it stream
await page.fill("#composer", "Here's a stack trace — what's the likely cause?");
await shot(page, "02-typed");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await shot(page, "03-streaming");
await page.waitForSelector("text=/Want me to draft/", { timeout: 15000 });
await page.waitForTimeout(400);
await shot(page, "04-reply-light");

// second exchange to show history
await page.fill("#composer", "Yes, draft it.");
await page.keyboard.press("Enter");
await page.waitForSelector("text=/exponential backoff/", { timeout: 15000 });
await page.waitForTimeout(400);
await shot(page, "04b-history-light");

// settings dialog
await page.getByRole("button", { name: "Settings" }).first().click();
await page.waitForTimeout(500);
await shot(page, "05-settings-connection");
await page.getByRole("button", { name: "Test connection" }).click();
await page.waitForTimeout(1200);
await shot(page, "06-settings-tested");
await page.getByRole("button", { name: "Appearance" }).click();
await page.getByRole("button", { name: "dark", exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Data" }).click();
await page.waitForTimeout(300);
await shot(page, "07-settings-data-dark");
await page.getByRole("button", { name: "Privacy" }).click();
await page.waitForTimeout(300);
await shot(page, "08-settings-privacy-dark");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await shot(page, "09-chat-dark");

// privacy dialog
await page.getByRole("button", { name: "Privacy" }).first().click();
await page.waitForTimeout(400);
await shot(page, "10-privacy-dialog");
await page.keyboard.press("Escape");

// back to light, sidebar search + model picker
await page.emulateMedia({ colorScheme: "light" });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.fill('input[aria-label="Search chats"]', "");
await page.getByRole("button", { name: "Choose model" }).click();
await page.waitForTimeout(400);
await shot(page, "11-model-picker");
await page.keyboard.press("Escape");

// mobile
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(APP, { waitUntil: "networkidle" });
await mobile.waitForTimeout(700);
await shot(mobile, "12-mobile-light");
await mobile.getByRole("button", { name: "Open chats" }).click();
await mobile.waitForTimeout(500);
await shot(mobile, "13-mobile-sidebar");

await browser.close();
upstream.close();
console.log("done");
