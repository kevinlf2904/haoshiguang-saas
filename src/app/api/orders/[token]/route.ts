import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = () => NextResponse.json(
  { error: "找不到訂單，或查詢連結已失效。" },
  { status: 404, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
);

async function keyedHash(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return fail();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    return NextResponse.json(
      { error: "訂單查詢服務暫時無法使用。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const tokenHash = await keyedHash(`tracking-hash:${token}`, secret);
  const supabase = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: access, error: accessError } = await supabase
    .from("public_order_tracking")
    .select("order_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (accessError || !access) return fail();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id,order_number,status,payment_status,total,fulfillment,table_label,created_at,order_items(id,product_name,unit_price,quantity,line_total)")
    .eq("id", access.order_id)
    .maybeSingle();

  if (orderError || !order) return fail();

  return NextResponse.json({ order }, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
