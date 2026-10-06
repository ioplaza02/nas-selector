// NASセレクターのデータを取得するスクレイパー。
//
// 使い方：
//   node scripts/scrape.mjs
//
// データソースは2つ：
// 1. search_linux.js … 容量・価格・JAN・RAID対応・推奨接続台数など、
//    商品ごとの詳細スペック（107レコード、link_url単位でグループ化）
// 2. https://www.iodata.jp/product/nas/general/（と wss-nas / appliance）
//    … 商品カテゴリー一覧ページ。型番ごとに「店頭在庫限り」「生産終了」の
//    アイコンが付いており、在庫状況の判定はこちらの方が正確。
//    「【中規模オフィス～64人】」のような人数付きラベルもここにある。
//
// 保証年数・対応機能は、各商品ページ本文＋spec.htmのテキストを
// 正規表現で走査して拾う（DOM構造への依存を避けるため）。

import fs from "node:fs/promises";

const LIST_URLS = [
  { url: "https://www.iodata.jp/ssp/nas/biznas/selector/search_linux.js", os: "Linux OS" },
  { url: "https://www.iodata.jp/ssp/nas/biznas/selector/search_windows.js", os: "Windows OS" }
];

// 在庫状況・人数ラベルの参照元。複数カテゴリーにまたがっているため全部見る。
const CATALOG_PAGE_URLS = [
  "https://www.iodata.jp/product/nas/general/",
  "https://www.iodata.jp/product/nas/wss-nas/",
  "https://www.iodata.jp/product/nas/appliance/"
];

// バックアップ用HDD対応表（型番ごとに、どの区分の表に載っているかをここから自動判定する）
const HDD_COMPAT_URL = "https://www.iodata.jp/pio/io/nas/landisk/hdd.htm";
const HDD_COMPAT_ANCHORS = [
  "linux-h1", "linux-h2", "linux-e1", "linux-e2",
  "windows2025", "windows2022", "windows2019", "cons"
];

// クラウドストレージ対応表（テレワーク・データ共有用途／災害対策BCP用途を型番ごとに判定する）
const CLOUD_COMPAT_URL = "https://www.iodata.jp/pio/io/nas/landisk/cloud.htm";

const OUTPUT_PATH = new URL("../data/products.json", import.meta.url);
const REQUEST_INTERVAL_MS = 2000;

const USER_AGENT =
  "NasSelectorBot/1.0 (+https://github.com/ioplaza02/nas-selector; " +
  "monthly price/spec check for internal comparison tool)";

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
// [ と ] の対応を1文字ずつ数えて、本当に配列が終わる位置を特定する
// （文字列リテラル内の [ ] は無視する）。
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
  const arrayText = extractJsonArrayText(text).replace(/,(\s*[\]}])/g, "$1");
  return JSON.parse(arrayText);
}

function parseRaidCell(cell) {
  if (!cell || cell === "-") return null;
  const m = cell.match(/\(([\d.]+TB)\)/);
  return { supported: true, effectiveCapacity: m ? m[1] : null };
}

// search_linux.js / search_windows.js の hoshu / hoshu_link フィールドから
// 保守サービス（ISS等）の名前とリンクを整形する。
// hoshu は "訪問安心保守5年\nISS-NHI-PR5" のように改行区切りで
// サービス名＋型番が入っているため、読みやすい一行にまとめる。
function buildMaintenanceService(hoshu, hoshuLink) {
  if (!hoshu || !hoshuLink) return null;
  const name = String(hoshu).replace(/\s*\n\s*/g, "（") + (hoshu.includes("\n") ? "）" : "");
  return { name, url: hoshuLink };
}

function officeSizeCode(code) {
  // TODO: 実際の値のバリエーション（小/中/大 以外があるか）を確認する
  return { "小": "小規模", "中": "中規模", "大": "大規模" }[code] || code;
}

