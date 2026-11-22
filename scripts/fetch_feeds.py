#!/usr/bin/env python3
"""Fetch public RSS/Atom feeds and write a compact, source-linked JSON digest."""

from __future__ import annotations

import email.utils
import hashlib
import html
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCES_PATH = ROOT / "sources.json"
OUTPUT_PATH = ROOT / "data" / "feeds.json"
EDITORIALS_PATH = ROOT / "editorials.json"
USER_AGENT = "GoodThingsToKnowTodayFeedCollector/1.0 (+https://github.com/)"
MAX_RESPONSE_BYTES = 2_000_000
MAX_ARTICLE_TEXT_LENGTH = 100_000
MAX_ITEMS_PER_SOURCE = 24
MAX_EXCERPT_LENGTH = 360
MAX_CONFIGURED_EXCERPT_LENGTH = 1600
MAX_TOTAL_ENTRIES = 160
MAX_GROUP_AGE_HOURS = 48
TITLE_STOP_WORDS = {
    "about", "after", "amid", "and", "are", "around", "been", "before", "being", "but",
    "for", "from", "have", "into", "its", "more", "new", "over", "said", "says", "than",
    "that", "the", "their", "them", "there", "they", "this", "under", "with", "will",
}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


class _ArticleTextExtractor(HTMLParser):
    BLOCK_TAGS = {"article", "main", "p", "div", "section", "li", "h1", "h2", "h3", "blockquote"}
    SKIP_TAGS = {"script", "style", "nav", "footer", "aside", "noscript", "svg", "form"}
    ARTICLE_MARKERS = {"article-body", "article-content", "article-text", "arttext", "story-body", "main-content"}
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.content_depth = 0
        self.content_tags: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").lower().split())
        element_id = (attributes.get("id") or "").lower()
        is_content = tag in {"article", "main"} or attributes.get("role") == "main"
        is_content = is_content or bool(classes.intersection(self.ARTICLE_MARKERS))
        is_content = is_content or element_id in self.ARTICLE_MARKERS

        if self.skip_depth or tag in self.SKIP_TAGS or "hidden" in attributes:
            if tag not in self.VOID_TAGS:
                self.skip_depth += 1
            return
        if is_content:
            self.content_depth += 1
            self.content_tags.append(tag)
        if self.content_depth and tag in self.BLOCK_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.content_tags:
            self.content_tags.remove(tag)
            self.content_depth = max(0, self.content_depth - 1)
        if self.content_depth and tag in self.BLOCK_TAGS:
            self.parts.append(" ")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.content_depth and not self.skip_depth:
            self.parts.append(data)


class _SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_host: str) -> None:
        super().__init__()
        self.allowed_host = allowed_host

    def redirect_request(self, request: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, new_url: str) -> urllib.request.Request | None:
        destination = urllib.parse.urlparse(urllib.parse.urljoin(request.full_url, new_url))
        if destination.scheme not in {"http", "https"} or destination.hostname != self.allowed_host:
            raise urllib.error.URLError("Article redirect left the licensed publisher host")
        return super().redirect_request(request, fp, code, msg, headers, new_url)


