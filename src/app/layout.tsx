import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Faultline — parallel bisection of a broken commit range",
  description:
    "Your laptop can only be one machine. Faultline bisects a broken commit range across eight Nebius cloud machines at once — and tells you why it broke.",
  applicationName: "Faultline",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-bg text-text antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-text"
        >
          Skip to content
        </a>

        <header className="border-b border-line/60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
            <Link href="/" className="flex items-center gap-2.5" aria-label="Faultline home">
              <FaultlineMark />
              <span className="text-[15px] font-semibold tracking-tight">Faultline</span>
            </Link>
            <nav aria-label="Primary" className="flex items-center gap-5 text-[13px] text-muted">
              <a className="hover:text-text" href="/api/integrations/verify">
                Integration proof
              </a>
              <a
                className="hover:text-text"
                href="https://github.com/edycu/faultline"
                rel="noreferrer noopener"
                target="_blank"
              >
                Source
              </a>
            </nav>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="mt-24 border-t border-line/60">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-[13px] text-muted">
            <p>
              Faultline runs every probe as a real Nebius Serverless AI Job. Job IDs are shown on
              screen because they are the proof a probe was a cloud container and not a local shell.
            </p>
            <p>
              Desktop-first by design. Below 768px the timeline stacks vertically with identical
              colour semantics — legible, not optimised.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** The mark: a range of ticks with one fault line through it. Graphics-only accent use. */
function FaultlineMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <rect x="1" y="6" width="3" height="10" rx="1.5" fill="var(--unknown)" />
      <rect x="6" y="6" width="3" height="10" rx="1.5" fill="var(--innocent)" />
      <rect x="11" y="4" width="3" height="14" rx="1.5" fill="var(--guilty)" />
      <rect x="16" y="6" width="3" height="10" rx="1.5" fill="var(--unknown)" />
    </svg>
  );
}
