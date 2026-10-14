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

const SITE = "https://faultline.edycu.dev";
// Search and link previews clip long descriptions: meta ≤ 160 characters, og/twitter ≤ 125.
const DESCRIPTION =
  "Faultline finds the commit that broke a test: each probe is a fresh Nebius container with that commit's own dependencies. Both ends proven, culprit explained.";
const SHARE_DESCRIPTION =
  "Finds the commit that broke your test: each probe a fresh Nebius container, both ends proven, the culprit explained.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Faultline — find the commit that broke it, in a clean room",
  description: DESCRIPTION,
  applicationName: "Faultline",
  authors: [{ name: "Edy Cu" }],
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  // Without these the deploy unfurls as a bare link. Slack, X and LinkedIn centre-crop the
  // card to 2:1, so og-image.png is composed to survive that crop (checked against a 2:1
  // centre crop).
  openGraph: {
    type: "website",
    siteName: "Faultline",
    url: SITE,
    title: "Faultline — find the commit that broke it, in a clean room",
    description: SHARE_DESCRIPTION,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Faultline — the commit that broke it, found in clean environments" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Faultline — find the commit that broke it, in a clean room",
    description: SHARE_DESCRIPTION,
    images: ["/og-image.png"],
  },
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
            <Link href="/" className="flex min-h-[40px] items-center gap-2.5" aria-label="Faultline home">
              <FaultlineMark />
              <span className="text-[15px] font-semibold tracking-tight">Faultline</span>
            </Link>
            <nav aria-label="Primary" className="flex items-center gap-5 text-[13px] text-muted">
              <a
                className="link-quiet inline-flex min-h-[40px] items-center hover:text-text"
                href="/api/integrations/verify"
              >
                Integration proof
              </a>
              <a
                className="link-quiet inline-flex min-h-[40px] items-center hover:text-text"
                href="https://github.com/edycutjong/faultline"
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
            <p className="flex flex-wrap items-center gap-x-1">
              <a className="link-quiet inline-flex min-h-[40px] items-center underline decoration-line underline-offset-4 hover:text-text" href="/about">
                The story, with every number sourced
              </a>
              {" · "}
              <a className="link-quiet inline-flex min-h-[40px] items-center underline decoration-line underline-offset-4 hover:text-text" href="/pitch">
                Pitch deck
              </a>
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
