import { expect, test, type Page } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";

const API = "http://localhost:8799";

async function createTask(title: string, status = "todo"): Promise<number> {
  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, status }),
  });
  const task = await res.json();
  return task.id;
}

/** Doneのタスクを用意する。POST /api/tasks に status:"done" を渡しても通らないので
 * (Doneへの扉は検収だけ)、本番と同じ道を通す: review → 検収チェック → 確定 */
async function createDoneTask(title: string): Promise<number> {
  const id = await createTask(title, "review");
  await fetch(`${API}/api/tasks/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/tasks/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });
  return id;
}

async function getTaskStatus(id: number): Promise<string | undefined> {
  const res = await fetch(`${API}/api/board`);
  const board = await res.json();
  return board.tasks.find((t: any) => t.id === id)?.status;
}

// dnd-kit PointerSensor (distance:4) を発火させる手動ドラッグ
async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const fromBox = (await from.boundingBox())!;
  const toBox = (await to.boundingBox())!;
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2 + 2, { steps: 3 });
  await page.mouse.up();
}

test("ボードが4列+件数バッジで表示される", async ({ page }) => {
  await page.goto("/");
  for (const col of ["todo", "inprogress", "review", "done"]) {
    await expect(page.getByTestId(`column-${col}`)).toBeVisible();
    await expect(page.getByTestId(`count-${col}`)).toBeVisible();
  }
  // 件数バッジがAPIの実数と一致する
  const board = await (await fetch(`${API}/api/board`)).json();
  const todoCount = board.tasks.filter((t: any) => t.status === "todo").length;
  await expect(page.getByTestId("count-todo")).toHaveText(String(todoCount));
});

test("D&Dで列間移動しstatusが即時更新・リロード後も維持", async ({ page }) => {
  const id = await createTask("E2E: 列間移動テスト");
  await page.goto("/");
  const card = page.getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  await drag(page, card, page.getByTestId("column-review"));
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
  await expect.poll(() => getTaskStatus(id)).toBe("review");

  await page.reload();
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
});

test("列内並び替えがリロード後も維持される", async ({ page }) => {
  const a = await createTask("E2E: 並び替えA");
  const b = await createTask("E2E: 並び替えB");
  await page.goto("/");
  const cardA = page.getByTestId(`task-card-${a}`);
  const cardB = page.getByTestId(`task-card-${b}`);
  await expect(cardB).toBeVisible();

  // B を A の位置(上)へドラッグ → B, A の順になる
  await drag(page, cardB, cardA);

  async function orderInTodo(): Promise<number[]> {
    const ids = await page
      .getByTestId("column-todo")
      .locator("[data-testid^='task-card-']")
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-testid")!.replace("task-card-", ""))));
    return ids.filter((id) => id === a || id === b);
  }
  await expect.poll(orderInTodo).toEqual([b, a]);

  await page.reload();
  await expect(cardA).toBeVisible();
  await expect.poll(orderInTodo).toEqual([b, a]);
});

test("更新失敗時はロールバックしトースト表示、リトライで復帰", async ({ page }) => {
  const id = await createTask("E2E: 失敗リトライテスト");
  await page.goto("/");
  const card = page.getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  // PATCH を強制失敗させる
  await page.route(`**/api/tasks/${id}`, (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "forced failure" }) : route.continue()
  );
  await drag(page, card, page.getByTestId("column-review"));

  await expect(page.getByTestId("toast")).toBeVisible();
  // ロールバックでtodo列に戻っている + サーバー側は未変更
  await expect(page.getByTestId("column-todo").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getTaskStatus(id)).toBe("todo");

  // 障害解除してリトライ → 移動が成立しトーストが消える
  await page.unroute(`**/api/tasks/${id}`);
  await page.getByTestId("toast").getByRole("button", { name: "リトライ" }).click();
  await expect(page.getByTestId("toast")).toBeHidden();
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
  await expect.poll(() => getTaskStatus(id)).toBe("review");
});

test("DoneへはD&Dで移動できない (検収ボタン経由のみ) (#57)", async ({ page }) => {
  const id = await createTask("E2E: Doneドロップ禁止テスト");
  await page.goto("/");
  const card = page.getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  // Done列へドラッグしても動かない
  await drag(page, card, page.getByTestId("column-done"));
  await expect(page.getByTestId("column-todo").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getTaskStatus(id)).toBe("todo");
});

test("Review列: 検収OKチェック→一括確定でdoneになる (チェックだけでは動かない) (#57)", async ({ page }) => {
  const id = await createTask("E2E: 検収テスト", "review");
  await page.goto("/");
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();

  // チェックはマーキングのみ (Reviewに留まる)
  await page.getByTestId(`approve-${id}`).check();
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getTaskStatus(id)).toBe("review");

  // 一括確定ボタンでdoneへ
  await page.getByTestId("approve-commit").click();
  await expect(page.getByTestId("column-done").getByTestId(`task-card-${id}`)).toBeVisible();
  await expect.poll(() => getTaskStatus(id)).toBe("done");
});

test("プロジェクト: 切り替えるとボードが入れ替わり、#IDは1から振り直される (#86)", async ({ page }) => {
  const inFirst = await createTask("E2E: 元プロジェクトのタスク");

  // 新規プロジェクトを作って切り替える
  const created = await (
    await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E: 別プロジェクト" }),
    })
  ).json();
  const pid = created.project.id as number;

  await page.goto("/");
  await expect(page.getByTestId(`task-card-${inFirst}`)).toBeVisible();

  // 詳細パネルを開いたまま切り替える (前プロジェクトのタスクが残ると危険)
  await page.getByTestId(`task-card-${inFirst}`).click();
  await expect(page.getByTestId("task-detail-panel")).toBeVisible();

  await page.getByTestId("project-select").selectOption(String(pid));
  await expect(page).toHaveURL(new RegExp(`/p/${pid}$`)); // #97: 表示中のプロジェクトはURLが持つ

  // ページ遷移なのでパネルは残らない
  await expect(page.getByTestId("task-detail-panel")).toBeHidden();
  // 元プロジェクトのタスクは見えない (ファイルごと別なので混ざらない)
  await expect(page.getByTestId(`task-card-${inFirst}`)).toBeHidden();
  // 新プロジェクトの最初のタスクは #1 (対象プロジェクトはヘッダで明示する #97)
  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ChatBan-Project": String(pid) },
    body: JSON.stringify({ title: "E2E: 新プロジェクトの1件目" }),
  });
  expect((await res.json()).id).toBe(1);

  // 元へ戻すと元のタスクが復活する
  await page.getByTestId("project-select").selectOption("1");
  await expect(page).toHaveURL(/\/p\/1$/);
  await expect(page.getByTestId(`task-card-${inFirst}`)).toBeVisible();
});

test("削除はゴミ箱行きで復元できる。実体を消せるのはゴミ箱からだけ (#102)", async ({ page }) => {
  const id = await createTask("E2E: ゴミ箱テスト");
  await page.goto("/");
  await expect(page.getByTestId(`task-card-${id}`)).toBeVisible();

  // チャット/MCPと同じ経路 (DELETE /api/tasks/:id) はゴミ箱行き
  await fetch(`${API}/api/tasks/${id}`, { method: "DELETE" });
  await expect(page.getByTestId(`task-card-${id}`)).toBeHidden();

  // 実体は残っている
  const trashed = await (await fetch(`${API}/api/trash`)).json();
  expect(trashed.tasks.some((t: any) => t.id === id)).toBe(true);

  // ゴミ箱画面から戻せる
  await page.getByRole("button", { name: "🗑 ゴミ箱" }).click();
  await page.getByRole("button", { name: "戻す" }).first().click();
  await page.getByRole("button", { name: "ボード" }).click();
  await expect(page.getByTestId(`task-card-${id}`)).toBeVisible();

  // 完全削除は二段階 (押し間違いで消えない)
  await fetch(`${API}/api/tasks/${id}`, { method: "DELETE" });
  await page.getByRole("button", { name: "🗑 ゴミ箱" }).click();
  await page.getByRole("button", { name: "完全に削除" }).first().click();
  await expect(page.getByRole("button", { name: "本当に消す" })).toBeVisible();
  await page.getByRole("button", { name: "本当に消す" }).click();
  await expect(page.getByText("ゴミ箱は空です")).toBeVisible(); // 反映を待ってから実体を確認する
  const after = await (await fetch(`${API}/api/trash`)).json();
  expect(after.tasks.some((t: any) => t.id === id)).toBe(false);
});

test("配信はプロジェクト単位のroomへ届く (#99)", async () => {
  // ブラウザ2枚での検証はまだできない (サーバー側アクティブが1つなので全画面が同じプロジェクトを見る。
  // タブごとに別プロジェクトを開けるのは #97)。ここでは接続時にプロジェクトを明示した購読者で確かめる
  const other = (
    await (
      await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E: 配信テスト" }),
      })
    ).json()
  ).project.id as number;

  const sock = io(API, { query: { project: 1 }, transports: ["websocket"] });
  const received: number[] = [];
  sock.on("board:changed", (p: { tasks: unknown[] }) => received.push(p.tasks.length));
  await new Promise<void>((r) => sock.on("connect", () => r()));

  // プロジェクト1への変更は届く
  await createTask("E2E: room検証(プロジェクト1)");
  await expect.poll(() => received.length).toBeGreaterThan(0);
  const afterFirst = received.length;

  // 別プロジェクトを触っても届かない (#97: 対象はヘッダで明示する)
  await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ChatBan-Project": String(other) },
    body: JSON.stringify({ title: "E2E: room検証(別プロジェクト)" }),
  });
  await new Promise((r) => setTimeout(r, 500));
  expect(received.length).toBe(afterFirst);

  sock.close();
});

test("タブごとに別プロジェクトを開ける。片方の更新はもう片方に届かない (#97)", async ({ page, browser }) => {
  const other = (
    await (
      await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E: 別タブ用" }),
      })
    ).json()
  ).project.id as number;

  // 1枚目はプロジェクト1、2枚目は別プロジェクトを直接URLで開く
  await page.goto("/p/1");
  const beforeTodo = await page.getByTestId("count-todo").textContent();

  const ctx = await browser.newContext();
  const other2 = await ctx.newPage();
  await other2.goto(`/p/${other}`);
  await expect(other2.getByTestId("count-todo")).toHaveText("0");

  // 2枚目のプロジェクトにタスクを足すと、2枚目だけが増える
  await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ChatBan-Project": String(other) },
    body: JSON.stringify({ title: "E2E: 別タブのタスク" }),
  });
  await expect(other2.getByTestId("count-todo")).toHaveText("1");
  await expect(page.getByTestId("count-todo")).toHaveText(beforeTodo ?? "");

  // リロードしてもURLのプロジェクトのまま (F5で戻らない)
  await other2.reload();
  await expect(other2.getByTestId("count-todo")).toHaveText("1");
  await ctx.close();
});

test("Done列のカードはドラッグで持ち出せない (#105)", async ({ page }) => {
  const id = await createDoneTask("E2E: Doneから持ち出し禁止");
  await page.goto("/");
  const card = page.getByTestId("column-done").getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  // Todo列へドラッグしても動かない (検収後アーカイブ完了までの間に持ち出せると
  // あとから走るアーカイブ処理が archived=1 にして幽霊タスクになる)
  await drag(page, card, page.getByTestId("column-todo"));
  await expect(page.getByTestId("column-done").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getTaskStatus(id)).toBe("done");
});

// MCP (Streamable HTTP) をエージェントと同じ経路で叩く。SSEで返るので最後のJSONを拾う
async function mcp(tool: string, args: unknown): Promise<any> {
  const res = await fetch(`${API}/mcp/1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = await res.text();
  const line = body
    .split("\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop()!;
  return JSON.parse(JSON.parse(line).result.content[0].text);
}

/** MCPの道具一覧 (契約そのもの)。同じ取り出しが3か所に書かれていたのでここへ寄せた */
async function mcpToolList(): Promise<any[]> {
  const res = await fetch(`${API}/mcp/1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const line = (await res.text())
    .split("\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop()!;
  return JSON.parse(line).result.tools as any[];
}

test("経緯メモの上書きは版が合うときだけ通る。状態変更は版に縛られない (#112)", async () => {
  const id = await createTask("楽観ロックの検証");

  // 版を添えないと適用されない (「必須」がプロンプトではなく契約で効いている)
  const noVersion = await mcp("update_tasks", { updates: [{ id, context: "版なしで書く" }] });
  expect(noVersion.conflicts?.[0]?.id).toBe(id);
  expect(noVersion.conflicts[0].contextVersion).toBe(1);
  // #120: 弾いたものを updated に載せない。成功と失敗を排他にする
  expect(noVersion.ok).toBe(false);
  expect(noVersion.updated).toHaveLength(0);

  // 正しい版なら通り、版が上がる
  const ok = await mcp("update_tasks", { updates: [{ id, context: "Aの追記", context_version: 1 }] });
  expect(ok.conflicts).toBeUndefined();
  expect(ok.updated[0].contextVersion).toBe(2);

  // 古い版のままだと衝突し、Aの追記は消えない。現在の全文が返るのでマージできる
  const stale = await mcp("update_tasks", { updates: [{ id, context: "Bの追記", context_version: 1 }] });
  expect(stale.conflicts[0].context).toBe("Aの追記");
  expect(stale.conflicts[0].contextVersion).toBe(2);

  // 状態変更は版を要求されず、経緯メモの版も上げない
  // (1本の版で守ると、長い書き戻しが無関係な状態変更で弾かれてしまう)
  const statusOnly = await mcp("update_tasks", { updates: [{ id, status: "inprogress" }] });
  expect(statusOnly.conflicts).toBeUndefined();
  expect(statusOnly.updated[0].status).toBe("inprogress");
  expect(statusOnly.updated[0].contextVersion).toBe(2);
});

test("検収の印はDBに残り、AIは読めるが付けられない (#108)", async () => {
  const id = await createTask("検収フラグの検証", "review");

  // 人間の経路(REST)でだけ付く
  await fetch(`${API}/api/tasks/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const checked = await (await fetch(`${API}/api/tasks/${id}`)).json();
  expect(checked.checkedAt).toBeTruthy();

  // エージェントはSQL窓口で読める
  const read = await mcp("query_log", { sql: `SELECT checked_at FROM tasks WHERE id = ${id}` });
  expect(read.rows[0].checked_at).toBeTruthy();

  // 書く口はどこにも無い: SQL窓口は読み取り専用、update_tasks のスキーマにも無い
  const write = await mcp("query_log", { sql: `UPDATE tasks SET checked_at = NULL WHERE id = ${id}` });
  expect(write.ok).toBe(false);
  await mcp("update_tasks", { updates: [{ id, checked_at: null, checkedAt: null }] });
  const afterAgent = await (await fetch(`${API}/api/tasks/${id}`)).json();
  expect(afterAgent.checkedAt).toBeTruthy(); // エージェントの指定は素通りする(消せない)

  // 作業中の列へ戻すと印は消える (確かめたのは前の状態に対してなので)
  await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "inprogress" }),
  });
  const reopened = await (await fetch(`${API}/api/tasks/${id}`)).json();
  expect(reopened.checkedAt).toBeFalsy();
});

