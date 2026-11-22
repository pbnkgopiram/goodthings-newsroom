# Good things to know today

Good things to know today is a source-linked reading brief. It refreshes a set of public RSS and Atom feeds, keeps headlines and short excerpts in a static JSON file, and sends readers to the original publisher for the full story.

It uses Python's standard library and static HTML/CSS/JavaScript. There are no paid APIs, API keys, build services, or server runtime requirements.

## Run locally

You need Python 3.10 or newer. From the project root:

```powershell
python -m unittest discover -s tests -v
python scripts/fetch_feeds.py
python -m http.server 8000
```

Open `http://localhost:8000`. The feed refresh needs outbound internet access. If a feed is unavailable, the collector records the failure and continues with the remaining feeds.

## Configure sources

Edit `sources.json`. Each entry has a display name, an RSS/Atom URL, and a category. Optional `max_items` can cap a feed's contribution (from 1 to 24). Set `max_excerpt_length` above the 360-character default only for a feed with an explicit reuse license, and provide its `license_url`; the collector rejects longer excerpts without a license link.

```json
{
  "name": "Example publication",
  "url": "https://example.com/feed.xml",
  "category": "Science",
  "max_items": 12
}
```

Use feeds published by the source itself, check its terms and reuse policy, and keep the source attribution intact. For ordinary feeds, Good things to know today displays a title and a short excerpt; readers follow a link to read the full article at its original home. Do not remove paywalls, republish full articles, or assume a feed grants permission to reuse copyrighted images or text. If a publisher asks you to stop using its feed, remove it.

The Life Science category collects up to five recent entries each from PLOS Biology and eLife. Their feeds are configured with CC BY 4.0 licensing and same-publisher full-text summarization. The collector extracts article text from those licensed publisher pages, selects a few salient sentences as an automated extractive summary, and displays the license and source links. If extraction fails, the feed excerpt is shown instead. Other feeds retain the 360-character excerpt limit and are never fetched for full-text summaries. Check the current article and publisher reuse terms before deployment.

For human-authored reporting, add reviewed editorial material to `editorials.json`. The feed collector matches entries by exact story URL and attaches the briefing to both the homepage digest and static prerender. Use only verified, original editorial text; never present RSS summaries or AI-generated speculation as reporting.

```json
{
  "stories": [
    {
      "url": "https://publisher.example/story",
      "whyItMatters": "A reviewed explanation of the story's significance.",
      "keyFacts": ["A verified fact.", "Another verified fact."],
      "whatToWatch": "The next decision or milestone.",
      "author": "Editorial desk",
      "reviewedAt": "2026-11-22"
    }
  ]
}
```

The separate Lifestyle category collects up to five recent entries each from BBC Health, NPR Health, and The Guardian Life & Style.

During each feed refresh, the collector conservatively groups cross-publisher entries with strong headline overlap, the same category, and publication times within 48 hours. Groups can include more than three unique publishers. A grouped card displays an automated, source-attributed overview drawn from available feed excerpts and licensed full-text summaries, with a link for each cited source. This extractive overview is not a human-written personal view and does not imply that all sources agree; add and attribute your own reviewed analysis in `editorials.json` for a genuine editorial perspective.

The collector limits each response to 2 MB, each source to 24 entries, ordinary excerpts to 360 characters, licensed excerpts to at most 1,600 characters, and the full digest to 160 entries. It only accepts HTTP(S) story links.

## Search engine discovery

Each live Pages hostname publishes its own canonical URL, `robots.txt`, and `sitemap.xml`. The homepage metadata and structured data describe the site's English-language global news and research brief. To request indexing:

