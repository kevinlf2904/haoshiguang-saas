import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Local Supabase URL and service role key are required.");

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = "e2e-owner@haoshiguang.test";
const password = "LocalOnly-E2E-Password-2026!";
const { data: created, error: createError } = await admin.auth.admin.createUser({
  email, password, email_confirm: true,
});
if (createError) throw createError;

const { data: tenant, error: tenantError } = await admin.from("tenants")
  .select("id").eq("slug", "laozhang").single();
if (tenantError || !tenant) throw tenantError || new Error("Pilot tenant fixture is missing.");

const { error: membershipError } = await admin.from("memberships").upsert({
  tenant_id: tenant.id,
  user_id: created.user.id,
  role: "owner",
}, { onConflict: "tenant_id,user_id" });
if (membershipError) throw membershipError;

console.log("Created isolated local merchant owner fixture.");
