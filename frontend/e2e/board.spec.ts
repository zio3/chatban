import { expect, test, type Page } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";

const API = "http://localhost:8799";

async function createCard(title: string, status = "todo"): Promise<number> {
  const res = await fetch(`${API}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, status }),
  });
  const card = await res.json();
  return card.id;
}

/** Doneのタスクを用意する。POST /api/cards に status:"done" を渡しても通らないので
 * (Doneへの扉は検収だけ)、本番と同じ道を通す: review → 検収チェック → 確定 */
async function createDoneCard(title: string): Promise<number> {
  const id = await createCard(title, "review");
  await fetch(`${API}/api/cards/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/cards/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });
  return id;
}

async function getCardStatus(id: number): Promise<string | undefined> {
  const res = await fetch(`${API}/api/board`);
  const board = await res.json();
  return board.cards.find((t: any) => t.id === id)?.status;
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
  const todoCount = board.cards.filter((t: any) => t.status === "todo").length;
  await expect(page.getByTestId("count-todo")).toHaveText(String(todoCount));
});

test("D&Dで列間移動しstatusが即時更新・リロード後も維持", async ({ page }) => {
  const id = await createCard("E2E: 列間移動テスト");
  await page.goto("/");
  const card = page.getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  await drag(page, card, page.getByTestId("column-review"));
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
  await expect.poll(() => getCardStatus(id)).toBe("review");

  await page.reload();
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
});

test("列内並び替えがリロード後も維持される", async ({ page }) => {
  const a = await createCard("E2E: 並び替えA");
  const b = await createCard("E2E: 並び替えB");
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
  const id = await createCard("E2E: 失敗リトライテスト");
  await page.goto("/");
  const card = page.getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  // PATCH を強制失敗させる
  await page.route(`**/api/cards/${id}`, (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "forced failure" }) : route.continue()
  );
  await drag(page, card, page.getByTestId("column-review"));

  await expect(page.getByTestId("toast")).toBeVisible();
  // ロールバックでtodo列に戻っている + サーバー側は未変更
  await expect(page.getByTestId("column-todo").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getCardStatus(id)).toBe("todo");

  // 障害解除してリトライ → 移動が成立しトーストが消える
  await page.unroute(`**/api/cards/${id}`);
  await page.getByTestId("toast").getByRole("button", { name: "リトライ" }).click();
  await expect(page.getByTestId("toast")).toBeHidden();
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
  await expect.poll(() => getCardStatus(id)).toBe("review");
});

test("DoneへはD&Dで移動できない (検収ボタン経由のみ) (#57)", async ({ page }) => {
  const id = await createCard("E2E: Doneドロップ禁止テスト");
  await page.goto("/");
  const card = page.getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  // Done列へドラッグしても動かない
  await drag(page, card, page.getByTestId("column-done"));
  await expect(page.getByTestId("column-todo").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getCardStatus(id)).toBe("todo");
});

test("Review列: 検収OKチェック→一括確定でdoneになる (チェックだけでは動かない) (#57)", async ({ page }) => {
  const id = await createCard("E2E: 検収テスト", "review");
  await page.goto("/");
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();

  // チェックはマーキングのみ (Reviewに留まる)
  await page.getByTestId(`approve-${id}`).check();
  await expect(page.getByTestId("column-review").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getCardStatus(id)).toBe("review");

  // 一括確定ボタンでdoneへ
  await page.getByTestId("approve-commit").click();
  await expect(page.getByTestId("column-done").getByTestId(`task-card-${id}`)).toBeVisible();
  await expect.poll(() => getCardStatus(id)).toBe("done");
});