test("sync_board: 同期トークンで差分が返り、他所の変更も拾える (#150/#187)", async () => {
  // ここが効かないと、エージェントは「自分が最後に読んだ一覧」を現在だと思い込んだままになる。
  // 実際に 2026-08-15 に誤報告が起きている (人間が検収して消えたのを「ビューのバグ」と報告した)
  const full = await mcp("sync_board", {});
  expect(typeof full.syncToken).toBe("string");
  expect(typeof full.projectContextVersion).toBe("number");
  // #187: 前提情報は版だけ。本文はここに載せない (3,000字級がボードを取るたびに乗っていた)
  expect(full.projectContext).toBeUndefined();

  // **自分以外の経路**で動かす。差分の値打ちは「自分が見ていない間に何が動いたか」にある
  const id = await createTask("E2E: 差分で拾われるタスク");
  await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });

  const delta = await mcp("sync_board", { sync_token: full.syncToken });
  expect(delta.syncToken).not.toBe(full.syncToken);
  // 全件は返らない (差分なのでタスク配列を持たない)
  expect(delta.tasks).toBeUndefined();
  const line = (delta.boardChanges as string[]).find((c) => c.includes(`#${id}`));
  expect(line).toBeTruthy();
  // **行だけ見て現在が確定すること。**IDしか書いていない差分だと古い一覧とマージさせることになる
  expect(line).toContain("E2E: 差分で拾われるタスク");

  // 失効したトークンでも失敗させない (エラーを返すとLLMがリトライを考え始める)
  const stale = await mcp("sync_board", { sync_token: "p1-20200101T000000-1" });
  expect(Array.isArray(stale.tasks)).toBe(true);
  expect(String(stale.note)).toContain("全件");
});

test("MCPの読み取りはSQL窓口1本。落とした一覧ツールは同じ内容を引ける (#108)", async () => {
  const id = await createTask("SQL窓口の検証", "review");

  // 読み取り専用ツールは query_log と search_tasks だけ (list_* は無い)
  const res = await fetch(`${API}/mcp/1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const names: string[] = JSON.parse(
    (await res.text())
      .split("\n")
      .map((l) => l.replace(/^data: /, "").trim())
      .filter((l) => l.startsWith("{"))
      .pop()!
  ).result.tools.map((t: any) => t.name);
  // get_board は #187 で sync_board に置き換わった (名前と語彙を揃える契約変更)
  for (const gone of ["list_tasks", "list_trash", "list_members", "get_metrics", "get_board"]) {
    expect(names).not.toContain(gone);
  }
  expect(names).toContain("query_log");
  expect(names).toContain("sync_board");

  // 落としたぶんはSQLで引ける (接続の足場だけは get_project_context に残す)。
  // **作ったタスクに絞って引く** — 全件だと query_log の上限 (200行) で切られ、
  // 積み重なったE2Eデータでは新しいものが範囲外に落ちる (実測: 387件で発生)
  const board = await mcp("query_log", {
    sql: `SELECT id, status, title FROM tasks WHERE archived=0 AND trashed_at IS NULL AND id=${id}`,
  });
  expect(board.rows.some((r: any) => r.id === id)).toBe(true);

  const anchor = await mcp("get_project_context", {});
  expect(anchor.project.id).toBe(1);
});

test("done_at は完了に入った瞬間だけ打刻され、その後の編集では動かない (#108)", async () => {
  const id = await createTask("done_atの検証", "review");
  const patch = (body: unknown) =>
    fetch(`${API}/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = async () => (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;

  expect((await get()).doneAt).toBeFalsy();

  // 検収チェックを先に付ける。approve はサーバー側で「Review列 + 検収済み」を確かめるので、
  // チェック無しでは通らない (以前は無条件に done にできたため、このテストも省略していた)
  await fetch(`${API}/api/tasks/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/tasks/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });
  const done = await get();
  expect(done.doneAt).toBeTruthy();

  // 完了後の編集で「終わった日」は動かない (updated_at とはここが違う)
  await patch({ summary: "完了後に編集" });
  const edited = await get();
  expect(edited.summary).toBe("完了後に編集"); // 更新自体は通っている
  expect(edited.doneAt).toBe(done.doneAt); // それでも「終わった日」は動かない

  // 完了から外れたらクリアされる (終わっていないものに完了日が残らない)
  await patch({ status: "review" });
  expect((await get()).doneAt).toBeFalsy();
});

test("依存チップをクリックすると依存先の詳細が開く (カード自体のクリックと取り合わない) (#111)", async ({ page }) => {
  const depId = await createTask("依存先のタスク", "inprogress");
  const id = await createTask("依存元のタスク");
  await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blockedBy: [depId] }),
  });

  await page.goto("/");
  const chip = page.getByTestId(`task-card-${id}`).getByTestId(`dep-chip-${depId}`);
  await expect(chip).toBeVisible();
  // ホバーで中身が読める (標準のツールチップ。レイアウトを覆わない)
  await expect(chip).toHaveAttribute("title", /依存先のタスク/);

  // クリックで開くのは依存「先」。依存元(カード自体)ではない
  await chip.click();
  const panel = page.getByTestId("task-detail-panel");
  await expect(panel).toContainText("依存先のタスク");
  await expect(panel).not.toContainText("依存元のタスク");
});

test("パネルから依存を双方向に辿れる (これ待ち → 待ち) (#111)", async ({ page }) => {
  const depId = await createTask("先に終わらせるタスク", "inprogress");
  const id = await createTask("それを待っているタスク");
  await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blockedBy: [depId] }),
  });

  await page.goto("/");
  const panel = page.getByTestId("task-detail-panel");

  // 依存先を開くと「これ待ち」に依存元が出る (逆引き。片方向だと行き止まりになる)
  await page.getByTestId(`task-card-${depId}`).click();
  await expect(panel).toContainText("これ待ち");
  await panel.getByTestId(`dep-chip-${id}`).click();

  // 戻ってきた側には「待ち」で依存先が出る
  await expect(panel).toContainText("それを待っているタスク");
  await expect(panel.getByTestId(`dep-chip-${depId}`)).toBeVisible();
});

test("前提情報は版が合うときだけ上書きできる (読まずに書くと全員の運用ルールが消える) (#115)", async () => {
  const before = await mcp("get_project_context", {});
  const v = before.version as number;

  const ok = await mcp("update_project_context", { text: "Aが書いた運用ルール", version: v });
  expect(ok.ok).toBe(true);

  // 古い版のまま別の全文を投げても通らない。現在値が返るのでマージして再実行できる
  const stale = await mcp("update_project_context", { text: "Bが読まずに書いた", version: v });
  expect(stale.ok).toBe(false);
  expect(stale.conflict.text).toBe("Aが書いた運用ルール");

  const after = await mcp("get_project_context", {});
  expect(after.text).toBe("Aが書いた運用ルール");

  // 元に戻す (このプロジェクトは他のテストと共用)
  await mcp("update_project_context", { text: before.text, version: after.version });
});

test("並べ替えの母集団はサーバー側で絞る。対象外のIDは無視して報告する (#108)", async () => {
  const a = await createTask("並べ替えA");
  const b = await createTask("並べ替えB");
  const gone = await createTask("アーカイブ行き", "review");
  await fetch(`${API}/api/tasks/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [gone] }),
  });

  // アーカイブ済みと存在しないIDを混ぜても、全体は失敗せず ignored で返る
  const r = await mcp("reorder_tasks", { status: "todo", ids: [b, gone, 999999, a] });
  expect(r.ignored).toContain(gone);
  expect(r.ignored).toContain(999999);
  expect(r.ordered).toBe(2);

  // 指定した2件は指定順に並ぶ
  const board = await (await fetch(`${API}/api/board`)).json();
  const todo = board.tasks.filter((t: any) => t.status === "todo").sort((x: any, y: any) => x.sort - y.sort);
  const idx = (id: number) => todo.findIndex((t: any) => t.id === id);
  expect(idx(b)).toBeLessThan(idx(a));
});

