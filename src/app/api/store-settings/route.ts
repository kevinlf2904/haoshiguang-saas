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
  if (!url || !key) return NextResponse.json({ error: "店家資訊暫時無法讀取。" }, { status: 503 });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // All storefront data is fetched with the public anon client and is constrained by RLS.
  const { data: tenant, error: tenantError } = await supabase.from("tenants")
    .select("id,name,slug,phone,address,is_active").eq("slug", slug).maybeSingle();
  if (tenantError || !tenant || !tenant.is_active) {
    return NextResponse.json({ error: "找不到這間店。" }, { status: 404 });
  }

  const [{ data: settings, error: settingsError }, { data: categories, error: categoriesError }] = await Promise.all([
    supabase.from("store_settings")
      .select("is_accepting_orders,prep_time_minutes,weekly_hours,closed_dates")
      .eq("tenant_id", tenant.id).maybeSingle(),
    supabase.from("categories").select("id,name,sort_order,is_active")
      .eq("tenant_id", tenant.id).eq("is_active", true).order("sort_order").order("name"),
  ]);
  if (settingsError || categoriesError) {
    return NextResponse.json({ error: "店家資訊暫時無法讀取。" }, { status: 503 });
  }

  const activeCategoryIds = (categories || []).map(category => category.id);
  let products: { id: string; category_id: string; name: string; description: string; price: number; is_available: boolean; sort_order: number }[] = [];
  if (activeCategoryIds.length) {
    const { data, error } = await supabase.from("products")
      .select("id,category_id,name,description,price,is_available,sort_order")
      .eq("tenant_id", tenant.id).eq("is_available", true)
      .in("category_id", activeCategoryIds).order("sort_order").order("name");
    if (error) return NextResponse.json({ error: "菜單暫時無法讀取。" }, { status: 503 });
    products = data || [];
  }

  return NextResponse.json({
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, phone: tenant.phone, address: tenant.address },
    settings: settings || { is_accepting_orders: true, prep_time_minutes: 20, weekly_hours: {}, closed_dates: [] },
    categories: categories || [],
    products,
  }, { headers: { "Cache-Control": "no-store" } });
}
