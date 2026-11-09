"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./products.css";

type Membership = { tenant_id: string; role: "owner" | "manager" | "staff"; tenants: { id: string; name: string; slug: string } | null };
type Category = { id: string; name: string; sort_order: number; is_active: boolean };
type Product = { id: string; category_id: string; name: string; description: string; price: number; is_available: boolean; sort_order: number };
type Catalog = { memberships: Membership[]; categories: Category[]; products: Product[]; canManage: boolean };

const money = (value: number) => new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(value);

export default function MerchantProductsPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPrice, setNewPrice] = useState("0");
  const [newCategoryId, setNewCategoryId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPrice, setEditPrice] = useState("0");
  const [editCategoryId, setEditCategoryId] = useState("");

  const activeCategories = useMemo(() => categories.filter(category => category.is_active), [categories]);
  const visibleProducts = useMemo(() => products.filter(product => categoryFilter === "all" || product.category_id === categoryFilter), [products, categoryFilter]);
  const selectedStore = memberships.find(membership => membership.tenant_id === tenantId)?.tenants;

  const load = useCallback(async (selectedTenant?: string) => {
    setError("");
    try {
      const first = await fetch("/api/merchant/products", { cache: "no-store" });
      if (first.status === 401) { router.replace("/merchant/login"); return; }
      const initial = await first.json() as { memberships?: Membership[]; error?: string };
      if (!first.ok) throw new Error(initial.error || "無法載入店家權限。");
      const nextMemberships = initial.memberships || [];
      setMemberships(nextMemberships);
      const target = selectedTenant || tenantId || nextMemberships[0]?.tenant_id || "";
      if (!target) { setLoading(false); return; }
      setTenantId(target);
      const response = await fetch("/api/merchant/products?tenantId=" + encodeURIComponent(target), { cache: "no-store" });
      const result = await response.json() as Catalog & { error?: string };
      if (!response.ok) throw new Error(result.error || "無法載入商品資料。");
      setCategories(result.categories || []);
      setProducts(result.products || []);
      setCanManage(Boolean(result.canManage));
      setNewCategoryId(current => current || result.categories?.find(category => category.is_active)?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "載入商品資料時發生錯誤。");
    } finally {
      setLoading(false);
    }
  }, [router, tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function save(payload: Record<string, unknown>, success: string) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/merchant/products", {
        method: payload.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, tenantId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "儲存失敗。");
      setNotice(success);
      await load(tenantId);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "儲存失敗。");
      return false;
    } finally { setSaving(false); }
  }

  async function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!await save({ kind: "category", name: newCategory }, "商品分類已新增。")) return;
    setNewCategory("");
  }

  async function addProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!await save({ kind: "product", name: newName, description: newDescription, price: Number(newPrice), categoryId: newCategoryId }, "商品已新增。")) return;
    setNewName(""); setNewDescription(""); setNewPrice("0");
  }

  function beginEdit(product: Product) {
    setEditingId(product.id); setEditName(product.name); setEditDescription(product.description);
    setEditPrice(String(product.price)); setEditCategoryId(product.category_id);
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, product: Product) {
    event.preventDefault();
    if (await save({ kind: "product", id: product.id, name: editName, description: editDescription, price: Number(editPrice), categoryId: editCategoryId }, "商品資料已更新。")) setEditingId("");
  }

  async function toggleAvailability(product: Product) {
    await save({ kind: "product", id: product.id, isAvailable: !product.is_available }, product.is_available ? "商品已停售。" : "商品已恢復販售。");
  }

  async function toggleCategory(category: Category) {
    await save({ kind: "category", id: category.id, isActive: !category.is_active }, category.is_active ? "分類已停用。" : "分類已啟用。");
  }

  async function signOut() {
    await createSupabaseBrowserClient().auth.signOut();
    router.replace("/merchant/login"); router.refresh();
  }

  return <main className="merchant-products-shell">
    <header className="merchant-products-header">
      <a href="/" className="merchant-products-brand">好食光 <span>店家管理</span></a>
      <div><a href="/merchant/orders">訂單管理</a><a href="/merchant/settings">營業設定</a><button onClick={signOut}>登出</button></div>
    </header>
    <section className="merchant-products-intro">
      <div><span className="merchant-products-kicker">MENU MANAGEMENT</span><h1>商品管理</h1><p>管理店內分類、商品價格與販售狀態。</p></div>
      {memberships.length > 1 && <label className="store-picker">目前店家<select value={tenantId} onChange={event => { setTenantId(event.target.value); void load(event.target.value); }}><option value="">選擇店家</option>{memberships.map(item => item.tenants && <option key={item.tenant_id} value={item.tenant_id}>{item.tenants.name}</option>)}</select></label>}
    </section>
    {selectedStore && <p className="current-store">目前管理：{selectedStore.name}（{selectedStore.slug}）</p>}
    {error && <p className="merchant-products-error" role="alert">{error}</p>}
    {notice && <p className="merchant-products-notice" role="status">{notice}</p>}
    {loading ? <div className="products-empty">正在載入商品資料…</div> : !tenantId ?
      <div className="products-empty">目前帳號尚未加入任何店家。</div> : !canManage ?
      <div className="products-empty"><strong>目前帳號只有檢視權限</strong><span>請由店家負責人或管理者授予商品管理權限。</span></div> :
      <>
        <section className="catalog-tools">
          <form className="catalog-form category-form" onSubmit={addCategory}>
            <h2>新增分類</h2>
            <label>分類名稱<input required maxLength={40} value={newCategory} onChange={event => setNewCategory(event.target.value)} placeholder="例如：湯麵類" /></label>
            <button disabled={saving}>新增分類</button>
          </form>
          <form className="catalog-form product-form" onSubmit={addProduct}>
            <h2>新增商品</h2>
            <label>商品名稱<input required maxLength={100} value={newName} onChange={event => setNewName(event.target.value)} placeholder="例如：紅燒牛肉麵" /></label>
            <label>商品分類<select required value={newCategoryId} onChange={event => setNewCategoryId(event.target.value)}><option value="">請選擇分類</option>{activeCategories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label>售價（元）<input type="number" min="0" max="10000000" step="1" required value={newPrice} onChange={event => setNewPrice(event.target.value)} /></label>
            <label>商品描述<textarea maxLength={500} rows={2} value={newDescription} onChange={event => setNewDescription(event.target.value)} placeholder="選填，最多 500 字" /></label>
            <button disabled={saving || !activeCategories.length}>新增商品</button>
            {!activeCategories.length && <small>請先建立至少一個啟用中的分類。</small>}
          </form>
        </section>
        <section className="category-management">
          <div className="catalog-section-heading"><h2>商品分類</h2><span>{categories.length} 個分類</span></div>
          <div className="category-chips">{categories.map(category => <div className={!category.is_active ? "category-chip disabled" : "category-chip"} key={category.id}><span>{category.name}</span><button disabled={saving} onClick={() => void toggleCategory(category)}>{category.is_active ? "停用" : "啟用"}</button></div>)}</div>
        </section>
        <section className="product-management">
          <div className="catalog-section-heading"><h2>商品列表</h2><span>{products.length} 項商品</span></div>
          <nav className="product-filters"><button className={categoryFilter === "all" ? "active" : ""} onClick={() => setCategoryFilter("all")}>全部</button>{activeCategories.map(category => <button key={category.id} className={categoryFilter === category.id ? "active" : ""} onClick={() => setCategoryFilter(category.id)}>{category.name}</button>)}</nav>
          {visibleProducts.length ? <div className="merchant-product-list">{visibleProducts.map(product => <article className="merchant-product-card" key={product.id}>
            {editingId === product.id ? <form className="product-edit-form" onSubmit={event => void saveEdit(event, product)}>
              <label>商品名稱<input required maxLength={100} value={editName} onChange={event => setEditName(event.target.value)} /></label>
              <label>分類<select required value={editCategoryId} onChange={event => setEditCategoryId(event.target.value)}>{activeCategories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>售價（元）<input type="number" min="0" max="10000000" step="1" required value={editPrice} onChange={event => setEditPrice(event.target.value)} /></label>
              <label>商品描述<textarea rows={2} maxLength={500} value={editDescription} onChange={event => setEditDescription(event.target.value)} /></label>
              <div className="product-edit-actions"><button type="submit" disabled={saving}>儲存修改</button><button type="button" className="cancel-edit" onClick={() => setEditingId("")}>取消</button></div>
            </form> : <>
              <div><strong>{product.name}</strong><span>{categories.find(category => category.id === product.category_id)?.name || "未分類"}</span>{product.description && <p>{product.description}</p>}</div>
              <div className="merchant-product-price">{money(product.price)}<span className={product.is_available ? "available" : "unavailable"}>{product.is_available ? "販售中" : "已停售"}</span></div>
              <div className="product-card-actions"><button className="edit-product" disabled={saving} onClick={() => beginEdit(product)}>編輯</button><button className={product.is_available ? "stop-selling" : "start-selling"} disabled={saving} onClick={() => void toggleAvailability(product)}>{product.is_available ? "設為停售" : "恢復販售"}</button></div>
            </>}
          </article>)}</div> : <div className="products-empty">這個分類目前沒有商品。</div>}
        </section>
      </>}
    <p className="merchant-products-footnote">商品刪除採停售／分類停用方式保留歷史訂單與商品快照；只有店家負責人及管理者能修改菜單。</p>
  </main>;
}
