import { admin } from "./store.js";
import { log } from "./log.js";

// #108: 記録している日時は「オフセットを持たないローカル時刻」(2026-08-10 21:12:06)。
// SQLite には DateTimeOffset に相当する型が無く、日時はただの文字列なので、
// 全レコードが同じ基準であることをアプリ側が保証するしかない。
//
// そして基準を決めているのは実行環境のタイムゾーンで、これは起動時にしか効かない —
// process.env.TZ を後から書き換えると JS 側だけ変わり、SQLite の datetime('now','localtime')
// は変わらないため、同じ行の隣り合う列が8時間ずれるという最悪の形になる(実測)。
//
// 時刻生成をJS側の1関数へ寄せる案もあったが、18箇所の書き換えは提出直前には重い。
// 「直す」のではなく「壊れた状態で動かさない」を選ぶ。UTCサーバーに置くと:
//  - 記録が9時間ずれ、既存データ(JST)と混ざって後から区別できない
//  - 「今日」の境界がずれ、日本の朝9時前に終えた分が前日扱いになる
//  - LLMが書く WHERE date(created_at)=... がすべて1日ずれる

const EXPECTED = process.env.CHATBAN_TZ_OFFSET ?? "+09:00";

/** そのDBに記録される時刻のUTCオフセット。SQLite側とJS側を別々に測る */
function offsets() {
  const sqliteLocal = admin.prepare("SELECT datetime('now','localtime') v").get() as { v: string };
  const sqliteUtc = admin.prepare("SELECT datetime('now') v").get() as { v: string };
  const diffMin = Math.round(
    (Date.parse(sqliteLocal.v.replace(" ", "T") + "Z") - Date.parse(sqliteUtc.v.replace(" ", "T") + "Z")) / 60000
  );
  const js = -new Date().getTimezoneOffset();
  return { sqlite: fmt(diffMin), js: fmt(js) };
}

function fmt(min: number) {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** 起動可否の判定。合わなければ理由と直し方を出して落とす */
export function assertTimezone() {
  const { sqlite, js } = offsets();
  if (sqlite === EXPECTED && js === EXPECTED) {
    log("boot", `timezone ${EXPECTED} (SQLite/JS 一致)`);
    return;
  }
  const split = sqlite !== js;
  const msg = [
    "起動を中止しました: タイムゾーンを調整してください。",
    split
      ? `  SQLite(${sqlite}) と JS(${js}) が食い違っています。同じ行の隣の列に別基準の時刻が入るので、UTC運用より危険です`
      : `  記録される時刻が ${sqlite} です。想定は ${EXPECTED}`,
    "  日時はオフセットを持たない文字列で保存しており、基準がずれると既存データと混ざって後から区別できません。",
    "",
    "  直し方:",
    "   - Windows: TZ を設定しない (OSの設定に従わせる)。",
    "     SQLite(MSVC)は JST-9 形式、Node は Asia/Tokyo 形式しか解さないため、",
    "     両方を満たす TZ の値が存在しない (TZ=Asia/Tokyo にすると SQLite だけ +01:00 になる)。",
    "   - Linux/macOS: TZ=Asia/Tokyo を起動時に指定する (例: TZ=Asia/Tokyo npm start)。",
    "     起動後に process.env.TZ を書き換えても SQLite には効かない。",
    `   - 別のタイムゾーンで運用する場合は CHATBAN_TZ_OFFSET=${split ? js : sqlite} を指定する。`,
    "     ただし既に別基準で記録済みのDBは混ざるので、新しいDBで始めること。",
  ].join("\n");
  log("boot", msg.replace(/\n/g, " / "));
  console.error(msg);
  process.exit(1);
}
