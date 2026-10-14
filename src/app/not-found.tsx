import Link from "next/link";

/**
 * 404 — the trace with nothing on it. A flat line with one stray tick: the instrument is
 * recording, there is simply no event at this address.
 */
export default function NotFound() {
  const flat = Array.from({ length: 121 }, (_, i) => {
    const x = (i / 120) * 1000;
    const blip = i === 74 ? -26 : i === 75 ? 22 : i === 76 ? -10 : 0;
    const y = 60 + Math.sin(i * 1.9) * 1.4 + Math.sin(i * 5.3) * 0.7 + blip;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" L");

  return (
    <div className="mx-auto max-w-6xl px-5 pt-16 pb-10 md:pt-24">
      <p className="eyebrow-lab">404 · no signal at this address</p>
      <h1 className="mt-4 text-[38px] leading-[0.98] md:text-[64px]">
        Nothing recorded <span className="hl">here.</span>
      </h1>
      <p className="mt-5 max-w-[56ch] text-[18px] leading-relaxed text-muted">
        The instrument is running — this page just never had an event. A hunt link from an older
        deploy may have expired; recorded runs live on the home page.
      </p>

      <div className="plate mt-10 overflow-hidden px-4 py-6" aria-hidden="true">
        <svg viewBox="0 0 1000 120" className="block h-[120px] w-full" preserveAspectRatio="none">
          <path d={`M${flat}`} fill="none" stroke="rgba(237,230,214,.55)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          <path d="M0 60H1000" stroke="rgba(237,230,214,.12)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/" className="cta-accent px-5 py-3 text-[15.5px] font-semibold">
          Open the live app <span aria-hidden="true">→</span>
        </Link>
        <a href="/about" className="btn-quiet border border-line px-5 py-3 text-[15.5px] font-semibold text-text">
          The story
        </a>
        <a href="/pitch" className="btn-quiet border border-line px-5 py-3 text-[15.5px] font-semibold text-text">
          Pitch deck
        </a>
      </div>
    </div>
  );
}