test("プロジェクト: 切り替えるとボードが入れ替わり、#IDは1から振り直される (#86)", async ({ page }) => {
  const inFirst = await createCard("E2E: 元プロジェクトのタスク");

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
  const res = await fetch(`${API}/api/cards`, {
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
  const id = await createCard("E2E: ゴミ箱テスト");
  await page.goto("/");
  await expect(page.getByTestId(`task-card-${id}`)).toBeVisible();

  // チャット/MCPと同じ経路 (DELETE /api/cards/:id) はゴミ箱行き
  await fetch(`${API}/api/cards/${id}`, { method: "DELETE" });
  await expect(page.getByTestId(`task-card-${id}`)).toBeHidden();

  // 実体は残っている
  const trashed = await (await fetch(`${API}/api/trash`)).json();
  expect(trashed.cards.some((t: any) => t.id === id)).toBe(true);

  // ゴミ箱画面から戻せる
  await page.getByRole("button", { name: "🗑 ゴミ箱" }).click();
  await page.getByRole("button", { name: "戻す" }).first().click();
  await page.getByRole("button", { name: "ボード" }).click();
  await expect(page.getByTestId(`task-card-${id}`)).toBeVisible();

  // 完全削除は二段階 (押し間違いで消えない)
  await fetch(`${API}/api/cards/${id}`, { method: "DELETE" });
  await page.getByRole("button", { name: "🗑 ゴミ箱" }).click();
  await page.getByRole("button", { name: "完全に削除" }).first().click();
  await expect(page.getByRole("button", { name: "本当に消す" })).toBeVisible();
  await page.getByRole("button", { name: "本当に消す" }).click();
  await expect(page.getByText("ゴミ箱は空です")).toBeVisible(); // 反映を待ってから実体を確認する
  const after = await (await fetch(`${API}/api/trash`)).json();
  expect(after.cards.some((t: any) => t.id === id)).toBe(false);
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
  sock.on("board:changed", (p: { cards: unknown[] }) => received.push(p.cards.length));
  await new Promise<void>((r) => sock.on("connect", () => r()));

  // プロジェクト1への変更は届く
  await createCard("E2E: room検証(プロジェクト1)");
  await expect.poll(() => received.length).toBeGreaterThan(0);
  const afterFirst = received.length;

  // 別プロジェクトを触っても届かない (#97: 対象はヘッダで明示する)
  await fetch(`${API}/api/cards`, {
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
  await fetch(`${API}/api/cards`, {
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
  const id = await createDoneCard("E2E: Doneから持ち出し禁止");
  await page.goto("/");
  const card = page.getByTestId("column-done").getByTestId(`task-card-${id}`);
  await expect(card).toBeVisible();

  // Todo列へドラッグしても動かない (検収後アーカイブ完了までの間に持ち出せると
  // あとから走るアーカイブ処理が archived=1 にして幽霊タスクになる)
  await drag(page, card, page.getByTestId("column-todo"));
  await expect(page.getByTestId("column-done").getByTestId(`task-card-${id}`)).toBeVisible();
  expect(await getCardStatus(id)).toBe("done");
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
  const id = await createCard("楽観ロックの検証");

  // 版を添えないと適用されない (「必須」がプロンプトではなく契約で効いている)
  const noVersion = await mcp("update_cards", { updates: [{ id, context: "版なしで書く" }] });
  expect(noVersion.conflicts?.[0]?.id).toBe(id);
  expect(noVersion.conflicts[0].contextVersion).toBe(1);
  // #120: 弾いたものを updated に載せない。成功と失敗を排他にする
  expect(noVersion.ok).toBe(false);
  expect(noVersion.updated).toHaveLength(0);

  // 正しい版なら通り、版が上がる
  const ok = await mcp("update_cards", { updates: [{ id, context: "Aの追記", context_version: 1 }] });
  expect(ok.conflicts).toBeUndefined();
  expect(ok.updated[0].contextVersion).toBe(2);

  // 古い版のままだと衝突し、Aの追記は消えない。現在の全文が返るのでマージできる
  const stale = await mcp("update_cards", { updates: [{ id, context: "Bの追記", context_version: 1 }] });
  expect(stale.conflicts[0].context).toBe("Aの追記");
  expect(stale.conflicts[0].contextVersion).toBe(2);

  // 状態変更は版を要求されず、経緯メモの版も上げない
  // (1本の版で守ると、長い書き戻しが無関係な状態変更で弾かれてしまう)
  const statusOnly = await mcp("update_cards", { updates: [{ id, status: "inprogress" }] });
  expect(statusOnly.conflicts).toBeUndefined();
  expect(statusOnly.updated[0].status).toBe("inprogress");
  expect(statusOnly.updated[0].contextVersion).toBe(2);
});

test("検収の印はDBに残り、AIは読めるが付けられない (#108)", async () => {
  const id = await createCard("検収フラグの検証", "review");

  // 人間の経路(REST)でだけ付く
  await fetch(`${API}/api/cards/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const checked = await (await fetch(`${API}/api/cards/${id}`)).json();
  expect(checked.checkedAt).toBeTruthy();

  // エージェントはSQL窓口で読める
  const read = await mcp("query_log", { sql: `SELECT checked_at FROM cards WHERE id = ${id}` });
  expect(read.rows[0].checked_at).toBeTruthy();

  // 書く口はどこにも無い: SQL窓口は読み取り専用、update_cards のスキーマにも無い
  const write = await mcp("query_log", { sql: `UPDATE cards SET checked_at = NULL WHERE id = ${id}` });
  expect(write.ok).toBe(false);
  await mcp("update_cards", { updates: [{ id, checked_at: null, checkedAt: null }] });
  const afterAgent = await (await fetch(`${API}/api/cards/${id}`)).json();
  expect(afterAgent.checkedAt).toBeTruthy(); // エージェントの指定は素通りする(消せない)

  // 作業中の列へ戻すと印は消える (確かめたのは前の状態に対してなので)
  await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "inprogress" }),
  });
  const reopened = await (await fetch(`${API}/api/cards/${id}`)).json();
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
  const id = await createCard("E2E: 差分で拾われるタスク");
  await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });

  const delta = await mcp("sync_board", { sync_token: full.syncToken });
  expect(delta.syncToken).not.toBe(full.syncToken);
  // 全件は返らない (差分なのでタスク配列を持たない)
  expect(delta.cards).toBeUndefined();
  const line = (delta.boardChanges as string[]).find((c) => c.includes(`#${id}`));
  expect(line).toBeTruthy();
  // **行だけ見て現在が確定すること。**IDしか書いていない差分だと古い一覧とマージさせることになる
  expect(line).toContain("E2E: 差分で拾われるタスク");

  // 失効したトークンでも失敗させない (エラーを返すとLLMがリトライを考え始める)
  const stale = await mcp("sync_board", { sync_token: "p1-20200101T000000-1" });
  expect(Array.isArray(stale.cards)).toBe(true);
  expect(String(stale.note)).toContain("全件");
});

test("MCPの読み取りはSQL窓口1本。落とした一覧ツールは同じ内容を引ける (#108)", async () => {
  const id = await createCard("SQL窓口の検証", "review");

  // 読み取り専用ツールは query_log と search_cards だけ (list_* は無い)
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
    sql: `SELECT id, status, title FROM cards WHERE archived=0 AND trashed_at IS NULL AND id=${id}`,
  });
  expect(board.rows.some((r: any) => r.id === id)).toBe(true);

  const anchor = await mcp("get_project_context", {});
  expect(anchor.project.id).toBe(1);
});

test("done_at は完了に入った瞬間だけ打刻され、その後の編集では動かない (#108)", async () => {
  const id = await createCard("done_atの検証", "review");
  const patch = (body: unknown) =>
    fetch(`${API}/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = async () => (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;

  expect((await get()).doneAt).toBeFalsy();

  // 検収チェックを先に付ける。approve はサーバー側で「Review列 + 検収済み」を確かめるので、
  // チェック無しでは通らない (以前は無条件に done にできたため、このテストも省略していた)
  await fetch(`${API}/api/cards/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/cards/approve`, {
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
  const depId = await createCard("依存先のタスク", "inprogress");
  const id = await createCard("依存元のタスク");
  await fetch(`${API}/api/cards/${id}`, {
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
  const depId = await createCard("先に終わらせるタスク", "inprogress");
  const id = await createCard("それを待っているタスク");
  await fetch(`${API}/api/cards/${id}`, {
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
  const a = await createCard("並べ替えA");
  const b = await createCard("並べ替えB");
  const gone = await createCard("アーカイブ行き", "review");
  await fetch(`${API}/api/cards/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [gone] }),
  });

  // アーカイブ済みと存在しないIDを混ぜても、全体は失敗せず ignored で返る
  const r = await mcp("reorder_cards", { status: "todo", ids: [b, gone, 999999, a] });
  expect(r.ignored).toContain(gone);
  expect(r.ignored).toContain(999999);
  expect(r.ordered).toBe(2);

  // 指定した2件は指定順に並ぶ
  const board = await (await fetch(`${API}/api/board`)).json();
  const todo = board.cards.filter((t: any) => t.status === "todo").sort((x: any, y: any) => x.sort - y.sort);
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
  const id = await createCard("部分適用しないことの検証");
  const before = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;

  // context と summary を一緒に送り、context の版だけ古い
  const r = await mcp("update_cards", {
    updates: [{ id, context: "古い版で書く", context_version: 999, summary: "これも保存されてはいけない" }],
  });

  expect(r.ok).toBe(false);
  expect(r.updated).toHaveLength(0); // 弾いた行は updated に載らない
  expect(r.note).toContain("一切適用していません");

  const after = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  expect(after.summary).toBe(before.summary); // 巻き添えで保存されない
  expect(after.updatedAt).toBe(before.updatedAt); // 拒否された書き込みで最終更新も動かない
});

test("存在しないIDは notFound で名指しし、成功と混ぜない (#123 #124)", async () => {
  const id = await createCard("実在するタスク");

  // 一部だけ失敗 = partial。適用できた行だけが updated に入り、null は混ざらない
  const partial = await mcp("update_cards", {
    updates: [{ id: 999999, summary: "存在しない" }, { id, summary: "実在する方" }],
  });
  expect(partial.ok).toBe(false);
  expect(partial.status).toBe("partial");
  expect(partial.notFound).toEqual([999999]);
  expect(partial.updated).toHaveLength(1);
  expect(partial.updated.every((t: unknown) => t != null)).toBe(true);
  expect(partial.note).toContain("2件のうち1件を適用しました");

  // 実在する方は実際に書けている (部分適用は「できたものはできた」)
  const after = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  expect(after.summary).toBe("実在する方");

  // 全滅は failed。ok:false だけだと「全部か一部か」が分からないので状態で言う
  const failed = await mcp("update_cards", { updates: [{ id: 999998, summary: "x" }] });
  expect(failed.status).toBe("failed");
  expect(failed.updated).toHaveLength(0);

  const all = await mcp("update_cards", { updates: [{ id, summary: "全部通る" }] });
  expect(all.ok).toBe(true);
  expect(all.status).toBe("ok");
});

test("経緯メモは版なしで追記でき、追記どうしは互いを消さない", async () => {
  const id = await createCard("追記の検証");

  // 全文上書きは版が要る (既存の守り)。追記は要らない — 足すだけなので他人の追記を消さない
  const a = await mcp("update_cards", { updates: [{ id, context_append: "1件目の追記" }] });
  expect(a.ok).toBe(true);

  // 読み直さずにもう1件足せる。版を持っていなくても通る
  const b = await mcp("update_cards", { updates: [{ id, context_append: "2件目の追記" }] });
  expect(b.ok).toBe(true);

  const after = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  expect(after.context).toBe(["1件目の追記", "2件目の追記"].join("\n\n")); // 1件目が残っている
  expect(after.contextVersion).toBeGreaterThan(1); // 版は進む (全文置換しようとしている人を弾くため)

  // 全文上書きは従来どおり版が要る
  const stale = await mcp("update_cards", { updates: [{ id, context: "全部消す", context_version: 1 }] });
  expect(stale.ok).toBe(false);
  const still = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  expect(still.context).toContain("1件目の追記");
});

test("生きているタスクは live_cards ビューで引ける (母集団の条件を毎回書かせない)", async () => {
  const alive = await createCard("生きているタスク");
  const trashed = await createCard("ゴミ箱行きのタスク");
  await mcp("delete_cards", { ids: [trashed] });

  // **この2件に絞って引く。**母集団を全件取ると query_log の上限 (200行) で切られ、
  // 積み重なったE2Eデータでは新しく作ったほうが範囲外に落ちて落ちる (実測: 387件で発生)。
  // 確かめたいのは「live_cards にゴミ箱が混ざらない」ことなので、母集団の大きさは要らない
  const r = await mcp("query_log", {
    sql: `SELECT id, title FROM live_cards WHERE id IN (${alive}, ${trashed})`,
  });
  const ids = (r.rows as any[]).map((x) => x.id);
  expect(ids).toContain(alive);
  expect(ids).not.toContain(trashed); // 条件を書かなくてもゴミ箱は混ざらない

  // cards を直に引けばゴミ箱も見える (見たいときは見られる)
  const raw = await mcp("query_log", {
    sql: `SELECT id FROM cards WHERE id=${trashed} AND trashed_at IS NOT NULL`,
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

  const update = tools.find((t) => t.name === "update_cards");
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
  expect(dep).toContain("reorder_cards");

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

test("完了は done_cards ビューで引ける。登録日と取り違えようがない", async () => {
  const id = await createCard("完了ビューの検証", "review");
  // 検収 → Done。done_at はこの瞬間に打刻される
  await fetch(`${API}/api/cards/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/cards/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });

  const r = await mcp("query_log", {
    sql: `SELECT id, done_day, done_at FROM done_cards WHERE id=${id}`,
  });
  expect(r.rows).toHaveLength(1);
  // 日付は列として出ているので date() を書かなくてよい
  expect((r.rows[0] as any).done_day).toBe((r.rows[0] as any).done_at.slice(0, 10));

  // 終わっていないものは入らない (created_at を完了日と取り違える余地がない)
  const alive = await createCard("まだ終わっていない");
  const none = await mcp("query_log", {
    sql: `SELECT id FROM done_cards WHERE id=${alive}`,
  });
  expect(none.rows).toHaveLength(0);
});

test("撤去した summary_cards はSQL窓口からも消えている (#200)", async () => {
  // テーブルを落としただけでなく、許可リストからも外れていること。
  // 片方だけ直すと「名前は通るが引けない」か「引けるが説明に無い」のどちらかになる
  const r = await mcp("query_log", { sql: "SELECT id FROM summary_cards LIMIT 1" });
  expect(r.ok).toBe(false);

  const tables = await mcpToolList();
  const queryLog = tables.find((t: any) => t.name === "query_log");
  expect(JSON.stringify(queryLog)).not.toContain("summary_cards");
});

test("SQLが失敗したら、直せる材料を一緒に返す (説明を厚くする代わりの事後注入)", async () => {
  // 列名を間違えたら、実DBから引いたスキーマが返る (説明とスキーマがズレない)
  const badCol = await mcp("query_log", { sql: "SELECT id, titel FROM live_cards LIMIT 1" });
  expect(badCol.ok).toBe(false);
  expect(badCol.schema["live_cards (ビュー)"]).toContain("title");
  expect(badCol.hint).toContain("live_cards");

  // 他のDBの関数を使ったら、SQLiteでの書き方が返る
  const badFn = await mcp("query_log", { sql: "SELECT date_trunc('day', created_at) FROM live_cards" });
  expect(badFn.ok).toBe(false);
  expect(JSON.stringify(badFn.dialect)).toContain("start of month");
});

test("エラーにならない間違いには、結果と一緒に一言添える", async () => {
  // cards 直引き = ゴミ箱もアーカイブも混ざる。エラーにならないので気づけない
  const raw = await mcp("query_log", { sql: "SELECT id, title FROM cards LIMIT 3" });
  expect(raw.rows.length).toBeGreaterThan(0); // 結果は普通に返る
  expect(raw.note).toContain("live_cards");

  // created_at で完了を数える = 登録日を数えている (実データで踏まれていた間違い)
  const wrongDate = await mcp("query_log", {
    sql: "SELECT date(created_at) d, COUNT(*) n FROM cards WHERE archived=1 GROUP BY 1",
  });
  expect(wrongDate.note).toContain("done_at");

  // 正しく引いたときは余計なことを言わない
  const ok = await mcp("query_log", { sql: "SELECT id, title FROM live_cards LIMIT 3" });
  expect(ok.note).toBeUndefined();
});

test("検収の確定はサーバー側で条件を確かめる (UIのフィルタに依存しない)", async () => {
  // Doneへ至る唯一の扉。以前は ids をそのまま done にしていて、直接叩けば
  // Todoのタスクもゴミ箱の中のタスクもDoneにできた (実測で3ケースとも通った)
  const todo = await createCard("検収ガード: Todoのまま");
  const unchecked = await createCard("検収ガード: Review未検収", "review");
  const trashed = await createCard("検収ガード: ゴミ箱");
  await fetch(`${API}/api/cards/${trashed}`, { method: "DELETE" });

  const ng = await (
    await fetch(`${API}/api/cards/approve`, {
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

  expect(await getCardStatus(todo)).toBe("todo");
  expect(await getCardStatus(unchecked)).toBe("review");

  // 正常系: Review + 検収済み は通る
  const ok = await createCard("検収ガード: 正しく検収済み", "review");
  await fetch(`${API}/api/cards/${ok}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const r = await (
    await fetch(`${API}/api/cards/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [ok] }),
    })
  ).json();
  expect(r.ok).toBe(true);
  expect(r.skipped).toBeUndefined();
  await expect.poll(() => getCardStatus(ok)).toBe("done");
});

test("検収APIを通らないRESTからもDoneには入れない (扉は1つ)", async () => {
  // 検収APIだけを厳しくしても、PATCH /api/cards/:id に status:"done" を投げれば素通りしていた
  // (自動レビュー指摘)。フロントは Board.tsx の handleDragEnd で Done列へのD&Dを禁止しているが、
  // その禁止がクライアント側にしか無く、PR #1 で塞いだのとまったく同じ形の穴だった。
  // 条件そのもの (Review列 + 検収済み) を updateCards の不変条件にしたので、入口を問わない
  const patch = async (id: number, body: unknown) =>
    (
      await fetch(`${API}/api/cards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();

  const todo = await createCard("扉は1つ: Todoから直接Done");
  const r1 = await patch(todo, { status: "done" });
  expect(r1.status).toBe("todo");
  expect(r1.note).toContain("Doneへは移していません"); // 黙って無視しない
  expect(await getCardStatus(todo)).toBe("todo");

  // 同じ patch に入っている他のフィールドは保存する (status だけ戻す)
  const unchecked = await createCard("扉は1つ: Review未検収", "review");
  const r2 = await patch(unchecked, { status: "done", summary: "この一行は残る" });
  expect(r2.status).toBe("review");
  expect(r2.summary).toBe("この一行は残る");

  // 新規作成でいきなりDoneも作れない (生まれた瞬間に検収済みのものは無い)
  const created = await (
    await fetch(`${API}/api/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "扉は1つ: 最初からDone", status: "done" }),
    })
  ).json();
  expect(created.status).toBe("review");
  expect(created.note).toContain("Doneへは移していません");

  // 正常系: 検収を通ればこの経路でも入る (条件を満たすかどうかだけを見ている)
  const ok = await createCard("扉は1つ: 検収済みならPATCHでも通る", "review");
  await fetch(`${API}/api/cards/${ok}/checked`, {
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
  const created = await fetch(`${API}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "知らない列", status: "banana" }),
  });
  expect(created.status).toBe(400);
  expect((await created.json()).error).toContain("todo / inprogress / review / done");

  const id = await createCard("入口の検証");
  const patched = await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "banana" }),
  });
  expect(patched.status).toBe(400);
  expect(await getCardStatus(id)).toBe("todo"); // 何も書き換わっていない

  // 居ないタスクの専用チャットは、LLMを呼ぶ前に断る (呼んでから気づくと課金だけ発生する)
  const ghost = await fetch(`${API}/api/cards/999999/chat`, {
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
    fetch(`${API}/api/cards/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked }),
    });

  const todo = await createCard("順序飛ばし: Todoで印を付ける");
  const ng = await check(todo);
  expect(ng.status).toBe(409);
  expect((await ng.json()).error).toContain("Review 列のカードだけ");

  // Reviewへ動かしてからなら付く。そのうえで確定できる
  await fetch(`${API}/api/cards/${todo}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });
  expect((await check(todo)).status).toBe(200);
  const r = await (
    await fetch(`${API}/api/cards/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [todo] }),
    })
  ).json();
  expect(r.ok).toBe(true);

  // ゴミ箱のタスクにも付けられない
  const trashed = await createCard("順序飛ばし: ゴミ箱", "review");
  await fetch(`${API}/api/cards/${trashed}`, { method: "DELETE" });
  expect((await check(trashed)).status).toBe(409);

  // 外すのはいつでもよい (印を消す方向は安全)
  const plain = await createCard("順序飛ばし: 印を外すのは自由");
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
  await createCard("E2E: 存在しないプロジェクト指定の検証");
  await new Promise((r) => setTimeout(r, 600));
  expect(received).toHaveLength(0);

  ghost.close();

  // 対照: 実在するプロジェクトを指定すれば従来どおり届く (塞ぎすぎていない)
  const ok = io(API, { query: { project: 1 }, transports: ["websocket"] });
  const got: unknown[] = [];
  ok.on("board:changed", (p) => got.push(p));
  await new Promise<void>((r) => ok.on("connect", () => r()));
  await createCard("E2E: 実在プロジェクト指定の対照");
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
  // 下で /api/cards/approve と /mcp が GET で通らないことだけ確かめておく
  for (const path of ["/api/suggestions", "/api/chat", "/api/cards/1/chat"]) {
    const res = await fetch(`${API}${path}`);
    expect(res.status, `${path} がGETで叩ける`).toBe(404);
  }
  // 間接的に要約(=LLM)を起こす口も、GETでは入口が無い
  expect((await fetch(`${API}/api/cards/approve`)).status).toBe(404);
  // MCPは stateless で POST only。GET は405で明示的に断る (ルートは在るので404ではない)
  expect((await fetch(`${API}/mcp/1`)).status).toBe(405);

  // **このテストが保証するのは「GETのルートが存在しないこと」だけ。**POST側が機能することは
  // ここでは確かめない — 有料のLLM呼び出しが走るため。
  //
  // #219: 以前ここに「E2Eは『LLM呼び出しなし』が原則」と書いていたが、**それは事実ではない**
  // (E2Eは backend/config.json を読むので呼び出しは実際に起きる。詳細は playwright.config.ts)。
  // 原則ではなく「増やさない」が正しい — 呼ぶ経路を新しく足さない、という意味でここは踏まない
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
  const beforeCount = before.projects.find((p: any) => p.id === 1).openCards as number;

  const res = await fetch(`${API}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E: ゴミ箱と件数" }),
  });
  const id = (await res.json()).id as number;

  const counts = async () => {
    const projects = await (await fetch(`${API}/api/projects`)).json();
    const board = await (await fetch(`${API}/api/board`)).json();
    return {
      project: projects.projects.find((p: any) => p.id === 1).openCards as number,
      onBoard: board.cards.some((t: any) => t.id === id),
    };
  };
  expect((await counts()).project).toBe(beforeCount + 1);

  // ゴミ箱へ移すと、ボードからも件数からも消える (片方だけ残らない)
  await fetch(`${API}/api/cards/${id}`, { method: "DELETE" });
  const after = await counts();
  expect(after.onBoard).toBe(false);
  expect(after.project).toBe(beforeCount);
});

test("完全削除はゴミ箱を通ったものだけ (取り返しのつく形を必ず一度経由させる)", async () => {
  // #102 で「間違えないようにするのではなく、間違えても取り返しがつく形にする」と決めたのに、
  // DELETE /api/trash/:id が id しか見ておらず、ボード上の生タスクのIDを直接投げると
  // ゴミ箱を経由せず実体が消えた (自動レビュー指摘)。二段構えの二段目が無条件では意味がない
  const alive = await createCard("完全削除: 生きているタスク");
  const purge = (id: number) => fetch(`${API}/api/trash/${id}`, { method: "DELETE" });

  const ng = await purge(alive);
  expect(ng.status).toBe(409);
  expect((await ng.json()).error).toContain("ゴミ箱にないカード");
  expect(await getCardStatus(alive)).toBe("todo"); // 消えていない

  // ゴミ箱へ移してからなら通る
  await fetch(`${API}/api/cards/${alive}`, { method: "DELETE" });
  expect((await purge(alive)).status).toBe(200);
  expect((await fetch(`${API}/api/cards/${alive}`)).status).toBe(404);

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
  const id = await createCard("重複ID: 1件として数える", "review");
  await fetch(`${API}/api/cards/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const r = await (
    await fetch(`${API}/api/cards/approve`, {
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
  const id = await createCard("差し戻しで印が消える検証", "review");
  const check = (checked: boolean) =>
    fetch(`${API}/api/cards/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked }),
    });
  const get = async () => (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  const approve = async () =>
    (await (
      await fetch(`${API}/api/cards/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      })
    ).json()) as any;

  await check(true);
  expect((await approve()).ok).toBe(true);
  await expect.poll(() => getCardStatus(id)).toBe("done");
  expect((await get()).checkedAt).toBeTruthy(); // Doneでは検収の結果として残る

  // Doneから差し戻す (チャットの「戻して」やD&Dで起きる)
  await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });
  expect((await get()).checkedAt).toBeFalsy(); // 印は消える

  // 印が無いので、そのままではもう一度Doneへ通せない
  const again = await approve();
  expect(again.ok).toBe(false);
  expect(JSON.stringify(again.skipped)).toContain("検収チェックが付いていません");
  expect(await getCardStatus(id)).toBe("review");

  // 付け直せば通る
  await check(true);
  expect((await approve()).ok).toBe(true);
  await expect.poll(() => getCardStatus(id)).toBe("done");
});

test("存在しないプロジェクトを指定した操作は既定へ落とさず拒否する (#125)", async () => {
  const bad = { "X-ChatBan-Project": "9999" };

  // 読み取りも書き込みも 400。黙って既定プロジェクトへ落ちない
  expect((await fetch(`${API}/api/board`, { headers: bad })).status).toBe(400);
  const write = await fetch(`${API}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bad },
    body: JSON.stringify({ title: "9999のつもりで作る" }),
  });
  expect(write.status).toBe(400);

  // 既定プロジェクトに混入していない
  const board = await (await fetch(`${API}/api/board`)).json();
  expect(board.cards.some((t: any) => t.title.includes("9999のつもり"))).toBe(false);

  // 無指定は既定プロジェクトで通る (curl・スクリプト用の経路は残す)
  expect((await fetch(`${API}/api/board`)).status).toBe(200);
});

test("MCPは接続URLのプロジェクトしか触れない (#125)", async () => {
  const id = await createCard("project1のタスク");

  // project2 のエンドポイントから project1 のIDを更新しようとしても届かない
  const res = await fetch(`${API}/mcp/2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "update_cards", arguments: { updates: [{ id, summary: "別プロジェクトから書き換えた" }] } },
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

  const after = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  expect(after.summary).toBeFalsy();
});

test("日本語が \\uXXXX エスケープで届いてもデコードして保存する", async () => {
  // 実害: project 9 の前提情報が全文エスケープで保存され、296字が1,346字(トークン3.2倍)に
  // 膨らんだうえ、LLMの読み取り精度も落ちていた (見出しの数を数え間違えた)
  const escaped = "\\u30c6\\u30b9\\u30c8\\u306e\\u30bf\\u30a4\\u30c8\\u30eb"; // 「テストのタイトル」
  const r = await mcp("create_cards", { cards: [{ title: escaped, summary: escaped }] });
  const id = r.created[0].id;

  const t = (await (await fetch(`${API}/api/cards/${id}`)).json()) as any;
  expect(t.title).toBe("テストのタイトル");
  expect(t.summary).toBe("テストのタイトル");

  // 単発のエスケープは壊さない (説明文で言及したいことがある)
  const single = await mcp("create_cards", { cards: [{ title: "\\u0041 は A のこと" }] });
  const t2 = (await (await fetch(`${API}/api/cards/${single.created[0].id}`)).json()) as any;
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
  const rows = await q("SELECT id, title FROM live_cards LIMIT 1");
  expect(Array.isArray(rows.rows)).toBe(true);
  // WITH も通ること。EXPLAIN を1回挟むようにしたので、素直なSELECT以外が壊れていないか確かめる
  const cte = await q("WITH x AS (SELECT id FROM live_cards LIMIT 3) SELECT COUNT(*) c FROM x");
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

test("チャットの処理中は提案チップを生成しない (#162)", async () => {
  // 上流が遅いときに並走するとTTFTが悪化する (実測: 単独12秒 → 3本並走で30〜55秒)。
  // しかもチップは会話が始まる前にしか出ないので、送信した瞬間から表示される余地が無い。
  // ここではLLMを呼ばずに、抑止のフラグが立っている間だけ空になることを確かめる
  const id = await createCard("チャット中の抑止を確かめる");

  // 応答が返る前に叩きたいので、待たずに走らせる。E2E環境のLLMは失敗してよい
  // (成否によらず runChatTurn には入るので、その間フラグは立つ)
  const chatting = fetch(`${API}/api/cards/${id}/chat`, {
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

  const id = await createCard("suggest先行の中断を確かめる");

  // 狙いたいのは「suggestが走っている最中にchatが来る」状態。
  // suggestが先に終わってしまうと中断する相手がいないので、その回は検証にならない
  let observed = false;
  for (let attempt = 0; attempt < 3 && !observed; attempt++) {
    // ボードを変えて提案キャッシュを外す。同じ状態だとLLMを呼ばずに即返る
    await createCard(`suggest先行の中断を確かめる (${attempt})`);
    const before = abortLines();

    // suggestを先に始める。待たない
    const suggesting = fetch(`${API}/api/suggestions`, { method: "POST" })
      .then((r) => r.json())
      .catch(() => null);

    // 走り出してからチャットを送る
    await new Promise((r) => setTimeout(r, 300));
    const chatting = fetch(`${API}/api/cards/${id}/chat`, {
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
  const id = await createCard("検収済みだがゴミ箱を通ったタスク", "review");
  await fetch(`${API}/api/cards/${id}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  const checkedAt = async () =>
    (await mcp("query_log", { scope: "audit", sql: `SELECT checked_at FROM cards WHERE id=${id}` }))
      .rows[0].checked_at;
  expect(await checkedAt(), "検収の印が付いていない").toBeTruthy();

  // ゴミ箱 → 復元。**AIが呼べるMCPツールだけで往復できる**のがこの穴の入口だった
  expect((await mcp("delete_cards", { ids: [id] })).ok).toBe(true);
  expect((await mcp("restore_cards", { ids: [id] })).ok).toBe(true);

  // 復元後は未検収に戻っている (ゴミ箱と復元の間に人間の確認は一度も入っていない)
  expect(await checkedAt(), "古い検収の印が生き返っている").toBeFalsy();

  // ゴミ箱にいる間は「検収済みだった」事実が残る (監査の材料を消さない)。
  // ゴミ箱にある限り mayEnterDone は trashedAt を見て false なので、残っていても危険はない —
  // **落とすのは復元のとき**。この形なら、変更前からゴミ箱にある行にも効く

  // **やっていないことを報告しない。**ゴミ箱に無いタスクを restore しても成功にしない
  // (以前は更新0件でも getCard を返していたので「復元しました」と言えてしまった)
  const again = await mcp("restore_cards", { ids: [id] });
  expect(again.ok, "ゴミ箱に無いのに復元成功として返っている").toBe(false);
  expect(again.notRestored).toContain(id);
  expect(again.restored, "戻していないのに restored に載っている").toHaveLength(0);

  // RESTは理由で応答を分ける。**実在するタスクを「無い」と言わない**
  const already = await fetch(`${API}/api/cards/${id}/restore`, { method: "POST" });
  expect(already.status, "実在するのに404を返している").toBe(409);
  const missing = await fetch(`${API}/api/cards/99999999/restore`, { method: "POST" });
  expect(missing.status).toBe(404);

  // 同じIDを2つ渡しても、片方が成功・片方が失敗にならない (先に重複を落とす)
  const dupTarget = await createCard("重複指定で戻すタスク");
  await mcp("delete_cards", { ids: [dupTarget] });
  const dup = await mcp("restore_cards", { ids: [dupTarget, dupTarget] });
  expect(dup.ok, "同じIDが成功と失敗の両方になっている").toBe(true);
  expect(dup.restored).toHaveLength(1);
  expect(dup.notRestored).toBeUndefined();
  // 応答は要点だけ。**経緯メモを載せない** — チャット経路ではこれが次のLLM入力へ再投入される
  expect(Object.keys(dup.restored[0]).sort()).toEqual(["id", "status", "title"]);
  // 復元したら検収の印が外れることを応答でも言う (境界はコードで守るが、報告しないと
  // エージェントは「さっき検収されていた」前提のまま話を進める)
  expect(dup.note).toContain("検収");

  // 印が無いので確定も通らない。setChecked はRESTにしか無いので、AIはここから先へ進めない
  const res = await fetch(`${API}/api/cards/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  });
  const after = await mcp("query_log", { scope: "audit", sql: `SELECT status FROM cards WHERE id=${id}` });
  expect(res.ok).toBe(true); // 一括検収そのものは成功で返る (条件を満たす件だけ通す)
  expect(after.rows[0].status, "未検収なのにDoneへ入った").not.toBe("done");
});

test("期限は登録時にも保存される (弾くだけ足して保存を忘れない) (#153)", async () => {
  // **「検証を足したら、通ったものが効くこと」まで確かめる。**
  // 検証だけ足して createCard に渡し忘れ、正しい due が200のまま黙って捨てられていた
  const res = await fetch(`${API}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "登録時に期限を入れるタスク", due: "2026-08-20" }),
  });
  expect(res.ok).toBe(true);
  const created = await res.json();
  expect(created.due, "正しい期限が黙って捨てられている").toBe("2026-08-20");

  // 不正な形式は登録そのものを断る
  const bad = await fetch(`${API}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "だめな期限", due: "2026-02-31" }),
  });
  expect(bad.status).toBe(400);

  // 解除の "" は空文字を保存せず null に均す (画面では解除に見えるのに
  // WHERE due IS NOT NULL のSQLに残る、という食い違いを作らない)
  await fetch(`${API}/api/cards/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ due: "" }),
  });
  const row = await mcp("query_log", {
    scope: "audit",
    // 別名に notNull は使えない (SQLite の予約語 NOTNULL とぶつかって構文エラーになる)
    sql: `SELECT due, (due IS NOT NULL) AS has_due FROM cards WHERE id=${created.id}`,
  });
  expect(row.rows[0].has_due, "解除したのに空文字が残っている").toBe(0);
});

