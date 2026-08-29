#!/usr/bin/env python3
# ============================================================
# 抓取台灣證券交易所「上市股票每日收盤資訊」，存成網站要用的
# data/tw_quotes.json。
#
# 為什麼需要這支程式？
# 瀏覽器沒辦法直接用 JavaScript 呼叫台灣證交所的公開資料介面
# （會被瀏覽器的 CORS 安全機制擋下來），所以改成用這支「伺服器對
# 伺服器」的程式先抓好資料、存成網站自己的檔案，網頁再讀取這個
# 同網站底下的檔案，就不會有 CORS 問題了。
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

SOURCE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
OUTPUT_PATH = "data/tw_quotes.json"
TAIPEI_OFFSET = timedelta(hours=8)


def fetch_stock_day_all():
    request = urllib.request.Request(
        SOURCE_URL,
        headers={
            # 有些伺服器會擋掉沒有 User-Agent 的請求，所以假裝成一般瀏覽器
            "User-Agent": "Mozilla/5.0 (compatible; CuteInvestAppBot/1.0)"
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8"))


def main():
    try:
        stocks = fetch_stock_day_all()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as err:
        print(f"抓取台股資料失敗：{err}", file=sys.stderr)
        print("為了避免用壞掉的資料覆蓋現有檔案，這次不會更新 data/tw_quotes.json。", file=sys.stderr)
        sys.exit(1)

    if not isinstance(stocks, list) or len(stocks) == 0:
        print("證交所回傳的資料格式不如預期（不是非空陣列），先不更新檔案。", file=sys.stderr)
        sys.exit(1)

    now_utc = datetime.now(timezone.utc)
    now_taipei = now_utc + TAIPEI_OFFSET

    payload = {
        "retrieved_at": now_utc.isoformat().replace("+00:00", "Z"),
        "retrieved_at_taipei": now_taipei.strftime("%Y-%m-%d %H:%M:%S (台北時間)"),
        "source": SOURCE_URL,
        "stock_count": len(stocks),
        "stocks": stocks,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(f"成功更新 {OUTPUT_PATH}，共 {len(stocks)} 檔股票，抓取時間 {payload['retrieved_at_taipei']}")


if __name__ == "__main__":
    main()
