import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { config, parse } from "dotenv";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required");
let source = readFileSync(existsSync(".env") ? ".env" : ".env.example", "utf8");
const values = parse(source);
const replacements = {};
if (!values.AUTH_SECRET || /REPLACE|CHANGEME/i.test(values.AUTH_SECRET)) replacements.AUTH_SECRET = randomBytes(48).toString("hex");
if (!values.ADMIN_PASSWORD || /REPLACE|CHANGEME/i.test(values.ADMIN_PASSWORD)) replacements.ADMIN_PASSWORD = randomBytes(24).toString("base64url");
// Move only the shipped defaults; preserve user-supplied database credentials.
if (values.DATABASE_URL === "postgresql://campaigns:campaigns@localhost:5432/campaigns?schema=public") replacements.DATABASE_URL = "postgresql://campaigns:campaigns@127.0.0.1:55432/campaigns?schema=public";
if (values.REDIS_URL === "redis://localhost:6379") replacements.REDIS_URL = "redis://127.0.0.1:56379";
for (const [key, value] of Object.entries(replacements)) {
  const line = `${key}=${JSON.stringify(value)}`;
  source = new RegExp(`^${key}=.*$`, "m").test(source) ? source.replace(new RegExp(`^${key}=.*$`, "m"), line) : source + `\n${line}\n`;
}
writeFileSync(".env", source, { mode: 0o600 });
chmodSync(".env", 0o600);
config();
run(process.execPath, ["scripts/services.mjs", "up"]);
run("npm", ["run", "db:generate"]);
run("npm", ["run", "db:push"]);
run("npm", ["run", "db:seed"]);
run("npm", ["run", "doctor"]);
run(process.execPath, ["scripts/create-launcher.mjs"]);
console.log(`\nSetup complete. Sign in as ${process.env.ADMIN_EMAIL} using ADMIN_PASSWORD in .env.\nStart with npm run dev:all. Your URL is http://localhost:${process.env.PORT || 3000}.`);
