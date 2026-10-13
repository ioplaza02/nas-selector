// LXシリーズが products.json に入らない原因を切り分けるための、その場限りのデバッグ用スクリプト。
// nas-selector フォルダの直下に置いて実行してください。
//
//   node debug_lx.mjs
//
// scrape.mjs と同じ正規表現を使い、「どの段階で落ちているか」を表示します。

const CATALOG_PAGE_URLS = [
  "https://www.iodata.jp/product/nas/general/",
  "https://www.iodata.jp/product/nas/wss-nas/",
  "https://www.iodata.jp/product/nas/appliance/"
];
const TARGETS = ["hdl2-lx", "hdl4-lx", "hdl2-lv"]; // hdl2-lv は比較用

let html = "";
for (const url of CATALOG_PAGE_URLS) {
  const res = await fetch(url, { headers: { "User-Agent": "NasSelectorBot/1.0 (debug script)" } });
  console.log("取得:", url, res.status);
  html += (await res.text()) + "\n";
}

// ---- 段階1: LXへのリンクがHTMLの中にあるか
for (const slug of TARGETS) {
  const hrefs = [...html.matchAll(new RegExp('href="([^"]*/' + slug + '/[^"]*)"[^>]*>([\\s\\S]{0,80}?)</a>', "gi"))];
  console.log("\n===== " + slug + " =====");
  console.log("段階1: このslugへのリンクの数:", hrefs.length);
  hrefs.slice(0, 4).forEach((m, i) =>
    console.log("  [" + i + "] href=" + m[1] + " / 中身=" + JSON.stringify(m[2].replace(/\s+/g, " ")))
  );
}

// ---- 段階2: 見出しリンクとして拾えるか（scrape.mjs の extractAllCatalogSeries と同じ）
const re = /href="([^"]*\/nas\/(general|wss-nas|appliance)\/([a-z0-9\-]+)\/(?:index\.htm)?)"[^>]*>([^<]*シリーズ[^<]*)<\/a>/gi;
const series = [];
const seen = new Set();
let m;
while ((m = re.exec(html)) !== null) {
  const slug = m[3].toLowerCase();
  if (seen.has(slug)) continue;
  seen.add(slug);
  series.push({ slug, name: m[4].trim(), index: m.index });
}
series.sort((a, b) => a.index - b.index);
console.log("\n段階2: 見出しリンクとして拾えたシリーズ数:", series.length);
for (const slug of TARGETS) {
  console.log("  " + slug + ":", seen.has(slug) ? "拾えた" : "拾えていない");
}

// ---- 段階3: 価格表の行が拾えるか（extractCatalogVariants と同じ）
const rowRe = /href="[^"]*\/nas\/(?:general|wss-nas|appliance)\/[a-z0-9\-]+\/(?:index\.htm)?"[^>]*>\s*([A-Z][A-Z0-9\-\/]+)\s*<\/a>([\s\S]{0,80}?)(\d+(?:\.\d+)?)\s*TB[\s\S]{0,150}?￥([\d,]+)/gi;
for (const slug of TARGETS) {
  const s = series.find(x => x.slug === slug);
  if (!s) continue;
  const next = series.map(x => x.index).filter(i => i > s.index).sort((a, b) => a - b)[0];
  const block = html.slice(s.index, next === undefined ? s.index + 8000 : next);
  const rows = [...block.matchAll(rowRe)];
  console.log("\n段階3 [" + slug + "]: 見出しから次の見出しまで " + block.length + " 文字、価格表の行 " + rows.length + " 件");
  rows.forEach(r => console.log("  ", r[1], r[3] + "TB", "￥" + r[4]));
  if (rows.length === 0) {
    console.log("  → 行が拾えていません。見出し直後の HTML（先頭1200文字）:");
    console.log(block.slice(0, 1200));
  }
}
