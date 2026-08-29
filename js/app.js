// ============================================================
// 小資芽理財 - 主程式
// 串接真實資料來源（台灣證交所公開資料 + Twelve Data），
// 取代原本展示版用 Math.random() 模擬出來的假報價。
// ============================================================

import { getTwStockQuote, getTwStockHistoryPoints } from "./providers/twse.js";
import {
    getGoldQuoteUsd,
    getUsdTwdRate,
    getHistory as getTwelveDataHistory
} from "./providers/twelvedata.js";
import {
    loadWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    fetchQuoteFor
} from "./watchlist.js";
import { hasFinnhubKey, getUsCompanyNews, buildNewsSearchLinks } from "./providers/news.js";

const CFG = window.APP_CONFIG || {};
const TAEL_TO_OZ = 1.2057; // 1 台兩 ≈ 1.2057 盎司 (37.5g / 31.1035g)
const GRAM_TO_OZ = 1 / 31.1035;

const TARGETS = {
    ring: { name: "可愛黃金小戒指 💍", weightTael: 0.1 },
    bar: { name: "小熊金條 🐻🪙", weightTael: 0.267 },
    cup: { name: "黃金富貴杯 🏆", weightTael: 1.0 }
};

const state = {
    goldQuote: null,
    usdToTwdRate: null,
    usdToTwdIsFallback: false,
    goldChartInstance: null,
    stockChartInstance: null,
    botPrices: null,
    activeBotTab: "coins",
    watchlist: [],
    watchlistQuotes: {}, // key: `${market}:${symbol}` -> quote
    watchlistErrors: {}, // key: `${market}:${symbol}` -> error message
    selectedStock: null, // { symbol, market, name }
    countdownInterval: null
};

function hasApiKey() {
    return !!CFG.TWELVE_DATA_API_KEY && CFG.TWELVE_DATA_API_KEY !== "YOUR_TWELVE_DATA_API_KEY";
}

