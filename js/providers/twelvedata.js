// ============================================================
// Twelve Data 資料來源
// 用於：美股報價/歷史股價、國際黃金 (XAU/USD)、美金兌台幣匯率
// 需要在 js/config.js 填入你自己申請的免費 API 金鑰
// 免費方案文件： https://twelvedata.com/pricing
//
// 免費方案通常有速率限制（例如每分鐘幾次、每天幾次請求），
// 所以這裡的呼叫頻率由 config.js 的 REFRESH_INTERVAL_MS 控制，
// 不會像原本的展示版一樣每 3 秒狂打一次。
// ============================================================

const BASE_URL = "https://api.twelvedata.com";

function getApiKey() {
    const key = window.APP_CONFIG && window.APP_CONFIG.TWELVE_DATA_API_KEY;
    if (!key || key === "YOUR_TWELVE_DATA_API_KEY") {
        throw new Error("尚未設定 Twelve Data API 金鑰，請先在 js/config.js 中填入你的金鑰");
    }
    return key;
}

async function callTwelveData(path, params) {
    const apikey = getApiKey();
    const query = new URLSearchParams({ ...params, apikey });
    const res = await fetch(`${BASE_URL}${path}?${query.toString()}`);
    const data = await res.json();

    // Twelve Data 錯誤時仍然回傳 HTTP 200，但 JSON 裡會有 status: "error"
    if (data && data.status === "error") {
        throw new Error(`Twelve Data 錯誤：${data.message || "未知錯誤"}`);
    }
    if (!res.ok) {
        throw new Error(`Twelve Data 回應失敗 (HTTP ${res.status})`);
    }
    return data;
}

function normalizeQuote(raw, fallbackSymbol) {
    const price = parseFloat(raw.close);
    const prevClose = parseFloat(raw.previous_close);
    const change = raw.change !== undefined ? parseFloat(raw.change) : price - prevClose;
    const changePercent =
        raw.percent_change !== undefined
            ? parseFloat(raw.percent_change)
            : prevClose
            ? (change / prevClose) * 100
            : 0;

    return {
        symbol: raw.symbol || fallbackSymbol,
        name: raw.name || fallbackSymbol,
        price,
        open: parseFloat(raw.open),
        high: parseFloat(raw.high),
        low: parseFloat(raw.low),
        prevClose,
        change,
        changePercent,
        asOf: raw.datetime || "",
        isRealtime: true,
        source: "twelvedata"
    };
}

// 美股（或任何 Twelve Data 支援的市場）即時報價
export async function getUsStockQuote(symbol) {
    const raw = await callTwelveData("/quote", { symbol });
    return normalizeQuote(raw, symbol);
}

// 國際黃金即時報價 (單位：USD / 盎司)
export async function getGoldQuoteUsd() {
    const raw = await callTwelveData("/quote", { symbol: "XAU/USD" });
    return normalizeQuote(raw, "XAU/USD");
}

// 美金兌台幣匯率，失敗時由呼叫端自行決定是否使用 config 的備援值
export async function getUsdTwdRate() {
    const raw = await callTwelveData("/exchange_rate", { symbol: "USD/TWD" });
    const rate = parseFloat(raw.rate);
    if (!rate) throw new Error("無法解析美金兌台幣匯率");
    return rate;
}

// 30 天日線歷史資料，回傳 [{date, price}, ...]，由舊到新排序
export async function getHistory(symbol, days = 30) {
    const raw = await callTwelveData("/time_series", {
        symbol,
        interval: "1day",
        outputsize: String(days)
    });
    if (!raw.values) throw new Error("Twelve Data 沒有回傳歷史資料");
    return raw.values
        .map((v) => ({ date: v.datetime, price: parseFloat(v.close) }))
        .reverse(); // Twelve Data 預設是新到舊，翻轉成舊到新方便畫圖
}
