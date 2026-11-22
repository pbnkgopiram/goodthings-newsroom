import unittest

from scripts.prerender import render_page


TEMPLATE = """<html>
<div class="story-list" id="story-list" aria-live="polite" aria-busy="true">
<!-- PRERENDERED_STORIES_START -->
<div class="loading-state">Loading</div>
<!-- PRERENDERED_STORIES_END -->
</div>
<span class="story-count" id="story-count">— stories</span>
<span class="category-count" data-count="all">0</span>
<span id="issue-number">01</span>
<span class="stamp-bottom" id="updated-at">UPDATING…</span>
</html>"""


class PrerenderTests(unittest.TestCase):
    def test_prerenders_the_newest_lifestyle_story_first(self):
        result = render_page(TEMPLATE, {"groups": [
            {
                "title": "Newest world story",
                "url": "https://world.example/story",
                "category": "World",
                "publishedAt": "2026-11-22T13:00:00Z",
                "sources": [{"source": "World News", "url": "https://world.example/story"}],
            },
            {
                "title": "Lifestyle story",
                "url": "https://life.example/story",
                "category": "Lifestyle",
                "publishedAt": "2026-11-20T13:00:00Z",
                "sources": [{"source": "Life News", "url": "https://life.example/story"}],
            },
            {
                "title": "Older world story",
                "url": "https://world.example/older",
                "category": "World",
                "publishedAt": "2026-11-19T13:00:00Z",
                "sources": [{"source": "World News", "url": "https://world.example/older"}],
            },
            {
                "title": "Business story",
                "url": "https://business.example/story",
                "category": "Business",
                "publishedAt": "2026-11-18T13:00:00Z",
                "sources": [{"source": "Business News", "url": "https://business.example/story"}],
            },
        ]})

        self.assertLess(result.index(">Lifestyle story<"), result.index(">Newest world story<"))
        self.assertLess(result.index(">Newest world story<"), result.index(">Business story<"))
        self.assertEqual(result.count('<article class="story-card"'), 3)
        self.assertIn(">3 stories<", result)
        self.assertNotIn(">Older world story<", result)

    def test_renders_attributed_multi_source_summary_without_duplicate_excerpts(self):
        result = render_page(TEMPLATE, {"groups": [{
            "title": "Multi-source story",
            "url": "https://one.example/story",
            "category": "World",
            "summary": "Lead source's short excerpt.",
            "sources": [
                {"source": "Source One", "url": "https://one.example/story"},
                {"source": "Source Two", "url": "https://two.example/story"},
            ],
            "sourceSynthesis": [
                {"source": "Source One", "url": "https://one.example/story", "text": "The council approved its water plan."},
                {"source": "Source Two", "url": "https://two.example/story", "text": "Residents will see construction begin next month."},
            ],
            "additionalCoverage": [
                {"source": "Source Two", "excerpt": "Residents will see construction begin next month."},
            ],
        }]})

        self.assertIn("The story, across sources", result)
        self.assertIn("Source One", result)
        self.assertIn("Source Two", result)
        self.assertEqual(result.count("Residents will see construction begin next month."), 1)

    def test_prefers_licensed_full_text_summary_over_feed_excerpt(self):
        result = render_page(TEMPLATE, {"groups": [{
            "title": "Licensed article",
            "url": "https://journal.example/article",
            "category": "Life Science",
            "summary": "The shorter RSS abstract.",
            "fullTextSummary": "A concise summary based on the full licensed article.",
            "sources": [{
                "source": "Journal",
                "url": "https://journal.example/article",
                "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            }],
        }]})

        self.assertIn("Full article summary", result)
        self.assertIn("A concise summary based on the full licensed article.", result)
        self.assertNotIn("The shorter RSS abstract.", result)

    def test_renders_reviewed_editorial_briefing(self):
        result = render_page(TEMPLATE, {"groups": [{
            "title": "Editorial story",
            "url": "https://news.example/story",
            "category": "World",
            "summary": "A source-linked summary.",
            "sources": [{"source": "Example News", "url": "https://news.example/story"}],
            "editorial": {
                "whyItMatters": "This affects public policy.",
                "keyFacts": ["A verified fact.", "A second verified fact."],
                "whatToWatch": "The next vote.",
                "author": "A. Reporter",
                "reviewedAt": "2026-11-22",
            },
        }]})

        self.assertIn("Editorial briefing", result)
        self.assertIn("Why it matters:", result)
        self.assertIn("A verified fact.", result)
        self.assertIn("Reviewed by A. Reporter", result)

    def test_unlicensed_story_has_one_summary_block(self):
        summary = " ".join(f"word{index}" for index in range(24))
        result = render_page(TEMPLATE, {"groups": [{
            "title": "Single summary story",
            "url": "https://news.example/story",
            "category": "World",
            "summary": summary,
            "excerpt": "A separate short excerpt.",
            "sources": [{"source": "Example News", "url": "https://news.example/story"}],
        }]})

        self.assertEqual(result.count('class="story-summary"'), 1)
        self.assertNotIn('class="story-excerpt"', result)

    def test_limits_unlicensed_teasers_to_ten_lines(self):
        summary = " ".join(f"word{index}" for index in range(120))
        result = render_page(TEMPLATE, {"groups": [{
            "title": "Ten-line story",
            "url": "https://news.example/story",
            "category": "World",
            "summary": summary,
            "sources": [{"source": "Example News", "url": "https://news.example/story"}],
        }]})

        self.assertEqual(result.count('class="story-summary-line"'), 10)

    def test_renders_source_linked_stories_safely_and_respects_limit(self):
        stories = []
        for index in range(3):
            stories.append({
                "title": f"Story {index}",
                "url": f"https://news.example/story-{index}?a=1&b=2",
                "category": ["World", "Business", "Science"][index],
                "publishedAt": f"2026-11-{21 - index:02d}T12:00:00Z",
                "summary": "<script>alert('x')</script> A useful \\1 summary.",
                "sources": [{
                    "source": "Example & News",
                    "url": f"https://news.example/story-{index}?a=1&b=2",
                    "authors": ["A. Researcher"],
                    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
                }],
                "additionalCoverage": [{"source": "Other <News>", "excerpt": "Another useful excerpt."}],
            })

        result = render_page(TEMPLATE, {"generatedAt": "2026-11-21T14:50:00Z", "groups": stories}, limit=2)

        self.assertEqual(result.count('<article class="story-card"'), 2)
        self.assertIn("2 stories", result)
        self.assertIn('aria-busy="false"', result)
        self.assertIn('href="https://news.example/story-0?a=1&amp;b=2"', result)
        self.assertIn("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;", result)
        self.assertIn("Other &lt;News&gt;", result)
        self.assertIn("Authors: A. Researcher", result)
        self.assertIn("CC BY 4.0", result)
        self.assertIn("story-long-summary", result)
        self.assertIn("\\1", result)
        self.assertNotIn("<script>alert('x')</script>", result)
        self.assertNotIn("PRERENDERED_STORIES_START", result)
        self.assertIn("UPDATED 14:50 UTC", result)

    def test_normalizes_entry_only_payloads(self):
        result = render_page(TEMPLATE, {
            "entries": [{
                "title": "Standalone story",
                "url": "https://news.example/story",
                "source": "Example News",
                "category": "Science",
                "excerpt": "A concise source summary.",
                "authors": ["A. Researcher"],
            }]
        })

        self.assertIn("Standalone story", result)
        self.assertIn("Authors: A. Researcher", result)
        self.assertIn("Source:</span>", result)
        self.assertIn("1 story", result)

    def test_rejects_payloads_without_safe_story_links(self):
        with self.assertRaisesRegex(ValueError, "no stories with safe source links"):
            render_page(TEMPLATE, {"groups": [{
                "title": "Unsafe story",
                "url": "javascript:alert(1)",
                "sources": [{"source": "Unsafe", "url": "javascript:alert(1)"}],
            }]})


if __name__ == "__main__":
    unittest.main()
