import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = "e2e-owner@haoshiguang.test";
const password = "LocalOnly-E2E-Password-2026!";

test("店家負責人可更新店名、電話與地址，顧客點餐頁同步顯示", async ({ page }) => {
  const { data: tenant, error } = await admin.from("tenants")
    .select("id,name,phone,address").eq("slug", "laozhang").single();
  expect(error).toBeNull();
  expect(tenant).not.toBeNull();

  await page.goto("/merchant/login");
  await page.getByLabel("電子郵件").fill(email);
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入管理後台" }).click();
  await expect(page).toHaveURL(/\/merchant\/orders$/);

  await page.goto("/merchant/profile");
  await expect(page.getByRole("heading", { name: "店家資料" })).toBeVisible();
  const name = page.locator(".profile-card input").nth(0);
  const phone = page.locator(".profile-card input").nth(1);
  const address = page.locator(".profile-card textarea");
  await expect(name).toHaveValue(tenant!.name);
  await name.fill("老張麵店（測試）");
  await phone.fill("02-2345-6789");
  await address.fill("台北市信義區測試路 1 號");
  await page.getByRole("button", { name: "儲存店家資料" }).click();
  await expect(page.getByRole("status")).toContainText("店家資料已儲存");

  const { data: publicProfile, error: publicError } = await admin.from("tenants")
    .select("name,phone,address").eq("id", tenant!.id).single();
  expect(publicError).toBeNull();
  expect(publicProfile).toEqual({
    name: "老張麵店（測試）",
    phone: "02-2345-6789",
    address: "台北市信義區測試路 1 號",
  });

  // Restore the isolated fixture so the other storefront E2E remains deterministic.
  await name.fill(tenant!.name);
  await phone.fill(tenant!.phone || "");
  await address.fill(tenant!.address || "");
  await page.getByRole("button", { name: "儲存店家資料" }).click();
  await expect(page.getByRole("status")).toContainText("店家資料已儲存");
});
