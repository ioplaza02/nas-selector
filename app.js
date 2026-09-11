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
  // ラベルの一致ではなく数値のスライダーで統一的に絞り込む）
  const employeeValues = allProducts.map(p => p.officeSizeMax).filter(v => v != null);
  if (employeeValues.length > 0) {
    const maxEmployees = Math.max(...employeeValues);
    const employeeDetails = document.createElement("details");
    employeeDetails.open = true;
    const employeeSummary = document.createElement("summary");
    employeeSummary.className = "filter-group__label";
    employeeSummary.textContent = "利用人数の目安";
    employeeDetails.appendChild(employeeSummary);

    const employeeLabel = document.createElement("p");
    employeeLabel.className = "range-value";
    employeeLabel.textContent = "指定なし（全ての規模を表示）";
    const employeeInput = document.createElement("input");
    employeeInput.type = "range";
    employeeInput.min = "0";
    employeeInput.max = String(maxEmployees);
    employeeInput.step = "5";
    employeeInput.value = "0";
    employeeInput.addEventListener("input", () => {
      const v = Number(employeeInput.value);
      employeeMin = v > 0 ? v : null;
      employeeLabel.textContent = v > 0 ? "自社の人数：約" + v + "人" : "指定なし（全ての規模を表示）";
      render();
    });
    employeeDetails.appendChild(employeeLabel);
    employeeDetails.appendChild(employeeInput);
    panel.appendChild(employeeDetails);
  }

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

    const price = document.createElement("p");
    price.className = "price";
    price.textContent = fmtPrice(variant.priceIncTax);
    card.appendChild(price);

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

  // 保守サービス（ISS）の案内。主役はNAS本体なので、控えめな行として一番下に添える。
  html += '<tr class="compare-table__soft-row"><th>保守サービス</th>';
  selected.forEach(p => {
    html += "<td>" + (p.maintenanceService
      ? '<a href="' + p.maintenanceService.url + '" target="_blank" rel="noopener noreferrer">'
        + p.maintenanceService.name + "</a>"
      : "-") + "</td>";
  });
  html += "</tr>";

  html += "</table>";

  html += '<p class="compare-footnote">'
    + 'バックアップ用の外付けHDDをお探しの場合は、'
    + '<a href="https://www.iodata.jp/pio/io/nas/landisk/hdd.htm" target="_blank" rel="noopener noreferrer">対応HDD一覧</a>'
    + 'でご確認いただけます。'
    + '</p>';

  document.getElementById("compare-table-wrap").innerHTML = html;
  document.getElementById("compare-modal").hidden = false;
}

init();
