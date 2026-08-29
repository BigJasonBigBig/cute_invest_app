// ============================================================
// 個股新聞
//
// 老實說明目前能做到什麼程度：
// - 美股：用 Finnhub 的免費方案（company-news）直接從瀏覽器抓真實新聞。
//   需要你自己另外申請一組免費金鑰（跟 Twelve Data 一樣的流程），
//   放進 js/config.js 的 FINNHUB_API_KEY。沒設定金鑰的話，會自動退回
//   下面的「搜尋捷徑連結」，網站不會壞掉。
// - 台股：目前找不到「免費、可以直接從瀏覽器呼叫、涵蓋台股個股」的新聞
//   API（大部分免費新聞 API 不是只服務美股，就是會被瀏覽器 CORS 擋下來，
//   需要額外的伺服器才能用），所以台股這裡改成提供 Google 新聞 /
//   Yahoo 股市的搜尋捷徑連結，讓你一鍵查到最新消息，不會假裝「自動幫你
//   整理好重磅消息」但其實資料來源不可靠。
// ============================================================

const FINNHUB_BASE = "https://finnhub.io/api/v1";

export function hasFinnhubKey() {
    const key = window.APP_CONFIG && window.APP_CONFIG.FINNHUB_API_KEY;
    return !!key && key !== "YOUR_FINNHUB_API_KEY";
}

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

// 美股個股新聞（最近 days 天，最多回傳 5 則）
export async function getUsCompanyNews(symbol, days = 7) {
    const key = window.APP_CONFIG.FINNHUB_API_KEY;
    const to = new Date();
    const from = new Date(Date.now() - days * 86400 * 1000);
    const url =
        `${FINNHUB_BASE}/company-news?symbol=${encodeURIComponent(symbol)}` +
        `&from=${fmtDate(from)}&to=${fmtDate(to)}&token=${key}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
        const msg = data && data.error ? data.error : `HTTP ${res.status}`;
        throw new Error(`Finnhub 新聞 API 錯誤：${msg}`);
    }
    if (!Array.isArray(data)) {
        throw new Error("Finnhub 回傳的格式不是預期的新聞清單");
    }

    return data
        .filter((item) => item && item.headline)
        .slice(0, 5)
        .map((item) => ({
            headline: item.headline,
            source: item.source || "",
            url: item.url,
            datetime: item.datetime ? new Date(item.datetime * 1000) : null
        }));
}

// 台股（以及美股在還沒設定金鑰時的備用方案）：組出搜尋捷徑連結，不呼叫任何 API
export function buildNewsSearchLinks(displayName, twSymbol) {
    const q = encodeURIComponent(displayName);
    const links = [
        { label: `🔍 Google 新聞搜尋：${displayName}`, url: `https://news.google.com/search?q=${q}&hl=zh-TW&gl=TW` }
    ];
    if (twSymbol) {
        links.push({
            label: "📰 Yahoo 奇摩股市個股新聞",
            url: `https://tw.stock.yahoo.com/quote/${encodeURIComponent(twSymbol)}.TW/news`
        });
    }
    return links;
}
