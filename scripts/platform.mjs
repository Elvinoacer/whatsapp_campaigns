import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWebPortAvailable, lockStartup, stopExistingProject } from "./platform-processes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const [mode, ...flags] = process.argv.slice(2);
if (!["dev", "production"].includes(mode) || flags.some(flag => !["--no-browser", "--skip-build"].includes(flag)) || (mode === "dev" && flags.includes("--skip-build"))) {
  console.error("Usage: run.sh dev|production [--no-browser] [--skip-build (production only)]");
  process.exit(1);
}
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Node.js 22 or newer is required");
  process.exit(1);
}

let active;
let stopping = false;
let stopTimer;
let releaseStartup;
function signalChild(signal) {
  if (!active?.pid) return;
  try { process.kill(-active.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
  if (stopping) { signalChild("SIGKILL"); return; }
  stopping = true;
  console.log("\nStopping CampaignDesk web and worker…");
  signalChild("SIGTERM");
  stopTimer = setTimeout(() => signalChild("SIGKILL"), 15000);
  stopTimer.unref();
});

function run(command, args, env = process.env) {
  if (stopping) return Promise.reject(new Error("Stopped"));
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env, detached: true });
    active = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      active = undefined;
      if (stopTimer) clearTimeout(stopTimer);
      if (stopping) reject(new Error("Stopped"));
      else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} stopped (${signal || code})`));
      else resolveRun();
    });
  });
}

function openBrowser(url) {
  if (flags.includes("--no-browser") || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return;
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const browser = spawn(command, [url], { stdio: "ignore", detached: true });
  browser.on("error", () => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

async function main() {
  releaseStartup = await lockStartup(root, () => stopping);
  // Stop before installing dependencies or building so the old worker cannot
  // keep the auth profile locked or read files being replaced by the build.
  let sessionDirectory = process.env.SESSION_DIR;
  if (!sessionDirectory && existsSync(".env") && existsSync("node_modules/dotenv/package.json")) {
    const { parse } = await import("dotenv");
    sessionDirectory = parse(readFileSync(".env")).SESSION_DIR;
  }
  await stopExistingProject(root, { shouldStop: () => stopping, sessionDirectory });
  if (!existsSync("node_modules/next/package.json") || !existsSync("node_modules/.bin/concurrently")) {
    console.log("Installing project dependencies…");
    await run("npm", ["ci", "--include=dev"]);
  }
  const { config, parse } = await import("dotenv");
  const fileSettings = existsSync(".env") ? parse(readFileSync(".env")) : {};
  const authSecret = process.env.AUTH_SECRET || fileSettings.AUTH_SECRET;
  if (!existsSync(".env") || !authSecret || /REPLACE|CHANGEME/i.test(authSecret)) {
    console.log("Preparing first-time configuration…");
    await run("npm", ["run", "setup"]);
    config();
  } else {
    config();
    await run("npm", ["run", "services:up"]);
    if (!existsSync("node_modules/.prisma/client/index.js")) await run("npm", ["run", "db:generate"]);
  }
  await assertWebPortAvailable(Number(process.env.PORT || "3000"));
  await run("npm", ["run", "doctor"]);
  const environment = { ...process.env, NODE_ENV: mode === "production" ? "production" : "development" };
  if (mode === "production") {
    if (flags.includes("--skip-build")) {
      if (!existsSync(".next/BUILD_ID")) throw new Error("No production build exists. Run run-production.sh without --skip-build first.");
    } else {
      console.log("\nBuilding the production app…");
      await run("npm", ["run", "build"], environment);
    }
  }
  const url = `http://localhost:${process.env.PORT || "3000"}`;
  console.log(`\nStarting CampaignDesk in ${mode} mode. Press Ctrl+C to stop.\n${url}\n`);
  const [{ Queue }, { default: IORedis }] = await Promise.all([import("bullmq"), import("ioredis")]);
  const readinessRedis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 2000 });
  readinessRedis.on("error", () => {});
  const queueName = process.env.QUEUE_NAME || "campaign-operations";
  const readinessQueues = [queueName, queueName + "-delivery"].map(name => {
    const queue = new Queue(name, { connection: readinessRedis, skipMetasUpdate: true });
    queue.on("error", () => {});
    return queue;
  });
  let checking = false;
  const browserTimer = setInterval(async () => {
    if (checking || stopping) return;
    checking = true;
    try {
      const response = await fetch(url + "/api/auth/me", { signal: AbortSignal.timeout(2000) });
      if (response.status === 401 || response.ok) {
        const workers = await Promise.all(readinessQueues.map(queue => queue.getWorkers()));
        if (workers.some(items => !items.length)) return;
        clearInterval(browserTimer);
        if (releaseStartup) { await releaseStartup(); releaseStartup = undefined; }
        console.log(`\nCampaignDesk is ready: ${url}`);
        openBrowser(url);
      }
    } catch { /* the server is still starting */ }
    finally { checking = false; }
  }, 1000);
  try {
    await run(process.execPath, ["node_modules/concurrently/dist/bin/concurrently.js", "--kill-others", "--success", "first", "--names", "web,worker",
      mode === "dev" ? "npm:dev" : "npm:start", mode === "dev" ? "npm:worker:dev" : "npm:worker"], environment);
  } finally {
    clearInterval(browserTimer);
    await Promise.all(readinessQueues.map(queue => queue.close()));
    readinessRedis.disconnect();
  }
}
main().catch(error => {
  if (!stopping) { console.error(`\nCould not start CampaignDesk: ${error.message}`); process.exitCode = 1; }
}).finally(async () => { if (releaseStartup) await releaseStartup(); });
