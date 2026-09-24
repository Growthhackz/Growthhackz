import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Peak Swap — Solana",
  description: "Swap Solana tokens with Peak. Wallet-signed trades powered by Jupiter.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
