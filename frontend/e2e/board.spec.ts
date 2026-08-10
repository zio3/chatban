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

  // パネルは閉じる
  await expect(page.getByTestId("task-detail-panel")).toBeHidden();
  // 元プロジェクトのタスクは見えない (ファイルごと別なので混ざらない)
  await expect(page.getByTestId(`task-card-${inFirst}`)).toBeHidden();
  // メンバーもプロジェクト側のものに入れ替わる
  await expect(page.getByRole("button", { name: "さくら", exact: true })).toBeVisible();

  // 新プロジェクトの最初のタスクは #1
  const res = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E: 新プロジェクトの1件目" }),
  });
  expect((await res.json()).id).toBe(1);

  // 元へ戻すと元のタスクが復活する
  await page.getByTestId("project-select").selectOption("1");
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

  // 別プロジェクトに切り替えて、そちらでタスクを作っても届かない
  await fetch(`${API}/api/projects/${other}/activate`, { method: "POST" });
  await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E: room検証(別プロジェクト)" }),
  });
  await new Promise((r) => setTimeout(r, 500));
  expect(received.length).toBe(afterFirst);

  sock.close();
  await fetch(`${API}/api/projects/1/activate`, { method: "POST" }); // 後続テストのため戻す
});
