# Hosted Preview 操作手冊（安全驗收版）

> 目的：在**全新、可丟棄的 Hosted Supabase Preview 專案**與 Vercel Preview deployment 驗證好食光 Pilot 流程。  
> 本文件不是 Production 上線授權。未取得另外明確授權前，不得部署 Production、修改正式 Supabase、邀請真實店家或接收真實訂單。

## 0. 驗收原則

1. Hosted Preview 必須使用獨立 Supabase 專案、獨立 tenant、獨立 Auth 測試信箱及獨立 secrets。
2. 不可將本機 `supabase/config.toml` 的 `haoshiguang-isolated` 當成 Hosted 專案識別。
3. 先核對 Supabase Project Ref、專案名稱、區域及 Vercel Preview URL；任何一項不明即停止。
4. migration 僅能套用至明確標記為 disposable Preview 的新專案。禁止對 Production 執行 `supabase db push`、`supabase db reset` 或 SQL 寫入。
5. secrets 只透過受控的 Vercel Preview Environment Variables / 密碼管理器輸入；不可貼到 GitHub issue、PR、聊天、截圖或日誌。
6. 不將 CI 綠燈、Preview build 成功或單一瀏覽器流程視為正式上線驗收。
7. 每一階段保留不含 secrets、個資、token、完整連線字串的證據。

## 1. 開始前核對（未完成不得操作）

- [ ] 使用者已明確指定本輪使用哪一個 disposable Hosted Supabase Preview 專案。
- [ ] 已記錄並由第二次獨立核對確認 Supabase Project Ref；確認它不是 Production 專案。
- [ ] 已確認該專案可完全丟棄，且沒有真實顧客、真實訂單或正式資料。
- [ ] 已確認 Vercel 專案與 Git branch，部署目標只能是 Preview。
- [ ] 已準備一個由測試人員控制的測試信箱；不得使用真實店主或顧客信箱。
- [ ] 已準備備份／刪除 Preview 專案的方式；明確知道刪除的是 disposable 專案。
- [ ] 已確認本次不會修改 Production environment variables、Production domain 或 Production Supabase。

**停止條件：** Supabase Project Ref 不確定、Vercel environment scope 不確定、看到真實資料、或 CLI 顯示將操作 Production 時，立即停止，不可嘗試「先跑看看」。

## 2. 建立 Hosted Supabase Preview

1. 在 Supabase Dashboard 建立全新專案，名稱清楚標示 `haoshiguang-disposable-preview`（名稱可依實際環境調整）。
2. 記錄 Project Ref、專案 URL、區域與建立時間；不要把 service-role key 或資料庫密碼放進紀錄。
3. 在 Authentication 設定測試用 Site URL 與 Redirect URLs，僅允許本輪 Vercel Preview 網域及程式實際使用的回呼路徑。
4. 使用專用測試信箱驗證邀請信寄送與接受流程；不可開放不必要的公開註冊。
5. 不匯入 Production 資料。Pilot seed 只使用 repository 內的測試菜單資料。

## 3. 套用 migrations（只允許 disposable Preview）

在本機專案目錄操作，先檢查 CLI 目前連線狀態與目標 Project Ref。不要在命令列、終端輸出或 shell history 中留下資料庫密碼。

建議順序：

1. 確認工作目錄、Git branch 與 migration 檔案版本。
2. 使用 Supabase CLI link 到本輪 disposable Preview Project Ref；不要 link 到 Production。
3. 執行 dry-run，逐項檢查待套用 migration。
4. 再次比對 CLI 顯示的 Project Ref 與第 1 節記錄；不一致就停止。
5. 只有在目標已由兩次核對確認為 disposable Preview 後，才可對該專案執行 migration push。
6. 驗證所有 migrations 已套用、RLS 啟用、RPC grants 正確，並保存不含敏感值的 migration 清單與結果。
7. 只在此 disposable Preview tenant 執行 Pilot seed；確認 seed 可重複執行且不產生重複商品。

**禁止：** 對 Hosted/Production 執行 `supabase db reset`。本機 `supabase db reset` 只可用於 disposable local Supabase。

## 4. Vercel Preview 環境變數

所有下列變數必須設定在 Vercel 的 **Preview scope**，不得誤設為 Production scope。部署前再次檢查 Environment 欄位。

| 變數 | Hosted Preview 設定要求 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | 本輪 disposable Preview Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 同一 Preview 專案的 anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | 同一 Preview 專案的 service-role key；server-only |
| `NEXT_PUBLIC_APP_DOMAIN` | 本輪 Preview 使用的應用網域 |
| `ORDER_TRACKING_HMAC_KEYS` | 至少 32 bytes 的獨立隨機 key ring；不可重用任何其他 key |
| `ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION` | 必須指向 key ring 中存在的版本 |
| `CRON_SECRET` | 獨立高熵值；不可重用 HMAC、Supabase 或 bootstrap secret |
| `PILOT_OWNER_BOOTSTRAP_TENANT_ID` | 只有執行一次性 bootstrap 前才暫時設定為 Preview tenant UUID |
| `PILOT_OWNER_BOOTSTRAP_SECRET` | 只有執行一次性 bootstrap 前才暫時設定為獨立高熵值 |

- HMAC key 與 `PILOT_OWNER_BOOTSTRAP_SECRET` 均至少 32 UTF-8 bytes，且各自獨立產生；可用密碼管理器或安全隨機產生器產生。
- `ORDER_TRACKING_HMAC_KEYS` 必須是合法 JSON object，版本使用正整數字串；active version 必須存在。
- 不可將 `SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET`、bootstrap secret 或 HMAC key 設為 `NEXT_PUBLIC_*`。
- `.env.example` 的值全部是 placeholder，不可直接複製到 Hosted Preview。
- 不要在公開 CI log 印出完整環境變數或 `supabase status -o env` 輸出。

