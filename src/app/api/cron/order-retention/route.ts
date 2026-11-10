import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorizedCronRequest } from "@/lib/cron-auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const response = (message: string, status: number) =>
  NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return response("排程維護尚未設定。", 503);
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), cronSecret)) {
    return response("未授權的排程請求。", 401);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return response("排程維護服務尚未設定。", 503);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("cleanup_all_public_order_retention");
  if (error) return response("資料保留清理未完成，請檢查維護日誌。", 500);
  if (Number((data as { tenants_failed?: number } | null)?.tenants_failed || 0) > 0) {
    return NextResponse.json({ ok: false, cleanup: data }, {
      status: 500,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  return NextResponse.json({ ok: true, cleanup: data }, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