test("設定のプロジェクト一覧からMCP接続先をコピーできる (#117)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "⚙ 設定" }).click();

  // プロジェクトごとに接続先が違う (URLで固定する設計 #96) ので、一覧に出す
  const btn = page.getByTestId("copy-mcp-1");
  await expect(btn).toContainText("/mcp/1");

  await btn.click();
  await expect(btn).toContainText("コピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/mcp\/1$/);
});

test("版が合わない更新は、同じ行の他のフィールドも保存しない (#120)", async () => {
  const id = await createTask("部分適用しないことの検証");
  const before = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;

  // context と summary を一緒に送り、context の版だけ古い
  const r = await mcp("update_tasks", {
    updates: [{ id, context: "古い版で書く", context_version: 999, summary: "これも保存されてはいけない" }],
  });

  expect(r.ok).toBe(false);
  expect(r.updated).toHaveLength(0); // 弾いた行は updated に載らない
  expect(r.note).toContain("一切適用していません");

  const after = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  expect(after.summary).toBe(before.summary); // 巻き添えで保存されない
  expect(after.updatedAt).toBe(before.updatedAt); // 拒否された書き込みで最終更新も動かない
});

test("存在しないIDは notFound で名指しし、成功と混ぜない (#123 #124)", async () => {
  const id = await createTask("実在するタスク");

  // 一部だけ失敗 = partial。適用できた行だけが updated に入り、null は混ざらない
  const partial = await mcp("update_tasks", {
    updates: [{ id: 999999, summary: "存在しない" }, { id, summary: "実在する方" }],
  });
  expect(partial.ok).toBe(false);
  expect(partial.status).toBe("partial");
  expect(partial.notFound).toEqual([999999]);
  expect(partial.updated).toHaveLength(1);
  expect(partial.updated.every((t: unknown) => t != null)).toBe(true);
  expect(partial.note).toContain("2件のうち1件を適用しました");

  // 実在する方は実際に書けている (部分適用は「できたものはできた」)
  const after = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  expect(after.summary).toBe("実在する方");

  // 全滅は failed。ok:false だけだと「全部か一部か」が分からないので状態で言う
  const failed = await mcp("update_tasks", { updates: [{ id: 999998, summary: "x" }] });
  expect(failed.status).toBe("failed");
  expect(failed.updated).toHaveLength(0);

  const all = await mcp("update_tasks", { updates: [{ id, summary: "全部通る" }] });
  expect(all.ok).toBe(true);
  expect(all.status).toBe("ok");
});

test("経緯メモは版なしで追記でき、追記どうしは互いを消さない", async () => {
  const id = await createTask("追記の検証");

  // 全文上書きは版が要る (既存の守り)。追記は要らない — 足すだけなので他人の追記を消さない
  const a = await mcp("update_tasks", { updates: [{ id, context_append: "1件目の追記" }] });
  expect(a.ok).toBe(true);

  // 読み直さずにもう1件足せる。版を持っていなくても通る
  const b = await mcp("update_tasks", { updates: [{ id, context_append: "2件目の追記" }] });
  expect(b.ok).toBe(true);

  const after = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  expect(after.context).toBe(["1件目の追記", "2件目の追記"].join("\n\n")); // 1件目が残っている
  expect(after.contextVersion).toBeGreaterThan(1); // 版は進む (全文置換しようとしている人を弾くため)

  // 全文上書きは従来どおり版が要る
  const stale = await mcp("update_tasks", { updates: [{ id, context: "全部消す", context_version: 1 }] });
  expect(stale.ok).toBe(false);
  const still = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  expect(still.context).toContain("1件目の追記");
});

test("生きているタスクは live_tasks ビューで引ける (母集団の条件を毎回書かせない)", async () => {
  const alive = await createTask("生きているタスク");
  const trashed = await createTask("ゴミ箱行きのタスク");
  await mcp("delete_tasks", { ids: [trashed] });

  // **この2件に絞って引く。**母集団を全件取ると query_log の上限 (200行) で切られ、
  // 積み重なったE2Eデータでは新しく作ったほうが範囲外に落ちて落ちる (実測: 387件で発生)。
  // 確かめたいのは「live_tasks にゴミ箱が混ざらない」ことなので、母集団の大きさは要らない
  const r = await mcp("query_log", {
    sql: `SELECT id, title FROM live_tasks WHERE id IN (${alive}, ${trashed})`,
  });
  const ids = (r.rows as any[]).map((x) => x.id);
  expect(ids).toContain(alive);
  expect(ids).not.toContain(trashed); // 条件を書かなくてもゴミ箱は混ざらない

  // tasks を直に引けばゴミ箱も見える (見たいときは見られる)
  const raw = await mcp("query_log", {
    sql: `SELECT id FROM tasks WHERE id=${trashed} AND trashed_at IS NOT NULL`,
  });
  expect(raw.rows).toHaveLength(1);
});

test("新しいプロジェクトの前提情報は空欄でなく既定値が入っている (推測させない)", async () => {
  const res = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `テンプレート検証 ${Date.now()}` }),
  });
  const created = (await res.json()) as any;
  const id = created.project?.id ?? created.id;

  const ctx = (await (
    await fetch(`${API}/api/project-context`, { headers: { "X-ChatBan-Project": String(id) } })
  ).json()) as any;

  // 列の意味が空欄のままだと、LLMは一般的な意味で埋めてしまう (外部エージェントの実例)
  expect(ctx.text).toContain("review = 検収待ち");
  expect(ctx.text).toContain("done = 人間が実物で確かめたもの");
  // やらない決定の残し方も既定値で書いてある (rejected が一度も使われなかった実例への手当て)
  expect(ctx.text).toContain("rejected");
  // ただし調整できることは明示されている (プロジェクトごとに違うのは review の意味)
  expect(ctx.text).toContain("違うなら書き換える");
  // 書き換えたら例文を消すところまで指示する。例が残っていると「どちらなのか」を考えさせる
  expect(ctx.text).toContain("但し書きごと消すこと");
  // 「使わないもの」を書く欄。空欄は「まだ入っていない」と読まれて埋められる
  expect(ctx.text).toContain("このプロジェクトで使わないもの");
});

test("前提情報のリファレンスは、足りないときだけ知らせ、求められたら渡す", async () => {
  // 既定では足場だけ。リファレンス全文は乗らない (毎回の取得を重くしない)
  const plain = await mcp("get_project_context", {});
  expect(plain.reference).toBeUndefined();

  // 節が揃っていないプロジェクトには、足りないものだけ知らせる
  // (E2E用DBの前提情報はテンプレート導入前のものなので、必ず何か欠けている)
  expect(plain.templateHint?.missing?.length).toBeGreaterThan(0);
  expect(plain.templateHint.note).toContain("reference=true");

  // 求められたら渡す。雛形ではなく選択肢のカタログなので、択一であることが分かる形
  const withRef = await mcp("get_project_context", { reference: true });
  expect(withRef.reference).toContain("どれか選ぶ");
  expect(withRef.reference).toContain("review = 検収待ち");
  expect(withRef.reference).toContain("review = 相手待ち");
  expect(withRef.referenceNote).toContain("そのまま書き戻さないこと");
  // summary の書き分けと、追記が効く経緯メモの書き始め方
  expect(withRef.reference).toContain("summary の書き方");
  expect(withRef.reference).toContain("## 経過");
  // 参考と前提情報が食い違ったときの優先順位を名指しする (判断させない)
  expect(withRef.reference).toContain("前提情報が優先");

  // boolean を文字列で送るMCPクライアントがある (実測: Claude Code)。受け側で吸収する
  const asString = await mcp("get_project_context", { reference: "true" });
  expect(asString.reference).toBeDefined();
  const asFalse = await mcp("get_project_context", { reference: "false" });
  expect(asFalse.reference).toBeUndefined();
});