function fmtMoney(n, digits = 0) {
    if (n === null || n === undefined || Number.isNaN(n)) return "--";
    return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Twelve Data 免費方案「每分鐘 8 次」的額度很容易被用光，遇到這種狀況時
// 顯示比較安心、看得懂的中文說明，而不是直接丟英文原始錯誤訊息給使用者看。
function friendlyErrorMessage(rawMessage) {
    if (!rawMessage) return rawMessage;
    if (/run out of api credits|credits for the current minute/i.test(rawMessage)) {
        return "Twelve Data 免費方案這一分鐘的用量已經用完了（免費方案限制：每分鐘最多 8 次），網站已經盡量快取資料減少用量，通常等 1 分鐘後重新整理網頁就會恢復正常，不是網站壞掉。";
    }
    return rawMessage;
}

function changeBadge(change, percent) {
    const sign = change >= 0 ? "+" : "";
    const dirClass = change >= 0 ? "up" : "down";
    const arrow = change >= 0 ? "▲" : "▼";
    return {
        html: `${arrow} ${sign}${fmtMoney(change, 2)} (${sign}${fmtMoney(percent, 2)}%)`,
        cls: `price-change ${dirClass}`
    };
}

// ------------------------------------------------------------
// 黃金專區
// ------------------------------------------------------------
async function refreshGold() {
    const errEl = document.getElementById("gold-error");
    errEl.hidden = true;

    try {
        const [goldQuote, fxRate] = await Promise.all([
            getGoldQuoteUsd(),
            getUsdTwdRate().catch(() => {
                state.usdToTwdIsFallback = true;
                return CFG.FALLBACK_USD_TWD_RATE;
            })
        ]);
        state.goldQuote = goldQuote;
        state.usdToTwdRate = fxRate;
        if (fxRate !== CFG.FALLBACK_USD_TWD_RATE) state.usdToTwdIsFallback = false;

        renderGoldBoard();
        runCalculator();
        updateSavingsPlanner();
        loadGoldHistory();
    } catch (err) {
        console.error("更新國際金價失敗：", err);
        errEl.textContent = hasApiKey()
            ? `暫時無法取得國際金價：${friendlyErrorMessage(err.message)}`
            : "尚未設定 Twelve Data API 金鑰，請至 js/config.js 設定後即可看到真實金價。";
        errEl.hidden = false;
    }
}

function renderGoldBoard() {
    const q = state.goldQuote;
    if (!q) return;

    const usdEl = document.getElementById("usd-price");
    const twdEl = document.getElementById("twd-price");
    const usdChangeEl = document.getElementById("usd-change");
    const twdChangeEl = document.getElementById("twd-change");

    usdEl.innerHTML = `${fmtMoney(q.price, 2)}<span class="price-unit">USD / 盎司</span>`;

    const twdTaelPrice = q.price * TAEL_TO_OZ * state.usdToTwdRate;
    twdEl.innerHTML = `${fmtMoney(Math.round(twdTaelPrice))}<span class="price-unit">TWD / 台兩</span>`;

    const usdBadge = changeBadge(q.change, q.changePercent);
    usdChangeEl.className = usdBadge.cls;
    usdChangeEl.innerHTML = usdBadge.html;

    const twdDiff = q.change * TAEL_TO_OZ * state.usdToTwdRate;
    const twdPercent = q.changePercent; // 換算成台幣後漲跌幅相同（假設匯率沒有同時劇烈變動）
    const twdBadge = changeBadge(twdDiff, twdPercent);
    twdChangeEl.className = twdBadge.cls;
    twdChangeEl.innerHTML = twdBadge.html;

    const timeEl = document.getElementById("update-time");
    const fxNote = state.usdToTwdIsFallback ? "（匯率為備援手動值，非即時）" : "";
    timeEl.textContent = `最後更新時間：${new Date().toLocaleTimeString("zh-TW")}${fxNote}`;
}

async function loadGoldHistory() {
    const noteEl = document.getElementById("gold-chart-note");
    try {
        const points = await getTwelveDataHistory("XAU/USD", 30);
        drawChart("goldChart", "goldChartInstance", points, "國際金價 (USD/盎司)", "#FFB830");
        noteEl.textContent = "資料來源：Twelve Data 日線資料（近 30 個交易日）。";
    } catch (err) {
        noteEl.textContent = `目前無法取得歷史金價走勢：${friendlyErrorMessage(err.message)}`;
    }
}

function runCalculator() {
    const amountInput = document.getElementById("calc-amount");
    const unitSelect = document.getElementById("calc-unit");
    const resultUsd = document.getElementById("result-usd");
    const resultTwd = document.getElementById("result-twd");

    if (!state.goldQuote || !state.usdToTwdRate) return;

    const value = parseFloat(amountInput.value) || 0;
    const unit = unitSelect.value;

    let weightInOz = 0;
    if (unit === "gram") weightInOz = value * GRAM_TO_OZ;
    else if (unit === "oz") weightInOz = value;
    else if (unit === "tael") weightInOz = value * TAEL_TO_OZ;

    const totalUsd = weightInOz * state.goldQuote.price;
    const totalTwd = totalUsd * state.usdToTwdRate;

    resultUsd.textContent = `$${fmtMoney(totalUsd, 2)} USD`;
    resultTwd.textContent = `${fmtMoney(Math.round(totalTwd))} TWD`;
}

function updateSavingsPlanner() {
    const selectEl = document.getElementById("target-select");
    const savedInput = document.getElementById("saved-amount");
    const progressFill = document.getElementById("progress-fill");
    const progressPercentText = document.getElementById("progress-percent-text");
    const plannerStatusText = document.getElementById("planner-status-text");

    if (!state.goldQuote || !state.usdToTwdRate) return;

    const targetObj = TARGETS[selectEl.value];
    const savedAmount = parseFloat(savedInput.value) || 0;

    const weightInOz = targetObj.weightTael * TAEL_TO_OZ;
    const targetCostTwd = weightInOz * state.goldQuote.price * state.usdToTwdRate;

    document.getElementById("target-cost-twd").textContent = `${fmtMoney(Math.round(targetCostTwd))} TWD`;

    let pct = (savedAmount / targetCostTwd) * 100;
    pct = Math.max(0, Math.min(100, pct));

    progressFill.style.width = `${pct}%`;
    progressPercentText.textContent = `儲蓄進度：${pct.toFixed(1)}%`;

    if (pct >= 100) {
        plannerStatusText.textContent = `哇！恭喜你已經可以買下【${targetObj.name}】囉！🎉✨`;
    } else {
        const remaining = targetCostTwd - savedAmount;
        plannerStatusText.textContent = `距離夢想【${targetObj.name}】還差 ${fmtMoney(Math.round(remaining))} TWD，加油！💪`;
    }
}

// ------------------------------------------------------------
// 台灣銀行實體金條/金幣參考牌價（人工整理的靜態資料）
// ------------------------------------------------------------
async function loadBotPrices() {
    try {
        const response = await fetch("data/bot_gold_prices.json");
        if (!response.ok) throw new Error("讀取失敗");
        const data = await response.json();
        state.botPrices = data;

        document.getElementById("bot-prices-time").textContent =
            `人工整理更新時間：${data.retrieval_time}（此區塊非即時資料，請見下方說明）`;

        renderBotPrices(state.activeBotTab);
    } catch (err) {
        console.error("Error loading BOT prices:", err);
        document.getElementById("bot-prices-tbody").innerHTML = `
            <tr><td colspan="4" style="padding: 20px; text-align: center; color: var(--accent-red); font-weight:700;">
                暫時無法載入台銀參考牌價資料。
            </td></tr>`;
    }
}

function renderBotPrices(tabName) {
    if (!state.botPrices) return;
    const tbody = document.getElementById("bot-prices-tbody");
    let html = "";

    if (tabName === "coins") {
        const coinTypes = [
            { id: "kangaroo_gold_coin", name: "🐨 澳洲袋鼠金幣" },
            { id: "maple_leaf_gold_coin", name: "🍁 加拿大楓葉金幣" },
            { id: "royal_kangaroo_gold_coin", name: "👑 皇家袋鼠金幣" },
            { id: "philharmonic_gold_coin", name: "🎻 維也納愛樂金幣" }
        ];
        coinTypes.forEach((coin) => {
            const dataObj = state.botPrices[coin.id];
            if (!dataObj) return;
            Object.keys(dataObj).forEach((weight) => {
                if (weight === "全套合計") return;
                const pricing = dataObj[weight];
                const sellText = pricing.sell ? `${pricing.sell.toLocaleString()} 元` : "--";
                const buyText = pricing.buy ? `${pricing.buy.toLocaleString()} 元` : "--";
                html += `<tr style="border-bottom: 1px solid #FFF6E5; height: 50px;">
                    <td style="padding: 10px; font-weight: 700; color: var(--text-main);">${coin.name}</td>
                    <td style="padding: 10px; font-weight: 600; color: var(--text-muted);">${weight}</td>
                    <td style="padding: 10px; font-weight: 900; color: var(--accent-red); text-align: right;">${sellText}</td>
                    <td style="padding: 10px; font-weight: 900; color: var(--accent-green); text-align: right;">${buyText}</td>
                </tr>`;
            });
        });
    } else if (tabName === "bars") {
        const barData = state.botPrices.gold_bars;
        if (barData) {
            Object.keys(barData).forEach((weight) => {
                const pricing = barData[weight];
                const sellText = pricing.sell ? `${pricing.sell.toLocaleString()} 元` : "--";
                html += `<tr style="border-bottom: 1px solid #FFF6E5; height: 50px;">
                    <td style="padding: 10px; font-weight: 700; color: var(--text-main);">🧱 臺銀黃金條塊 (無買回價)</td>
                    <td style="padding: 10px; font-weight: 600; color: var(--text-muted);">${weight}</td>
                    <td style="padding: 10px; font-weight: 900; color: var(--accent-red); text-align: right;">${sellText}</td>
                    <td style="padding: 10px; font-weight: 900; color: var(--text-muted); text-align: right;">--</td>
                </tr>`;
            });
        }
        const diamondBar = state.botPrices.bot_gold_diamond_bar;
        if (diamondBar && diamondBar["1 台兩"]) {
            const pricing = diamondBar["1 台兩"];
            html += `<tr style="border-bottom: 1px solid #FFF6E5; height: 50px;">
                <td style="padding: 10px; font-weight: 700; color: var(--text-main);">💎 臺銀金鑽條塊 (可買回)</td>
                <td style="padding: 10px; font-weight: 600; color: var(--text-muted);">1 台兩 (十錢)</td>
                <td style="padding: 10px; font-weight: 900; color: var(--accent-red); text-align: right;">${pricing.sell ? pricing.sell.toLocaleString() + " 元" : "--"}</td>
                <td style="padding: 10px; font-weight: 900; color: var(--accent-green); text-align: right;">${pricing.buy ? pricing.buy.toLocaleString() + " 元" : "--"}</td>
            </tr>`;
        }
        const rainbowBar = state.botPrices.starlight_gold_bar;
        if (rainbowBar) {
            ["1 台兩", "1 英兩", "10 公克", "5 公克", "1 公克"].forEach((weight) => {
                const pricing = rainbowBar[weight];
                if (!pricing) return;
                html += `<tr style="border-bottom: 1px solid #FFF6E5; height: 50px;">
                    <td style="padding: 10px; font-weight: 700; color: var(--text-main);">🌈 幻彩條塊 (Starlight Bar)</td>
                    <td style="padding: 10px; font-weight: 600; color: var(--text-muted);">${weight}</td>
                    <td style="padding: 10px; font-weight: 900; color: var(--accent-red); text-align: right;">${pricing.sell ? pricing.sell.toLocaleString() + " 元" : "--"}</td>
                    <td style="padding: 10px; font-weight: 900; color: var(--accent-green); text-align: right;">${pricing.buy ? pricing.buy.toLocaleString() + " 元" : "--"}</td>
                </tr>`;
            });
        }
    }
    tbody.innerHTML = html;
}

window.switchBotTab = function (tabName) {
    state.activeBotTab = tabName;
    const btnCoins = document.getElementById("btn-tab-coins");
    const btnBars = document.getElementById("btn-tab-bars");
    if (tabName === "coins") {
        btnCoins.style.backgroundColor = "var(--primary-color)";
        btnCoins.style.color = "white";
        btnBars.style.backgroundColor = "white";
        btnBars.style.color = "var(--text-main)";
    } else {
        btnBars.style.backgroundColor = "var(--primary-color)";
        btnBars.style.color = "white";
        btnCoins.style.backgroundColor = "white";
        btnCoins.style.color = "var(--text-main)";
    }
    renderBotPrices(tabName);
};

// ------------------------------------------------------------
// 通用走勢圖繪製 (黃金 / 個股共用)
// ------------------------------------------------------------
function drawChart(canvasId, instanceKey, points, label, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (state[instanceKey]) {
        state[instanceKey].destroy();
        state[instanceKey] = null;
    }
    if (!points || points.length === 0) return;

    if (typeof Chart === "undefined") {
        // Chart.js 是從 CDN 載入的，如果網路連不到 CDN 就會發生這種情況。
        // 安靜地放棄畫圖，不要讓整個頁面因此壞掉。
        console.error("Chart.js 尚未載入成功，無法繪製走勢圖。");
        return;
    }

    const ctx = canvas.getContext("2d");
    state[instanceKey] = new Chart(ctx, {
        type: "line",
        data: {
            labels: points.map((p) => p.date.slice(5)),
            datasets: [
                {
                    label,
                    data: points.map((p) => p.price),
                    borderColor: color,
                    borderWidth: 4,
                    backgroundColor: `${color}26`,
                    fill: true,
                    tension: 0.35,
                    pointRadius: points.length > 1 ? 3 : 6,
                    pointBackgroundColor: color,
                    pointHoverRadius: 7
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: (ctx2) => `${label}: ${fmtMoney(ctx2.raw, 2)}` }
                }
            },
            scales: {
                y: { grid: { color: "rgba(0,0,0,0.06)" }, ticks: { font: { family: "Quicksand" } } },
                x: { grid: { display: false }, ticks: { font: { family: "Quicksand" } } }
            }
        }
    });
}

