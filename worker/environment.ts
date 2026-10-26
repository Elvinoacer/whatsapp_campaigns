import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Direct worker launches and both launcher modes must read the same .env,
// auth profiles, browser cache and uploads, regardless of the shell's cwd.
config({ path: resolve(projectRoot, ".env") });
process.chdir(projectRoot);
export const sessionDirectory = resolve(projectRoot, process.env.SESSION_DIR || ".wwebjs_auth");
