"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "./tracking.css";

type Order = {
  order_number: number;
  status: "pending" | "accepted" | "preparing" | "ready" | "completed" | "cancelled";
  payment_status: string;
  total: number;
  fulfillment: "takeaway" | "dine_in";
  table_label: string | null;
  created_at: string;
  order_items: { id: string; product_name: string; unit_price: number; quantity: number; line_total: number }[];
};

const statusLabels: Record<Order["status"], string> = {
  pending: "等待店家確認",
  accepted: "店家已接單",
  preparing: "餐點製作中",
  ready: "餐點已備妥",
  completed: "訂單已完成",
  cancelled: "訂單已取消",
};

const progress = ["pending", "accepted", "preparing", "ready", "completed"] as const;
const money = (value: number) => "NT$" + Number(value).toLocaleString("zh-TW");

export default function OrderTrackingClient() {
  const { token } = useParams<{ token: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/orders/" + encodeURIComponent(token), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const result = await response.json() as { order?: Order; error?: string };
      if (!response.ok || !result.order) throw new Error(result.error || "無法讀取訂單進度。");
      setOrder(result.order);
      setUpdatedAt(new Date());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "訂單查詢暫時失敗。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setError("訂單查詢連結格式不正確。");
      setLoading(false);
      return;
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [refresh, token]);

  const currentIndex = order ? progress.indexOf(order.status as typeof progress[number]) : -1;

  return (
    <main className="tracking-shell">
      <header className="tracking-header">
        <Link href="/" className="tracking-brand">好食光</Link>
        <span>訂單進度查詢</span>
      </header>
      <section className="tracking-card">
        <span className="tracking-eyebrow">ORDER TRACKING</span>
        <h1>查看訂單進度</h1>
        {loading ? <p className="tracking-muted" role="status">正在讀取訂單…</p> : error && !order ?
          <div className="tracking-error" role="alert">{error}</div> :
          order ? <>
            <div className="tracking-number">訂單編號 <strong>#{order.order_number}</strong></div>
            <div className={`tracking-status ${order.status}`} role="status">
              <strong>{statusLabels[order.status]}</strong>
              <span>{order.status === "cancelled" ? "如需協助，請直接聯絡店家。" : "訂單狀態會每 10 秒自動更新。"}</span>
            </div>
            {order.status !== "cancelled" && <ol className="tracking-steps">
              {progress.map((step, index) => <li key={step} className={index <= currentIndex ? "done" : ""}>
                <span className="tracking-dot">{index < currentIndex ? "✓" : index + 1}</span>
                <span>{statusLabels[step]}</span>
              </li>)}
            </ol>}
            <div className="tracking-details">
              <div><span>取餐方式</span><strong>{order.fulfillment === "takeaway" ? "外帶" : `內用 · ${order.table_label || "未提供桌號"}`}</strong></div>
              <div><span>付款方式</span><strong>現場付款 · {order.payment_status === "paid" ? "已付款" : "尚未付款"}</strong></div>
              <div><span>訂單金額</span><strong>{money(order.total)}</strong></div>
              <div><span>建立時間</span><strong>{new Date(order.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</strong></div>
            </div>
            <div className="tracking-items">
              <h2>餐點明細</h2>
              {order.order_items.map(item => <div className="tracking-item" key={item.id}>
                <span>{item.product_name} × {item.quantity}</span><strong>{money(item.line_total)}</strong>
              </div>)}
            </div>
            {updatedAt && <p className="tracking-updated">最後更新：{updatedAt.toLocaleTimeString("zh-TW")}</p>}
            {error && <p className="tracking-inline-error">{error}，系統會繼續嘗試更新。</p>}
          </> : null}
        <p className="tracking-privacy">此連結是訂單專屬查詢憑證，請勿轉傳給他人。</p>
      </section>
      <footer className="tracking-footer">好食光 · 讓每一餐，都剛剛好。</footer>
    </main>
  );
}
