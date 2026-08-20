import { randomUUID } from "node:crypto";
import { getProjectContextRow, listTasks } from "./db.js";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";

// #150/#187: MCP経由のエージェント向けに「ボードの写し + 同期トークン」を配る。
//
// 直したい事故はこれ: エージェントは自分が最後に読んだ一覧を現在の状態だと思い込み、
// 食い違うとボードのほうを疑う。実際 2026-08-15 に「live_cards に review が出ないバグがある」と
// 誤報告した (人間が9件を検収して done+archived にしていただけで、ビューは正しかった)。
// 人間はUIで視覚的に上書きされるが、**LLMのコンテキストは追記型で上書きが無い**。
//
// 設計は promptState.ts (#50) と同じ「スナップショットを2つ比べる」方式で、変更ログは持たない。
// 書き込み経路にフックを刺さずに済み、追加・変更に加えて**消滅**も同じ計算で拾える
// (「畳まれてボードから消えた」は updated_at では絶対に拾えない — 畳み込みは archived を
//  立てるだけで updated_at を動かさないため。#200 で要約カードは撤去したが、この事情は同じ)。
//
// promptState と分けているのは用途が違うため: あちらはプロンプトのプレフィックスをバイト単位で
// 安定させるための表示テキスト、こちらはMCPの応答に載せる「何がどう変わったか」。

/** 同期トークンが有効な上限時間。これを過ぎたスナップショットは捨て、全件返しにフォールバックする */
const TTL_MS = 60 * 60 * 1000;
/** 1プロジェクトあたりの保持数。**暴走を止める安全弁で、通常の失効はTTLが担う。**
 *
 * 元は32だった。「エージェントが何本繋がっていても1本1個なら足りる」という同時接続数のつもりの値だが、
 * 実際は書き込み応答にも差分を同梱する (boardDelta が毎回 takeSnapshot する) ので、
 * **消費されるのは呼び出し1回につき1個**。33回書いた時点で、まだ数分しか経っていないトークンが
 * 静かに失効していた。失効はエラーにならず全件応答に落ちるだけなので、起きても気づけない —
 * 差分で100文字だったものが全件で2万文字に戻るという、この機能の意義だけが削れる形。
 *
 * 単位を取り違えていた上限なので、値を調整するのではなく**当たらない大きさ**に置く。
 * 持っているのは TaskFacts だけ (context本文は版番号のみ) なので1個は軽く、
 * 60分ぶん溜めてもメモリは問題にならない。60分で512回の呼び出しは実運用では起きない
 * (1回がLLMの往復に対応する) し、仮に当たっても古いものが落ちるだけで壊れない */
const MAX_SNAPSHOTS = 512;
/** 差分がこれを超えたら、差分を読ませるより全件を渡したほうが速い (promptState の MAX_EVENTS と同じ考え) */
const MAX_CHANGES = 40;

/** 差分に出す分だけを持つ。context本文のような重いものは持たない (版だけ見る) */
export interface TaskFacts {
  title: string;
  status: string;
  summary: string | null;
  due: string | null;
  blockedBy: number[] | null;
  rejected: boolean;
  contextVersion: number;
  /** 人が実物で確かめた日時。**この機能が拾いたいものの本体。**
   * 2026-08-15 の事故は「人間が検収したことをエージェントが知らなかった」ために起きた。
   * setChecked は updated_at を動かさないので、タイムスタンプ方式では二重に拾えない (自動レビュー指摘) */
  checkedAt: string | null;
  /** 並び順。reorder_cards で動く。1件動かすと周りも連動して変わるので、差分では1行にまとめる */
  sort: number;
}

export interface BoardSnapshot {
  syncToken: string;
  takenAt: number;
  cards: Map<number, TaskFacts>;
  /** 前提情報は**本文を持たない (#187)**。応答に載せるのも版だけで、
   * 中身が要るなら get_project_context を呼ばせる。
   * 3,000字級の本文がボードを取るたびに乗るのを止めるのが目的 (#186 と同じ問題) */
  projectContextVersion: number;
}

