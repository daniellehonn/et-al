import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { Spine } from "@/components/Spine";
import { AuthGate } from "@/components/AuthGate";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "et al.",
  description: "An MCP-native personal operating system.",
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
            <Spine />
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
