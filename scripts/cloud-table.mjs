// クラウドストレージ対応表（cloud.htm）の読み取り専用モジュール。
//
// 公式の対応表は「行＝商品シリーズ（1行に複数の型番が並ぶ）」「列＝クラウドサービス」の表で、
// ところどころ行がセル結合（rowspan）されている。以前は「型番が最初に出てくる位置から600文字を
// 見て、◯があれば対応」という方式だったため、隣のセルの○を拾ったり、似た型番
// （HDL4-XAB と HDL4-XA など）を取り違えたりしていた。
// ここでは <table> の構造をそのまま読み、結合セルを展開してから、行×列で判定する。
//
//   parseCloudCompatTables(html)      … 対応表を「行ごとの型番リスト＋サービス別の○×」に変換する
//   lookupCloudSupport(parsed, product) … 商品1件が、どの行に載っているかを探して対応状況を返す
//   applyCloudFeatures(features, r)    … features の「クラウドストレージ連携」「NarSuSクラウドバックアップ」を
//                                         対応表の結果で上書きする
//
// 対象は、先頭見出しが「商品シリーズ名」の表（法人向けモデル）だけ。
// 先頭見出しが「サービス」の表（個人向けモデル）は対象外。

const MARK_TRUE = /^[◯〇○]/; // 丸の表記ゆれ（◯ U+25EF / 〇 U+3007 / ○ U+25CB）をすべて「対応」とみなす

function decodeEntities(s) {
  return s
    .replace(/&times;/g, "×")
    .replace(/&sup2;/g, "²")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ""));
}

// セルの見た目の文字（空白をすべて詰める。比較用）
function cellText(html) {
  return stripTags(html).replace(/\s+/g, "");
}

// ◯〇○ → true、× - － 確認中 空欄 → false
function isSupportedMark(text) {
  return MARK_TRUE.test(text.trim());
}

