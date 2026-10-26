import "dotenv/config";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const port = process.env.PORT || "3000";
if (!["dev", "start"].includes(mode) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("Use web.mjs dev|start with PORT between 1 and 65535");
}
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", mode, "--port", port, ...process.argv.slice(3)], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 0; });
