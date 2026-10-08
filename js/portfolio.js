// ============================================================
// 我的持股：純計算邏輯（不碰畫面，方便單獨測試）
//
// 資料只存在「這個瀏覽器」的 localStorage，不會上傳到任何地方。
// 因為換裝置或清瀏覽器資料會消失，所以提供匯出／匯入備份檔。
//
// 計算方式：移動平均成本法（台灣券商 App 最常見的算法）
//   - 買進／期初持股：總成本 += 股數 × 價格 + 手續費；股數 += 買進股數
//   - 賣出：賣出的那部分成本 = 目前均價 × 賣出股數
//           這筆已實現損益 = (賣出股數 × 價格 − 手續費 − 證交稅) − 賣出的那部分成本
//           賣出後剩餘持股的均價不變
//   - 均價 = 總成本 ÷ 股數（買進手續費已經算進成本裡）
// ============================================================

const STORAGE_KEY = "portfolio_v1";
const SETTINGS_KEY = "portfolio_settings_v1";

export const TW_FEE_RATE = 0.001425;
export const TW_TAX_RATE_STOCK = 0.003;
export const TW_TAX_RATE_ETF = 0.001;

export const DEFAULT_SETTINGS = {
    twFeeDiscount: 1, // 手續費折扣，1 = 不打折，0.6 = 六折
    twMinFee: 20 // 整股最低手續費；零股可以改成 1
};

// ---------- 手續費／證交稅試算 ----------
export function isTwEtf(symbol) {
    return /^00/.test(String(symbol));
}

export function estimateFee(market, shares, price, settings = DEFAULT_SETTINGS) {
    if (market !== "TW") return 0; // 美股券商差異太大，預設 0，請自行填寫
    const amount = shares * price;
    if (!(amount > 0)) return 0;
    const raw = Math.floor(amount * TW_FEE_RATE * settings.twFeeDiscount);
    return Math.max(raw, settings.twMinFee);
}

export function estimateTax(market, type, symbol, shares, price) {
    if (market !== "TW" || type !== "sell") return 0;
    const amount = shares * price;
    if (!(amount > 0)) return 0;
    return Math.floor(amount * (isTwEtf(symbol) ? TW_TAX_RATE_ETF : TW_TAX_RATE_STOCK));
}

// ---------- 持股計算 ----------
export function positionKey(market, symbol) {
    return `${market}:${String(symbol).toUpperCase()}`;
}

