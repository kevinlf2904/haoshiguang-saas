import { createHash } from "node:crypto";
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

const MEMBER_INVITE_MARKER = "haoshiguang_member_invite_recovery";

function inviteMarker(tenantId: string, email: string, role: "manager" | "staff") {
  return createHash("sha256").update(`${tenantId}:member-invite:${role}:${email}`).digest("hex");
}

async function findPendingInviteUser(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  email: string,
  marker: string,
) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Unable to reconcile pending member invitation.");
    const users = data.users ?? [];
    const match = users.find(user => user.email?.toLowerCase() === email);
    if (match) {
      const userMarker = match.app_metadata?.[MEMBER_INVITE_MARKER]
        ?? match.user_metadata?.[MEMBER_INVITE_MARKER];
      return userMarker === marker ? match : null;
    }
    if (users.length < 1000) return null;
  }
  throw new Error("Member invite reconciliation exceeded the safe pagination limit.");
}

async function membershipInviteCommitted(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  tenantId: string,
  userId: string,
  email: string,
  role: "manager" | "staff",
) {
  const [{ data: invite, error: inviteError }, { data: member, error: memberError }] = await Promise.all([
    admin.from("tenant_membership_invites").select("user_id,role")
      .eq("tenant_id", tenantId).eq("normalized_email", email).maybeSingle(),
    admin.from("memberships").select("user_id,role")
      .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle(),
  ]);
  if (inviteError || memberError) return false;
  return invite?.user_id === userId && invite.role === role
    && member?.user_id === userId && member.role === role;
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

  // The database RPC writes the invite record and membership atomically.
  // A retry reuses that record and never sends a second Auth invitation.
  const { data: existingInvite, error: inviteLookupError } = await admin.from("tenant_membership_invites")
    .select("user_id,role").eq("tenant_id", body.tenantId).eq("normalized_email", email).maybeSingle();
  if (inviteLookupError) return fail("無法確認既有邀請狀態。", 503);
  if (existingInvite) {
    if (existingInvite.role !== role) return fail("此電子郵件已有不同角色的邀請，請先撤銷會員權限再重新邀請。", 409);
    const { error: retryGrantError } = await admin.rpc("grant_tenant_member_invite", {
      target_tenant_id: body.tenantId,
      target_user_id: existingInvite.user_id,
      target_email: email,
      target_role: role,
      actor_user_id: userId,
    });
    if (retryGrantError) return fail("重試會員權限建立失敗，請重新整理後再試。", retryGrantError.code === "42501" ? 403 : 409);
    return NextResponse.json({ ok: true, message: "此會員邀請已存在，權限已確認。" }, {
      status: 202, headers: { "Cache-Control": "no-store" },
    });
  }

  const marker = inviteMarker(body.tenantId, email, role);
  let invitedUser: { id: string; app_metadata?: Record<string, unknown> | null } | null = null;
  try {
    invitedUser = await findPendingInviteUser(admin, email, marker);
  } catch {
    return fail("目前無法確認既有邀請狀態；請稍後以相同電子郵件重試。", 503);
  }

  let newlyInvited = false;
  if (!invitedUser) {
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { [MEMBER_INVITE_MARKER]: marker },
    });
    if (inviteError || !invited.user) {
      return fail("邀請結果尚未確認，或此電子郵件已屬於既有帳號；請確認帳號狀態後再試。", 409);
    }
    invitedUser = invited.user;
    newlyInvited = true;
  }

  // Persist a server-controlled recovery marker as soon as Auth returns the user.
  // user_metadata is also supplied at invite creation so a lost response can be
  // reconciled; app_metadata survives user profile edits after the invite is accepted.
  const { error: markerError } = await admin.auth.admin.updateUserById(invitedUser.id, {
    app_metadata: {
      ...(invitedUser.app_metadata || {}),
      [MEMBER_INVITE_MARKER]: marker,
    },
  });
  if (markerError) {
    return fail("Auth 邀請已建立，但恢復標記尚未確認；請以相同電子郵件重試。", 503);
  }

  const { error: membershipError } = await admin.rpc("grant_tenant_member_invite", {
    target_tenant_id: body.tenantId,
    target_user_id: invitedUser.id,
    target_email: email,
    target_role: role,
    actor_user_id: userId,
  });
  if (membershipError) {
    // A transport error can arrive after the SQL transaction committed. Never
    // delete the Auth user here: that could cascade-delete a valid membership.
    if (await membershipInviteCommitted(admin, body.tenantId, invitedUser.id, email, role)) {
      return NextResponse.json({ ok: true, message: "會員邀請與權限已確認。" }, {
        status: 202, headers: { "Cache-Control": "no-store" },
      });
    }
    return fail("Auth 邀請已保留，但會員權限結果尚待確認；請以相同電子郵件重試，系統會接續原邀請。", 503);
  }

  return NextResponse.json({ ok: true, message: newlyInvited ? "已寄出會員邀請。" : "已接續既有邀請並確認會員權限。" }, {
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

  const { error: removeError } = await admin.rpc("remove_tenant_member", {
    target_tenant_id: body.tenantId,
    target_membership_id: target.id,
    actor_user_id: userId,
  });
  if (removeError) return fail("移除會員失敗，請重新整理後再試。", removeError.code === "P0002" ? 404 : 503);
  return NextResponse.json({ ok: true });
}
