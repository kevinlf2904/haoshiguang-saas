import type { Metadata } from "next";
import OrderTrackingClient from "./tracking-client";

export const metadata: Metadata = {
  title: "訂單進度｜好食光",
  robots: { index: false, follow: false },
};

export default function OrderTrackingPage() {
  return <OrderTrackingClient />;
}
