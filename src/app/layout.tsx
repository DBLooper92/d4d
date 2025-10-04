// src/app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "D4D",
  description: "Driving for Dollars",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="light" style={{ colorScheme: "light" }}>
      <head>
        <meta name="color-scheme" content="light only" />
        <meta name="theme-color" content="#ffffff" />
      </head>
      <body className="min-h-dvh bg-white text-gray-900 antialiased">{children}</body>
    </html>
  );
}
