import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type OrderStatus = "pending" | "accepted" | "preparing" | "ready" | "completed" | "cancelled";
const allowedStatuses: OrderStatus[] = ["pending", "accepted", "preparing", "ready", "completed", "cancelled"];
const transitions: Record<OrderStatus, OrderStatus[]> = {
  pending: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed"],
  completed: [],
  cancelled: [],
};
const error = (message: string, status: number) => NextResponse.json({ error: message }, { status });

async function authenticatedClient() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { supabase: null, response: error("請先登入店家管理帳號。", 401) };
  return { supabase, response: null };
}

export async function GET() {
  const { supabase, response } = await authenticatedClient();
  if (response || !supabase) return response;
  const { data, error: queryError } = await supabase
    .from("orders")
    .select("id,order_number,customer_name,customer_phone,fulfillment,table_label,note,status,payment_status,total,created_at,order_items(id,product_name,unit_price,quantity,line_total)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (queryError) return error("無法讀取訂單，請確認帳號已加入店家並具備訂單讀取權限。", 403);
  return NextResponse.json({ orders: data || [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const { supabase, response } = await authenticatedClient();
  if (response || !supabase) return response;

  let body: { orderId?: unknown; status?: unknown };
  try {
    body = await request.json() as { orderId?: unknown; status?: unknown };
  } catch {
    return error("請確認更新資料格式。", 400);
  }
  if (typeof body.orderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.orderId)) {
    return error("訂單識別碼格式錯誤。", 400);
  }
  if (typeof body.status !== "string" || !allowedStatuses.includes(body.status as OrderStatus)) {
    return error("不支援的訂單狀態。", 400);
  }

  const { data: current, error: readError } = await supabase
    .from("orders").select("status").eq("id", body.orderId).maybeSingle();
  if (readError || !current) return error("找不到訂單或沒有查看權限。", 404);

  const currentStatus = current.status as OrderStatus;
  const nextStatus = body.status as OrderStatus;
  if (!transitions[currentStatus].includes(nextStatus)) {
    return error("此訂單目前不能進行這項狀態變更。", 409);
  }

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({ status: nextStatus })
    .eq("id", body.orderId)
    .eq("status", currentStatus)
    .select("id,status")
    .maybeSingle();

  if (updateError) return error("更新失敗，請確認店家權限。", 403);
  if (!updated) return error("訂單狀態已被其他人更新，請重新整理。", 409);
  return NextResponse.json({ order: updated });
}
