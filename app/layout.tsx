import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CampaignDesk — WhatsApp Campaign Manager",
  description: "Manage WhatsApp sessions, consented audiences and scheduled campaigns.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