test("summary の契約はチャットとMCPで同じ文言になっている (入口ごとにズレない)", async () => {
  const res = await fetch(`${API}/mcp/1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body;
  const tools = JSON.parse(line.replace(/^data: /, "")).result.tools as any[];

  const update = tools.find((t) => t.name === "update_tasks");
  const summaryDesc = update.inputSchema.properties.updates.items.properties.summary.description;
  // MCP側は以前「現況の一言。カードに表示される」だけで、読み手が誰かが抜けていた
  expect(summaryDesc).toContain("AIとユーザーの両方に");
  expect(summaryDesc).toContain("次の判断を促す");
  // 「状態を書くな」という否定形はやめた (守られないので、書くべきものを名指しする)
  expect(summaryDesc).not.toContain("状態ではなく");

  const dep = update.inputSchema.properties.updates.items.properties.blocked_by.description;
  // #152: 依存は緩い参照で、コードは何も止めない (mayEnterDone は依存先を見ない)。
  // 以前は「それが終わらないと着手できない」と書いてあり、実装が課していない制約を
  // 宣言していた — 相互依存や循環を見たエージェントが「矛盾」として直そうとする。
  // 契約側で「止めない」「循環でも矛盾ではない」を言えていることを検査する
  expect(dep).toContain("コードは何も止めない");
  expect(dep).toContain("循環していても矛盾ではない");
  expect(dep).not.toContain("着手できない");
  // 依存を優先順位に使う失敗 (#41) への歯止めは残っていること
  expect(dep).toContain("reorder_tasks");

  // 契約が「渡せないもの」を案内していないこと。additionalProperties:false なので、
  // 存在しないパラメータ名を書くと渡した側が確実にエラーになる (実際 rejected の説明が
  // 「reasonに根拠を書く」で、reason というパラメータは無かった)
  const props = Object.keys(update.inputSchema.properties.updates.items.properties);
  const rejected = update.inputSchema.properties.updates.items.properties.rejected.description;
  for (const name of ["reason"]) {
    expect(props).not.toContain(name);
    expect(rejected).not.toContain(`${name}に`);
  }
  // 見出しは実際に更新できるものを言う (一覧しか見ないクライアントでも context_append に気づける)
  expect(update.description).toContain("context_append");
});

test("完了は done_tasks ビューで引ける。登録日と取り違えようがない", async () => {
  const id = await createTask("完了ビューの検証", "review");
  // 検収 → Done。done_at はこの瞬間に打刻される
  await fetch(`${API}/api/tasks/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/tasks/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });

  const r = await mcp("query_log", {
    sql: `SELECT id, done_day, done_at FROM done_tasks WHERE id=${id}`,
  });
  expect(r.rows).toHaveLength(1);
  // 日付は列として出ているので date() を書かなくてよい
  expect((r.rows[0] as any).done_day).toBe((r.rows[0] as any).done_at.slice(0, 10));

  // 終わっていないものは入らない (created_at を完了日と取り違える余地がない)
  const alive = await createTask("まだ終わっていない");
  const none = await mcp("query_log", {
    sql: `SELECT id FROM done_tasks WHERE id=${alive}`,
  });
  expect(none.rows).toHaveLength(0);
});

test("要約カードの列は frozen (旧 settled)。SQL窓口から新しい名前で引ける", async () => {
  // 改名のマイグレーションが効いていること。旧名で引くと落ちる = 移行漏れが検出できる
  const r = await mcp("query_log", {
    sql: "SELECT id, title, frozen FROM summary_cards LIMIT 1",
  });
  expect(r.error).toBeUndefined();

  const old = await mcp("query_log", { sql: "SELECT settled FROM summary_cards LIMIT 1" });
  expect(JSON.stringify(old)).toContain("no such column");
});

test("SQLが失敗したら、直せる材料を一緒に返す (説明を厚くする代わりの事後注入)", async () => {
  // 列名を間違えたら、実DBから引いたスキーマが返る (説明とスキーマがズレない)
  const badCol = await mcp("query_log", { sql: "SELECT id, titel FROM live_tasks LIMIT 1" });
  expect(badCol.ok).toBe(false);
  expect(badCol.schema["live_tasks (ビュー)"]).toContain("title");
  expect(badCol.hint).toContain("live_tasks");

  // 他のDBの関数を使ったら、SQLiteでの書き方が返る
  const badFn = await mcp("query_log", { sql: "SELECT date_trunc('day', created_at) FROM live_tasks" });
  expect(badFn.ok).toBe(false);
  expect(JSON.stringify(badFn.dialect)).toContain("start of month");
});

test("エラーにならない間違いには、結果と一緒に一言添える", async () => {
  // tasks 直引き = ゴミ箱もアーカイブも混ざる。エラーにならないので気づけない
  const raw = await mcp("query_log", { sql: "SELECT id, title FROM tasks LIMIT 3" });
  expect(raw.rows.length).toBeGreaterThan(0); // 結果は普通に返る
  expect(raw.note).toContain("live_tasks");

  // created_at で完了を数える = 登録日を数えている (実データで踏まれていた間違い)
  const wrongDate = await mcp("query_log", {
    sql: "SELECT date(created_at) d, COUNT(*) n FROM tasks WHERE archived=1 GROUP BY 1",
  });
  expect(wrongDate.note).toContain("done_at");

  // 正しく引いたときは余計なことを言わない
  const ok = await mcp("query_log", { sql: "SELECT id, title FROM live_tasks LIMIT 3" });
  expect(ok.note).toBeUndefined();
});

test("検収の確定はサーバー側で条件を確かめる (UIのフィルタに依存しない)", async () => {
  // Doneへ至る唯一の扉。以前は ids をそのまま done にしていて、直接叩けば
  // Todoのタスクもゴミ箱の中のタスクもDoneにできた (実測で3ケースとも通った)
  const todo = await createTask("検収ガード: Todoのまま");
  const unchecked = await createTask("検収ガード: Review未検収", "review");
  const trashed = await createTask("検収ガード: ゴミ箱");
  await fetch(`${API}/api/tasks/${trashed}`, { method: "DELETE" });

  const ng = await (
    await fetch(`${API}/api/tasks/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [todo, unchecked, trashed] }),
    })
  ).json();
  expect(ng.ok).toBe(false);
  expect(ng.updated).toHaveLength(0);
  expect(ng.skipped).toHaveLength(3);
  // 通らなかった理由が分かる (黙って落とすと「押したのに動かない」になる)
  expect(JSON.stringify(ng.skipped)).toContain("Review列にありません");
  expect(JSON.stringify(ng.skipped)).toContain("検収チェックが付いていません");
  expect(JSON.stringify(ng.skipped)).toContain("ゴミ箱");

  expect(await getTaskStatus(todo)).toBe("todo");
  expect(await getTaskStatus(unchecked)).toBe("review");

  // 正常系: Review + 検収済み は通る
  const ok = await createTask("検収ガード: 正しく検収済み", "review");
  await fetch(`${API}/api/tasks/${ok}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const r = await (
    await fetch(`${API}/api/tasks/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [ok] }),
    })
  ).json();
  expect(r.ok).toBe(true);
  expect(r.skipped).toBeUndefined();
  await expect.poll(() => getTaskStatus(ok)).toBe("done");
});

test("検収APIを通らないRESTからもDoneには入れない (扉は1つ)", async () => {
  // 検収APIだけを厳しくしても、PATCH /api/tasks/:id に status:"done" を投げれば素通りしていた
  // (自動レビュー指摘)。フロントは Board.tsx の handleDragEnd で Done列へのD&Dを禁止しているが、
  // その禁止がクライアント側にしか無く、PR #1 で塞いだのとまったく同じ形の穴だった。
  // 条件そのもの (Review列 + 検収済み) を updateTasks の不変条件にしたので、入口を問わない
  const patch = async (id: number, body: unknown) =>
    (
      await fetch(`${API}/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();

  const todo = await createTask("扉は1つ: Todoから直接Done");
  const r1 = await patch(todo, { status: "done" });
  expect(r1.status).toBe("todo");
  expect(r1.note).toContain("Doneへは移していません"); // 黙って無視しない
  expect(await getTaskStatus(todo)).toBe("todo");

  // 同じ patch に入っている他のフィールドは保存する (status だけ戻す)
  const unchecked = await createTask("扉は1つ: Review未検収", "review");
  const r2 = await patch(unchecked, { status: "done", summary: "この一行は残る" });
  expect(r2.status).toBe("review");
  expect(r2.summary).toBe("この一行は残る");

  // 新規作成でいきなりDoneも作れない (生まれた瞬間に検収済みのものは無い)
  const created = await (
    await fetch(`${API}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "扉は1つ: 最初からDone", status: "done" }),
    })
  ).json();
  expect(created.status).toBe("review");
  expect(created.note).toContain("Doneへは移していません");

  // 正常系: 検収を通ればこの経路でも入る (条件を満たすかどうかだけを見ている)
  const ok = await createTask("扉は1つ: 検収済みならPATCHでも通る", "review");
  await fetch(`${API}/api/tasks/${ok}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const r3 = await patch(ok, { status: "done" });
  expect(r3.status).toBe("done");
  expect(r3.note).toBeUndefined();
});

test("入口で確かめる: 知らない列・居ないタスク・居ないプロジェクト", async () => {
  // TypeScriptの型は実行時に消えるので、RESTは何でも保存できた。status:"banana" は
  // ボードの4列に出ず、詳細を開くと STATUS_LABELS[status] が undefined で画面が落ちる。
  // 「消えた」ように見えて実在する、が一番たちが悪い (自動レビュー指摘)
  const created = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "知らない列", status: "banana" }),
  });
  expect(created.status).toBe(400);
  expect((await created.json()).error).toContain("todo / inprogress / review / done");

  const id = await createTask("入口の検証");
  const patched = await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "banana" }),
  });
  expect(patched.status).toBe(400);
  expect(await getTaskStatus(id)).toBe("todo"); // 何も書き換わっていない

  // 居ないタスクの専用チャットは、LLMを呼ぶ前に断る (呼んでから気づくと課金だけ発生する)
  const ghost = await fetch(`${API}/api/tasks/999999/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "このタスクを進めて" }),
  });
  expect(ghost.status).toBe(404);

  // 居ないプロジェクトのPATCHは500ではなく404 (古いタブと削除の競合で普通に踏む)
  const noProject = await fetch(`${API}/api/projects/999999`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "変更後" }),
  });
  expect(noProject.status).toBe(404);
});

test("検収の印を付けられるのはReview列だけ (順序を飛ばして確定できない)", async () => {
  // Doneへの遷移は「Review + 印」を見ているが、印を付ける側が列を見ていなかったので、
  // Todoのうちに印を付けてからReviewへ動かすと、Reviewに入ってから一度も確かめずに
  // 確定まで通せた (自動レビュー指摘)。順序そのものを守らせる
  const check = (id: number, checked = true) =>
    fetch(`${API}/api/tasks/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked }),
    });

  const todo = await createTask("順序飛ばし: Todoで印を付ける");
  const ng = await check(todo);
  expect(ng.status).toBe(409);
  expect((await ng.json()).error).toContain("Review 列のタスクだけ");

  // Reviewへ動かしてからなら付く。そのうえで確定できる
  await fetch(`${API}/api/tasks/${todo}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });
  expect((await check(todo)).status).toBe(200);
  const r = await (
    await fetch(`${API}/api/tasks/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [todo] }),
    })
  ).json();
  expect(r.ok).toBe(true);

  // ゴミ箱のタスクにも付けられない
  const trashed = await createTask("順序飛ばし: ゴミ箱", "review");
  await fetch(`${API}/api/tasks/${trashed}`, { method: "DELETE" });
  expect((await check(trashed)).status).toBe(409);

  // 外すのはいつでもよい (印を消す方向は安全)
  const plain = await createTask("順序飛ばし: 印を外すのは自由");
  expect((await check(plain, false)).status).toBe(200);
});

