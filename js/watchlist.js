// ============================================================
// 自選股清單
// 依照你的需求：清單存在「瀏覽器本機」(localStorage)，
// 不需要註冊帳號、不會同步到別台裝置或別的瀏覽器。
// ============================================================

import { getTwStockQuote, lookupTwStockName } from "./providers/twse.js";
import { getUsStockQuote } from "./providers/twelvedata.js";

const STORAGE_KEY = "watchlist_v1";

export function loadWatchlist() {
    let list;
    try {
        list = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
        list = null;
    }
    if (!Array.isArray(list)) {
        list = (window.APP_CONFIG && window.APP_CONFIG.DEFAULT_WATCHLIST) || [];
        saveWatchlist(list);
    }
    return list;
}

export function saveWatchlist(list) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
        console.error("無法儲存自選股清單到 localStorage：", err);
    }
}

function isDuplicate(list, symbol, market) {
    return list.some(
        (item) => item.symbol.toUpperCase() === symbol.toUpperCase() && item.market === market
    );
}

// 新增一檔股票；台股會自動去查中文名稱，美股先用代號當名稱顯示
export async function addToWatchlist(rawSymbol, market) {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol) throw new Error("請輸入股票代號");

    const list = loadWatchlist();
    if (isDuplicate(list, symbol, market)) {
        throw new Error("這檔股票已經在你的自選股清單裡囉！");
    }

    let name = symbol;
    if (market === "TW") {
        const found = await lookupTwStockName(symbol);
        if (!found) {
            throw new Error(`在台灣證交所資料中找不到股號「${symbol}」，請確認代號是否正確`);
        }
        name = found;
    }

    list.push({ symbol, market, name });
    saveWatchlist(list);
    return list;
}

export function removeFromWatchlist(symbol, market) {
    const list = loadWatchlist().filter(
        (item) => !(item.symbol === symbol && item.market === market)
    );
    saveWatchlist(list);
    return list;
}

// 依照 market 呼叫對應的資料來源，並統一回傳格式
export async function fetchQuoteFor(item) {
    if (item.market === "TW") {
        return getTwStockQuote(item.symbol);
    }
    return getUsStockQuote(item.symbol);
}
