# 小資芽理財 🌱

一個給理財新手看的可愛小網站：國際黃金報價、自選股清單（台股 + 美股）、
新手教學、儲蓄計畫小工具。純前端網站，不需要伺服器，可以直接放上
GitHub Pages 讓所有人瀏覽。

---

## 這個版本跟之前的展示版有什麼不同？

之前的版本，「即時金價」「即時股價」其實都是網頁自己用亂數模擬出來的假資料。
這個版本改成串接真實資料來源：

| 功能 | 資料來源 | 是否需要金鑰 | 說明 |
|---|---|---|---|
| 台股報價 | 台灣證券交易所公開資料 (openapi.twse.com.tw)，經 GitHub Actions 背景排程抓取後存成 `data/tw_quotes.json` | 不需要 | 詳見下方「台股資料為什麼要多一道排程？」 |
| 台股歷史走勢 | 你的瀏覽器本機累積 | 不需要 | 每次打開網站記錄一筆真實收盤價，會慢慢累積到 30 天 |
| 美股報價/歷史 | Twelve Data | 需要免費金鑰 | 詳見下方申請步驟 |
| 國際黃金 (XAU/USD) | Twelve Data | 需要免費金鑰 | 同上 |
| 美金兌台幣匯率 | Twelve Data | 需要免費金鑰 | 抓不到時會用 `config.js` 裡的備援值，並在畫面上註明「非即時」 |
| 台銀實體金條/金幣牌價 | 人工整理的參考資料 (`data/bot_gold_prices.json`) | 不需要 | 臺灣銀行沒有公開 API，這塊誠實標示為「參考資料」並附官方連結 |

**重要：** 免費資料來源大多有「每分鐘 / 每天可以打幾次」的額度限制，也不保證是
毫秒級的即時報價。這個網站的目標是「新手也能看到接近真實、有公信力來源的
資訊」，不是專業交易看盤軟體，請不要拿來做即時下單決策。

---

## 台股資料為什麼要多一道排程？（CORS 是什麼）

實際測試後發現，台灣證交所的開放資料介面（不管是 `openapi.twse.com.tw`
還是看盤網站用的 `mis.twse.com.tw`）雖然可以直接用瀏覽器打開網址看到資料，
但**不允許網頁的 JavaScript 用 `fetch()` 跨網域讀取**（沒有回傳
`Access-Control-Allow-Origin` 標頭，這是瀏覽器的安全機制，叫做 CORS）。
這代表如果讓網頁直接呼叫證交所的網址，瀏覽器會直接擋下來，畫面上的台股卡片
會永遠卡在「載入中」。

解法是加一道「伺服器對伺服器」的中間步驟，伺服器對伺服器的呼叫不受 CORS
限制：

1. `.github/workflows/update-tw-quotes.yml` 這個 GitHub Actions 設定，
   會每 30 分鐘在 GitHub 的伺服器上自動執行一次
   `scripts/fetch_tw_quotes.py`。
2. 這支 Python 程式去抓證交所的官方公開資料（全部上市股票的最近交易日
   收盤資訊），存成 `data/tw_quotes.json`，並自動 commit 回這個
   repository。
3. 網頁本身只讀取「自己網站底下」的 `data/tw_quotes.json`（這是
   same-origin，瀏覽器不會擋），所以不管你之後在「自選股」加哪一檔台股
   代號，都能從這份資料裡查到（因為證交所一次就會回傳全部上市股票）。

也就是說，部署到 GitHub Pages 之後，台股資料是「整個網站每 30 分鐘更新一次
大家共用的一份資料」，不是「你每次打開網頁重新抓一次」。畫面上（自選股卡片
點開的走勢圖上方）會顯示這份資料實際的抓取時間，讓使用者知道資料新不新。

---

## 台股新增了哪些籌碼資訊？

點開「我的自選股」裡任何一檔台股，走勢圖跟計算機下面會多出三個小表格：

- **本益比 / 殖利率 / 股價淨值比**（來源：證交所新版開放資料平台
  `openapi.twse.com.tw` 的 `BWIBBU_ALL`。這份原始欄位是英文縮寫
  `PEratio`／`DividendYield`／`PBratio`，網站已經自動轉成好懂的中文標籤。）
