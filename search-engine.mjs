let storyIndexes = new WeakMap();
const segmenters = new Map();
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
export const MAX_STORIES_PER_TAB = 5;
const ENGLISH_SYNONYMS = new Map([
  ["ai", [["artificial", "intelligence"]]],
  ["artificial intelligence", [["ai"]]],
]);

function normalized(value, locale) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase(locale)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function segmenterFor(locale) {
  if (!("Segmenter" in Intl)) return null;
  if (!segmenters.has(locale)) {
    try {
      segmenters.set(locale, new Intl.Segmenter(locale, { granularity: "word" }));
    } catch {
      segmenters.set(locale, new Intl.Segmenter("en", { granularity: "word" }));
    }
  }
  return segmenters.get(locale);
}

export function tokenize(value, locale = "en") {
  const text = normalized(value, locale);
  if (!text) return [];
  const segmenter = segmenterFor(locale);
  if (segmenter) {
    return [...segmenter.segment(text)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  }
  return text.match(WORD_PATTERN) || [];
}

function storyFields(story, locale) {
  const cached = storyIndexes.get(story);
  if (cached?.locale === locale) return cached;

  const originalTitle = story.originalTitle || story.englishTitle || "";
  const originalSummary = story.originalSummary || story.englishSummary || "";
  const sources = Array.isArray(story.sources) ? story.sources : [];
  const sourceNames = sources.map((source) => source.source || source.name || "");
  const sourceText = sources.flatMap((source) => [
    source.title || "",
    source.excerpt || "",
  ]);
  const commonFields = [
    { value: story.category || "", weight: 2 },
    { value: story.localizedCategory || "", weight: 2 },
    ...sourceNames.map((value) => ({ value, weight: 2 })),
    ...sourceText.map((value) => ({ value, weight: 1 })),
  ];
  const currentFields = [
    { value: story.title || "", weight: 7 },
    { value: story.summary || story.excerpt || "", weight: 4 },
  ];
  const originalFields = [
    { value: originalTitle, weight: 6 },
    { value: originalSummary, weight: 3 },
  ];
  const fields = (values) => values
    .filter((field) => field.value)
    .map((field) => ({
      ...field,
      normalized: normalized(field.value, locale),
      tokens: tokenize(field.value, locale),
    }));

  const index = {
    locale,
    current: fields([...currentFields, ...commonFields]),
    english: fields([...originalFields, ...commonFields]),
    all: fields([...currentFields, ...originalFields, ...commonFields]),
  };
  storyIndexes.set(story, index);
  return index;
}

function editDistanceAtMostOne(first, second) {
  if (Math.abs(first.length - second.length) > 1) return false;
  if (first.length === second.length) {
    const differences = [];
    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) differences.push(index);
    }
    if (differences.length <= 1) return true;
    const [left, right] = differences;
    return right === left + 1
      && first[left] === second[right]
      && first[right] === second[left];
  }

  let firstIndex = 0;
  let secondIndex = 0;
  let differences = 0;
  while (firstIndex < first.length && secondIndex < second.length) {
    if (first[firstIndex] === second[secondIndex]) {
      firstIndex += 1;
      secondIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (first.length > second.length) firstIndex += 1;
    else if (second.length > first.length) secondIndex += 1;
    else {
      firstIndex += 1;
      secondIndex += 1;
    }
  }
  return differences + (firstIndex < first.length || secondIndex < second.length ? 1 : 0) <= 1;
}

function tokenMatch(queryToken, fieldTokens) {
  let best = 0;
  for (const fieldToken of fieldTokens) {
    if (fieldToken === queryToken) best = Math.max(best, 1);
    else if (fieldToken.startsWith(queryToken)) best = Math.max(best, 0.75);
    else if (queryToken.length >= 5 && editDistanceAtMostOne(queryToken, fieldToken)) {
      best = Math.max(best, 0.55);
    }
    if (best === 1) break;
  }
  return best;
}

function queryGroups(queryTokens, locale) {
  const groups = [];
  for (let index = 0; index < queryTokens.length; index += 1) {
    const phrase = queryTokens.slice(index, index + 2).join(" ");
    const phraseAlternatives = locale.startsWith("en") ? ENGLISH_SYNONYMS.get(phrase) : null;
    if (phraseAlternatives) {
      groups.push([[...queryTokens.slice(index, index + 2)], ...phraseAlternatives]);
      index += 1;
      continue;
    }

    const alternatives = locale.startsWith("en") ? ENGLISH_SYNONYMS.get(queryTokens[index]) : null;
    groups.push([[queryTokens[index]], ...(alternatives || [])]);
  }
  return groups;
}