test("計測系と監査ログのAPIは無い (#181の撤去漏れの番人)", async () => {
  // ここには「全ログExportが人が読める形で返る」テストがあった。#181 で監査ログごと撤去した。
  // **消えたことをテストで固定する** — 撤去したはずのものが復活したら落ちる側にしておく
  // (#179 では消し残した .mjs が壊れたまま残り、テストが無いので気づけなかった)
  for (const path of ["/api/metrics", "/api/audit", "/api/audit/export", "/api/models", "/api/settings/models"]) {
    const res = await fetch(`${API}${path}`);
    expect(res.status, `${path} がまだ生きている`).toBe(404);
    const post = await fetch(`${API}${path}`, { method: "POST" });
    expect(post.status, `${path} (POST) がまだ生きている`).toBe(404);
  }
});

test("存在しないプロジェクトを指定したSocketは、既定プロジェクトの更新を受け取らない (#125)", async () => {
  // RESTは存在しないプロジェクト指定を400で拒否するのに、Socketだけ「指定なし」と同じ扱いに
  // 落として既定プロジェクトのroomへ入れていた。/p/999999 を開くと画面は読み込み失敗なのに、
  // Socketからは既定プロジェクトのタスクが流れてきて、存在しないURLの上に別物が並ぶ
  const ghost = io(API, { query: { project: 999999 }, transports: ["websocket"] });
  const received: unknown[] = [];
  ghost.on("board:changed", (p) => received.push(p));
  await new Promise<void>((r) => ghost.on("connect", () => r()));

  // 既定プロジェクトを動かしても届かない
  await createTask("E2E: 存在しないプロジェクト指定の検証");
  await new Promise((r) => setTimeout(r, 600));
  expect(received).toHaveLength(0);

  ghost.close();

  // 対照: 実在するプロジェクトを指定すれば従来どおり届く (塞ぎすぎていない)
  const ok = io(API, { query: { project: 1 }, transports: ["websocket"] });
  const got: unknown[] = [];
  ok.on("board:changed", (p) => got.push(p));
  await new Promise<void>((r) => ok.on("connect", () => r()));
  await createTask("E2E: 実在プロジェクト指定の対照");
  await expect.poll(() => got.length).toBeGreaterThan(0);
  ok.close();
});

// #180: 認証を廃止したので、残る境界は「待ち受け 127.0.0.1」と「知らないページを断る」だけ。
// cors() の許可リストは境界にならない — 許可しない Origin には ACAO を付けないだけで、
// リクエストはハンドラまで届いて状態が変わる (Codexレビューの実測で 200 + 状態変更)。
// ブラウザが遮るのはレスポンスを読むことだけ。ここは実際に断れているかを見る

test("知らないページからのRESTは403で断る (認証が無い以上ここが最後の砦 #180)", async () => {
  const res = await fetch(`${API}/api/projects/1/activate`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  });
  expect(res.status).toBe(403);

  // 対照: 許可しているページからは通る (塞ぎすぎていない)
  const ok = await fetch(`${API}/api/board`, { headers: { Origin: "http://localhost:5199" } });
  expect(ok.status).toBe(200);
  // 対照: Origin の無い呼び出し (curl・MCP・スクリプト) も通る
  const noOrigin = await fetch(`${API}/api/board`);
  expect(noOrigin.status).toBe(200);
});

test("Originの付かないブラウザGET (<img>相当) も断る。有料の呼び出しを撃たせない (#180)", async () => {
  // 悪意あるページは <img src="http://localhost:8787/api/..."> で GET を撃てる。
  // この要求に Origin は付かないので Origin 判定では止まらない。
  // 止めるのは Sec-Fetch-Site (ブラウザが自分で付けるのでページ側から偽装できない)
  const res = await fetch(`${API}/api/board`, {
    headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" },
  });
  expect(res.status).toBe(403);

  // 対照: 自分のページからの要求は通る
  const ok = await fetch(`${API}/api/board`, {
    headers: { Origin: "http://localhost:5199", "Sec-Fetch-Site": "same-origin" },
  });
  expect(ok.status).toBe(200);
});

test("LLMを直接呼ぶ口はGETに置かない (#180)", async () => {
  // GET のままだと、悪意あるページが <img src> で撃つだけで課金を増やせる。
  //
  // **「LLMを直接呼ぶ口」に限った検証。**#200 でDone列の蒸留をやめたので、検収と差し戻しは
  // LLMを起こさなくなった (畳み直しは同期のSQLだけ)。間接的に起こす口が減った形。
  // 下で /api/tasks/approve と /mcp が GET で通らないことだけ確かめておく
  for (const path of ["/api/suggestions", "/api/chat", "/api/tasks/1/chat"]) {
    const res = await fetch(`${API}${path}`);
    expect(res.status, `${path} がGETで叩ける`).toBe(404);
  }
  // 間接的に要約(=LLM)を起こす口も、GETでは入口が無い
  expect((await fetch(`${API}/api/tasks/approve`)).status).toBe(404);
  // MCPは stateless で POST only。GET は405で明示的に断る (ルートは在るので404ではない)
  expect((await fetch(`${API}/mcp/1`)).status).toBe(405);

  // **このテストが保証するのは「GETのルートが存在しないこと」だけ。**POST側が機能することは
  // ここでは確かめない — 有料のLLM呼び出しが走るため。E2Eは「LLM呼び出しなし」が原則
});

test("知らないページからのSocket接続はハンドシェイクで断る (#180)", async () => {
  // WebSocketのハンドシェイクは CORS の対象外なので、cors 設定では止まらない。
  // 止めるのは allowRequest。ここが開いていると board:changed を外部ページに配信してしまう
  const evil = io(API, { transports: ["websocket"], extraHeaders: { Origin: "https://evil.example" } });
  const outcome = await new Promise<string>((resolve) => {
    evil.on("connect", () => resolve("connected"));
    evil.on("connect_error", () => resolve("rejected"));
    setTimeout(() => resolve("timeout"), 3000);
  });
  evil.close();
  expect(outcome).toBe("rejected");
});

test("ゴミ箱のタスクはプロジェクトの未完了件数に数えない", async () => {
  // ボードから消えているのに件数が減らないと、どれが残っているのか分からなくなる
  const before = await (await fetch(`${API}/api/projects`)).json();
  const beforeCount = before.projects.find((p: any) => p.id === 1).openTasks as number;

  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E: ゴミ箱と件数" }),
  });
  const id = (await res.json()).id as number;

  const counts = async () => {
    const projects = await (await fetch(`${API}/api/projects`)).json();
    const board = await (await fetch(`${API}/api/board`)).json();
    return {
      project: projects.projects.find((p: any) => p.id === 1).openTasks as number,
      onBoard: board.tasks.some((t: any) => t.id === id),
    };
  };
  expect((await counts()).project).toBe(beforeCount + 1);

  // ゴミ箱へ移すと、ボードからも件数からも消える (片方だけ残らない)
  await fetch(`${API}/api/tasks/${id}`, { method: "DELETE" });
  const after = await counts();
  expect(after.onBoard).toBe(false);
  expect(after.project).toBe(beforeCount);
});

test("完全削除はゴミ箱を通ったものだけ (取り返しのつく形を必ず一度経由させる)", async () => {
  // #102 で「間違えないようにするのではなく、間違えても取り返しがつく形にする」と決めたのに、
  // DELETE /api/trash/:id が id しか見ておらず、ボード上の生タスクのIDを直接投げると
  // ゴミ箱を経由せず実体が消えた (自動レビュー指摘)。二段構えの二段目が無条件では意味がない
  const alive = await createTask("完全削除: 生きているタスク");
  const purge = (id: number) => fetch(`${API}/api/trash/${id}`, { method: "DELETE" });

  const ng = await purge(alive);
  expect(ng.status).toBe(409);
  expect((await ng.json()).error).toContain("ゴミ箱にないタスク");
  expect(await getTaskStatus(alive)).toBe("todo"); // 消えていない

  // ゴミ箱へ移してからなら通る
  await fetch(`${API}/api/tasks/${alive}`, { method: "DELETE" });
  expect((await purge(alive)).status).toBe(200);
  expect((await fetch(`${API}/api/tasks/${alive}`)).status).toBe(404);

  // 存在しないIDは404 (「ゴミ箱に無い」と「そもそも無い」を区別する)
  expect((await purge(999999)).status).toBe(404);
});

