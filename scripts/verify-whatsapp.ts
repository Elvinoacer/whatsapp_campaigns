import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import wwebjs from "whatsapp-web.js";
import { discoverWhatsApp } from "../worker/discovery";
import { whatsappFixture } from "./whatsapp-fixture";

const { Client, LocalAuth } = wwebjs;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 90000;
  while (Date.now() < end) { if (check()) return; await delay(200); }
  throw new Error("Timed out waiting for " + label);
}
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "campaigndesk-whatsapp-check-"));
  const client = new Client({ authStrategy: new LocalAuth({ dataPath: directory }), authTimeoutMs: 60000,
    puppeteer: { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"] } });
  let codes = 0;
  let navigations = 0;
  const errors: string[] = [];
  client.on("qr", () => { codes++; });
  client.on("session_loading", () => { navigations++; });
  client.on("session_error", error => errors.push(String(error)));
  const timeout = setTimeout(() => { void client.destroy(); }, 240000);
  try {
    await client.initialize();
    await until(() => codes > 0, "initial QR");
    assert(client.pupPage && client.pupBrowser);
    console.log("✓ Real WhatsApp Web QR generated in Chromium with isolated authentication");
    for (let i = 0; i < 2; i++) {
      const previous = codes;
      await client.pupPage.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await until(() => codes > previous || errors.length > 0, "QR after main-frame reload");
      assert.deepEqual(errors, []);
    }
    assert.equal(navigations, 2);
    await client.pupPage.evaluate("document.body.appendChild(document.createElement('iframe')).src = 'about:blank'");
    await delay(500);
    assert.equal(navigations, 2);
    console.log("✓ Main-frame reloads recovered twice; iframe navigation ignored; no unhandled browser errors");
    const fixture = await client.pupBrowser.newPage();
    await fixture.evaluate(whatsappFixture);
    const directoryData = await fixture.evaluate(discoverWhatsApp);
    assert.equal(directoryData.contacts.length, 3);
    assert.equal(directoryData.groups.length, 1);
    assert.equal(directoryData.warnings, 1);
    const members = await fixture.evaluate(discoverWhatsApp, "123@g.us");
    assert.equal(members.participants?.length, 2);
    assert(members.participants.some(member => member.whatsappId === "200@lid"));
    console.log("✓ Directory and selected group discovery execute in real Chromium, including private IDs and a throwing optional getter");
  } finally {
    clearTimeout(timeout);
    await client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
