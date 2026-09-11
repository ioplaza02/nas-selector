const FACET_DEFS = [
  { key: "install", label: "設置方法", type: "single" },
  { key: "os", label: "OS", type: "single" },
  { key: "bay", label: "ドライブ数", type: "single" },
  { key: "raidSupport", label: "対応RAID", type: "array" },
  { key: "warrantyYears", label: "保証", type: "single", format: v => v + "年保証" },
  { key: "features", label: "対応機能", type: "array" }
];

let allProducts = [];
const activeFilters = {};
const uiState = {};
let budgetMax = null;
let capacityRange = null;
let employeeMin = null;
let cloudTeleworkOnly = false;
let cloudBcpOnly = false;

async function init() {
  const res = await fetch("data/products.json");
  const data = await res.json();
  allProducts = data.products;
  allProducts.forEach(p => {
    uiState[p.id] = { checked: false, variantIdx: 0 };
  });

  if (data.updatedAt) {
    const d = new Date(data.updatedAt);
    const formatted = d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
    const daysSince = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    const updatedEl = document.getElementById("updated-at");
    if (daysSince > 40) {
      updatedEl.textContent = "データ最終更新日：" + formatted + "（" + daysSince + "日前 - 更新が止まっている可能性があります）";
      updatedEl.classList.add("disclaimer__updated--warning");
    } else {
      updatedEl.textContent = "データ最終更新日：" + formatted;
    }
  }

  buildFilterPanel();
  render();

  document.getElementById("show-discontinued").addEventListener("change", render);
  document.getElementById("compare-close").addEventListener("click", () => {
    document.getElementById("compare-modal").hidden = true;
  });
  document.getElementById("tray-btn").addEventListener("click", openCompare);
}

function facetValues(key, type) {
  const set = new Set();
  allProducts.forEach(p => {
    if (type === "array") {
      (p[key] || []).forEach(v => set.add(v));
    } else {
      if (p[key] !== undefined && p[key] !== null) set.add(p[key]);
    }
  });
  return Array.from(set);
}