// 「〜64人」「500人〜」のようなラベルから、絞り込み用の代表人数（一番大きい数字）を取り出す。
// Linux版（〜100人台）とWindows版（〜500人台）でスケールも表記の向きも違うため、
// OSを問わず同じ物差しで絞り込めるよう、ラベル文字列ではなくこの数値を使う。
function extractOfficeSizeNumber(label) {
  if (!label) return null;
  const numbers = [...label.matchAll(/(\d+)/g)].map(m => Number(m[1]));
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function installType(code) {
  if (code === "BOX") return "BOXタイプ";
  // メーカー側の表記ゆれ（"RACK" / "ラック" / "ラックマウント" など）を
  // すべて「ラックマウントタイプ」に統一する
  if (/ラック|^RACK$/i.test(code || "")) return "ラックマウントタイプ";
  return code;
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

// link_url からディレクトリ名（例: "hdl6-hb"）を取り出す
function slugFromLinkUrl(linkUrl) {
  const m = linkUrl.match(/\/general\/([a-z0-9\-]+)\/?/i) || linkUrl.match(/\/([a-z0-9\-]+)\/?$/i);
  return m ? m[1] : null;
}

// /general/ 配下だけでなく /wss-nas/ /appliance/ 配下も対象にするための共通パターン。
// Linux版商品ページでのみ動いていたのを、Windows版・アプライアンス版でも
// 同じロジックが使えるように一般化したもの。
function slugAnchorRegex(slug) {
  return new RegExp("/nas/(?:general|wss-nas|appliance)/" + slug + "/(?:index\\.htm)?", "i");
}

// カテゴリー一覧ページの生HTMLから、型番の直後にある状態アイコンを調べる。
// 完全なDOM解析はせず、「型番の文字列が出てくる位置の少し後ろ」を見るだけの
// シンプルな方式（型番はユニークな文字列なので誤検出しにくい）。
function lookupSkuStatus(catalogHtml, sku) {
  const idx = catalogHtml.indexOf(sku);
  if (idx === -1) return null; // このカタログページには載っていない
  const window = catalogHtml.slice(idx, idx + 250);
  if (/icon_close/.test(window)) return "生産終了";
  // 店頭在庫限りは「生産終了」とは別物として区別する。
  // NASセレクター自身の表示（「生産終了品（在庫限り）を含める」トグル）では
  // 従来通りまとめて「現行」から外して扱うが、ISSセレクターなど他ツールが
  // この status をそのまま「保守サービス対象外」の判定に使っているため、
  // まだ購入・保守に加入できる在庫限り品を生産終了と取り違えないよう、
  // 文字列としては別の値（「在庫限り」）を返すようにする。
  if (/icon_limit/.test(window)) return "在庫限り";
  return "現行";
}

// search_linux.js の link_url が実際のカタログページと食い違っている
// （型番と一致しないURLになっている）ケースがまれにある。
// その場合、型番そのものをカタログページ内で検索し、直前にある
// シリーズ見出しリンクから「本当のslug」を逆引きする。
function findSlugBySku(catalogHtml, sku) {
  const idx = catalogHtml.indexOf(sku);
  if (idx === -1) return null;
  const before = catalogHtml.slice(Math.max(0, idx - 3000), idx);
  const matches = [...before.matchAll(/\/nas\/(general|wss-nas|appliance)\/([a-z0-9\-]+)\/(?:index\.htm)?"[^>]*>([^<]*シリーズ[^<]*)</gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { category: last[1].toLowerCase(), slug: last[2].toLowerCase() };
}

// シリーズのディレクトリ名から、直前にある【...】ラベルを探す
function lookupOfficeLabel(catalogHtml, slug) {
  if (!slug) return null;
  const re = slugAnchorRegex(slug);
  const m = re.exec(catalogHtml);
  if (!m) return null;
  const before = catalogHtml.slice(Math.max(0, m.index - 800), m.index);
  const matches = [...before.matchAll(/【([^】]+)】/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1]; // 直前に一番近いもの
}

function formatOfficeLabel(label) {
  if (!label) return null;
  // 「大規模オフィス～128人」→「大規模：～128人」
  const m = label.match(/^(.+?)オフィス(.*)$/);
  if (!m) return label;
  return m[1] + "：" + m[2];
}

// カタログページの見出しリンクから、正式なシリーズ名をそのまま拾う
// （型番の末尾が数字+アルファベット混在の場合、SKU名からの推測に頼らない）
// シリーズによっては見出しがリンクになっておらず黒文字のままのケースがあるため、
// リンクが見つからない場合は直前のテキストから「シリーズ」を含む一文を拾うフォールバックを用意。
function lookupSeriesName(catalogHtml, slug) {
  if (!slug) return null;
  const linkRe = new RegExp('href="[^"]*/nas/(?:general|wss-nas|appliance)/' + slug + '/(?:index\\.htm)?"[^>]*>([^<]+)</a>', "i");
  const m = linkRe.exec(catalogHtml);
  if (m) return m[1].trim();

  const anchorRe = slugAnchorRegex(slug);
  const anchorMatch = anchorRe.exec(catalogHtml);
  if (!anchorMatch) return null;
  const before = catalogHtml.slice(Math.max(0, anchorMatch.index - 800), anchorMatch.index);
  const plainMatches = [...before.matchAll(/>([^<]*シリーズ[^<]*)</g)];
  return plainMatches.length > 0 ? plainMatches[plainMatches.length - 1][1].trim() : null;
}

// 設置方法・ドライブ数は、【...】ラベルの直後にある説明文
// （例:「10GbE対応 4ドライブ BOXタイプ」）から拾う
function lookupInstallAndBay(catalogHtml, slug) {
  if (!slug) return { install: null, bay: null };
  const re = slugAnchorRegex(slug);
  const m = re.exec(catalogHtml);
  if (!m) return { install: null, bay: null };
  const before = catalogHtml.slice(Math.max(0, m.index - 800), m.index).replace(/<[^>]+>/g, " ");
  const bayMatch = before.match(/(\d+)\s*ドライブ/);
  // 「BOX」「ラック」は複数箇所に出現しうる（例：ページ上部のナビゲーション
  // 「サーバーラックマウント対応一覧」など、商品説明とは無関係な文言）。
  // 最初に見つかったものではなく、アンカーに一番近い（＝最後に出現する）ものを
  // 採用することで、無関係な文言を誤って拾わないようにする。
  const installMatches = [...before.matchAll(/(BOX|ラック)/g)];
  const lastInstall = installMatches.length > 0
    ? installMatches[installMatches.length - 1][1]
    : null;
  return {
    bay: bayMatch ? bayMatch[1] + "ベイ" : null,
    // 明示的に「ラック」と書かれていない商品は、すべてBOXタイプとして扱う
    install: lastInstall === "ラック" ? "ラックマウントタイプ" : "BOXタイプ"
  };
}

// シリーズ見出し付近にある商品画像を拾う。
// icon_limit.gif（在庫限り）などの小さいステータスアイコンを誤って
// 商品写真として拾わないよう明示的に除外する。webp形式にも対応。
function lookupSeriesImage(catalogHtml, slug) {
  if (!slug) return null;
  const re = slugAnchorRegex(slug);
  const m = re.exec(catalogHtml);
  if (!m) return null;
  const windowHtml = catalogHtml.slice(m.index, m.index + 2000);
  const imgMatches = [...windowHtml.matchAll(/<img[^>]+src="([^"]+)"/gi)];
  for (const im of imgMatches) {
    const src = im[1];
    if (/icon_/i.test(src)) continue; // 在庫限り・生産終了・グリーン購入法などのバッジ画像を除外
    let resolved = src.trim();
    if (resolved.startsWith("//")) resolved = "https:" + resolved;
    else if (resolved.startsWith("/")) resolved = "https://www.iodata.jp" + resolved;
    return resolved;
  }
  return null;
}

// 機能バッジ探索と同じ範囲を使って、説明文に直接書かれた保証年数も拾う
function lookupCatalogWarranty(catalogHtml, slug) {
  if (!slug) return null;
  const re = slugAnchorRegex(slug);
  const m = re.exec(catalogHtml);
  if (!m) return null;
  const rest = catalogHtml.slice(m.index);
  const nextLabelIdx = rest.indexOf("【", 50);
  const windowHtml = nextLabelIdx === -1 ? rest.slice(0, 6000) : rest.slice(0, nextLabelIdx);
  const windowText = windowHtml.replace(/<[^>]+>/g, " ");
  const heroMatch = windowText.match(/(\d)\s*年保証/);
  return heroMatch ? Number(heroMatch[1]) : null;
}

// 機能バッジの補完用（既出）
function lookupCatalogFeatures(catalogHtml, slug) {
  if (!slug) return [];
  const re = slugAnchorRegex(slug);
  const m = re.exec(catalogHtml);
  if (!m) return [];
  const rest = catalogHtml.slice(m.index);
  const nextLabelIdx = rest.indexOf("【", 50);
  const windowHtml = nextLabelIdx === -1 ? rest.slice(0, 6000) : rest.slice(0, nextLabelIdx);
  const windowText = windowHtml.replace(/<[^>]+>/g, " ");
  return FEATURE_KEYWORDS.filter(kw => windowText.includes(kw));
}

// <table>の構造をちゃんと解析して「期間」行・「標準保証」列の値を取り出す。
// テキストの文字間隔に頼る方式は表のレイアウトが崩れると破綻しやすいため、
// タグの対応関係を見る、より頑丈な方式に切り替えている。
function extractWarrantyFromTables(rawHtml) {
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(rawHtml)) !== null) {
    const tableHtml = tableMatch[0];
    // 「標準保証」を含む表だけを対象にする（文字間の空白は許容）
    const strippedForCheck = tableHtml.replace(/<[^>]+>/g, "");
    if (!/標\s*準\s*保\s*証/.test(strippedForCheck)) continue;

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        const cellText = cellMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
        cells.push(cellText);
      }
      // 1列目が「期間」の行を探し、2列目（標準保証列）の値を取る
      if (cells.length >= 2 && /^期\s*間$/.test(cells[0])) {
        const m = cells[1].match(/(\d+)\s*年/);
        if (m) return Number(m[1]);
      }
    }
  }
  return null;
}

// 「保存可能容量」「実効容量」というタイトルの表から、SKUごと・RAIDモードごとの
// 実効容量（TB）を抜き出す（DASセレクターの「実効容量×2でDASを選ぶ」機能で使う）。
// 見出し行に出てくるRAIDモードの種類・並び順は商品シリーズによって異なる
// （例：2ベイ機は RAIDeX/RAID1/RAID0、4〜6ベイ機は RAIDeX/RAID6/RAID5/RAID0）ため、
// 決め打ちにせず、見出し行のラベルを都度読み取ってから列をマッピングする。
// 見出しが「型番」の行と、実際のRAID名が並ぶ行の2段に分かれているケースにも対応する。
function extractEffectiveCapacityTable(rawHtml) {
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(rawHtml)) !== null) {
    const tableHtml = tableMatch[0];
    const strippedForCheck = tableHtml.replace(/<[^>]+>/g, "");
    if (!/(保存可能容量|実効容量)/.test(strippedForCheck)) continue;

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows = [];
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        const cellText = cellMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
        cells.push(cellText);
      }
      if (cells.length > 0) rows.push(cells);
    }

    const headerRowIdx = rows.findIndex(r => r.some(c => /^型番$/.test(c)));
    if (headerRowIdx === -1) continue;

    // 「型番」の行自体にRAIDラベルが同居していない場合、次の行を見出しとして使う
    // （「型番」セルがrowspanで1列目に縦結合されているケース）。
    // その場合、RAIDラベルの行には「型番」列のセル自体が物理的に存在しないため、
    // データ行と列位置がずれないよう、先頭にダミー列を補って位置を合わせる。
    let labelRow = rows[headerRowIdx];
    let labelRowIdx = headerRowIdx;
    if (!labelRow.some(c => /RAID/i.test(c))) {
      const next = rows[headerRowIdx + 1];
      if (next && next.some(c => /RAID/i.test(c))) {
        labelRow = ["型番", ...next];
        labelRowIdx = headerRowIdx + 1;
      }
    }

    const colKeys = labelRow.map(label => {
      if (/RAIDeX/i.test(label)) return "raidex";
      if (/RAID\s?0/i.test(label)) return "raid0";
      if (/RAID\s?1/i.test(label)) return "raid1";
      if (/RAID\s?5/i.test(label)) return "raid5";
      if (/RAID\s?6/i.test(label)) return "raid6";
      return null;
    });

    const map = {};
    for (let i = labelRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const sku = row[0];
      if (!sku || !/^[A-Z]/i.test(sku)) continue; // 型番以外の行（脚注など）はスキップ
      const entry = {};
      for (let c = 1; c < row.length; c++) {
        const key = colKeys[c];
        if (!key) continue;
        const m = row[c].match(/(\d+(?:\.\d+)?)\s*TB/);
        if (m) entry[key] = Number(m[1]);
      }
      if (Object.keys(entry).length > 0) map[sku.toUpperCase()] = entry;
    }
    if (Object.keys(map).length > 0) return map;
  }
  return null;
}

