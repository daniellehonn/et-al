import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { Spine } from "@/components/Spine";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "et al.",
  description: "An MCP-native personal operating system.",
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
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 15rem) minmax(0, 1fr)", minHeight: "100vh" }} className="et-shell">
            <Spine />
            <main style={{ minWidth: 0 }}>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
