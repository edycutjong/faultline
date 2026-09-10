# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| latest (`main`) | ✅ |

## Reporting a vulnerability

Please **do not** open a public issue. Report privately:

- Email **edy.cu@live.com**, or
- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability).

You will get an acknowledgment within 48 hours and a timeline after triage.

## Known open advisories, and why they are open

`npm audit --omit=dev` reports **two** advisories, one moderate and one high. Both are inside
`next`, and both are fixable only by upgrading to `next@16` — a major-version framework
migration.

This project must stay live and working for judges through **2026-12-15**. A major framework
bump applied unattended to a submitted project is a realistic way to take the demo down, which
is a larger risk than the advisories themselves: neither is reachable in this application's
request path (the PostCSS issues concern build-time CSS stringification and source-map reads of
attacker-supplied CSS; Faultline compiles no user-supplied CSS). The project is already on the
latest 15.x patch, `15.5.25`.

So the audit step in CI is **advisory rather than blocking**, and the reason is written here
instead of being hidden behind a green check. Dependabot is configured to ignore major bumps
for the same reason, while security alerts stay enabled.

## How secrets are handled

- Credentials live in `~/.config/faultline/` and in the deploy platform's environment. Nothing
  secret is ever written into this tree — `.gitignore` covers `.env` and `.env.*`, and
  `.env.example` carries placeholders only.
- The service-account private key is generated locally by `scripts/provision.sh`, which prints
  the environment block and never writes a secret to disk itself.
- Two scanners run on every push: **TruffleHog** (verified secrets, full history) in the CI
  pipeline, and **gitleaks** with `fetch-depth: 0` in its own workflow. gitleaks is there
  because GitHub's built-in scanning only matches known provider patterns and would not flag a
  project-shaped name like `NEBIUS_AUTH_PRIVATE_KEY`.
- Object Storage access keys are a separate credential from the authorized key used for the
  IAM token exchange, so the S3 channel and the Jobs API can be revoked independently.
