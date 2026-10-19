import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CDS Extension Dashboard",
  description: "Team-scoped access control for the CDS Notification Centre extension"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