// 同期トークンの時刻部分。読んで「いつのものか」が分かるようにするためのもので、
// backend/logs と突き合わせられると失効の調査が早い
function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `T${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/** プロセス起動ごとに変わる符丁。**衝突を防いでいるのはこれで、時刻ではない。**
 *
 * 連番はプロセス起動ごとに0へ戻るので、これが無いと「同じ秒に旧プロセスと新プロセスが
 * それぞれ最初のスナップショットを作る」だけで**まったく同じトークン**になる。
 * 旧トークンを持ったクライアントが新プロセスのスナップショットに誤ヒットし、
 * 再起動をまたいだ変化を既読扱いして空差分が返る — 差分機能が黙って嘘をつく一番悪い形。
 *
 * 秒を細かくしても (ミリ秒にしても) 理論上の衝突は残るので、時刻の精度ではなく符丁で断つ。
 * 一度これを消して時刻だけにし、自動レビューに指摘されて戻している。
 *
 * Math.random() ではなく暗号乱数を使う。**衝突したときの症状が「空差分」で、
 * エラーにならないぶん検知が絶望的**なので、識別子の質をケチる場所ではない (自動レビュー指摘) */
const RUN = randomUUID().slice(0, 8);

/** 同期トークンの組み立て。**符丁を引数で受ける形にしてあるのはテストのため** —
 * 「同じ秒・同じ連番でも、プロセスが違えば別のトークンになる」を、
 * 実際にプロセスを立て直さずに固定できる */
export function makeSyncToken(projectId: number, at: Date, run: string, seq: number): string {
  return `p${projectId}-${stamp(at)}-${run}${seq}`;
}

let counter = 0;

const snapshots = new Map<number, BoardSnapshot[]>();

/** いまのボードを写し取る。DBに触るのはここだけで、差分計算(diffBoards)は純粋関数にしてある */
export function captureBoard(): Omit<BoardSnapshot, "syncToken" | "takenAt"> {
  const cards = new Map<number, TaskFacts>(
    listTasks().map((t) => [
      t.id,
      {
        title: t.title,
        status: t.status,
        summary: t.summary ?? null,
        due: t.due,
        blockedBy: t.blockedBy,
        rejected: t.rejected,
        contextVersion: t.contextVersion,
        checkedAt: t.checkedAt ?? null,
        sort: t.sort,
      },
    ])
  );
  return { cards, projectContextVersion: getProjectContextRow().version };
}

/** 列ごとの「並んでいるIDの列」。sort の数値ではなくこの並びを比べる。
 * only を渡すと、そこに含まれるIDだけで並びを作る (追加・消滅による見かけの変化を除くため)。
 * sort が同値のときは id で決める — 実データは listTasks の ORDER BY sort, id 順で入るので、
 * 比較関数にも同じ規則を書いておく (暗黙の安定性に寄りかからない) */
function columnLists(cards: Map<number, TaskFacts>, only?: Set<number>): Map<string, number[]> {
  const byStatus = new Map<string, { id: number; sort: number }[]>();
  for (const [id, t] of cards) {
    if (only && !only.has(id)) continue;
    const list = byStatus.get(t.status) ?? [];
    list.push({ id, sort: t.sort });
    byStatus.set(t.status, list);
  }
  const out = new Map<string, number[]>();
  for (const [status, list] of byStatus) {
    out.set(
      status,
      list.sort((a, b) => a.sort - b.sort || a.id - b.id).map((x) => x.id)
    );
  }
  return out;
}

function columnOrders(cards: Map<number, TaskFacts>, only?: Set<number>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [status, ids] of columnLists(cards, only)) out.set(status, ids.map((id) => `#${id}`).join(","));
  return out;
}

