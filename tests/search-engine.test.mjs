import assert from "node:assert/strict";
import test from "node:test";
import { highlightRanges, limitStories, onePerCategory, searchStories, tokenize } from "../search-engine.mjs";

const stories = [
  {
    id: "climate-title",
    title: "Climate policy changes",
    originalTitle: "Climate policy changes",
    summary: "Governments discuss new rules.",
    category: "World",
    publishedAt: "2026-03-10T12:00:00Z",
    sources: [{ source: "Global News" }],
  },
  {
    id: "climate-summary",
    title: "A new energy agreement",
    originalTitle: "A new energy agreement",
    summary: "Climate policy will shape the agreement.",
    category: "Business",
    publishedAt: "2026-03-09T12:00:00Z",
    sources: [{ source: "Market Journal" }],
  },
  {
    id: "science",
    title: "New science discovery",
    originalTitle: "New science discovery",
    summary: "Researchers report a result.",
    category: "Science",
    publishedAt: "2026-03-08T12:00:00Z",
    sources: [{ source: "Global News" }],
  },
];

test("search ranks title and exact phrase matches above summary-only matches", () => {
  const results = searchStories(stories, "climate policy", {
    locale: "en",
    now: new Date("2026-03-10T15:00:00Z"),
  });

  assert.deepEqual(results.map(({ story }) => story.id), ["climate-title", "climate-summary"]);
});

test("search supports prefix and one-character typo matches without dropping multi-term requirements", () => {
  const prefix = searchStories(stories, "clim pol", { locale: "en" });
  const typo = searchStories(stories, "clmiate", { locale: "en" });
  const incomplete = searchStories(stories, "climate missing", { locale: "en" });

  assert.deepEqual(prefix.map(({ story }) => story.id), ["climate-title", "climate-summary"]);
  assert.deepEqual(typo.map(({ story }) => story.id), ["climate-title", "climate-summary"]);
  assert.deepEqual(incomplete, []);
});

test("search combines category, publisher, and inclusive date filters", () => {
  const results = searchStories(stories, "", {
    categories: new Set(["World", "Business"]),
    sources: new Set(["Global News"]),
    dateRange: "custom",
    from: "2026-03-10",
    to: "2026-03-10",
  });

  assert.deepEqual(results.map(({ story }) => story.id), ["climate-title"]);
});

test("chronological sorting compares dates across categories", () => {
  const results = searchStories(stories, "", { sort: "newest" });
  assert.deepEqual(results.map(({ story }) => story.id), ["climate-title", "climate-summary", "science"]);
});

test("the Everything default pins the newest Lifestyle story first", () => {
  const mixedStories = [
    { id: "new-world", title: "World news", category: "World", publishedAt: "2026-03-10T12:00:00Z", sources: [] },
    { id: "lifestyle", title: "Lifestyle news", category: "Lifestyle", publishedAt: "2026-03-08T12:00:00Z", sources: [] },
    { id: "older-world", title: "Earlier world news", category: "World", publishedAt: "2026-03-07T12:00:00Z", sources: [] },
  ];

  const defaultResults = searchStories(mixedStories, "");
  const defaultVisible = onePerCategory(defaultResults);
  const newestResults = searchStories(mixedStories, "", { sort: "newest" });

  assert.deepEqual(defaultResults.map(({ story }) => story.id), ["lifestyle", "new-world", "older-world"]);
  assert.deepEqual(defaultVisible.map(({ story }) => story.id), ["lifestyle", "new-world"]);
  assert.deepEqual(newestResults.map(({ story }) => story.id), ["new-world", "lifestyle", "older-world"]);
});

test("the display limit keeps only the first five results across all categories", () => {
  const matches = Array.from({ length: 14 }, (_, index) => ({
    story: {
      id: String(index),
      category: index % 2 ? "Science" : "World",
    },
  }));
  const limited = limitStories(matches);

  assert.equal(limited.length, 5);
  assert.deepEqual(limited.map(({ story }) => story.id), ["0", "1", "2", "3", "4"]);
});

test("array filter values work and malicious text is never interpreted as a pattern", () => {
  const arrayFiltered = searchStories(stories, "", {
    categories: ["World"],
    sources: ["Global News"],
  });
  assert.deepEqual(arrayFiltered.map(({ story }) => story.id), ["climate-title"]);

  const ranges = highlightRanges("literal (text) [x]", ".*[", "en");
  assert.deepEqual(ranges, []);
});

test("multilingual fields match the active locale and English originals", () => {
  const story = {
    title: "Économie mondiale",
    summary: "Une évolution importante.",
    originalTitle: "Global economy",
    originalSummary: "An important development.",
    category: "Business",
    sources: [],
  };

  assert.equal(searchStories([story], "économie", { locale: "fr", language: "current" }).length, 1);
  assert.equal(searchStories([story], "economy", { locale: "en", language: "en" }).length, 1);
  assert.equal(searchStories([story], "économie", { locale: "fr", language: "en" }).length, 0);
});

test("the small English alias set matches AI with its expanded term", () => {
  const story = {
    title: "Artificial intelligence policy",
    originalTitle: "Artificial intelligence policy",
    summary: "",
    category: "Technology",
    sources: [],
  };

  assert.equal(searchStories([story], "AI policy", { locale: "en" }).length, 1);
});

test("Unicode tokenization and highlight ranges preserve visible source text", () => {
  assert.ok(tokenize("தமிழ் செய்திகள்", "ta").length > 0);

  const ranges = highlightRanges("Climate policy changes", "clim pol", "en");
  assert.deepEqual(ranges, [[0, 7], [8, 14]]);
});
