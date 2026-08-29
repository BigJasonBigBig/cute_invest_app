#!/usr/bin/env python3
# ============================================================
# 抓取台灣證券交易所的多份公開資料，合併存成網站要用的
# data/tw_quotes.json。
#
# 為什麼需要這支程式？
# 瀏覽器沒辦法直接用 JavaScript 呼叫台灣證交所的公開資料介面
# （會被瀏覽器的 CORS 安全機制擋下來），所以改成用這支「伺服器對
# 伺服器」的程式先抓好資料、存成網站自己的檔案，網頁再讀取這個
# 同網站底下的檔案，就不會有 CORS 問題了。
#
# 這支程式會抓四份證交所官方公開資料，並用股號 (Code) 合併成一份：
#   1. STOCK_DAY_ALL  — 全部上市股票的每日收盤資訊（價格、開高低收）
#   2. BWIBBU_ALL     — 全部上市股票的本益比、殖利率、股價淨值比
#   3. T86            — 三大法人（外資／投信／自營商）買賣超
#   4. MI_MARGN       — 融資融券餘額
#
# 後面三份資料是「盡力而為」：證交所有時候會調整報表的欄位命名，
# 這支程式抓不到某一份的時候不會讓整個流程失敗，只會跳過那份、
# 在網站上顯示「查無資料」，其他資料（尤其是最重要的股價）還是
# 會正常更新。
#
# 什麼時候會用到這支程式？
#   1. GitHub Actions 會自動、定期執行它（見
#      .github/workflows/update-tw-quotes.yml），部署到 GitHub Pages
#      後不需要手動做任何事。
#   2. 在本機測試網站時，如果想要台股卡片顯示真實資料，先手動執行
#      一次： python scripts/fetch_tw_quotes.py
# ============================================================

import json
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

BASE_URL = "https://openapi.twse.com.tw/v1"
ENDPOINTS = {
    "stock_day_all": f"{BASE_URL}/exchangeReport/STOCK_DAY_ALL",   # 每日收盤資訊（必要，抓不到就整個中止）
    "valuation": f"{BASE_URL}/exchangeReport/BWIBBU_ALL",          # 本益比／殖利率／股價淨值比
    "institutional": f"{BASE_URL}/fund/T86",                       # 三大法人買賣超
    "margin": f"{BASE_URL}/exchangeReport/MI_MARGN",                # 融資融券餘額
}

OUTPUT_PATH = "data/tw_quotes.json"
TAIPEI_OFFSET = timedelta(hours=8)

# 不同報表的股號／股票名稱欄位命名不太一樣，依序嘗試這些候選欄位名稱
CODE_KEY_CANDIDATES = ["Code", "證券代號", "股票代號", "SecuritiesCompanyCode"]
NAME_KEY_CANDIDATES = ["Name", "證券名稱", "股票名稱"]


