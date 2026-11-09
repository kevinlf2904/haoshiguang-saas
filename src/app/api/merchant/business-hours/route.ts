import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("slug");
  if (slug) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return fail("營業資訊暫時無法取得。", 503);
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: tenant } = await client.from("tenants").select("id,slug,weekly_hours,special_hours,accepting_orders,prep_time_minutes").eq("slug", slug).eq("is_active", true).maybeSingle();
    if (!tenant) return fail("找不到店家。", 404);
    const { data: accepting } = await client.rpc("is_store_accepting_orders", { target_tenant: tenant.id });
    return NextResponse.json({ weeklyHours: tenant.weekly_hours, specialHours: tenant.special_hours,
      acceptingOrders: Boolean(tenant.accepting_orders && accepting), prepTimeMinutes: tenant.prep_time_minutes },
      { headers: { "Cache-Control": "no-store" } });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return fail("請先登入店家管理帳號。", 401);
  const { data: memberships, error } = await supabase.from("memberships")
    .select("tenant_id,role,tenants(id,name,slug,weekly_hours,special_hours,accepting_orders,prep_time_minutes)")
    .eq("user_id", user.id);
  if (error) return fail("無法讀取店家權限。", 403);
  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ memberships: memberships || [] }, { headers: { "Cache-Control": "no-store" } });
  if (!uuid(tenantId)) return fail("店家識別碼格式錯誤。", 400);
  const membership = (memberships || []).find(item => item.tenant_id === tenantId);
  if (!membership || !["owner", "manager"].includes(membership.role)) return fail("只有店家負責人或管理者可以修改營業設定。", 403);
  return NextResponse.json({ tenant: membership.tenants }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return fail("請先登入店家管理帳號。", 401);
  let body: { tenantId?: unknown; weeklyHours?: unknown; specialHours?: unknown; acceptingOrders?: unknown; prepTimeMinutes?: unknown };
  try { body = await request.json(); } catch { return fail("設定資料格式錯誤。", 400); }
  if (!uuid(body.tenantId)) return fail("店家識別碼格式錯誤。", 400);
  const { data: membership } = await supabase.from("memberships").select("role")
    .eq("tenant_id", body.tenantId).eq("user_id", user.id).maybeSingle();
  if (!membership || !["owner", "manager"].includes(membership.role)) return fail("只有店家負責人或管理者可以修改營業設定。", 403);
  if (body.weeklyHours === undefined || body.specialHours === undefined || typeof body.acceptingOrders !== "boolean"
      || !Number.isInteger(body.prepTimeMinutes) || Number(body.prepTimeMinutes) < 5 || Number(body.prepTimeMinutes) > 240) {
    return fail("請確認營業時間、公休日、接單狀態及備餐時間。", 400);
  }
  const validIntervals = (value: unknown): value is Array<{ open: string; close: string }> =>
    Array.isArray(value) && value.length <= 4 && value.every(slot =>
      slot && typeof slot === "object" && !Array.isArray(slot)
      && typeof slot.open === "string" && /^([01]\\d|2[0-3]):[0-5]\\d$/.test(slot.open)
      && typeof slot.close === "string" && /^([01]\\d|2[0-3]):[0-5]\\d$/.test(slot.close)
      && slot.close > slot.open);
  if (!body.weeklyHours || typeof body.weeklyHours !== "object" || Array.isArray(body.weeklyHours)
      || !body.specialHours || typeof body.specialHours !== "object" || Array.isArray(body.specialHours)) return fail("營業時間格式錯誤。", 400);
  const weekly = body.weeklyHours as Record<string, unknown>;
  if (Object.keys(weekly).some(day => !/^[0-6]$/.test(day)) || Array.from({length:7},(_,i)=>String(i)).some(day => !validIntervals(weekly[day]))) {
    return fail("每週營業時段格式錯誤；每一天最多四個時段，且結束時間必須晚於開始時間。", 400);
  }
  const special = body.specialHours as Record<string, unknown>;
  for (const [date, value] of Object.entries(special)) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !value || typeof value !== "object" || Array.isArray(value)) return fail("特殊營業日期格式錯誤。", 400);
    const override = value as { closed?: unknown; intervals?: unknown };
    if (override.closed !== true && !validIntervals(override.intervals)) return fail("特殊營業日必須設定 closed:true 或有效 intervals。", 400);
  }
  const { data, error } = await supabase.from("tenants").update({
    weekly_hours: body.weeklyHours, special_hours: body.specialHours,
    accepting_orders: body.acceptingOrders, prep_time_minutes: body.prepTimeMinutes,
  }).eq("id", body.tenantId).select("id,weekly_hours,special_hours,accepting_orders,prep_time_minutes").maybeSingle();
  if (error || !data) return fail("儲存營業設定失敗，請確認資料庫 migration 已套用。", 400);
  return NextResponse.json({ tenant: data });
}
