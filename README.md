# 好食光｜SaaS 訂餐系統

好食光是面向台灣餐飲店家的多租戶 SaaS 訂餐平台。第一家 Pilot 店家為「老張麵店」。

## 產品設定
- 店家模式：SaaS，多租戶
- 上線策略：Pilot
- 店家網址：Subdomain（例如 `laozhang.haoshiguang.tw`）
- 語系／幣別：繁體中文／TWD
- 技術：Next.js App Router、TypeScript、Supabase PostgreSQL + Auth、Vercel

## 開發狀態
目前已完成第一階段 Pilot 功能：顧客菜單與購物車、伺服器端價格重算及訂單建立、店家登入與訂單狀態管理、商品／分類管理、營業時間／公休／暫停接單、店家資料管理、訂單追蹤與店家新訂單提醒。新增的第一位店家負責人初始化及會員邀請 API，仍須在隔離 Supabase Auth 環境驗證郵件邀請與完整瀏覽器流程。

資料庫 migrations、RLS、結帳併發與目前 E2E 均以 disposable local PostgreSQL／Supabase 驗證。CI 通過不代表 hosted Supabase、Vercel Cron、DNS 或正式顧客流程已驗證。

**目前尚未正式上線。** 正式環境仍需設定 hosted Supabase、正式環境密鑰、Vercel Cron、trusted ingress、subdomain/DNS，並完成 hosted Preview 的顧客與店家端到端驗收。

## 本機啟動
1. 安裝 Node.js 20+。
2. 安裝相容版本的 Supabase CLI（目前 `supabase/config.toml` 以 CLI v2 為驗證基準）。
3. 安裝依賴：`npm ci`。
4. 複製 `.env.example` 為 `.env.local`，填入本機 Supabase URL、anon key、service-role key。
5. 啟動本機 Supabase：`supabase start`。
6. 套用 migrations：`supabase db reset`。此命令會重設**本機 Supabase**資料庫，不可對 hosted／正式專案執行。
7. 依本機 Supabase 狀態取得 DB URL，執行 `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed/001_laozhang_pilot.sql`。
8. 啟動 Next.js：`npm run dev`。

## 店家帳號初始化與會員邀請

第一位 Pilot 負責人只能透過 server-only bootstrap endpoint 初始化。必須在可信任伺服器環境設定 `PILOT_OWNER_BOOTSTRAP_TENANT_ID`（精確的 Pilot tenant UUID）及獨立高熵 `PILOT_OWNER_BOOTSTRAP_SECRET`（至少 32 bytes），再以 HTTPS 呼叫 `POST /api/merchant/bootstrap`，並在 `x-pilot-bootstrap-secret` header 提供該 secret、JSON body 提供負責人 email。資料庫以鎖定的 singleton claim 保證只成功一次；成功後立即移除兩個 bootstrap 環境變數。不要把 secret 放入 URL、前端程式、工單或日誌。

登入後，店家負責人可透過 `/api/merchant/members` 管理會員 API：owner 可邀請 manager/staff；manager 僅可邀請 staff。兩者可查看會員；owner 可移除 manager/staff，manager 僅可移除 staff。邀請紀錄以店家與 email 唯一化，重試會檢查並補齊既有會員權限，不重複建立邀請。一般邀請不允許授予 owner。負責人移轉目前不支援，必須另行設計安全的移轉流程。目前已提供店家後台會員管理頁面與 API。

## 環境變數與安全

- `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` 可由瀏覽器使用。
- `SUPABASE_SERVICE_ROLE_KEY`、`PILOT_OWNER_BOOTSTRAP_SECRET` 僅限 server-only。
- 不提交任何 API key、service-role key、bootstrap secret、密碼或真實顧客資料。
- 所有店家資料表以 tenant_id 隔離並啟用 RLS；service role 僅由可信任 server routes 使用。
- 訂單金額由伺服器／資料庫依商品現價計算，不信任瀏覽器傳入價格。
- 訂單追蹤 token 為敏感憑證；資料庫只保存 HMAC hash。

## 資料庫與 migration

Migration 位於 `supabase/migrations/`，依檔名時間順序執行。新增 schema 變更時新增 migration，不要修改可能已在其他環境套用的舊 migration。正式執行前必須先在獨立測試 Supabase 專案驗證 migration、RLS、權限及回復策略。

## 資料保留排程

`vercel.json` 設定每日 03:17 UTC（台灣時間 11:17）呼叫 `GET /api/cron/order-retention`。部署環境需設定獨立 server-only `CRON_SECRET`、Supabase URL 與 service-role key。排程只清理過期 rate-limit hashes 與 checkout idempotency records，不刪除訂單、顧客聯絡資料或追蹤連結。程式碼與隔離 SQL 測試通過不代表 hosted Cron 已驗證。

## 本機 PostgreSQL 驗證（僅限 disposable local DB）

`scripts/test-merchant-db.sh` 只接受 loopback PostgreSQL URL，依序套用所有 timestamped migrations、Pilot seed 與隔離權限測試。**不要將正式 Supabase URL 放入 TEST_DATABASE_URL。**