// ------------------------------------------------------------
// 自選股清單
// ------------------------------------------------------------
function watchlistKey(item) {
    return `${item.market}:${item.symbol}`;
}

function renderWatchlistGrid() {
    const grid = document.getElementById("watchlist-grid");
    grid.innerHTML = "";

    state.watchlist.forEach((item) => {
        const key = watchlistKey(item);
        const quote = state.watchlistQuotes[key];
        const card = document.createElement("div");
        card.className = "watchlist-card";
        if (state.selectedStock && watchlistKey(state.selectedStock) === key) {
            card.classList.add("selected");
        }

        const marketBadge = item.market === "TW" ? "🇹🇼 台股" : "🇺🇸 美股";

        const errorMsg = state.watchlistErrors[key];

        if (quote) {
            const badge = changeBadge(quote.change, quote.changePercent);
            card.innerHTML = `
                <button class="watchlist-remove" title="移除" data-symbol="${item.symbol}" data-market="${item.market}">×</button>
                <span class="watchlist-market-badge">${marketBadge}</span>
                <div class="watchlist-name">${quote.name || item.name}</div>
                <div class="watchlist-symbol">${item.symbol}</div>
                <div class="watchlist-price">${fmtMoney(quote.price, 2)}</div>
                <div class="${badge.cls}">${badge.html}</div>
            `;
        } else if (errorMsg) {
            card.innerHTML = `
                <button class="watchlist-remove" title="移除" data-symbol="${item.symbol}" data-market="${item.market}">×</button>
                <span class="watchlist-market-badge">${marketBadge}</span>
                <div class="watchlist-name">${item.name}</div>
                <div class="watchlist-symbol">${item.symbol}</div>
                <div class="watchlist-price-error" title="${errorMsg.replace(/"/g, "&quot;")}">⚠️ 無法取得報價</div>
            `;
        } else {
            card.innerHTML = `
                <button class="watchlist-remove" title="移除" data-symbol="${item.symbol}" data-market="${item.market}">×</button>
                <span class="watchlist-market-badge">${marketBadge}</span>
                <div class="watchlist-name">${item.name}</div>
                <div class="watchlist-symbol">${item.symbol}</div>
                <div class="watchlist-price">載入中...</div>
            `;
        }

        card.addEventListener("click", (e) => {
            if (e.target.classList.contains("watchlist-remove")) return;
            selectStock(item);
        });
        grid.appendChild(card);
    });

    grid.querySelectorAll(".watchlist-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const symbol = btn.dataset.symbol;
            const market = btn.dataset.market;
            state.watchlist = removeFromWatchlist(symbol, market);
            delete state.watchlistQuotes[`${market}:${symbol}`];
            if (state.selectedStock && state.selectedStock.symbol === symbol && state.selectedStock.market === market) {
                state.selectedStock = state.watchlist[0] || null;
                if (state.selectedStock) selectStock(state.selectedStock);
            }
            renderWatchlistGrid();
        });
    });
}

