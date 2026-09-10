# Contributing

Thanks for your interest in Faultline.

## Getting started

```bash
npm install
cp .env.example .env.local     # optional — the app runs without any of it
npm run dev
```

Everything except dispatching a live hunt works with **no credentials at all**: the landing
page, the recorded example, the integration report and the whole test suite. Nebius
credentials are needed only to run a real hunt.

## Before opening a PR

```bash
npm run ci     # lint, typecheck, tests with coverage, production audit
npm run e2e    # Playwright, desktop and mobile
```

- Add or update tests for any behavior change.
- Commit messages follow Angular convention: `feat:`, `fix:`, `perf:`, `docs:`, `chore:`,
  `test:`, `refactor:`, `ci:`.

## The one rule that matters most here

**Never put an unmeasured number on a judged surface.** No wall-clock, cost or throughput
figure enters the README, the UI, `DEMO.md` or the submission until it has come out of a real
run. Where a number is not yet measured it is *absent*, not estimated — `scripts/bench.py`
refuses to write a results file if no hunt completed, and stamps `SIMULATED: true` on anything
produced against the stub. Please keep it that way.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include repro steps, expected vs. actual behavior, and
whether Nebius credentials were configured — the app behaves deliberately differently without
them, and that is usually the first thing worth knowing.
