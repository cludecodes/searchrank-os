import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SEARCHRANK OS — Search Intelligence Platform",
  description: "Evidence-driven SEO operations, discovery, content and reporting for registered businesses.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
