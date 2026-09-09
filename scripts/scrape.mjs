// NASセレクターのデータを取得するスクレイパー。
//
// 使い方：
//   node scripts/scrape.mjs
//
// Playwrightは使わない。理由：
// linux.htm / windows.htm の絞り込み結果は、ページ読み込み時に一度だけ
// search_linux.js / search_windows.js という静的JSファイルを読み込み、
// あとはブラウザ内のJavaScriptだけで絞り込み処理をしている
// （絞り込み操作をしてもサーバーへの追加リクエストが発生しない）。
// そのため、このJSファイルを直接fetchするだけで全件のスペックデータが手に入る。
//
// 商品ページ（link_url）側は通常のサーバーレンダリングされたHTMLなので、
// これもfetchだけで読める。保証年数・在庫状況・対応機能は、
// ページ本文のテキストを正規表現で走査して拾う。

import fs from "node:fs/promises";

const LIST_URLS = [
  "https://www.iodata.jp/ssp/nas/biznas/selector/search_linux.js",
  // TODO: Windows版が同じ命名規則か確認する
  // "https://www.iodata.jp/ssp/nas/biznas/selector/search_windows.js"
];

const OUTPUT_PATH = new URL("../data/products.json", import.meta.url);
const REQUEST_INTERVAL_MS = 2000;

const USER_AGENT =
  "NasSelectorBot/1.0 (+https://github.com/ioplaza02/nas-selector; " +
  "monthly price/spec check for internal comparison tool)";

// 商品ページ本文から拾いたい機能キーワード。
// 見出しバッジの文言と完全一致していなくても、テキスト中に含まれていればヒットとする。
const FEATURE_KEYWORDS = [
  "RAIDeX", "10GbE", "NAS専用HDD", "データ復旧サービス", "UPS対応",
  "リモートアクセス", "クラウドストレージ連携", "NarSuS", "NarSuSクラウドバックアップ",
  "ワンタッチセキュア", "多要素認証", "ログインロックアウト", "Time Machine", "暗号ボリューム"
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.text();
}

// "var json = [ ... ];" 形式のJSファイルから配列部分だけ取り出してparseする。
// 「ファイル内最後の ] まで」ではなく、[ と ] の対応を1文字ずつ数えて
// 本当に配列が終わる位置を特定する（文字列リテラル内の [ ] は無視する）。
function extractJsonArrayText(text) {
  const anchor = text.indexOf("var json");
  if (anchor === -1) throw new Error("var json が見つかりませんでした");

  const start = text.indexOf("[", anchor);
  if (start === -1) throw new Error("配列の開始 [ が見つかりませんでした");

  let depth = 0;
  let inString = false;
  let quoteChar = null;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quoteChar) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("配列の閉じ ] が見つかりませんでした（対応が取れていません）");
}

function parseSearchJs(text) {
  const arrayText = extractJsonArrayText(text)
    // JSでは許容される「配列・オブジェクト末尾の余計なカンマ」はJSON.parseがエラーになるので除去する
    .replace(/,(\s*[\]}])/g, "$1");
  return JSON.parse(arrayText);
}

// "○(120TB)" のような文字列から対応/実効容量を読み取る
function parseRaidCell(cell) {
  if (!cell || cell === "-") return null;
  const m = cell.match(/\(([\d.]+TB)\)/);
  return { supported: true, effectiveCapacity: m ? m[1] : null };
}

function officeSizeCode(code) {
  // TODO: 実際の値のバリエーション（小/中/大 以外があるか）を確認する
  return { "小": "小規模", "中": "中規模", "大": "大規模" }[code] || code;
}

function installType(code) {
  // TODO: ラックマウント型の実際のコード値を確認する（"RACK"などを想定）
  return code === "BOX" ? "BOXタイプ" : code === "RACK" ? "ラックマウントタイプ" : code;
}

function raidSupportList(entry) {
  const list = [];
  if (parseRaidCell(entry.expand)) list.push("RAIDeX");
  if (parseRaidCell(entry.raid0)) list.push("RAID 0");
  if (parseRaidCell(entry.raid1)) list.push("RAID 1");
  if (parseRaidCell(entry.raid5)) list.push("RAID 5");
  if (parseRaidCell(entry.raid6)) list.push("RAID 6");
  return list;
}

async function fetchProductDetail(url) {
  const html = await fetchText(url);
  // ざっくりテキスト化（正確なDOM解析はせず、本文全体を対象に正規表現で拾う）
  const text = html.replace(/<[^>]+>/g, " ");

  let warrantyYears = null;
  if (/5\s*年保証/.test(text)) warrantyYears = 5;
  else if (/3\s*年保証/.test(text)) warrantyYears = 3;
  // TODO: 1年保証のパターンが実際に存在するか確認する

  // TODO: 実際のページで「生産終了」「店頭在庫限り」がどう表示されるか
  // （本文テキストか、alt属性付きの画像バッジか）を確認して精度を上げる
  const isDiscontinued = /生産終了|店頭在庫限り|在庫限り/.test(text);

  // 【大規模オフィス～128人】のような見出しラベルをそのまま拾う
  const officeLabelMatch = text.match(/【([^】]+オフィス[^】]*)】/);

  const features = FEATURE_KEYWORDS.filter(kw => text.includes(kw));

  return {
    warrantyYears,
    status: isDiscontinued ? "生産終了" : "現行",
    officeSizeLabel: officeLabelMatch ? officeLabelMatch[1] : null,
    features
  };
}

async function main() {
  const rawEntries = [];
  for (const url of LIST_URLS) {
    const text = await fetchText(url);
    rawEntries.push(...parseSearchJs(text));
    await sleep(REQUEST_INTERVAL_MS);
  }

  // link_url が同じもの＝同一機種の容量バリエーションとしてグループ化
  const groups = new Map();
  for (const e of rawEntries) {
    if (!groups.has(e.link_url)) groups.set(e.link_url, []);
    groups.get(e.link_url).push(e);
  }

  const products = [];
  for (const [linkUrl, entries] of groups) {
    const base = entries[0];

    const detail = await fetchProductDetail(linkUrl);
    await sleep(REQUEST_INTERVAL_MS);

    products.push({
      id: base.name.replace(/\d+$/, "").toLowerCase(),
      name: base.series + "（" + base.name.replace(/\d+$/, "") + "シリーズ）",
      series: base.series,
      os: "Linux OS", // TODO: Windows版を追加する時はここを出し分ける
      install: installType(base.type),
      bay: base.drive + "ベイ",
      officeSize: detail.officeSizeLabel || officeSizeCode(base.office),
      raidSupport: raidSupportList(base),
      warrantyYears: detail.warrantyYears,
      status: detail.status,
      features: detail.features,
      variants: entries.map(e => ({
        sku: e.name,
        capacityTB: Number(String(e.capacity).replace("TB", "")),
        priceIncTax: e.price,
        jan: String(e.jan)
      })),
      sourceUrl: linkUrl,
      lastCheckedAt: new Date().toISOString()
    });
  }

  const output = {
    updatedAt: new Date().toISOString(),
    products
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log("done. products:", products.length, "/ raw entries:", rawEntries.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
