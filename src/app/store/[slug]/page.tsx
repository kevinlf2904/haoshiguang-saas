"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import "./storefront.css";

type MenuItem = { id: string; category_id: string; name: string; description: string; price: number; is_available: boolean; sort_order: number };
type StoreCategory = { id: string; name: string; sort_order: number; is_active: boolean };
type StoreTenant = { id: string; name: string; slug: string; phone: string | null; address: string | null };
type CartLine = { key: string; item: MenuItem; quantity: number };
type StoreSettings = { is_accepting_orders: boolean; prep_time_minutes: number; weekly_hours: Record<string, { open: string; close: string }[]>; closed_dates: string[] };

const money = (value: number) => new Intl.NumberFormat("zh-TW", {
  style: "currency", currency: "TWD", maximumFractionDigits: 0,
}).format(value);

export default function StorefrontPage() {
  const params = useParams<{ slug: string }>();
  const [categories, setCategories] = useState<StoreCategory[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [tenant, setTenant] = useState<StoreTenant | null>(null);
  const [activeCategory, setActiveCategory] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [fulfillment, setFulfillment] = useState<"takeaway" | "dine_in">("takeaway");
  const [tableLabel, setTableLabel] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [note, setNote] = useState("");
  const [showCart, setShowCart] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [confirmedOrder, setConfirmedOrder] = useState<{ order_number: number; total: number } | null>(null);
  const [storeSettings, setStoreSettings] = useState<StoreSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/store-settings?slug=" + encodeURIComponent(params.slug), { cache: "no-store" })
      .then(async response => {
        const result = await response.json() as { tenant?: StoreTenant; settings?: StoreSettings; categories?: StoreCategory[]; products?: MenuItem[] };
        if (!response.ok || !result.settings || !result.tenant) throw new Error("storefront_unavailable");
        if (active) {
          setTenant(result.tenant);
          setStoreSettings(result.settings);
          setCategories(result.categories || []);
          setMenuItems(result.products || []);
          setActiveCategory(result.categories?.[0]?.id || "");
        }
      })
      .catch(() => { if (active) setSettingsError(true); })
      .finally(() => { if (active) setSettingsLoading(false); });
    return () => { active = false; };
  }, [params.slug]);

  const isOpenNow = useMemo(() => {
    if (!storeSettings) return false;
    if (!storeSettings.is_accepting_orders) return false;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const get = (type: string) => parts.find(part => part.type === type)?.value || "";
    const date = get("year") + "-" + get("month") + "-" + get("day");
    if (storeSettings.closed_dates.includes(date)) return false;
    if (!Object.keys(storeSettings.weekly_hours || {}).length) return true;
    const day = get("weekday").toLowerCase().slice(0, 3);
    const time = get("hour") + ":" + get("minute");
    return (storeSettings.weekly_hours[day] || []).some(slot => time >= slot.open && time < slot.close);
  }, [storeSettings, clockNow]);

  const visibleItems = menuItems.filter((item) => item.category_id === activeCategory);
  const activeCategoryName = categories.find(category => category.id === activeCategory)?.name || "";
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
    if (settingsLoading || settingsError || !isOpenNow) return setCheckoutError("店家目前未開放線上接單，請稍後再試。");
    if (cart.length === 0) return setCheckoutError("請先選擇餐點。");
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
          items: cart.map((line) => ({ name: line.item.name, category: categories.find(category => category.id === line.item.category_id)?.name || "", quantity: line.quantity })),
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

  if (settingsError && !tenant) {
    return <main className="order-shell"><section className="store-option-note"><strong>店家資訊暫時無法讀取</strong><span>請稍後重新整理頁面。</span></section></main>;
  }

  return (
    <main className="order-shell">
      <header className="store-header">
        <Link className="store-brand" href="/">好食光</Link>
        <span className="store-header-note">線上點餐 · PICK UP SOMETHING GOOD</span>
        <button className="cart-mobile" onClick={() => setShowCart(!showCart)} aria-label="開啟購物車">
          購物車 <b>{count}</b>
        </button>
      </header>

      <section className="store-hero">
        <div className="store-hero-copy">
          <span className="eyebrow">LOCAL FAVORITE · SINYI DISTRICT</span>
          <h1>{tenant?.name || "好食光店家"}</h1>
          <p>一碗熱騰騰的好味道，今天也替你好好準備。</p>
          <div className="store-meta">
            <span>⌖ {tenant?.address || "店家地址尚未設定"}</span>
            {tenant?.phone && <a href={`tel:${tenant.phone}`}>☎ {tenant.phone}</a>}
          </div>
          <div className={`store-order-status ${settingsLoading ? "loading" : isOpenNow ? "open" : "closed"}`} role="status">
            {settingsLoading ? "正在確認營業狀態…" : settingsError ? "營業資訊暫時無法讀取" : isOpenNow ? `線上接單中 · 預計備餐 ${storeSettings?.prep_time_minutes ?? 20} 分鐘` : "目前暫停線上接單"}
          </div>
        </div>
        <div className="hero-stamp"><span>好食光</span><b>GOOD<br/>FOOD<br/>GOOD DAY</b></div>
      </section>

      <div className="store-layout">
        <section className="menu-section">
          <div className="section-heading">
            <div><span className="eyebrow">OUR MENU</span><h2>今天想吃點什麼？</h2></div>
            <span className="menu-count">{menuItems.length} 道好味道</span>
          </div>
          <nav className="category-tabs" aria-label="菜單分類">
            {categories.map((category) => (
              <button key={category.id} className={activeCategory === category.id ? "active" : ""}
                onClick={() => setActiveCategory(category.id)}>{category.name}</button>
            ))}
          </nav>
          <div className="menu-grid">
            {visibleItems.map((item) => (
              <article className="menu-card" key={item.id}>
                <div className="dish-art" aria-hidden="true"><span>{activeCategoryName === "小菜" ? "🥢" : activeCategoryName.includes("飯") ? "🍚" : "🍜"}</span></div>
                <div className="dish-info">
                  <div className="dish-title-row"><h3>{item.name}</h3><strong>{money(item.price)}</strong></div>
                  {item.description ? <p>{item.description}</p> : <p className="dish-subtle">店家每日新鮮製作</p>}
                  <button className="add-button" onClick={() => add(item)} disabled={!isOpenNow || settingsLoading} aria-label={`加入${item.name}`}>＋ 加入</button>
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
            <><button className="checkout-button" onClick={submitOrder} disabled={submitting || settingsLoading || settingsError || !isOpenNow || cart.length === 0}>{submitting ? "正在送出…" : "送出訂單"} <span>→</span></button>
            {checkoutError && <p className="checkout-error" role="alert">{checkoutError}</p>}
            <p className="checkout-hint">{settingsLoading ? "正在確認店家營業狀態…" : settingsError ? "暫時無法確認營業資訊，請稍後重試。" : !isOpenNow ? "店家目前未開放線上接單，您可以先瀏覽菜單。" : `預計備餐時間約 ${storeSettings?.prep_time_minutes ?? 20} 分鐘。送出後會建立待確認訂單；目前僅支援現場付款。`}</p></>
          )}
        </aside>
      </div>
      <footer className="store-footer"><strong>好食光</strong><span>讓每一餐，都剛剛好。</span><small>此為試點建置頁面，尚未開放正式接單。</small></footer>
    </main>
  );
}