async function refreshWatchlistQuotes() {
    await Promise.all(
        state.watchlist.map(async (item) => {
            const key = watchlistKey(item);
            try {
                const quote = await fetchQuoteFor(item);
                state.watchlistQuotes[key] = quote;
                delete state.watchlistErrors[key];
            } catch (err) {
                console.error(`更新 ${item.symbol} 報價失敗：`, err.message);
                state.watchlistErrors[key] = friendlyErrorMessage(err.message);
            }
        })
    );
    renderWatchlistGrid();
    if (state.selectedStock) renderStockDetail(state.selectedStock);
}

async function selectStock(item) {
    state.selectedStock = item;
    renderWatchlistGrid();
    await renderStockDetail(item);
}

async function renderStockDetail(item) {
    const key = watchlistKey(item);
    let quote = state.watchlistQuotes[key];
    if (!quote) {
        try {
            quote = await fetchQuoteFor(item);
            state.watchlistQuotes[key] = quote;
        } catch (err) {
            document.getElementById("detail-stock-title").textContent = `${item.name} (${item.symbol})`;
            document.getElementById("stock-chart-note").textContent = `暫時無法取得報價：${friendlyErrorMessage(err.message)}`;
            document.getElementById("tw-extra-info").hidden = true;
            return;
        }
    }

    document.getElementById("detail-stock-title").textContent = `${quote.name} (${item.symbol}) 走勢與換算`;
    const badge = changeBadge(quote.change, quote.changePercent);
    const badgeEl = document.getElementById("detail-stock-badge");
    badgeEl.textContent = `${fmtMoney(quote.price, 2)} ${badge.html.replace(/<[^>]*>/g, "")}`;
    document.getElementById("detail-stock-asof").textContent = quote.asOf ? `資料時間：${quote.asOf}` : "";

    document.getElementById("detail-open").textContent = fmtMoney(quote.open, 2);
    document.getElementById("detail-prev-close").textContent = fmtMoney(quote.prevClose, 2);
    document.getElementById("detail-high").textContent = fmtMoney(quote.high, 2);
    document.getElementById("detail-low").textContent = fmtMoney(quote.low, 2);

    const noteEl = document.getElementById("stock-chart-note");
    const twExtraEl = document.getElementById("tw-extra-info");
    if (item.market === "TW") {
        const points = getTwStockHistoryPoints(item.symbol);
        drawChart("stockChart", "stockChartInstance", points, `${quote.name} (${item.symbol})`, "#74B9FF");
        noteEl.textContent =
            points.length < 5
                ? `台股走勢圖是每次你打開網站累積一筆真實收盤價，目前只有 ${points.length} 筆，持續使用會慢慢累積到 30 天喔！`
                : `目前已累積 ${points.length} 筆真實收盤價（每天最多新增一筆）。`;

        twExtraEl.hidden = false;
        renderKvTable("tw-valuation-table", quote.valuationRaw);
        renderKvTable("tw-institutional-table", quote.institutionalRaw);
        renderKvTable("tw-margin-table", quote.marginRaw);
        renderHighLowCard(points, quote.price, "TW");
    } else {
        let usPoints = [];
        try {
            usPoints = await getTwelveDataHistory(item.symbol, 30);
            drawChart("stockChart", "stockChartInstance", usPoints, `${quote.name} (${item.symbol})`, "#74B9FF");
            noteEl.textContent = "資料來源：Twelve Data 日線資料（近 30 個交易日）。";
        } catch (err) {
            noteEl.textContent = `目前無法取得歷史走勢：${friendlyErrorMessage(err.message)}`;
        }
        twExtraEl.hidden = true; // 這三塊是台股專屬的公開資料，美股沒有對應資料源
        renderHighLowCard(usPoints, quote.price, "US");
    }

    renderNewsSection(item, quote);

    runStockCalculator(quote, item.market);
    document.getElementById("stock-calc-shares").oninput = () => runStockCalculator(state.watchlistQuotes[key], item.market);
}

