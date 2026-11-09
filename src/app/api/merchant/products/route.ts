import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type CatalogBody = {
  kind?: unknown;
  tenantId?: unknown;
  id?: unknown;
  name?: unknown;
  description?: unknown;
  price?: unknown;
  categoryId?: unknown;
  sortOrder?: unknown;
  isAvailable?: unknown;
  isActive?: unknown;
};

const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status });

async function getContext() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { supabase: null, userId: null, response: fail("請先登入店家管理帳號。", 401) };
  return { supabase, userId: user.id, response: null };
}

async function canManage(supabase: NonNullable<Awaited<ReturnType<typeof getContext>>["supabase"]>, userId: string, tenantId: string) {
  const { data, error } = await supabase.from("memberships")
    .select("role").eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  if (error || !data) return false;
  return data.role === "owner" || data.role === "manager";
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request: NextRequest) {
  const { supabase, userId, response } = await getContext();
  if (response || !supabase || !userId) return response ?? fail("請先登入店家管理帳號。", 401);

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("tenant_id,role,tenants(id,name,slug)")
    .eq("user_id", userId);
  if (membershipError) return fail("無法讀取店家權限。", 403);

  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ memberships: memberships || [] }, { headers: { "Cache-Control": "no-store" } });
  if (!validUuid(tenantId) || !(memberships || []).some((membership) => membership.tenant_id === tenantId)) {
    return fail("沒有這間店的管理權限。", 403);
  }

  const [{ data: categories, error: categoryError }, { data: products, error: productError }] = await Promise.all([
    supabase.from("categories").select("id,name,sort_order,is_active").eq("tenant_id", tenantId).order("sort_order").order("name"),
    supabase.from("products").select("id,category_id,name,description,price,is_available,sort_order,created_at").eq("tenant_id", tenantId).order("sort_order").order("name"),
  ]);
  if (categoryError || productError) return fail("無法讀取商品資料，請確認店家資料庫權限。", 403);

  const role = (memberships || []).find((membership) => membership.tenant_id === tenantId)?.role;
  return NextResponse.json({ categories: categories || [], products: products || [], canManage: role === "owner" || role === "manager" }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  const { supabase, userId, response } = await getContext();
  if (response || !supabase || !userId) return response ?? fail("請先登入店家管理帳號。", 401);

  let body: CatalogBody;
  try { body = await request.json() as CatalogBody; }
  catch { return fail("請確認送出的資料格式。", 400); }

  if (!validUuid(body.tenantId)) return fail("店家識別碼格式錯誤。", 400);
  if (!(await canManage(supabase, userId, body.tenantId))) return fail("只有店家負責人或管理者可以修改菜單。", 403);

  if (body.kind === "category") {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40) return fail("分類名稱需為 1 至 40 個字。", 400);
    const { data, error } = await supabase.from("categories").insert({
      tenant_id: body.tenantId, name: body.name.trim(), sort_order: Number.isInteger(body.sortOrder) ? body.sortOrder : 0,
    }).select("id,name,sort_order,is_active").single();
    if (error) return fail(error.code === "23505" ? "這個分類名稱已存在。" : "新增分類失敗，請稍後再試。", error.code === "23505" ? 409 : 400);
    return NextResponse.json({ category: data }, { status: 201 });
  }

  if (body.kind === "product") {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return fail("商品名稱需為 1 至 100 個字。", 400);
    if (typeof body.description !== "string" || body.description.length > 500) return fail("商品描述不可超過 500 字。", 400);
    if (!Number.isSafeInteger(body.price) || (body.price as number) < 0 || (body.price as number) > 10000000) return fail("價格需為 0 至 10,000,000 的整數。", 400);
    if (!validUuid(body.categoryId)) return fail("請選擇有效的商品分類。", 400);
    const { data: category } = await supabase.from("categories").select("id").eq("id", body.categoryId).eq("tenant_id", body.tenantId).eq("is_active", true).maybeSingle();
    if (!category) return fail("商品分類不存在或已停用。", 400);
    const { data, error } = await supabase.from("products").insert({
      tenant_id: body.tenantId, category_id: body.categoryId, name: body.name.trim(),
      description: body.description.trim(), price: body.price,
      sort_order: Number.isInteger(body.sortOrder) ? body.sortOrder : 0,
      is_available: true,
    }).select("id,category_id,name,description,price,is_available,sort_order,created_at").single();
    if (error) return fail(error.code === "23505" ? "同一分類已有相同商品名稱。" : "新增商品失敗，請稍後再試。", error.code === "23505" ? 409 : 400);
    return NextResponse.json({ product: data }, { status: 201 });
  }

  return fail("不支援的新增資料類型。", 400);
}

