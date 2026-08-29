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
# 這支程式會抓四份證交所官方公開資料，並用股號合併成一份：
#   1. STOCK_DAY_ALL — 全部上市股票的每日收盤資訊（價格、開高低收）
#      來源：新版開放資料平台 openapi.twse.com.tw
#   2. BWIBBU_ALL    — 全部上市股票的本益比、殖利率、股價淨值比
#      來源：同上，openapi.twse.com.tw
#   3. MI_MARGN      — 融資融券餘額
#      來源：同上，openapi.twse.com.tw
#   4. T86           — 三大法人（外資／投信／自營商）買賣超
#      來源：證交所「舊版」報表系統 www.twse.com.tw（這份資料目前
#      沒有在新版開放資料平台上），需要指定日期、且對程式化存取比較
#      敏感，所以用比較貼近瀏覽器的方式去抓（詳見 fetch_institutional_t86）。
#
# 後面三份資料是「盡力而為」：證交所有時候會調整報表的欄位命名，或是
# 舊版系統可能會擋掉看起來像機器人的請求，這支程式抓不到某一份的時候
# 不會讓整個流程失敗，只會跳過那份、在網站上顯示「查無資料」，其他資料
# （尤其是最重要的股價）還是會正常更新。
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
import http.cookiejar
from datetime import datetime, timedelta, timezone

BASE_URL = "https://openapi.twse.com.tw/v1"
ENDPOINTS = {
    "stock_day_all": f"{BASE_URL}/exchangeReport/STOCK_DAY_ALL",   # 每日收盤資訊（必要，抓不到就整個中止）
    "valuation": f"{BASE_URL}/exchangeReport/BWIBBU_ALL",          # 本益比／殖利率／股價淨值比
    "margin": f"{BASE_URL}/exchangeReport/MI_MARGN",                # 融資融券餘額
}

# 上市公司每日重大訊息（不在 /v1/ 底下，是 /opendata/ 這個獨立的分類）。
# 這份資料只會有「今天」公布的公告，所以法說會累積檔（見下面）要靠每次
# 執行時「疊加」進去，沒辦法一次回溯過去的公告。
MATERIAL_NEWS_URL = "https://openapi.twse.com.tw/opendata/t187ap04_L"
EARNINGS_OUTPUT_PATH = "data/tw_earnings_announcements.json"
EARNINGS_KEYWORDS = ["法人說明會", "法說會", "投資人說明會", "法人說明会"]
EARNINGS_MAX_PER_CODE = 5  # 每家公司最多保留幾筆比對到的公告

# T86（三大法人買賣超）不在新版開放資料平台上，只能從舊版報表系統抓，
# 而且必須指定「某一個交易日」的日期，沒有交易的那天會抓不到東西。
T86_URL_TEMPLATE = "https://www.twse.com.tw/rwd/zh/fund/T86?date={date}&selectType=ALL&response=json"
T86_REFERER_PAGE = "https://www.twse.com.tw/zh/trading/fund/T86.html"
T86_MAX_DAYS_BACK = 10  # 遇到假日/國定假日時，最多往回試幾天

OUTPUT_PATH = "data/tw_quotes.json"
TAIPEI_OFFSET = timedelta(hours=8)

# 不同報表的股號／股票名稱欄位命名不太一樣，依序嘗試這些候選欄位名稱
CODE_KEY_CANDIDATES = ["Code", "證券代號", "股票代號", "公司代號", "SecuritiesCompanyCode"]
NAME_KEY_CANDIDATES = ["Name", "證券名稱", "股票名稱", "公司名稱"]

# BWIBBU_ALL 的欄位是英文縮寫，直接顯示給非技術使用者看不好懂，
# 這裡轉成白話中文標籤（其餘兩份報表本來就是證交所官方中文標題，不需要轉）。
VALUATION_LABEL_MAP = {
    "Date": "資料日期（民國年）",
    "PEratio": "本益比",
    "DividendYield": "殖利率 (%)",
    "PBratio": "股價淨值比",
}