function buildFilterPanel() {
  const panel = document.getElementById("filter-panel");
  panel.innerHTML = "";

  // 利用人数（Linux版・Windows版でスケールも表記も違うため、
  // ラベルの一致ではなく数値のスライダーで統一的に絞り込む）。
  // 200人を超えると該当商品の顔ぶれがほぼ変わらないため、目盛りは段階的にし、
  // 上限は「200人以上」としてまとめる。折りたたみはせず常に開いた状態にする。
  const EMPLOYEE_STEPS = [0, 10, 16, 20, 25, 50, 64, 100, 128, 200];
  const employeeValues = allProducts.map(p => p.officeSizeMax).filter(v => v != null);
  if (employeeValues.length > 0) {
    const employeeSection = document.createElement("div");
    employeeSection.className = "filter-section";
    const employeeLabelTitle = document.createElement("p");
    employeeLabelTitle.className = "filter-group__label filter-group__label--static";
    employeeLabelTitle.textContent = "利用人数の目安";
    employeeSection.appendChild(employeeLabelTitle);

    const employeeLabel = document.createElement("p");
    employeeLabel.className = "range-value";
    employeeLabel.textContent = "指定なし（全ての規模を表示）";
    const employeeInput = document.createElement("input");
    employeeInput.type = "range";
    employeeInput.min = "0";
    employeeInput.max = String(EMPLOYEE_STEPS.length - 1);
    employeeInput.step = "1";
    employeeInput.value = "0";
    employeeInput.setAttribute("list", "employee-ticks");

    const datalist = document.createElement("datalist");
    datalist.id = "employee-ticks";
    EMPLOYEE_STEPS.forEach((_, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      datalist.appendChild(opt);
    });

    employeeInput.addEventListener("input", () => {
      const i = Number(employeeInput.value);
      const v = EMPLOYEE_STEPS[i];
      employeeMin = v > 0 ? v : null;
      const isTop = i === EMPLOYEE_STEPS.length - 1;
      employeeLabel.textContent = v > 0
        ? "自社の人数：約" + v + "人" + (isTop ? "以上" : "〜")
        : "指定なし（全ての規模を表示）";
      render();
    });
    employeeSection.appendChild(employeeLabel);
    employeeSection.appendChild(employeeInput);
    employeeSection.appendChild(datalist);
    panel.appendChild(employeeSection);
  }

  // クラウド連携は「テレワーク・データ共有」と「災害対策（BCP）バックアップ」で
  // 目的がまったく違うため、1つのチェックにまとめず分けて絞り込めるようにする。
  const cloudSection = document.createElement("details");
  const cloudTitle = document.createElement("summary");
  cloudTitle.className = "filter-group__label";
  cloudTitle.textContent = "クラウド連携";
  cloudSection.appendChild(cloudTitle);

  const cloudOptions = [
    {
      key: "telework",
      title: "テレワーク・データ共有",
      note: "OneDrive・Dropbox・Boxなど。社外からのアクセスや共同編集向け"
    },
    {
      key: "bcp",
      title: "災害対策（BCP）バックアップ",
      note: "NarSuS・Azure・S3など。万一の際のデータ保全向け"
    }
  ];
  cloudOptions.forEach(opt => {
    const wrapper = document.createElement("label");
    wrapper.className = "cloud-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      if (opt.key === "telework") cloudTeleworkOnly = cb.checked;
      else cloudBcpOnly = cb.checked;
      render();
    });
    const textWrap = document.createElement("span");
    const titleEl = document.createElement("span");
    titleEl.className = "cloud-option__title";
    titleEl.textContent = opt.title;
    const noteEl = document.createElement("span");
    noteEl.className = "cloud-option__note";
    noteEl.textContent = opt.note;
    textWrap.appendChild(titleEl);
    textWrap.appendChild(document.createElement("br"));
    textWrap.appendChild(noteEl);
    wrapper.appendChild(cb);
    wrapper.appendChild(textWrap);
    cloudSection.appendChild(wrapper);
  });
  panel.appendChild(cloudSection);

  FACET_DEFS.forEach(def => {
    activeFilters[def.key] = new Set();
    const values = facetValues(def.key, def.type);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "filter-group__label";
    summary.textContent = def.label;
    details.appendChild(summary);

    values.forEach(v => {
      const wrapper = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", () => {
        if (cb.checked) activeFilters[def.key].add(v);
        else activeFilters[def.key].delete(v);
        render();
      });
      wrapper.appendChild(cb);
      wrapper.appendChild(document.createTextNode(def.format ? def.format(v) : v));
      details.appendChild(wrapper);
    });
    panel.appendChild(details);
  });

  // 予算・容量（レンジ）
  const priceValues = allProducts.flatMap(p => p.variants.map(v => v.priceIncTax));
  const capValues = allProducts.flatMap(p => p.variants.map(v => v.capacityTB));
  const maxPrice = Math.max(...priceValues, 100000);
  const maxCap = Math.max(...capValues, 8);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.className = "filter-group__label";
  summary.textContent = "予算・容量で絞り込む";
  details.appendChild(summary);

  const priceLabel = document.createElement("p");
  priceLabel.className = "range-value";
  priceLabel.textContent = "予算上限：指定なし";
  const priceInput = document.createElement("input");
  priceInput.type = "range";
  priceInput.min = "0";
  priceInput.max = String(maxPrice);
  priceInput.step = "10000";
  priceInput.value = String(maxPrice);
  priceInput.addEventListener("input", () => {
    budgetMax = Number(priceInput.value);
    priceLabel.textContent = "予算上限：¥" + budgetMax.toLocaleString();
    render();
  });

  const capLabel = document.createElement("p");
  capLabel.className = "range-value";
  capLabel.textContent = "総容量下限：指定なし";
  const capInput = document.createElement("input");
  capInput.type = "range";
  capInput.min = "0";
  capInput.max = String(maxCap);
  capInput.step = "4";
  capInput.value = "0";
  capInput.addEventListener("input", () => {
    capacityRange = Number(capInput.value);
    capLabel.textContent = "総容量下限：" + capacityRange + "TB";
    render();
  });

  details.appendChild(priceLabel);
  details.appendChild(priceInput);
  details.appendChild(capLabel);
  details.appendChild(capInput);
  panel.appendChild(details);

  const resetBtn = document.createElement("button");
  resetBtn.className = "filter-reset";
  resetBtn.textContent = "絞り込みを解除する";
  resetBtn.addEventListener("click", () => {
    FACET_DEFS.forEach(def => activeFilters[def.key].clear());
    budgetMax = null;
    capacityRange = null;
    employeeMin = null;
    cloudTeleworkOnly = false;
    cloudBcpOnly = false;
    buildFilterPanel();
    render();
  });
  panel.appendChild(resetBtn);
}

function matchesFilters(p) {
  for (const def of FACET_DEFS) {
    const chosen = activeFilters[def.key];
    if (chosen.size === 0) continue;
    if (def.type === "array") {
      const values = p[def.key] || [];
      const hit = values.some(v => chosen.has(v));
      if (!hit) return false;
    } else {
      if (!chosen.has(p[def.key])) return false;
    }
  }
  if (budgetMax !== null) {
    const anyWithinBudget = p.variants.some(v => v.priceIncTax <= budgetMax);
    if (!anyWithinBudget) return false;
  }
  if (capacityRange !== null && capacityRange > 0) {
    const anyWithinCapacity = p.variants.some(v => v.capacityTB >= capacityRange);
    if (!anyWithinCapacity) return false;
  }
  if (employeeMin !== null) {
    if (p.officeSizeMax == null || p.officeSizeMax < employeeMin) return false;
  }
  if (cloudTeleworkOnly && !p.cloudTelework) return false;
  if (cloudBcpOnly && !p.cloudBcp) return false;
  return true;
}

