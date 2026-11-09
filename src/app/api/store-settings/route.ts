import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("slug");
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    return NextResponse.json({ error: "店家網址格式不正確。" }, { status: 400 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ error: "營業資訊暫時無法讀取。" }, { status: 503 });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: tenant, error: tenantError } = await supabase.from("tenants")
    .select("id,name,is_active").eq("slug", slug).maybeSingle();
  if (tenantError || !tenant || !tenant.is_active) return NextResponse.json({ error: "找不到這間店。" }, { status: 404 });
  const { data, error } = await supabase.from("store_settings")
    .select("is_accepting_orders,prep_time_minutes,weekly_hours,closed_dates")
    .eq("tenant_id", tenant.id).maybeSingle();
  if (error) return NextResponse.json({ error: "營業資訊暫時無法讀取。" }, { status: 503 });
  return NextResponse.json({ settings: data || { is_accepting_orders: true, prep_time_minutes: 20, weekly_hours: {}, closed_dates: [] } }, {
    headers: { "Cache-Control": "no-store" },
  });
}