# 假裝成一般瀏覽器，降低被證交所舊版系統的防機器人機制擋下來的機率
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}


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


def relabel(row, label_map):
    """把英文/縮寫欄位名稱換成看得懂的中文標籤（沒有對應的維持原樣）。"""
    return {label_map.get(k, k): v for k, v in row.items()}


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


def fetch_institutional_t86():
    """抓三大法人買賣超（T86）。

    這份資料的兩個難點：
    1. 不在新版開放資料平台上，只能用舊版報表系統的網址，而且一定要帶
       「某一天」的日期，遇到週末/國定假日那天會抓不到東西，所以要從
       今天（台北時間）開始，往回試最多 T86_MAX_DAYS_BACK 天。
    2. 舊版系統對看起來像機器人的請求比較敏感，這裡刻意加上瀏覽器常見
       的標頭，並先「熱身」造訪一次網頁本身（讓它願意發 cookie），
       盡量提高抓成功的機率；就算熱身失敗，還是會照樣嘗試抓資料。
    """
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))

    try:
        warmup_req = urllib.request.Request(T86_REFERER_PAGE, headers=BROWSER_HEADERS)
        opener.open(warmup_req, timeout=20).read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        # 熱身失敗不影響後面繼續嘗試，只是成功機率可能會低一點
        pass

    now_taipei = datetime.now(timezone.utc) + TAIPEI_OFFSET

    for days_back in range(T86_MAX_DAYS_BACK):
        target_date = now_taipei - timedelta(days=days_back)
        date_str = target_date.strftime("%Y%m%d")
        url = T86_URL_TEMPLATE.format(date=date_str)

        try:
            req = urllib.request.Request(
                url, headers={**BROWSER_HEADERS, "Referer": T86_REFERER_PAGE}
            )
            with opener.open(req, timeout=30) as response:
                raw = response.read()
            payload = json.loads(raw.decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as err:
            print(f"⚠️  「三大法人買賣超」（{date_str}）抓取失敗：{err}，改試前一天。", file=sys.stderr)
            continue

        if not isinstance(payload, dict) or not payload.get("data"):
            # 不是回傳錯誤，只是那天沒有交易資料（例如假日），試更早一天即可
            continue

        fields = payload.get("fields") or []
        if not fields:
            print(f"⚠️  「三大法人買賣超」（{date_str}）回傳的資料沒有欄位名稱（fields），這次略過。", file=sys.stderr)
            return None

        rows = [dict(zip(fields, row)) for row in payload["data"]]
        return rows

    print(
        f"⚠️  「三大法人買賣超」嘗試了最近 {T86_MAX_DAYS_BACK} 天都抓不到資料"
        "（可能是證交所舊版系統擋掉了自動化請求，或是欄位/網址又調整了），這次略過，不影響其他資料。",
        file=sys.stderr,
    )
    return None


def update_tw_earnings_announcements():
    """比對今天的證交所重大訊息，把跟法說會有關的公告疊加進累積檔案。

    這個函式故意獨立於股價那份資料之外：就算這裡整個失敗，也絕對不能
    影響到 tw_quotes.json 的更新（股價是最重要的資料）。
    """
    try:
        rows = fetch_json(MATERIAL_NEWS_URL)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as err:
        print(f"⚠️  抓取「上市公司重大訊息」失敗（{err}），這次略過法說會比對，不影響股價資料。", file=sys.stderr)
        return

    if not isinstance(rows, list) or len(rows) == 0:
        print("⚠️  「上市公司重大訊息」回傳的格式不是預期的非空陣列，這次略過法說會比對。", file=sys.stderr)
        return

    sample = rows[0]
    code_key = find_key(sample, CODE_KEY_CANDIDATES)
    subject_key = "主旨" if "主旨" in sample else None
    desc_key = "說明" if "說明" in sample else None
    date_key = "發言日期" if "發言日期" in sample else None

    if not code_key or not subject_key:
        print(
            f"⚠️  「上市公司重大訊息」的欄位跟預期不同（實際欄位：{list(sample.keys())}），這次略過法說會比對。",
            file=sys.stderr,
        )
        return

    matched = []
    for row in rows:
        subject = row.get(subject_key, "") or ""
        desc = row.get(desc_key, "") or "" if desc_key else ""
        haystack = subject + desc
        if any(kw in haystack for kw in EARNINGS_KEYWORDS):
            matched.append(
                {
                    "code": row.get(code_key),
                    "date": row.get(date_key, "") if date_key else "",
                    "subject": subject,
                    "description": desc,
                }
            )

    # 讀取現有的累積檔案（第一次執行時檔案還不存在，視為空的就好）
    try:
        with open(EARNINGS_OUTPUT_PATH, encoding="utf-8") as f:
            existing = json.load(f)
        by_code = existing.get("by_code", {})
    except (FileNotFoundError, ValueError):
        by_code = {}

    added_count = 0
    for item in matched:
        code = item["code"]
        if not code:
            continue
        entries = by_code.setdefault(code, [])
        # 用「日期+主旨」去重，同一則公告在同一天內被排程重複抓到很多次，
        # 不應該一直重複疊加
        dedup_key = (item["date"], item["subject"])
        if any((e.get("date"), e.get("subject")) == dedup_key for e in entries):
            continue
        entries.append(
            {
                "date": item["date"],
                "subject": item["subject"],
                "description": item["description"]
            }
        )
        added_count += 1
        # 保留最新的 N 筆（用日期字串排序，證交所日期是 YYYYMMDD 的民國年格式，字串排序恰好等於時間排序）
        entries.sort(key=lambda e: e.get("date", ""), reverse=True)
        by_code[code] = entries[:EARNINGS_MAX_PER_CODE]

    now_utc = datetime.now(timezone.utc)
    payload = {
        "updated_at": now_utc.isoformat().replace("+00:00", "Z"),
        "note": "由 scripts/fetch_tw_quotes.py 每次執行時，比對當天證交所重大訊息公告疊加而成，"
        "只能從系統開始運作那天起累積，無法回溯更早的公告。",
        "by_code": by_code,
    }
    with open(EARNINGS_OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(f"法說會重大訊息比對完成：這次新增 {added_count} 筆，目前累積 {len(by_code)} 家公司的公告。")


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
    institutional_rows = fetch_institutional_t86()
    margin_rows = fetch_optional("融資融券餘額", ENDPOINTS["margin"])

    valuation_idx, v_code, v_name = index_by_code(valuation_rows or [], "本益比／殖利率／股價淨值比")
    institutional_idx, i_code, i_name = index_by_code(institutional_rows or [], "三大法人買賣超")
    margin_idx, m_code, m_name = index_by_code(margin_rows or [], "融資融券餘額")

    merged_count = {"valuation": 0, "institutional": 0, "margin": 0}

    for stock in stocks:
        code = stock.get(base_code_key)

        if code in valuation_idx:
            cleaned = strip_redundant_keys(valuation_idx[code], v_code, v_name)
            stock["valuation_raw"] = relabel(cleaned, VALUATION_LABEL_MAP)
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

    # 3. 法說會重大訊息比對（獨立於股價資料之外，這裡萬一出錯也不能影響上面已經寫好的 tw_quotes.json）
    try:
        update_tw_earnings_announcements()
    except Exception as err:  # noqa: BLE001 - 這裡故意攔截所有例外，法說會比對失敗不該讓整個排程報錯
        print(f"⚠️  法說會重大訊息比對過程發生未預期的錯誤（{err}），這次略過，不影響股價資料。", file=sys.stderr)


if __name__ == "__main__":
    main()
