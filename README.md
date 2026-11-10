# 好食光｜SaaS 訂餐系統

好食光是面向台灣餐飲店家的多租戶 SaaS 訂餐平台。第一家 Pilot 店家為「老張麵店」。

## 產品設定
- 店家模式：SaaS，多租戶
- 上線策略：Pilot
- 店家網址：Subdomain（例如 `laozhang.haoshiguang.tw`）
- 語系／幣別：繁體中文／TWD
- 技術：Next.js App Router、TypeScript、Supabase PostgreSQL + Auth、Vercel

## 開發狀態
目前已完成第一階段 Pilot 功能：老張麵店顧客菜單與購物車、伺服器端價格重算及訂單建立、店家登入與訂單狀態管理、商品／分類管理、營業時間／公休／暫停接單，以及店家名稱／電話／地址管理。顧客可透過專屬連結查詢訂單進度；店家後台支援新訂單輪詢與使用者啟用的提示音／桌面通知。訂單追蹤使用版本化 HMAC 金鑰，資料保留排程已加入程式碼。

資料庫 migration、RLS、結帳併發與隔離測試均以 disposable local PostgreSQL／Supabase 驗證。GitHub CI 通過不代表 hosted Supabase、Vercel Cron、DNS 或正式顧客流程已驗證。

**目前尚未正式上線。** 尚待 hosted Supabase 專案設定與 migrations、正式店家帳號邀請／管理流程、正式環境密鑰、Vercel Cron、trusted ingress、subdomain/DNS，以及 hosted Preview 的顧客與店家端到端驗收。請勿將目前系統視為可接收真實訂單的正式服務。

## 本機啟動

1. 安裝 Node.js 20+。
2. 安裝相容版本的 Supabase CLI（目前 repository 的 `supabase/config.toml` 以 CLI v2 為驗證基準）。
3. 安裝依賴：`npm ci`。
4. 複製 `.env.example` 為 `.env.local`，填入本機 Supabase URL、anon key、service-role key，以及專用的 tracking HMAC key ring。
5. 啟動本機 Supabase：`supabase start`。
6. 套用所有 timestamped migrations：`supabase db reset`。此命令會重設**本機 Supabase**資料庫；不可對 hosted／正式專案執行。
7. 執行 `supabase status -o env` 查看本機連線資訊，將其中的 `DB_URL` 設定到目前 shell（不要把包含金鑰的完整輸出貼到公開位置），再執行 `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed/001_laozhang_pilot.sql`。
8. 啟動 Next.js：`npm run dev`。

若只執行 `npm run test:db`，該腳本使用 disposable localhost PostgreSQL，僅驗證基礎 migration 與 seed idempotency；完整 migrations、RLS、排程 SQL 與瀏覽器流程由 `.github/workflows/storefront-isolated-e2e.yml` 在隔離 Supabase 執行。

## 環境變數

| 變數 | 用途 | 是否公開 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL | 是 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key | 是 |
| `SUPABASE_SERVICE_ROLE_KEY` | 伺服器端受限資料操作 | **否，僅可信任伺服器** |
| `ORDER_TRACKING_HMAC_KEYS` | 訂單追蹤 token 的版本化 HMAC key ring | **否** |
| `ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION` | 新追蹤連結使用的 key version | **否** |
| `CRON_SECRET` | Vercel Cron 維護端點驗證 | **否** |
| `NEXT_PUBLIC_APP_DOMAIN` | 公開應用程式網域設定 | 是 |

HMAC key 至少 32 bytes，且不得重用 Supabase service-role key 或 CRON secret。產生獨立隨機值可使用 `openssl rand -base64 48`。正式環境不得使用 `.env.example` 中的 placeholder。

## 資料庫與 migration

Migration 位於 `supabase/migrations/`，依檔名時間順序執行。新增 schema 變更時請新增 migration，不要修改已部署環境可能已套用的舊 migration。正式執行前必須先在獨立測試 Supabase 專案驗證 migration、RLS、權限及回復策略。

`supabase/config.toml` 的 project id 是隔離本機測試設定，不代表已建立 hosted Supabase 專案。Repository 目前沒有 hosted migration 執行證據。

## 資料保留排程

`vercel.json` 設定每日 03:17 UTC（台灣時間 11:17）呼叫 `GET /api/cron/order-retention`。部署環境必須設定獨立的 server-only `CRON_SECRET`、Supabase URL 與 service-role key。排程只清理過期的 rate-limit hashes 與 checkout idempotency records，不刪除訂單、餐點明細、顧客姓名、電話、備註或追蹤連結。

程式碼與隔離 SQL 測試已完成，不代表 Vercel Cron 已部署或曾在 hosted Supabase 成功執行。部署後仍須驗證授權拒絕、成功執行、失敗監控與租戶清理統計。

## 安全原則

- 不提交任何 API key、service-role key、HMAC secret、Cron secret、密碼或真實客戶資料。
- 前端只使用 Supabase anon/publishable key；service-role key 僅限可信任伺服器環境。
- 所有店家資料表以 tenant_id 隔離並啟用 RLS；資料庫權限是最終授權界線。
- 訂單金額必須由伺服器／資料庫依商品現價計算，不信任瀏覽器傳入價格。
- 訂單追蹤只保存 HMAC token hash，不保存原始 bearer token；追蹤連結應視同敏感憑證。
- 不要將正式 Supabase URL 放入 `TEST_DATABASE_URL`，也不要對正式資料庫執行本機測試腳本或 `supabase db reset`。
