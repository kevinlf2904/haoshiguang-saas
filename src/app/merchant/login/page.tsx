"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./login.css";

export default function MerchantLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) throw authError;
      router.replace("/merchant/orders");
      router.refresh();
    } catch {
      setError("登入失敗，請確認帳號、密碼及 Supabase Auth 設定。");
    } finally {
      setBusy(false);
    }
  }

  return <main className="merchant-login-shell">
    <section className="merchant-login-card">
      <Link className="merchant-login-brand" href="/">好食光</Link>
      <span className="merchant-login-kicker">MERCHANT PORTAL</span>
      <h1>店家管理登入</h1>
      <p>登入後即可查看所屬店家的訂單。帳號權限由店家管理員授予。</p>
      <form onSubmit={submit}>
        <label>電子郵件<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>密碼<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p className="merchant-login-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "登入中…" : "登入管理後台"}</button>
      </form>
      <small>此為試點管理入口，尚未開放自行註冊。</small>
    </section>
  </main>;
}
