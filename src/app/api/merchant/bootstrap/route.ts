import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validSecret(provided: string | null, expected: string | undefined) {
  if (!provided || !expected || Buffer.byteLength(expected, "utf8") < 32) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const tenantId = process.env.PILOT_OWNER_BOOTSTRAP_TENANT_ID || "";
  const secret = request.headers.get("x-pilot-bootstrap-secret");
  if (!validSecret(secret, process.env.PILOT_OWNER_BOOTSTRAP_SECRET)) {
    return fail("初始化憑證無效或尚未設定。", 403);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    return fail("Pilot 初始化尚未完成環境設定。", 503);
  }

  let body: { email?: unknown };
  try { body = await request.json() as { email?: unknown }; }
  catch { return fail("請確認初始化資料格式。", 400); }
  if (!body || typeof body.email !== "string" || body.email.length > 254 ||
      !emailPattern.test(body.email.trim())) {
    return fail("請提供有效的負責人電子郵件。", 400);
  }

  let admin: ReturnType<typeof createSupabaseAdminClient>;
  try { admin = createSupabaseAdminClient(); }
  catch { return fail("初始化服務尚未設定完成。", 503); }

  const email = body.email.trim().toLowerCase();
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);
  if (inviteError || !invited.user) {
    return fail("無法建立負責人邀請；此電子郵件可能已存在，請由管理員先確認 Auth 使用者狀態。", 409);
  }

  const { error: claimError } = await admin.rpc("bootstrap_pilot_owner", {
    target_tenant_id: tenantId,
    target_user_id: invited.user.id,
  });
  if (claimError) {
    // The Auth user was created by this request. Remove it if the atomic,
    // one-time database claim fails, so no orphan invited account remains.
    await admin.auth.admin.deleteUser(invited.user.id);
    return fail("負責人初始化未完成；初始化可能已使用，請檢查資料庫狀態。", 409);
  }

  return NextResponse.json({ ok: true, message: "已寄出店家負責人邀請。" }, {
    status: 202,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
