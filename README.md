# 好食光｜SaaS 訂餐系統

好食光是面向台灣餐飲店家的多租戶 SaaS 訂餐平台。第一家 Pilot 店家為「老張麵店」。

## 產品設定
- 店家模式：SaaS，多租戶
- 上線策略：Pilot
- 店家網址：Subdomain（例如 `laozhang.haoshiguang.tw`）
- 語系／幣別：繁體中文／TWD
- 技術：Next.js App Router、TypeScript、Supabase PostgreSQL + Auth、Vercel

## 開發狀態
目前為專案起始骨架與資料庫初始 migration。尚未完成 Supabase 專案連線、登入流程、完整 RLS 驗證、訂單 API、正式付款或正式營運部署。不要將目前預覽頁視為可接收真實訂單的系統。

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
