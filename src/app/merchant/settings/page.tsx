"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./settings.css";

const days = [
  { key: "mon", label: "星期一" }, { key: "tue", label: "星期二" },
  { key: "wed", label: "星期三" }, { key: "thu", label: "星期四" },
  { key: "fri", label: "星期五" }, { key: "sat", label: "星期六" },
  { key: "sun", label: "星期日" },
] as const;
type Day = typeof days[number]["key"];
type Slot = { open: string; close: string };
type Hours = Partial<Record<Day, Slot[]>>;
type Membership = { tenant_id: string; role: string; tenants: { id: string; name: string; slug: string } | null };
type Settings = { is_accepting_orders: boolean; prep_time_minutes: number; weekly_hours: Hours; closed_dates: string[] };
const defaultSettings: Settings = { is_accepting_orders: true, prep_time_minutes: 20, weekly_hours: {}, closed_dates: [] };

export default function MerchantSettingsPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [newClosedDate, setNewClosedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (target?: string) => {
    setError("");
    try {
      const response = await fetch("/api/merchant/settings", { cache: "no-store" });
      if (response.status === 401) { router.replace("/merchant/login"); return; }
      const result = await response.json() as { memberships?: Membership[]; error?: string };
      if (!response.ok) throw new Error(result.error || "無法讀取店家資料。");
      const items = result.memberships || [];
      setMemberships(items);
      const selected = target || tenantId || items[0]?.tenant_id || "";
      if (!selected) return;
      setTenantId(selected);
      const detail = await fetch("/api/merchant/settings?tenantId=" + encodeURIComponent(selected), { cache: "no-store" });
      const data = await detail.json() as { settings?: Settings; error?: string };
      if (!detail.ok || !data.settings) throw new Error(data.error || "無法讀取營業設定。");
      setSettings({ ...defaultSettings, ...data.settings, weekly_hours: data.settings.weekly_hours || {}, closed_dates: data.settings.closed_dates || [] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "讀取營業設定失敗。"); }
    finally { setLoading(false); }
  }, [router, tenantId]);

  useEffect(() => { void load(); }, [load]);

  function setSlot(day: Day, index: number, field: keyof Slot, value: string) {
    setSettings(current => {
      const slots = [...(current.weekly_hours[day] || [])];
      slots[index] = { ...(slots[index] || { open: "11:00", close: "14:00" }), [field]: value };
      return { ...current, weekly_hours: { ...current.weekly_hours, [day]: slots } };
    });
  }

  function addSlot(day: Day) {
    setSettings(current => {
      const slots = [...(current.weekly_hours[day] || [])];
      if (slots.length >= 2) return current;
      slots.push({ open: "17:00", close: "21:00" });
      return { ...current, weekly_hours: { ...current.weekly_hours, [day]: slots } };
    });
  }

  function removeSlot(day: Day, index: number) {
    setSettings(current => {
      const slots = (current.weekly_hours[day] || []).filter((_, i) => i !== index);
      const weeklyHours = { ...current.weekly_hours };
      if (slots.length) weeklyHours[day] = slots; else delete weeklyHours[day];
      return { ...current, weekly_hours: weeklyHours };
    });
  }

  async function save() {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/merchant/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, isAcceptingOrders: settings.is_accepting_orders,
          prepTimeMinutes: settings.prep_time_minutes, weeklyHours: settings.weekly_hours, closedDates: settings.closed_dates }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "儲存失敗。");
      setNotice("營業設定已儲存，顧客點餐頁與結帳驗證將同步套用。");
      await load(tenantId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "儲存失敗。"); }
    finally { setSaving(false); }
  }

  async function signOut() {
    await createSupabaseBrowserClient().auth.signOut();
    router.replace("/merchant/login"); router.refresh();
  }

  const selected = memberships.find(item => item.tenant_id === tenantId)?.tenants;
  const canManage = ["owner", "manager"].includes(memberships.find(item => item.tenant_id === tenantId)?.role || "");

  return <main className="merchant-settings-shell">
    <header className="merchant-settings-header"><a href="/" className="merchant-settings-brand">好食光 <span>店家管理</span></a>
      <nav><a href="/merchant/orders">訂單管理</a><a href="/merchant/products">商品管理</a><button onClick={signOut}>登出</button></nav></header>
    <section className="merchant-settings-intro"><span>STORE OPERATIONS</span><h1>營業設定</h1><p>設定每週營業時間、公休日、接單開關與預計備餐時間。</p>
      {memberships.length > 1 && <label>管理店家<select value={tenantId} onChange={event => { setTenantId(event.target.value); void load(event.target.value); }}>{memberships.map(item => item.tenants && <option key={item.tenant_id} value={item.tenant_id}>{item.tenants.name}</option>)}</select></label>}
      {selected && <small>目前店家：{selected.name}</small>}
    </section>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    {loading ? <div className="settings-empty">正在載入…</div> : !tenantId ? <div className="settings-empty">目前帳號尚未加入任何店家。</div> : !canManage ? <div className="settings-empty">只有店家負責人及管理者可以修改營業設定。</div> : <>
      <section className="settings-card order-toggle-card"><div><h2>線上接單</h2><p>暫停接單會立即阻止新的顧客訂單，既有訂單不受影響。</p></div>
        <button className={settings.is_accepting_orders ? "accepting" : "paused"} onClick={() => setSettings(s => ({ ...s, is_accepting_orders: !s.is_accepting_orders }))}>{settings.is_accepting_orders ? "接單中 · 點擊暫停" : "已暫停 · 點擊恢復"}</button></section>
      <section className="settings-card"><div className="settings-heading"><h2>每週營業時間</h2><span>台灣時間 UTC+8 · 每日最多兩個時段</span></div>
        <div className="weekly-hours">{days.map(day => <div className="hours-day" key={day.key}><strong>{day.label}</strong><div className="hours-slots">
          {(settings.weekly_hours[day.key] || []).map((slot,index) => <div className="hours-slot" key={index}><input aria-label={day.label+"開始時間"} type="time" value={slot.open} onChange={event => setSlot(day.key,index,"open",event.target.value)} /><span>至</span><input aria-label={day.label+"結束時間"} type="time" value={slot.close} onChange={event => setSlot(day.key,index,"close",event.target.value)} /><button onClick={() => removeSlot(day.key,index)} aria-label="移除此時段">移除</button></div>)}
          {!(settings.weekly_hours[day.key] || []).length && <span className="day-closed">未設定（不開放線上接單）</span>}
          {(settings.weekly_hours[day.key] || []).length < 2 && <button className="add-hours" onClick={() => addSlot(day.key)}>＋ 新增時段</button>}
        </div></div>)}</div>
      </section>
      <section className="settings-card"><div className="settings-heading"><h2>公休日</h2><span>最多 90 個日期</span></div>
        <div className="closed-date-add"><input type="date" value={newClosedDate} onChange={event => setNewClosedDate(event.target.value)} /><button disabled={!newClosedDate || settings.closed_dates.includes(newClosedDate) || settings.closed_dates.length >= 90} onClick={() => { setSettings(s => ({ ...s, closed_dates: [...s.closed_dates, newClosedDate].sort() })); setNewClosedDate(""); }}>新增公休日</button></div>
        <div className="closed-date-list">{settings.closed_dates.map(date => <span key={date}>{date}<button onClick={() => setSettings(s => ({ ...s, closed_dates: s.closed_dates.filter(item => item !== date) }))}>移除</button></span>)}</div>
      </section>
      <section className="settings-card prep-time-card"><div><h2>預計備餐時間</h2><p>顯示於顧客點餐頁，範圍 5–180 分鐘。</p></div><label><input type="number" min="5" max="180" step="5" value={settings.prep_time_minutes} onChange={event => setSettings(s => ({ ...s, prep_time_minutes: Number(event.target.value) }))} /> 分鐘</label></section>
      <button className="save-settings" disabled={saving} onClick={() => void save()}>{saving ? "儲存中…" : "儲存營業設定"}</button>
    </>}
  </main>;
}