def fetch_json(url):
    request = urllib.request.Request(
        url,
        headers={
            # 有些伺服器會擋掉沒有 User-Agent 的請求，所以假裝成一般瀏覽器
            "User-Agent": "Mozilla/5.0 (compatible; CuteInvestAppBot/1.0)"
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8"))


def find_key(row, candidates):
    for key in candidates:
        if key in row:
            return key
    return None


def index_by_code(rows, label):
    """把一份報表的資料，依股號建立成 {股號: 該列資料} 的對照表。

    回傳 (index_dict, code_key, name_key)；如果完全找不到股號欄位，
    回傳空字典並印出警告，讓呼叫端可以安全地略過這份資料。
    """
    if not rows:
        return {}, None, None

    sample = rows[0]
    code_key = find_key(sample, CODE_KEY_CANDIDATES)
    name_key = find_key(sample, NAME_KEY_CANDIDATES)

    if not code_key:
        print(
            f"⚠️  「{label}」這份資料裡找不到股號欄位（試過 {CODE_KEY_CANDIDATES}），"
            f"這份資料這次不會合併進網站，其他資料不受影響。實際欄位有：{list(sample.keys())}",
            file=sys.stderr,
        )
        return {}, None, None

    index = {}
    for row in rows:
        code = row.get(code_key)
        if code:
            index[code] = row
    return index, code_key, name_key


def strip_redundant_keys(row, code_key, name_key):
    """把股號、名稱欄位拿掉，只留下真正有資訊量的欄位，顯示會比較乾淨。"""
    return {k: v for k, v in row.items() if k not in (code_key, name_key)}


def fetch_optional(label, url):
    """抓「加分」資料（非股價本身）：失敗就回傳 None，不中止整個流程。"""
    try:
        data = fetch_json(url)
        if not isinstance(data, list) or len(data) == 0:
            print(f"⚠️  「{label}」回傳的格式不是預期的非空陣列，這次略過。", file=sys.stderr)
            return None
        return data
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as err:
        print(f"⚠️  抓取「{label}」失敗（{err}），這次略過，不影響其他資料。", file=sys.stderr)
        return None


def main():
    # 1. 股價資料是必要的，抓不到就整個中止（避免網站用壞掉/空白的資料覆蓋現有檔案）
    try:
        stocks = fetch_json(ENDPOINTS["stock_day_all"])
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as err:
        print(f"抓取台股股價資料失敗：{err}", file=sys.stderr)
        print("為了避免用壞掉的資料覆蓋現有檔案，這次不會更新 data/tw_quotes.json。", file=sys.stderr)
        sys.exit(1)

    if not isinstance(stocks, list) or len(stocks) == 0:
        print("證交所回傳的股價資料格式不如預期（不是非空陣列），先不更新檔案。", file=sys.stderr)
        sys.exit(1)

    base_code_key, base_name_key = find_key(stocks[0], CODE_KEY_CANDIDATES), find_key(stocks[0], NAME_KEY_CANDIDATES)
    if not base_code_key:
        print("連股價資料裡都找不到股號欄位，證交所可能改版了，先不更新檔案。", file=sys.stderr)
        sys.exit(1)

    # 2. 三份「加分」資料：本益比等、三大法人、融資融券。抓不到就跳過，不影響股價本身。
    valuation_rows = fetch_optional("本益比／殖利率／股價淨值比", ENDPOINTS["valuation"])
    institutional_rows = fetch_optional("三大法人買賣超", ENDPOINTS["institutional"])
    margin_rows = fetch_optional("融資融券餘額", ENDPOINTS["margin"])

    valuation_idx, v_code, v_name = index_by_code(valuation_rows or [], "本益比／殖利率／股價淨值比")
    institutional_idx, i_code, i_name = index_by_code(institutional_rows or [], "三大法人買賣超")
    margin_idx, m_code, m_name = index_by_code(margin_rows or [], "融資融券餘額")

    merged_count = {"valuation": 0, "institutional": 0, "margin": 0}

    for stock in stocks:
        code = stock.get(base_code_key)

        if code in valuation_idx:
            stock["valuation_raw"] = strip_redundant_keys(valuation_idx[code], v_code, v_name)
            merged_count["valuation"] += 1

        if code in institutional_idx:
            stock["institutional_raw"] = strip_redundant_keys(institutional_idx[code], i_code, i_name)
            merged_count["institutional"] += 1

        if code in margin_idx:
            stock["margin_raw"] = strip_redundant_keys(margin_idx[code], m_code, m_name)
            merged_count["margin"] += 1

    now_utc = datetime.now(timezone.utc)
    now_taipei = now_utc + TAIPEI_OFFSET

    payload = {
        "retrieved_at": now_utc.isoformat().replace("+00:00", "Z"),
        "retrieved_at_taipei": now_taipei.strftime("%Y-%m-%d %H:%M:%S (台北時間)"),
        "source": ENDPOINTS["stock_day_all"],
        "stock_count": len(stocks),
        "merged_extra_data_count": merged_count,
        "stocks": stocks,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(
        f"成功更新 {OUTPUT_PATH}，共 {len(stocks)} 檔股票，抓取時間 {payload['retrieved_at_taipei']}\n"
        f"其中有合併到「本益比等」資料的股票數：{merged_count['valuation']}\n"
        f"有合併到「三大法人」資料的股票數：{merged_count['institutional']}\n"
        f"有合併到「融資融券」資料的股票數：{merged_count['margin']}\n"
        "（如果上面三個數字是 0，代表證交所那份報表這次抓不到或欄位改了，"
        "看終端機上面的 ⚠️ 警告訊息了解細節）"
    )


if __name__ == "__main__":
    main()
