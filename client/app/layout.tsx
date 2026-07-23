import type { Metadata } from "next";
import "./globals.css";
import AuthGate from "@/components/AuthGate";

export const metadata: Metadata = {
  title: "et al.",
  description: "A personal operating system for what you save, learn, and build.",
};

// Navigation is deliberately restrained (spec §4.1). Life Areas are filters and
// context, not top-level destinations — giving each identity its own workspace
// would recreate the fragmentation this product exists to remove.
// Grouped rather than a flat list of ten. The sections mirror the loop the
// product is built around — capture, then act, then make sense of it — so the
// nav teaches the model instead of just listing screens.
const NAV: Array<{ group: string; items: Array<{ href: string; label: string }> }> = [
  {
    group: "",
    items: [
      { href: "/", label: "Home" },
      { href: "/search/", label: "Search" },
      { href: "/inbox/", label: "Inbox" },
    ],
  },
  {
    group: "Do",
    items: [
      { href: "/projects/", label: "Projects" },
      { href: "/goals/", label: "Goals" },
    ],
  },
  {
    group: "Learn",
    items: [
      { href: "/knowledge/", label: "Knowledge" },
      { href: "/library/", label: "Library" },
    ],
  },
  {
    group: "Share",
    items: [
      { href: "/content/", label: "Content" },
      { href: "/identity/", label: "Identity" },
    ],
  },
  { group: "", items: [{ href: "/review/", label: "Review" }] },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <div className="brand">et al.</div>
            {NAV.map((section, i) => (
              <div key={i} className="nav-group">
                {section.group && <div className="nav-group-label">{section.group}</div>}
                {section.items.map((item) => (
                  <a key={item.href} href={item.href}>{item.label}</a>
                ))}
              </div>
            ))}
          </nav>
          <main className="main">{children}</main>
        </div>
        {/* Sits above every page: writing needs the session, and a silent 401
            is indistinguishable from a broken app. */}
        <AuthGate />
      </body>
    </html>
  );
}
