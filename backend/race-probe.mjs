import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import Database from "better-sqlite3";
const N = 6;
const runOnce = async (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  const file = path.join(dir, "chatban-admin.db");
  const legacy = 1787000000000;
  const seed = new Database(file);
  seed.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))");
  seed.prepare("INSERT INTO settings (key,value) VALUES ('boot.generation', ?)").run(String(legacy));
  seed.close();
  const child = path.join(dir, "boot.mjs");
  fs.writeFileSync(child, `const { nextBootGeneration } = await import(${JSON.stringify(new URL("./src/store.ts", import.meta.url).href)});\nconsole.log(nextBootGeneration());`);
  const run = () => new Promise((res) => {
    let out = "", err = "";
    const p = spawn(process.execPath, ["--import", "tsx", child], { env: { ...process.env, CHATBAN_DATA_DIR: dir } });
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("close", code => res({ code, err }));
  });
  const rs = await Promise.all(Array.from({length: N}, run));
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = rs.filter(r => r.code !== 0);
  console.log(`${label}: ${N}本中 失敗${failed.length}本` + (failed[0] ? ` / 例: ${failed[0].err.match(/Error[^\n]*/)?.[0]}` : ""));
};
await runOnce(process.argv[2] ?? "run");
