"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import "./hours.css";

type Slot = { open: string; close: string };
type Hours = Record<string, Slot[]>;
type Tenant = { id: string; name: string; slug: string; weekly_hours: Hours; special_hours: Record<string, { closed?: boolean; intervals?: Slot[] }>; accepting_orders: boolean; prep_time_minutes: number };
const days = ["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];
const defaults: Hours = Object.fromEntries(days.map((_,i)=>[String(i), i===0?[]:[{open:"11:00",close:"14:00"},{open:"17:00",close:"20:00"}]]));

export default function MerchantHoursPage() {
 const router=useRouter();
 const [memberships,setMemberships]=useState<Array<{tenant_id:string;tenants:{id:string;name:string}|null}>>([]);
 const [tenantId,setTenantId]=useState("");
 const [tenant,setTenant]=useState<Tenant|null>(null);
 const [hours,setHours]=useState<Hours>(defaults);
 const [special,setSpecial]=useState("{}");
 const [accepting,setAccepting]=useState(true);
 const [prep,setPrep]=useState(20);
 const [loading,setLoading]=useState(true);
 const [saving,setSaving]=useState(false);
 const [message,setMessage]=useState("");
 const [error,setError]=useState("");
 const load=useCallback(async(id?:string)=>{
  setError(""); try {
   const first=await fetch("/api/merchant/business-hours",{cache:"no-store"});
   if(first.status===401){router.replace("/merchant/login");return;}
   const initial=await first.json();
   if(!first.ok)throw new Error(initial.error||"無法載入店家。");
   setMemberships(initial.memberships||[]);
   const target=id||tenantId||initial.memberships?.[0]?.tenant_id;
   if(!target)return;
   setTenantId(target);
   const response=await fetch("/api/merchant/business-hours?tenantId="+encodeURIComponent(target),{cache:"no-store"});
   const result=await response.json(); if(!response.ok)throw new Error(result.error||"無法載入營業設定。");
   const t=result.tenant as Tenant; setTenant(t); setHours(t.weekly_hours||defaults); setSpecial(JSON.stringify(t.special_hours||{},null,2));
   setAccepting(t.accepting_orders); setPrep(t.prep_time_minutes);
  }catch(e){setError(e instanceof Error?e.message:"載入失敗。");}finally{setLoading(false);}
 },[router,tenantId]);
 useEffect(()=>{void load();},[load]);
 function updateSlot(day:string,index:number,key:keyof Slot,value:string){
  setHours(current=>({...current,[day]:current[day].map((slot,i)=>i===index?{...slot,[key]:value}:slot)}));
 }
 async function save(){
  setSaving(true);setError("");setMessage("");
  try{
   let specialHours:Tenant["special_hours"]; try{specialHours=JSON.parse(special);}catch{throw new Error("臨時公休 JSON 格式錯誤。");}
   const response=await fetch("/api/merchant/business-hours",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({tenantId,weeklyHours:hours,specialHours,acceptingOrders:accepting,prepTimeMinutes:prep})});
   const result=await response.json();if(!response.ok)throw new Error(result.error||"儲存失敗。");
   setMessage("營業設定已儲存。");
  }catch(e){setError(e instanceof Error?e.message:"儲存失敗。");}finally{setSaving(false);}
 }
 async function signOut(){await createSupabaseBrowserClient().auth.signOut();router.replace("/merchant/login");router.refresh();}
 return <main className="hours-shell">
  <header><a href="/merchant/orders">好食光 · 店家管理</a><nav><a href="/merchant/products">商品管理</a><button onClick={signOut}>登出</button></nav></header>
  <section className="hours-title"><span>STORE SETTINGS</span><h1>營業設定與接單控制</h1><p>營業時間以台灣時間（Asia/Taipei）判斷。</p></section>
  {memberships.length>1&&<label className="hours-picker">選擇店家<select value={tenantId} onChange={e=>void load(e.target.value)}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.name||m.tenant_id}</option>)}</select></label>}
  {loading?<p>載入中…</p>:!tenant?<p>目前帳號沒有可管理的店家。</p>:<>
   <section className="accept-toggle"><div><strong>{accepting?"目前允許接單":"目前暫停接單"}</strong><p>暫停後顧客仍可瀏覽菜單，但無法送出訂單。</p></div><button className={accepting?"is-on":"is-off"} onClick={()=>setAccepting(v=>!v)}>{accepting?"暫停接單":"恢復接單"}</button></section>
   <section className="hours-card"><h2>每週營業時間</h2><p>每一天可設定多個時段；刪除全部時段代表當日公休。</p>
    {days.map((day,i)=><div className="day-row" key={i}><strong>{day}</strong><div className="slots">{(hours[String(i)]||[]).map((slot,index)=><div className="slot" key={index}><input aria-label={day+"開始時間"} type="time" value={slot.open} onChange={e=>updateSlot(String(i),index,"open",e.target.value)}/><span>至</span><input aria-label={day+"結束時間"} type="time" value={slot.close} onChange={e=>updateSlot(String(i),index,"close",e.target.value)}/><button onClick={()=>setHours(h=>({...h,[String(i)]:h[String(i)].filter((_,n)=>n!==index)}))}>移除</button></div>)}<button className="add-slot" onClick={()=>setHours(h=>({...h,[String(i)]:[...(h[String(i)]||[]),{open:"11:00",close:"14:00"}]}))}>＋ 新增時段</button></div></div>)}
   </section>
   <section className="hours-card"><h2>臨時公休／特殊營業日</h2><p>使用日期作為 key；格式範例：{"{ "2026-12-25": { "closed": true }, "2026-12-31": { "intervals": [{ "open": "11:00", "close": "15:00" }] } }"}</p><textarea rows={7} value={special} onChange={e=>setSpecial(e.target.value)}/></section>
   <section className="hours-card prep-card"><label>預計備餐時間（分鐘）<input type="number" min="5" max="240" step="5" value={prep} onChange={e=>setPrep(Number(e.target.value))}/></label></section>
   {error&&<p className="hours-error" role="alert">{error}</p>}{message&&<p className="hours-success" role="status">{message}</p>}
   <button className="save-hours" disabled={saving} onClick={()=>void save()}>{saving?"儲存中…":"儲存營業設定"}</button>
  </>}
 </main>;
}
