import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWebPortAvailable, inspectProcess, isProjectProcess, lockStartup, stopExistingProject } from "../scripts/platform-processes.mjs";

const directories: string[] = [];
const children: ChildProcess[] = [];
const releases: (() => Promise<void>)[] = [];
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() { const path = await mkdtemp(join(tmpdir(), "campaigndesk-process-test-")); directories.push(path); return path; }
async function worker(root: string, stubborn = false, withChild = false) {
  await mkdir(join(root, "worker"), { recursive: true });
  await writeFile(join(root, "worker/index.ts"), `
    const fs = require('node:fs');
    const timer = setInterval(() => {}, 1000);
    ${withChild ? `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});fs.writeFileSync('child.pid', String(child.pid));` : ""}
    process.on('SIGTERM', () => { ${stubborn ? "" : "fs.writeFileSync('stopped', 'gracefully'); clearInterval(timer); process.exit(0);"} });
    process.stdout.write('ready\\n');
  `);
  const child = spawn(process.execPath, ["worker/index.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  await new Promise<void>((done, reject) => { child.stdout!.once("data", () => done()); child.once("exit", code => reject(new Error("Fixture worker exited " + code))); });
  return child;
}

describe("project process ownership", () => {
  const root = "/projects/campaigndesk";
  const info = { pid: 10, parent: 1, start: "100", cwd: root, executable: "/usr/bin/node", args: ["node", "worker/index.ts"] };
  it("recognizes the project's launcher, worker and Next server", () => {
    expect(isProjectProcess(info, root)).toBe(true);
    expect(isProjectProcess({ ...info, args: ["node", "scripts/platform.mjs", "production"] }, root)).toBe(true);
    expect(isProjectProcess({ ...info, args: ["next-server (v16.4.3)"] }, root)).toBe(true);
  });
  it("leaves unrelated apps, other checkouts and database services alone", () => {
    expect(isProjectProcess({ ...info, args: ["node", "other-server.mjs"] }, root)).toBe(false);
    expect(isProjectProcess({ ...info, cwd: root + "-other" }, root)).toBe(false);
    expect(isProjectProcess({ ...info, executable: "/usr/bin/postgres" }, root)).toBe(false);
    expect(isProjectProcess({ ...info, executable: "/usr/bin/redis-server" }, root)).toBe(false);
  });
  it("recognizes only Chromium using this project's WhatsApp profile", () => {
    const browser = { ...info, executable: "/opt/chrome", args: ["chrome", "--user-data-dir=" + root + "/.wwebjs_auth/session-test"] };
    expect(isProjectProcess(browser, root)).toBe(true);
    expect(isProjectProcess({ ...browser, args: ["chrome", "--user-data-dir=/personal/chrome"] }, root)).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("real process shutdown", () => {
  it("stops a matching worker gracefully and preserves another checkout", async () => {
    const owned = await directory(); const other = await directory();
    const first = await worker(owned); const second = await worker(other);
    await stopExistingProject(owned, { timeoutMs: 1000, log: () => {} });
    expect(await readFile(join(owned, "stopped"), "utf8")).toBe("gracefully");
    expect(await inspectProcess(first.pid!)).toBeNull();
    expect(await inspectProcess(second.pid!)).not.toBeNull();
  });
  it("forces a stuck worker to stop after allowing a graceful shutdown", async () => {
    const root = await directory(); const child = await worker(root, true);
    const log = vi.fn();
    await stopExistingProject(root, { timeoutMs: 200, log });
    expect(log.mock.calls.flat().join(" ")).toContain("timed out");
    expect(await inspectProcess(child.pid!)).toBeNull();
  });
  it("cleans up child processes even when a parent exits first", async () => {
    const root = await directory(); await worker(root, false, true);
    const childId = Number(await readFile(join(root, "child.pid"), "utf8"));
    await stopExistingProject(root, { timeoutMs: 200, log: () => {} });
    expect(await inspectProcess(childId)).toBeNull();
  });
  it("serializes launches and releases the operating-system lock", async () => {
    const root = await directory(); const release = await lockStartup(root);
    releases.push(release);
    let acquired = false;
    const next = lockStartup(root, () => false, () => {}).then(release => { acquired = true; return release; });
    await pause(150); expect(acquired).toBe(false);
    await release();
    const releaseNext = await next; releases.push(releaseNext);
    expect(acquired).toBe(true);
    await releaseNext();
    const third = await lockStartup(root); releases.push(third);
  });
});

it("reports a foreign port collision without stopping its owner", async () => {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  try {
    await expect(assertWebPortAvailable(address.port)).rejects.toThrow("another application");
    expect(server.listening).toBe(true);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
