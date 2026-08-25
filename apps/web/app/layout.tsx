import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "infralift | fixed-fee infrastructure migrations, delivered as Terraform",
  description:
    "Your cloud bill shouldn't scale faster than your revenue. Free assessment for Vercel, Heroku, Firebase, AWS, GCP, Azure, Netlify, Render, Railway, Fly.io, and DigitalOcean. Fixed-fee migration onto infrastructure you own, delivered as Terraform.",
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