// 把證交所回傳的原始 key/value 物件畫成一個小表格。
// 故意直接使用證交所官方報表的中文欄位名稱當標籤，不重新翻譯，
// 這樣欄位名稱一定跟證交所公告的定義一致，不會因為我們自己亂翻譯而搞錯意思。
function renderKvTable(containerId, rawObj) {
    const container = document.getElementById(containerId);
    if (!rawObj || Object.keys(rawObj).length === 0) {
        container.innerHTML = `<div class="kv-empty">查無資料（可能當日尚未公布，或該股票不適用）</div>`;
        return;
    }

    const rows = Object.entries(rawObj)
        .map(([label, value]) => {
            const displayValue = value === "" || value === null || value === undefined ? "--" : value;
            return `<div class="kv-row"><span class="kv-label">${label}</span><span class="kv-value">${displayValue}</span></div>`;
        })
        .join("");
    container.innerHTML = rows;
}

// ------------------------------------------------------------
// 近期高低點參考資訊（不是投資建議，只是客觀的價格區間數字）
// ------------------------------------------------------------
function computeHighLowStats(points, currentPrice) {
    if (!points || points.length === 0 || !Number.isFinite(currentPrice)) return null;
    const prices = points.map((p) => p.price).filter((p) => Number.isFinite(p));
    if (prices.length === 0) return null;

    // 把「今天」的價格也算進區間裡，這樣「創新高/新低」才會包含最新這筆
    const periodHigh = Math.max(...prices, currentPrice);
    const periodLow = Math.min(...prices, currentPrice);
    const days = new Set(points.map((p) => p.date)).size;

    return {
        days,
        periodHigh,
        periodLow,
        belowHighPct: periodHigh ? ((periodHigh - currentPrice) / periodHigh) * 100 : 0,
        aboveLowPct: periodLow ? ((currentPrice - periodLow) / periodLow) * 100 : 0,
        isNewHigh: currentPrice >= periodHigh,
        isNewLow: currentPrice <= periodLow
    };
}