test("期限の形式が違うとその指定だけ捨てて名指しで返す (#153)", async () => {
  // REST は 400 で断る
  const id = await createCard("期限を入れたいタスク");
  const bad = await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ due: "not-a-date" }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("YYYY-MM-DD");

  // エージェント経路 (MCP) は行ごと落とさず、他の項目は保存して badDue で報告する
  const r = await mcp("update_cards", { updates: [{ id, summary: "現況は保存される", due: "2026-02-31" }] });
  expect(r.badDue, "期限を捨てたことが名指しで返っていない").toContain(id);
  expect(r.note).toContain("期限の形式");

  const row = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT due, summary FROM cards WHERE id=${id}`,
  });
  expect(row.rows[0].due, "暦に無い日付が保存された").toBeFalsy();
  expect(row.rows[0].summary, "期限以外も一緒に落ちている").toBe("現況は保存される");

  // 正しい形式は通る (弾きすぎていないことの確認)
  const ok = await mcp("update_cards", { updates: [{ id, due: "2026-08-17" }] });
  expect(ok.badDue).toBeUndefined();
  expect((await mcp("query_log", { scope: "audit", sql: `SELECT due FROM cards WHERE id=${id}` })).rows[0].due)
    .toBe("2026-08-17");
});

test("検索の絞り込みは引数ではなくSQLへ案内する (#176)", async () => {
  const hit = await createCard("スクリーンショットを撮り直す");
  const noise = await createCard("ダークモードの検討");
  // 経緯メモに語が入っているだけのタスク (#130 で実際に起きた形)。
  // context の全文上書きは版が要るので、版の要らない context_append で足す
  await mcp("update_cards", {
    updates: [{ id: noise, context_append: "提出前に見た目を揃えるかどうか。スクリーンショットの見え方も含む" }],
  });

  // search_cards は広く当てる道具のまま (本文で当たるものも返る)
  const wide = await mcp("search_cards", { terms: ["スクリーンショット"] });
  const wideIds = wide.hits.map((h: any) => h.id);
  expect(wideIds).toContain(hit);
  expect(wideIds, "本文で当たるものが出ていない (前提が崩れている)").toContain(noise);

  // **絞り込みの引数は持たない。**足しかけた title_only は撤回した (#91 と同じ判断) —
  // 渡しても黙って無視される (=引数で絞れると思わせない) ことを固定する
  const ignored = await mcp("search_cards", { terms: ["スクリーンショット"], title_only: true });
  expect(ignored.hits.map((h: any) => h.id), "絞り込みの引数が生きている").toContain(noise);

  // 代わりに契約がSQLへ案内していること。案内が消えたら、絞りたいエージェントは
  // 引数を探して見つからず、広い結果を読み直すことになる
  const tools = await mcpToolList();
  const desc = tools.find((t: any) => t.name === "search_cards").description as string;
  expect(desc).toContain("query_log");
  expect(desc).toContain("title LIKE");

  // **案内した先が実際に効くことまで確かめる。**手順を書くだけでなく通してみる
  const narrowed = await mcp("query_log", {
    scope: "audit",
    sql: "SELECT id, title FROM live_cards WHERE title LIKE '%スクリーンショット%'",
  });
  const narrowedIds = narrowed.rows.map((r: any) => r.id);
  expect(narrowedIds).toContain(hit);
  expect(narrowedIds, "SQLで絞ったのに本文で当たったものが残っている").not.toContain(noise);
});

test("live_cards と done_cards に何が入るかは、契約に書いてある通りになっている (#175)", async () => {
  // **説明を足したら、実物がその通りかを見る。**#175 は「review が live_cards に
  // 入るかどうかが契約に書いていない」ために誤報 (「live_cards に review が出ないバグ」) が
  // 起きた札。ビューは status ではなく archived / trashed_at / done_at で定義されているので、
  // 説明のほうを実物に合わせたうえで、その説明をここで固定する
  const todo = await createCard("live: todoのもの", "todo");
  const inprogress = await createCard("live: inprogressのもの", "inprogress");
  const review = await createCard("live: reviewのもの", "review");

  const live = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id, status FROM live_cards WHERE id IN (${todo}, ${inprogress}, ${review})`,
  });
  const ids = live.rows.map((r: any) => r.id);
  for (const [label, id] of [["todo", todo], ["inprogress", inprogress], ["review", review]] as const) {
    expect(ids, `${label} が live_cards に出ていない`).toContain(id);
  }

  // 検収してDoneへ確定すると done_cards に現れる。
  // **このE2Eは AUTO_ARCHIVE=0 なので畳まれず、live_cards にも残る** —
  // 契約に書いた「同じタスクが両方に出る瞬間がある (不整合ではない)」がこの状態
  await fetch(`${API}/api/cards/${review}/checked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked: true }),
  });
  await fetch(`${API}/api/cards/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [review] }),
  });

  const done = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id, done_day FROM done_cards WHERE id=${review}`,
  });
  expect(done.rows, "確定したのに done_cards に出ていない").toHaveLength(1);
  expect(done.rows[0].done_day, "done_day が空 (date(done_at) が引けていない)").toBeTruthy();

  const stillLive = await mcp("query_log", {
    scope: "audit",
    sql: `SELECT id FROM live_cards WHERE id=${review}`,
  });
  expect(stillLive.rows, "畳まれていないDoneが live_cards から消えている (契約の記述と違う)").toHaveLength(1);

  // 契約側にもその説明が書かれていること (書いていないと推測される #92/#175)
  const tools = await mcpToolList();
  const desc = tools.find((t: any) => t.name === "query_log").description as string;
  for (const word of ["todo / inprogress / review", "畳まれるまでは同じカードが両方に出る"]) {
    expect(desc, `契約に「${word}」の説明が無い`).toContain(word);
  }
  // **「短時間」と書き戻さない。**畳む処理は fire-and-forget で、プロセスが止まれば
  // ジョブは失われ、起動時に回収する処理も無い = 両方に出る状態は無期限に残る (Codexレビュー指摘)。
  // 「時間で消える」と書くと、エージェントは待てば直ると判断してしまう
  expect(desc, "「短時間」と書くと待てば直ると読まれる").not.toContain("短時間");
});

test("チャットに番号だけ打つと、LLMを呼ばずにそのタスクを開く (#197)", async ({ page }) => {
  // 「検索窓が欲しい、とくに番号でアクセスしたいケースが増えてきた」への答え。
  // 専用の検索窓は作らず、常設のチャット (#74) を入口にした。
  // 開く仕掛け (openCard / jumpToBoard) は #59 / #111 で既に在ったので、足したのは入口だけ
  const id = await createCard("番号ジャンプの的");
  await page.goto("/");
  const input = page.getByPlaceholder("ボードに話しかける…", { exact: false });

  // `#<id>` で開く
  await input.fill(`#${id}`);
  await input.press("Enter");
  await expect(page.getByTestId("task-detail-panel")).toBeVisible();
  await expect(page.getByText(`#${id} をひらきます。`)).toBeVisible();
  // 番号ジャンプはLLMへ行く手前で横取りするので、応答待ちの「考え中…」は出ない。
  //
  // **これは「LLMを呼んでいない」の証明ではない。**`toBeHidden()` は確認した時点で
  // 非表示なら通るので、送信された直後の一瞬をすり抜けうる。ここで押さえているのは
  // 「パネルが開き、応答待ちの表示に切り替わっていない」までで、呼び出しの有無ではない。
  //
  // #219: 以前ここに「E2E環境には鍵が無いので失敗が出る」と書いていたが、**鍵はある**
  // (E2Eは backend/config.json をそのまま読む)。**LLMへ行けば失敗せずに成功して課金される**ので、
  // 「失敗が出る」を証拠にしてはいけない
  await expect(page.getByText("考え中…")).toBeHidden();

  // 井桁なしの数字だけでも開く (パネルを閉じてから確かめる)
  await page.getByTestId("task-detail-panel").getByTitle("閉じる").click();
  await expect(page.getByTestId("task-detail-panel")).toBeHidden();
  await input.fill(String(id));
  await input.press("Enter");
  await expect(page.getByTestId("task-detail-panel")).toBeVisible();
});

