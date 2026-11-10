import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function context() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { supabase: null, userId: null, response: fail("請先登入店家管理帳號。", 401) };
  return { supabase, userId: user.id, response: null };
}

async function roleFor(supabase: NonNullable<Awaited<ReturnType<typeof context>>["supabase"]>, userId: string, tenantId: string) {
  const { data, error } = await supabase.from("memberships").select("role")
    .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  if (error) return { role: null, error: true };
  return { role: data?.role || null, error: false };
}

function adminClient() {
  try { return createSupabaseAdminClient(); } catch { return null; }
}

export async function GET(request: NextRequest) {
  const { supabase, userId, response } = await context();
  if (response) return response;
  if (!supabase || !userId) return fail("請先登入店家管理帳號。", 401);
  const tenantId = request.nextUrl.searchParams.get("tenantId") || "";
  if (!uuidPattern.test(tenantId)) return fail("店家識別碼格式錯誤。", 400);

  const actor = await roleFor(supabase, userId, tenantId);
  if (actor.error) return fail("無法驗證店家權限。", 503);
  if (actor.role !== "owner" && actor.role !== "manager") return fail("只有負責人或管理者可以查看會員。", 403);

  const admin = adminClient();
  if (!admin) return fail("會員管理服務尚未設定完成。", 503);
  const { data: memberships, error } = await admin.from("memberships")
    .select("id,user_id,role,created_at").eq("tenant_id", tenantId).order("created_at", { ascending: true });
  if (error) return fail("無法讀取店家會員。", 503);

  const members = await Promise.all((memberships || []).map(async member => {
    const { data } = await admin.auth.admin.getUserById(member.user_id);
    return { id: member.id, userId: member.user_id, email: data.user?.email || null, role: member.role, createdAt: member.created_at };
  }));
  return NextResponse.json({ members }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const { supabase, userId, response } = await context();
  if (response) return response;
  if (!supabase || !userId) return fail("請先登入店家管理帳號。", 401);

  let body: { tenantId?: unknown; email?: unknown; role?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return fail("請確認邀請資料格式。", 400); }
  if (!body || typeof body.tenantId !== "string" || !uuidPattern.test(body.tenantId) ||
      typeof body.email !== "string" || body.email.length > 254 || !emailPattern.test(body.email.trim()) ||
      (body.role !== "manager" && body.role !== "staff")) {
    return fail("店家、電子郵件或邀請角色格式錯誤。", 400);
  }

  const actor = await roleFor(supabase, userId, body.tenantId);
  if (actor.error) return fail("無法驗證店家權限。", 503);
  if (actor.role !== "owner" && actor.role !== "manager") return fail("只有負責人或管理者可以邀請會員。", 403);
  if (actor.role === "manager" && body.role !== "staff") return fail("管理者只能邀請員工，不能授予管理者權限。", 403);

  const admin = adminClient();
  if (!admin) return fail("會員管理服務尚未設定完成。", 503);
  const email = body.email.trim().toLowerCase();
  const role = body.role as "manager" | "staff";

  // A completed or partially completed prior request is safe to retry. The
  // invite record is written before membership so a retry can finish the grant.
  const { data: existingInvite, error: inviteLookupError } = await admin.from("tenant_membership_invites")
    .select("user_id,role").eq("tenant_id", body.tenantId).eq("normalized_email", email).maybeSingle();
  if (inviteLookupError) return fail("無法確認既有邀請狀態。", 503);
  if (existingInvite) {
    if (existingInvite.role !== role) return fail("此電子郵件已有不同角色的邀請，請先撤銷會員權限再重新邀請。", 409);
    const { data: existingMembership, error: membershipLookupError } = await admin.from("memberships")
      .select("id,role").eq("tenant_id", body.tenantId).eq("user_id", existingInvite.user_id).maybeSingle();
    if (membershipLookupError) return fail("無法確認會員狀態。", 503);
    if (existingMembership && existingMembership.role !== role) return fail("會員目前角色與邀請紀錄不一致，請聯絡系統管理員。", 409);
    if (!existingMembership) {
      const { error: retryGrantError } = await admin.from("memberships").insert({
        tenant_id: body.tenantId, user_id: existingInvite.user_id, role,
      });
      if (retryGrantError) return fail("重試會員權限建立失敗。", 503);
    }
    return NextResponse.json({ ok: true, message: "此會員邀請已存在，權限已確認。" }, {
      status: 202, headers: { "Cache-Control": "no-store" },
    });
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);
  if (inviteError || !invited.user) return fail("邀請失敗；此電子郵件可能已註冊或已有待處理邀請。", 409);

  const { error: inviteRecordError } = await admin.from("tenant_membership_invites").insert({
    tenant_id: body.tenantId, normalized_email: email, user_id: invited.user.id,
    role, invited_by: userId,
  });
  if (inviteRecordError) {
    await admin.auth.admin.deleteUser(invited.user.id);
    return fail("邀請紀錄建立失敗，已回復本次建立的 Auth 帳號。", 409);
  }

  const { error: membershipError } = await admin.from("memberships").insert({
    tenant_id: body.tenantId, user_id: invited.user.id, role,
  });
  if (membershipError) {
    await admin.from("tenant_membership_invites").delete()
      .eq("tenant_id", body.tenantId).eq("normalized_email", email);
    await admin.auth.admin.deleteUser(invited.user.id);
    return fail("會員權限建立失敗，已回復本次建立的邀請與 Auth 帳號。", 409);
  }

  return NextResponse.json({ ok: true, message: "已寄出會員邀請。" }, {
    status: 202,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function DELETE(request: NextRequest) {
  const { supabase, userId, response } = await context();
  if (response) return response;
  if (!supabase || !userId) return fail("請先登入店家管理帳號。", 401);

  let body: { tenantId?: unknown; membershipId?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return fail("請確認會員資料格式。", 400); }
  if (!body || typeof body.tenantId !== "string" || !uuidPattern.test(body.tenantId) ||
      typeof body.membershipId !== "string" || !uuidPattern.test(body.membershipId)) {
    return fail("店家或會員識別碼格式錯誤。", 400);
  }

  const actor = await roleFor(supabase, userId, body.tenantId);
  if (actor.error) return fail("無法驗證店家權限。", 503);
  if (actor.role !== "owner" && actor.role !== "manager") return fail("只有負責人或管理者可以移除會員。", 403);

  const admin = adminClient();
  if (!admin) return fail("會員管理服務尚未設定完成。", 503);
  const { data: target, error: readError } = await admin.from("memberships")
    .select("id,user_id,role").eq("id", body.membershipId).eq("tenant_id", body.tenantId).maybeSingle();
  if (readError) return fail("無法讀取會員資料。", 503);
  if (!target) return fail("找不到該店會員。", 404);
  if (target.role === "owner") return fail("目前不支援移除負責人，請先建立正式負責人移轉流程。", 409);
  if (actor.role === "manager" && target.role !== "staff") return fail("管理者只能移除員工。", 403);

  const { error: deleteError } = await admin.from("memberships").delete()
    .eq("id", target.id).eq("tenant_id", body.tenantId);
  if (deleteError) return fail("移除會員失敗。", 503);
  const { error: inviteDeleteError } = await admin.from("tenant_membership_invites").delete()
    .eq("tenant_id", body.tenantId).eq("user_id", target.user_id);
  if (inviteDeleteError) return fail("會員已移除，但清理邀請紀錄失敗；請稍後重試。", 503);
  return NextResponse.json({ ok: true });
}
