# 好食光｜SaaS 訂餐系統

好食光是面向台灣餐飲店家的多租戶 SaaS 訂餐平台。第一家 Pilot 店家為「老張麵店」。

## 產品設定
- 店家模式：SaaS，多租戶
- 上線策略：Pilot
- 店家網址：Subdomain（例如 `laozhang.haoshiguang.tw`）
- 語系／幣別：繁體中文／TWD
- 技術：Next.js App Router、TypeScript、Supabase PostgreSQL + Auth、Vercel

## 開發狀態
目前已完成第一階段 Pilot 功能：老張麵店顧客菜單與購物車、伺服器端價格重算及訂單建立、店家登入與訂單狀態管理、商品／分類管理、營業時間／公休／暫停接單，以及店家名稱／電話／地址管理。資料庫 migration、RLS、結帳併發與隔離測試均以 disposable local PostgreSQL／Supabase 為驗證環境。

尚未完成 hosted Supabase 專案設定與 migration 部署、正式帳號邀請／管理流程、正式環境端到端驗收、線上付款及正式營運部署。不要將 GitHub CI 或本機 E2E 通過視為 hosted production 已驗證，也不要將目前頁面視為可接收真實訂單的正式服務。

## 本機啟動
1. 安裝 Node.js 20+
2. `npm install`
3. 複製 `.env.example` 為 `.env.local` 並填入 Supabase 專案資訊
4. `npm run dev`

## 資料庫
使用 Supabase SQL Editor 或 Supabase CLI 執行 `supabase/migrations/0001_initial.sql`。正式執行前請先在測試專案驗證 migration 與 RLS。

## 安全原則
- 不提交任何 API key、service role key、密碼或真實客戶資料。
- 前端只使用 Supabase anon/publishable key；service role 僅限可信任伺服器環境。
- 所有店家資料表以 tenant_id 隔離並啟用 RLS。
- 訂單金額必須由伺服器／資料庫依商品現價計算，不信任瀏覽器傳入價格。

## 本機 PostgreSQL 驗證（僅限 disposable local DB）

目前無法從 Git repository 判定 migration 0001 是否已套用到任何 Supabase 環境；migration 檔案本身不包含環境執行紀錄。請勿以修改舊 migration 取代已部署環境的升級。商品唯一約束由後續 migration `0002_product_identity_unique.sql` 加入，若既有資料有重複商品，migration 會停止並列出需要人工處理的原因，不會自動刪除資料。

建立一個可丟棄的本機 PostgreSQL database 後，執行：

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/haoshiguang_test bash scripts/test-db.sh
```

腳本只接受 localhost、127.0.0.1 或 ::1，並依序執行 0001、0002、Seed 兩次，以及停售保留／商品唯一性斷言。**不要將正式 Supabase URL 放入 TEST_DATABASE_URL。** 測試資料會寫入指定的本機測試資料庫，建議使用全新且可丟棄的 database。