test("存在しない番号は横取りせず、普通の発言としてLLMへ渡す (#197)", async ({ page }) => {
  // 「2026」のような数字だけの発言を番号ジャンプが食べてしまわないこと。
  // zio判断: パターンに合っても、その番号が無ければ通常のチャット
  await page.goto("/");
  const input = page.getByPlaceholder("ボードに話しかける…", { exact: false });
  await input.fill("999999");
  await input.press("Enter");
  // パネルは開かない。発言はチャットへ流れる。
  //
  // #219: **このテストは有料のLLM呼び出しを起こす。**以前は「鍵が無いので結果は失敗でよい」と
  // 書いていたが誤り。鍵はあり、実測では成功していた (`OK ... reply=37ch`)。
  // 応答の中身は見ずに「パネルが開かないこと」だけを見るので、**呼び出しに見合う価値は無い**。
  // 残しているのは、横取りしない経路がチャットへ流れることを端から端まで見たいため。
  // **コメントで「無駄」と書いても課金は止まらない** — 止めるならテスト設計を変える
  // (番号ジャンプの分岐だけを見る形にする)。それは別の判断なのでここではやらない
  await expect(page.getByTestId("task-detail-panel")).toBeHidden();
  await expect(page.getByText("999999")).toBeVisible();
});

