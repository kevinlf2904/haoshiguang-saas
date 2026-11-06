import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "好食光｜線上點餐",
  description: "好食光 SaaS 訂餐平台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