// ---------------------------------------------------------------------------
// 表 → 行×列の格子（rowspan / colspan を展開する）
// ---------------------------------------------------------------------------
function tableToGrid(tableHtml) {
  const rowHtmls = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const grid = [];
  const pending = []; // pending[列] = { remaining: あと何行ぶん残っているか, cell }

  for (const rowHtml of rowHtmls) {
    const out = [];
    let col = 0;
    const fillPending = () => {
      while (pending[col] && pending[col].remaining > 0) {
        out[col] = pending[col].cell;
        pending[col].remaining--;
        col++;
      }
    };

    for (const m of rowHtml.matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      fillPending();
      const attrs = m[2];
      const rowspan = Number((attrs.match(/rowspan="?(\d+)/i) || [])[1] || 1);
      const colspan = Number((attrs.match(/colspan="?(\d+)/i) || [])[1] || 1);
      const cell = { html: m[3] };
      for (let c = 0; c < colspan; c++) {
        out[col + c] = cell;
        if (rowspan > 1) pending[col + c] = { remaining: rowspan - 1, cell };
      }
      col += colspan;
    }
    // 行の右端に、上の行から伸びてきた結合セルが残っている場合
    for (; col < pending.length; col++) {
      if (pending[col] && pending[col].remaining > 0) {
        out[col] = pending[col].cell;
        pending[col].remaining--;
      }
    }
    grid.push(out);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// サービス名の表示用の正規化（列見出し → 画面に出す名前）
// ---------------------------------------------------------------------------
const SERVICE_NAME_RULES = [
  [/OneDriveforBusiness/i, "Microsoft OneDrive for Business"],
  [/OneDrive/i, "Microsoft OneDrive"],
  [/Googleドライブ/, "Googleドライブ"],
  [/Dropbox/i, "Dropbox"],
  [/^Box/i, "Box"],
  [/WorkingFolder/i, "WorkingFolder"],
  [/HOME-?BOX/i, "HOME-BOX²"],
  [/NarSuSクラウドSC/, "NarSuSクラウドSC"],
  [/NarSuSクラウド/, "NarSuSクラウド"],
  [/Azure/i, "Microsoft Azure"],
  [/AmazonS3/i, "Amazon S3互換"],
  [/WasabiCloudNAS/i, "Wasabi Cloud NAS"],
  [/WasabiHotCloudStorage/i, "Wasabi Hot Cloud Storage"],
  [/Azumasy/, "Azumasyストレージサービス"],
  [/BCPリモートバックアップ/, "BCPリモートバックアップ"],
  [/あずけ/, "フレッツ・あずけ～るPRO"],
  [/コラストレージ/, "コラストレージ"],
  [/AOSBOX/i, "AOSBOX Business"]
];

function canonicalServiceName(headerHtml) {
  // 見出しの脚注（※5 など）を除いた文字だけで判定する
  const t = cellText(headerHtml).replace(/※[\d、,]*/g, "");
  for (const [re, name] of SERVICE_NAME_RULES) {
    if (re.test(t)) return name;
  }
  return t; // 知らない名前はそのまま使う（新しいサービスが追加されても落とさない）
}

// 先頭列のセル（型番リスト）を、{ name, slug } の配列にする。
// 型番は <br /> で区切られ、多くはリンク（…/general/hdl6-hab/）になっている。
// リンクの URL のフォルダ名（slug）は商品の id と同じなので、一番確実な照合キーになる。
function parseModelCell(html) {
  const models = [];
  for (const seg of html.split(/<br\s*\/?>/i)) {
    const name = stripTags(seg).replace(/※[\d、,]*/g, "").replace(/\s+/g, "").trim();
    if (!name || !/^[A-Za-z]/.test(name)) continue;
    const href = seg.match(/href="[^"]*\/nas\/(?:general|wss-nas|appliance)\/([a-z0-9\-]+)\/?(?:index\.htm)?"/i);
    models.push({ name: name.toUpperCase(), slug: href ? href[1].toLowerCase() : null });
  }
  return models;
}

// ---------------------------------------------------------------------------
// ページ全体 → 解析結果
//   { telework: [行…], bcp: [行…] }
//   行 = { models: [{name, slug}], services: { "Box": true, "Microsoft OneDrive": false, … } }
// ---------------------------------------------------------------------------
export function parseCloudCompatTables(html) {
  const result = { telework: [], bcp: [] };

  for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const grid = tableToGrid(tm[0]);
    if (grid.length < 2) continue;
    const header = grid[0];
    // 法人向け（先頭見出しが「商品シリーズ名」）の表だけを読む。個人向けの表は「サービス」始まり。
    if (!header[0] || cellText(header[0].html) !== "商品シリーズ名") continue;

    const serviceNames = header.map((h, i) => (i === 0 ? null : canonicalServiceName(h.html)));
    const headerText = serviceNames.join("|");
    const kind = /OneDrive/.test(headerText) ? "telework" : /NarSuSクラウド/.test(headerText) ? "bcp" : null;
    if (!kind) continue;

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row[0]) continue;
      const models = parseModelCell(row[0].html);
      if (models.length === 0) continue;
      const services = {};
      for (let c = 1; c < serviceNames.length; c++) {
        if (!row[c]) continue; // 行の右端が欠けている場合は無視
        services[serviceNames[c]] = isSupportedMark(cellText(row[c].html));
      }
      result[kind].push({ models, services });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 商品1件 → 対応表のどの行か
// ---------------------------------------------------------------------------

// 型番（例：HDL2-LE16N, HDL4-XA32B, HDL4-HA64-U）から容量の数字を除いて、
// 対応表の「シリーズの型番」（HDL2-LEN, HDL4-XAB, HDL4-HA-U）の形にする。
// ハイフンより前の「HDL4」の4は残す。
function seriesStemOfSku(sku) {
  const first = String(sku).toUpperCase().split("/")[0];
  const i = first.indexOf("-");
  if (i === -1) return first;
  return first.slice(0, i + 1) + first.slice(i + 1).replace(/\d+/g, "");
}

function slugOfUrl(url) {
  const m = String(url || "").match(/\/nas\/(?:general|wss-nas|appliance)\/([a-z0-9\-]+)\/?/i);
  return m ? m[1].toLowerCase() : null;
}

function productKeys(product) {
  const slugs = new Set();
  const names = new Set();
  if (product.id) slugs.add(String(product.id).toLowerCase().replace(/\/+$/, ""));
  const us = slugOfUrl(product.sourceUrl);
  if (us) slugs.add(us);
  for (const v of product.variants || []) {
    if (!v.sku) continue;
    const full = String(v.sku).toUpperCase().split("/")[0];
    names.add(full);
    names.add(seriesStemOfSku(v.sku));
  }
  return { slugs, names };
}

function rowMatchesProduct(row, keys) {
  // 完全一致のみ（前方一致・部分一致は使わない：HDL4-XA が HDL4-XAB に当たるのを防ぐ）
  return row.models.some(m => (m.slug && keys.slugs.has(m.slug)) || keys.names.has(m.name));
}

// 戻り値：
//   matched            … 対応表のどこかの行に載っていたか（false なら「表に載っていない」＝判定不能）
//   telework / bcp     … その区分で1つでも対応サービスがあるか
//   teleworkServices / bcpServices … 対応しているサービス名の一覧
//   teleworkRowFound / bcpRowFound … その区分の表に行があったか
//   narsusCloud / narsusCloudSC    … NarSuSクラウド列／NarSuSクラウドSC列が○か（行が無ければ null）
export function lookupCloudSupport(parsed, product) {
  const keys = productKeys(product);
  const teleRows = parsed.telework.filter(r => rowMatchesProduct(r, keys));
  const bcpRows = parsed.bcp.filter(r => rowMatchesProduct(r, keys));

  const collect = rows => {
    const names = [];
    for (const row of rows) {
      for (const [name, ok] of Object.entries(row.services)) {
        if (ok && !names.includes(name)) names.push(name);
      }
    }
    return names;
  };
  const teleworkServices = collect(teleRows);
  const bcpServices = collect(bcpRows);

  const flag = (rows, name) => (rows.length === 0 ? null : rows.some(r => r.services[name] === true));

  return {
    matched: teleRows.length > 0 || bcpRows.length > 0,
    teleworkRowFound: teleRows.length > 0,
    bcpRowFound: bcpRows.length > 0,
    telework: teleworkServices.length > 0,
    bcp: bcpServices.length > 0,
    teleworkServices,
    bcpServices,
    narsusCloud: flag(bcpRows, "NarSuSクラウド"),
    narsusCloudSC: flag(bcpRows, "NarSuSクラウドSC")
  };
}

// features の2項目を、対応表の結果で上書きする。
//   ・クラウドストレージ連携 … 対応表の「テレワーク（データ共有）」区分を正とする。
//     （Windowsモデルの表には「災害対策」の区分しかないので、載っていれば「連携なし」になる）
//   ・NarSuSクラウドバックアップ … 対応表の「NarSuSクラウド」列を正とする。
// 対応表のどこにも載っていない商品は、判定材料が無いので features には触らない。
export function applyCloudFeatures(features, r, keywordOrder = []) {
  if (!r.matched) return features;
  const set = new Set(features);

  if (r.telework) set.add("クラウドストレージ連携");
  else set.delete("クラウドストレージ連携");

  if (r.bcpRowFound) {
    if (r.narsusCloud) set.add("NarSuSクラウドバックアップ");
    else set.delete("NarSuSクラウドバックアップ");
  }

  const ordered = keywordOrder.filter(k => set.has(k));
  const rest = [...set].filter(k => !keywordOrder.includes(k));
  return [...ordered, ...rest];
}
