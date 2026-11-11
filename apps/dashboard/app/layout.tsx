import type { Metadata } from "next";
import "./globals.css";
import { AppNav } from "../components/sidebar-nav";

export const metadata: Metadata = {
  title: "infralift",
  description: "See what your infrastructure costs. See what it should cost.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen md:flex">
          <AppNav />
          <main className="min-w-0 flex-1 max-w-[1000px] p-4 md:p-10">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
