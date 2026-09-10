// 保証年数がなぜ拾えないか確認するための、その場限りのデバッグ用スクリプト。
// nas-selector フォルダの直下に置いて実行してください。
//
//   node debug_warranty.mjs

const url = "https://www.iodata.jp/product/nas/general/hdl4-lx/index.htm";

const res = await fetch(url, {
  headers: { "User-Agent": "NasSelectorBot/1.0 (debug script)" }
});
const html = await res.text();
const text = html.replace(/<[^>]+>/g, " ");

const idx = text.indexOf("標準保証");
console.log("単純一致(標準保証)の位置:", idx);

const looseMatch = text.match(/標\s*準\s*保\s*証/);
console.log("緩い一致の結果:", looseMatch ? looseMatch[0] : "見つからず", looseMatch ? looseMatch.index : "");

const dataIdx = text.indexOf("データ復旧サービス付き");
console.log("「データ復旧サービス付き」の位置:", dataIdx);

if (dataIdx !== -1) {
  console.log("---その周辺のテキスト(前後200文字)---");
  console.log(text.slice(dataIdx, dataIdx + 600));
}