- **融資融券餘額**（來源：同一個新版開放資料平台的 `MI_MARGN`，欄位本來就是
  證交所官方中文標題，例如「融資今日餘額」，沒有另外翻譯或改名。）
- **三大法人買賣超**（外資／投信／自營商）——這份資料**沒有**收錄在新版開放
  資料平台裡，只存在證交所比較舊的報表系統 `www.twse.com.tw`，而且這個舊
  系統一定要指定「某一個交易日」才查得到，也比較容易把自動化程式當成機器人
  擋下來。`scripts/fetch_tw_quotes.py` 會從今天開始往回試最多 10 天找一個
  有資料的交易日，並加上瀏覽器常見的標頭來降低被擋的機率，但仍然有可能失敗
  ——失敗時這個表格會顯示「查無資料」，其他兩份資料跟股價都不受影響。

美股沒有對應的免費資料來源，所以這三個表格只會在你選台股的時候出現。

**如果某個表格一直顯示「查無資料」：** 本益比／殖利率／淨值比、融資融券這兩份
理論上應該每次都抓得到（除非證交所調整了報表格式）；三大法人買賣超則本來就
有機率抓不到（見上一段的說明）。不管是哪一種情況，都可以到 GitHub Actions
該次執行紀錄裡看有沒有印出 ⚠️ 開頭的警告訊息，把訊息內容告訴我，我可以幫忙
調整程式對應新的欄位名稱或抓取方式。

「外盤／內盤」這種盤中逐筆成交資料，證交所沒有提供免費的公開介面，需要另外
串接即時商業資料源（通常要付費），目前這個版本先不做這塊。

---

## Step 1：申請 Twelve Data 免費 API 金鑰

1. 前往 https://twelvedata.com/pricing ，選擇 **Free** 方案並註冊帳號。
2. 註冊完成後，登入 Twelve Data 後台（Dashboard），會看到一組 **API Key**。
3. 打開這個專案的 `js/config.js`，把 `YOUR_TWELVE_DATA_API_KEY` 換成你剛剛拿到的金鑰：

   ```js
   TWELVE_DATA_API_KEY: "在這裡貼上你的金鑰",
   ```

4. 如果 Twelve Data 後台有「網域白名單 / Allowed Origins」之類的安全性設定，
   建議設定成你之後部署的 GitHub Pages 網址（例如
   `https://你的帳號.github.io`），這樣即使有人複製了你的金鑰，也無法在別的
   網站上盜用。

> ⚠️ 因為這是純前端網站（沒有後端伺服器），這把金鑰最終會被放進公開網頁的
> 原始碼裡，任何人打開瀏覽器開發者工具都看得到。只要你申請的是「免費方案」，
> 最糟的狀況就是額度被別人用完、你需要重新產生一把新的金鑰，不會造成金錢
> 損失。如果之後想要完全隱藏金鑰，需要多做一個小後端（例如 Vercel 的
> Serverless Function）幫你代打 API，這個目前的版本沒有做，未來想加可以再
> 討論。

Twelve Data 免費方案有額度限制（依官網公告為準），如果你把 `js/config.js`
裡的 `REFRESH_INTERVAL_MS` 調得太短、或是自選股加太多檔，有可能會超過額度
被暫時限流。預設是 60 秒更新一次，建議先用預設值。

---

## Step 2：本機測試

因為 `js/app.js` 是用 ES module 寫的（`import`/`export`），**不能直接用瀏覽器
打開 `index.html` 檔案**（`file://` 開頭會失敗），需要透過一個簡單的本機
網頁伺服器：

```bash
# 在專案資料夾裡執行，Python 3 內建就有
python3 -m http.server 8080
```

接著瀏覽器打開 http://localhost:8080 即可測試。

**如果想在本機也看到真實的台股資料**（不然本機測試時，因為還沒有
GitHub Actions 幫你排程抓資料，台股卡片會顯示「⚠️ 無法取得報價」），
可以手動執行一次跟 GitHub Actions 一樣的抓取程式：

```bash
python3 scripts/fetch_tw_quotes.py
```

執行成功會產生／更新 `data/tw_quotes.json`，重新整理網頁就看得到真實台股
資料了。之後想更新，重新執行這行指令即可。

---

## Step 3：部署到 GitHub Pages（讓大家都可以看到）

