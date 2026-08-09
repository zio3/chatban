import { expect, test, type Page } from "@playwright/test";

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
