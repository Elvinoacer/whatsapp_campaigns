import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const pause = ms => new Promise(done => setTimeout(done, ms));

export async function inspectProcess(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (["Z", "X"].includes(fields[0])) return null;
    const [cwd, executable, command] = await Promise.all([
      readlink(`/proc/${pid}/cwd`), readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    return { pid, parent: Number(fields[1]), start: fields[19], cwd, executable, args: command.split("\0").filter(Boolean) };
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
}

function service(processInfo) {
  return /^(postgres|postmaster|redis-server)$/.test(basename(processInfo.executable));
}

export function isProjectProcess(info, root, sessionDirectory = join(root, ".wwebjs_auth")) {
  if (!info || service(info)) return false;
  // A browser orphan can retain the auth-profile lock even after its worker dies.
  if (/^(chrome|chromium|chromium-browser|headless_shell)$/.test(basename(info.executable))) {
    return info.args.some(arg => arg.startsWith("--user-data-dir=" + sessionDirectory + sep + "session-"));
  }
  if (info.cwd !== root || !/^node(?:js)?(?:$|-)/.test(basename(info.executable))) return false;
  if (/^next-server \(/.test(info.args[0] || "")) return true;
  const paths = info.args.map(arg => isAbsolute(arg) ? arg : resolve(info.cwd, arg));
  if (["scripts/platform.mjs", "scripts/web.mjs", "worker/index.ts"].some(path => paths.includes(join(root, path)))) return true;
  const next = paths.indexOf(join(root, "node_modules/next/dist/bin/next"));
  if (next >= 0 && ["dev", "start"].includes(info.args[next + 1])) return true;
  return paths.includes(join(root, "node_modules/concurrently/dist/bin/concurrently.js")) &&
    info.args.some(arg => /^npm:worker(?::dev)?$/.test(arg));
}

/** Linux advisory lock: the kernel releases it even if a launcher is killed. */
export async function lockStartup(root, shouldStop = () => false, log = console.log) {
  await mkdir(join(root, ".local"), { recursive: true, mode: 0o700 });
  if (process.platform !== "linux") return async () => {};
  return new Promise((resolveLock, reject) => {
    const child = spawn("flock", ["--no-fork", "--exclusive", join(root, ".local/platform-start.lock"),
      process.execPath, "-e", 'process.stdout.write("locked\\n"); process.stdin.resume();'], { stdio: ["pipe", "pipe", "pipe"] });
    let acquired = false;
    let errorText = "";
    const waiting = setTimeout(() => log("Another CampaignDesk launch is starting. Waiting for it to finish…"), 500);
    const cancelled = setInterval(() => { if (shouldStop()) child.kill("SIGTERM"); }, 100);
    const clear = () => { clearTimeout(waiting); clearInterval(cancelled); };
    child.stdin.on("error", () => {});
    child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-2000); });
    child.once("error", error => { clear(); reject(new Error("Could not lock CampaignDesk startup: " + error.message)); });
    child.once("exit", code => {
      clear();
      if (!acquired) reject(new Error(shouldStop() ? "Stopped" : "Could not lock CampaignDesk startup: " + (errorText || code)));
    });
    child.stdout.once("data", () => {
      acquired = true;
      clear();
      resolveLock(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(done => { child.once("exit", done); child.stdin.end(); });
      });
    });
  });
}

export async function stopExistingProject(root, { timeoutMs = 20000, shouldStop = () => false, log = console.log, sessionDirectory = ".wwebjs_auth" } = {}) {
  if (process.platform !== "linux") return;
  root = await realpath(root);
  const ids = (await readdir("/proc")).filter(id => /^\d+$/.test(id)).map(Number);
  const processes = (await Promise.all(ids.map(inspectProcess))).filter(Boolean);
  const byId = new Map(processes.map(info => [info.pid, info]));
  const excluded = new Set([process.pid]);
  let ancestor = byId.get(process.pid);
  while (ancestor && !excluded.has(ancestor.parent)) { excluded.add(ancestor.parent); ancestor = byId.get(ancestor.parent); }
  const candidates = processes.filter(info => !excluded.has(info.pid) && isProjectProcess(info, root, resolve(root, sessionDirectory)));
  if (!candidates.length) return;
  const candidateIds = new Set(candidates.map(info => info.pid));
  const outermost = candidates.filter(info => {
    let parent = byId.get(info.parent);
    while (parent) { if (candidateIds.has(parent.pid)) return false; parent = byId.get(parent.parent); }
    return true;
  });
  // Capture descendants before signaling parents; keep identities to avoid PID reuse.
  const targets = new Map(candidates.map(info => [info.pid, info]));
  for (let changed = true; changed;) {
    changed = false;
    for (const info of processes) {
      if (targets.has(info.parent) && !targets.has(info.pid) && !excluded.has(info.pid) && !service(info)) {
        targets.set(info.pid, info); changed = true;
      }
    }
  }
  const alive = async info => (await inspectProcess(info.pid))?.start === info.start;
  const signal = async (info, name) => {
    if (!await alive(info)) return;
    try { process.kill(info.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const remaining = async () => {
    const states = await Promise.all([...targets.values()].map(async info => await alive(info) ? info : null));
    return states.filter(Boolean);
  };
  const wait = async ms => {
    const end = Date.now() + ms;
    do {
      if (shouldStop()) throw new Error("Stopped");
      const running = await remaining();
      if (!running.length) return [];
      if (Date.now() >= end) return running;
      await pause(150);
    } while (true);
  };
  log("Stopping the existing CampaignDesk web server and WhatsApp worker…");
  for (const info of outermost) await signal(info, "SIGTERM");
  let running = await wait(timeoutMs);
  if (running.length) {
    log("Graceful shutdown timed out. Stopping the remaining CampaignDesk processes…");
    for (const info of running) await signal(info, "SIGKILL");
    running = await wait(5000);
    if (running.length) throw new Error("Some CampaignDesk processes could not stop. Try again after they exit.");
  }
  log("Previous CampaignDesk instance stopped. Starting a fresh instance…");
}

export async function assertWebPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", error => reject(error.code === "EADDRINUSE"
      ? new Error(`Port ${port} is occupied by another application. Close that app or change PORT in .env; unrelated processes were left running.`) : error));
    server.listen(port, () => server.close(done));
  });
}