test("既定プロジェクトは無効にできない (見えない・消せない・でも書き込まれる、を作らない)", async () => {
  // activeProjectId() は archived を見ないので、既定を無効にすると
  // ドロップダウンから消えるのに既定のまま残り、ヘッダ指定のない操作の行き先であり続ける。
  // trashProject は active を弾くので削除もできない (自動コードレビュー指摘)
  const projects = (await (await fetch(`${API}/api/projects`)).json()).projects as any[];
  const active = projects.find((p) => p.active);
  expect(active).toBeTruthy();

  const patch = (id: number, body: unknown) =>
    fetch(`${API}/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const ng = await patch(active.id, { archived: true });
  expect(ng.status).toBe(409);
  expect((await ng.json()).error).toContain("既定のプロジェクトは無効にできません");

  // 名前と同時に投げても、名前だけ変わることがない (途中まで適用しない)
  const ng2 = await patch(active.id, { name: "E2E: この名前にはならない", archived: true });
  expect(ng2.status).toBe(409);
  const after = ((await (await fetch(`${API}/api/projects`)).json()).projects as any[]).find(
    (p) => p.id === active.id
  );
  expect(after.name).toBe(active.name);
  expect(after.archived).toBe(false);

  // 既定でないプロジェクトなら従来どおり無効にできる (塞ぎすぎていない)
  const other = (
    await (
      await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E: 無効にできる側" }),
      })
    ).json()
  ).project.id as number;
  expect((await patch(other, { archived: true })).status).toBe(200);
});

test("同じIDを2回渡しても1件として確定する (#157)", async () => {
  // 判定も更新も2度走り、updated に同じタスクが2件載って「2件確定しました」に見えていた。
  // 押した数と通った数を突き合わせられるようにしてあるのに、その数字が水増しされては意味がない
  const id = await createTask("重複ID: 1件として数える", "review");
  await fetch(`${API}/api/tasks/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const r = await (
    await fetch(`${API}/api/tasks/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id, id, id] }),
    })
  ).json();
  expect(r.ok).toBe(true);
  expect(r.updated).toHaveLength(1);
  expect(r.updated[0].id).toBe(id);
});

test("無効化したプロジェクトは既定にできない (順序を変えても不可視状態を作れない)", async () => {
  // setProjectArchived 側で「既定は無効にできない」を塞いだが、順序を入れ替えれば
  // 同じ状態が作れた (先に無効化 → activate)。「既定 かつ 無効」という組み合わせ自体を作らせない
  const id = (
    await (
      await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E: 無効なら既定にできない" }),
      })
    ).json()
  ).project.id as number;

  // 既定でないので無効化はできる
  const off = await fetch(`${API}/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  expect(off.status).toBe(200);

  // そのまま既定にしようとすると断られる
  const act = await fetch(`${API}/api/projects/${id}/activate`, { method: "POST" });
  expect(act.status).toBe(400);
  expect((await act.json()).error).toContain("無効になっているプロジェクトは既定にできません");

  // 有効へ戻せば既定にできる (塞ぎすぎていない)。戻したあと元の既定に復帰させる
  const before = ((await (await fetch(`${API}/api/projects`)).json()).projects as any[]).find((p) => p.active).id;
  await fetch(`${API}/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  expect((await fetch(`${API}/api/projects/${id}/activate`, { method: "POST" })).status).toBe(200);
  await fetch(`${API}/api/projects/${before}/activate`, { method: "POST" });
  await fetch(`${API}/api/projects/${id}`, { method: "DELETE" });
});

test("Doneから差し戻すと検収の印は消える (確認し直さずに戻せない)", async () => {
  // approveChecked が checked_at を「人が確かめた唯一の証拠」にしたので、
  // 差し戻しで印が残ると、確認し直さずにもう一度Doneへ通せてしまう
  const id = await createTask("差し戻しで印が消える検証", "review");
  const check = (checked: boolean) =>
    fetch(`${API}/api/tasks/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked }),
    });
  const get = async () => (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  const approve = async () =>
    (await (
      await fetch(`${API}/api/tasks/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      })
    ).json()) as any;

  await check(true);
  expect((await approve()).ok).toBe(true);
  await expect.poll(() => getTaskStatus(id)).toBe("done");
  expect((await get()).checkedAt).toBeTruthy(); // Doneでは検収の結果として残る

  // Doneから差し戻す (チャットの「戻して」やD&Dで起きる)
  await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });
  expect((await get()).checkedAt).toBeFalsy(); // 印は消える

  // 印が無いので、そのままではもう一度Doneへ通せない
  const again = await approve();
  expect(again.ok).toBe(false);
  expect(JSON.stringify(again.skipped)).toContain("検収チェックが付いていません");
  expect(await getTaskStatus(id)).toBe("review");

  // 付け直せば通る
  await check(true);
  expect((await approve()).ok).toBe(true);
  await expect.poll(() => getTaskStatus(id)).toBe("done");
});

test("存在しないプロジェクトを指定した操作は既定へ落とさず拒否する (#125)", async () => {
  const bad = { "X-ChatBan-Project": "9999" };

  // 読み取りも書き込みも 400。黙って既定プロジェクトへ落ちない
  expect((await fetch(`${API}/api/board`, { headers: bad })).status).toBe(400);
  const write = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bad },
    body: JSON.stringify({ title: "9999のつもりで作る" }),
  });
  expect(write.status).toBe(400);

  // 既定プロジェクトに混入していない
  const board = await (await fetch(`${API}/api/board`)).json();
  expect(board.tasks.some((t: any) => t.title.includes("9999のつもり"))).toBe(false);

  // 無指定は既定プロジェクトで通る (curl・スクリプト用の経路は残す)
  expect((await fetch(`${API}/api/board`)).status).toBe(200);
});

test("MCPは接続URLのプロジェクトしか触れない (#125)", async () => {
  const id = await createTask("project1のタスク");

  // project2 のエンドポイントから project1 のIDを更新しようとしても届かない
  const res = await fetch(`${API}/mcp/2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "update_tasks", arguments: { updates: [{ id, summary: "別プロジェクトから書き換えた" }] } },
    }),
  });
  const body = await res.text();
  const line = body
    .split("\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop()!;
  const r = JSON.parse(JSON.parse(line).result.content[0].text);
  expect(r.notFound).toContain(id);

  const after = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  expect(after.summary).toBeFalsy();
});

test("日本語が \\uXXXX エスケープで届いてもデコードして保存する", async () => {
  // 実害: project 9 の前提情報が全文エスケープで保存され、296字が1,346字(トークン3.2倍)に
  // 膨らんだうえ、LLMの読み取り精度も落ちていた (見出しの数を数え間違えた)
  const escaped = "\\u30c6\\u30b9\\u30c8\\u306e\\u30bf\\u30a4\\u30c8\\u30eb"; // 「テストのタイトル」
  const r = await mcp("create_tasks", { tasks: [{ title: escaped, summary: escaped }] });
  const id = r.created[0].id;

  const t = (await (await fetch(`${API}/api/tasks/${id}`)).json()) as any;
  expect(t.title).toBe("テストのタイトル");
  expect(t.summary).toBe("テストのタイトル");

  // 単発のエスケープは壊さない (説明文で言及したいことがある)
  const single = await mcp("create_tasks", { tasks: [{ title: "\\u0041 は A のこと" }] });
  const t2 = (await (await fetch(`${API}/api/tasks/${single.created[0].id}`)).json()) as any;
  expect(t2.title).toBe("\\u0041 は A のこと");
});

test("SQL窓口は許可リスト方式。載っていないものは名前も引けない (#168)", async () => {
  // もとは隠す側を列挙していたので、遮断リストに書き忘れた経路が開いていた
  // (pragma_table_list から settings を含む全テーブル名が読めた)。
  // 許可リストなら、次にテーブルを足しても黙って開かない
  const q = async (sql: string) => await mcp("query_log", { sql });

  // 機密そのもの。#181 で管理DB側の窓口 (旧 scope='cost') を撤去したので、settings には
  // **そもそも到達できない** — この接続はプロジェクトDBで、settings は管理DBにある。
  // 許可リストで弾く以前に存在しないので、返るのは "no such table"。守りとしては一段強い
  // (許可リストを間違えても届かない)
  expect((await q("SELECT * FROM settings")).error).toBeTruthy();
  // 許可リストそのものは、プロジェクトDBに実在して許可していないもので確かめる (下の sqlite_sequence)。
  // sqlite_master 自身は sqlite_master に載らないので、実在名の照合だけでは捕まらない。
  // 許可リスト化したとき実際にここが開き、このテストが拾った
  expect((await q("SELECT name FROM sqlite_master")).error).toContain("参照できません");
  // 仮想テーブルも sqlite_master に載らない。名前を数え上げる方式では「知らないものは開く」から
  // 抜け出せず、実際 pragma_* を閉じた直後に dbstat が残っていた (外部レビュー指摘)。
  // dbstat は全テーブル名とページ構成を返すので、塞いだはずの settings の存在漏れが残っていた。
  // いまは EXPLAIN の VOpen で機構ごと閉じているので、名前を知らなくても捕まる
  expect((await q("SELECT name FROM pragma_table_list")).error).toContain("仮想テーブル");
  expect((await q("SELECT name, pageno FROM dbstat")).error).toContain("仮想テーブル");
  // 機密ではないが許可もしていないもの。「危なくないから開けておく」をやらない
  expect((await q("SELECT * FROM sqlite_sequence")).error).toContain("参照できません");

  // 開けているものは素通りする (閉めすぎて使えなくなっていないこと)
  const rows = await q("SELECT id, title FROM live_tasks LIMIT 1");
  expect(Array.isArray(rows.rows)).toBe(true);
  // WITH も通ること。EXPLAIN を1回挟むようにしたので、素直なSELECT以外が壊れていないか確かめる
  const cte = await q("WITH x AS (SELECT id FROM live_tasks LIMIT 3) SELECT COUNT(*) c FROM x");
  expect(Array.isArray(cte.rows)).toBe(true);

  // #181: 撤去した計測系のテーブルには届かない (プロジェクトDBの接続なので、そもそも存在しない)
  expect((await q("SELECT COUNT(*) FROM llm_calls")).error).toBeTruthy();
  expect((await q("SELECT COUNT(*) FROM model_prices")).error).toBeTruthy();
});