// 商品比較画面で「実は違う項目」を目立たせるための詳細スペック。
// 同じ表記ゆれの心配が少ない、値がラベルセルの直後の1セルに入っている
// シンプルな「ラベル｜値」形式の行だけを対象にする（複雑な結合セルの表は対象外）。
// 同じラベルが複数回出てくる項目（USBポートの世代別など）は、出現順にすべて集める。
const SPEC_LABEL_MAP = [
  ["cpu", /^CPU$/i],
  ["memoryCapacity", /^メモリ[ーー]?容量$/],
  ["osEdition", /^搭載OS$/],
  ["lanPort", /^LAN\s*ポート$/],
  ["usbPort", /^USB\s*ポート$/],
  ["videoOutput", /^映像出力$/]
];

function extractLabeledSpecs(rawHtml) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const result = {};
  let rowMatch;
  while ((rowMatch = rowRe.exec(rawHtml)) !== null) {
    const rowHtml = rowMatch[1];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    // ラベル照合用（空白を完全に詰めた版）と、画面表示用（単語間の空白は残す版）を両方持つ
    const cellsForMatch = [];
    const cellsForDisplay = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      const rawCell = cellMatch[1].replace(/<[^>]+>/g, " ");
      cellsForMatch.push(rawCell.replace(/\s+/g, "").trim());
      cellsForDisplay.push(rawCell.replace(/\s+/g, " ").trim());
    }
    if (cellsForMatch.length < 2) continue;
    const label = cellsForMatch[0];
    const value = cellsForDisplay[cellsForDisplay.length - 1];
    if (!label || !value) continue;
    for (const [key, re] of SPEC_LABEL_MAP) {
      if (re.test(label)) {
        if (!result[key]) result[key] = [];
        // 同じ値の重複（結合セルが複数行にまたがって同じテキストを繰り返す場合）は避ける
        if (!result[key].includes(value)) result[key].push(value);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// LANポートの速さ（「一番速いNAS」を選べるようにするための項目）
//
// 公式の仕様表は、シリーズによってLANポートの書き方が3通りある。
//   ①「LANポート」1行に全部書く
//      例：（10GBASE-T／5GBASE-T／…）×1 （1000BASE-T／…）×1
//   ②「筐体特徴」の下に、速度ごとの行がある（ポートが無い速度は「－」）
//      例：10GbE LAN port｜（10GBASE-T／…）背面×1、2.5GbE LAN port｜－
//   ③「LAN ポート」の下の「転送規格」の行にまとめて書く
//      例：2.5GbE LAN port (2.5GBASE-T／…)×1 10GbE LAN port (10GBASE-T／…)×1
// ①の書き方でも「LANポートコネクタ形状｜RJ45×2」のような速度の無い行があるため、
// 速度表記（○○BASE-T）を含む行だけを集める。行の先頭以外のセル（結合セルの子ラベル）も見る。
// ---------------------------------------------------------------------------

const LAN_SPEED_ORDER = ["1G", "2.5G", "5G", "10G"];

function lanSpeedOfText(text) {
  const t = String(text).normalize("NFKC");
  if (/10GBASE-T/i.test(t)) return "10G";
  if (/(?<![\d.])5GBASE-T/i.test(t)) return "5G";
  if (/2\.5GBASE-T/i.test(t)) return "2.5G";
  if (/1000BASE-T/i.test(t)) return "1G";
  return null;
}

export function extractLanInfo(rawHtml) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const texts = [];
  let rowMatch;
  while ((rowMatch = rowRe.exec(rawHtml || "")) !== null) {
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(cm[1].replace(/<[^>]+>/g, " ").replace(/&times;/g, "×").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
    }
    if (cells.length < 2) continue;
    const value = cells[cells.length - 1];
    const labels = cells.slice(0, -1).map(c => c.normalize("NFKC").replace(/\s+/g, ""));
    const isLanRow = labels.some(l =>
      /^(10|5|2\.5|1)GbELANport$/i.test(l) || /^LANポート$/.test(l) || /^転送規格$/.test(l));
    if (!isLanRow) continue;
    if (!/BASE-T/i.test(value)) continue; // 「－」（その速度のポートは無い）や「RJ45×2」は除外
    // ②の書き方では、値に速度名が入っていないのでラベル（10GbE LAN port など）を前に付ける
    const speedLabel = labels.find(l => /GbELANport$/i.test(l));
    const display = speedLabel ? speedLabel.replace(/LANport$/i, " LAN port ") + value : value;
    if (!texts.includes(display)) texts.push(display);
  }
  if (texts.length === 0) return null;
  const joined = texts.join(" ");
  const maxSpeed = lanSpeedOfText(joined);

  // 最速の速度に対応したポートが何個あるか（例：10GbE×1）。
  // 「（…10GBASE-T…）×1」「10GBASE-T／1000BASE-T × 2」のどちらの書き方でも数える。
  let maxPorts = 0;
  const segRe = /([^×]*?)×\s*(\d+)/g;
  let sm;
  const norm = joined.normalize("NFKC");
  while ((sm = segRe.exec(norm)) !== null) {
    if (maxSpeed && lanSpeedOfText(sm[1]) === maxSpeed) maxPorts += Number(sm[2]);
  }
  return { maxSpeed, maxPorts: maxPorts || null, summary: texts.join(" / ") };
}

// spec.htm側とindex.htm側、それぞれから拾えた詳細スペックをキーごとにマージする。
// 同じキーが両方にある場合は、より情報量の多い方（配列が長い方）を採用する。
function mergeSpecDetails(specResult, mainResult) {
  const merged = {};
  const keys = new Set([...Object.keys(specResult), ...Object.keys(mainResult)]);
  for (const key of keys) {
    const a = specResult[key] || [];
    const b = mainResult[key] || [];
    merged[key] = a.length >= b.length ? a : b;
  }
  return merged;
}

// シリーズ全体の販売状況。現行の容量が1つでもあれば「現行」、
// 現行は無いが在庫限りの容量があれば「在庫限り」、どれも無ければ「生産終了」。
// （以前は在庫限りしか無いシリーズも「生産終了」にしていたため、まだ購入・保守加入できる
//   在庫限り品が、ISSセレクターで保守対象外として除外されてしまっていた）
function seriesStatus(variants) {
  if (variants.some(v => v.status === "現行")) return "現行";
  if (variants.some(v => v.status === "在庫限り")) return "在庫限り";
  return "生産終了";
}

// カタログページ側の機能タグを使った場合も、仕様表でLAN速度が確認できていれば「10GbE」を付け直す
function withLanCheckedFeatures(features, lanSpeedMax, checked) {
  const list = [...features];
  if (!checked) return list;
  const idx = list.indexOf("10GbE");
  if (lanSpeedMax === "10G" && idx === -1) list.push("10GbE");
  if (lanSpeedMax !== "10G" && idx !== -1) list.splice(idx, 1);
  return list;
}

async function fetchWarrantyAndFeatures(productUrl) {
  const specUrl = productUrl.replace(/\/?$/, "/") + "spec.htm";

  let mainHtml = "";
  let mainText = "";
  let specHtml = "";
  let specText = "";
  try {
    mainHtml = await fetchText(productUrl);
    mainText = mainHtml.replace(/<[^>]+>/g, " ");
  } catch (err) {
    console.warn("  -> 商品ページ取得失敗:", productUrl, "(" + err.message + ")");
  }
  await sleep(REQUEST_INTERVAL_MS);
  try {
    specHtml = await fetchText(specUrl);
    specText = specHtml.replace(/<[^>]+>/g, " ");
  } catch (err) {
    console.warn("  -> spec.htm取得失敗:", specUrl, "(" + err.message + ")");
  }
  await sleep(REQUEST_INTERVAL_MS);

  // 実効容量（保存可能容量）表は基本的にspec.htmにあるが、シリーズによっては
  // 商品トップページ（index.htm）側に出ることもあるため、両方試す。
  const effectiveCapacityBySku =
    extractEffectiveCapacityTable(specHtml) || extractEffectiveCapacityTable(mainHtml);

  // 商品比較画面用の詳細スペック（CPU・メモリ容量・OS表記・LAN/USBポート・映像出力）。
  // spec.htmを優先し、無ければmain側も見る。同じラベルがspec/main両方にあった場合は
  // 値の種類が多いほう（＝より詳しい方）を採用する。
  const specDetails = mergeSpecDetails(
    extractLabeledSpecs(specHtml),
    extractLabeledSpecs(mainHtml)
  );

  const combined = mainText + " " + specText;

  let warrantyYears = null;
  const heroMatch = combined.match(/(\d)\s*年保証/);
  if (heroMatch) {
    warrantyYears = Number(heroMatch[1]);
  } else {
    const idx = combined.indexOf("保証期間");
    if (idx !== -1) {
      const after = combined.slice(idx, idx + 60);
      const m = after.match(/(\d)\s*年/);
      if (m) warrantyYears = Number(m[1]);
    }
  }

  if (warrantyYears === null && mainHtml) {
    // 表の構造を正しく解析する方式（テキストの文字間隔に頼る方式より頑丈）
    warrantyYears = extractWarrantyFromTables(mainHtml);
  }

  const features = FEATURE_KEYWORDS.filter(kw => combined.includes(kw));

  // LANポートの速さ。仕様表（spec.htm → 無ければindex.htm）の値から判定する。
  const lanInfo = extractLanInfo(specHtml) || extractLanInfo(mainHtml);
  // 「10GbE」の機能タグは、本文中の言葉（例：他機種の紹介文に出てくる「10GbE」）では判定せず、
  // 仕様表のLAN速度で付け直す。仕様表から速度が取れなかったときだけ、本文の判定を残す。
  if (lanInfo && lanInfo.maxSpeed) {
    const idx = features.indexOf("10GbE");
    if (lanInfo.maxSpeed === "10G" && idx === -1) features.push("10GbE");
    if (lanInfo.maxSpeed !== "10G" && idx !== -1) features.splice(idx, 1);
  }

  // 「冗長化」欄からRAID対応状況を拾う。
  // search_linux/windows.js に無いカタログ補完分の商品で使う。
  // Linux版は「冗長化設定：RAIDeX（出荷時）／RAID 6／RAID 5／RAID 0」（RAIDと数字の間にスペースあり）、
  // Windows版は「冗長化」の下に「方式」「設定」と分かれ、値は「RAID1（出荷時）、RAID0」
  // （RAIDと数字の間にスペースなし）と表記が異なるため、両方に対応させる。
  //
  // 「冗長化」という単語は、実際の仕様表だけでなく「独自の冗長化技術『RAIDeX』採用」の
  // ようなマーケティング文章中にも登場する。以前は最初の出現箇所だけを見ていたため、
  // 先にマーケティング文章側の「冗長化」に引っかかって仕様表まで辿り着けない
  // （＝raidSupportが空になる）不具合があった。
  // そのため、出現箇所を1つずつすべて試し、実際にRAID情報が読み取れたものが
  // 見つかるたびに採用結果を更新する（＝一番仕様表に近い、最後に見つかった
  // 有効な結果が最終的に残る）方式に変更した。
  let raidSupport = [];
  const raidChecks = [
    ["RAIDeX", /RAIDeX/],
    ["RAID 0", /RAID\s?0/],
    ["RAID 1", /RAID\s?1/],
    ["RAID 5", /RAID\s?5/],
    ["RAID 6", /RAID\s?6/]
  ];
  let searchFrom = 0;
  while (true) {
    const redundancyIdx = combined.indexOf("冗長化", searchFrom);
    if (redundancyIdx === -1) break;
    searchFrom = redundancyIdx + 1;

    const nearby = combined.slice(redundancyIdx, redundancyIdx + 300);
    const settingIdx = nearby.indexOf("設定");
    if (settingIdx === -1) continue;

    const raidWindow = nearby.slice(settingIdx, settingIdx + 150);
    const found = raidChecks.filter(([, re]) => re.test(raidWindow)).map(([label]) => label);
    if (found.length > 0) {
      raidSupport = found;
    }
  }

  // 各詳細スペックは配列（同じラベルの行が複数あった場合はすべて）で来るので、
  // 表示用に「／」区切りの1つの文字列にまとめる。値が取れなかった項目はnullのまま。
  const specSummary = {
    cpu: (specDetails.cpu && specDetails.cpu[0]) || null,
    memoryCapacity: (specDetails.memoryCapacity && specDetails.memoryCapacity[0]) || null,
    osEdition: (specDetails.osEdition && specDetails.osEdition[0]) || null,
    lanPort: (lanInfo && lanInfo.summary) || (specDetails.lanPort && specDetails.lanPort[0]) || null,
    usbPort: specDetails.usbPort && specDetails.usbPort.length > 0 ? specDetails.usbPort.join(" / ") : null,
    videoOutput: (specDetails.videoOutput && specDetails.videoOutput[0]) || null
  };

  return {
    warrantyYears, features, raidSupport, effectiveCapacityBySku, specSummary,
    lanSpeedMax: lanInfo ? lanInfo.maxSpeed : null,
    lanMaxPorts: lanInfo ? lanInfo.maxPorts : null,
    lanFeatureChecked: !!(lanInfo && lanInfo.maxSpeed)
  };
}

// カタログページ全体から、全シリーズの見出しリンク（slug・シリーズ名・出現位置）を洗い出す。
// 「シリーズ」という文字を含むリンクだけを対象にすることで、価格表内の型番リンク
// （見出しと同じhrefを指すがテキストは型番）を誤って拾わないようにしている。
function extractAllCatalogSeries(catalogHtml) {
  const re = /href="([^"]*\/nas\/(general|wss-nas|appliance)\/([a-z0-9\-]+)\/(?:index\.htm)?)"[^>]*>([^<]*シリーズ[^<]*)<\/a>/gi;
  const seen = new Set();
  const list = [];
  let m;
  while ((m = re.exec(catalogHtml)) !== null) {
    const slug = m[3].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    list.push({ slug, category: m[2].toLowerCase(), name: m[4].trim(), index: m.index });
  }
  return list.sort((a, b) => a.index - b.index);
}

