import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status });
const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Day = typeof days[number];
type Slot = { open: string; close: string };
type Hours = Partial<Record<Day, Slot[]>>;
type SettingsBody = { tenantId?: unknown; isAcceptingOrders?: unknown; prepTimeMinutes?: unknown; weeklyHours?: unknown; closedDates?: unknown };

function validHours(value: unknown): value is Hours {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !days.includes(key as Day))) return false;
  for (const slots of Object.values(record)) {
    if (!Array.isArray(slots) || slots.length > 2) return false;
    let previousClose = "";
    for (const slot of slots) {
      if (!slot || typeof slot !== "object") return false;
      const { open, close } = slot as Record<string, unknown>;
      if (typeof open !== "string" || typeof close !== "string" ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(open) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(close) || open >= close ||
          (previousClose && open < previousClose)) return false;
      previousClose = close;
    }
  }
  return true;
}

function validDates(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 90 &&
    value.every(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) &&
    new Set(value).size === value.length;
}

async function context() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { supabase: null, userId: null, response: fail("請先登入店家管理帳號。", 401) };
  return { supabase, userId: user.id, response: null };
}

async function canManage(supabase: NonNullable<Awaited<ReturnType<typeof context>>["supabase"]>, userId: string, tenantId: string) {
  const { data } = await supabase.from("memberships").select("role")
    .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  return data?.role === "owner" || data?.role === "manager";
}

export async function GET(request: NextRequest) {
  const { supabase, userId, response } = await context();
  if (response || !supabase || !userId) return response;
  const { data: memberships, error } = await supabase.from("memberships")
    .select("tenant_id,role,tenants(id,name,slug)").eq("user_id", userId);
  if (error) return fail("無法讀取店家權限。", 403);
  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ memberships: memberships || [] }, { headers: { "Cache-Control": "no-store" } });
  if (!(memberships || []).some(item => item.tenant_id === tenantId)) return fail("沒有這間店的查看權限。", 403);
  const { data, error: settingsError } = await supabase.from("store_settings")
    .select("tenant_id,is_accepting_orders,prep_time_minutes,weekly_hours,closed_dates,updated_at")
    .eq("tenant_id", tenantId).maybeSingle();
  if (settingsError) return fail("無法讀取營業設定，請確認資料庫 Migration。", 503);
  const role = memberships.find(item => item.tenant_id === tenantId)?.role;
  return NextResponse.json({
    settings: data || { tenant_id: tenantId, is_accepting_orders: true, prep_time_minutes: 20, weekly_hours: {}, closed_dates: [] },
    canManage: role === "owner" || role === "manager",
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const { supabase, userId, response } = await context();
  if (response || !supabase || !userId) return response;
  let body: SettingsBody;
  try { body = await request.json() as SettingsBody; } catch { return fail("請確認設定資料格式。", 400); }
  if (typeof body.tenantId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.tenantId)) return fail("店家識別碼格式錯誤。", 400);
  if (!(await canManage(supabase, userId, body.tenantId))) return fail("只有店家負責人或管理者可以修改營業設定。", 403);
  if (typeof body.isAcceptingOrders !== "boolean") return fail("接單狀態格式錯誤。", 400);
  if (!Number.isInteger(body.prepTimeMinutes) || (body.prepTimeMinutes as number) < 5 || (body.prepTimeMinutes as number) > 180) return fail("備餐時間需介於 5 至 180 分鐘。", 400);
  if (!validHours(body.weeklyHours)) return fail("營業時間格式錯誤；每日最多兩個時段，且結束時間須晚於開始時間。", 400);
  if (!validDates(body.closedDates)) return fail("公休日格式錯誤，最多可設定 90 天且不可重複。", 400);
  const { data, error } = await supabase.from("store_settings").upsert({
    tenant_id: body.tenantId, is_accepting_orders: body.isAcceptingOrders,
    prep_time_minutes: body.prepTimeMinutes, weekly_hours: body.weeklyHours,
    closed_dates: body.closedDates, updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id" }).select().single();
  if (error) return fail("儲存營業設定失敗，請確認 Migration 已套用。", 503);
  return NextResponse.json({ settings: data });
}
