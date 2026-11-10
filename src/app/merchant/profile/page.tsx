"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./profile.css";

type Membership = {
  tenant_id: string;
  role: string;
  tenants: { id: string; name: string; slug: string } | null;
};
type Profile = { id: string; name: string; slug: string; phone: string | null; address: string | null };

export default function MerchantProfilePage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (selectedTenantId?: string) => {
    setError("");
    try {
      const membershipResponse = await fetch("/api/merchant/settings", { cache: "no-store" });
      if (membershipResponse.status === 401) { router.replace("/merchant/login"); return; }
      const membershipResult = await membershipResponse.json() as { memberships?: Membership[]; error?: string };
      if (!membershipResponse.ok) throw new Error(membershipResult.error || "無法讀取店家權限。");
      const items = membershipResult.memberships || [];
      setMemberships(items);
      const selected = selectedTenantId || tenantId || items[0]?.tenant_id || "";
      if (!selected) { setProfile(null); setTenantId(""); return; }
      setTenantId(selected);
      const response = await fetch("/api/merchant/profile?tenantId=" + encodeURIComponent(selected), { cache: "no-store" });
      const result = await response.json() as { profile?: Profile; canManage?: boolean; error?: string };
      if (response.status === 401) { router.replace("/merchant/login"); return; }
      if (!response.ok || !result.profile) throw new Error(result.error || "無法讀取店家資料。");
      setProfile(result.profile);
      setCanManage(Boolean(result.canManage));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "讀取店家資料失敗。");
    } finally {
      setLoading(false);
    }
  }, [router, tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!profile) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/merchant/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: profile.id,
          name: profile.name,
          phone: profile.phone || "",
          address: profile.address || "",
        }),
      });
      const result = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok || !result.profile) throw new Error(result.error || "儲存店家資料失敗。");
      setProfile(result.profile);
      setNotice("店家資料已儲存，顧客點餐頁將同步顯示最新資訊。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "儲存店家資料失敗。");
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    await createSupabaseBrowserClient().auth.signOut();
    router.replace("/merchant/login");
    router.refresh();
  }

  return <main className="merchant-profile-shell">
    <header className="merchant-profile-header">
      <Link href="/" className="merchant-profile-brand">好食光 <span>店家管理</span></Link>
      <nav>
        <Link href="/merchant/orders">訂單管理</Link>
        <Link href="/merchant/products">商品管理</Link>
        <Link href="/merchant/settings">營業設定</Link>
        <button onClick={signOut}>登出</button>
      </nav>
    </header>
    <section className="merchant-profile-intro">
      <span>STORE PROFILE</span><h1>店家資料</h1>
      <p>管理顧客點餐頁顯示的店名、聯絡電話與地址。</p>
      {memberships.length > 1 && <label>管理店家
        <select value={tenantId} onChange={event => { setTenantId(event.target.value); void load(event.target.value); }}>
          {memberships.map(item => item.tenants && <option key={item.tenant_id} value={item.tenant_id}>{item.tenants.name}</option>)}
        </select>
      </label>}
      {profile && <small>店舖網址識別：{profile.slug}（不可在此變更）</small>}
    </section>
    {error && <p className="profile-error" role="alert">{error}</p>}
    {notice && <p className="profile-notice" role="status">{notice}</p>}
    {loading ? <div className="profile-empty">正在載入…</div> : !profile ?
      <div className="profile-empty">目前帳號尚未加入任何店家。</div> :
      <section className="profile-card">
        <label>店家名稱
          <input value={profile.name} maxLength={80} disabled={!canManage}
            onChange={event => setProfile(current => current ? { ...current, name: event.target.value } : current)} />
          <small>顧客點餐頁的主要店名，最多 80 個字。</small>
        </label>
        <label>聯絡電話
          <input value={profile.phone || ""} maxLength={30} inputMode="tel" disabled={!canManage}
            onChange={event => setProfile(current => current ? { ...current, phone: event.target.value } : current)} />
          <small>顧客可從點餐頁直接撥打聯絡店家。</small>
        </label>
        <label>店家地址
          <textarea value={profile.address || ""} maxLength={200} rows={3} disabled={!canManage}
            onChange={event => setProfile(current => current ? { ...current, address: event.target.value } : current)} />
          <small>顯示於店家點餐頁，最多 200 個字。</small>
        </label>
        {canManage ? <button className="save-profile" disabled={saving || !profile.name.trim()} onClick={() => void save()}>
          {saving ? "儲存中…" : "儲存店家資料"}
        </button> : <p className="profile-readonly">目前帳號只有查看權限；請由店家負責人或管理者修改資料。</p>}
      </section>}
  </main>;
}