// 指定シリーズの価格表ブロック（そのシリーズの見出し〜次のシリーズの見出し直前まで）から、
// 型番・容量・価格・在庫状況を抜き出す。JANコード・RAID対応はこのページには無いため空にする。
function extractCatalogVariants(catalogHtml, series, allSeries) {
  const startIdx = series.index;
  const nextIdx = allSeries
    .map(s => s.index)
    .filter(i => i > startIdx)
    .sort((a, b) => a - b)[0];
  const block = catalogHtml.slice(startIdx, nextIdx === undefined ? startIdx + 8000 : nextIdx);

  // 型番の直後に「店頭在庫限り」「生産終了」などのアイコン画像（<img … alt="店頭在庫限り" …>）が
  // 入っている行は、型番から容量までが100文字を超える。以前は80文字までしか見ていなかったため、
  // アイコン付きの行（＝旧モデル）を1件も拾えていなかった。
  // 読み取り範囲を広げる代わりに、次の行（</tr>）をまたがないよう制限している。
  const rowRe = /href="[^"]*\/nas\/(?:general|wss-nas|appliance)\/[a-z0-9\-]+\/(?:index\.htm)?"[^>]*>\s*([A-Z][A-Z0-9\-\/]+)\s*<\/a>((?:(?!<\/tr>)[\s\S]){0,300}?)(\d+(?:\.\d+)?)\s*TB(?:(?!<\/tr>)[\s\S]){0,300}?￥([\d,]+)/gi;

  const variants = [];
  let m;
  while ((m = rowRe.exec(block)) !== null) {
    const sku = m[1].trim();
    const statusWindow = m[2];
    // 上の lookupSkuStatus と同じ理由で、在庫限りと生産終了を別の値として区別する。
    const status = /icon_close/.test(statusWindow) ? "生産終了"
      : /icon_limit/.test(statusWindow) ? "在庫限り"
      : "現行";
    variants.push({
      sku,
      capacityTB: Number(m[3]),
      priceIncTax: Number(m[4].replace(/,/g, "")),
      jan: PREVIOUS_JAN_BY_SKU[sku.toUpperCase()] || "",
      status
    });
  }
  return variants.sort((a, b) => a.capacityTB - b.capacityTB);
}
// バックアップ用HDD対応表の中で、型番ごとにどの見出し区分（アンカー）に
// 載っているかを判定する。区分の境目は、既知のアンカー名の出現位置を目印にする。
function buildBackupHddAnchorMap(html, productIds) {
  const anchorPositions = [];
  for (const name of HDD_COMPAT_ANCHORS) {
    const re = new RegExp('(?:id|name)="' + name + '"', "i");
    const m = re.exec(html);
    if (m) anchorPositions.push({ name, index: m.index });
  }
  anchorPositions.sort((a, b) => a.index - b.index);

  const upperHtml = html.toUpperCase();
  const map = {};
  for (const id of productIds) {
    if (!id) continue;
    const idx = upperHtml.indexOf(id.toUpperCase());
    if (idx === -1) continue;
    let anchor = null;
    for (const a of anchorPositions) {
      if (a.index <= idx) anchor = a.name;
      else break;
    }
    if (anchor) map[id] = anchor;
  }
  return map;
}