function visibleProducts() {
  const showDiscontinued = document.getElementById("show-discontinued").checked;
  return allProducts.filter(p => {
    if (p.status !== "現行" && !showDiscontinued) return false;
    return matchesFilters(p);
  });
}

function fmtPrice(n) {
  return "\u00a5" + n.toLocaleString();
}

function render() {
  const visible = visibleProducts();
  const hiddenDiscontinued = allProducts.filter(p => p.status !== "現行").length;
  const showDiscontinued = document.getElementById("show-discontinued").checked;

  document.getElementById("result-count").textContent =
    "該当 " + visible.length + " 件" +
    (!showDiscontinued && hiddenDiscontinued > 0 ? "（生産終了品 " + hiddenDiscontinued + " 件を非表示）" : "");

  const grid = document.getElementById("product-grid");
  grid.innerHTML = "";

  visible.forEach(p => {
    const s = uiState[p.id];
    const variant = p.variants[s.variantIdx];

    const card = document.createElement("div");
    card.className = "product-card" + (s.checked ? " product-card--selected" : "");

    const top = document.createElement("div");
    top.className = "product-card__top";
    let icon;
    if (p.imageUrl) {
      const imgLink = document.createElement("a");
      imgLink.href = p.sourceUrl;
      imgLink.target = "_blank";
      imgLink.rel = "noopener noreferrer";
      imgLink.title = "公式ページを見る";
      const img = document.createElement("img");
      img.src = p.imageUrl;
      img.alt = p.name;
      img.className = "product-card__image";
      imgLink.appendChild(img);
      icon = imgLink;
    } else {
      icon = document.createElement("span");
      icon.textContent = "\u25A3";
    }
    const compareLabel = document.createElement("label");
    compareLabel.className = "product-card__compare";
    const compareCb = document.createElement("input");
    compareCb.type = "checkbox";
    compareCb.checked = s.checked;
    compareCb.addEventListener("change", () => {
      s.checked = compareCb.checked;
      updateTray();
      render();
    });
    compareLabel.appendChild(compareCb);
    compareLabel.appendChild(document.createTextNode("比較"));
    top.appendChild(icon);
    top.appendChild(compareLabel);
    card.appendChild(top);

    const name = document.createElement("p");
    name.className = "product-card__name";
    name.textContent = p.name;
    card.appendChild(name);

    const badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";
    const badgeValues = [
      p.officeSize,
      p.install,
      p.bay,
      p.warrantyYears != null ? p.warrantyYears + "年保証" : null
    ].filter(t => t !== null && t !== undefined);
    badgeValues.forEach(t => {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = t;
      badgeRow.appendChild(b);
    });
    card.appendChild(badgeRow);

    if (p.raidSupport && p.raidSupport.length > 0) {
      const raidLine = document.createElement("p");
      raidLine.className = "raid-line";
      raidLine.textContent = "[" + p.raidSupport.join("/") + "]";
      card.appendChild(raidLine);
    }

    if (p.features && p.features.length > 0) {
      const featureRow = document.createElement("div");
      featureRow.className = "feature-row";
      p.features.forEach(f => {
        const chip = document.createElement("span");
        chip.className = "feature-chip";
        chip.textContent = f;
        featureRow.appendChild(chip);
      });
      card.appendChild(featureRow);
    }

    const variantLabel = document.createElement("p");
    variantLabel.className = "variant-label";
    variantLabel.textContent = "容量を選択";
    card.appendChild(variantLabel);

    const variantRow = document.createElement("div");
    variantRow.className = "variant-row";
    p.variants.forEach((v, vi) => {
      const btn = document.createElement("button");
      btn.className = "variant-btn" + (vi === s.variantIdx ? " variant-btn--selected" : "");
      btn.textContent = v.capacityTB + "TB";
      btn.addEventListener("click", () => {
        s.variantIdx = vi;
        render();
      });
      variantRow.appendChild(btn);
    });
    card.appendChild(variantRow);

    const priceRow = document.createElement("div");
    priceRow.className = "price-row";

    const skuBlock = document.createElement("div");
    const skuLine = document.createElement("p");
    skuLine.className = "sku-line";
    skuLine.textContent = variant.sku || "-";
    const janLine = document.createElement("p");
    janLine.className = "jan-line";
    janLine.textContent = variant.jan ? "JAN: " + variant.jan : "";
    skuBlock.appendChild(skuLine);
    skuBlock.appendChild(janLine);

    const price = document.createElement("p");
    price.className = "price";
    price.textContent = fmtPrice(variant.priceIncTax);

    priceRow.appendChild(skuBlock);
    priceRow.appendChild(price);
    card.appendChild(priceRow);

    grid.appendChild(card);
  });

  updateTray();
}

