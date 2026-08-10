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
  const id = await createTask("E2E: Doneから持ち出し禁止", "done");
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