function sortTransactions(txs) {
    return [...txs].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

// 回傳 { positions: {key: {...}}, sellPnl: {txId: 已實現損益}, errors: [訊息] }
export function computePositions(transactions) {
    const positions = {};
    const sellPnl = {};
    const errors = [];
    const EPS = 1e-9;

    for (const tx of sortTransactions(transactions)) {
        const key = positionKey(tx.market, tx.symbol);
        const pos = (positions[key] ||= {
            key,
            market: tx.market,
            symbol: String(tx.symbol).toUpperCase(),
            name: tx.name || tx.symbol,
            shares: 0,
            totalCost: 0,
            realized: 0
        });
        if (tx.name) pos.name = tx.name;

        const qty = Number(tx.shares);
        const price = Number(tx.price);
        const fee = Number(tx.fee) || 0;
        const tax = Number(tx.tax) || 0;

        if (tx.type === "sell") {
            if (qty > pos.shares + EPS) {
                errors.push(
                    `${tx.date} 賣出 ${pos.symbol} ${qty} 股，但當時只持有 ${pos.shares} 股`
                );
                continue;
            }
            const avg = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
            const costOfSold = avg * qty;
            const pnl = qty * price - fee - tax - costOfSold;
            sellPnl[tx.id] = pnl;
            pos.realized += pnl;
            pos.shares -= qty;
            pos.totalCost -= costOfSold;
            if (pos.shares <= EPS) {
                pos.shares = 0;
                pos.totalCost = 0;
            }
        } else {
            // "open"（期初持股）與 "buy"（買進）都是增加持股
            pos.totalCost += qty * price + fee;
            pos.shares += qty;
        }
    }

    for (const pos of Object.values(positions)) {
        pos.avgCost = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
    }
    return { positions, sellPnl, errors };
}

// 把持股結果加上現價後的市值／未實現損益；quote 為 null 代表查不到報價
export function valuePosition(pos, price) {
    if (!Number.isFinite(price)) {
        return { price: null, marketValue: null, unrealized: null, unrealizedPct: null };
    }
    const marketValue = pos.shares * price;
    const unrealized = marketValue - pos.totalCost;
    const unrealizedPct = pos.totalCost > 0 ? (unrealized / pos.totalCost) * 100 : null;
    return { price, marketValue, unrealized, unrealizedPct };
}

// ---------- 輸入驗證 ----------
export function validateNewTransaction(existing, candidate) {
    if (!candidate.symbol) return "請輸入股票代號";
    if (!candidate.date) return "請選擇日期";
    if (!(Number(candidate.shares) > 0)) return "股數要大於 0";
    if (!(Number(candidate.price) > 0)) return "價格要大於 0";
    if (Number(candidate.fee) < 0 || Number(candidate.tax) < 0) return "手續費和稅不能是負數";
    if (candidate.market === "TW" && !Number.isInteger(Number(candidate.shares))) {
        return "台股股數請輸入整數（零股也是整數股）";
    }
    const before = computePositions(existing).errors.length;
    const after = computePositions([...existing, candidate]).errors;
    if (after.length > before) return `這筆會讓賣出超過持股：${after[after.length - 1]}`;
    return null;
}

// 刪除一筆後，不能讓後面的賣出變成超賣
export function validateDeletion(existing, txId) {
    const before = computePositions(existing).errors.length;
    const remaining = existing.filter((t) => t.id !== txId);
    const after = computePositions(remaining).errors;
    if (after.length > before) {
        return `不能刪除這筆，因為會讓後面的賣出變成超過持股：${after[after.length - 1]}。請先刪除那筆賣出。`;
    }
    return null;
}

// ---------- 儲存 ----------
export function loadTransactions() {
    try {
        const list = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

export function saveTransactions(list) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        return true;
    } catch (err) {
        console.error("無法儲存持股資料：", err);
        return false;
    }
}

export function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        return { ...DEFAULT_SETTINGS, ...(s || {}) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        /* 儲存失敗就略過，下次重設即可 */
    }
}

export function newTransactionId() {
    return `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- 備份 ----------
export function buildBackup(transactions, settings) {
    return JSON.stringify(
        { app: "cute_invest_app", kind: "portfolio", version: 1, exportedAt: new Date().toISOString(), settings, transactions },
        null,
        2
    );
}

// 解析並檢查備份檔；有問題就丟錯誤，不會動到現有資料
export function parseBackup(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("這不是有效的備份檔（無法解析）");
    }
    if (!data || data.kind !== "portfolio" || !Array.isArray(data.transactions)) {
        throw new Error("這個檔案不是「我的持股」的備份檔");
    }
    const allowedTypes = ["open", "buy", "sell"];
    const cleaned = data.transactions.map((t, i) => {
        const ok =
            t &&
            allowedTypes.includes(t.type) &&
            (t.market === "TW" || t.market === "US") &&
            typeof t.symbol === "string" &&
            t.symbol &&
            /^\d{4}-\d{2}-\d{2}$/.test(t.date) &&
            Number(t.shares) > 0 &&
            Number(t.price) > 0;
        if (!ok) throw new Error(`備份檔第 ${i + 1} 筆資料格式不正確，已取消匯入`);
        return {
            id: typeof t.id === "string" && t.id ? t.id : newTransactionId(),
            createdAt: Number(t.createdAt) || Date.now() + i,
            type: t.type,
            market: t.market,
            symbol: t.symbol.toUpperCase(),
            name: typeof t.name === "string" ? t.name : t.symbol,
            date: t.date,
            shares: Number(t.shares),
            price: Number(t.price),
            fee: Number(t.fee) || 0,
            tax: Number(t.tax) || 0,
            note: typeof t.note === "string" ? t.note : ""
        };
    });
    const { errors } = computePositions(cleaned);
    if (errors.length > 0) throw new Error(`備份檔內容有矛盾，已取消匯入：${errors[0]}`);
    return { transactions: cleaned, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
}
