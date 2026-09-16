import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Work Distribution Grid",
  description: "A local-first planning board for balancing work across your team.",
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