// #19: 任意レーン (custom1 / custom2)。
// 既定は0本なので、ふつうのボードは4列のまま — その「変わらないこと」も一緒に確かめる。
async function setLanes(custom1: string, custom2 = "") {
  await fetch(`${API}/api/projects/1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom1Label: custom1, custom2Label: custom2 }),
  });
}

test.describe("任意レーン (#19)", () => {
  // レーンはプロジェクトの設定なので、他のテストへ漏れないよう必ず戻す
  test.afterEach(async () => {
    await setLanes("", "");
  });

  test("既定では4列のまま、名前を付けたときだけ列が現れる", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("column-todo")).toBeVisible();
    await expect(page.getByTestId("column-custom1")).toBeHidden();

    await setLanes("素材");
    // ボードは Socket.IO で流れてくるので、リロードせずに現れる
    await expect(page.getByTestId("column-custom1")).toBeVisible();
    await expect(page.getByTestId("column-custom1")).toContainText("素材");
    // 2本目は名前を付けていないので出ない
    await expect(page.getByTestId("column-custom2")).toBeHidden();

    // 並びは Review と Done の間
    const keys = await page.locator("[data-testid^=column-]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid"))
    );
    expect(keys).toEqual(["column-todo", "column-inprogress", "column-review", "column-custom1", "column-done"]);
  });

  test("有効化していないレーンには置けない (RESTが断る)", async () => {
    const res = await fetch(`${API}/api/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "無効なレーンへ", status: "custom1" }),
    });
    // 「保存されているのにどの列にも出ない」を作らないための境界
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("custom1");
  });

  test("レーンを畳むと、そこにあったタスクはTodoへ戻る (消えない)", async () => {
    await setLanes("素材");
    const id = await createCard("素材に置いたもの", "custom1");
    expect(await getCardStatus(id)).toBe("custom1");

    await setLanes(""); // 名前を消す = 畳む
    expect(await getCardStatus(id)).toBe("todo");
  });

  // レビュー指摘 (2026-08-21): **レーンが「作業中の列」に入っていなかった。**
  // 直行は塞いであったが、**遠回りは塞がっていなかった** —
  // Reviewで検収 → レーンへ退避 → Reviewへ戻す、で古い印が生き残った。
  // #161 (ゴミ箱) と #57 (Doneからの差し戻し) と同じ穴の3回目
  test("レーンを経由しても古い検収の印は残らない (遠回りでDoneへ通せない)", async () => {
    await setLanes("素材");
    const id = await createCard("検収済みだがレーンを通ったタスク", "review");
    await fetch(`${API}/api/cards/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked: true }),
    });
    const checkedAt = async () =>
      (await mcp("query_log", { sql: `SELECT checked_at FROM cards WHERE id=${id}` })).rows[0].checked_at;
    expect(await checkedAt(), "検収の印が付いていない").toBeTruthy();

    const move = (status: string) =>
      fetch(`${API}/api/cards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    await move("custom1");
    expect(await checkedAt(), "レーンへ動かしても印が残っている").toBeFalsy();

    // 戻しても再検収なしではDoneへ行けない
    await move("review");
    await move("done");
    expect(await getCardStatus(id)).toBe("review");
  });

  // 畳む処理も updateCards を通すようにした (以前は生SQLで status だけ書き換えていた)。
  //
  // **このテストは畳む処理を単独では捕まえられない。**setChecked が Review 列でしか印を
  // 付けさせないので、印を持ったままレーンに居るカードは上の修正後は作れず、
  // 生SQLに戻してもここは通る (実測済み)。畳む側の変更は経路を1本にするための保険で、
  // ここで見ているのは**畳んで戻ってきたカードが未検収で todo に居る**という結果のほう */
  test("レーンを畳むと todo へ戻り、検収の印は付いていない", async () => {
    await setLanes("素材");
    const id = await createCard("検収済みのままレーンで畳まれたタスク", "review");
    await fetch(`${API}/api/cards/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked: true }),
    });
    await fetch(`${API}/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "custom1" }),
    });
    await setLanes(""); // 畳む → todo へ退避
    expect(await getCardStatus(id)).toBe("todo");
    const row = (await mcp("query_log", { sql: `SELECT checked_at FROM cards WHERE id=${id}` })).rows[0];
    expect(row.checked_at, "畳んで戻したカードに古い印が残っている").toBeFalsy();
  });

  test("レーンからDoneへは直接行けない (退場はreviewを通る)", async () => {
    await setLanes("素材");
    const id = await createCard("素材から直行を試す", "custom1");
    const res = await fetch(`${API}/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    // mayEnterDone は変えていないので、検収を通っていないものは弾かれる
    expect(await getCardStatus(id)).toBe("custom1");
    expect(res.status).toBeLessThan(500);
  });
});

// #228: 期限の整形がカードと詳細パネルで別々にあり、**超過の判定がカードにしか無かった**。
// 見た目の違いではなく情報量の違いなので、パネル側を固定する。
// 「1か所に置く」は types.ts の statusLabel に書いてある教訓で、期限には適用されていなかった
test("期限切れは詳細パネルでも超過として出る (#228)", async ({ page }) => {
  const id = await createCard("期限を過ぎたタスク");
  await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ due: "2020-01-01" }),
  });

  await page.goto("/");
  await expect(page.getByTestId(`task-card-${id}`)).toContainText("超過");
  await page.getByTestId(`task-card-${id}`).click();
  await expect(page.getByTestId("task-detail-panel")).toContainText("超過");
});

// #226: 経緯メモの本文は板の配信に載せていない (ペイロードの大半を占めていた)。
// **配らないことと、開いたときに読めることは別の話**なので、両方をここで固定する。
// 版が上がったら取り直す経路も見る — 配信に載るのは版だけなので、そこが切れると
// 「パネルを開きっぱなしで古い本文を読み続ける」が起きる (画面もテストも落ちない形で)
test("経緯メモは板の配信に載らないが、パネルを開くと読める (#226)", async ({ page }) => {
  const id = await createCard("経緯メモを持つタスク");
  await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: "最初に決めたこと", contextVersion: 0 }),
  });

  // 板の配信には本文が無い (代わりに「あるか・どれくらいか」と版が載る)
  const board = await (await fetch(`${API}/api/board`)).json();
  const card = board.cards.find((c: any) => c.id === id);
  expect(card.context).toBeUndefined();
  expect(card.contextChars).toBe("最初に決めたこと".length);

  // 開けば読める (アーカイブ済みカードと同じ GET /api/cards/:id を通る)
  await page.goto("/");
  await page.getByTestId(`task-card-${id}`).click();
  const panel = page.getByTestId("task-detail-panel");
  await expect(panel).toContainText("最初に決めたこと");

  // 開いたまま他所から書き換えられても、版が上がるので取り直す
  await fetch(`${API}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: "あとから足したこと", contextVersion: 1 }),
  });
  await expect(panel).toContainText("あとから足したこと");
});

