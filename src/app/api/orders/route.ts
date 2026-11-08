import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type CheckoutItem = {
  name: string;
  category: string;
  quantity: number;
};

type CheckoutBody = {
  storeSlug?: string;
  customerName?: string;
  customerPhone?: string;
  fulfillment?: "takeaway" | "dine_in";
  tableLabel?: string;
  note?: string;
  items?: CheckoutItem[];
};

const json = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

export async function POST(request: NextRequest) {
  let body: CheckoutBody;
  try {
    body = await request.json() as CheckoutBody;
  } catch {
    return json("請確認訂單資料格式。", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json("請確認訂單資料格式。", 400);
  }
  if (!body.storeSlug || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(body.storeSlug)) {
    return json("店家網址格式不正確。", 400);
  }
  if (typeof body.customerName !== "string" || body.customerName.trim().length < 1 || body.customerName.trim().length > 60) {
    return json("請填寫正確的稱呼。", 400);
  }
  if (typeof body.customerPhone !== "string" || body.customerPhone.replace(/\D/g, "").length < 8 || body.customerPhone.replace(/\D/g, "").length > 15) {
    return json("請填寫正確的聯絡電話。", 400);
  }
  if (body.fulfillment !== "takeaway" && body.fulfillment !== "dine_in") {
    return json("請選擇取餐方式。", 400);
  }
  if (body.fulfillment === "dine_in" && (!body.tableLabel?.trim() || body.tableLabel.trim().length > 20)) {
    return json("內用請填寫桌號。", 400);
  }
  if (typeof body.note === "string" && body.note.length > 500) {
    return json("備註不可超過 500 字。", 400);
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    return json("訂單至少需要一項餐點，最多 30 項。", 400);
  }
  const items = body.items.map((item) => ({
    product_name: typeof item?.name === "string" ? item.name.trim() : "",
    category_name: typeof item?.category === "string" ? item.category.trim() : "",
    quantity: Number(item?.quantity),
  }));
  if (items.some((item) => !item.product_name || item.product_name.length > 100 || !item.category_name || item.category_name.length > 50 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) {
    return json("餐點資料有誤，請重新確認購物車。", 400);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !publishableKey) {
    return json("訂單服務尚未設定，請稍後再試。", 503);
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("create_public_order", {
    p_tenant_slug: body.storeSlug,
    p_customer_name: body.customerName.trim(),
    p_customer_phone: body.customerPhone,
    p_fulfillment: body.fulfillment,
    p_table_label: body.tableLabel?.trim() || null,
    p_note: body.note?.trim() || "",
    p_items: items,
  });

  if (error) {
    if (error.message.includes("store_unavailable")) return json("這間店目前暫停接單。", 404);
    if (error.message.includes("item_unavailable_or_invalid")) return json("部分餐點已停售或資料有變動，請重新整理菜單。", 409);
    if (error.code === "22023") return json("訂單資料不完整或格式有誤，請重新確認。", 400);
    return json("訂單暫時無法建立，請稍後再試。", 500);
  }

  return NextResponse.json({ order: data }, { status: 201 });
}