/** 列の中でそのカードがどこに居るか。**追加行にこれが要る** —
 * ゴミ箱からの復元は sort を保ったまま戻るので列の途中に入りうるが、
 * 「追加」は並び順の判定 (居続けたIDの比較) から外れるため、ここで言わないと位置が分からない (自動レビュー指摘) */
function positionIn(lists: Map<string, number[]>, status: string, id: number): string {
  const ids = lists.get(status) ?? [];
  const at = ids.indexOf(id);
  if (at < 0 || ids.length <= 1) return `${status} の先頭`;
  if (at === 0) return `${status} の先頭 (次が #${ids[1]})`;
  if (at === ids.length - 1) return `${status} の末尾 (前が #${ids[at - 1]})`;
  return `${status} の #${ids[at - 1]} と #${ids[at + 1]} の間`;
}

function sameDeps(a: number[] | null, b: number[] | null): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 1件のカードについて、変わったフィールドだけを "status: todo -> inprogress" の形で並べる */
function fieldChanges(prev: TaskFacts, cur: TaskFacts): string[] {
  const out: string[] = [];
  if (prev.status !== cur.status) out.push(`status: ${prev.status} -> ${cur.status}`);
  if (prev.title !== cur.title) out.push(`title: 「${prev.title}」-> 「${cur.title}」`);
  if (prev.rejected !== cur.rejected) out.push(cur.rejected ? "却下された" : "却下を取り消した");
  if (prev.due !== cur.due) out.push(`期限: ${prev.due ?? "なし"} -> ${cur.due ?? "なし"}`);
  if (!sameDeps(prev.blockedBy, cur.blockedBy))
    out.push(`依存: [${(prev.blockedBy ?? []).join(",")}] -> [${(cur.blockedBy ?? []).join(",")}]`);
  if (prev.summary !== cur.summary) out.push(`現況: ${cur.summary ?? "(消去)"}`);
  if (prev.checkedAt !== cur.checkedAt)
    out.push(cur.checkedAt ? `人が検収の印を付けた (${cur.checkedAt})` : "検収の印が外れた");
  // 経緯メモは本文を載せると差分が膨らむので、変わったことだけ伝えて中身は取りに行かせる
  if (prev.contextVersion !== cur.contextVersion) out.push(`経緯メモが更新された (v${cur.contextVersion})`);
  return out;
}

/**
 * 2つのスナップショットの差分を、LLMがそのまま読める1行の並びで返す。
 *
 * **各行はそれ単体で現在が確定する形にしてある。** LLMのコンテキストは追記型なので、
 * 古い一覧が残ったまま差分を渡されると自力でマージを迫られる。IDだけを指す差分にしない。
 */
