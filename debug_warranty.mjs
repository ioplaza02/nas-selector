// 保証年数がなぜ拾えないか確認するための、その場限りのデバッグ用スクリプト（強化版）。
// nas-selector フォルダの直下に置いて実行してください。
//
//   node debug_warranty.mjs

const url = "https://www.iodata.jp/product/nas/general/hdl4-lx/index.htm";

const res = await fetch(url, {
  headers: { "User-Agent": "NasSelectorBot/1.0 (debug script)" }
});
const html = await res.text();
const text = html.replace(/<[^>]+>/g, " ");

const matches = [...text.matchAll(/標\s*準\s*保\s*証/g)];
console.log("「標準保証」の出現回数:", matches.length);

matches.forEach((m, i) => {
  console.log("\n===== " + (i + 1) + "件目（位置: " + m.index + "） =====");
  const nearby = text.slice(m.index, m.index + 800);
  const periodMatch = nearby.match(/期\s*間/);
  console.log("この後800文字以内に「期間」が見つかるか:", periodMatch ? "はい（位置 " + periodMatch.index + "）" : "いいえ");
  if (periodMatch) {
    console.log("「期間」以降30文字:", JSON.stringify(nearby.slice(periodMatch.index, periodMatch.index + 30)));
  }
  console.log("--- 周辺500文字 ---");
  console.log(nearby.slice(0, 500));
});
