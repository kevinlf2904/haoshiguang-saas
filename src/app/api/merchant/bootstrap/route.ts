import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVATION_METADATA_KEY = "pilot_owner_bootstrap_reservation";

function validSecret(provided: string | null, expected: string | undefined) {
  if (!provided || !expected || Buffer.byteLength(expected, "utf8") < 32) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function reservationId(secret: string, tenantId: string, email: string) {
  const bytes = createHmac("sha256", secret)
    .update(`${tenantId}:pilot-owner:${email}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function findReservedAuthUser(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  email: string,
  expectedReservationId: string,
) {
  // Supabase Admin listUsers is paginated. Only accept an existing account if
  // its server-written metadata proves it belongs to this exact bootstrap saga.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Unable to reconcile the pending Auth invitation.");
    const users = data.users ?? [];
    const match = users.find((user) => user.email?.toLowerCase() === email);
    if (match) {
      return match.user_metadata?.[RESERVATION_METADATA_KEY] === expectedReservationId
        ? match
        : null;
    }
    if (users.length < 1000) return null;
  }
  throw new Error("Auth user reconciliation exceeded the safe pagination limit.");
}

export async function POST(request: NextRequest) {
  const tenantId = process.env.PILOT_OWNER_BOOTSTRAP_TENANT_ID || "";
  const expectedSecret = process.env.PILOT_OWNER_BOOTSTRAP_SECRET;
  const providedSecret = request.headers.get("x-pilot-bootstrap-secret");

  if (!validSecret(providedSecret, expectedSecret)) {
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

  const email = body.email.trim().toLowerCase();
  const secret = expectedSecret as string;
  const claimId = reservationId(secret, tenantId, email);

  let admin: ReturnType<typeof createSupabaseAdminClient>;
  try { admin = createSupabaseAdminClient(); }
  catch { return fail("初始化服務尚未設定完成。", 503); }

  // Reserve the one-time claim before any Auth email/user side effect. The
  // deterministic reservation ID makes retries for this exact email resumable.
  const { error: reserveError } = await admin.rpc("reserve_pilot_owner_bootstrap", {
    target_tenant_id: tenantId,
    target_email: email,
    target_reservation_id: claimId,
  });
  if (reserveError) {
    console.error("PILOT_BOOTSTRAP_RESERVATION_FAILED", {
      code: reserveError.code,
      message: reserveError.message,
    });
    return fail("初始化已完成、已由其他電子郵件保留，或店家狀態不符合初始化條件。", 409);
  }

  let authUser;
  try {
    authUser = await findReservedAuthUser(admin, email, claimId);
  } catch {
    return fail("目前無法確認邀請狀態；初始化保留紀錄未清除，請稍後以相同電子郵件重試。", 503);
  }

  if (!authUser) {
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { [RESERVATION_METADATA_KEY]: claimId },
    });
    if (inviteError || !invited.user) {
      // The Auth request may have succeeded remotely despite a transport error.
      // Never delete an Auth user or release the reservation on an ambiguous result.
      return fail("邀請結果尚未確認；請稍後以相同電子郵件重試，系統會先核對邀請狀態。", 503);
    }
    authUser = invited.user;
  }

  const { error: attachError } = await admin.rpc("attach_pilot_owner_auth_user", {
    target_reservation_id: claimId,
    target_user_id: authUser.id,
  });
  if (attachError) {
    // Do not compensate by deleting Auth users: the DB write may have committed
    // even if its response was lost. The same reservation can safely retry.
    return fail("邀請已建立，但初始化狀態尚待確認；請以相同電子郵件重試。", 503);
  }

  const { error: completeError } = await admin.rpc("complete_pilot_owner_bootstrap", {
    target_reservation_id: claimId,
  });
  if (completeError) {
    // Completion may have committed before a network failure. Keep Auth user and
    // reservation intact; a retry is idempotent and cannot send another invite.
    return fail("負責人初始化結果尚待確認；請以相同電子郵件重試或由管理員檢查狀態。", 503);
  }

  return NextResponse.json({ ok: true, message: "已建立店家負責人並寄出邀請。" }, {
    status: 202,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
