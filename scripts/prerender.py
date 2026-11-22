#!/usr/bin/env python3
"""Render a small source-linked story batch into the static homepage HTML."""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

PRERENDER_LIMIT = 12
STORIES_START = "<!-- PRERENDERED_STORIES_START -->"
STORIES_END = "<!-- PRERENDERED_STORIES_END -->"
LIFESTYLE_CATEGORY = "Lifestyle"
STORY_LIST_OPEN = '<div class="story-list" id="story-list" aria-live="polite" aria-busy="true">'


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_url(value: Any) -> str:
    candidate = _text(value)
    if not candidate:
        return ""
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return ""
    return candidate if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _parse_date(value: Any) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _story_sources(story: dict[str, Any]) -> list[dict[str, Any]]:
    raw_sources = story.get("sources")
    if not isinstance(raw_sources, list):
        return []
    sources = []
    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            continue
        url = _safe_url(raw_source.get("url") or raw_source.get("link"))
        if not url:
            continue
        source = dict(raw_source)
        source["url"] = url
        source["source"] = _text(source.get("source") or source.get("name")) or "Original source"
        authors = source.get("authors")
        source["authors"] = [
            author.strip()[:120]
            for author in authors
            if isinstance(author, str) and author.strip()
        ][:30] if isinstance(authors, list) else []
        source["licenseUrl"] = _safe_url(source.get("licenseUrl")) or ""
        sources.append(source)
    return sources


def _normalized_stories(data: dict[str, Any]) -> list[dict[str, Any]]:
    groups = data.get("groups")
    stories: list[dict[str, Any]] = []
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, dict):
                continue
            sources = _story_sources(group)
            if not sources:
                continue
            story = dict(group)
            story["sources"] = sources
            story["url"] = _safe_url(group.get("url") or group.get("link")) or sources[0]["url"]
            stories.append(story)
    else:
        entries = data.get("entries")
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                url = _safe_url(entry.get("url") or entry.get("link"))
                if not url:
                    continue
                title = _text(entry.get("title")) or "Untitled story"
                excerpt = _text(entry.get("excerpt"))
                source = _text(entry.get("source") or entry.get("name")) or "Original source"
                stories.append({
                    "title": title,
                    "url": url,
                    "category": entry.get("category"),
                    "publishedAt": entry.get("publishedAt"),
                    "summary": excerpt,
                    "sources": [{
                        "source": source,
                        "url": url,
                        "title": title,
                        "excerpt": excerpt,
                        "authors": entry.get("authors", []),
                        "licenseUrl": entry.get("licenseUrl", ""),
                    }],
                    "additionalCoverage": [],
                })

    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    stories.sort(key=lambda story: _parse_date(story.get("publishedAt")) or epoch, reverse=True)
    lifestyle_index = next(
        (index for index, story in enumerate(stories) if _text(story.get("category")) == LIFESTYLE_CATEGORY),
        None,
    )
    if lifestyle_index is not None:
        stories.insert(0, stories.pop(lifestyle_index))
    return stories


