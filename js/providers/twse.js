// ============================================================
// 台灣證券交易所 (TWSE) 資料來源
//
// 重要更新（實測結果）：
// 台灣證交所的開放資料介面 openapi.twse.com.tw 與看盤介面
// mis.twse.com.tw，實際測試後發現都「不允許瀏覽器用 JavaScript
// 跨網域直接讀取」（沒有回傳 Access-Control-Allow-Origin 標頭）。
// 用瀏覽器直接輸入網址可以看到資料，但網頁程式碼用 fetch() 呼叫
// 就會被瀏覽器擋下來（這是瀏覽器的安全機制 CORS，不是我們程式碼
// 寫錯）。
//
// 解決方式：改成「背景排程抓資料」的架構
//   1. 一個 GitHub Actions 排程（.github/workflows/update-tw-quotes.yml）
//      每 30 分鐘在 GitHub 的伺服器上執行 scripts/fetch_tw_quotes.py，
//      伺服器對伺服器的呼叫不受瀏覽器 CORS 限制，可以正常抓到
//      證交所的官方公開資料。
//   2. 抓到的資料會存成這個網站自己的檔案 data/tw_quotes.json，
//      並且自動 commit 回 GitHub。
//   3. 網頁本身只需要讀取「同一個網站底下」的 data/tw_quotes.json
//      （這是 same-origin，不會有 CORS 問題），就能拿到全部上市
//      股票最近一個交易日的官方收盤資料。
//
// 這代表台股報價不是「你每次打開網頁都重新抓一次」，而是「整個網站
// 背景每 30 分鐘更新一次大家共用的一份資料」，畫面上會誠實顯示
// 這份資料是什麼時候抓的。
// ============================================================

const LOCAL_QUOTES_URL = "data/tw_quotes.json";
const HISTORY_STORAGE_KEY = "tw_stock_history_v1";
const HISTORY_MAX_POINTS = 30;

let _cache = null;
let _cacheFetchedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

async function loadLocalQuotes() {
    const now = Date.now();
    if (_cache && now - _cacheFetchedAt < CACHE_TTL_MS) return _cache;

    const res = await fetch(`${LOCAL_QUOTES_URL}?_=${Date.now()}`);
    if (!res.ok) throw new Error(`讀取本地台股資料失敗 (HTTP ${res.status})`);
    const data = await res.json();

    if (!data || !Array.isArray(data.stocks) || data.stocks.length === 0) {
        throw new Error(
            "台股資料檔案還是空的。請確認 GitHub Actions 排程 (update-tw-quotes) 是否已經成功執行過一次，" +
            "或本機測試時先手動執行 python scripts/fetch_tw_quotes.py"
        );
    }

    _cache = data;
    _cacheFetchedAt = now;
    return data;
}

async function fetchTwStockDaily(stockNo) {
    const data = await loadLocalQuotes();
    const row = data.stocks.find((item) => item.Code === stockNo);
    if (!row) throw new Error(`在台股資料中找不到股號 ${stockNo}，請確認代號是否正確`);

    const close = parseFloat(row.ClosingPrice);
    const open = parseFloat(row.OpeningPrice);
    const high = parseFloat(row.HighestPrice);
    const low = parseFloat(row.LowestPrice);
    const changeNum = parseFloat(String(row.Change).replace(/[^\d.+-]/g, "")) || 0;
    const prevClose = close - changeNum;

    return {
        symbol: stockNo,
        name: row.Name || stockNo,
        price: close,
        open,
        high,
        low,
        prevClose,
        change: changeNum,
        changePercent: prevClose ? (changeNum / prevClose) * 100 : 0,
        asOf: `交易日 ${row.Date || "--"}（資料抓取時間：${data.retrieved_at_taipei || data.retrieved_at || "未知"}）`,
        isRealtime: false,
        source: "twse-daily-cached",
        // 額外的籌碼資訊（本益比等 / 三大法人 / 融資融券），由
        // scripts/fetch_tw_quotes.py 用股號合併進來。證交所報表欄位
        // 就是中文原始標題，這裡故意不重新命名，直接顯示給使用者看，
        // 抓不到時會是 undefined，畫面上會顯示「查無資料」。
        valuationRaw: row.valuation_raw || null,
        institutionalRaw: row.institutional_raw || null,
        marginRaw: row.margin_raw || null
    };
}

// 對外主要函式
export async function getTwStockQuote(stockNo) {
    const quote = await fetchTwStockDaily(stockNo);
    recordDailyHistoryPoint(stockNo, quote.price);
    return quote;
}

// ------------------------------------------------------------
// 本機歷史資料累積（用於畫走勢圖）
// ------------------------------------------------------------
function loadHistoryStore() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY)) || {};
    } catch {
        return {};
    }
}

function saveHistoryStore(store) {
    try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(store));
    } catch {
        // localStorage 滿了或不可用時，安靜地放棄記錄即可，不影響主要功能
    }
}

function recordDailyHistoryPoint(stockNo, price) {
    const store = loadHistoryStore();
    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const list = store[stockNo] || [];

    const existingIdx = list.findIndex((p) => p.date === todayKey);
    if (existingIdx >= 0) {
        list[existingIdx].price = price;
    } else {
        list.push({ date: todayKey, price });
    }

    store[stockNo] = list.slice(-HISTORY_MAX_POINTS);
    saveHistoryStore(store);
}

export function getTwStockHistoryPoints(stockNo) {
    const store = loadHistoryStore();
    return store[stockNo] || [];
}

// 用股號查中文名稱（新增自選股時，自動帶入公司名稱用）
export async function lookupTwStockName(stockNo) {
    try {
        const data = await loadLocalQuotes();
        const row = data.stocks.find((item) => item.Code === stockNo);
        return row ? row.Name : null;
    } catch {
        return null;
    }
}
