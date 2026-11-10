import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getTrustedVercelClientIp } from "../../../lib/trusted-client-ip.mjs";
import { deriveTrackingToken, hashTrackingToken, loadTrackingKeyRing } from "../../../lib/order-tracking-crypto.mjs";

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

async function keyedHash(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

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
  if (typeof body.customerPhone !== "string" || body.customerPhone.replace(/\\D/g, "").length < 8 || body.customerPhone.replace(/\\D/g, "").length > 15) {
    return json("請填寫正確的聯絡電話。", 400);
  }
  if (body.fulfillment !== "takeaway" && body.fulfillment !== "dine_in") {
    return json("請選擇取餐方式。", 400);
  }
  if (body.fulfillment === "dine_in" &&
      (typeof body.tableLabel !== "string" || !body.tableLabel.trim() || body.tableLabel.trim().length > 20)) {
    return json("內用請填寫桌號。", 400);
  }
  if (body.tableLabel !== undefined && typeof body.tableLabel !== "string") {
    return json("桌號格式錯誤。", 400);
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return json("備註格式錯誤。", 400);
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

  const idempotencyKey = request.headers.get("idempotency-key") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return json("訂單識別碼無效，請重新送出。", 400);
  }
  const clientIp = getTrustedVercelClientIp(request.headers);
  if (!clientIp) return json("無法確認連線來源，請稍後再試。", 400);

  const requestFingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    storeSlug: body.storeSlug,
    customerName: body.customerName.trim(),
    customerPhone: body.customerPhone.replace(/\\D/g, ""),
    fulfillment: body.fulfillment,
    tableLabel: body.fulfillment === "dine_in" ? body.tableLabel?.trim() || "" : "",
    note: body.note?.trim() || "",
    items,
  }))).then(buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join(""));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const trackingKeyRing = loadTrackingKeyRing();
  if (!supabaseUrl || !serviceRoleKey || !trackingKeyRing) {
    return json("訂單服務尚未設定，請稍後再試。", 503);
  }

  const normalizedPhone = body.customerPhone.replace(/\\D/g, "");
  const [ipHash, phoneHash] = await Promise.all([
    keyedHash(`ip:${clientIp}`, serviceRoleKey),
    keyedHash(`phone:${normalizedPhone}`, serviceRoleKey),
  ]);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Derive a stable bearer token from the UUID idempotency key so retries
  // return the same tracking URL without storing the raw token in the database.
  const activeTrackingSecret = trackingKeyRing.keys.get(trackingKeyRing.activeVersion)!;
  const trackingToken = deriveTrackingToken(body.storeSlug, idempotencyKey, activeTrackingSecret);
  const trackingTokenHash = hashTrackingToken(trackingToken, activeTrackingSecret);
  const { data, error } = await supabase.rpc("create_public_order", {
    p_tenant_slug: body.storeSlug,
    p_customer_name: body.customerName.trim(),
    p_customer_phone: body.customerPhone,
    p_fulfillment: body.fulfillment,
    p_table_label: body.fulfillment === "dine_in" ? body.tableLabel!.trim() : null,
    p_note: body.note?.trim() || "",
    p_items: items,
    p_idempotency_key: idempotencyKey,
    p_client_ip_hash: ipHash,
    p_phone_hash: phoneHash,
    p_request_hash: requestFingerprint,
  });

  if (error) {
    if (error.message.includes("store_unavailable")) return json("這間店目前暫停接單。", 404);
    if (error.message.includes("store_closed")) return json("目前不在店家營業時間或為公休日，暫時無法送出訂單。", 409);
    if (error.message.includes("item_unavailable_or_invalid")) return json("部分餐點已停售或資料有變動，請重新整理菜單。", 409);
    if (error.message.includes("order_rate_limited")) return json("送單次數過於頻繁，請 10 分鐘後再試。", 429);
    if (error.message.includes("order_ip_rate_limited")) return json("目前連線送單過於頻繁，請 10 分鐘後再試。", 429);
    if (error.message.includes("order_total_exceeds_limit")) return json("訂單金額超過系統允許上限，請聯絡店家。", 400);
    if (error.message.includes("idempotency_key_payload_mismatch")) return json("這筆送單識別碼已用於不同訂單內容，請重新整理購物車後再送出。", 409);
    if (error.code === "22023") return json("訂單資料不完整或格式有誤，請重新確認。", 400);
    return json("訂單暫時無法建立，請稍後再試。", 500);
  }

  // Ignore duplicate order rows so a retry after key rotation preserves the
  // original link's key version instead of silently invalidating that bearer URL.
  const { error: trackingError } = await supabase
    .from("public_order_tracking")
    .upsert(
      { order_id: data.id, token_hash: trackingTokenHash, key_version: trackingKeyRing.activeVersion },
      { onConflict: "order_id", ignoreDuplicates: true },
    );
  if (trackingError) {
    return json("訂單已建立，但查詢連結尚未準備完成；請保留原頁面並重試。", 503);
  }

  const { data: trackingRecord, error: trackingReadError } = await supabase
    .from("public_order_tracking")
    .select("token_hash,key_version")
    .eq("order_id", data.id)
    .maybeSingle();
  if (trackingReadError || !trackingRecord) {
    return json("訂單已建立，但查詢連結尚未準備完成；請保留原頁面並重試。", 503);
  }
  const issuedSecret = trackingKeyRing.keys.get(trackingRecord.key_version);
  if (!issuedSecret) {
    return json("訂單查詢金鑰尚未完成設定，請稍後再試。", 503);
  }
  const issuedToken = deriveTrackingToken(body.storeSlug, idempotencyKey, issuedSecret);
  if (hashTrackingToken(issuedToken, issuedSecret) !== trackingRecord.token_hash) {
    return json("訂單查詢連結驗證失敗，請聯絡店家確認。", 503);
  }

  return NextResponse.json({
    order: { ...data, tracking_token: issuedToken },
  }, { status: 201 });
}