1. Sign in to [Google Search Console](https://search.google.com/search-console/) and add a **URL prefix** property for the hostname you want to monitor.
2. Verify ownership for that property. `google622a2fa14a1f2982.html` is deployed at the root of both sites and must remain there. If Search Console supplies a different verification token for the second hostname, add that file to both deployment bundles and the workflow.
3. Submit that hostname's `/sitemap.xml` in Search Console and use **URL inspection** to request indexing of the homepage, locale routes, and a translated story URL after the initial indexer run.
4. Add the hostname to [Bing Webmaster Tools](https://www.bing.com/webmasters/) and submit the same sitemap.

The deployment pre-renders one source-linked story per available category into the homepage HTML. JavaScript then loads the full digest and enables search and filters; if that request fails, the pre-rendered category-balanced stories remain available.

The deployment publishes `/en/`, `/ta/`, `/hi/`, `/te/`, `/ml/`, `/kn/`, `/bn/`, `/es/`, `/fr/`, and `/de/`. Each route has localized page text and metadata, a self-referencing canonical, and alternate-language links. `/` remains a language-aware entry point: it uses the saved language cookie when present, otherwise the browser's first supported language, and defaults to English. The sitemap lists the locale homepages and every indexed, translated story page. Story pages contain only the source headline and short feed summary, preserve source names and links, and point readers to the original publisher for full articles. Indexing and rankings are not immediate or guaranteed. Search engines may take days or longer to crawl a new site. A feed aggregator should add original summaries, analysis, or other editorial value; simply republishing headlines and excerpts may not rank well and can be insufficient for monetization approval.

Homepage search ranks matches across the loaded digest, translated and English headlines/summaries, categories, and publishers. Category tabs are exclusive; source filters can be combined. The Lifestyle tab appears first after Everything. The default Everything view shows the newest story from each available category, with Lifestyle first; searches and explicit sort orders retain their regular five-story cap. The interface supports date ranges, keyboard-accessible suggestions, and shareable URL state; query/filter URLs are marked `noindex`. Category tabs display at most five stories. Search runs locally without a request per keystroke. Recent searches are stored only on the current device after the reader opts in, and can be cleared or disabled at any time. The current search covers the loaded digest rather than a complete historical archive.

## Configure indexed multilingual translations

The UI dictionaries live in `locales.json`. A scheduled Cloudflare Worker pre-translates source headlines and short feed summaries, then stores them in D1 by article, language, and content version. Pages Functions read only those stored translations; they do not call the translation provider at visitor request time. The same D1 records power localized story pages and the dynamic `sitemap.xml`. Full third-party articles are never fetched or translated. Until a translation is indexed, the site keeps the original English headline and summary. The indexer defaults to at most 100 new story-language translations per UTC day; the initial backfill can take several days.

Before enabling translations:

1. The deployment workflow applies `translation-schema.sql` idempotently before publishing. To initialize it manually, run `npx wrangler@4 d1 execute newsaggregator-views --remote --file=translation-schema.sql --config=translation-wrangler.jsonc`. This creates the article index and daily translation-cap tables alongside the existing translation table.
2. In **Workers & Pages → each Pages project → Settings → Bindings**, add a D1 binding named `TRANSLATION_DB` and select `newsaggregator-views`. Bind the same database to both Pages projects so localized story pages and the sitemap share the index.
3. The `goodthings-translation-indexer` Worker uses the Cloudflare Workers AI binding with the `@cf/meta/m2m100-1.2b` translation model. Wrangler configures the `AI` binding at deploy time; no external translation endpoint or provider API key is required. The scheduled job runs six-hourly and observes `TRANSLATION_DAILY_ITEM_QUOTA` (default `100`).
4. Ensure the GitHub Actions Cloudflare token can edit Pages, Workers Scripts, and D1, then push the workflow changes to `main` or run **Refresh and deploy Good things to know today** from GitHub Actions. The workflow deploys the Pages Functions and scheduled indexer.

Existing cached translations are reused, and the daily cap limits Workers AI usage during the initial backfill and later updates.

## Configure donations

Edit `site-config.js` before deployment. For UPI, set your public UPI ID and payee name; the site creates a standard UPI payment link that opens a compatible app on phones. A phone number by itself is not a reliable web payment address, and publishing it exposes your number. Prefer a UPI ID or a hosted HTTPS payment page. The donation setting is public website content, so only put a payment address you intend visitors to see there. Payment providers may charge transaction fees.

The file starts with empty values:

```js
window.GOODTHINGS_CONFIG = {
  donationUrl: "",
  upiId: "",
  payeeName: "",
  razorpayKeyId: ""
};
```

Fill `upiId` and `payeeName` for UPI, or set `donationUrl` to an HTTPS checkout page. The button remains hidden while both destinations are empty.

For a hosted payment page, set `donationUrl` to its HTTPS URL and leave `upiId` empty. The donation button stays hidden until a valid destination is configured.

## Support page and Razorpay donations

The site now includes a `/support/` page for one-time contributions. The page collects an amount, optional name/email, and opens Razorpay Checkout after the browser calls the Cloudflare Pages Function `/api/support/create-order`.

The backend verifies the payment signature through `/api/support/verify` before redirecting to a success page. This keeps the secret key off client-side assets and prevents a fake client-side success from unlocking anything.

Set the following environment variables in Cloudflare Pages or a local `.env` file before testing:

```bash
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

The repository includes `.env.example` with the required placeholders.

## Page-view counter

The header displays persistent total page views and today's views in UTC. The counter uses the `newsaggregator-counter` Cloudflare Worker and the `newsaggregator-views` D1 database. Each page load increments the figures; these are page views, not unique people. Cloudflare's Workers Free plan currently includes D1 usage suitable for a small counter, subject to daily quotas.

## Publish for free with Cloudflare Pages

The sites are live at <https://goodthingstoknowtoday.pages.dev> and <https://newsaggregator-gopi.pages.dev>. Each deployment has its own canonical URL, sitemap, and robots directive. The previous <https://fieldnotes-erg.pages.dev> deployment also remains active as a backup.

The project is in the public GitHub repository [pbnkgopiram/newsaggregator](https://github.com/pbnkgopiram/newsaggregator). GitHub Actions refreshes the RSS feeds every six hours, then deploys updated assets to both Pages projects.

The workflow requires the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. They are configured in **Settings → Secrets and variables → Actions**. The API token needs **Cloudflare Pages: Edit**, **Workers Scripts: Edit**, and **D1: Edit** access on the account containing both Pages projects and the translation database. Keep the token private and never put it in project files. Scheduled runs can be delayed by GitHub during busy periods.

The feed collector groups only cross-publisher headlines with strong title overlap, matching category, and publication times within 48 hours. It preserves every publisher link and excerpt. If no stories meet those strict criteria, the site displays individual briefings rather than merging unrelated coverage. Grouped source excerpts are attributed reporting, not original independent reporting.

Cloudflare Pages and GitHub Actions can both be used without charge within their current free-tier quotas. A custom domain and domain registration may cost money. Free service policies and quotas can change, so check the current terms before relying on them for a business.

## Earning revenue

Publishing a site does not automatically produce income. Advertising networks such as AdSense review sites and may require original editorial value, privacy disclosures, policy compliance, and sufficient content before approving ads. Affiliate programs also require separate approval and clear disclosures near qualifying links. Add any required privacy, cookie, advertising, and affiliate disclosures before monetizing. Revenue is not guaranteed, and meaningful earnings usually require sustained readership and ongoing editorial work.

Do not present aggregated headlines as your own reporting. Keep source names and links visible, verify feed licensing and attribution terms, and curate the site with original commentary or useful context rather than relying solely on copied snippets.