// レビュー指摘 (2026-08-21): **パネルに key が無く、カードを切り替えても作り直されていなかった。**
// チャットのログ・送信中のリクエスト・入力中の下書きが前のカードのまま引き継がれ、
// 送信中に切り替えると応答が新しいカードのログに落ちる → そのまま次の発言の履歴として
// LLMへ渡り、**別のカードの経緯メモが書かれる**。
//
// LLMを呼ばずに確かめるため、**同じ持ち越しが起きる下書き**で見る。
// 直っていれば下書きは残らず、直っていなければ残る (どちらも同じ「作り直されたか」を見ている)
test("カードを切り替えるとパネルは作り直される (前のカードの状態を持ち越さない)", async ({ page }) => {
  const a = await createCard("先に開くカード");
  const b = await createCard("次に開くカード");
  await page.goto("/");

  const panel = page.getByTestId("task-detail-panel");
  await page.getByTestId(`task-card-${a}`).click();
  const input = panel.locator("textarea");
  await expect(input).toHaveAttribute("placeholder", new RegExp(`#${a}`));
  await input.fill("#Aに向けて書きかけた文");

  await page.getByTestId(`task-card-${b}`).click();
  await expect(input).toHaveAttribute("placeholder", new RegExp(`#${b}`));
  await expect(input, "前のカードの入力が持ち越されている (パネルが作り直されていない)").toHaveValue("");
});