test("ツール説明に書いてあるテーブルは、実際に引けるものと一致する (#168)", async () => {
  // 説明と実装のズレは #92 #108 #114 で3回踏んでいる。許可リストが唯一の出所なので、
  // 説明に載っているのに引けない / 引けるのに載っていない、の**両方向**を見る。
  //
  // ハードコードした一覧と突き合わせる形はやめた (自動レビュー指摘) — 説明から表名が落ちても、
  // こちらの一覧を直さなければ通ってしまう。**許可リストの実物は、拒否メッセージが列挙している**
  // ので、そこから取り出して突き合わせる (実行時の値が出所になる)
  // 実装が持っている許可リスト。拒否メッセージが列挙している
  const blocked = (await mcp("query_log", { sql: "SELECT * FROM sqlite_sequence" })) as any;
  expect(blocked.error).toContain("参照できません");
  const fromCode =
    String(blocked.error)
      .match(/引けるのは (.+?) だけです/)?.[1]
      .split(" / ")
      .map((s) => s.trim()) ?? [];
  expect(fromCode.length, "拒否メッセージから許可リストを読み取れない (文言が変わった?)").toBeGreaterThan(3);

  // ツール説明が案内している一覧。説明は PUBLIC_TABLES から生成しているので、
  // 突き合わせる相手が「実装が言っていること」になる (手で書いた一覧との比較はやめた)
  const res = await fetch(`${API}/mcp/1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body;
  const tools = JSON.parse(line.replace(/^data: /, "")).result.tools as any[];
  const desc = tools.find((t) => t.name === "query_log").description as string;
  const fromDesc =
    desc
      .split("\n")
      .find((l) => l.startsWith("引けるもの: "))
      ?.replace("引けるもの: ", "")
      .split(" / ")
      .map((s) => s.trim()) ?? [];
  expect(fromDesc.length, "説明から一覧を読み取れない (行の形が変わった?)").toBeGreaterThan(3);

  // **集合として一致すること。**前は許可リスト側の項目だけをループしていたので、
  // 「許可リストから消えて説明に残った」ケースを見逃していた (自動レビュー指摘)
  expect([...fromDesc].sort(), "説明の一覧と実装の許可リストがズレている").toEqual([...fromCode].sort());

  // 案内どおりに書いたら実際に引けること (一致していても両方が間違っている場合を弾く)
  for (const t of fromCode) {
    const r = await mcp("query_log", { sql: `SELECT * FROM ${t} LIMIT 1` });
    expect(r.error, `${t} は案内されているのに引けない`).toBeFalsy();
  }

  // 機密は説明にも載っていない (載っていて引けない、を「一致」と呼ばないため)
  expect(fromDesc).not.toContain("settings");
});

test("AI提案チップのON/OFFはシステム全体で1つ。OFFなら提案は空で返る (#167 → #199)", async ({ page }) => {
  // #167 ではプロジェクトごとの設定だった (撮影用だけ切れるように)。#199 で全体1つに変えた —
  // 「使うかどうか」は持ち主の好みでプロジェクトの性質ではなく、プロジェクト単位だと
  // 新しく作るたびに既定ONで始まって1件ずつ切り直すことになっていたため。
  // **ここで固定したいのは、その逆転** = 切ったら後から作ったプロジェクトも含めて全部切れる
  const enabled = async () => ((await (await fetch(`${API}/api/settings`)).json()) as any).suggestEnabled;

  // 既定はON
  expect(await enabled()).toBe(true);
  // プロジェクトの属性ではなくなったので、一覧には出ない
  const before = (await (await fetch(`${API}/api/projects`)).json()) as any;
  expect(before.projects[0]).not.toHaveProperty("suggestEnabled");

  await fetch(`${API}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestEnabled: false }),
  });
  expect(await enabled()).toBe(false);

  // OFFにした**後で**作ったプロジェクトも切れたまま。#167 の形ではここが ON に戻っていて、
  // プロジェクトを作るたびに切り直すことになっていた
  await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "E2E-全体OFFが新規にも効くか" }),
  });
  expect(await enabled()).toBe(false);

  // 入口で確かめる。**書き換えるものが1つも無い要求を成功にしない** —
  // 綴り違いや型違いが200で通ると、呼んだ側は反映されたつもりで待ち続ける
  for (const bad of [{}, { suggestEnabled: "false" }, { suggestEnabled: null }, { suggestEnable: false }]) {
    const r = await fetch(`${API}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    expect(r.status, `${JSON.stringify(bad)} が通ってしまった`).toBe(400);
  }
  // 断ったあとも値は動いていない (途中まで適用して400、を作らない)
  expect(await enabled()).toBe(false);

  // 配信は**合図だけ**で中身を載せない。受け手はこれを見て GET し直す (projects と同じ形)。
  // 値を配ると受け手が「HTTP応答と配信のどちらが先か」を解く羽目になるので、そうしない
  const sock = io(API, { query: { project: 1 }, transports: ["websocket"] });
  // 接続が確立してからPATCHする。繋ぎに行った直後に叩くと配信のほうが先に出て取りこぼす
  await new Promise<void>((resolve, reject) => {
    sock.on("connect", () => resolve());
    setTimeout(() => reject(new Error("socketが繋がらなかった")), 5000);
  });
  const broadcast = new Promise<void>((resolve, reject) => {
    sock.on("settings:changed", () => resolve());
    setTimeout(() => reject(new Error("settings:changed が届かなかった")), 5000);
  });
  await fetch(`${API}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestEnabled: false }),
  });
  await broadcast;
  sock.close();
  expect(await enabled()).toBe(false);

  // OFFなら空で返る。**「LLMを呼んでいないこと」は誰も確かめていない** —
  // #181 まで使っていた llm_calls の件数差はテーブルごと撤去され、共有ログの行数で数える形は
  // 開発サーバーの書き込みで誤判定しうる (自動レビュー指摘)。
  // いま在るのは `suggestSkipReason` のユニットテスト (判定結果は正しい) と、ここ (設定→API応答まで
  // OFFが効いている) の2つで、**呼び出し0回そのものは範囲外**。固定するには
  // LLM呼び出しを差し替えられる形にする必要があり、それは別の改修
  const s = (await (await fetch(`${API}/api/suggestions`, { method: "POST" })).json()) as any;
  expect(s.suggestions).toEqual([]);

  // UIのトグルはラベルで状態が読める (押せるが何も起きないボタンにしない)。
  // プロジェクト行の中ではなく「全体の設定」に1つだけ在る
  await page.goto("/");
  await page.getByRole("button", { name: "⚙ 設定" }).click();
  const toggle = page.getByTestId("suggest-toggle");
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveText("💡 AI提案チップ OFF");
  await toggle.click();
  await expect(toggle).toHaveText("💡 AI提案チップ ON");
  expect(await enabled()).toBe(true);
});

test("設定は全体で1つなので、片方のタブで切ると開いているもう片方も追従する (#199)", async ({ browser }) => {
  // 「4経路を同じ判定に通す」のうち socket 配信の経路が、実際の画面で効いていることを見る。
  // ペイロードの形 (bootGeneration / revision) は別テストで確かめてあるが、
  // **受け取った側が本当に描き替わるか**はUIを2つ開かないと分からない。
  // 版の比較を入れたので「新しい配信を古い応答が巻き戻す」と、ここが落ちる。
  //
  // 設定は全体で1つ = **テストをまたいで残る状態**なので、他のテストの結果に乗らないよう
  // 開く前に自分でONへ揃える (前のテストが落ちて戻し損ねたときに道連れで落ちない)
  await fetch(`${API}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestEnabled: true }),
  });
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const p of [a, b]) {
    await p.goto("/");
    await p.getByRole("button", { name: "⚙ 設定" }).click();
    await expect(p.getByTestId("suggest-toggle")).toHaveText("💡 AI提案チップ ON");
  }

  await a.getByTestId("suggest-toggle").click();
  await expect(a.getByTestId("suggest-toggle")).toHaveText("💡 AI提案チップ OFF");
  // 押していない側も追従する (リロードは挟まない)
  await expect(b.getByTestId("suggest-toggle")).toHaveText("💡 AI提案チップ OFF");

  // 逆向きも同じ。片方向だけ効いて見える実装 (押した側のstateだけ更新) を通さない
  await b.getByTestId("suggest-toggle").click();
  await expect(b.getByTestId("suggest-toggle")).toHaveText("💡 AI提案チップ ON");
  await expect(a.getByTestId("suggest-toggle")).toHaveText("💡 AI提案チップ ON");

  await a.close();
  await b.close();
});

test("チャットの処理中は提案チップを生成しない (#162)", async () => {
  // 上流が遅いときに並走するとTTFTが悪化する (実測: 単独12秒 → 3本並走で30〜55秒)。
  // しかもチップは会話が始まる前にしか出ないので、送信した瞬間から表示される余地が無い。
  // ここではLLMを呼ばずに、抑止のフラグが立っている間だけ空になることを確かめる
  const id = await createTask("チャット中の抑止を確かめる");

  // 応答が返る前に叩きたいので、待たずに走らせる。E2E環境のLLMは失敗してよい
  // (成否によらず runChatTurn には入るので、その間フラグは立つ)
  const chatting = fetch(`${API}/api/tasks/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "状況は?", history: [] }),
  }).catch(() => null);

  // 立ち上がりを待ってから確認する
  await new Promise((r) => setTimeout(r, 300));
  const during = (await (await fetch(`${API}/api/suggestions`, { method: "POST" })).json()) as any;
  expect(during.suggestions).toEqual([]);

  await chatting;
});