export function diffBoards(
  prev: Pick<BoardSnapshot, "cards" | "projectContextVersion">,
  cur: Pick<BoardSnapshot, "cards" | "projectContextVersion">
): string[] {
  const changes: string[] = [];
  const curLists = columnLists(cur.cards);

  for (const [id, t] of cur.cards) {
    const before = prev.cards.get(id);
    if (!before) {
      // 追加はIDだけでは何か分からないので内容ごと載せる。
      // **検収済みかどうかもここに要る** — 検収済みのカードが「追加」として現れる経路があり
      // (fieldChanges を通らないので検収状態が抜け落ちる。自動レビュー指摘)。
      // #161 以降、ゴミ箱からの復元は checked_at を落とすのでこの例からは外れたが、
      // スナップショット失効後の再ベースラインなどでは依然として起きる
      const marks = [
        positionIn(curLists, t.status, id),
        ...(t.due ? [`期限 ${t.due}`] : []),
        ...(t.rejected ? ["却下"] : []),
        ...(t.checkedAt ? ["検収済み"] : []),
      ];
      changes.push(`+ #${id}「${t.title}」が追加された (${marks.join(", ")})`);
      continue;
    }
    const fields = fieldChanges(before, t);
    if (fields.length > 0) changes.push(`~ #${id}「${t.title}」 ${fields.join(" / ")}`);
  }

  for (const [id, t] of prev.cards) {
    if (!cur.cards.has(id)) {
      // 完了アーカイブ・要約への畳み込み・削除はどれもここに落ちる。
      // どれだったかはボードから消えた事実ほど重要ではないので、まとめて1つの表現にする
      changes.push(`- #${id}「${t.title}」がボードから消えた (完了アーカイブ・要約への統合・削除のいずれか)`);
    }
  }

  // **見るのは sort の数値ではなく、列に並んだIDの順そのもの。**
  // 数値で比べると両側に穴があった (自動レビュー指摘):
  //   - 列をまたいで動かすと sort が変わらないことがある (UIは移動先の先頭要素の sort-1 を振るので、
  //     0 の前に入れると 0 のまま)。数値が同じなので「並びが変わった」を出せない
  //   - 逆に sort を 0,1 -> 5,9 に振り直しただけで、見た目の順が同じでも「変わった」と出る
  //
  // 判定に使うのは**その列に居続けたIDの相対順序**。全IDで比べると、1件足すたび・
  // 1件動かすたびに「並び順が変わった」が付いてくる (出入りは + / - / status の行がもう伝えている)。
  // ただし列を移ってきたものは、**どこに入ったか**が status の行では分からないので、
  // 並びが2件以上ある列に限って現在順を出す
  const stayed = new Set(
    [...cur.cards.entries()].filter(([id, t]) => prev.cards.get(id)?.status === t.status).map(([id]) => id)
  );
  const prevOrder = columnOrders(prev.cards, stayed);
  const curOrder = columnOrders(cur.cards, stayed);
  const arrived = new Set(
    [...cur.cards.entries()]
      .filter(([id, t]) => {
        const p = prev.cards.get(id);
        return p !== undefined && p.status !== t.status;
      })
      .map(([, t]) => t.status)
  );
  const shown = columnOrders(cur.cards);
  const countIn = (status: string) => (shown.get(status) ? shown.get(status)!.split(",").length : 0);
  const movedColumns = [...new Set([...prevOrder.keys(), ...curOrder.keys(), ...arrived])].filter((status) =>
    prevOrder.get(status) !== curOrder.get(status) ? true : arrived.has(status) && countIn(status) > 1
  );
  if (movedColumns.length > 0) {
    // 出すのは**全部入りの現在順**。判定から外した新入りも、いま何番目に居るかは知りたい
    const lines = movedColumns.map((status) => `${status}: ${shown.get(status) || "(空)"}`);
    changes.push(`並び順が変わった。現在の順は ${lines.join(" / ")}`);
  }


  // 版で比べる。本文を持っていないので中身の差は出せないが、そもそも出すつもりが無い
  // (差分に3,000字が乗る)。「変わった」とだけ言って get_project_context を呼ばせる
  if (prev.projectContextVersion !== cur.projectContextVersion)
    changes.push(`プロジェクトの前提情報が更新された (v${cur.projectContextVersion})`);

  return changes;
}

/** いまのボードを写し取り、同期トークンを払い出して保持する */
export function takeSnapshot(): BoardSnapshot {
  const projectId = currentProjectId();
  const now = Date.now();
  const snap: BoardSnapshot = {
    syncToken: makeSyncToken(projectId, new Date(now), RUN, ++counter),
    takenAt: now,
    ...captureBoard(),
  };
  const list = snapshots.get(projectId) ?? [];
  list.push(snap);
  // TTL切れを捨てる。失効は正常系なので、消えたこと自体は問題にならない。
  // 件数のほうは安全弁で、実際に効くのはTTL (MAX_SNAPSHOTS のコメントを見る)
  const alive = list.filter((s) => Date.now() - s.takenAt <= TTL_MS).slice(-MAX_SNAPSHOTS);
  snapshots.set(projectId, alive);
  return snap;
}

