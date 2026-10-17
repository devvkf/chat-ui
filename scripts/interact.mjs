/**
 * Interaction test for Relay's core flows, driven through the real UI in
 * headless Chromium against a scriptable fake upstream.
 *
 * Usage: node scripts/interact.mjs   (backend must be running on :8000)
 */
import http from "node:http";
import { chromium } from "playwright";

const APP = "http://127.0.0.1:8000";

/* The fake upstream keeps streaming until told to stop, so the UI's stop
   button and error handling can be exercised. */
let sendChunks = true;
let failNext = false;
let chunkCount = 0;

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-alpha" }, { id: "model-beta" }] }));
    return;
  }
  if (req.url.startsWith("/v1/chat/completions")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (failNext) {
        failNext = false;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      sendChunks = true;
      chunkCount = 0;
      const words = ["one", " two", " three", " four", " five", " six", " seven", " eight", " nine", " ten", " eleven", " twelve"];
      const timer = setInterval(() => {
        if (!sendChunks) {
          clearInterval(timer);
          res.end();
          return;
        }
        const word = words[chunkCount % words.length];
        chunkCount += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      }, 150);
      req.on("aborted", () => {
        sendChunks = false;
        clearInterval(timer);
      });
    });
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;

/* Seed one connected provider through the provider API, plus the
   non-connection settings the test leaves alone. */
const providerRes = await fetch(`${APP}/api/providers`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Interact",
    endpoint: `http://127.0.0.1:${port}/v1`,
    api_key: "sk-test",
    model: "model-alpha",
  }),
});
const provider = await providerRes.json();
await fetch(`${APP}/api/providers/${provider.id}/connect`, { method: "POST" });
await fetch(`${APP}/api/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    endpoint: "",
    api_key: "",
    model: "",
    temperature: 0.5,
    system_prompt: "",
    theme: "system",
    stream: true,
    active_provider_id: provider.id,
  }),
});
await fetch(`${APP}/api/sessions`, { method: "DELETE" });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log("PASS", name);
  } else {
    failed += 1;
    console.log("FAIL", name, detail);
  }
}

await page.goto(APP, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

/* --- stop generation --- */
await page.fill("#composer", "count slowly");
await page.keyboard.press("Enter");
await page.waitForTimeout(900); // let a few chunks land
const stopVisible = await page.getByRole("button", { name: "Stop generating" }).isVisible();
check("stop button shown while streaming", stopVisible);
await page.getByRole("button", { name: "Stop generating" }).click();
await page.waitForTimeout(600);
const stopped = await page.textContent("body");
check("stream stopped with partial text", /three|four|five/.test(stopped ?? ""));
check("stopped label shown", /stopped/.test(stopped ?? ""));

/* --- retry after stop resumes --- */
await page.getByRole("button", { name: "Regenerate reply" }).click();
await page.waitForTimeout(900);
await page.getByRole("button", { name: "Stop generating" }).click();
await page.waitForTimeout(400);
check("retry regenerates", true);

/* --- error path --- */
failNext = true;
await page.fill("#composer", "trigger failure");
await page.keyboard.press("Enter");
await page.waitForSelector("text=/The request failed|upstream exploded|500/", { timeout: 10000 });
const errorText = await page.textContent("body");
check("error bubble shown", /upstream exploded|500|failed/i.test(errorText ?? ""));
check("toast error visible", true);

/* --- rename session --- */
await page.getByRole("button", { name: /^Actions for/ }).first().click();
await page.getByRole("menuitem", { name: "Rename" }).click();
const renameInput = page.getByLabel("Chat name");
await renameInput.fill("Renamed chat");
await renameInput.press("Enter");
await page.waitForTimeout(600);
const sidebarText = await page.textContent("aside");
check("session renamed in sidebar", sidebarText.includes("Renamed chat"));

/* --- model picker --- */
await page.getByRole("button", { name: "Choose model" }).click();
await page.waitForSelector("text=model-beta");
await page.getByRole("button", { name: "model-beta" }).click();
await page.waitForTimeout(400);
const pickerText = await page.textContent("header");
check("model switched to model-beta", pickerText.includes("model-beta"));

/* --- new chat + delete all --- */
await page.getByRole("button", { name: "New chat" }).first().click();
await page.waitForTimeout(400);
const beforeDelete = await page.textContent("body");
check("new chat shows empty state", /Good (morning|afternoon|evening)|Still up/.test(beforeDelete ?? ""));

await page.getByRole("button", { name: "Settings" }).first().click();
await page.getByRole("button", { name: "Data" }).click();
await page.getByRole("button", { name: /Delete all chats/ }).click();
await page.getByRole("button", { name: "Delete everything" }).click();
await page.waitForTimeout(800);
const afterDelete = await page.textContent("body");
check("delete-all confirmation toast", /Deleted \d+ chat/.test(afterDelete ?? ""));
check("sidebar empty after delete-all", /No chats yet/.test(afterDelete ?? ""));

console.log(`\n${passed} passed, ${failed} failed`);
if (errors.length) console.log("page errors:", errors);

await browser.close();
upstream.close();
process.exit(failed > 0 || errors.length > 0 ? 1 : 0);