## 5. Vercel Preview 部署前檢查

- [ ] Git branch / commit 是本次核准的 PR head。
- [ ] Vercel Project 正確，Git integration 指向 `kevinlf2904/haoshiguang-saas`。
- [ ] 所有 Hosted Supabase URL / keys 均指向 disposable Preview 專案。
- [ ] secrets 的 Environment scope 全部為 Preview；Production scope 未被修改。
- [ ] `NEXT_PUBLIC_APP_DOMAIN` 與 Preview 網域相符。
- [ ] build log 沒有 secrets、完整連線字串或測試個資。
- [ ] Preview deployment URL 可辨識且不會覆蓋 Production domain。

只有使用者明確授權部署 Preview 後，才執行部署。部署 Preview 不等於授權 Production。

## 6. Owner bootstrap（一次性、僅測試帳號）

前置條件：

- disposable Preview migrations、RLS、bootstrap RPC tests 已通過。
- 已人工核對 Preview tenant UUID。
- 已確認測試信箱由測試人員控制，且不是真實店主帳號。
- 已設定 Preview-only `PILOT_OWNER_BOOTSTRAP_TENANT_ID` 與獨立 `PILOT_OWNER_BOOTSTRAP_SECRET`。

操作要求：

1. 使用 HTTPS 呼叫 `POST /api/merchant/bootstrap`。
2. secret 僅放在 `x-pilot-bootstrap-secret` request header，不可放 URL、query string、body、前端程式或工單。
3. JSON body 只提供測試負責人 email。
4. 收到成功回應後，立即從 Vercel Preview environment 移除兩個 bootstrap variables，並觸發 Preview 設定生效所需的受控更新流程。
5. 驗證測試信箱收到邀請、可完成登入，且資料庫只建立一位該 tenant 的 owner。
6. 驗證重放同一 bootstrap request 不會建立第二位 owner 或重複邀請。
7. 若結果不明，不刪除 Auth user、不手動解除 reservation；以相同 email 重試或先查核 Auth metadata / reservation 狀態。
8. 記錄完成時間、測試 tenant、測試帳號代號及 secrets 已移除的證據；不得記錄 email、token 或 secret。

## 7. Hosted Preview 驗收矩陣

| 範圍 | 驗收案例 | 通過條件 |
| --- | --- | --- |
| Auth | 測試 owner 收到邀請並完成登入 | 只屬於指定 Preview tenant |
| Bootstrap | 相同 email 重試 | 冪等，不產生第二個 owner / invitation |
| Bootstrap | 不正確 secret、錯誤 tenant | 拒絕；不建立會員 |
| Members | Owner 邀請 Manager / Staff | 權限正確、tenant scope 正確 |
| Members | Manager 邀請 Staff | 可邀請 Staff；不能提升為 Owner / Manager |
| Members | 跨 tenant 讀取或刪除 | 一律拒絕，無資料洩漏 |
| Storefront | 顧客瀏覽菜單、加入購物車、結帳 | 伺服器重算價格；訂單屬於正確 tenant |
| Checkout | 同一 idempotency key 重送 | 不建立重複訂單 |
| Tracking | 有效追蹤 token | 只回傳該筆訂單允許公開的狀態 |
| Tracking | 無效 / 竄改 token | 不洩漏訂單是否存在或個資 |
| Merchant | 更新訂單狀態 | 僅授權店家成員可更新 |
| Cron route | 缺少 / 錯誤 Bearer secret | 503（未設定）或 401（未授權） |
| Cron route | 正確 secret | 僅清理設計允許的過期 rate-limit / idempotency records |
| Data isolation | tenant A 嘗試存取 tenant B | RLS / RPC / API 全部拒絕 |
| Logs | 檢查應用與平台日誌 | 不含 secrets、bearer token、完整電話或不必要個資 |

Hosted Preview 的 Cron route 可用受控測試請求驗證授權邊界；不要把 Preview endpoint 的手動呼叫當成 Vercel 排程已正式啟用的證據。Production Cron 必須在另行核准部署後獨立驗收。

## 8. 完成後清理與證據

- [ ] 移除 `PILOT_OWNER_BOOTSTRAP_TENANT_ID`。
- [ ] 移除 `PILOT_OWNER_BOOTSTRAP_SECRET`。
- [ ] 確認 Preview deployment 已讀取移除後的環境設定。
- [ ] 確認測試帳號、tenant、訂單及測試資料均標記為 Preview 測試資料。
- [ ] 確認日誌與截圖已遮罩 email、電話、token、URL query 與所有 secrets。
- [ ] 保存 CI run、migration 狀態、RLS/RPC 測試、E2E 結果、Cron auth 結果及 bootstrap secret 移除證據。
- [ ] 若不再需要，依核准的清理程序刪除 disposable Preview Supabase 專案與測試部署。

## 9. Production 上線是另一個獨立決策

即使 Hosted Preview 全數通過，也不能直接推論 Production Ready。Production 前仍需另行審查：

- 正式 Supabase 專案、tenant、資料備份與復原演練。
- Production secrets、網域、TLS、trusted ingress、監控與告警。
- Production migration 變更計畫、停機／回復策略與核准紀錄。
- 正式店主邀請與真實訂單啟用的明確授權。
- 正式 Vercel deployment 的額度、影響範圍與回滾方式。

**本文件不授權以上任何 Production 操作。**
