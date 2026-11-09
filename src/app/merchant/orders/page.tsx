"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./orders.css";

type OrderStatus = "pending" | "accepted" | "preparing" | "ready" | "completed" | "cancelled";
type OrderItem = { id: string; product_name: string; unit_price: number; quantity: number; line_total: number };
type MerchantOrder = {
  id: string; order_number: number; customer_name: string; customer_phone: string;
  fulfillment: "takeaway" | "dine_in"; table_label: string | null; note: string;
  status: OrderStatus; payment_status: string; total: number; created_at: string;
  order_items: OrderItem[];
};

const labels: Record<OrderStatus, string> = {
  pending: "待接單", accepted: "已接單", preparing: "製作中",
  ready: "可取餐", completed: "已完成", cancelled: "已取消",
};
const nextAction: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  pending: { status: "accepted", label: "接受訂單" },
  accepted: { status: "preparing", label: "開始製作" },
  preparing: { status: "ready", label: "通知取餐" },
  ready: { status: "completed", label: "完成訂單" },
};

function money(value: number) {
  return new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(value);
}

export default function MerchantOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<MerchantOrder[]>([]);
  const [filter, setFilter] = useState<"all" | OrderStatus>("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const loadOrders = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/merchant/orders", { cache: "no-store" });
      if (response.status === 401) { router.replace("/merchant/login"); return; }
      const result = await response.json() as { orders?: MerchantOrder[]; error?: string };
      if (!response.ok) throw new Error(result.error || "無法載入訂單。");
      setOrders(result.orders || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "載入訂單時發生錯誤。");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  async function updateStatus(order: MerchantOrder, status: OrderStatus) {
    setBusyId(order.id);
    setError("");
    try {
      const response = await fetch("/api/merchant/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, status }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "訂單狀態更新失敗。");
      await loadOrders();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "訂單狀態更新失敗。");
    } finally {
      setBusyId("");
    }
  }

  async function signOut() {
    await createSupabaseBrowserClient().auth.signOut();
    router.replace("/merchant/login");
    router.refresh();
  }

  const visibleOrders = filter === "all" ? orders : orders.filter(order => order.status === filter);
  const pendingCount = orders.filter(order => order.status === "pending").length;

  return <main className="merchant-orders-shell">
    <header className="merchant-orders-header">
      <Link href="/" className="merchant-orders-brand">好食光 <span>店家管理</span></Link>
      <div><Link className="refresh-button" href="/merchant/products">商品管理</Link><Link className="refresh-button" href="/merchant/settings">營業設定</Link><button className="signout-button" onClick={signOut}>登出</button></div>
    </header>
    <section className="merchant-orders-intro">
      <div><span className="merchant-orders-kicker">ORDER MANAGEMENT</span><h1>訂單管理</h1><p>即時查看顧客訂單，並更新備餐進度。</p></div>
      <div className="pending-counter"><strong>{pendingCount}</strong><span>筆待接單</span></div>
    </section>
    <nav className="order-filters" aria-label="訂單狀態篩選">
      {(["all","pending","accepted","preparing","ready","completed","cancelled"] as const).map(value =>
        <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
          {value === "all" ? "全部訂單" : labels[value]}
        </button>
      )}
    </nav>
    {error && <p className="merchant-orders-error" role="alert">{error}</p>}
    {loading ? <div className="orders-empty">正在載入訂單…</div> : visibleOrders.length === 0 ?
      <div className="orders-empty"><strong>目前沒有符合條件的訂單</strong><span>新訂單送達後會顯示在這裡。</span></div> :
      <section className="merchant-order-list">
        {visibleOrders.map(order => {
          const action = nextAction[order.status];
          return <article className="merchant-order-card" key={order.id}>
            <div className="merchant-order-top">
              <div><span className="merchant-order-number">訂單 #{order.order_number}</span><span className={"order-status status-" + order.status}>{labels[order.status]}</span></div>
              <time dateTime={order.created_at}>{new Date(order.created_at).toLocaleString("zh-TW", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false })}</time>
            </div>
            <div className="merchant-order-customer"><strong>{order.customer_name}</strong><a href={"tel:" + order.customer_phone}>{order.customer_phone}</a><span>{order.fulfillment === "dine_in" ? "內用 · " + (order.table_label || "未填桌號") : "外帶"}</span></div>
            <ul className="merchant-order-items">{order.order_items.map(item => <li key={item.id}><span>{item.product_name} × {item.quantity}</span><strong>{money(item.line_total)}</strong></li>)}</ul>
            {order.note && <p className="merchant-order-note">備註：{order.note}</p>}
            <div className="merchant-order-bottom"><div><span>付款：{order.payment_status === "paid" ? "已付款" : "未付款"}</span><strong>{money(order.total)}</strong></div>
              <div className="merchant-order-actions">
                {order.status === "pending" && <button className="reject-order" disabled={busyId === order.id} onClick={() => void updateStatus(order, "cancelled")}>拒絕</button>}
                {action && <button className="advance-order" disabled={busyId === order.id} onClick={() => void updateStatus(order, action.status)}>{busyId === order.id ? "更新中…" : action.label}</button>}
              </div>
            </div>
          </article>;
        })}
      </section>}
    <p className="merchant-orders-footnote">訂單資料依登入帳號的店家成員權限讀取；本頁不提供跨店查詢或付款操作。</p>
  </main>;
}
