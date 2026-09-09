// NASセレクターのデータを取得するスクレイパーの雛形。
//
// 使い方：
//   npm install
//   npx playwright install chromium
//   node scripts/scrape.mjs
//
// このファイルは「型」だけ用意した雛形です。実際のDOM構造・APIエンドポイントは
// ブラウザのDevTools（Networkタブ）で確認してから、TODO の箇所を埋めてください。
//
// 優先して調べるべきこと：
// 1. linux.htm / windows.htm を開き、DevTools > Network で「Fetch/XHR」だけに絞る
// 2. 絞り込み条件を1つ変えてみて、そのタイミングでJSON/APIリクエストが飛んでいないか確認
//    → もし専用のJSON APIが見つかれば、DOM解析よりそちらを叩く方が圧倒的に安定します
// 3. 見つからなければ、レンダリング後のテーブル行（<tr>など）をDOM解析する
//
// サイトへの配慮について：
// - リクエストは並列にせず、1件ずつ順番に取得する（このファイルは元からfor文で直列処理）
// - 各リクエストの間に REQUEST_INTERVAL_MS の待機を入れる
// - 専用のUser-Agentを名乗り、何のための巡回か分かるようにする
// - 本番投入前に一度 https://www.iodata.jp/robots.txt を確認し、
//   Disallow や Crawl-delay の指定があれば従う

import { chromium } from "playwright";
import fs from "node:fs/promises";

const TARGET_URLS = [
  "https://www.iodata.jp/ssp/nas/biznas/selector/linux.htm",
  "https://www.iodata.jp/ssp/nas/biznas/selector/windows.htm"
];

const OUTPUT_PATH = new URL("../data/products.json", import.meta.url);

// リクエスト間隔（ミリ秒）。月1回・数十ページ程度の取得なので、
// 急ぐ必要はない。2秒程度空けておけば十分マナーとして丁寧。
const REQUEST_INTERVAL_MS = 2000;

// 何のためのアクセスか分かるUser-Agent。
// 会社名やお問い合わせ先を含めておくと、相手側が見た時に安心材料になる。
const USER_AGENT =
  "NasSelectorBot/1.0 (+https://github.com/ioplaza02/nas-selector; " +
  "monthly price/spec check for internal comparison tool)";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeListPage(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });

  // TODO: 実際の結果テーブルが描画されるまで待つ。
  // 例）await page.waitForSelector(".result-table tbody tr");

  // TODO: 行ごとに機種名・型番・価格などを取り出す。
  // 例）
  // const rows = await page.$$eval(".result-table tbody tr", trs =>
  //   trs.map(tr => ({
  //     name: tr.querySelector(".product-name")?.textContent?.trim(),
  //     sku: tr.querySelector(".sku")?.textContent?.trim(),
  //     priceIncTax: tr.querySelector(".price")?.textContent?.trim()
  //   }))
  // );

  // ここでは雛形として空配列を返す
  return [];
}

async function scrapeProductPage(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });

  // TODO: 保証年数（3年保証／5年保証）の記載箇所を特定して取得する
  // TODO: 「店頭在庫限り」「生産終了品」のバッジ／テキストの有無を判定する
  //       例）const bodyText = await page.locator("body").innerText();
  //           const isDiscontinued = /在庫限り|生産終了/.test(bodyText);

  return {
    warrantyYears: null,
    status: "現行" // 判定できたら "生産終了" に上書きする
  };
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  const collected = [];
  for (const url of TARGET_URLS) {
    const rows = await scrapeListPage(page, url);
    collected.push(...rows);
    await sleep(REQUEST_INTERVAL_MS);
  }

  // TODO: 個別の商品ページ（保証年数・在庫状況の確認）を巡回する場合も、
  // 同じように1件ずつ処理してsleep()を挟むこと。
  // 例）
  // for (const p of collected) {
  //   const detail = await scrapeProductPage(page, p.sourceUrl);
  //   Object.assign(p, detail);
  //   await sleep(REQUEST_INTERVAL_MS);
  // }

  await browser.close();

  // TODO: collected を data/products.json のスキーマ
  //       （id / name / officeSize / install / bay / raidSupport / warrantyYears /
  //         status / features / variants[] / sourceUrl / lastCheckedAt）に整形する。
  //
  // 既存の products.json を読み込んでマージし、
  // 「価格が変わった商品」「新しく生産終了になった商品」を検出して
  // ログに出しておくと、PRのレビュー時に差分の意味が分かりやすくなります。

  const existing = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf-8"));
  const output = {
    updatedAt: new Date().toISOString(),
    products: existing.products // TODO: collected の内容で置き換える
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log("done. products:", output.products.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