def _one_per_category(stories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen_categories: set[str] = set()
    selected: list[dict[str, Any]] = []
    for story in stories:
        category = _text(story.get("category")) or "General"
        if category in seen_categories:
            continue
        seen_categories.add(category)
        selected.append(story)
    return selected


def _teaser_lines(story: dict[str, Any]) -> list[str]:
    raw = _text(story.get("summary") or story.get("excerpt") or story.get("title"))
    cleaned = re.sub(r"https?://\S+", "", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).replace("\u2018", "").replace("\u2019", "").replace("\u201c", "").replace("\u201d", "").strip()
    if not cleaned:
        return []
    words = cleaned.split()
    if len(words) <= 10:
        return [cleaned]
    chunk_count = min(10, max(2, math.ceil(len(words) / 12)))
    chunk_size = math.ceil(len(words) / chunk_count)
    return [" ".join(words[index:index + chunk_size]) for index in range(0, len(words), chunk_size)][:10]


def _source_synthesis_markup(story: dict[str, Any]) -> list[str]:
    synthesis = story.get("sourceSynthesis")
    if not isinstance(synthesis, list):
        return []
    items = [
        item for item in synthesis
        if isinstance(item, dict) and _text(item.get("text"))
    ]
    if len(items) < 2:
        return []

    parts = [
        '    <aside class="source-synthesis" aria-label="The story across sources">',
        '      <span class="editorial-label">The story, across sources</span>',
        '      <p class="source-synthesis-note">Key details highlighted by each publisher; accounts may differ.</p>',
        "      <ul>",
    ]
    for item in items:
        source_name = _text(item.get("source")) or "Original source"
        source_url = _safe_url(item.get("url"))
        if source_url:
            source_markup = (
                f'<a class="source-synthesis-source" href="{html.escape(source_url, quote=True)}" '
                f'target="_blank" rel="noopener noreferrer">{html.escape(source_name)}</a>'
            )
        else:
            source_markup = f'<strong class="source-synthesis-source">{html.escape(source_name)}</strong>'
        parts.append(f'        <li>{source_markup}: {html.escape(_text(item.get("text")))}</li>')
    parts.extend(["      </ul>", "    </aside>"])
    return parts


def _editorial_markup(story: dict[str, Any]) -> list[str]:
    editorial = story.get("editorial")
    if not isinstance(editorial, dict):
        return []
    why = _text(editorial.get("whyItMatters"))
    key_facts = editorial.get("keyFacts")
    what_next = _text(editorial.get("whatToWatch"))
    author = _text(editorial.get("author"))
    reviewed_at = _text(editorial.get("reviewedAt"))
    if not why and not (isinstance(key_facts, list) and key_facts) and not what_next:
        return []

    parts = [
        '    <aside class="editorial-brief" aria-label="Editorial briefing">',
        '      <span class="editorial-label">Editorial briefing</span>',
    ]
    if why:
        parts.append(f'      <p><strong>Why it matters: </strong>{html.escape(why)}</p>')
    if isinstance(key_facts, list):
        facts = [_text(fact) for fact in key_facts if isinstance(fact, (str,)) and _text(fact)]
        if facts:
            parts.append("      <p><strong>Key facts</strong></p>")
            parts.append('      <ul class="editorial-facts">')
            parts.extend(f"        <li>{html.escape(fact)}</li>" for fact in facts[:8])
            parts.append("      </ul>")
    if what_next:
        parts.append(f'      <p><strong>What to watch: </strong>{html.escape(what_next)}</p>')
    if author or reviewed_at:
        byline = " · ".join([
            f"Reviewed by {author}" if author else "",
            f"Reviewed {reviewed_at}" if reviewed_at else "",
        ]).replace(" ·  · ", " · ")
        parts.append(f'      <p class="editorial-byline">{html.escape(byline)}</p>')
    parts.append("    </aside>")
    return parts


def _render_story(story: dict[str, Any], index: int) -> str:
    escape = html.escape
    category = _text(story.get("category")) or "General"
    title = _text(story.get("title")) or "Untitled story"
    story_url = _safe_url(story.get("url") or story.get("link"))
    published = _parse_date(story.get("publishedAt"))
    date_text = published.strftime("%b %d").upper().replace(" 0", " ") if published else "DATE UNKNOWN"
    datetime_attr = f' datetime="{escape(published.isoformat(timespec="seconds"), quote=True)}"' if published else ""
    parts = [
        f'<article class="story-card" style="animation-delay: {min(index, 8) * 35}ms">',
        '  <div class="story-meta">',
        f'    <span class="story-category">{escape(category)}</span>',
        f'    <time class="story-date"{datetime_attr}>{date_text}</time>',
        "  </div>",
        '  <div class="story-body">',
        '    <h3 class="story-title">',
        f'      <a href="{escape(story_url, quote=True)}" target="_blank" rel="noopener noreferrer">{escape(title)}</a>',
        "    </h3>",
    ]

    sources = _story_sources(story)
    summary = _text(story.get("summary"))
    full_text_summary = _text(story.get("fullTextSummary"))
    has_licensed_summary = any(source.get("licenseUrl") for source in sources)
    if full_text_summary and has_licensed_summary:
        parts.extend([
            '    <aside class="full-text-summary">',
            '      <span class="editorial-label">Full article summary</span>',
            f'      <p>{escape(full_text_summary)}</p>',
            "    </aside>",
        ])
    elif has_licensed_summary and summary:
        parts.append(f'    <p class="story-excerpt story-long-summary">{escape(summary)}</p>')
    else:
        teaser_lines = _teaser_lines(story)
        if teaser_lines:
            parts.append('    <div class="story-summary">')
            parts.extend(f'      <span class="story-summary-line">{escape(line)}</span>' for line in teaser_lines)
            parts.append("    </div>")

    source_synthesis = _source_synthesis_markup(story)
    parts.extend(source_synthesis)
    parts.extend(_editorial_markup(story))

    coverage = story.get("additionalCoverage")
    if not source_synthesis and isinstance(coverage, list):
        for item in coverage:
            if not isinstance(item, dict):
                continue
            additional_excerpt = _text(item.get("excerpt"))
            if not additional_excerpt:
                continue
            source_name = _text(item.get("source") or item.get("name")) or "Another source"
            parts.append(
                '    <p class="story-excerpt additional-coverage">'
                f'<strong>Also reported by {escape(source_name)}: </strong>{escape(additional_excerpt)}</p>'
            )

    parts.append(f'    <div class="story-source"><span>{"Coverage:" if len(sources) > 1 else "Source:"}</span>')
    authors = [author for source in sources for author in source.get("authors", []) if isinstance(author, str) and author.strip()]
    if authors:
        parts.append(f'      <span class="story-authors">Authors: {escape(", ".join(authors))}</span>')
    for source_index, source in enumerate(sources):
        if source_index:
            parts.append('<span class="source-dot"></span>')
        if source.get("licenseUrl"):
            parts.append(
                f'<a class="read-link" href="{escape(source["licenseUrl"], quote=True)}" '
                f'target="_blank" rel="noopener noreferrer">CC BY 4.0</a>'
            )
        source_name = _text(source.get("source") or source.get("name")) or "Original source"
        parts.append(
            f'<a class="read-link" href="{escape(source["url"], quote=True)}" '
            f'target="_blank" rel="noopener noreferrer">{escape(source_name)} ↗</a>'
        )
    parts.extend(["    </div>", "  </div>", "</article>"])
    return "\n".join(parts)


def render_page(template: str, data: dict[str, Any], limit: int = PRERENDER_LIMIT) -> str:
    if not isinstance(data, dict):
        raise ValueError("Feed data must be a JSON object")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError("Prerender limit must be at least one")
    stories = _normalized_stories(data)
    if not stories:
        raise ValueError("Feed data contains no stories with safe source links")
    visible_stories = _one_per_category(stories)[:limit]
    if template.count(STORIES_START) != 1 or template.count(STORIES_END) != 1:
        raise ValueError("Homepage must contain exactly one prerender marker pair")
    if template.count(STORY_LIST_OPEN) != 1:
        raise ValueError("Homepage must contain exactly one story-list container")

    story_markup = "\n".join(_render_story(story, index) for index, story in enumerate(visible_stories))
    marker_block = re.compile(re.escape(STORIES_START) + r".*?" + re.escape(STORIES_END), re.DOTALL)
    if marker_block.search(template) is None:
        raise ValueError("Homepage prerender markers are out of order")
    rendered = marker_block.sub(lambda _: story_markup, template, count=1)
    rendered = _replace_once(rendered, STORY_LIST_OPEN, STORY_LIST_OPEN.replace('aria-busy="true"', 'aria-busy="false"'), "story-list container")
    rendered = _replace_once(
        rendered,
        '<span class="story-count" id="story-count">— stories</span>',
        f'<span class="story-count" id="story-count">{len(visible_stories)} {"story" if len(visible_stories) == 1 else "stories"}</span>',
        "story count",
    )
    rendered = _replace_once(
        rendered,
        '<span class="category-count" data-count="all">0</span>',
        f'<span class="category-count" data-count="all">{len(visible_stories)}</span>',
        "total category count",
    )

    generated = _parse_date(data.get("generatedAt"))
    issue_number = f"{generated.day:02d}" if generated else "01"
    updated = f"UPDATED {generated.strftime('%H:%M UTC')}" if generated else "LATEST EDITION"
    rendered = _replace_once(rendered, '<span id="issue-number">01</span>', f'<span id="issue-number">{issue_number}</span>', "issue number")
    return _replace_once(
        rendered,
        '<span class="stamp-bottom" id="updated-at">UPDATING…</span>',
        f'<span class="stamp-bottom" id="updated-at">{html.escape(updated)}</span>',
        "update timestamp",
    )


def _replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"Homepage must contain exactly one {label} placeholder")
    return source.replace(old, new, 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feed_data", type=Path)
    parser.add_argument("html_file", type=Path)
    args = parser.parse_args(argv)

    try:
        data = json.loads(args.feed_data.read_text(encoding="utf-8"))
        template = args.html_file.read_text(encoding="utf-8")
        rendered = render_page(template, data)
        story_count = len(_normalized_stories(data))
        args.html_file.write_text(rendered, encoding="utf-8")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Could not prerender homepage: {error}", file=sys.stderr)
        return 1

    visible_count = min(PRERENDER_LIMIT, len(_one_per_category(_normalized_stories(data))))
    print(f"Pre-rendered {visible_count} category-balanced previews of {story_count} stories.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