function renderHighLowCard(points, currentPrice, market) {
    const noteEl = document.getElementById("stock-highlow-note");
    const tableEl = document.getElementById("stock-highlow-table");
    const stats = computeHighLowStats(points, currentPrice);
    const unit = market === "TW" ? "TWD" : "USD";

    if (!stats || stats.days < 3) {
        noteEl.textContent = "";
        tableEl.innerHTML = `<div class="kv-empty">目前累積的價格資料還太少（僅 ${stats ? stats.days : 0} 筆），持續使用一段時間後就能看到高低點分析。</div>`;
        return;
    }

    noteEl.textContent = `統計範圍：目前已累積的近 ${stats.days} 個交易日資料`;

    const highLine = stats.isNewHigh
        ? `🚀 目前價位就是這段期間的最高價（創近 ${stats.days} 日新高）`
        : `低於期間最高價 ${fmtMoney(stats.belowHighPct, 1)}%`;
    const lowLine = stats.isNewLow
        ? `📉 目前價位就是這段期間的最低價（創近 ${stats.days} 日新低）`
        : `高於期間最低價 ${fmtMoney(stats.aboveLowPct, 1)}%`;

    tableEl.innerHTML = `
        <div class="kv-row"><span class="kv-label">期間最高價</span><span class="kv-value">${fmtMoney(stats.periodHigh, 2)} ${unit}</span></div>
        <div class="kv-row"><span class="kv-label">期間最低價</span><span class="kv-value">${fmtMoney(stats.periodLow, 2)} ${unit}</span></div>
        <div class="kv-row"><span class="kv-label">目前價位 vs 最高</span><span class="kv-value">${highLine}</span></div>
        <div class="kv-row"><span class="kv-label">目前價位 vs 最低</span><span class="kv-value">${lowLine}</span></div>
    `;
}

// ------------------------------------------------------------
// 相關新聞
// ------------------------------------------------------------
function renderSearchLinkList(container, links) {
    container.innerHTML = links
        .map((l) => `<div class="news-item"><a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label}</a></div>`)
        .join("");
}

async function renderNewsSection(item, quote) {
    const container = document.getElementById("stock-news-section");
    if (!container) return;
    const displayName = quote && quote.name ? quote.name : item.name || item.symbol;

    if (item.market === "TW") {
        container.innerHTML = `
            <p class="card-subtext">台股目前沒有找到「免費、可以直接從網頁抓取」的個股新聞 API，先提供搜尋捷徑，一鍵幫你查最新消息：</p>
        `;
        const linksEl = document.createElement("div");
        renderSearchLinkList(linksEl, buildNewsSearchLinks(displayName, item.symbol));
        container.appendChild(linksEl);
        return;
    }

    if (!hasFinnhubKey()) {
        container.innerHTML = `<p class="card-subtext">尚未設定 Finnhub 新聞金鑰（選填，見 js/config.js 說明），先提供搜尋捷徑：</p>`;
        const linksEl = document.createElement("div");
        renderSearchLinkList(linksEl, buildNewsSearchLinks(displayName));
        container.appendChild(linksEl);
        return;
    }

    container.innerHTML = `<p class="card-subtext">載入新聞中...</p>`;
    try {
        const news = await getUsCompanyNews(item.symbol);
        if (news.length === 0) {
            container.innerHTML = `<p class="card-subtext">最近 7 天內查無 ${item.symbol} 的相關新聞（資料來源：Finnhub）。</p>`;
            return;
        }
        container.innerHTML = news
            .map(
                (n) => `
            <div class="news-item">
                <a href="${n.url}" target="_blank" rel="noopener noreferrer">${n.headline}</a>
                <div class="news-meta">${n.source}${n.datetime ? " · " + n.datetime.toLocaleDateString("zh-TW") : ""}</div>
            </div>`
            )
            .join("");
    } catch (err) {
        container.innerHTML = `<p class="card-subtext">暫時無法取得新聞：${friendlyErrorMessage(err.message)}</p>`;
    }
}