test("先に始まっていた提案生成は、チャットが始まったら中断される (#162)", async () => {
  // 開始時のフラグを見るだけでは片方向にしか効かない (外部レビュー指摘)。
  // 実際の画面ではページ表示直後に /api/suggestions が走るので、
  // 「suggest開始 → chat開始」のほうが普通の順番。こちらを止められないと意味がない。
  //
  // 結果を捨てるだけでは足りず、接続ごとやめる必要がある
  // (捨てるだけだと上流の応答は待ち続けるので、止めたかったTTFTの奪い合いが残る)
  // **空配列を中断の証拠にしない。**空配列は「LLMが空を返した」「上流が失敗した」
  // 「JSONの解析に失敗した」「chatより先に完了した」でも返るので区別がつかない (外部レビュー指摘)。
  // 中断そのものはサーバーのログに残るので、その行が増えたかで判定する
  const abortLines = (): number => {
    const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
    const file = path.join("..", "backend", "logs", `chatban-${today}.log`);
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.includes("ABORTED")).length;
  };

  const id = await createTask("suggest先行の中断を確かめる");

  // 狙いたいのは「suggestが走っている最中にchatが来る」状態。
  // suggestが先に終わってしまうと中断する相手がいないので、その回は検証にならない
  let observed = false;
  for (let attempt = 0; attempt < 3 && !observed; attempt++) {
    // ボードを変えて提案キャッシュを外す。同じ状態だとLLMを呼ばずに即返る
    await createTask(`suggest先行の中断を確かめる (${attempt})`);
    const before = abortLines();

    // suggestを先に始める。待たない
    const suggesting = fetch(`${API}/api/suggestions`, { method: "POST" })
      .then((r) => r.json())
      .catch(() => null);

    // 走り出してからチャットを送る
    await new Promise((r) => setTimeout(r, 300));
    const chatting = fetch(`${API}/api/tasks/${id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "状況は?", history: [] }),
    }).catch(() => null);

    const s = (await suggesting) as any;
    const chatRes = await chatting;
    // 上流が落ちている日はsuggestが即失敗するので、狙いの並びが作れない。
    // それは実装の回帰ではないので、赤くして本当の回帰を埋もれさせない
    if (!chatRes || !(chatRes as Response).ok) {
      test.skip(true, "上流が応答しないため中断の並びを作れなかった (実装の検証はできていない)");
      return;
    }
    // 中断が実際に起きた回だけを合格とする。空配列だったかは見ない —
    // 空配列は「LLMが空を返した」「上流が失敗した」「解析に失敗した」でも返る
    if (abortLines() > before) {
      observed = true;
      expect(s?.suggestions, "中断したのに提案が返っている").toEqual([]);
    }
  }
  expect(observed, "3回試しても中断のログが増えなかった (suggestが毎回chatより先に完了した?)").toBe(true);
});

test("ゴミ箱に入れると検収の印が落ちる (古い確認のままDoneへ通せない) (#161)", async () => {
  // 検収まで済ませる (人間のUI操作と同じ道)
  const id = await createTask("検収済みだがゴミ箱を通ったタスク", "review");
  await fetch(`${API}/api/tasks/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const checkedAt = async () =>
    (await mcp("query_log", { scope: "audit", sql: `SELECT checked_at FROM tasks WHERE id=${id}` }))
      .rows[0].checked_at;
  expect(await checkedAt(), "検収の印が付いていない").toBeTruthy();

  // ゴミ箱 → 復元。**AIが呼べるMCPツールだけで往復できる**のがこの穴の入口だった
  expect((await mcp("delete_tasks", { ids: [id] })).ok).toBe(true);
  expect((await mcp("restore_tasks", { ids: [id] })).ok).toBe(true);

  // 復元後は未検収に戻っている (ゴミ箱と復元の間に人間の確認は一度も入っていない)
  expect(await checkedAt(), "古い検収の印が生き返っている").toBeFalsy();

  // ゴミ箱にいる間は「検収済みだった」事実が残る (監査の材料を消さない)。
  // ゴミ箱にある限り mayEnterDone は trashedAt を見て false なので、残っていても危険はない —
  // **落とすのは復元のとき**。この形なら、変更前からゴミ箱にある行にも効く

  // **やっていないことを報告しない。**ゴミ箱に無いタスクを restore しても成功にしない
  // (以前は更新0件でも getTask を返していたので「復元しました」と言えてしまった)
  const again = await mcp("restore_tasks", { ids: [id] });
  expect(again.ok, "ゴミ箱に無いのに復元成功として返っている").toBe(false);
  expect(again.notRestored).toContain(id);
  expect(again.restored, "戻していないのに restored に載っている").toHaveLength(0);

  // RESTは理由で応答を分ける。**実在するタスクを「無い」と言わない**
  const already = await fetch(`${API}/api/tasks/${id}/restore`, { method: "POST" });
  expect(already.status, "実在するのに404を返している").toBe(409);
  const missing = await fetch(`${API}/api/tasks/99999999/restore`, { method: "POST" });
  expect(missing.status).toBe(404);

  // 同じIDを2つ渡しても、片方が成功・片方が失敗にならない (先に重複を落とす)
  const dupTarget = await createTask("重複指定で戻すタスク");
  await mcp("delete_tasks", { ids: [dupTarget] });
  const dup = await mcp("restore_tasks", { ids: [dupTarget, dupTarget] });
  expect(dup.ok, "同じIDが成功と失敗の両方になっている").toBe(true);
  expect(dup.restored).toHaveLength(1);
  expect(dup.notRestored).toBeUndefined();
  // 応答は要点だけ。**経緯メモを載せない** — チャット経路ではこれが次のLLM入力へ再投入される
  expect(Object.keys(dup.restored[0]).sort()).toEqual(["id", "status", "title"]);
  // 復元したら検収の印が外れることを応答でも言う (境界はコードで守るが、報告しないと
  // エージェントは「さっき検収されていた」前提のまま話を進める)
  expect(dup.note).toContain("検収");

  // 印が無いので確定も通らない。setChecked はRESTにしか無いので、AIはここから先へ進めない
  const res = await fetch(`${API}/api/tasks/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });
  const after = await mcp("query_log", { scope: "audit", sql: `SELECT status FROM tasks WHERE id=${id}` });
  expect(res.ok).toBe(true); // 一括検収そのものは成功で返る (条件を満たす件だけ通す)
  expect(after.rows[0].status, "未検収なのにDoneへ入った").not.toBe("done");
});

test("期限は登録時にも保存される (弾くだけ足して保存を忘れない) (#153)", async () => {
  // **「検証を足したら、通ったものが効くこと」まで確かめる。**
  // 検証だけ足して createTask に渡し忘れ、正しい due が200のまま黙って捨てられていた
  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "登録時に期限を入れるタスク", due: "2026-08-20" }),
  });
  expect(res.ok).toBe(true);
  const created = await res.json();
  expect(created.due, "正しい期限が黙って捨てられている").toBe("2026-08-20");

  // 不正な形式は登録そのものを断る
  const bad = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "だめな期限", due: "2026-02-31" }),
  });
  expect(bad.status).toBe(400);

  // 解除の "" は空文字を保存せず null に均す (画面では解除に見えるのに
  // WHERE due IS NOT NULL のSQLに残る、という食い違いを作らない)
  await fetch(`${API}/api/tasks/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ due: "" }),
  });
  const row = await mcp("query_log", {
    scope: "audit",
    // 別名に notNull は使えない (SQLite の予約語 NOTNULL とぶつかって構文エラーになる)
    sql: `SELECT due, (due IS NOT NULL) AS has_due FROM tasks WHERE id=${created.id}`,
  });
  expect(row.rows[0].has_due, "解除したのに空文字が残っている").toBe(0);
});

test("期限の形式が違うとその指定だけ捨てて名指しで返す (#153)", async () => {
  // REST は 400 で断る
  const id = await createTask("期限を入れたいタスク");
  const bad = await fetch(`${API}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ due: "not-a-date" }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("YYYY-MM-DD");

  // エージェント経路 (MCP) は行ごと落とさず、他の項目は保存して badDue で報告する
  const r = await mcp("update_tasks", { updates: [{ id, summary: "現況は保存される", due: "2026-02-31" }] });
  expect(r.badDue, "期限を捨てたことが名指しで返っていない").toContain(id);
  expect(r.note).toContain("期限の形式");

  const row = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT due, summary FROM tasks WHERE id=${id}`,
  });
  expect(row.rows[0].due, "暦に無い日付が保存された").toBeFalsy();
  expect(row.rows[0].summary, "期限以外も一緒に落ちている").toBe("現況は保存される");

  // 正しい形式は通る (弾きすぎていないことの確認)
  const ok = await mcp("update_tasks", { updates: [{ id, due: "2026-08-17" }] });
  expect(ok.badDue).toBeUndefined();
  expect((await mcp("query_log", { scope: "audit", sql: `SELECT due FROM tasks WHERE id=${id}` })).rows[0].due)
    .toBe("2026-08-17");
});

test("検索の絞り込みは引数ではなくSQLへ案内する (#176)", async () => {
  const hit = await createTask("スクリーンショットを撮り直す");
  const noise = await createTask("ダークモードの検討");
  // 経緯メモに語が入っているだけのタスク (#130 で実際に起きた形)。
  // context の全文上書きは版が要るので、版の要らない context_append で足す
  await mcp("update_tasks", {
    updates: [{ id: noise, context_append: "提出前に見た目を揃えるかどうか。スクリーンショットの見え方も含む" }],
  });

  // search_tasks は広く当てる道具のまま (本文で当たるものも返る)
  const wide = await mcp("search_tasks", { terms: ["スクリーンショット"] });
  const wideIds = wide.hits.map((h: any) => h.id);
  expect(wideIds).toContain(hit);
  expect(wideIds, "本文で当たるものが出ていない (前提が崩れている)").toContain(noise);

  // **絞り込みの引数は持たない。**足しかけた title_only は撤回した (#91 と同じ判断) —
  // 渡しても黙って無視される (=引数で絞れると思わせない) ことを固定する
  const ignored = await mcp("search_tasks", { terms: ["スクリーンショット"], title_only: true });
  expect(ignored.hits.map((h: any) => h.id), "絞り込みの引数が生きている").toContain(noise);

  // 代わりに契約がSQLへ案内していること。案内が消えたら、絞りたいエージェントは
  // 引数を探して見つからず、広い結果を読み直すことになる
  const tools = await mcpToolList();
  const desc = tools.find((t: any) => t.name === "search_tasks").description as string;
  expect(desc).toContain("query_log");
  expect(desc).toContain("title LIKE");

  // **案内した先が実際に効くことまで確かめる。**手順を書くだけでなく通してみる
  const narrowed = await mcp("query_log", {
    scope: "audit",
    sql: "SELECT id, title FROM live_tasks WHERE title LIKE '%スクリーンショット%'",
  });
  const narrowedIds = narrowed.rows.map((r: any) => r.id);
  expect(narrowedIds).toContain(hit);
  expect(narrowedIds, "SQLで絞ったのに本文で当たったものが残っている").not.toContain(noise);
});

test("live_tasks と done_tasks に何が入るかは、契約に書いてある通りになっている (#175)", async () => {
  // **説明を足したら、実物がその通りかを見る。**#175 は「review が live_tasks に
  // 入るかどうかが契約に書いていない」ために誤報 (「live_tasks に review が出ないバグ」) が
  // 起きた札。ビューは status ではなく archived / trashed_at / done_at で定義されているので、
  // 説明のほうを実物に合わせたうえで、その説明をここで固定する
  const todo = await createTask("live: todoのもの", "todo");
  const inprogress = await createTask("live: inprogressのもの", "inprogress");
  const review = await createTask("live: reviewのもの", "review");

  const live = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id, status FROM live_tasks WHERE id IN (${todo}, ${inprogress}, ${review})`,
  });
  const ids = live.rows.map((r: any) => r.id);
  for (const [label, id] of [["todo", todo], ["inprogress", inprogress], ["review", review]] as const) {
    expect(ids, `${label} が live_tasks に出ていない`).toContain(id);
  }

  // 検収してDoneへ確定すると done_tasks に現れる。
  // **このE2Eは AUTO_ARCHIVE=0 なので畳まれず、live_tasks にも残る** —
  // 契約に書いた「同じタスクが両方に出る瞬間がある (不整合ではない)」がこの状態
  await fetch(`${API}/api/tasks/${review}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/tasks/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [review] }),
  });

  const done = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id, done_day FROM done_tasks WHERE id=${review}`,
  });
  expect(done.rows, "確定したのに done_tasks に出ていない").toHaveLength(1);
  expect(done.rows[0].done_day, "done_day が空 (date(done_at) が引けていない)").toBeTruthy();

  const stillLive = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id FROM live_tasks WHERE id=${review}`,
  });
  expect(stillLive.rows, "畳まれていないDoneが live_tasks から消えている (契約の記述と違う)").toHaveLength(1);

  // 契約側にもその説明が書かれていること (書いていないと推測される #92/#175)
  const tools = await mcpToolList();
  const desc = tools.find((t: any) => t.name === "query_log").description as string;
  for (const word of ["todo / inprogress / review", "畳まれるまでは同じタスクが両方に出る"]) {
    expect(desc, `契約に「${word}」の説明が無い`).toContain(word);
  }
  // **「短時間」と書き戻さない。**畳む処理は fire-and-forget で、プロセスが止まれば
  // ジョブは失われ、起動時に回収する処理も無い = 両方に出る状態は無期限に残る (Codexレビュー指摘)。
  // 「時間で消える」と書くと、エージェントは待てば直ると判断してしまう
  expect(desc, "「短時間」と書くと待てば直ると読まれる").not.toContain("短時間");
});