// クラウドストレージ対応表から、型番ごとに
// 「テレワーク・データ共有用途」「災害対策（BCP対策）用途」のどちらに対応しているかを判定する。
// 個人向けモデルの節は対象外（法人向けモデルの節だけを見る）。
// 同じ型番が両方の表に載っていることもあるため、区間ごとに別々に判定する。
function buildCloudSupportMap(html, productIds) {
  // ページ最上部の目次にも「個人向けモデル」という文字が先に出てくるため、
  // 1回目（目次リンク）ではなく2回目（実際の見出し）を境目として使う。
  const firstMention = html.indexOf("個人向けモデル");
  const personalIdx = firstMention === -1 ? -1 : html.indexOf("個人向けモデル", firstMention + 1);
  const bizHtml = personalIdx === -1 ? html : html.slice(0, personalIdx);

  const headingRe = /(テレワーク（データ共有）用途|災害対策（BCP対策）用途)/g;
  const headings = [];
  let hm;
  while ((hm = headingRe.exec(bizHtml)) !== null) {
    headings.push({ type: hm[1].startsWith("テレワーク") ? "telework" : "bcp", index: hm.index });
  }
  headings.sort((a, b) => a.index - b.index);

  const regions = headings.map((h, i) => ({
    type: h.type,
    start: h.index,
    end: i + 1 < headings.length ? headings[i + 1].index : bizHtml.length
  }));

  const map = {};
  for (const id of productIds) {
    if (!id) continue;
    for (const region of regions) {
      const section = bizHtml.slice(region.start, region.end);
      const idx = section.toUpperCase().indexOf(id.toUpperCase());
      if (idx === -1) continue;
      const windowText = section.slice(idx, idx + 600);
      const supported = /[◯〇]/.test(windowText);
      if (!map[id]) map[id] = {};
      map[id][region.type] = map[id][region.type] || supported;
    }
  }
  return map;
}