function runStockCalculator(quote, market) {
    if (!quote) return;
    const sharesInput = document.getElementById("stock-calc-shares");
    const shares = parseInt(sharesInput.value, 10) || 0;
    const total = shares * quote.price;

    document.getElementById("stock-result-value").textContent =
        `${fmtMoney(Math.round(total))} ${market === "TW" ? "TWD" : "USD"}`;

    const noteEl = document.getElementById("stock-calc-note");
    if (market === "TW") {
        noteEl.textContent = `相當於 ${(shares / 1000).toFixed(3)} 張`;
    } else {
        noteEl.textContent = "美股沒有「張」的概念，通常直接以股為單位交易";
    }
}

async function handleAddStock(e) {
    e.preventDefault();
    const marketSelect = document.getElementById("add-stock-market");
    const symbolInput = document.getElementById("add-stock-symbol");
    const errEl = document.getElementById("add-stock-error");
    errEl.hidden = true;

    try {
        state.watchlist = await addToWatchlist(symbolInput.value, marketSelect.value);
        symbolInput.value = "";
        renderWatchlistGrid();
        await refreshWatchlistQuotes();
        const added = state.watchlist[state.watchlist.length - 1];
        selectStock(added);
    } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
    }
}

// ------------------------------------------------------------
// 台積電新手包（人工整理的教學內容，價格另外抓 2330 真實報價）
// ------------------------------------------------------------
async function loadTsmcFeatured() {
    try {
        const response = await fetch("data/tsmc_data.json");
        if (!response.ok) throw new Error("讀取失敗");
        const data = await response.json();

        document.getElementById("earnings-title").textContent = data.next_earnings_call.title;
        document.getElementById("earnings-desc").textContent = data.next_earnings_call.description;
        const dateStr = new Date(data.next_earnings_call.date).toLocaleString("zh-TW", {
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
        });
        document.getElementById("earnings-date").textContent = `活動日期：${dateStr} (${data.next_earnings_call.location})`;
        startCountdownTimer(data.next_earnings_call.date);

        document.getElementById("financials-quarter").textContent = data.recent_financials.quarter;
        const metricsContainer = document.getElementById("tsmc-metrics-container");
        metricsContainer.innerHTML = "";
        data.recent_financials.metrics.forEach((metric) => {
            const card = document.createElement("div");
            card.className = "metric-item-card";
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="display:flex; align-items:center; gap:8px; font-weight:700;">
                        <span>${metric.icon}</span><span>${metric.name}</span>
                    </div>
                    <div style="font-weight:900; color:var(--text-main); font-size:1.15rem;">
                        ${metric.value} <span style="font-size:0.75rem; color:var(--accent-red); font-weight:700; margin-left:4px;">${metric.growth}</span>
                    </div>
                </div>
                <div class="metric-detail">${metric.desc}</div>
            `;
            card.addEventListener("click", () => {
                const detail = card.querySelector(".metric-detail");
                const isOpen = card.classList.contains("open");
                document.querySelectorAll(".metric-item-card").forEach((item) => {
                    item.classList.remove("open");
                    item.querySelector(".metric-detail").style.maxHeight = "0";
                });
                if (!isOpen) {
                    card.classList.add("open");
                    detail.style.maxHeight = "120px";
                }
            });
            metricsContainer.appendChild(card);
        });

        const faqContainer = document.getElementById("tsmc-faq-container");
        faqContainer.innerHTML = "";
        data.faq.forEach((item) => {
            const faqCard = document.createElement("div");
            faqCard.className = "guide-card";
            faqCard.innerHTML = `
                <div class="guide-icon" style="background-color: #EBF8FF; color: #2B6CB0;">💡</div>
                <h3 class="guide-title">${item.q}</h3>
                <p class="guide-text">${item.a}</p>
            `;
            faqContainer.appendChild(faqCard);
        });
    } catch (err) {
        console.error("Error loading TSMC featured data:", err);
    }
}

function startCountdownTimer(targetDateStr) {
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    const targetDate = new Date(targetDateStr).getTime();
    const daysEl = document.getElementById("countdown-days");
    const hoursEl = document.getElementById("countdown-hours");
    const minsEl = document.getElementById("countdown-mins");
    const secsEl = document.getElementById("countdown-secs");

    function tick() {
        const diff = targetDate - Date.now();
        if (diff <= 0) {
            clearInterval(state.countdownInterval);
            [daysEl, hoursEl, minsEl, secsEl].forEach((el) => (el.textContent = "00"));
            document.getElementById("earnings-desc").textContent = "💡 法說會召開中！趕快關注最新消息公告！🎉";
            return;
        }
        daysEl.textContent = String(Math.floor(diff / 86400000)).padStart(2, "0");
        hoursEl.textContent = String(Math.floor((diff % 86400000) / 3600000)).padStart(2, "0");
        minsEl.textContent = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
        secsEl.textContent = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    }
    tick();
    state.countdownInterval = setInterval(tick, 1000);
}

// ------------------------------------------------------------
// 分頁切換
// ------------------------------------------------------------
window.switchPage = function (pageName) {
    const goldSection = document.getElementById("dashboard");
    const watchlistSection = document.getElementById("watchlist-section");
    const navGold = document.getElementById("nav-gold");
    const navWatchlist = document.getElementById("nav-watchlist");

    const heroBadge = document.getElementById("hero-badge");
    const heroTitle = document.getElementById("hero-title");
    const heroDesc = document.getElementById("hero-desc");
    const heroBtnPrimary = document.getElementById("hero-btn-primary");
    const heroBtnSecondary = document.getElementById("hero-btn-secondary");

    if (pageName === "gold") {
        goldSection.style.display = "block";
        watchlistSection.style.display = "none";
        navGold.classList.add("active");
        navWatchlist.classList.remove("active");

        heroBadge.textContent = "✨ 專為理財新手打造的避險入門課";
        heroTitle.innerHTML = "理財第一步！<br>跟著小芽認識 <span>國際黃金</span>";
        heroDesc.textContent = "覺得投資很難、數字很冰冷嗎？別擔心！黃金是世界上最古老也最安穩的「避險守護神」。讓我們用最簡單、最可愛的方式，一起看懂金價波動，規劃你的第一筆黃金夢想基金吧！";
        heroBtnPrimary.textContent = "看國際金價 📊";
        heroBtnPrimary.href = "#dashboard";
        heroBtnSecondary.textContent = "黃金新手包 💡";
        heroBtnSecondary.href = "#guide";
    } else {
        goldSection.style.display = "none";
        watchlistSection.style.display = "block";
        navWatchlist.classList.add("active");
        navGold.classList.remove("active");

        heroBadge.textContent = "📈 想追蹤哪支股票，自己加進來！";
        heroTitle.innerHTML = "打造你的<br>專屬 <span>自選股清單</span>";
        heroDesc.textContent = "不管是台股還是美股，輸入代號就能加進你的自選股清單，隨時掌握報價變化。小芽也幫你準備了台積電的深入介紹，帶你認識法說會與財報怎麼看！";
        heroBtnPrimary.textContent = "看我的自選股 📊";
        heroBtnPrimary.href = "#watchlist-section";
        heroBtnSecondary.textContent = "台積電新手包 📢";
        heroBtnSecondary.href = "#events-section-title";

        if (state.stockChartInstance) state.stockChartInstance.resize();
    }
};

// ------------------------------------------------------------
// 初始化
// ------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("api-key-banner").hidden = hasApiKey();

    // 黃金專區
    refreshGold();
    loadBotPrices();

    document.getElementById("calc-amount").addEventListener("input", runCalculator);
    document.getElementById("calc-unit").addEventListener("change", runCalculator);
    document.getElementById("target-select").addEventListener("change", updateSavingsPlanner);
    document.getElementById("saved-amount").addEventListener("input", updateSavingsPlanner);

    // 自選股
    state.watchlist = loadWatchlist();
    renderWatchlistGrid();
    refreshWatchlistQuotes().then(() => {
        if (state.watchlist.length > 0) selectStock(state.watchlist[0]);
    });
    document.getElementById("add-stock-form").addEventListener("submit", handleAddStock);

    // 台積電新手包
    loadTsmcFeatured();

    // 定期更新 (預設每 60 秒，可在 js/config.js 調整)
    const refreshMs = CFG.REFRESH_INTERVAL_MS || 60000;
    document.getElementById("gold-refresh-note").textContent = `每 ${Math.round(refreshMs / 1000)} 秒自動更新一次`;
    document.getElementById("watchlist-refresh-note").textContent = `${Math.round(refreshMs / 1000)}`;
    setInterval(() => {
        refreshGold();
        refreshWatchlistQuotes();
    }, refreshMs);

    // FAQ Accordion
    document.querySelectorAll(".faq-question").forEach((q) => {
        q.addEventListener("click", () => {
            const parent = q.parentElement;
            const isOpen = parent.classList.contains("open");
            document.querySelectorAll(".faq-item").forEach((item) => item.classList.remove("open"));
            if (!isOpen) parent.classList.add("open");
        });
    });
});
