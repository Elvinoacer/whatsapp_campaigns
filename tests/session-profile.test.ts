import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProcess, lockWhatsAppWorker, ownsBrowserProfile, prepareSessionProfile } from "../scripts/platform-processes.mjs";
import { reconnectDelayMs, requiresPairing, shouldRestoreSession } from "../worker/session-state";

const require = createRequire(import.meta.url);
const directories: string[] = [];
const children: ChildProcess[] = [];
const browsers: { pid: number; start: string }[] = [];
const releases: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const browser of browsers.splice(0)) if ((await inspectProcess(browser.pid))?.start === browser.start) process.kill(browser.pid, "SIGKILL");
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function profile() {
  const directory = await mkdtemp(join(tmpdir(), "campaigndesk-profile-test-"));
  directories.push(directory);
  await mkdir(join(directory, "Default"));
  await writeFile(join(directory, "Default", "saved-login-fixture"), "keep this login");
  return directory;
}

it.each([
  ["CONNECTED", "known", false, true], ["CONNECTING", null, false, true], ["QR_READY", null, true, true],
  ["ERROR", "known", true, true], ["ERROR", "known", false, false], ["ERROR", null, true, true], ["ERROR", null, false, false],
  ["DISCONNECTED", "known", true, false],
])("restores %s sessions with prior phone %s and profile %s: %s", (status, phone, exists, expected) => {
  expect(shouldRestoreSession({ status: status as string, phone: phone as string | null }, exists as boolean)).toBe(expected);
});

it("uses capped exponential recovery without abandoning an existing login", () => {
  expect(reconnectDelayMs(1)).toBe(2000);
  expect(reconnectDelayMs(2)).toBe(4000);
  expect(reconnectDelayMs(3)).toBe(8000);
  expect(reconnectDelayMs(8)).toBe(256000);
  expect(reconnectDelayMs(9)).toBe(300000);
  expect(reconnectDelayMs(1000)).toBe(300000);
});

it("distinguishes a revoked login from a recoverable transport disconnect", () => {
  expect(requiresPairing("LOGOUT")).toBe(true);
  expect(requiresPairing("UNPAIRED_IDLE")).toBe(true);
  expect(requiresPairing("TIMEOUT")).toBe(false);
  expect(requiresPairing("NAVIGATION")).toBe(false);
});

describe.skipIf(process.platform !== "linux")("saved browser profile recovery", () => {
  it("removes only stale singleton links and preserves login data", async () => {
    const directory = await profile();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise(resolve => child.once("exit", resolve));
    for (const [name, target] of [["SingletonLock", `${hostname()}-${child.pid}`], ["SingletonCookie", "old-cookie"], ["SingletonSocket", "/tmp/old-browser-socket"]]) await symlink(target, join(directory, name));
    await prepareSessionProfile(directory);
    expect(await readFile(join(directory, "Default", "saved-login-fixture"), "utf8")).toBe("keep this login");
    await expect(readlink(join(directory, "SingletonLock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(join(directory, "SingletonSocket"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(join(directory, "SingletonCookie"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves locks from another machine and unrelated live processes", async () => {
    const foreign = await profile();
    await symlink(`other-machine-${process.pid}`, join(foreign, "SingletonLock"));
    await expect(prepareSessionProfile(foreign)).rejects.toThrow("another machine");
    expect(await readlink(join(foreign, "SingletonLock"))).toBe(`other-machine-${process.pid}`);
    const unrelated = await profile();
    await symlink(`${hostname()}-${process.pid}`, join(unrelated, "SingletonLock"));
    await expect(prepareSessionProfile(unrelated)).rejects.toThrow("unverified process");
    expect(await readFile(join(unrelated, "Default", "saved-login-fixture"), "utf8")).toBe("keep this login");
  });
  it("allows only one worker per auth directory and releases ownership cleanly", async () => {
    const directory = await profile();
    const release = await lockWhatsAppWorker(directory); releases.push(release);
    await expect(lockWhatsAppWorker(directory)).rejects.toThrow("already using this session storage");
    await release();
    const again = await lockWhatsAppWorker(directory); releases.push(again);
    await again();
  });
  it("protects a live owner's browser, reclaims an orphan with shortened arguments, and restores its IndexedDB", async () => {
    const directory = await profile();
    const server = createServer((_, response) => { response.setHeader("Content-Type", "text/html"); response.end("<title>Saved session fixture</title>"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const origin = `http://127.0.0.1:${address.port}`;
    let restored: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    try {
      const source = `
        const puppeteer = require(${JSON.stringify(require.resolve("puppeteer"))});
        (async () => {
          const browser = await puppeteer.launch({headless:true, userDataDir:${JSON.stringify(directory)}, executablePath:${JSON.stringify(process.env.PUPPETEER_EXECUTABLE_PATH)}, args:['--no-sandbox','--disable-setuid-sandbox']});
          const page = (await browser.pages())[0]; await page.goto(${JSON.stringify(origin)});
          await page.evaluate(() => new Promise((resolve, reject) => {
            const opening = indexedDB.open('saved-login-test',1);
            opening.onupgradeneeded = () => opening.result.createObjectStore('credentials');
            opening.onsuccess = () => { const db=opening.result; const tx=db.transaction('credentials','readwrite'); tx.objectStore('credentials').put('existing-login','session'); tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>reject(tx.error); };
          }));
          console.log(browser.process().pid);
          process.stdin.once('data', async () => { await browser.disconnect(); process.exit(0); }); process.stdin.resume();
        })().catch(error=>{console.error(error);process.exit(1);});`;
      const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
      const pid = await new Promise<number>((resolve, reject) => {
        child.stdout!.once("data", data => resolve(Number(String(data).trim())));
        child.once("exit", code => reject(new Error("Browser fixture exited " + code)));
      });
      const info = await inspectProcess(pid);
      expect(info).not.toBeNull();
      browsers.push({ pid, start: info!.start });
      // Reproduce Chrome's rewritten /proc cmdline using real open descriptors.
      expect(await ownsBrowserProfile({ ...info!, args: [info!.executable] }, directory)).toBe(true);
      await expect(prepareSessionProfile(directory)).rejects.toThrow("another running worker");
      expect(await inspectProcess(pid)).not.toBeNull();
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.stdin!.write("orphan\n"); await exited;
      await prepareSessionProfile(directory, { timeoutMs: 1000, log: () => {} });
      expect(await inspectProcess(pid)).toBeNull();
      expect(await readFile(join(directory, "Default", "saved-login-fixture"), "utf8")).toBe("keep this login");
      restored = await puppeteer.launch({ headless: true, userDataDir: directory, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const page = (await restored.pages())[0]; await page.goto(origin);
      const saved = await page.evaluate(() => new Promise<string>((resolve, reject) => {
        const opening = indexedDB.open("saved-login-test", 1);
        opening.onsuccess = () => { const db = opening.result; const reading = db.transaction("credentials").objectStore("credentials").get("session"); reading.onsuccess = () => { db.close(); resolve(reading.result); }; reading.onerror = () => reject(reading.error); };
        opening.onerror = () => reject(opening.error);
      }));
      expect(saved).toBe("existing-login");
    } finally { await restored?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 60000);
});