// 前回のデータ（data/products.json）。公式のデータファイル（search_linux/windows.js）から
// 外れた旧モデルはカタログページから補うが、カタログにはシリーズ大分類（LAN DISK H/X/Z…）や
// JANコードが無い。DASセレクターがシリーズ大分類を使うため、前回のデータにあった値を引き継ぐ。
const PREVIOUS_SERIES_BY_SLUG = {};
const PREVIOUS_JAN_BY_SKU = {};

async function loadPreviousData() {
  try {
    const prev = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8"));
    (prev.products || []).forEach(p => {
      const slug = String(p.sourceUrl || "").replace(/\/+$/, "").split("/").pop();
      if (slug && p.series) PREVIOUS_SERIES_BY_SLUG[slug.toLowerCase()] = p.series;
      (p.variants || []).forEach(v => {
        if (v.sku && v.jan) PREVIOUS_JAN_BY_SKU[String(v.sku).toUpperCase()] = String(v.jan);
      });
    });
    console.log(`前回データから引き継ぎ: シリーズ大分類 ${Object.keys(PREVIOUS_SERIES_BY_SLUG).length} 件 / JANコード ${Object.keys(PREVIOUS_JAN_BY_SKU).length} 件`);
  } catch (err) {
    console.warn("前回データが読めなかったため、引き継ぎは行いません:", err.message);
  }
}

