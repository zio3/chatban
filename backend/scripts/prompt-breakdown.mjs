// システムプロンプトのセクション別サイズ分析 (文字数ベース、日本語は約1.5文字/tk)
import Database from "better-sqlite3";
const db = new Database("chatban.db", { readonly: true });

const tasks = db.prepare("SELECT * FROM tasks WHERE archived = 0 ORDER BY COALESCE(sort,id)").all();
const index = JSON.stringify(
  tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, ...(t.lane ? { lane: t.lane } : {}), ...(t.context ? { hasContext: true } : {}) }))
);
const fullTasks = JSON.stringify(tasks);
const loads = JSON.stringify(
  db.prepare("SELECT name FROM members").all().map((m) => ({ name: m.name }))
);
const history = JSON.stringify(db.prepare("SELECT task_title, assignee, note FROM assignment_history ORDER BY id DESC LIMIT 20").all());
const cards = JSON.stringify(
  db.prepare("SELECT * FROM summary_cards").all().map((r) => ({ id: r.id, title: r.title, elements: JSON.parse(r.elements).map((e) => e.text) }))
);
const ctx = db.prepare("SELECT text FROM project_context WHERE id=1").get()?.text ?? "";

function report(name, s) {
  console.log(`${name.padEnd(24)} ${String(s.length).padStart(6)} chars (~${Math.round(s.length / 1.7)} tk)`);
}
report("索引 (新)", index);
report("[参考] 全フィールド (旧)", fullTasks);
report("割り振り履歴 (20件)", history);
report("要約カード", cards);
report("前提情報", ctx);
console.log(`タスク数: ${tasks.length} / 履歴行数: ${db.prepare("SELECT COUNT(*) c FROM assignment_history").get().c}`);
