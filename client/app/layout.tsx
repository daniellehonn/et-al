import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { PageTree } from "@/components/PageTree";
import { AuthGate } from "@/components/AuthGate";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "et al.",
  description: "An MCP-native personal operating system.",
  manifest: "/manifest.webmanifest",
  // `capable` is what makes the home-screen launch run without Safari chrome.
  // The manifest declares a `share_target`, but note that only Chrome on Android
  // honours it — iOS has never shipped the Web Share Target API, so on iPhone
  // the share sheet entry comes from a Shortcut instead (docs/IOS-SHARE.md).
  appleWebApp: { capable: true, title: "et al.", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // Next 15 emits only the standardised `mobile-web-app-capable`, which iOS did
  // not honour until 17.4. Keep the legacy Apple name alongside it so older
  // iPhones still launch the home-screen app without Safari chrome.
  other: { "apple-mobile-web-app-capable": "yes" },
};

// `viewport-fit=cover` so the safe-area insets used by the mobile bar resolve on
// notched phones; zoom is left enabled deliberately (accessibility).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f0" },
    { media: "(prefers-color-scheme: dark)", color: "#101013" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${serif.variable} ${mono.variable}`}
        style={{
          // Bind next/font families onto the tokens declared in globals.css.
          ["--font-sans" as string]: "var(--font-inter)",
          ["--font-display" as string]: "var(--font-instrument)",
          ["--font-mono" as string]: "var(--font-jetbrains)",
        }}>
        <Providers>
          {/* Two columns on desktop; globals.css collapses this to one block-flow
              column under the mobile breakpoint, where the Spine goes off-canvas. */}
          <div className="et-shell">
            <PageTree />
            <main style={{ minWidth: 0 }}>
              <AuthGate />
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
