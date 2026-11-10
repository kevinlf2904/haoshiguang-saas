import Link from "next/link";

export default function HomePage() {
  return <main className="shell">
    <div className="brand">好食光 · HAOSHIGUANG</div>
    <section className="hero">
      <h1>讓每一餐，都剛剛好。</h1>
      <p>給台灣餐飲店家的雲端訂餐 SaaS。<br/>多店家管理、獨立店舖網址、線上點餐與訂單管理。</p>
      <span className="tag">SaaS 多租戶</span><span className="tag">Pilot 試營運</span><span className="tag">繁體中文 · TWD</span>
    </section>
    <section className="panel">
      <h2>第一家試點店家：老張麵店</h2>
      <p className="muted">顧客點餐介面已進入開發階段；雲端送單、店家登入及訂單管理仍在建置中。</p><p><Link href="/store/laozhang">前往老張麵店點餐介面 →</Link></p>
    </section>
  </main>;
}
