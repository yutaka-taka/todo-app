import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "シンプルToDoリスト",
  description: "タスクを管理するシンプルなToDoアプリ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
