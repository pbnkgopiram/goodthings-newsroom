import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_feeds
from fetch_feeds import clean_excerpt, group_entries, parse_feed


class FeedParsingTests(unittest.TestCase):
    def test_summarizes_only_explicitly_licensed_same_host_article_text(self):
        sentences = [
            f"Research finding {index} explains how the study measured important biological changes across carefully selected samples."
            for index in range(12)
        ]
        page = f"<html><nav>Navigation should not appear.</nav><article><h1>Research</h1>{''.join(f'<p>{sentence}</p>' for sentence in sentences)}</article></html>"
        response = io.BytesIO(page.encode("utf-8"))
        source = {
            "url": "https://journal.example/feed",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "full_text_summary": True,
        }
        with patch.object(fetch_feeds.urllib.request, "build_opener") as build_opener:
            build_opener.return_value.open.return_value.__enter__.return_value = response
            summary, error = fetch_feeds.fetch_licensed_article_summary(
                "https://journal.example/article/1",
                source,
                "Research finding",
            )

        self.assertIsNone(error)
        self.assertTrue(summary)
        self.assertLess(len(summary), len(" ".join(sentences)))
        self.assertNotIn("Navigation should not appear", summary)

    def test_does_not_fetch_full_text_from_a_different_host(self):
        source = {
            "url": "https://journal.example/feed",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "full_text_summary": True,
        }
        with patch.object(fetch_feeds.urllib.request, "build_opener") as build_opener:
            summary, error = fetch_feeds.fetch_licensed_article_summary(
                "https://other.example/article/1",
                source,
                "Story",
            )

        self.assertEqual(summary, "")
        self.assertIn("publisher host", error)
        build_opener.assert_not_called()

    def test_merges_reviewed_editorial_content_by_story_url(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            editorials_path = Path(temporary_directory) / "editorials.json"
            editorials_path.write_text(json.dumps({"stories": [{
                "url": "https://news.example/story",
                "whyItMatters": "This matters for readers.",
                "keyFacts": ["A verified fact."],
                "whatToWatch": "The next hearing.",
                "author": "A. Reporter",
                "reviewedAt": "2026-11-22",
            }]}), encoding="utf-8")
            result = {
                "entries": [{"url": "https://news.example/story", "title": "Story"}],
                "groups": [{"url": "https://news.example/story", "title": "Story"}],
            }
            with patch.object(fetch_feeds, "EDITORIALS_PATH", editorials_path):
                merged = fetch_feeds.merge_editorial_content(result)

        self.assertEqual(merged["entries"][0]["editorial"]["whyItMatters"], "This matters for readers.")
        self.assertEqual(merged["groups"][0]["editorial"]["keyFacts"], ["A verified fact."])

    def test_parses_rss_and_sanitizes_excerpt(self):
        xml = b"""<rss version='2.0'><channel><item>
          <title>A <b>clear</b> headline</title>
          <link>https://news.example/story</link>
          <description><![CDATA[<p>A useful <em>short</em> summary &amp; context.</p>]]></description>
          <pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate>
        </item></channel></rss>"""
        entries = parse_feed(xml, {"name": "Example", "url": "https://news.example/feed", "category": "News"})
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "A clear headline")
        self.assertEqual(entries[0]["excerpt"], "A useful short summary & context.")
        self.assertEqual(entries[0]["category"], "News")
        self.assertTrue(entries[0]["publishedAt"].startswith("2026-11-14T10:00:00"))

    def test_parses_atom_links_and_rejects_non_web_urls(self):
        xml = b"""<feed xmlns='http://www.w3.org/2005/Atom'><entry>
          <title>Research note</title><link href='/notes/1'/><updated>2026-11-14T10:00:00Z</updated>
          <summary>New research.</summary></entry><entry><title>Unsafe</title>
          <link href='javascript:alert(1)'/></entry></feed>"""
        entries = parse_feed(xml, {"name": "Lab", "url": "https://lab.example/feed"})
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["url"], "https://lab.example/notes/1")
        self.assertEqual(entries[0]["excerpt"], "New research.")

    def test_extracts_rss_authors_for_attribution(self):
        xml = b"""<rss><channel><item>
          <title>Research note</title><link>https://news.example/story</link>
          <author>researcher@example.org (A. Researcher)</author>
        </item></channel></rss>"""
        entries = parse_feed(xml, {"name": "Example", "url": "https://news.example/feed"})

        self.assertEqual(entries[0]["authors"], ["A. Researcher"])

    def test_long_licensed_summary_does_not_repeat_the_author_byline(self):
        xml = b"""<rss><channel><item>
          <title>Research note</title><link>https://news.example/story</link>
          <author>Ada Lovelace</author><author>Alan Turing</author>
          <content><![CDATA[<p>by Ada Lovelace, Alan Turing</p><p>A useful abstract.</p>]]></content>
        </item></channel></rss>"""
        entries = parse_feed(xml, {
            "name": "Licensed journal",
            "url": "https://news.example/feed",
            "max_excerpt_length": 1200,
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
        })

        self.assertEqual(entries[0]["authors"], ["Ada Lovelace", "Alan Turing"])
        self.assertEqual(entries[0]["excerpt"], "A useful abstract.")

    def test_excerpt_has_a_hard_limit(self):
        excerpt = clean_excerpt("<p>" + ("useful words " * 80) + "</p>", 40)
        self.assertLessEqual(len(excerpt), 40)
        self.assertTrue(excerpt.endswith("…"))

    def test_source_max_items_caps_feed_entries(self):
        xml = b"""<rss><channel>
          <item><title>One</title><link>https://news.example/1</link></item>
          <item><title>Two</title><link>https://news.example/2</link></item>
          <item><title>Three</title><link>https://news.example/3</link></item>
        </channel></rss>"""
        source = {"name": "Example", "url": "https://news.example/feed", "category": "Life Science", "max_items": 2}
        with patch.object(fetch_feeds.urllib.request, "urlopen", return_value=io.BytesIO(xml)):
            entries, error = fetch_feeds.fetch_source(source)

        self.assertIsNone(error)
        self.assertEqual([entry["title"] for entry in entries], ["One", "Two"])

    def test_long_feed_summaries_require_a_bounded_limit_and_keep_license_link(self):
        long_text = "A research summary with useful detail. " * 20
        xml = f"""<rss><channel><item>
          <title>Research note</title><link>https://news.example/story</link>
          <description>{long_text}</description>
        </item></channel></rss>""".encode()
        license_url = "https://creativecommons.org/licenses/by/4.0/"
        source = {
            "name": "Licensed journal",
            "url": "https://news.example/feed",
            "max_excerpt_length": 400,
            "license_url": license_url,
        }
        with patch.object(fetch_feeds.urllib.request, "urlopen", return_value=io.BytesIO(xml)):
            entries, error = fetch_feeds.fetch_source(source)

        self.assertIsNone(error)
        self.assertGreater(len(entries[0]["excerpt"]), fetch_feeds.MAX_EXCERPT_LENGTH)
        self.assertLessEqual(len(entries[0]["excerpt"]), 400)
        self.assertEqual(entries[0]["licenseUrl"], license_url)

    def test_invalid_source_max_items_is_reported(self):
        entries, error = fetch_feeds.fetch_source({
            "name": "Example",
            "url": "https://news.example/feed",
            "max_items": 0,
        })

        self.assertEqual(entries, [])
        self.assertIn("max_items", error)

    def test_unbounded_long_summary_limit_is_reported(self):
        entries, error = fetch_feeds.fetch_source({
            "name": "Example",
            "url": "https://news.example/feed",
            "max_excerpt_length": fetch_feeds.MAX_CONFIGURED_EXCERPT_LENGTH + 1,
        })

        self.assertEqual(entries, [])
        self.assertIn("max_excerpt_length", error)

    def test_long_summary_without_license_is_rejected(self):
        entries, error = fetch_feeds.fetch_source({
            "name": "Example",
            "url": "https://news.example/feed",
            "max_excerpt_length": 400,
        })

        self.assertEqual(entries, [])
        self.assertIn("license_url", error)

    def test_full_text_summary_requires_a_license(self):
        entries, error = fetch_feeds.fetch_source({
            "name": "Example",
            "url": "https://news.example/feed",
            "full_text_summary": True,
        })

        self.assertEqual(entries, [])
        self.assertIn("license_url", error)

    def test_removes_hacker_news_metadata_from_excerpt(self):
        excerpt = clean_excerpt('Yes, i really hate "dict[str, ANY]" Comments URL: https://news.ycombinator.com/item?id=50504072 Points: 28 # Comments: 9')
        self.assertEqual(excerpt, 'Yes, i really hate "dict[str, ANY]"')
        self.assertEqual(clean_excerpt('Article URL: https://github.com/Tthanh2k6/turbo-browser-mcp Comments URL: https://news.ycombinator.com/item?id=50503930 Points: 14 # Comments: 0'), '')

    def test_removes_markdown_source_link_from_excerpt(self):
        excerpt = clean_excerpt('It is the latest development in a months-long challenge to the president\'s plans for East Potomac Golf Links. Source: [BBC World](https://www.bbc.co.uk/news/articles/c6j9mn7l14y0o?at_medium=RSS&at_campaign=rss)')
        self.assertEqual(excerpt, "It is the latest development in a months-long challenge to the president's plans for East Potomac Golf Links.")

    def test_groups_strong_cross_source_coverage_and_keeps_attributions(self):
        entries = [
          {"title": "City council approves new clean water plan", "url": "https://one.example/story", "excerpt": "Council approved the clean water plan.", "publishedAt": "2026-11-15T10:00:00+00:00", "source": "Source One", "category": "World"},
          {"title": "New clean water plan approved by city council", "url": "https://two.example/story", "excerpt": "The city council approved a clean water plan.", "publishedAt": "2026-11-15T11:00:00+00:00", "source": "Source Two", "category": "World"},
        ]
        groups = group_entries(entries)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["url"], "https://two.example/story")
        self.assertEqual(len(groups[0]["sources"]), 2)
        self.assertIn("Source One", {item["source"] for item in groups[0]["sources"]})
        self.assertIn("Source Two", {item["source"] for item in groups[0]["sources"]})
        combined_summary = " ".join([groups[0]["summary"], *(item["excerpt"] for item in groups[0]["additionalCoverage"])])
        self.assertIn("Council approved", combined_summary)
        self.assertIn("The city council approved", combined_summary)

    def test_builds_source_synthesis_for_more_than_three_matching_sources(self):
        entries = [
            {
                "title": "City council approves clean water plan",
                "url": f"https://source{index}.example/story",
                "excerpt": f"Source {index} reports a verified detail about the city council clean water plan.",
                "publishedAt": f"2026-11-15T{10 + index:02d}:00:00+00:00",
                "source": f"Source {index}",
                "category": "World",
            }
            for index in range(5)
        ]

        groups = group_entries(entries)

        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]["sources"]), 5)
        self.assertEqual(len(groups[0]["sourceSynthesis"]), 5)
        self.assertEqual(
            {item["source"] for item in groups[0]["sourceSynthesis"]},
            {f"Source {index}" for index in range(5)},
        )

    def test_does_not_group_same_source_old_or_different_category(self):
        base = {"title": "City council approves new clean water plan", "url": "https://one.example/story", "excerpt": "Council approved the clean water plan.", "publishedAt": "2026-11-15T10:00:00+00:00", "source": "Source One", "category": "World"}
        same_source = {**base, "url": "https://one.example/another", "title": "New clean water plan approved by city council"}
        old_story = {**base, "url": "https://two.example/old", "title": "New clean water plan approved by city council", "source": "Source Two", "publishedAt": "2026-11-10T10:00:00+00:00"}
        other_category = {**base, "url": "https://two.example/tech", "title": "New clean water plan approved by city council", "source": "Source Two", "category": "Technology"}
        self.assertEqual(len(group_entries([base, same_source])), 2)
        self.assertEqual(len(group_entries([base, old_story])), 2)
        self.assertEqual(len(group_entries([base, other_category])), 2)

    def test_all_sources_failing_preserves_last_good_digest(self):
      with tempfile.TemporaryDirectory() as temporary_directory:
        sources_path = Path(temporary_directory) / "sources.json"
        output_path = Path(temporary_directory) / "feeds.json"
        sources_path.write_text(json.dumps([{"name": "Offline", "url": "https://example.com/feed"}]), encoding="utf-8")
        output_path.write_text("last-good-digest", encoding="utf-8")
        with patch.object(fetch_feeds, "SOURCES_PATH", sources_path), patch.object(fetch_feeds, "OUTPUT_PATH", output_path), patch.object(fetch_feeds, "fetch_source", return_value=([], "offline")):
          self.assertEqual(fetch_feeds.main(), 1)
        self.assertEqual(output_path.read_text(encoding="utf-8"), "last-good-digest")


if __name__ == "__main__":
    unittest.main()