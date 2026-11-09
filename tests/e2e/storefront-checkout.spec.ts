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
  await page.reload();
  await expect(page.getByText("海鮮湯麵", { exact: true })).toBeVisible();

  // Merchant signs in and pauses orders through the actual settings UI.
  await page.goto("/merchant/login");
  await page.getByLabel("電子郵件").fill(email);
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入管理後台" }).click();
  await page.goto("/merchant/settings");
  await expect(page.getByRole("heading", { name: "營業設定" })).toBeVisible();
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
  const pausedResponse = await request.post("/api/orders", { data: checkoutBody });
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
  const holidayResponse = await request.post("/api/orders", { data: checkoutBody });
  expect(holidayResponse.status()).toBe(409);
  expect((await holidayResponse.json()).error).toContain("公休日");

  // Remove the holiday and create a real order through the customer-facing browser flow.
  await page.goto("/merchant/settings");
  await page.locator(".closed-date-list span").filter({ hasText: today })
    .getByRole("button", { name: "移除" }).click();
  await page.getByRole("button", { name: "儲存營業設定" }).click();
  await expect(page.getByRole("status")).toContainText("營業設定已儲存");

  await page.goto("/store/laozhang");
  await expect(page.getByText("線上接單中", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "加入海鮮湯麵" }).click();
  await page.getByLabel("稱呼").fill(customerName);
  await page.getByLabel("聯絡電話").fill("0912345678");
  await page.getByRole("button", { name: /送出訂單/ }).click();
  await expect(page.getByText("訂單已建立")).toBeVisible();
  await expect(page.getByText("應付金額 NT$180")).toBeVisible();

  // The same committed order is visible to the authenticated tenant and can be accepted.
  await page.goto("/merchant/orders");
  await expect(page.getByText(customerName)).toBeVisible();
  await expect(page.getByText("海鮮湯麵 × 1")).toBeVisible();
  await page.getByRole("button", { name: "接受訂單" }).first().click();
  await expect(page.getByText("已接單").first()).toBeVisible();
});
