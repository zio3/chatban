import assert from "node:assert/strict";
import { test } from "node:test";
import { isTaskStatus, isUsableStatus, isWorkStatus, TASK_STATUSES } from "./db.js";
import { agentStatusValues, reorderableStatuses, statusDescription, STATUS_DESCRIPTION } from "./chat.js";
import type { CustomLane, TaskStatus } from "./types.js";

// #19: 任意レーン。**判定はどれも純粋関数**にしてあるので、DBもexpressも要らない
// (isTaskStatus / mayEnterDone / isDueDate と同じ置き方)。

const 素材: CustomLane = { key: "custom1", label: "素材" };
const 保留: CustomLane = { key: "custom2", label: "保留" };

test("custom1 / custom2 は値としては実在する", () => {
  for (const s of ["todo", "inprogress", "review", "custom1", "custom2", "done"]) {
    assert.equal(isTaskStatus(s), true, s);
  }
  assert.equal(isTaskStatus("custom3"), false);
  assert.equal(isTaskStatus("custom"), false);
});

// ここが #19 の肝。列を描かないのに保存だけ通ると、カードが「消えたように見えて実在する」
test("有効化していないレーンには置けない", () => {
  assert.equal(isUsableStatus("custom1", []), false);
  assert.equal(isUsableStatus("custom2", []), false);
  // 1本だけ有効なとき、もう片方は依然として置けない
  assert.equal(isUsableStatus("custom1", [素材]), true);
  assert.equal(isUsableStatus("custom2", [素材]), false);
});

test("固定4列はレーンの有無に関係なく置ける", () => {
  for (const lanes of [[], [素材], [素材, 保留]]) {
    for (const s of ["todo", "inprogress", "review", "done"]) {
      assert.equal(isUsableStatus(s, lanes), true, `${s} / lanes=${lanes.length}`);
    }
  }
});

test("未知の値はレーンを有効にしても通らない", () => {
  assert.equal(isUsableStatus("banana", [素材, 保留]), false);
  assert.equal(isUsableStatus("", [素材]), false);
  assert.equal(isUsableStatus(undefined, [素材]), false);
  assert.equal(isUsableStatus(null, [素材]), false);
  assert.equal(isUsableStatus(3, [素材]), false);
});

// 契約側。「選べないものは選ばれない」— done を enum から外したのと同じ形で、
// 無効なレーンはそもそもエージェントに見せない
test("ツール契約に出るのは有効なレーンだけ", () => {
  assert.deepEqual(agentStatusValues([]), ["todo", "inprogress", "review"]);
  assert.deepEqual(agentStatusValues([素材]), ["todo", "inprogress", "review", "custom1"]);
  assert.deepEqual(agentStatusValues([素材, 保留]), ["todo", "inprogress", "review", "custom1", "custom2"]);
  // done はどの組み合わせでも出ない (人間の検収だけが通す扉)
  for (const lanes of [[], [素材], [素材, 保留]]) {
    assert.equal(agentStatusValues(lanes).includes("done"), false);
  }
});

test("並べ替えの対象にも同じレーンが出る", () => {
  assert.deepEqual(reorderableStatuses([素材]), ["todo", "inprogress", "review", "custom1"]);
});

// **表示名は必須**にしてあるので、custom1 が「説明の無い文字列欄」(#92) になることはない。
// 人が前提情報を書くのを待たず、対応だけは自動で契約に載せる
test("レーンの表示名が契約の説明に入る", () => {
  assert.equal(statusDescription([]), STATUS_DESCRIPTION, "0本なら文言は元のまま (無駄な差分を出さない)");
  const d = statusDescription([素材, 保留]);
  assert.ok(d.startsWith(STATUS_DESCRIPTION), "元の説明を落とさない");
  assert.ok(d.includes("custom1 = 「素材」"), d);
  assert.ok(d.includes("custom2 = 「保留」"), d);
});

test("列の並びは Review と Done の間で固定", () => {
  // TASK_STATUSES の順序がそのままボードの列順の根拠になっている
  assert.deepEqual([...TASK_STATUSES], ["todo", "inprogress", "review", "custom1", "custom2", "done"]);
});

// レビュー指摘 (2026-08-21): **任意レーンが「作業中」に入っていなかった。**
// Reviewで検収 → レーンへ退避 → Reviewへ戻す、の3手で古い印が生き残り、
// 確認し直さずにDoneへ通せた。#161 (ゴミ箱) と #57 (Doneからの差し戻し) で
// 同じ穴を2回塞いでいるのに、レーンだけ取り残されていた
test("任意レーンも作業中の列 (検収の印を落とす側)", () => {
  for (const s of ["todo", "inprogress", "custom1", "custom2"] as TaskStatus[]) {
    assert.equal(isWorkStatus(s), true, `${s} は作業中の列`);
  }
  // review は含めない。検収待ちの列で印を付けてから一括確定するので、印は進捗そのもの
  assert.equal(isWorkStatus("review"), false);
  // done から出るときの扱いは別に見ている (leavingDone)
  assert.equal(isWorkStatus("done"), false);
});

// **列を足したら「作業中とは何か」も更新する。**今回の穴はそこを忘れて開いた。
// 値の一覧と判定が別々に伸びると、次に列が増えたときに同じことが起きる
test("すべての列が作業中かレビュー/完了のどちらかに分類されている", () => {
  const unclassified = TASK_STATUSES.filter((s) => !isWorkStatus(s) && s !== "review" && s !== "done");
  assert.deepEqual(unclassified, [], `分類されていない列がある: ${unclassified.join(", ")}`);
});