function updateTray() {
  const selected = allProducts.filter(p => uiState[p.id].checked);
  document.getElementById("tray-count").textContent = selected.length;
  document.getElementById("tray-btn").disabled = selected.length < 2;
}

function openCompare() {
  const selected = allProducts.filter(p => uiState[p.id].checked);
  const rows = [
    ["容量／価格", p => {
      const v = p.variants[uiState[p.id].variantIdx];
      return v.capacityTB + "TB / " + fmtPrice(v.priceIncTax);
    }],
    ["オフィス規模", p => p.officeSize || "-"],
    ["設置方法", p => p.install || "-"],
    ["OS", p => p.os || "-"],
    ["ドライブ数", p => p.bay || "-"],
    ["対応RAID", p => (p.raidSupport && p.raidSupport.length > 0) ? p.raidSupport.join(" / ") : "-"],
    ["保証", p => p.warrantyYears != null ? p.warrantyYears + "年保証" : "-"],
    ["対応機能", p => (p.features && p.features.length > 0) ? p.features.join(" / ") : "-"]
  ];

  let html = '<table class="compare-table"><tr><th></th>';
  selected.forEach(p => { html += "<th>" + p.name + "</th>"; });
  html += "</tr>";
  html += '<tr><th>画像</th>';
  selected.forEach(p => {
    if (!p.imageUrl) { html += "<td>-</td>"; return; }
    html += "<td><a href=\"" + p.sourceUrl + "\" target=\"_blank\" rel=\"noopener noreferrer\">"
      + '<img src="' + p.imageUrl + '" alt="' + p.name + '" class="compare-table__image">'
      + "</a></td>";
  });
  html += "</tr>";
  rows.forEach(([label, getter]) => {
    html += "<tr><th>" + label + "</th>";
    selected.forEach(p => { html += "<td>" + getter(p) + "</td>"; });
    html += "</tr>";
  });

  // バックアップ用HDD・保守サービスの案内。主役はNAS本体なので、控えめな行として一番下に添える。
  html += '<tr class="compare-table__soft-row"><th>対応HDD</th>';
  selected.forEach(p => {
    html += "<td>" + (p.backupHddUrl
      ? '<a href="' + p.backupHddUrl + '" target="_blank" rel="noopener noreferrer">対応HDD一覧</a>'
      : "-") + "</td>";
  });
  html += "</tr>";

  html += "</table>";

  html += '<p class="compare-footnote">保守サービスもご用意しています。'
    + '<a href="https://www.iodata.jp/support/service/iss/maintenance/nas/lineup.htm" target="_blank" rel="noopener noreferrer">訪問・安心・保守</a>'
    + '</p>';

  document.getElementById("compare-table-wrap").innerHTML = html;
  document.getElementById("compare-modal").hidden = false;
}

// 簡易パスワードゲート（試作版の関係者限定用）。
// GitHub Pagesは静的配信のみのため、本当の意味でのサーバー側認証ではなく、
// このJavaScriptのチェックを通らないと中身を表示しない、という簡易的な鍵です。
const SITE_PASSWORD = "landisk2026";
const UNLOCK_KEY = "nas-selector-unlocked";

// 日本語入力がオンのまま打つと全角（ａ－ｚ、０－９）になってしまうことがあるため、
// 比較の前に半角へ変換し、前後の空白も取り除く。
function normalizeInput(str) {
  return str
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function showApp() {
  document.getElementById("password-gate").hidden = true;
  document.getElementById("app-root").hidden = false;
  init();
}

if (sessionStorage.getItem(UNLOCK_KEY) === "1") {
  showApp();
} else {
  const passwordInput = document.getElementById("password-input");
  const toggleBtn = document.getElementById("password-toggle");
  toggleBtn.addEventListener("click", () => {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    toggleBtn.textContent = showing ? "👁" : "🙈";
    toggleBtn.setAttribute("aria-label", showing ? "パスワードを表示" : "パスワードを非表示");
  });

  document.getElementById("password-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = normalizeInput(passwordInput.value);
    if (input === SITE_PASSWORD) {
      sessionStorage.setItem(UNLOCK_KEY, "1");
      showApp();
    } else {
      document.getElementById("password-error").hidden = false;
    }
  });
}
