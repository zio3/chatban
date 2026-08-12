import { expect, test, type Page } from "@playwright/test";
import { io } from "socket.io-client";

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

test("担当フィルタ: 複数トグルのOR絞り込みと非表示件数の表示 (#90)", async ({ page }) => {
  // 担当ありと担当なしを1件ずつ用意する
  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E: フィルタ対象(zio担当)", assignee: "zio" }),
  });
  const assigned = (await res.json()).id as number;
  const unassigned = await createTask("E2E: フィルタ対象(担当なし)");

  await page.goto("/");
  await expect(page.getByTestId(`task-card-${assigned}`)).toBeVisible();
  await expect(page.getByTestId(`task-card-${unassigned}`)).toBeVisible();

  // zioで絞ると担当なしが消え、非表示件数バッジが出る
  await page.getByRole("button", { name: "zio", exact: true }).click();
  await expect(page.getByTestId(`task-card-${assigned}`)).toBeVisible();
  await expect(page.getByTestId(`task-card-${unassigned}`)).toBeHidden();
  await expect(page.getByText(/フィルタで\d+件が非表示/)).toBeVisible();

  // 未割り当ても足すとOR条件になり両方見える
  await page.getByRole("button", { name: "未割り当て", exact: true }).click();
  await expect(page.getByTestId(`task-card-${assigned}`)).toBeVisible();
  await expect(page.getByTestId(`task-card-${unassigned}`)).toBeVisible();

  // ✕で解除するとバッジも消える
  await page.getByTitle("フィルタ解除").click();
  await expect(page.getByText(/フィルタで\d+件が非表示/)).toBeHidden();
  await expect(page.getByTestId(`task-card-${unassigned}`)).toBeVisible();
});

test("担当フィルタ: メンバー未登録の担当者にもトグルが出る (全部オンで全件見える) (#90)", async ({ page }) => {
  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E: メンバー表にない担当者", assignee: "Claude" }),
  });
  const id = (await res.json()).id as number;

  await page.goto("/");
  // メンバー表に居ない担当者でもトグルが生える
  const chip = page.getByRole("button", { name: "Claude", exact: true });
  await expect(chip).toBeVisible();

  // 他の担当者だけで絞ると隠れ、そのトグルを足せば出てくる
  await page.getByRole("button", { name: "zio", exact: true }).click();
  await expect(page.getByTestId(`task-card-${id}`)).toBeHidden();
  await chip.click();
  await expect(page.getByTestId(`task-card-${id}`)).toBeVisible();
});

test("プロジェクト: 切り替えるとボードが入れ替わり、#IDは1から振り直される (#86)", async ({ page }) => {
  const inFirst = await createTask("E2E: 元プロジェクトのタスク");

  // 新規プロジェクトを作って切り替える
  const created = await (
    await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E: 別プロジェクト", members: ["さくら"] }),
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
  // メンバーもプロジェクト側のものに入れ替わる
  await expect(page.getByRole("button", { name: "さくら", exact: true })).toBeVisible();

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
        body: JSON.stringify({ name: "E2E: 配信テスト", members: [] }),
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
        body: JSON.stringify({ name: "E2E: 別タブ用", members: [] }),
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
  const read = await mcp("query_log", { scope: "audit", sql: `SELECT checked_at FROM tasks WHERE id = ${id}` });
  expect(read.rows[0].checked_at).toBeTruthy();

  // 書く口はどこにも無い: SQL窓口は読み取り専用、update_tasks のスキーマにも無い
  const write = await mcp("query_log", { scope: "audit", sql: `UPDATE tasks SET checked_at = NULL WHERE id = ${id}` });
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
  for (const gone of ["list_tasks", "list_trash", "list_members", "get_metrics"]) {
    expect(names).not.toContain(gone);
  }
  expect(names).toContain("query_log");

  // 落としたぶんはSQLで引ける (接続の足場だけは get_project_context に残す)
  const board = await mcp("query_log", {
    scope: "audit",
    sql: "SELECT id, status, title FROM tasks WHERE archived=0 AND trashed_at IS NULL",
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

  const r = await mcp("query_log", {
    scope: "audit",
    sql: "SELECT id, title FROM live_tasks",
  });
  const ids = (r.rows as any[]).map((x) => x.id);
  expect(ids).toContain(alive);
  expect(ids).not.toContain(trashed); // 条件を書かなくてもゴミ箱は混ざらない

  // tasks を直に引けばゴミ箱も見える (見たいときは見られる)
  const raw = await mcp("query_log", {
    scope: "audit",
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
  expect(dep).toContain("それが終わらないと着手できない");

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
    scope: "audit",
    sql: `SELECT id, done_day, done_at FROM done_tasks WHERE id=${id}`,
  });
  expect(r.rows).toHaveLength(1);
  // 日付は列として出ているので date() を書かなくてよい
  expect((r.rows[0] as any).done_day).toBe((r.rows[0] as any).done_at.slice(0, 10));

  // 終わっていないものは入らない (created_at を完了日と取り違える余地がない)
  const alive = await createTask("まだ終わっていない");
  const none = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id FROM done_tasks WHERE id=${alive}`,
  });
  expect(none.rows).toHaveLength(0);
});

test("要約カードの列は frozen (旧 settled)。SQL窓口から新しい名前で引ける", async () => {
  // 改名のマイグレーションが効いていること。旧名で引くと落ちる = 移行漏れが検出できる
  const r = await mcp("query_log", {
    scope: "audit",
    sql: "SELECT id, title, frozen FROM summary_cards LIMIT 1",
  });
  expect(r.error).toBeUndefined();

  const old = await mcp("query_log", { scope: "audit", sql: "SELECT settled FROM summary_cards LIMIT 1" });
  expect(JSON.stringify(old)).toContain("no such column");
});

test("SQLが失敗したら、直せる材料を一緒に返す (説明を厚くする代わりの事後注入)", async () => {
  // 列名を間違えたら、実DBから引いたスキーマが返る (説明とスキーマがズレない)
  const badCol = await mcp("query_log", { scope: "audit", sql: "SELECT id, titel FROM live_tasks LIMIT 1" });
  expect(badCol.ok).toBe(false);
  expect(badCol.schema["live_tasks (ビュー)"]).toContain("title");
  expect(badCol.hint).toContain("live_tasks");

  // 他のDBの関数を使ったら、SQLiteでの書き方が返る
  const badFn = await mcp("query_log", { scope: "cost", sql: "SELECT date_trunc('day', created_at) FROM llm_calls" });
  expect(badFn.ok).toBe(false);
  expect(JSON.stringify(badFn.dialect)).toContain("start of month");
});

test("エラーにならない間違いには、結果と一緒に一言添える", async () => {
  // tasks 直引き = ゴミ箱もアーカイブも混ざる。エラーにならないので気づけない
  const raw = await mcp("query_log", { scope: "audit", sql: "SELECT id, title FROM tasks LIMIT 3" });
  expect(raw.rows.length).toBeGreaterThan(0); // 結果は普通に返る
  expect(raw.note).toContain("live_tasks");

  // created_at で完了を数える = 登録日を数えている (実データで踏まれていた間違い)
  const wrongDate = await mcp("query_log", {
    scope: "audit",
    sql: "SELECT date(created_at) d, COUNT(*) n FROM tasks WHERE archived=1 GROUP BY 1",
  });
  expect(wrongDate.note).toContain("done_at");

  // 正しく引いたときは余計なことを言わない
  const ok = await mcp("query_log", { scope: "audit", sql: "SELECT id, title FROM live_tasks LIMIT 3" });
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