async function main() {
  console.log("NASセレクター スクレイパー（版：2026-10-06b 旧モデル補完・在庫限り判定・LAN速度対応）");
  await loadPreviousData();
  const rawEntries = [];
  for (const source of LIST_URLS) {
    const text = await fetchText(source.url);
    const entries = parseSearchJs(text);
    entries.forEach(e => { e.__os = source.os; });
    rawEntries.push(...entries);
    await sleep(REQUEST_INTERVAL_MS);
  }

  let catalogHtml = "";
  for (const url of CATALOG_PAGE_URLS) {
    try {
      catalogHtml += await fetchText(url) + "\n";
    } catch (err) {
      console.warn("  -> カタログページ取得失敗:", url, "(" + err.message + ")");
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  // link_url が同じもの＝同一機種の容量バリエーションとしてグループ化
  const groups = new Map();
  for (const e of rawEntries) {
    if (!groups.has(e.link_url)) groups.set(e.link_url, []);
    groups.get(e.link_url).push(e);
  }

  const products = [];
  const coveredSlugs = new Set();
  // 公式データファイルに残っているシリーズでも、一部の容量（在庫限りの旧容量など）が
  // データファイルから外れ、カタログにだけ載っていることがある。その分を足すために使う。
  const catalogSeriesForMerge = extractAllCatalogSeries(catalogHtml);

  for (const [linkUrl, entries] of groups) {
    const base = entries[0];
    let slug = slugFromLinkUrl(linkUrl);
    let effectiveUrl = linkUrl;

    // link_url由来のslugでカタログ情報が一つも見つからない場合、
    // link_url自体が間違っている可能性が高いので、型番から逆引きする
    const seemsUnresolved =
      !lookupSeriesName(catalogHtml, slug) &&
      !lookupSeriesImage(catalogHtml, slug) &&
      !lookupOfficeLabel(catalogHtml, slug);
    if (seemsUnresolved) {
      const corrected = findSlugBySku(catalogHtml, base.name);
      if (corrected) {
        console.warn("  -> link_urlの不一致を検出、slugを補正:", slug, "->", corrected.slug);
        slug = corrected.slug;
        effectiveUrl = "https://www.iodata.jp/product/nas/" + corrected.category + "/" + slug + "/";
      }
    }
    if (slug) coveredSlugs.add(slug);

    const variants = entries.map(e => ({
      sku: e.name,
      capacityTB: Number(String(e.capacity).replace("TB", "")),
      priceIncTax: e.price,
      jan: String(e.jan),
      status: lookupSkuStatus(catalogHtml, e.name) || "現行"
    })).sort((a, b) => a.capacityTB - b.capacityTB);

    // カタログにだけ載っている容量（データファイルから外れた在庫限り品など）を足す
    const catalogSeries = catalogSeriesForMerge.find(cs => cs.slug === slug);
    if (catalogSeries) {
      const known = new Set(variants.map(v => v.sku.toUpperCase()));
      const extra = extractCatalogVariants(catalogHtml, catalogSeries, catalogSeriesForMerge)
        .filter(cv => !known.has(cv.sku.toUpperCase()));
      if (extra.length > 0) {
        console.log(`  -> ${slug}: カタログにだけある容量を追加 ${extra.map(v => v.sku).join(", ")}`);
        variants.push(...extra);
        variants.sort((a, b) => a.capacityTB - b.capacityTB);
      }
    }

    const anyCurrent = variants.some(v => v.status === "現行");
    const officeLabel = formatOfficeLabel(lookupOfficeLabel(catalogHtml, slug));

    const {
      warrantyYears: detailWarrantyYears,
      features: detailFeatures,
      raidSupport: detailRaidSupport,
      effectiveCapacityBySku,
      specSummary,
      lanSpeedMax,
      lanMaxPorts,
      lanFeatureChecked
    } = await fetchWarrantyAndFeatures(effectiveUrl);
    const warrantyYears = detailWarrantyYears ?? lookupCatalogWarranty(catalogHtml, slug);
    const features = withLanCheckedFeatures(
      detailFeatures.length > 0 ? detailFeatures : lookupCatalogFeatures(catalogHtml, slug), lanSpeedMax, lanFeatureChecked);

    // DASセレクター用：SKUごとのRAIDモード別実効容量（TB）を、わかる分だけ変種に付与する
    // （DAS用HDD対応表に無い旧機種や、表が見つからなかった場合はnullのまま）
    if (effectiveCapacityBySku) {
      variants.forEach(v => {
        v.effectiveCapacityTB = effectiveCapacityBySku[v.sku.toUpperCase()] || null;
      });
    } else {
      variants.forEach(v => { v.effectiveCapacityTB = null; });
    }

    const catalogSeriesName = lookupSeriesName(catalogHtml, slug);
    const fallbackShortName = base.name.replace(/\d+$/, "");
    const displayName = catalogSeriesName || (base.series + "（" + fallbackShortName + "シリーズ）");

    products.push({
      id: (slug || fallbackShortName).toLowerCase(),
      name: displayName,
      series: base.series,
      os: base.__os || "Linux OS",
      install: installType(base.type),
      bay: base.drive + "ベイ",
      officeSize: officeLabel || (officeSizeCode(base.office) + "：" + base.concurrent),
      officeSizeMax: extractOfficeSizeNumber(officeLabel) ?? extractOfficeSizeNumber(base.concurrent),
      maintenanceService: buildMaintenanceService(base.hoshu, base.hoshu_link),
      imageUrl: lookupSeriesImage(catalogHtml, slug),
      raidSupport: raidSupportList(base).length > 0 ? raidSupportList(base) : detailRaidSupport,
      warrantyYears,
      status: seriesStatus(variants),
      features,
      lanSpeedMax,
      lanMaxPorts,
      specDetails: specSummary,
      variants,
      sourceUrl: effectiveUrl,
      lastCheckedAt: new Date().toISOString()
    });
  }

  // search_linux.js に無いシリーズ（LXシリーズなど）をカタログページから補完する。
  // JANコード・RAID対応・推奨接続台数はこのページに無いため空/不明のままになる。
  //
  // これらのカタログ補完分には、search_linux/windows.js側が持つ「series」フィールド
  // （LAN DISK H / X / A…といったシリーズ大分類）が無いため、従来は series: null の
  // ままになっていた（DASセレクター側でシリーズを特定できない原因になっていた）。
  // I-O DATA公式のバックアップ用HDD対応表（hdd.htm）の脚注で
  // 「LAN DISK LXシリーズ：HDL4-LX, HDL4-LXU, HDL2-LX」と明記されているのを
  // 確認済みのため、分かっている分だけ slug → series名の対応表で補っておく。
  // （ここに無いslugは今まで通り series: null のまま。見つかり次第ここに追加していく）
  const CATALOG_SERIES_NAME_OVERRIDE = {
    "hdl4-lx": "LAN DISK LX",
    "hdl4-lxu": "LAN DISK LX",
    "hdl2-lx": "LAN DISK LX"
  };

  const allCatalogSeries = extractAllCatalogSeries(catalogHtml);
  for (const series of allCatalogSeries) {
    if (coveredSlugs.has(series.slug)) continue;

    const variants = extractCatalogVariants(catalogHtml, series, allCatalogSeries);
    if (variants.length === 0) continue; // 価格表が見つからなければスキップ（バナー等の誤検出防止）

    const productUrl = "https://www.iodata.jp/product/nas/" + series.category + "/" + series.slug + "/";
    const anyCurrent = variants.some(v => v.status === "現行");
    const officeLabel = formatOfficeLabel(lookupOfficeLabel(catalogHtml, series.slug));
    const { install, bay } = lookupInstallAndBay(catalogHtml, series.slug);

    const {
      warrantyYears: detailWarrantyYears,
      features: detailFeatures,
      raidSupport: detailRaidSupport,
      effectiveCapacityBySku,
      specSummary,
      lanSpeedMax,
      lanMaxPorts,
      lanFeatureChecked
    } = await fetchWarrantyAndFeatures(productUrl);
    const warrantyYears = detailWarrantyYears ?? lookupCatalogWarranty(catalogHtml, series.slug);
    const features = withLanCheckedFeatures(
      detailFeatures.length > 0 ? detailFeatures : lookupCatalogFeatures(catalogHtml, series.slug), lanSpeedMax, lanFeatureChecked);

    if (effectiveCapacityBySku) {
      variants.forEach(v => {
        v.effectiveCapacityTB = effectiveCapacityBySku[v.sku.toUpperCase()] || null;
      });
    } else {
      variants.forEach(v => { v.effectiveCapacityTB = null; });
    }

    products.push({
      id: series.slug,
      name: series.name,
      // 対応表 → 前回のデータ（公式データファイルに載っていた頃のシリーズ大分類）の順に引き継ぐ
      // Windows系（wss-nas）は、大分類が分かっている機種がすべて「LAN DISK Z」なので、不明なものもそれに合わせる
      series: CATALOG_SERIES_NAME_OVERRIDE[series.slug] || PREVIOUS_SERIES_BY_SLUG[series.slug]
        || (series.category === "wss-nas" ? "LAN DISK Z" : null),
      os: series.category === "wss-nas" ? "Windows OS" : "Linux OS",
      install,
      bay,
      officeSize: officeLabel,
      officeSizeMax: extractOfficeSizeNumber(officeLabel),
      imageUrl: lookupSeriesImage(catalogHtml, series.slug),
      raidSupport: detailRaidSupport, // 商品ページの「冗長化設定」欄から取得
      warrantyYears,
      maintenanceService: null, // カタログ補完分はsearch_linux/windows.js由来のhoshu情報を持たない
      status: seriesStatus(variants),
      features,
      lanSpeedMax,
      lanMaxPorts,
      specDetails: specSummary,
      variants,
      sourceUrl: productUrl,
      lastCheckedAt: new Date().toISOString()
    });
  }


  // バックアップ用HDD対応表を取得し、型番ごとの区分（アンカー）を付与する
  try {
    const hddCompatHtml = await fetchText(HDD_COMPAT_URL);
    const anchorMap = buildBackupHddAnchorMap(hddCompatHtml, products.map(p => p.id));
    products.forEach(p => {
      const anchor = anchorMap[p.id];
      p.backupHddUrl = anchor ? HDD_COMPAT_URL + "#" + anchor : HDD_COMPAT_URL;
    });
  } catch (err) {
    console.warn("  -> HDD対応表の取得失敗:", err.message);
    products.forEach(p => { p.backupHddUrl = HDD_COMPAT_URL; });
  }
  await sleep(REQUEST_INTERVAL_MS);

  // クラウドストレージ対応表を取得し、型番ごとの用途対応を付与する
  try {
    const cloudCompatHtml = await fetchText(CLOUD_COMPAT_URL);
    const cloudMap = buildCloudSupportMap(cloudCompatHtml, products.map(p => p.id));
    products.forEach(p => {
      const entry = cloudMap[p.id] || {};
      p.cloudTelework = !!entry.telework;
      p.cloudBcp = !!entry.bcp;
    });
  } catch (err) {
    console.warn("  -> クラウド対応表の取得失敗:", err.message);
    products.forEach(p => { p.cloudTelework = false; p.cloudBcp = false; });
  }
  await sleep(REQUEST_INTERVAL_MS);

  const output = {
    updatedAt: new Date().toISOString(),
    products
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log("done. products:", products.length, "/ raw entries:", rawEntries.length);
  // 確認用のまとめ（販売状況ごとの件数と、LAN速度・シリーズ大分類が取れなかったもの）
  const byStatus = {};
  products.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  console.log("販売状況ごとのシリーズ数:", JSON.stringify(byStatus));
  const noLan = products.filter(p => !p.lanSpeedMax).map(p => p.id);
  console.log(`LAN速度が取れなかったシリーズ: ${noLan.length}件 ${noLan.join(", ")}`);
  const noSeries = products.filter(p => !p.series).map(p => p.id);
  console.log(`シリーズ大分類が無いシリーズ: ${noSeries.length}件 ${noSeries.join(", ")}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
