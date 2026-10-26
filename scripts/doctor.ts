import "dotenv/config";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import IORedis from "ioredis";
import puppeteer from "puppeteer";
import { db } from "../lib/db";
import { configuration } from "../lib/config";

async function main() {
  const config = configuration();
  console.log("✓ Configuration valid");
  try { await db.$queryRaw`SELECT 1`; await db.user.count(); }
  catch { throw new Error("PostgreSQL or schema unavailable. Run npm run setup; for custom services verify DATABASE_URL and run npm run db:push."); }
  if (!await db.user.count()) throw new Error("No admin account. Run npm run db:seed.");
  console.log("✓ PostgreSQL, schema and admin account ready");
  const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 5000, retryStrategy: () => null });
  redis.on("error", () => {});
  try {
    const info = await redis.info("server");
    const version = info.match(/redis_version:(\d+)\.(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 6 || (Number(version[1]) === 6 && Number(version[2]) < 2)) throw new Error("Redis 6.2+ is required. Run npm run setup to provision a compatible project-local Redis.");
    console.log(`✓ Redis ${version.slice(1).join(".")} ready`);
  } finally { redis.disconnect(); }
  const executable = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  try { await access(executable); }
  catch { throw new Error("Chromium is missing. Run npx puppeteer browsers install chrome, or set PUPPETEER_EXECUTABLE_PATH."); }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Chromium cannot start. Install its Linux system libraries; see README.")));
  });
  console.log("✓ Chromium executable ready");
  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is occupied. Set PORT to a free port in .env.`)));
    server.listen(port, () => server.close(() => resolve()));
  });
  console.log(`✓ Web port ${port} available\nReady: npm run dev:all`);
}
main().catch(error => { console.error(`Setup check failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }).finally(() => db.$disconnect());
