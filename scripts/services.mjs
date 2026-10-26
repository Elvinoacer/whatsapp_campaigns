import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import net from "node:net";

const root = resolve(".local");
const mode = process.argv[2] || "up";
if (!["up", "down"].includes(mode)) throw new Error("Expected services.mjs up|down");
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw new Error(`${cmd} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout?.trim();
};
const available = cmd => !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
const listening = port => new Promise(resolveListening => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  socket.once("connect", () => { socket.destroy(); resolveListening(true); });
  socket.once("error", () => { socket.destroy(); resolveListening(false); });
  socket.once("timeout", () => { socket.destroy(); resolveListening(false); });
});
const marker = join(root, "services.json");
mkdirSync(root, { recursive: true, mode: 0o700 });
const stored = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
if (mode === "down") {
  if (stored?.backend === "docker") run("docker", ["compose", "stop"], { stdio: "inherit" });
  else if (stored?.backend === "native") {
    if (existsSync(join(root, "postgres", "postmaster.pid"))) run(stored.pgCtl, ["-D", join(root, "postgres"), "stop", "-m", "fast"]);
    if (existsSync(join(root, "redis.pid"))) {
      const pid = Number(readFileSync(join(root, "redis.pid"), "utf8").trim());
      if (pid > 1) { try { process.kill(pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
    }
  }
  console.log("Project services stopped. Persisted data is retained.");
} else {
  const database = new URL(process.env.DATABASE_URL || "postgresql://campaigns:campaigns@127.0.0.1:55432/campaigns");
  const redis = new URL(process.env.REDIS_URL || "redis://127.0.0.1:56379");
  const pgPort = Number(database.port || 5432);
  const redisPort = Number(redis.port || 6379);
  if (database.hostname !== "127.0.0.1" || redis.hostname !== "127.0.0.1" || pgPort !== 55432 || redisPort !== 56379) {
    console.log("Using custom services from .env. Run npm run doctor to validate their connectivity.");
    process.exit(0);
  }
  const backend = process.env.SERVICES_BACKEND || stored?.backend || (available("docker") && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? "docker" : "native");
  if (backend === "docker") {
    if (decodeURIComponent(database.username) !== "campaigns" || decodeURIComponent(database.password) !== "campaigns" || database.pathname !== "/campaigns") throw new Error("Bundled Docker services use campaigns as database/user/password. Set matching DATABASE_URL or manage your own services.");
    run("docker", ["compose", "up", "-d", "--wait"], { stdio: "inherit" });
    writeFileSync(marker, JSON.stringify({ backend }));
  } else {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Install Docker Desktop for bundled services on this platform");
    let bin = process.env.POSTGRES_BIN;
    if (!bin && existsSync("/usr/lib/postgresql")) bin = readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a)).map(v => `/usr/lib/postgresql/${v}/bin`).find(p => existsSync(join(p, "initdb")));
    const pg = tool => bin ? join(bin, tool) : tool;
    if (!available(pg("pg_ctl"))) throw new Error("Install PostgreSQL server binaries (Ubuntu: sudo apt install postgresql), or install Docker + Compose. Then rerun npm run setup.");
    const pgDir = join(root, "postgres");
    if (!existsSync(join(pgDir, "PG_VERSION"))) {
      const passwordFile = join(root, "pg-password");
      writeFileSync(passwordFile, decodeURIComponent(database.password), { mode: 0o600 });
      run(pg("initdb"), ["-D", pgDir, "-U", decodeURIComponent(database.username), "--pwfile", passwordFile, "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--no-locale"]);
      unlinkSync(passwordFile);
    }
    writeFileSync(marker, JSON.stringify({ backend, pgCtl: pg("pg_ctl") }));
    if (spawnSync(pg("pg_ctl"), ["-D", pgDir, "status"], { stdio: "ignore" }).status !== 0) {
      if (await listening(pgPort)) throw new Error(`Port ${pgPort} is occupied by another service`);
      run(pg("pg_ctl"), ["-D", pgDir, "-l", join(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${pgPort} -k ${root}`, "-w", "start"]);
    }
    const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(database.password) };
    const args = ["-h", "127.0.0.1", "-p", String(pgPort), "-U", decodeURIComponent(database.username)];
    const dbName = decodeURIComponent(database.pathname.slice(1));
    const dbExists = run(pg("psql"), [...args, "-d", "postgres", "-Atc", `SELECT 1 FROM pg_database WHERE datname = '${dbName.replaceAll("'", "''")}'`], { env: pgEnv });
    if (dbExists !== "1") run(pg("createdb"), [...args, dbName], { env: pgEnv });
    let redisBin = "redis-server";
    const version = spawnSync(redisBin, ["--version"], { encoding: "utf8" }).stdout?.match(/v=(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 6 || (Number(version[1]) === 6 && Number(version[2]) < 2)) {
      const redisVersion = "7.4.6";
      redisBin = join(root, `redis-${redisVersion}`, "src", "redis-server");
      if (!existsSync(redisBin)) {
        console.log(`Building project-local Redis ${redisVersion}; existing system Redis stays on its own port.`);
        const response = await fetch(`https://download.redis.io/releases/redis-${redisVersion}.tar.gz`, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Redis download failed: ${response.status}`);
        const archive = Buffer.from(await response.arrayBuffer());
        if (createHash("sha256").update(archive).digest("hex") !== "73b94484e00fb4c2440b490dc4021142fb0b6efc8b64c6329c10d24f0b531c99") throw new Error("Redis download checksum mismatch");
        const archivePath = join(root, "redis.tar.gz");
        writeFileSync(archivePath, archive);
        run("tar", ["-xzf", archivePath, "-C", root]);
        run("make", ["-j2", "MALLOC=libc", "BUILD_TLS=no", "OPT=-O2", "REDIS_CFLAGS=", "REDIS_LDFLAGS=", "redis-server"], { cwd: join(root, `redis-${redisVersion}`), stdio: "inherit" });
      }
    }
    writeFileSync(marker, JSON.stringify({ backend, pgCtl: pg("pg_ctl") }));
    if (!await listening(redisPort)) {
      const redisDir = join(root, "redis");
      mkdirSync(redisDir, { recursive: true });
      const configPath = join(root, "redis.conf");
      writeFileSync(configPath, `bind 127.0.0.1\nport ${redisPort}\ndaemonize yes\nappendonly yes\nmaxmemory-policy noeviction\ndir ${JSON.stringify(redisDir)}\npidfile ${JSON.stringify(join(root, "redis.pid"))}\nlogfile ${JSON.stringify(join(root, "redis.log"))}\n`);
      run(redisBin, [configPath]);
    }
    console.log(`PostgreSQL ready on ${pgPort}; Redis ready on ${redisPort}. Data: .local/`);
  }
}
