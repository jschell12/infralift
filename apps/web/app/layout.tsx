import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "infralift — fixed-fee infrastructure migrations, delivered as Terraform",
  description:
    "Connect a read-only token. Get an assessment with cost projections. We migrate you off Vercel, Heroku, Firebase, or AWS onto Cloudflare or a VPS — every deliverable is Terraform in a repo you own.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
