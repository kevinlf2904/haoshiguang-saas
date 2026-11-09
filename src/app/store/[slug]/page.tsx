"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import menuData from "../../../../data/laozhang-menu.json";
import "./storefront.css";

type MenuItem = (typeof menuData.menu)[number];
type CartLine = { key: string; item: MenuItem; quantity: number };\ntype StoreStatus = { acceptingOrders: boolean; prepTimeMinutes: number } | null;

const money = (value: number) => new Intl.NumberFormat("zh-TW", {
  style: "currency", currency: "TWD", maximumFractionDigits: 0,
}).format(value);

export default function StorefrontPage() {
  const params = useParams<{ slug: string }>();
  const categories = [...new Set(menuData.menu.map((item) => item.category))];
  const [activeCategory, setActiveCategory] = useState(categories[0]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [fulfillment, setFulfillment] = useState<"takeaway" | "dine_in">("takeaway");
  const [tableLabel, setTableLabel] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [note, setNote] = useState("");
  const [showCart, setShowCart] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [confirmedOrder, setConfirmedOrder] = useState<{ order_number: number; total: number } | null>(null);\n  const [storeStatus, setStoreStatus] = useState<StoreStatus>(null);\n\n  useEffect(() => {\n    let active = true;\n    fetch("/api/merchant/business-hours?slug=" + encodeURIComponent(params.slug), { cache: "no-store" })\n      .then(response => response.ok ? response.json() : null)\n      .then(result => { if (active && result) setStoreStatus({ acceptingOrders: Boolean(result.acceptingOrders), prepTimeMinutes: Number(result.prepTimeMinutes) || 20 }); })\n      .catch(() => { if (active) setStoreStatus(null); });\n    return () => { active = false; };\n  }, [params.slug]);

  const visibleItems = menuData.menu.filter((item) => item.category === activeCategory);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.item.price * line.quantity, 0),
    [cart],
  );

  function add(item: MenuItem) {
    const key = item.name;
    setCart((current) => {
      const found = current.find((line) => line.key === key);
      if (found) return current.map((line) =>
        line.key === key ? { ...line, quantity: line.quantity + 1 } : line,
      );
      return [...current, { key, item, quantity: 1 }];
    });
  }

  async function submitOrder() {
    setCheckoutError("");
    if (storeStatus && !storeStatus.acceptingOrders) return setCheckoutError("店家目前未營業或暫停接單，暫時無法送出訂單。");\n    if (cart.length === 0) return setCheckoutError("請先選擇餐點。");
    if (!customerName.trim() || !customerPhone.trim()) return setCheckoutError("請填寫稱呼及聯絡電話。");
    if (fulfillment === "dine_in" && !tableLabel.trim()) return setCheckoutError("內用請填寫桌號。");
    setSubmitting(true);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeSlug: params.slug,
          customerName,
          customerPhone,
          fulfillment,
          tableLabel,
          note,
          items: cart.map((line) => ({ name: line.item.name, category: line.item.category, quantity: line.quantity })),
        }),
      });
      const result = await response.json() as { order?: { order_number: number; total: number }; error?: string };
      if (!response.ok || !result.order) throw new Error(result.error || "訂單建立失敗，請稍後再試。");
      setConfirmedOrder(result.order);
      setCart([]);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "網路連線異常，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  }

  function changeQuantity(key: string, delta: number) {
    setCart((current) => current
      .map((line) => line.key === key ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  if (params.slug !== menuData.tenant.slug) {
    return <main className="order-shell"><section className="store-option-note"><strong>找不到這間店</strong><span>請確認店家網址是否正確。</span></section></main>;
  }

  return (
    <main className="order-shell">
      <header className="store-header">
        <a className="store-brand" href="/">好食光</a>
        <span className="store-header-note">線上點餐 · PICK UP SOMETHING GOOD</span>
        <button className="cart-mobile" onClick={() => setShowCart(!showCart)} aria-label="開啟購物車">
          購物車 <b>{count}</b>
        </button>
      </header>

      <section className="store-hero">
        <div className="store-hero-copy">
          <span className="eyebrow">LOCAL FAVORITE · SINYI DISTRICT</span>
          <h1>{menuData.tenant.name}</h1>
          <p>一碗熱騰騰的好味道，今天也替你好好準備。</p>
          {storeStatus && <p className="store-operating-status">{storeStatus.acceptingOrders ? "● 目前可接單" : "● 目前暫停接單"} · 預計備餐 {storeStatus.prepTimeMinutes} 分鐘</p>}\n          <div className="store-meta">
            <span>⌖ {menuData.tenant.address}</span>
            <a href={`tel:${menuData.tenant.phone}`}>☎ {menuData.tenant.phone}</a>
          </div>
        </div>
        <div className="hero-stamp"><span>好食光</span><b>GOOD<br/>FOOD<br/>GOOD DAY</b></div>
      </section>

      <div className="store-layout">
        <section className="menu-section">
          <div className="section-heading">
            <div><span className="eyebrow">OUR MENU</span><h2>今天想吃點什麼？</h2></div>
            <span className="menu-count">{menuData.menu.length} 道好味道</span>
          </div>
          <nav className="category-tabs" aria-label="菜單分類">
            {categories.map((category) => (
              <button key={category} className={activeCategory === category ? "active" : ""}
                onClick={() => setActiveCategory(category)}>{category}</button>
            ))}
          </nav>
          <div className="menu-grid">
            {visibleItems.map((item) => (
              <article className="menu-card" key={item.name}>
                <div className="dish-art" aria-hidden="true"><span>{item.category === "小菜" ? "🥢" : item.category === "飯類" ? "🍚" : "🍜"}</span></div>
                <div className="dish-info">
                  <div className="dish-title-row"><h3>{item.name}</h3><strong>{money(item.price)}</strong></div>
                  {item.description ? <p>{item.description}</p> : <p className="dish-subtle">店家每日新鮮製作</p>}
                  <button className="add-button" onClick={() => add(item)} aria-label={`加入${item.name}`}>＋ 加入</button>
                </div>
              </article>
            ))}
          </div>
          <div className="store-option-note">
            <strong>加購選項</strong>
            <span>加麵 + NT$20</span><span>升級燒肉飯 + NT$30</span>
            <small>加購選項的適用商品與客製化規則，待店家後台設定完成後開放選取。</small>
          </div>
        </section>

        <aside className={`cart-panel ${showCart ? "cart-open" : ""}`}>
          <div className="cart-heading"><div><span className="eyebrow">YOUR ORDER</span><h2>訂單明細</h2></div><span className="cart-count">{count} 件</span></div>
          {cart.length === 0 ? (
            <div className="empty-cart"><span>🥣</span><strong>購物車還是空的</strong><p>選幾道喜歡的餐點，開始今天的美味。</p></div>
          ) : (
            <div className="cart-lines">
              {cart.map((line) => (
                <div className="cart-line" key={line.key}>
                  <div className="cart-line-main"><strong>{line.item.name}</strong><span>{money(line.item.price)} / 份</span></div>
                  <div className="quantity-control">
                    <button onClick={() => changeQuantity(line.key, -1)} aria-label={`減少${line.item.name}`}>−</button>
                    <b>{line.quantity}</b>
                    <button onClick={() => changeQuantity(line.key, 1)} aria-label={`增加${line.item.name}`}>＋</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="cart-form">
            <label className="field-label">取餐方式</label>
            <div className="fulfillment-switch">
              <button className={fulfillment === "takeaway" ? "selected" : ""} onClick={() => setFulfillment("takeaway")}>外帶</button>
              <button className={fulfillment === "dine_in" ? "selected" : ""} onClick={() => setFulfillment("dine_in")}>內用</button>
            </div>
            {fulfillment === "dine_in" && <label className="field-label">桌號<input value={tableLabel} onChange={(event) => setTableLabel(event.target.value)} placeholder="請輸入桌號"/></label>}
            <label className="field-label">稱呼<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="怎麼稱呼您？"/></label>
            <label className="field-label">聯絡電話<input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} inputMode="tel" placeholder="方便店家聯絡"/></label>
            <label className="field-label">備註（選填）<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：不要香菜、餐具不用..." rows={2}/></label>
          </div>
          <div className="cart-total"><span>商品小計</span><strong>{money(subtotal)}</strong></div>
          {confirmedOrder ? (
            <div className="checkout-result" role="status"><strong>訂單已建立</strong><b>訂單編號 #{confirmedOrder.order_number}</b><span>應付金額 {money(confirmedOrder.total)}</span><small>請向店家確認接單狀態；目前僅支援現場付款。</small><button onClick={() => setConfirmedOrder(null)}>繼續點餐</button></div>
          ) : (
            <><button className="checkout-button" onClick={submitOrder} disabled={submitting || cart.length === 0 || Boolean(storeStatus && !storeStatus.acceptingOrders)}>{submitting ? "正在送出…" : storeStatus && !storeStatus.acceptingOrders ? "目前暫停接單" : "送出訂單"} <span>→</span></button>
            {checkoutError && <p className="checkout-error" role="alert">{checkoutError}</p>}
            <p className="checkout-hint">送出後會建立待確認訂單；目前僅支援現場付款，尚未串接線上金流。</p></>
          )}
        </aside>
      </div>
      <footer className="store-footer"><strong>好食光</strong><span>讓每一餐，都剛剛好。</span><small>此為試點建置頁面，尚未開放正式接單。</small></footer>
    </main>
  );
}