def clean_excerpt(value: str, limit: int = MAX_EXCERPT_LENGTH) -> str:
    extractor = _TextExtractor()
    try:
        extractor.feed(value)
        extractor.close()
        text = " ".join(extractor.parts)
    except Exception:
        text = value
    text = html.unescape(text)
    text = re.sub(r"(?is)\b(?:Article URL|Comments URL)\s*:?\s*(?:https?://\S+)?", " ", text)
    text = re.sub(r"(?is)\bSource\s*:\s*\[[^\]]+\]\([^)]*\)", " ", text)
    text = re.sub(r"(?is)\bSource\s*:\s*https?://\S+", " ", text)
    text = re.sub(r"(?is)\bPoints\s*:\s*\d+\s*", " ", text)
    text = re.sub(r"(?is)#\s*Comments\s*:\s*\d+\s*", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if len(text) > limit:
        return text[: limit - 1].rsplit(" ", 1)[0].rstrip(".,;:") + "…"
    return text


def summarize_article_text(value: str, title: str, limit: int = 900) -> str:
    sentences = [
        re.sub(r"\s+", " ", sentence).strip()
        for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", value)
    ]
    sentences = [sentence for sentence in sentences if 8 <= len(sentence.split()) <= 70]
    if not sentences:
        return clean_excerpt(value, limit)

    title_terms = {
        word.casefold()
        for word in re.findall(r"[A-Za-z0-9]{3,}", title)
        if word.casefold() not in TITLE_STOP_WORDS
    }
    frequencies: dict[str, int] = {}
    tokenized: list[list[str]] = []
    for sentence in sentences:
        words = [
            word.casefold()
            for word in re.findall(r"[A-Za-z0-9]{3,}", sentence)
            if word.casefold() not in TITLE_STOP_WORDS
        ]
        tokenized.append(words)
        for word in set(words):
            frequencies[word] = frequencies.get(word, 0) + 1

    scored = []
    for index, (sentence, words) in enumerate(zip(sentences, tokenized)):
        if not words:
            continue
        score = sum(math.log1p(frequencies[word]) + (1.5 if word in title_terms else 0) for word in words) / math.sqrt(len(words))
        scored.append((score, index, sentence))
    selected: list[tuple[int, str]] = []
    total_length = 0
    for _, index, sentence in sorted(scored, reverse=True):
        extra_length = len(sentence) + (1 if selected else 0)
        if total_length + extra_length > limit:
            continue
        selected.append((index, sentence))
        total_length += extra_length
        if len(selected) == 5:
            break
    if not selected:
        return clean_excerpt(sentences[0], limit)
    return " ".join(sentence for _, sentence in sorted(selected))


def build_source_synthesis(entries: list[dict[str, Any]], title: str) -> list[dict[str, str]]:
    synthesis: list[dict[str, str]] = []
    seen_text: set[str] = set()
    for entry in entries:
        content = entry.get("fullTextSummary") or entry.get("excerpt") or ""
        if not isinstance(content, str) or not content.strip():
            continue
        summary = summarize_article_text(content, title, limit=240)
        normalized = re.sub(r"\W+", " ", summary.casefold()).strip()
        if not summary or normalized in seen_text:
            continue
        seen_text.add(normalized)
        synthesis.append({
            "source": entry.get("source", "Original source"),
            "url": entry.get("url", ""),
            "text": summary,
        })
    return synthesis


def fetch_licensed_article_summary(url: str, source: dict[str, Any], title: str) -> tuple[str, str | None]:
    if not source.get("full_text_summary"):
        return "", None
    if not source.get("license_url"):
        return "", "Full-text summaries require an explicit license_url"
    feed_host = urllib.parse.urlparse(_safe_http_url(source.get("url", ""))).hostname
    article_url = _safe_http_url(url)
    article_host = urllib.parse.urlparse(article_url).hostname
    if not feed_host or article_host != feed_host:
        return "", "Article URL is not on the configured publisher host"

    request = urllib.request.Request(
        article_url,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9"},
    )
    opener = urllib.request.build_opener(_SameHostRedirectHandler(feed_host))
    try:
        with opener.open(request, timeout=18) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            return "", "Article response exceeded the 2 MB limit"
        extractor = _ArticleTextExtractor()
        extractor.feed(payload.decode("utf-8", errors="replace"))
        extractor.close()
        article_text = clean_excerpt(" ".join(extractor.parts), MAX_ARTICLE_TEXT_LENGTH)
        if len(article_text.split()) < 80:
            return "", "Could not extract enough licensed article text for a summary"
        return summarize_article_text(article_text, title), None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return "", f"{type(error).__name__}: {error}"


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(element: ET.Element, *names: str) -> str:
    wanted = {name.lower() for name in names}
    for child in element.iter():
        if child is element or _local_name(child.tag) not in wanted:
            continue
        value = "".join(child.itertext()).strip()
        if value:
            return value
    return ""


def _entry_link(element: ET.Element) -> str:
    for child in element:
        if _local_name(child.tag) != "link":
            continue
        href = child.attrib.get("href", "").strip()
        rel = child.attrib.get("rel", "alternate")
        candidate = href if href and rel == "alternate" else (child.text or "").strip()
        if candidate:
            return candidate
    return ""


def _entry_authors(element: ET.Element) -> list[str]:
    authors: list[str] = []
    for child in element:
        if _local_name(child.tag) not in {"author", "creator"}:
            continue
        value = _child_text(child, "name") or "".join(child.itertext()).strip()
        email_with_name = re.fullmatch(r"[^()]*\(([^()]+)\)", value)
        if email_with_name:
            value = email_with_name.group(1).strip()
        value = clean_excerpt(value, 120)
        if value and value not in authors:
            authors.append(value)
    return authors


def _safe_http_url(value: str, base: str = "") -> str:
    resolved = urllib.parse.urljoin(base, value.strip()) if base else value.strip()
    parsed = urllib.parse.urlparse(resolved)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return resolved


def _iso_date(value: str) -> str | None:
    if not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _title_tokens(title: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", title.lower())
        if len(token) > 2 and token not in TITLE_STOP_WORDS
    }


def _can_group(first: dict[str, Any], second: dict[str, Any]) -> bool:
    if first["source"] == second["source"] or first["category"] != second["category"]:
        return False
    first_date = _iso_date(first.get("publishedAt") or "")
    second_date = _iso_date(second.get("publishedAt") or "")
    if first_date and second_date:
        gap = abs((datetime.fromisoformat(first_date) - datetime.fromisoformat(second_date)).total_seconds())
        if gap > MAX_GROUP_AGE_HOURS * 3600:
            return False

    first_tokens = _title_tokens(first["title"])
    second_tokens = _title_tokens(second["title"])
    shared = first_tokens & second_tokens
    smaller_title_size = min(len(first_tokens), len(second_tokens))
    return smaller_title_size >= 3 and len(shared) >= 3 and len(shared) / smaller_title_size >= 0.6


def group_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[list[dict[str, Any]]] = []
    for entry in sorted(entries, key=lambda item: item.get("publishedAt") or "", reverse=True):
        matching_cluster = next(
            (
                cluster
                for cluster in clusters
                if all(existing["source"] != entry["source"] for existing in cluster)
                and any(_can_group(existing, entry) for existing in cluster)
            ),
            None,
        )
        if matching_cluster is None:
            clusters.append([entry])
        else:
            matching_cluster.append(entry)

    groups: list[dict[str, Any]] = []
    for cluster in clusters:
        lead = max(cluster, key=lambda item: item.get("publishedAt") or "")
        excerpts: list[str] = []
        for item in cluster:
            if item.get("excerpt") and item["excerpt"] not in excerpts:
                excerpts.append(item["excerpt"])
        group_id = hashlib.sha1(lead["url"].encode("utf-8")).hexdigest()[:12]
        groups.append(
            {
                "id": group_id,
                "title": lead["title"],
                "url": lead.get("url", ""),
                "category": lead["category"],
                "publishedAt": lead.get("publishedAt"),
                "summary": lead.get("excerpt", ""),
                **({"fullTextSummary": lead["fullTextSummary"]} if lead.get("fullTextSummary") else {}),
                **(
                    {"sourceSynthesis": build_source_synthesis(cluster, lead["title"])}
                    if len(cluster) > 1
                    else {}
                ),
                "additionalCoverage": [
                    {
                        "source": item["source"],
                        "url": item["url"],
                        "excerpt": item["excerpt"],
                    }
                    for item in cluster
                    if item is not lead and item.get("excerpt") and item["excerpt"] not in {lead.get("excerpt", "")}
                ],
                "sources": cluster,
            }
        )
    return groups


def parse_feed(xml_bytes: bytes, source: dict[str, Any], limit: int = MAX_ITEMS_PER_SOURCE) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_bytes)
    root_name = _local_name(root.tag)
    if root_name == "rss":
        channel = next((child for child in root if _local_name(child.tag) == "channel"), root)
        elements = [child for child in channel if _local_name(child.tag) == "item"]
    elif root_name == "feed":
        elements = [child for child in root if _local_name(child.tag) == "entry"]
    else:
        elements = [child for child in root.iter() if _local_name(child.tag) in {"item", "entry"}]

    entries: list[dict[str, Any]] = []
    for element in elements[:limit]:
        url = _safe_http_url(_entry_link(element), source["url"])
        title = _child_text(element, "title")
        if not url or not title:
            continue
        excerpt = _child_text(element, "description", "summary", "encoded", "content")
        published = _child_text(element, "pubdate", "published", "updated", "date")
        excerpt_limit = source.get("max_excerpt_length", MAX_EXCERPT_LENGTH)
        authors = _entry_authors(element)
        excerpt_text = clean_excerpt(excerpt, excerpt_limit)
        author_byline = f"by {', '.join(authors)}"
        if authors and excerpt_text.casefold().startswith(author_byline.casefold()):
            excerpt_text = excerpt_text[len(author_byline):].lstrip(" ,.:;-")
        entry = {
            "title": clean_excerpt(title, 240),
            "url": url,
            "excerpt": excerpt_text,
            "publishedAt": _iso_date(published),
            "source": source["name"],
            "category": source.get("category", "General"),
        }
        license_url = _safe_http_url(source.get("license_url", ""))
        if license_url:
            entry["licenseUrl"] = license_url
        if authors:
            entry["authors"] = authors
        entries.append(entry)
    return entries


