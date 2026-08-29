// ============================================================
// 法說會與財報
//
// 美股：用 Finnhub 的免費方案，有結構化的「財報實際/預估數字」
// (/stock/earnings) 跟「財報行事曆」(/calendar/earnings)，可以直接告訴你
// 上一次財報實際 vs 預估、下一次財報預估日期。跟新聞一樣需要你自己
// 申請一組免費金鑰（js/config.js 的 FINNHUB_API_KEY），沒設定的話會
// 自動退回搜尋捷徑連結。
//
// 台股：實際查證後發現，證交所沒有公開的「法說會日程查詢 API」。
// 唯一比較接近的資料來源，是證交所每天公布的「上市公司重大訊息」
// (opendata/t187ap04_L)，裡面偶爾會有公司自己公告的法人說明會資訊，
// 但那是一大段非結構化文字，而且這份資料本質上只能看到「今天」公布的，
// 沒辦法回溯過去的公告。所以做法是：
//   1. scripts/fetch_tw_quotes.py 每次執行時，順便抓一次今天的重大訊息，
//      篩選出主旨或說明裡有「法說」「法人說明會」等關鍵字的公告。
//   2. 把篩選出來的公告，依公司代號累加進 data/tw_earnings_announcements.json
//      （只累加、不刪除舊資料，每家公司最多保留最近 5 筆），這樣時間久了
//      涵蓋的公司會越來越多。
//   3. 網頁讀取這份累積檔案，查到就顯示證交所公告原文，查不到就誠實
//      告訴使用者「還沒累積到」，不會假裝知道法說會日期。
//
// 這代表剛上線的前幾個月，大部分台股很可能都查不到東西，這是資料來源
// 本身的限制，不是程式壞掉。
// ============================================================

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const TW_EARNINGS_URL = "data/tw_earnings_announcements.json";

function hasFinnhubKey() {
    const key = window.APP_CONFIG && window.APP_CONFIG.FINNHUB_API_KEY;
    return !!key && key !== "YOUR_FINNHUB_API_KEY";
}

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

const HOUR_LABELS = {
    bmo: "盤前公布",
    amc: "盤後公布",
    dmh: "盤中公布"
};

// 美股：上一次財報的實際 vs 預估 EPS
export async function getUsLastEarningsResult(symbol) {
    if (!hasFinnhubKey()) throw new Error("尚未設定 Finnhub 金鑰");
    const key = window.APP_CONFIG.FINNHUB_API_KEY;
    const url = `${FINNHUB_BASE}/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${key}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
        const msg = data && data.error ? data.error : `HTTP ${res.status}`;
        throw new Error(`Finnhub 財報 API 錯誤：${msg}`);
    }
    if (!Array.isArray(data) || data.length === 0) return null;

    // Finnhub 回傳通常已經是新到舊排序，保險起見還是自己排一次
    const sorted = [...data].sort((a, b) => (b.period || "").localeCompare(a.period || ""));
    const latest = sorted[0];
    return {
        period: latest.period,
        actual: latest.actual,
        estimate: latest.estimate,
        surprisePercent: latest.surprisePercent
    };
}

// 美股：下一次財報預估日期
export async function getUsNextEarningsDate(symbol) {
    if (!hasFinnhubKey()) throw new Error("尚未設定 Finnhub 金鑰");
    const key = window.APP_CONFIG.FINNHUB_API_KEY;
    const today = new Date();
    const from = fmtDate(today);
    const to = fmtDate(new Date(Date.now() + 180 * 86400 * 1000));
    const url =
        `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}` +
        `&symbol=${encodeURIComponent(symbol)}&token=${key}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
        const msg = data && data.error ? data.error : `HTTP ${res.status}`;
        throw new Error(`Finnhub 財報行事曆 API 錯誤：${msg}`);
    }
    const list = (data && data.earningsCalendar) || [];
    const upcoming = list.filter((e) => e.date >= from).sort((a, b) => a.date.localeCompare(b.date));
    if (upcoming.length === 0) return null;

    const next = upcoming[0];
    return {
        date: next.date,
        hourLabel: HOUR_LABELS[next.hour] || ""
    };
}

// 台股：讀取累積的重大訊息比對結果
let _twEarningsCache = null;
async function loadTwEarningsFile() {
    if (_twEarningsCache) return _twEarningsCache;
    const res = await fetch(`${TW_EARNINGS_URL}?_=${Date.now()}`);
    if (!res.ok) throw new Error(`讀取台股法說會累積資料失敗 (HTTP ${res.status})`);
    const data = await res.json();
    _twEarningsCache = data;
    return data;
}

export async function getTwEarningsAnnouncements(stockNo) {
    try {
        const data = await loadTwEarningsFile();
        const byCode = (data && data.by_code) || {};
        return byCode[stockNo] || [];
    } catch (err) {
        console.error("讀取台股法說會累積資料失敗：", err.message);
        return [];
    }
}
