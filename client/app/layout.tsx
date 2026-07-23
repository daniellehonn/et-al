import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "et al.",
  description: "A personal operating system for what you save, learn, and build.",
};

// Navigation is deliberately restrained (spec §4.1). Life Areas are filters and
// context, not top-level destinations — giving each identity its own workspace
// would recreate the fragmentation this product exists to remove.
const NAV = [
  { href: "/", label: "Home" },
  { href: "/inbox/", label: "Inbox" },
  { href: "/projects/", label: "Projects" },
  { href: "/knowledge/", label: "Knowledge" },
  { href: "/library/", label: "Library" },
  { href: "/content/", label: "Content" },
  { href: "/review/", label: "Review" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <div className="brand">et al.</div>
            {NAV.map((item) => (
              <a key={item.href} href={item.href}>{item.label}</a>
            ))}
          </nav>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
