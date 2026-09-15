// スクレイピング結果の健全性チェック
//
// 「前回のdata/products.jsonの商品件数」と「今回スクレイピングした直後の
// 商品件数」を比較して、大きく減っていないか（＝スクレイパーが壊れて
// データを正しく取れていない兆候ではないか）を確認する。
//
// 問題が無ければ終了コード0（正常終了）、
// 問題があれば終了コード1（異常終了）を返す。
// ワークフロー側はこの終了コードを見て、自動反映するかPRを作るかを分岐する。

import fs from "node:fs";

const OLD_PATH = "data/products.previous.json";
const NEW_PATH = "data/products.json";

// 「前回より何割減ったら異常とみなすか」の閾値。まずは1割に設定。
// 運用してみて厳しすぎる/緩すぎると感じたらここを調整してください。
const DROP_THRESHOLD = 0.1;

function loadProductCount(path) {
  if (!fs.existsSync(path)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(path, "utf8"));
    return Array.isArray(json.products) ? json.products.length : null;
  } catch (e) {
    return null;
  }
}

const oldCount = loadProductCount(OLD_PATH);
const newCount = loadProductCount(NEW_PATH);

console.log(`前回の商品件数: ${oldCount ?? "不明（初回実行など）"}`);
console.log(`今回の商品件数: ${newCount ?? "不明（読み込み失敗）"}`);

// 新しいデータが空、または壊れていて読めない場合は問答無用で異常
if (newCount === null || newCount === 0) {
  console.error("異常あり: 新しいデータが空か、正しく読み込めませんでした。");
  process.exit(1);
}

// 前回データと比較できる場合は、減少率をチェック
if (oldCount !== null && oldCount > 0) {
  const dropRatio = (oldCount - newCount) / oldCount;
  if (dropRatio > DROP_THRESHOLD) {
    console.error(
      `異常あり: 商品件数が前回より${Math.round(dropRatio * 100)}%減少しています` +
      `（${oldCount}件 → ${newCount}件）。スクレイパーが壊れている可能性があります。`
    );
    process.exit(1);
  }
}

console.log("健全性チェック: 問題ありませんでした。");
process.exit(0);
