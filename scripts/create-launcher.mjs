import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Desktop-entry quoting is separate from shell quoting; escape literal field codes too.
const quote = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("%", "%%") + '"';
for (const script of ["run.sh", "run-dev.sh", "run-production.sh"]) chmodSync(join(root, script), 0o755);
const path = join(root, "CampaignDesk.desktop");
const exec = `Exec=${quote(join(root, "run.sh"))}`;
const source = `[Desktop Entry]\nVersion=1.0\nType=Application\nName=CampaignDesk\nComment=Choose development or build and run production\n${exec}\nTerminal=true\nIcon=utilities-terminal\nCategories=Utility;\n`;
writeFileSync(path, source, { mode: 0o755 });
chmodSync(path, 0o755);
if (process.platform === "linux") {
  const result = spawnSync("xdg-user-dir", ["DESKTOP"], { encoding: "utf8", timeout: 3000 });
  const desktop = result.status === 0 ? result.stdout.trim() : join(homedir(), "Desktop");
  if (desktop && desktop !== homedir() && existsSync(desktop)) {
    const shortcut = join(desktop, "CampaignDesk.desktop");
    if (!existsSync(shortcut) || readFileSync(shortcut, "utf8").includes(exec + "\n")) {
      writeFileSync(shortcut, source, { mode: 0o755 });
      chmodSync(shortcut, 0o755);
      spawnSync("gio", ["set", shortcut, "metadata::trusted", "true"], { stdio: "ignore", timeout: 3000 });
      console.log("Created the CampaignDesk desktop shortcut. Double-click it to choose development or production.");
    } else console.log("An existing CampaignDesk desktop shortcut was preserved. Use run.sh in this project folder.");
  }
}
console.log("Project launchers are ready: run.sh, run-dev.sh and run-production.sh.");