export function scoreStory(story, query, { locale = "en", language = "all" } = {}) {
  const queryTokens = tokenize(query, locale);
  if (!queryTokens.length) return 0;

  const index = storyFields(story, locale);
  const fields = language === "en" ? index.english : language === "current" ? index.current : index.all;
  let score = 0;
  for (const alternatives of queryGroups(queryTokens, locale)) {
    let best = 0;
    for (const alternative of alternatives) {
      let alternativeScore = 0;
      let matches = true;
      for (const queryToken of alternative) {
        let tokenScore = 0;
        for (const field of fields) {
          tokenScore = Math.max(tokenScore, field.weight * tokenMatch(queryToken, field.tokens));
        }
        if (!tokenScore) {
          matches = false;
          break;
        }
        alternativeScore += tokenScore;
      }
      if (matches) {
        const averageScore = alternativeScore / alternative.length;
        best = Math.max(best, averageScore * (alternative.length > 1 ? 0.8 : 1));
      }
    }
    if (!best) return null;
    score += best;
  }

  const phrase = normalized(query, locale);
  if (queryTokens.length > 1 && fields.some((field) => field.normalized.includes(phrase))) score += 5;
  return score;
}

function selected(values, value) {
  return values instanceof Set ? values.has(value) : Array.isArray(values) && values.includes(value);
}

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isValidDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && dayKey(new Date(`${value}T00:00:00`)) === value;
}

function dateBounds({ dateRange, from, to, now = new Date() }) {
  if (dateRange === "today") return { from: dayKey(now), to: dayKey(now) };
  if (dateRange === "week" || dateRange === "month") {
    const days = dateRange === "week" ? 6 : 29;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    return { from: dayKey(start), to: dayKey(now) };
  }
  if (dateRange === "custom") {
    return {
      from: isValidDay(from) ? from : "",
      to: isValidDay(to) ? to : "",
    };
  }
  return { from: "", to: "" };
}

function storyDay(story) {
  const date = new Date(story.publishedAt || "");
  return Number.isNaN(date.getTime()) ? "" : dayKey(date);
}

export function searchStories(stories, query, options = {}) {
  const {
    locale = "en",
    language = "all",
    categories = new Set(),
    sources = new Set(),
    dateRange = "any",
    from = "",
    to = "",
    now = new Date(),
    sort = "relevance",
  } = options;
  const categorySelection = categories instanceof Set ? categories : new Set(categories || []);
  const sourceSelection = sources instanceof Set ? sources : new Set(sources || []);
  const bounds = dateBounds({ dateRange, from, to, now });
  const queryText = String(query || "").trim();

  const matches = [];
  for (const story of stories) {
    if (categorySelection.size && !selected(categorySelection, story.category)) continue;
    const storySources = Array.isArray(story.sources) ? story.sources : [];
    if (sourceSelection.size && !storySources.some((source) => selected(sourceSelection, source.source || source.name))) continue;
    const publishedDay = storyDay(story);
    if ((bounds.from && (!publishedDay || publishedDay < bounds.from))
      || (bounds.to && (!publishedDay || publishedDay > bounds.to))) continue;

    const score = scoreStory(story, queryText, { locale, language });
    if (score === null) continue;
    matches.push({ story, score, timestamp: new Date(story.publishedAt || "").getTime() || 0 });
  }

  matches.sort((first, second) => {
    if (queryText && sort === "relevance" && first.score !== second.score) return second.score - first.score;
    if (!queryText && sort === "relevance" && categorySelection.size === 0) {
      const firstIsLifestyle = first.story.category === "Lifestyle";
      const secondIsLifestyle = second.story.category === "Lifestyle";
      if (firstIsLifestyle !== secondIsLifestyle) return firstIsLifestyle ? -1 : 1;
    }
    const direction = sort === "oldest" ? 1 : -1;
    if (first.timestamp !== second.timestamp) return direction * (first.timestamp - second.timestamp);
    return String(first.story.title || "").localeCompare(String(second.story.title || ""), locale);
  });
  return matches;
}

export function limitStories(matches, limit = MAX_STORIES_PER_TAB) {
  return matches.slice(0, limit);
}

export function onePerCategory(matches) {
  const seenCategories = new Set();
  return matches.filter(({ story }) => {
    const category = story.category || "General";
    if (seenCategories.has(category)) return false;
    seenCategories.add(category);
    return true;
  });
}

export function highlightRanges(value, query, locale = "en") {
  const text = String(value || "");
  const queryTokens = new Set(tokenize(query, locale));
  if (!text || !queryTokens.size) return [];

  const segments = segmenterFor(locale);
  const ranges = [];
  if (segments) {
    for (const part of segments.segment(text)) {
      if (!part.isWordLike) continue;
      const token = normalized(part.segment, locale);
      if ([...queryTokens].some((queryToken) => token === queryToken || token.startsWith(queryToken))) {
        ranges.push([part.index, part.index + part.segment.length]);
      }
    }
  } else {
    for (const match of text.matchAll(WORD_PATTERN)) {
      const token = normalized(match[0], locale);
      if ([...queryTokens].some((queryToken) => token === queryToken || token.startsWith(queryToken))) {
        ranges.push([match.index, match.index + match[0].length]);
      }
    }
  }
  return ranges;
}

export function clearSearchIndex() {
  storyIndexes = new WeakMap();
}