/** 同期トークンからスナップショットを引く。無ければ null (呼び出し側は全件返しにフォールバックする) */
export function findSnapshot(syncToken: string): BoardSnapshot | null {
  const list = snapshots.get(currentProjectId()) ?? [];
  const found = list.find((s) => s.syncToken === syncToken);
  if (!found) return null;
  if (Date.now() - found.takenAt > TTL_MS) return null;
  return found;
}

/** テスト用。プロセス内に溜まったスナップショットを捨てる */
export function resetSnapshots(): void {
  snapshots.clear();
}

export interface BoardDelta {
  syncToken: string;
  /** 差分を返したときだけ入る。**どの時点からの差分か** (呼び出し側が渡してきたトークン)。
   * 名前を since のままにしない — 応答に出る語は、エージェントにとって次に使う語の見本になる。
   * 引数が sync_token になったのに応答で since と呼ぶと、旧契約を再提示することになる (自動レビュー指摘) */
  fromSyncToken?: string;
  changes?: string[];
  full?: boolean;
  note?: string;
  /** 前提情報の版。**全件でも差分でも必ず載せる (#187)** —
   * 本文を返さなくなったぶん、「自分が読んだときから変わっていないか」を
   * これ1つで確かめられるようにしておく */
  projectContextVersion: number;
}

/**
 * MCPの応答に載せるボード状況を組み立てる。
 *
 * - 同期トークンが無い / メモリに無い / 失効している → **全件を返す** (エラーにしない)。
 *   失効は正常系で、エラーを返すとLLMがリトライを考え始める
 * - 見つかれば、そこからの差分だけ返す
 * - 差分が MAX_CHANGES を超えたら、読ませる負担が上回るので全件に切り替える
 */
/**
 * 書き込み応答に混ぜるボード部分を組み立てる。**boardDelta と分けてあるのはテストのため** —
 * ここはDBに触らない純粋関数なので、キーの取り違えを単体で固定できる。
 *
 * note ではなく boardNote を使うのが肝。書き込み側が返す note (「#9999 は存在しません。
 * 古い一覧を見ている可能性があります」等の**警告**) と同じキーにすると、spread の順で警告が消える。
 */
export function formatBoardUpdate(d: BoardDelta, syncToken?: string): Record<string, unknown> {
  if (!d.full)
    return {
      syncToken: d.syncToken,
      projectContextVersion: d.projectContextVersion,
      ...(d.changes?.length ? { boardChanges: d.changes } : {}),
    };
  if (!syncToken) return { syncToken: d.syncToken, projectContextVersion: d.projectContextVersion };
  // 差分を返せなかったとき、**新しい同期トークンを渡さない。**
  // 渡すとエージェントはそれを次の sync_token に使い、「変化なし」が返って
  // 全件を一度も見ないまま古い認識のまま進む
  return {
    boardNote: `${d.note ?? "差分を返せなかった"}。sync_token を付けずに sync_board を呼び、全体を取り直すこと`,
  };
}

export function boardDelta(syncToken?: string): BoardDelta {
  const snap = takeSnapshot();
  const base = syncToken ? findSnapshot(syncToken) : null;
  const head = { syncToken: snap.syncToken, projectContextVersion: snap.projectContextVersion };

  if (!syncToken) return { ...head, full: true };
  if (!base) {
    return {
      ...head,
      full: true,
      note: `同期トークン ${syncToken} は保持期間(60分)を過ぎたか、このプロジェクトのものではないため、最新の全件を返した`,
    };
  }

  const changes = diffBoards(base, snap);
  if (changes.length > MAX_CHANGES) {
    log("board", `diff ${syncToken} -> ${snap.syncToken}: ${changes.length}件で上限超過、全件に切り替え`);
    return {
      ...head,
      full: true,
      note: `前回から${changes.length}件変わっており差分が大きいため、最新の全件を返した`,
    };
  }
  return { ...head, fromSyncToken: syncToken, changes };
}
