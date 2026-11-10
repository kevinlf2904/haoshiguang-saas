"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./members.css";

type Membership = { tenant_id: string; role: "owner" | "manager" | "staff"; tenants: { id: string; name: string; slug: string } | null };
type Member = { id: string; userId: string; email: string | null; role: "owner" | "manager" | "staff"; createdAt: string };

export default function MerchantMembersPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"manager" | "staff">("staff");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const actorRole = memberships.find(item => item.tenant_id === tenantId)?.role;
  const selectedStore = memberships.find(item => item.tenant_id === tenantId)?.tenants;
  const canManage = actorRole === "owner" || actorRole === "manager";

  const load = useCallback(async (target?: string) => {
    setError("");
    try {
      const first = await fetch("/api/merchant/settings", { cache: "no-store" });
      if (first.status === 401) { router.replace("/merchant/login"); return; }
      const initial = await first.json() as { memberships?: Membership[]; error?: string };
      if (!first.ok) throw new Error(initial.error || "無法讀取店家權限。");
      const items = initial.memberships || [];
      setMemberships(items);
      const selected = target || tenantId || items[0]?.tenant_id || "";
      if (!selected) { setMembers([]); return; }
      setTenantId(selected);
      const response = await fetch("/api/merchant/members?tenantId=" + encodeURIComponent(selected), { cache: "no-store" });
      const result = await response.json() as { members?: Member[]; error?: string };
      if (!response.ok) throw new Error(result.error || "無法讀取會員資料。");
      setMembers(result.members || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "讀取會員資料失敗。");
    } finally { setLoading(false); }
  }, [router, tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/merchant/members", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, email: email.trim(), role: inviteRole }),
      });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "邀請失敗。");
      setEmail(""); setNotice(result.message || "邀請已送出。");
      await load(tenantId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "邀請失敗。");
    } finally { setBusy(false); }
  }

  async function remove(member: Member) {
    if (!window.confirm("確定要移除此會員在目前店家的權限嗎？此操作不會刪除其登入帳號。")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/merchant/members", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, membershipId: member.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "移除會員失敗。");
      setNotice("已移除該會員的店家權限。");
      await load(tenantId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除會員失敗。");
    } finally { setBusy(false); }
  }

  async function signOut() {
    await createSupabaseBrowserClient().auth.signOut();
    router.replace("/merchant/login"); router.refresh();
  }

  const roleLabel = (role: Member["role"]) => role === "owner" ? "負責人" : role === "manager" ? "管理者" : "員工";

  return <main className="merchant-members-shell">
    <header className="merchant-members-header">
      <Link href="/" className="merchant-members-brand">好食光 <span>店家管理</span></Link>
      <nav><Link href="/merchant/orders">訂單管理</Link><Link href="/merchant/products">商品管理</Link><Link href="/merchant/settings">營業設定</Link><Link href="/merchant/profile">店家資料</Link><button onClick={signOut}>登出</button></nav>
    </header>
    <section className="merchant-members-intro">
      <span>TEAM ACCESS</span><h1>店家會員管理</h1><p>邀請管理者與員工，並管理其在目前店家的存取權限。</p>
      {memberships.length > 1 && <label>管理店家<select value={tenantId} onChange={event => { setTenantId(event.target.value); void load(event.target.value); }}>{memberships.map(item => item.tenants && <option key={item.tenant_id} value={item.tenant_id}>{item.tenants.name}</option>)}</select></label>}
      {selectedStore && <small>目前店家：{selectedStore.name}</small>}
    </section>
    {error && <p className="members-error" role="alert">{error}</p>}
    {notice && <p className="members-notice" role="status">{notice}</p>}
    {loading ? <div className="members-empty">正在載入會員…</div> : !tenantId ? <div className="members-empty">目前帳號尚未加入任何店家。</div> : !canManage ? <div className="members-empty">只有店家負責人及管理者可以管理會員。</div> : <>
      <section className="members-card">
        <h2>邀請新會員</h2>
        <p>系統會寄送 Supabase Auth 邀請信。一般邀請無法授予負責人權限。</p>
        <form onSubmit={invite}>
          <label>電子郵件<input type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="staff@example.com" /></label>
          <label>授予角色<select value={inviteRole} onChange={event => setInviteRole(event.target.value as "manager" | "staff")}>
            {actorRole === "owner" && <option value="manager">管理者</option>}
            <option value="staff">員工</option>
          </select></label>
          <button disabled={busy || !email.trim()}>{busy ? "處理中…" : "寄送邀請"}</button>
        </form>
        {actorRole === "manager" && <small>管理者僅能邀請員工；如需新增管理者，請由負責人操作。</small>}
      </section>
      <section className="members-card">
        <div className="members-heading"><h2>目前會員</h2><span>{members.length} 位</span></div>
        {members.length ? <div className="members-list">{members.map(member => <article key={member.id}>
          <div><strong>{member.email || "未取得電子郵件"}</strong><span>{roleLabel(member.role)}</span></div>
          {member.role === "owner" ? <small>負責人權限需透過正式移轉流程變更</small> :
            (actorRole === "owner" || member.role === "staff") && <button disabled={busy} onClick={() => void remove(member)}>移除權限</button>}
        </article>)}</div> : <p className="members-empty-inline">尚無會員資料。</p>}
      </section>
    </>}
    <p className="members-footnote">移除會員只會撤銷其目前店家的 membership，不會刪除 Supabase Auth 帳號，也不會影響其在其他店家的權限。負責人移轉功能尚未開放。</p>
  </main>;
}
