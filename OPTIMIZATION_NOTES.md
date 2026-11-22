# Optimization notes for uploaded 22 November 2026 source

This is an incremental source patch, **not a production deployment**. No repository or Cloudflare settings were modified remotely.

## Implemented

1. **Readable editorial UI**: Increased summary/source/metadata text sizes; improved card grouping, hover/focus feedback, search controls and narrow-screen touch targets; unified donate button color with the brand; moved About navigation into the introductory section to reduce mobile header crowding. Existing CSS, components, and language handling are otherwise preserved.
2. **Cloudflare deployment completeness**: Both Pages builds now include the existing `/support/` static pages and both pairs of payment Functions (`/api/create-order`, `/api/verify-payment`, `/api/support/*`). The generated Pages routing manifest includes these paths.
3. **Workers-compatible payment signatures**: Replaced Node-specific `Buffer` and `node:crypto` in included payment Functions with browser/Workers `btoa()` and Web Crypto HMAC verification. Added security regression tests for tampered signatures and order credentials.
4. **Static security headers**: Added `_headers` with `nosniff`, `Referrer-Policy`, `X-Frame-Options` and restrictive `Permissions-Policy`; the deployment workflow now copies it into each project. These static-file headers do not automatically apply to dynamic Functions.
5. **Tests**: Existing and added Python/JS unit tests passed in the local environment. Static mobile browser rendering verified at 390px without horizontal overflow. No real Razorpay payment or remote Cloudflare deployment was performed.

## Before release (manual verification)

- Run Python and Node tests in GitHub Actions; run Cloudflare Pages preview deployments before publishing.
- Check that Pages Functions bind correctly and `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are configured as secrets; use Razorpay *test* credentials and end-to-end tests before live payments. A valid HMAC verifies the checkout signature; it **does not independently establish settlement or capture**. Confirm payment status server-to-server before granting entitlements.
- **Fix D1 configuration**: `counter-wrangler.jsonc` and `translation-wrangler.jsonc` still refer to different database IDs under the name `newsaggregator-views`. Confirm the intended production database IDs in Cloudflare rather than guessing.
- **Consolidate SEO**: Both Pages hostnames have self-canonical URLs. Choose a preferred production hostname; redirect the other only after confirming the backup/migration plan.
- **Improve original editorial value**: `editorials.json` is currently empty, and the 112 snapshot groups are individual stories. Add independently reviewed analysis with primary-source links; mass paraphrases do not guarantee search traffic.
- **Multilingual crawlability**: Non-English static prerenders still show English source headlines until translated content loads. Improve localized server-side rendering or explicitly label originals; avoid presenting untranslated stories as fully translated.
- Test mobile widths 320/375/390/430/768px, keyboard interaction, contrast, full navigation, payment flows, and production Core Web Vitals.
- Consider adding licensed relevant story imagery and a unique social preview after confirming image rights. This patch deliberately did not copy publisher imagery.

## Verification commands

```bash
python -m unittest discover -s tests -q
node --test tests/*.test.mjs
python scripts/prerender.py data/feeds.json /tmp/news-preview/index.html
python scripts/build_locales.py /tmp/news-preview --base-url https://goodthingstoknowtoday.pages.dev
```

For the last two commands, copy `index.html` to `/tmp/news-preview` first.
