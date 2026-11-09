import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = "e2e-owner@haoshiguang.test";
const password = "LocalOnly-E2E-Password-2026!";
const customerName = "E2E 完整流程顧客";

function taipeiDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)?.value || "";
  return value("year") + "-" + value("month") + "-" + value("day");
}

test("顧客菜單 → 店家營業設定 → 資料庫拒單 → 真實建立訂單 → 店家接單", async ({ page, request }) => {
  const { data: tenant, error: tenantError } = await admin.from("tenants")
    .select("id").eq("slug", "laozhang").single();
  expect(tenantError).toBeNull();
  expect(tenant).not.toBeNull();

  // Prove the public menu reflects live catalog availability rather than a static JSON snapshot.
  const { data: soldOut } = await admin.from("products").select("id")
    .eq("tenant_id", tenant!.id).eq("name", "海鮮湯麵").single();
  expect(soldOut).not.toBeNull();
  await admin.from("products").update({ is_available: false }).eq("id", soldOut!.id);
  await page.goto("/store/laozhang");
  await expect(page.getByRole("heading", { name: "老張麵店" })).toBeVisible();
  await expect(page.getByText("海鮮湯麵", { exact: true })).toHaveCount(0);
  await admin.from("products").update({ is_available: true }).eq("id", soldOut!.id);

  const { data: soupCategory } = await admin.from("categories").select("id")
    .eq("tenant_id", tenant!.id).eq("name", "湯類").single();
  expect(soupCategory).not.toBeNull();
  await admin.from("categories").update({ is_active: false }).eq("id", soupCategory!.id);
  await page.reload();
  await expect(page.getByRole("button", { name: "湯類", exact: true })).toHaveCount(0);
  await admin.from("categories").update({ is_active: true }).eq("id", soupCategory!.id);
  await page.reload();
  await expect(page.getByText("海鮮湯麵", { exact: true })).toBeVisible();
  await expect(page.locator(".menu-count")).toContainText("27");

  // Merchant signs in and pauses orders through the actual settings UI.
  await page.goto("/merchant/login");
  await page.getByLabel("電子郵件").fill(email);
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入管理後台" }).click();
  // The click resolves before the async sign-in handler finishes; wait for its redirect
  // so Supabase SSR cookies are persisted before navigating to a protected page.
  await expect(page).toHaveURL(/\/merchant\/orders$/);
  await page.goto("/merchant/settings");
  await expect(page.getByRole("heading", { name: "營業設定" })).toBeVisible();
  // Emit only non-secret auth diagnostics so CI distinguishes session, membership and UI failures.
  const authProbe = await page.evaluate(async () => {
    const response = await fetch("/api/merchant/settings", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    return {
      status: response.status,
      body,
      cookieNames: document.cookie.split(";").map(item => item.trim().split("=")[0]).filter(Boolean),
      storageKeys: Object.keys(localStorage).filter(key => key.startsWith("sb-")),
      pageText: document.body.innerText.slice(0, 1200),
    };
  });
  console.log("MERCHANT_SETTINGS_AUTH_DIAGNOSTIC", JSON.stringify(authProbe));
  // Wait for the authenticated owner controls, not merely the page shell heading.
  await expect(page.getByRole("button", { name: "接單中 · 點擊暫停" })).toBeVisible();
  await expect(page.locator(".prep-time-card input")).toBeVisible();
  await page.locator(".prep-time-card input").fill("35");
  await page.getByRole("button", { name: "接單中 · 點擊暫停" }).click();
  await page.getByRole("button", { name: "儲存營業設定" }).click();
  await expect(page.getByRole("status")).toContainText("營業設定已儲存");

  await page.goto("/store/laozhang");
  await expect(page.getByText("目前暫停線上接單")).toBeVisible();
  const checkoutBody = {
    storeSlug: "laozhang", customerName, customerPhone: "0912345678",
    fulfillment: "takeaway", tableLabel: "", note: "",
    items: [{ name: "海鮮湯麵", category: "湯麵類", quantity: 1 }],
  };
  const pausedResponse = await request.post("/api/orders", { data: checkoutBody, headers: { "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" } });
  expect(pausedResponse.status()).toBe(404);
  expect((await pausedResponse.json()).error).toContain("暫停接單");

  // Resume orders, add today's Taipei date as a holiday, and prove the RPC still blocks checkout.
  await page.goto("/merchant/settings");
  await page.getByRole("button", { name: "已暫停 · 點擊恢復" }).click();
  const today = taipeiDate();
  await page.locator('input[type="date"]').fill(today);
  await page.getByRole("button", { name: "新增公休日" }).click();
  await page.getByRole("button", { name: "儲存營業設定" }).click();
  await expect(page.getByRole("status")).toContainText("營業設定已儲存");

  await page.goto("/store/laozhang");
  await expect(page.getByText("目前暫停線上接單")).toBeVisible();
  const holidayResponse = await request.post("/api/orders", { data: checkoutBody, headers: { "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" } });
  expect(holidayResponse.status()).toBe(409);
  expect((await holidayResponse.json()).error).toContain("公休日");

  // Remove the holiday and create a real order through the customer-facing browser flow.
  await page.goto("/merchant/settings");
  await page.locator(".closed-date-list span").filter({ hasText: today })
    .getByRole("button", { name: "移除" }).click();
  await page.getByRole("button", { name: "儲存營業設定" }).click();
  await expect(page.getByRole("status")).toContainText("營業設定已儲存");

  await page.goto("/store/laozhang");
  await expect(page.getByText("線上接單中 · 預計備餐 35 分鐘")).toBeVisible();
  await page.getByRole("button", { name: "加入海鮮湯麵" }).click();
  await page.getByLabel("稱呼").fill(customerName);
  await page.getByLabel("聯絡電話").fill("0912345678");
  const checkoutResponsePromise = page.waitForResponse(response => response.url().includes("/api/orders") && response.request().method() === "POST");
  await page.getByRole("button", { name: /送出訂單/ }).click();
  const checkoutResponse = await checkoutResponsePromise;
  expect(checkoutResponse.status()).toBe(201);
  const checkoutPayload = await checkoutResponse.json() as { order?: { order_number?: number; total?: number; currency?: string } };
  expect(checkoutPayload.order?.order_number).toBeTruthy();
  expect(checkoutPayload.order?.currency).toBe("TWD");
  expect(Number(checkoutPayload.order?.total)).toBe(180);
  await expect(page.getByText("訂單已建立")).toBeVisible();
  await expect(page.locator(".checkout-result span")).toHaveText("應付金額 NT$180");

  // The same committed order is visible to the authenticated tenant and can be accepted.
  await page.goto("/merchant/orders");
  await expect(page.getByText(customerName)).toBeVisible();
  await expect(page.getByText("海鮮湯麵 × 1")).toBeVisible();
  await page.getByRole("button", { name: "接受訂單" }).first().click();
  await expect(page.getByText("已接單").first()).toBeVisible();
});
