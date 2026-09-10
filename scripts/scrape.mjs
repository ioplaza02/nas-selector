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
  "https://www.iodata.jp/ssp/nas/biznas/selector/search_linux.js"
  // TODO: Windows版の同等ファイル（search_windows.js的なもの）を調査して追加する
];

// 在庫状況・人数ラベルの参照元。複数カテゴリーにまたがっているため全部見る。
const CATALOG_PAGE_URLS = [
  "https://www.iodata.jp/product/nas/general/",
  "https://www.iodata.jp/product/nas/wss-nas/",
  "https://www.iodata.jp/product/nas/appliance/"
];

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

// link_url からディレクトリ名（例: "hdl6-hb"）を取り出す
function slugFromLinkUrl(linkUrl) {
  const m = linkUrl.match(/\/general\/([a-z0-9\-]+)\/?/i) || linkUrl.match(/\/([a-z0-9\-]+)\/?$/i);
  return m ? m[1] : null;
}

// カテゴリー一覧ページの生HTMLから、型番の直後にある状態アイコンを調べる。
// 完全なDOM解析はせず、「型番の文字列が出てくる位置の少し後ろ」を見るだけの
// シンプルな方式（型番はユニークな文字列なので誤検出しにくい）。
function lookupSkuStatus(catalogHtml, sku) {
  const idx = catalogHtml.indexOf(sku);
  if (idx === -1) return null; // このカタログページには載っていない
  const window = catalogHtml.slice(idx, idx + 250);
  if (/icon_close/.test(window)) return "生産終了";
  if (/icon_limit/.test(window)) return "生産終了"; // 店頭在庫限りも「現行」からは外す
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
  const matches = [...before.matchAll(/\/general\/([a-z0-9\-]+)\/(?:index\.htm)?"[^>]*>([^<]*シリーズ[^<]*)</gi)];
  return matches.length > 0 ? matches[matches.length - 1][1].toLowerCase() : null;
}

// シリーズのディレクトリ名から、直前にある【...】ラベルを探す
function lookupOfficeLabel(catalogHtml, slug) {
  if (!slug) return null;
  const re = new RegExp("/general/" + slug + "/(?:index\\.htm)?", "i");
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
  const linkRe = new RegExp('href="[^"]*/general/' + slug + '/(?:index\\.htm)?"[^>]*>([^<]+)</a>', "i");
  const m = linkRe.exec(catalogHtml);
  if (m) return m[1].trim();

  const anchorRe = new RegExp("/general/" + slug + "/(?:index\\.htm)?", "i");
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
  const re = new RegExp("/general/" + slug + "/(?:index\\.htm)?", "i");
  const m = re.exec(catalogHtml);
  if (!m) return { install: null, bay: null };
  const before = catalogHtml.slice(Math.max(0, m.index - 800), m.index).replace(/<[^>]+>/g, " ");
  const bayMatch = before.match(/(\d+)\s*ドライブ/);
  const installMatch = before.match(/(BOX|ラック)/);
  return {
    bay: bayMatch ? bayMatch[1] + "ベイ" : null,
    install: installMatch ? (installMatch[1] === "BOX" ? "BOXタイプ" : "ラックマウントタイプ") : null
  };
}

// シリーズ見出し付近にある商品画像を拾う。
// icon_limit.gif（在庫限り）などの小さいステータスアイコンを誤って
// 商品写真として拾わないよう明示的に除外する。webp形式にも対応。
function lookupSeriesImage(catalogHtml, slug) {
  if (!slug) return null;
  const re = new RegExp("/general/" + slug + "/(?:index\\.htm)?", "i");
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
  const re = new RegExp("/general/" + slug + "/(?:index\\.htm)?", "i");
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
  const re = new RegExp("/general/" + slug + "/(?:index\\.htm)?", "i");
  const m = re.exec(catalogHtml);
  if (!m) return [];
  const rest = catalogHtml.slice(m.index);
  const nextLabelIdx = rest.indexOf("【", 50);
  const windowHtml = nextLabelIdx === -1 ? rest.slice(0, 6000) : rest.slice(0, nextLabelIdx);
  const windowText = windowHtml.replace(/<[^>]+>/g, " ");
  return FEATURE_KEYWORDS.filter(kw => windowText.includes(kw));
}

async function fetchWarrantyAndFeatures(productUrl) {
  const specUrl = productUrl.replace(/\/?$/, "/") + "spec.htm";

  let mainText = "";
  let specText = "";
  try {
    mainText = (await fetchText(productUrl)).replace(/<[^>]+>/g, " ");
  } catch (err) {
    console.warn("  -> 商品ページ取得失敗:", productUrl, "(" + err.message + ")");
  }
  await sleep(REQUEST_INTERVAL_MS);
  try {
    specText = (await fetchText(specUrl)).replace(/<[^>]+>/g, " ");
  } catch (err) {
    console.warn("  -> spec.htm取得失敗:", specUrl, "(" + err.message + ")");
  }
  await sleep(REQUEST_INTERVAL_MS);

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

  if (warrantyYears === null) {
    // 「標準保証」列・「期間」行に年数だけが書かれている表形式に対応
    // （例: 標準保証 / 交換品お届け保守 / 訪問安心保守 の3列表で、
    //   期間の行が「3年 / 1～7年 / 1～7年」のように並ぶ）
    // ページ内に「標準保証」という文字列が本題と無関係な場所にも
    // 出てくることがあるため、最初の1件だけで決め打ちせず、
    // 直後に「期間」と年数が続く箇所が見つかるまで順番に確認する。
    const stdMatches = [...combined.matchAll(/標\s*準\s*保\s*証/g)];
    for (const sm of stdMatches) {
      const nearby = combined.slice(sm.index, sm.index + 400);
      const periodMatch = nearby.match(/期\s*間/);
      if (!periodMatch) continue;
      const afterPeriod = nearby.slice(periodMatch.index, periodMatch.index + 30);
      const m = afterPeriod.match(/(\d+)\s*年/);
      if (m) {
        warrantyYears = Number(m[1]);
        break;
      }
    }
  }

  const features = FEATURE_KEYWORDS.filter(kw => combined.includes(kw));

  return { warrantyYears, features };
}

// カタログページ全体から、全シリーズの見出しリンク（slug・シリーズ名・出現位置）を洗い出す。
// 「シリーズ」という文字を含むリンクだけを対象にすることで、価格表内の型番リンク
// （見出しと同じhrefを指すがテキストは型番）を誤って拾わないようにしている。
function extractAllCatalogSeries(catalogHtml) {
  const re = /href="([^"]*\/general\/([a-z0-9\-]+)\/(?:index\.htm)?)"[^>]*>([^<]*シリーズ[^<]*)<\/a>/gi;
  const seen = new Set();
  const list = [];
  let m;
  while ((m = re.exec(catalogHtml)) !== null) {
    const slug = m[2].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    list.push({ slug, name: m[3].trim(), index: m.index });
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

  const rowRe = /href="[^"]*\/general\/[a-z0-9\-]+\/(?:index\.htm)?"[^>]*>\s*([A-Z][A-Z0-9\-\/]+)\s*<\/a>([\s\S]{0,80}?)(\d+(?:\.\d+)?)\s*TB[\s\S]{0,150}?￥([\d,]+)/gi;

  const variants = [];
  let m;
  while ((m = rowRe.exec(block)) !== null) {
    const sku = m[1].trim();
    const statusWindow = m[2];
    const status = /icon_close|icon_limit/.test(statusWindow) ? "生産終了" : "現行";
    variants.push({
      sku,
      capacityTB: Number(m[3]),
      priceIncTax: Number(m[4].replace(/,/g, "")),
      jan: "",
      status
    });
  }
  return variants;
}
async function main() {
  const rawEntries = [];
  for (const url of LIST_URLS) {
    const text = await fetchText(url);
    rawEntries.push(...parseSearchJs(text));
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
      const correctedSlug = findSlugBySku(catalogHtml, base.name);
      if (correctedSlug) {
        console.warn("  -> link_urlの不一致を検出、slugを補正:", slug, "->", correctedSlug);
        slug = correctedSlug;
        effectiveUrl = "https://www.iodata.jp/product/nas/general/" + slug + "/";
      }
    }
    if (slug) coveredSlugs.add(slug);

    const variants = entries.map(e => ({
      sku: e.name,
      capacityTB: Number(String(e.capacity).replace("TB", "")),
      priceIncTax: e.price,
      jan: String(e.jan),
      status: lookupSkuStatus(catalogHtml, e.name) || "現行"
    }));

    const anyCurrent = variants.some(v => v.status === "現行");
    const officeLabel = formatOfficeLabel(lookupOfficeLabel(catalogHtml, slug));

    const { warrantyYears: detailWarrantyYears, features: detailFeatures } = await fetchWarrantyAndFeatures(effectiveUrl);
    const warrantyYears = detailWarrantyYears ?? lookupCatalogWarranty(catalogHtml, slug);
    const features = detailFeatures.length > 0 ? detailFeatures : lookupCatalogFeatures(catalogHtml, slug);

    const catalogSeriesName = lookupSeriesName(catalogHtml, slug);
    const fallbackShortName = base.name.replace(/\d+$/, "");
    const displayName = catalogSeriesName || (base.series + "（" + fallbackShortName + "シリーズ）");

    products.push({
      id: (slug || fallbackShortName).toLowerCase(),
      name: displayName,
      series: base.series,
      os: "Linux OS", // TODO: Windows版を追加する時はここを出し分ける
      install: installType(base.type),
      bay: base.drive + "ベイ",
      officeSize: officeLabel || (officeSizeCode(base.office) + "：" + base.concurrent),
      imageUrl: lookupSeriesImage(catalogHtml, slug),
      raidSupport: raidSupportList(base),
      warrantyYears,
      status: anyCurrent ? "現行" : "生産終了",
      features,
      variants,
      sourceUrl: effectiveUrl,
      lastCheckedAt: new Date().toISOString()
    });
  }

  // search_linux.js に無いシリーズ（LXシリーズなど）をカタログページから補完する。
  // JANコード・RAID対応・推奨接続台数はこのページに無いため空/不明のままになる。
  const allCatalogSeries = extractAllCatalogSeries(catalogHtml);
  for (const series of allCatalogSeries) {
    if (coveredSlugs.has(series.slug)) continue;

    const variants = extractCatalogVariants(catalogHtml, series, allCatalogSeries);
    if (variants.length === 0) continue; // 価格表が見つからなければスキップ（バナー等の誤検出防止）

    const productUrl = "https://www.iodata.jp/product/nas/general/" + series.slug + "/";
    const anyCurrent = variants.some(v => v.status === "現行");
    const officeLabel = formatOfficeLabel(lookupOfficeLabel(catalogHtml, series.slug));
    const { install, bay } = lookupInstallAndBay(catalogHtml, series.slug);

    const { warrantyYears: detailWarrantyYears, features: detailFeatures } = await fetchWarrantyAndFeatures(productUrl);
    const warrantyYears = detailWarrantyYears ?? lookupCatalogWarranty(catalogHtml, series.slug);
    const features = detailFeatures.length > 0 ? detailFeatures : lookupCatalogFeatures(catalogHtml, series.slug);

    products.push({
      id: series.slug,
      name: series.name,
      series: null, // TODO: カタログ補完分はシリーズ大分類（LAN DISK H/X/A等）を未取得
      os: "Linux OS",
      install,
      bay,
      officeSize: officeLabel,
      imageUrl: lookupSeriesImage(catalogHtml, series.slug),
      raidSupport: [], // このページには無い情報
      warrantyYears,
      status: anyCurrent ? "現行" : "生産終了",
      features,
      variants,
      sourceUrl: productUrl,
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