1. 到 https://github.com/new 建立一個新的 Repository（例如取名
   `cute-invest-app`），設定為 Public。
2. 在這個專案資料夾裡執行：

   ```bash
   git init
   git add .
   git commit -m "小資芽理財：串接真實資料 + 自選股功能"
   git branch -M main
   git remote add origin https://github.com/你的帳號/cute-invest-app.git
   git push -u origin main
   ```

3. 到 GitHub 該 Repository 頁面 → **Settings** → 左側選單 **Pages**。
4. 「Build and deployment」的 Source 選擇 **Deploy from a branch**，
   Branch 選 `main`、資料夾選 `/ (root)`，按 **Save**。
5. 等 1~2 分鐘，畫面會出現網址，格式類似：
   `https://你的帳號.github.io/cute-invest-app/`
   這就是可以分享給任何人看的正式網址！

6. **讓自動更新台股資料的排程可以正常運作：**
   到 Repository 頁面 → **Settings** → 左側選單 **Actions** → **General**，
   捲到最下面「Workflow permissions」，選擇
   **Read and write permissions**，按 **Save**。
   （GitHub 預設只給唯讀權限，我們的排程需要寫入權限才能把抓到的台股資料
   commit 回 repository，這步驟不做的話，排程會執行失敗。）

7. **手動先跑一次排程，讓台股資料馬上出現：**
   到 Repository 頁面上方 **Actions** 分頁 → 左側選
   **Update TW Stock Quotes** → 右邊按 **Run workflow** → 再按一次綠色的
   **Run workflow** 按鈕。等 30 秒到 1 分鐘，重新整理你的網站，台股卡片就
   會出現真實資料了（不用等 30 分鐘的排程時間）。

之後想更新網站內容，只要在本機修改檔案後，重新執行：

```bash
git add .
git commit -m "說明這次改了什麼"
git push
```

GitHub Pages 會自動重新部署。

---

## 使用者怎麼「自己增加想追蹤的股票」？

打開網站 → 點上方導覽列的「我的自選股」→ 在表單選擇「台股」或「美股」、
輸入代號（例如 `2330` 或 `AAPL`）→ 按「加入自選股」。清單會存在瀏覽器的
`localStorage`，重新整理網頁不會消失，但只存在「這一台裝置、這一個瀏覽器」
裡，換電腦或換瀏覽器不會同步（這是先前討論過的設計，之後如果想要「登入帳號、
跨裝置同步」，需要另外加後端資料庫和登入功能，可以再跟我說）。

---

## 檔案結構

```
cute_invest_app/
├── index.html                 網站主頁面
├── style.css                  樣式
├── js/
│   ├── config.js              設定檔（API 金鑰、更新頻率、預設自選股）
│   ├── app.js                 主程式：串接資料、畫圖、UI 互動
│   ├── watchlist.js           自選股清單邏輯（localStorage 存取）
│   └── providers/
│       ├── twse.js            讀取 data/tw_quotes.json 的台股資料邏輯
│       └── twelvedata.js      Twelve Data 資料（美股/黃金/匯率）
├── data/
│   ├── tw_quotes.json         台股資料（由 GitHub Actions 排程自動更新，勿手動編輯）
│   ├── tsmc_data.json         台積電新手包的教學內容（人工整理，非即時）
│   └── bot_gold_prices.json   台銀實體金條/金幣參考牌價（人工整理，非即時）
├── scripts/
│   └── fetch_tw_quotes.py     抓取台股官方資料、寫入 data/tw_quotes.json
├── .github/workflows/
│   └── update-tw-quotes.yml   每 30 分鐘自動執行上面那支程式的排程設定
└── README.md                  就是這份文件
```

## 之後可以再擴充的方向

- 幫美股新增的股票也做「輸入代號時自動查公司全名 / 自動完成」的功能
  （目前美股是先直接接受你輸入的代號，正式報價回來後才會顯示公司名稱）。
- `data/tsmc_data.json`、`data/bot_gold_prices.json` 建議每一季或每隔一段
  時間手動更新一次內容/日期，才不會顯示過舊的資訊。
- 如果之後想要「多裝置同步自選股」或「多人留言/分享」，需要加後端與登入功能，
  屆時可以考慮 Vercel + 一個簡單資料庫（例如 Supabase）。