// レビュー指摘 (2026-08-21): **能力フラグが2つあるチャット面の片方にしか届いていなかった。**
// 「まとめたつもり」と「実際に全部に届いている」がズレる形で、配線なので画面も型も落ちない。
//
// 板の配信を差し替えて「添付を受けない構成」を作る。**サーバーの環境変数を触らない**ので、
// 他のテストと同じ1台のまま確かめられる (apiStyle: messages を再現する必要もない)
test("添付を受けない板では、2つあるチャット面の両方で入口が閉じる", async ({ page }) => {
  const id = await createCard("添付の入口を確かめるカード");

  await page.route("**/api/board", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ json: { ...body, attachments: false } });
  });
  await page.goto("/");

  // 1. メインチャット
  const mainAttach = page.getByTitle(/画像\/PDFを添付/);
  await expect(mainAttach).toHaveCount(0);
  await expect(page.getByPlaceholder(/スクショやPDFも貼れます/)).toHaveCount(0);

  // 2. カード専用チャット (ここが届いていなかった側)
  await page.getByTestId(`task-card-${id}`).click();
  const panel = page.getByTestId("task-detail-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTitle(/画像\/PDFを添付/), "カード専用チャットに能力フラグが届いていない").toHaveCount(0);
});

// レビュー指摘 (2026-08-21): **📋前提の画面が開いたまま古い本文を出し続けていた。**
// この画面は編集UIを持たず、変更経路はチャット (と外部エージェント) だけ (#73) なので、
// 取得がマウント時の1回だけだと**設計上の唯一の使い方で必ず古くなる**。
// 見ている人は変わっていないと思ってもう一度依頼する。
test("前提情報を外から書き換えると、開いている📋前提の画面が追いつく (#73)", async ({ page }) => {
  const before = await mcp("get_project_context", {});
  try {
    await page.goto("/");
    await page.getByRole("button", { name: /📋 前提/ }).click();
    await expect(page.getByText(/プロジェクトの前提情報/)).toBeVisible();

    // 画面を開いたまま、外 (MCP = チャットと同じ書き込み経路) から書き換える
    const cur = await mcp("get_project_context", {});
    await mcp("update_project_context", { text: "画面を開いたまま書き換えた前提", version: cur.version });

    // 再読み込みもタブ切り替えもせずに追いつく
    await expect(page.getByText("画面を開いたまま書き換えた前提")).toBeVisible();

    // **切れている間の変更も取りこぼさない** (レビュー指摘 2026-08-21、2周目)。
    // Socket.IO は切断中のイベントを再送しないので、通知を受ける形だけだと
    // 「スリープ中に書き換えられた」が古いまま残る
  } finally {
    const now = await mcp("get_project_context", {});
    await mcp("update_project_context", { text: before.text, version: now.version });
  }
});

