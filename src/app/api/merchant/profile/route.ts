import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function authenticatedContext() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { supabase: null, userId: null, response: fail("請先登入店家管理帳號。", 401) };
  }
  return { supabase, userId: user.id, response: null };
}

async function membershipRole(
  supabase: NonNullable<Awaited<ReturnType<typeof authenticatedContext>>["supabase"]>,
  userId: string,
  tenantId: string,
) {
  const { data, error } = await supabase.from("memberships").select("role")
    .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  if (error) return { role: null, error: true };
  return { role: data?.role || null, error: false };
}

export async function GET(request: NextRequest) {
  const { supabase, userId, response } = await authenticatedContext();
  if (response) return response;
  if (!supabase || !userId) return fail("請先登入店家管理帳號。", 401);

  const tenantId = request.nextUrl.searchParams.get("tenantId") || "";
  if (!uuidPattern.test(tenantId)) return fail("店家識別碼格式錯誤。", 400);

  const membership = await membershipRole(supabase, userId, tenantId);
  if (membership.error) return fail("無法讀取店家權限。", 503);
  if (!membership.role) return fail("沒有這間店的查看權限。", 403);

  const { data, error } = await supabase.from("tenants")
    .select("id,name,slug,phone,address")
    .eq("id", tenantId).maybeSingle();
  if (error) return fail("無法讀取店家資料。", 503);
  if (!data) return fail("找不到店家。", 404);

  return NextResponse.json({
    profile: data,
    canManage: membership.role === "owner" || membership.role === "manager",
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const { supabase, userId, response } = await authenticatedContext();
  if (response) return response;
  if (!supabase || !userId) return fail("請先登入店家管理帳號。", 401);

  let body: { tenantId?: unknown; name?: unknown; phone?: unknown; address?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return fail("請確認店家資料格式。", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.tenantId !== "string" || !uuidPattern.test(body.tenantId)) {
    return fail("店家識別碼格式錯誤。", 400);
  }
  if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 80) {
    return fail("店家名稱需為 1 至 80 個字。", 400);
  }
  if (typeof body.phone !== "string" || body.phone.trim().length > 30) {
    return fail("聯絡電話不可超過 30 個字。", 400);
  }
  if (typeof body.address !== "string" || body.address.trim().length > 200) {
    return fail("店家地址不可超過 200 個字。", 400);
  }

  const membership = await membershipRole(supabase, userId, body.tenantId);
  if (membership.error) return fail("無法驗證店家權限。", 503);
  if (membership.role !== "owner" && membership.role !== "manager") {
    return fail("只有店家負責人或管理者可以修改店家資料。", 403);
  }

  // The database RLS policy is the final authorization boundary; the API role
  // check provides a clear error but cannot grant access across tenants.
  const { data, error } = await supabase.from("tenants").update({
    name: body.name.trim(),
    phone: body.phone.trim() || null,
    address: body.address.trim() || null,
  }).eq("id", body.tenantId).select("id,name,slug,phone,address").maybeSingle();

  if (error) return fail("儲存店家資料失敗，請確認資料庫 Migration。", 503);
  if (!data) return fail("找不到店家或沒有修改權限。", 403);
  return NextResponse.json({ profile: data });
}