def fetch_source(source: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    url = _safe_http_url(source.get("url", ""))
    if not url:
        return [], "Feed URL must use HTTP or HTTPS"
    limit = source.get("max_items", MAX_ITEMS_PER_SOURCE)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_ITEMS_PER_SOURCE:
        return [], f"Source max_items must be an integer from 1 to {MAX_ITEMS_PER_SOURCE}"
    excerpt_limit = source.get("max_excerpt_length", MAX_EXCERPT_LENGTH)
    if not isinstance(excerpt_limit, int) or isinstance(excerpt_limit, bool) or not MAX_EXCERPT_LENGTH <= excerpt_limit <= MAX_CONFIGURED_EXCERPT_LENGTH:
        return [], f"Source max_excerpt_length must be an integer from {MAX_EXCERPT_LENGTH} to {MAX_CONFIGURED_EXCERPT_LENGTH}"
    license_url = source.get("license_url", "")
    if license_url and (not isinstance(license_url, str) or not _safe_http_url(license_url)):
        return [], "Source license_url must use HTTP or HTTPS"
    if "full_text_summary" in source and not isinstance(source["full_text_summary"], bool):
        return [], "Source full_text_summary must be a boolean"
    if source.get("full_text_summary") and not license_url:
        return [], "Full-text summaries require an explicit license_url"
    if excerpt_limit > MAX_EXCERPT_LENGTH and not license_url:
        return [], "Long source excerpts require a license_url"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5"})
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            return [], "Feed response exceeded the 2 MB limit"
        entries = parse_feed(payload, source, limit=limit)
        if source.get("full_text_summary"):
            for entry in entries:
                summary, summary_error = fetch_licensed_article_summary(entry["url"], source, entry["title"])
                if summary:
                    entry["fullTextSummary"] = summary
                elif summary_error:
                    print(f"Could not summarize licensed article {entry['url']}: {summary_error}", file=sys.stderr)
        return entries, None
    except (urllib.error.URLError, TimeoutError, OSError, ET.ParseError, ValueError) as error:
        return [], f"{type(error).__name__}: {error}"


def merge_editorial_content(result: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(EDITORIALS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return result
    except (OSError, json.JSONDecodeError) as error:
        print(f"Could not read editorial content: {error}", file=sys.stderr)
        return result

    stories = payload.get("stories") if isinstance(payload, dict) else None
    if not isinstance(stories, list):
        return result

    editorial_by_url: dict[str, dict[str, Any]] = {}
    for item in stories:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not _safe_http_url(url):
            continue
        key = url.split("#", 1)[0]
        why = item.get("whyItMatters")
        key_facts = item.get("keyFacts")
        what_next = item.get("whatToWatch")
        author = item.get("author")
        reviewed_at = item.get("reviewedAt")
        editorial = {
            "whyItMatters": clean_excerpt(str(why), 600).strip() if isinstance(why, str) and why.strip() else "",
            "keyFacts": [
                clean_excerpt(str(fact), 240).strip()
                for fact in key_facts
                if isinstance(fact, str) and fact.strip()
            ][:8] if isinstance(key_facts, list) else [],
            "whatToWatch": clean_excerpt(str(what_next), 600).strip() if isinstance(what_next, str) and what_next.strip() else "",
            "author": clean_excerpt(str(author), 120).strip() if isinstance(author, str) and author.strip() else "",
            "reviewedAt": clean_excerpt(str(reviewed_at), 40).strip() if isinstance(reviewed_at, str) and reviewed_at.strip() else "",
        }
        if any((editorial["whyItMatters"], editorial["keyFacts"], editorial["whatToWatch"])):
            editorial_by_url[key] = editorial

    for story in result.get("groups", []) if isinstance(result.get("groups"), list) else []:
        if not isinstance(story, dict):
            continue
        url = story.get("url")
        if isinstance(url, str):
            editorial = editorial_by_url.get(url.split("#", 1)[0])
            if editorial:
                story["editorial"] = editorial

    for story in result.get("entries", []) if isinstance(result.get("entries"), list) else []:
        if not isinstance(story, dict):
            continue
        url = story.get("url")
        if isinstance(url, str):
            editorial = editorial_by_url.get(url.split("#", 1)[0])
            if editorial:
                story["editorial"] = editorial

    return result


def collect(sources: list[dict[str, Any]]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    statuses: list[dict[str, Any]] = []
    for source in sources:
        if not source.get("name") or not source.get("url"):
            statuses.append({"name": source.get("name", "Unnamed source"), "ok": False, "error": "Each source needs a name and URL"})
            continue
        found, error = fetch_source(source)
        accepted = 0
        for entry in found:
            normalized_url = entry["url"].split("#", 1)[0]
            if normalized_url in seen_urls:
                continue
            seen_urls.add(normalized_url)
            entries.append(entry)
            accepted += 1
        statuses.append({"name": source["name"], "ok": error is None, "items": accepted, **({"error": error} if error else {})})
        if len(entries) >= MAX_TOTAL_ENTRIES:
            entries = entries[:MAX_TOTAL_ENTRIES]
            break
        time.sleep(0.15)

    entries.sort(key=lambda entry: entry["publishedAt"] or "", reverse=True)
    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": statuses,
        "entries": entries,
        "groups": group_entries(entries),
    }
    return merge_editorial_content(result)


def main() -> int:
    try:
        sources = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
        if not isinstance(sources, list):
            raise ValueError("sources.json must contain a list")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Could not read {SOURCES_PATH}: {error}", file=sys.stderr)
        return 1

    result = collect(sources)
    if result["sources"] and not result["entries"] and all(not source["ok"] for source in result["sources"]):
        print("Every configured feed failed; keeping the previous digest unchanged.", file=sys.stderr)
        return 1
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(not source["ok"] for source in result["sources"])
    print(f"Wrote {len(result['entries'])} stories from {len(result['sources'])} sources ({failed} unavailable).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())