// **繋ぎ直しの取りこぼし。**Socket.IO は切れていた間のイベントを再送しないので、
// 通知を受けるだけでは「スリープ中に書き換えられた」が古いまま残る。
//
// setOffline も socket.io の口を塞ぐのも、テスト時間の中ではクライアントが切断に気づかず
// **ハンドラを外しても通るテスト**にしかならなかった。アプリが共有している socket を
// ブラウザ内で直に切って繋ぎ直すと、**決定的に**再現できる (レビューで教わった方法)。
//
// 前提情報の応答は page.route で差し替える。DBを触らないので後始末が要らず、
// 「切れている間に変わった」を1行で作れる
test("切断中に📋前提を開いても、繋ぎ直したときに追いつく", async ({ page }) => {
  let body = { text: "切れる前の前提", updatedAt: "2026-08-21 00:00:00" };
  await page.route("**/api/project-context", (route) => route.fulfill({ json: body }));
  const socket = (fn: "disconnect" | "connect") =>
    page.evaluate((f) => import("/src/socket.ts").then((m) => (m.socket as any)[f]()), fn);

  await page.goto("/");
  // **開く前に切る。**ここが穴だった — 画面は socket.connected=false で始まるので、
  // 「初回の connect は飛ばす」判定を持っていると、そのあとの繋ぎ直しを初回と誤認する
  await socket("disconnect");
  await page.getByRole("button", { name: /📋 前提/ }).click();
  await expect(page.getByText("切れる前の前提")).toBeVisible();

  // 切れている間に書き換わる (通知は届かない)
  body = { text: "切れている間に変わった前提", updatedAt: "2026-08-21 01:00:00" };
  await socket("connect");

  await expect(page.getByText("切れている間に変わった前提"), "繋ぎ直しても古い本文のまま").toBeVisible();
});
// レビュー指摘 (2026-08-21): **停止しても、サーバーのLLM処理は続いている。**
// 停止はクライアント側で受信を捨てるだけなので、そこで再送すると元の処理と並走し、
// **同じ操作が二重に走る** (「カードを追加して」→ 停止 → 再送 → カードが2枚)。
// 表示ではなくデータが増えるので、再送ボタンを出さないことをここで固定する。
//
// LLMは呼ばない。**チャットの往復を page.route で作る**ので、実物のサーバーには触れない
test.describe("失敗のあとに再送を出してよいか (#123 の線)", () => {
  test("停止したときは再送を出さない (サーバー側は動き続けているため)", async ({ page }) => {
    // 応答を返さないまま待たせる = 「処理中」の状態を作る
    await page.route("**/api/chat", () => new Promise(() => {}));
    await page.goto("/");

    await page.getByPlaceholder(/ボードに話しかける/).fill("カードを追加して");
    await page.keyboard.press("Enter");

    const stop = page.getByTitle(/応答の受信をやめる/);
    await expect(stop).toBeVisible();
    await stop.click();

    await expect(page.getByText(/応答の受信を停止しました/)).toBeVisible();
    await expect(page.getByRole("button", { name: /再送/ }), "停止後に再送ボタンが出ている").toHaveCount(0);
  });

  // **普通の失敗でも出さない。**1周目は「停止・タイムアウトだけ危ない」と考えて
  // ここに「普通の失敗では再送を出す」という対照を置いていたが、それが危険な境界だった
  // (レビュー指摘 2026-08-21、2周目) — ツールの往復は1ターンに何ラウンドもあり、
  // **1ラウンド目で create_cards が成功したあと2ラウンド目が失敗すると 500 が返る**。
  // クライアントからは副作用の有無を判定できないので、案内だけ出す
  test("普通の失敗でも再送は出さず、ボードを確かめるよう案内する", async ({ page }) => {
    await page.route("**/api/chat", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
    await page.goto("/");

    await page.getByPlaceholder(/ボードに話しかける/).fill("なにか話す");
    await page.keyboard.press("Enter");

    await expect(page.getByText(/途中まで実行されている場合があります/)).toBeVisible();
    await expect(page.getByRole("button", { name: /再送/ }), "副作用の有無が分からないのに再送が出ている").toHaveCount(0);
  });
});

// #232 第3弾のレビュー指摘 (2026-08-23): **AI応答の #NN をクリックして詳細が開く経路に番人が無かった。**
// linkifyMentions は `[#NN](#task-NN)` を作り、レンダラが `/^#task-(\d+)$/` で拾う。
// **この2つは対でしか意味がない**のに、識別子の一括改名でレンダラ側だけ `#card-` に変わり、
// クリックが黙って効かなくなった。既存76本は全部通ったまま素通りしている。
//
// アンカーは data-testid と同じ**契約**なので、片方だけ動かせないことをここで固定する。
// LLMは呼ばない (page.route でチャットの応答を作る)。
test("AI応答の #NN をクリックすると、そのカードの詳細が開く", async ({ page }) => {
  const id = await createCard("メンションから開くカード");
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      json: { reply: `確認先は #${id} です`, trace: [], uiActions: [], usage: { rounds: 1, elapsedMs: 1 } },
    })
  );
  await page.goto("/");

  await page.getByPlaceholder(/ボードに話しかける/).fill("どれを見ればいい");
  await page.keyboard.press("Enter");

  // 素の <a> ではなくボタンとして描かれていること自体が、レンダラが拾えている証拠
  // 発言者の吹き出しは複数あるので、AI応答の中に絞る
  await page.locator(".chat-md").last().getByRole("button", { name: `#${id}` }).click();
  await expect(page.getByTestId("task-detail-panel")).toBeVisible();
  await expect(page.getByTestId("task-detail-panel")).toContainText("メンションから開くカード");
});
