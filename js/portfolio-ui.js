// ============================================================
// 我的持股：畫面與互動
// 計算邏輯在 portfolio.js（純函式，有獨立測試）；這裡只負責顯示、
// 表單、匯出／匯入備份，以及向既有的報價來源要現價。
// ============================================================

import {
    computePositions,
    valuePosition,
    estimateFee,
    estimateTax,
    validateNewTransaction,
    validateDeletion,
    loadTransactions,
    saveTransactions,
    loadSettings,
    saveSettings,
    newTransactionId,
    buildBackup,
    parseBackup
} from "./portfolio.js";
import { lookupTwStockName } from "./providers/twse.js";
import { fetchQuoteFor } from "./watchlist.js";

const ui = {
    transactions: [],
    settings: loadSettings(),
    quotes: {}, // key -> { price, asOf, error }
    quoteLoading: false
};

const $ = (id) => document.getElementById(id);

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function money(n, market, digits) {
    if (!Number.isFinite(n)) return "--";
    const d = digits ?? (market === "TW" ? 0 : 2);
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// 股數：整數就不顯示小數，美股零碎股最多顯示 4 位小數
function fmtShares(n) {
    return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "--";
}

function signed(n, market, digits) {
    if (!Number.isFinite(n)) return "--";
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    return `${sign}${money(Math.abs(n), market, digits)}`;
}

function pnlClass(n) {
    if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "";
    return n > 0 ? "pnl-up" : "pnl-down";
}

function pnlCell(n, pct, market) {
    if (!Number.isFinite(n)) return "--";
    const pctText = Number.isFinite(pct) ? `<small>${pct > 0 ? "+" : ""}${pct.toFixed(2)}%</small>` : "";
    return `<span class="${pnlClass(n)}">${signed(n, market)}${pctText ? `<br>${pctText}` : ""}</span>`;
}

const TYPE_LABEL = { open: "期初持股", buy: "買進", sell: "賣出" };
const CURRENCY = { TW: "NT$", US: "US$" };

// ------------------------------------------------------------
// 持股總覽
// ------------------------------------------------------------
function renderMarket(market, positions, sellPnlTotalsByKey) {
    const mkt = market.toLowerCase();
    const inMarket = Object.values(positions).filter((p) => p.market === market);
    const held = inMarket.filter((p) => p.shares > 0);
    const closed = inMarket.filter((p) => p.shares === 0);

    let totalCost = 0;
    let totalValue = 0;
    let pricedCost = 0;
    let missing = 0;
    let realized = 0;
    for (const p of inMarket) realized += p.realized;
    for (const p of held) {
        totalCost += p.totalCost;
        const q = ui.quotes[p.key];
        const v = valuePosition(p, q && q.price);
        if (v.marketValue === null) {
            missing += 1;
        } else {
            totalValue += v.marketValue;
            pricedCost += p.totalCost;
        }
    }
    const pricedCount = held.length - missing;
    const hasPrices = pricedCount > 0; // 一檔現價都沒有時，市值與未實現損益顯示「--」，不要誤顯示成 0
    const unrealized = hasPrices ? totalValue - pricedCost : null;
    const unrealizedPct = hasPrices && pricedCost > 0 ? (unrealized / pricedCost) * 100 : null;
    const cur = CURRENCY[market];

    const summary = $(`pf-summary-${mkt}`);
    if (inMarket.length === 0) {
        summary.innerHTML = "";
        $(`pf-table-${mkt}`).innerHTML = "";
        $(`pf-empty-${mkt}`).hidden = false;
        $(`pf-note-${mkt}`).textContent = "";
        return;
    }
    $(`pf-empty-${mkt}`).hidden = true;

    const box = (label, value, cls = "") =>
        `<div class="stat-box"><span class="stat-label">${label}</span><div class="stat-value ${cls}">${value}</div></div>`;
    summary.innerHTML =
        box("持股成本", `${cur} ${money(totalCost, market)}`) +
        box("持股市值", hasPrices ? `${cur} ${money(totalValue, market)}` : "--") +
        box(
            "未實現損益",
            hasPrices ? `${signed(unrealized, market)}${Number.isFinite(unrealizedPct) ? `<br><small>${unrealizedPct > 0 ? "+" : ""}${unrealizedPct.toFixed(2)}%</small>` : ""}` : "--",
            pnlClass(unrealized)
        ) +
        box("已實現損益", signed(realized, market), pnlClass(realized)) +
        box(
            "總損益（已實現＋未實現）",
            held.length && !hasPrices ? "--" : signed(realized + (hasPrices ? unrealized : 0), market),
            held.length && !hasPrices ? "" : pnlClass(realized + (hasPrices ? unrealized : 0))
        );

    const rows = held
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((p) => {
            const q = ui.quotes[p.key];
            const v = valuePosition(p, q && q.price);
            const priceCell = v.price === null
                ? `<span title="${esc(q && q.error ? q.error : ui.quoteLoading ? "取得中" : "尚未取得報價")}">${ui.quoteLoading ? "取得中…" : "--"}</span>`
                : money(v.price, market, 2);
            return `<tr>
                <td><strong>${esc(p.symbol)}</strong><br><small>${esc(p.name)}</small></td>
                <td class="num">${fmtShares(p.shares)}</td>
                <td class="num">${money(p.avgCost, market, 2)}</td>
                <td class="num">${priceCell}</td>
                <td class="num">${money(v.marketValue, market)}</td>
                <td class="num">${pnlCell(v.unrealized, v.unrealizedPct, market)}</td>
                <td class="num ${pnlClass(p.realized)}">${Math.abs(p.realized) < 0.005 ? "--" : signed(p.realized, market)}</td>
            </tr>`;
        })
        .join("");
    $(`pf-table-${mkt}`).innerHTML = held.length
        ? `<div class="pf-table-wrap"><table class="pf-table">
            <thead><tr><th>股票</th><th class="num">股數</th><th class="num">均價</th><th class="num">現價</th><th class="num">市值</th><th class="num">未實現損益</th><th class="num">已實現損益</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : `<p class="card-subtext">目前沒有持股（全部賣出了）。</p>`;

    const notes = [];
    if (missing > 0) notes.push(`有 ${missing} 檔暫時取不到現價，市值與未實現損益的合計沒有包含它們。`);
    if (closed.length > 0) notes.push(`已全部賣出的股票（${closed.map((p) => esc(p.symbol)).join("、")}）的已實現損益有算進「已實現損益」。`);
    $(`pf-note-${mkt}`).innerHTML = notes.join("<br>");
}

function renderHoldings() {
    const { positions, errors } = computePositions(ui.transactions);
    renderMarket("TW", positions);
    renderMarket("US", positions);
    const errBox = $("pf-integrity-error");
    errBox.hidden = errors.length === 0;
    errBox.textContent = errors.length ? `資料有矛盾（可能是備份檔被改過）：${errors[0]}` : "";
    return positions;
}

// ------------------------------------------------------------
// 交易紀錄
// ------------------------------------------------------------
function renderTransactions() {
    const { sellPnl } = computePositions(ui.transactions);
    const list = [...ui.transactions].sort((a, b) =>
        a.date !== b.date ? (a.date < b.date ? 1 : -1) : (b.createdAt || 0) - (a.createdAt || 0)
    );
    $("pf-tx-empty").hidden = list.length > 0;
    $("pf-tx-wrap").hidden = list.length === 0;
    $("pf-tx-tbody").innerHTML = list
        .map((t) => {
            const pnl = sellPnl[t.id];
            return `<tr>
                <td>${esc(t.date)}</td>
                <td><span class="pf-badge pf-badge-${esc(t.type)}">${TYPE_LABEL[t.type]}</span></td>
                <td><strong>${esc(t.symbol)}</strong><br><small>${esc(t.name)} · ${t.market === "TW" ? "台股" : "美股"}</small></td>
                <td class="num">${fmtShares(t.shares)}</td>
                <td class="num">${money(t.price, t.market, 2)}</td>
                <td class="num">${money(t.fee, t.market)}</td>
                <td class="num">${money(t.tax, t.market)}</td>
                <td class="num ${pnlClass(pnl)}">${Number.isFinite(pnl) ? signed(pnl, t.market) : "--"}</td>
                <td>${esc(t.note)}</td>
                <td><button type="button" class="btn btn-sm btn-secondary pf-del" data-id="${esc(t.id)}">刪除</button></td>
            </tr>`;
        })
        .join("");
}

function renderAll() {
    renderHoldings();
    renderTransactions();
}

// ------------------------------------------------------------
// 報價
// ------------------------------------------------------------
export async function refreshPortfolioQuotes() {
    const { positions } = computePositions(ui.transactions);
    const held = Object.values(positions).filter((p) => p.shares > 0);
    if (held.length === 0) {
        renderHoldings();
        return;
    }
    ui.quoteLoading = true;
    renderHoldings();
    await Promise.all(
        held.map(async (p) => {
            try {
                const q = await fetchQuoteFor({ symbol: p.symbol, market: p.market });
                ui.quotes[p.key] = { price: q.price, asOf: q.asOf, error: null };
            } catch (err) {
                // 抓失敗時保留上一次成功的價格（若有），不要憑空填數字
                const prev = ui.quotes[p.key];
                ui.quotes[p.key] = prev && Number.isFinite(prev.price) ? { ...prev, error: err.message } : { price: null, asOf: null, error: err.message };
            }
        })
    );
    ui.quoteLoading = false;
    renderHoldings();
    const asOfs = held.map((p) => ui.quotes[p.key] && ui.quotes[p.key].asOf).filter(Boolean);
    $("pf-quote-note").textContent = asOfs.length
        ? "台股現價是證交所最近一個交易日的收盤價（不是盤中即時價）；美股現價來自 Twelve Data。"
        : "";
}

// ------------------------------------------------------------
// 表單
// ------------------------------------------------------------
function formValues() {
    return {
        type: $("pf-type").value,
        market: $("pf-market").value,
        symbol: $("pf-symbol").value.trim().toUpperCase(),
        date: $("pf-date").value,
        shares: Number($("pf-shares").value),
        price: Number($("pf-price").value),
        fee: $("pf-fee").value === "" ? 0 : Number($("pf-fee").value),
        tax: $("pf-tax").value === "" ? 0 : Number($("pf-tax").value),
        note: $("pf-note").value.trim()
    };
}

function syncAutoFields() {
    const v = formValues();
    const isOpen = v.type === "open";
    $("pf-price-label").textContent = isOpen ? "均價（每股成本）" : "成交價（每股）";
    $("pf-fee-field").hidden = isOpen;
    $("pf-tax-field").hidden = v.type !== "sell" || v.market !== "TW";
    if (isOpen) {
        $("pf-fee").value = "";
        $("pf-tax").value = "";
        return;
    }
    const ready = v.shares > 0 && v.price > 0;
    if ($("pf-fee").dataset.auto !== "0") {
        $("pf-fee").value = ready && v.market === "TW" ? String(estimateFee(v.market, v.shares, v.price, ui.settings)) : "";
    }
    if ($("pf-tax").dataset.auto !== "0") {
        $("pf-tax").value = ready && v.type === "sell" && v.market === "TW" ? String(estimateTax(v.market, v.type, v.symbol, v.shares, v.price)) : "";
    }
    $("pf-fee-hint").textContent = v.market === "TW" ? "已依手續費設定自動試算，可直接改成券商實際扣的金額" : "美股請填券商實際收的手續費（沒有就留空）";
}

function showFormError(msg) {
    const box = $("pf-form-error");
    box.textContent = msg || "";
    box.hidden = !msg;
}

async function handleSubmit(e) {
    e.preventDefault();
    showFormError("");
    const v = formValues();
    const submitBtn = $("pf-submit");
    submitBtn.disabled = true;
    try {
        let name = v.symbol;
        let warn = "";
        if (v.market === "TW") {
            const found = v.symbol ? await lookupTwStockName(v.symbol) : null;
            if (found) name = found;
            else if (v.symbol) warn = "證交所上市資料裡找不到這個代號（可能是上櫃或興櫃股票），已照你輸入的記錄，但無法自動取得現價。";
        }
        const candidate = {
            id: newTransactionId(),
            createdAt: Date.now(),
            type: v.type,
            market: v.market,
            symbol: v.symbol,
            name,
            date: v.date,
            shares: v.shares,
            price: v.price,
            fee: v.type === "open" ? 0 : v.fee,
            tax: v.type === "sell" ? v.tax : 0,
            note: v.note
        };
        const problem = validateNewTransaction(ui.transactions, candidate);
        if (problem) {
            showFormError(problem);
            return;
        }
        const next = [...ui.transactions, candidate];
        if (!saveTransactions(next)) {
            showFormError("儲存失敗（瀏覽器可能封鎖了本機儲存空間），這筆沒有記錄。");
            return;
        }
        ui.transactions = next;
        $("pf-shares").value = "";
        $("pf-price").value = "";
        $("pf-note").value = "";
        $("pf-fee").dataset.auto = "1";
        $("pf-tax").dataset.auto = "1";
        syncAutoFields();
        renderAll();
        if (warn) showFormError(`已記錄。注意：${warn}`);
        refreshPortfolioQuotes();
    } finally {
        submitBtn.disabled = false;
    }
}

function handleDelete(e) {
    const btn = e.target.closest(".pf-del");
    if (!btn) return;
    const id = btn.dataset.id;
    const tx = ui.transactions.find((t) => t.id === id);
    if (!tx) return;
    const problem = validateDeletion(ui.transactions, id);
    if (problem) {
        window.alert(problem);
        return;
    }
    if (!window.confirm(`確定要刪除這筆紀錄嗎？\n${tx.date} ${TYPE_LABEL[tx.type]} ${tx.symbol} ${tx.shares} 股 @ ${tx.price}`)) return;
    const next = ui.transactions.filter((t) => t.id !== id);
    if (saveTransactions(next)) {
        ui.transactions = next;
        renderAll();
        refreshPortfolioQuotes();
    }
}

// ------------------------------------------------------------
// 設定與備份
// ------------------------------------------------------------
function initSettings() {
    $("pf-discount").value = String(Math.round(ui.settings.twFeeDiscount * 100) / 10); // 0.6 -> 6 折
    $("pf-minfee").value = String(ui.settings.twMinFee);
    const onChange = () => {
        const disc = Number($("pf-discount").value);
        const minFee = Number($("pf-minfee").value);
        if (disc > 0 && disc <= 10) ui.settings.twFeeDiscount = disc / 10;
        if (Number.isFinite(minFee) && minFee >= 0) ui.settings.twMinFee = minFee;
        saveSettings(ui.settings);
        $("pf-fee").dataset.auto = "1";
        $("pf-tax").dataset.auto = "1";
        syncAutoFields();
    };
    $("pf-discount").addEventListener("change", onChange);
    $("pf-minfee").addEventListener("change", onChange);
}

function exportBackup() {
    const blob = new Blob([buildBackup(ui.transactions, ui.settings)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `portfolio-backup-${todayLocal()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const msg = $("pf-backup-msg");
    try {
        const parsed = parseBackup(await file.text());
        if (!window.confirm(`備份檔裡有 ${parsed.transactions.length} 筆紀錄。\n匯入會「取代」目前這個瀏覽器裡的所有持股紀錄（目前有 ${ui.transactions.length} 筆），確定嗎？`)) return;
        if (!saveTransactions(parsed.transactions)) throw new Error("儲存失敗（瀏覽器可能封鎖了本機儲存空間）");
        ui.transactions = parsed.transactions;
        ui.settings = parsed.settings;
        saveSettings(ui.settings);
        initSettings();
        renderAll();
        refreshPortfolioQuotes();
        msg.textContent = `匯入完成，共 ${parsed.transactions.length} 筆。`;
        msg.className = "card-subtext";
    } catch (err) {
        msg.textContent = `匯入失敗：${err.message}`;
        msg.className = "data-error";
    }
}

// ------------------------------------------------------------
// 對外
// ------------------------------------------------------------
export function initPortfolio() {
    ui.transactions = loadTransactions();
    $("pf-date").value = todayLocal();
    initSettings();
    syncAutoFields();
    renderAll();

    $("pf-form").addEventListener("submit", handleSubmit);
    ["pf-type", "pf-market", "pf-symbol", "pf-shares", "pf-price"].forEach((id) => {
        $(id).addEventListener("input", () => {
            if (id === "pf-type" || id === "pf-market" || id === "pf-symbol") {
                $("pf-fee").dataset.auto = "1";
                $("pf-tax").dataset.auto = "1";
            }
            syncAutoFields();
        });
    });
    $("pf-fee").addEventListener("input", () => { $("pf-fee").dataset.auto = "0"; });
    $("pf-tax").addEventListener("input", () => { $("pf-tax").dataset.auto = "0"; });
    $("pf-tx-tbody").addEventListener("click", handleDelete);
    $("pf-export").addEventListener("click", exportBackup);
    $("pf-import").addEventListener("change", importBackup);
}

export function onPortfolioShown() {
    renderAll();
    refreshPortfolioQuotes();
}
