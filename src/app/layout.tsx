import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import "./globals.css";

// The same OFL files the /about page and the pitch deck self-host, so every surface renders
// with byte-identical faces: Syne for display, Familjen Grotesk for text, Kode Mono for data.
const syne = localFont({
  src: "../../public/landing/fonts/syne.woff2",
  weight: "500 800",
  variable: "--font-syne",
  display: "swap",
  fallback: ["Arial Black", "sans-serif"],
});

const familjen = localFont({
  src: [
    { path: "../../public/landing/fonts/familjengrotesk.woff2", weight: "400 700", style: "normal" },
    { path: "../../public/landing/fonts/familjengrotesk-italic.woff2", weight: "400 700", style: "italic" },
  ],
  variable: "--font-familjen",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

const kodeMono = localFont({
  src: "../../public/landing/fonts/kodemono.woff2",
  weight: "400 700",
  variable: "--font-kode",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "monospace"],
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
  themeColor: "#100F0D",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${syne.variable} ${familjen.variable} ${kodeMono.variable}`}>
      <body className="min-h-screen bg-bg text-text antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-text"
        >
          Skip to content
        </a>

        <header className="site-head">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3.5">
            <Link href="/" className="brand flex min-h-[40px] items-center gap-2.5" aria-label="Faultline home">
              <FaultlineMark />
              <span className="font-display text-[19px] font-extrabold tracking-[-0.01em]">Faultline</span>
            </Link>
            <span className="rec hidden lg:inline-flex" aria-hidden="true">
              <i />
              live app · Nebius Serverless AI Jobs
            </span>
            <nav aria-label="Primary" className="ml-auto flex items-center gap-4 text-[14.5px] text-muted sm:gap-5">
              <a className="link-quiet hidden min-h-[40px] items-center sm:inline-flex" href="/about">
                The story
              </a>
              <a className="link-quiet hidden min-h-[40px] items-center sm:inline-flex" href="/pitch">
                Pitch deck
              </a>
              <a className="link-quiet inline-flex min-h-[40px] items-center" href="/api/integrations/verify">
                Integration proof
              </a>
              <a
                className="btn-quiet inline-flex min-h-[40px] items-center gap-2 border border-line px-3.5 text-text"
                href="https://github.com/edycutjong/faultline"
                rel="noreferrer noopener"
                target="_blank"
              >
                <GitHubMark />
                <span className="hidden sm:inline">GitHub</span>
                <span className="sr-only sm:hidden">GitHub</span>
              </a>
            </nav>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="site-foot mt-24">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-9 text-[13.5px] text-muted">
            <p className="max-w-[80ch]">
              Every probe is a real Nebius Serverless AI Job. Job IDs are on screen because they are the proof a
              probe was a cloud container and not a local shell.
            </p>
            <p className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[12.5px] tracking-[0.04em]">
              <a className="link-quiet inline-flex min-h-[40px] items-center" href="/about">The story, every number sourced</a>
              <a className="link-quiet inline-flex min-h-[40px] items-center" href="/pitch">Pitch deck</a>
              <a className="link-quiet inline-flex min-h-[40px] items-center" href="https://github.com/edycutjong/faultline" rel="noreferrer noopener" target="_blank">GitHub</a>
              <a className="link-quiet inline-flex min-h-[40px] items-center" href="https://github.com/edycutjong/faultline/blob/main/LICENSE" rel="noreferrer noopener" target="_blank">MIT License</a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** The mark: the site icon — a strata line, slipped at the fault. */
function FaultlineMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icon.svg" width={26} height={26} alt="" aria-hidden="true" className="brand-mark" />
  );
}

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