export async function PATCH(request: NextRequest) {
  const { supabase, userId, response } = await getContext();
  if (response || !supabase || !userId) return response ?? fail("請先登入店家管理帳號。", 401);

  let body: CatalogBody;
  try { body = await request.json() as CatalogBody; }
  catch { return fail("請確認送出的資料格式。", 400); }

  if (!validUuid(body.tenantId) || !validUuid(body.id)) return fail("店家或商品識別碼格式錯誤。", 400);
  if (!(await canManage(supabase, userId, body.tenantId))) return fail("只有店家負責人或管理者可以修改菜單。", 403);

  if (body.kind === "category") {
    const updates: { name?: string; is_active?: boolean; sort_order?: number } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40) return fail("分類名稱需為 1 至 40 個字。", 400);
      updates.name = body.name.trim();
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") return fail("分類狀態格式錯誤。", 400);
      updates.is_active = body.isActive;
    }
    if (body.sortOrder !== undefined) {
      if (!Number.isInteger(body.sortOrder)) return fail("排序必須是整數。", 400);
      updates.sort_order = body.sortOrder as number;
    }
    if (!Object.keys(updates).length) return fail("沒有可更新的欄位。", 400);
    const { data, error } = await supabase.from("categories").update(updates)
      .eq("id", body.id).eq("tenant_id", body.tenantId).select("id,name,sort_order,is_active").maybeSingle();
    if (error) return fail(error.code === "23505" ? "這個分類名稱已存在。" : "更新分類失敗。", error.code === "23505" ? 409 : 400);
    if (!data) return fail("找不到分類或沒有修改權限。", 404);
    return NextResponse.json({ category: data });
  }

  if (body.kind === "product") {
    const updates: { name?: string; description?: string; price?: number; category_id?: string; is_available?: boolean; sort_order?: number } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return fail("商品名稱需為 1 至 100 個字。", 400);
      updates.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string" || body.description.length > 500) return fail("商品描述不可超過 500 字。", 400);
      updates.description = body.description.trim();
    }
    if (body.price !== undefined) {
      if (!Number.isSafeInteger(body.price) || (body.price as number) < 0 || (body.price as number) > 10000000) return fail("價格需為 0 至 10,000,000 的整數。", 400);
      updates.price = body.price as number;
    }
    if (body.categoryId !== undefined) {
      if (!validUuid(body.categoryId)) return fail("商品分類格式錯誤。", 400);
      const { data: category } = await supabase.from("categories").select("id").eq("id", body.categoryId).eq("tenant_id", body.tenantId).eq("is_active", true).maybeSingle();
      if (!category) return fail("商品分類不存在或已停用。", 400);
      updates.category_id = body.categoryId;
    }
    if (body.isAvailable !== undefined) {
      if (typeof body.isAvailable !== "boolean") return fail("商品販售狀態格式錯誤。", 400);
      updates.is_available = body.isAvailable;
    }
    if (body.sortOrder !== undefined) {
      if (!Number.isInteger(body.sortOrder)) return fail("排序必須是整數。", 400);
      updates.sort_order = body.sortOrder as number;
    }
    if (!Object.keys(updates).length) return fail("沒有可更新的欄位。", 400);
    const { data, error } = await supabase.from("products").update(updates)
      .eq("id", body.id).eq("tenant_id", body.tenantId)
      .select("id,category_id,name,description,price,is_available,sort_order,created_at").maybeSingle();
    if (error) return fail(error.code === "23505" ? "同一分類已有相同商品名稱。" : "更新商品失敗。", error.code === "23505" ? 409 : 400);
    if (!data) return fail("找不到商品或沒有修改權限。", 404);
    return NextResponse.json({ product: data });
  }

  return fail("不支援的更新資料類型。", 400);
}
