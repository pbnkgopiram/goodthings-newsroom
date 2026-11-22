import {
  clearSearchIndex,
  highlightRanges,
  limitStories,
  MAX_STORIES_PER_TAB,
  onePerCategory,
  searchStories,
  tokenize,
} from "./search-engine.mjs?v=20261122-category-balance";

const storyList = document.querySelector("#story-list");
const categoryNav = document.querySelector("#category-nav");
const sourceOptions = document.querySelector("#source-options");
const sourceFilterSummary = document.querySelector("#source-filter-summary");
const searchInput = document.querySelector("#search");
const sortOrder = document.querySelector("#sort-order");
const dateRange = document.querySelector("#date-range");
const dateRangeInputs = document.querySelector("#date-range-inputs");
const searchFrom = document.querySelector("#search-from");
const searchTo = document.querySelector("#search-to");
const searchLanguage = document.querySelector("#search-language");
const suggestionsPopover = document.querySelector("#suggestions-popover");
const searchSuggestions = document.querySelector("#search-suggestions");
const searchHistoryEnabled = document.querySelector("#search-history-enabled");
const clearSearchHistoryButton = document.querySelector("#clear-search-history");
const storyCount = document.querySelector("#story-count");
const updatedAt = document.querySelector("#updated-at");
const emptyState = document.querySelector("#empty-state");
const errorState = document.querySelector("#error-state");
const languageSelect = document.querySelector("#language-select");
const translationNotice = document.querySelector("#translation-notice");
const loadingState = storyList.querySelector(".loading-state");
const categoryColors = ["#27725d", "#e27b4f", "#477a93", "#9b6b46", "#bd664c"];
const languagePreferenceKey = "news-aggregator-language";
const searchHistoryKey = "news-aggregator-search-history-v1";
const searchHistoryPreferenceKey = "news-aggregator-search-history-enabled";
const localeCatalogVersion = "20261122-tamil";
let supportedLocales = new Set();
const categoryPriority = {
  Lifestyle: 0,
  World: 1,
  Business: 2,
  Science: 3,
  Technology: 4,
  "Life Science": 5,
};
const fallbackMessages = {
  allCategories: "Everything",
  allSources: "All sources",
  alsoReportedBy: "Also reported by {source}: ",
  categories: { World: "World", Business: "Business", Science: "Science", Technology: "Technology", "Life Science": "Life Science", Lifestyle: "Lifestyle", General: "General" },
  coverageLabel: "Coverage:",
  clearSearchHistory: "Clear history",
  clearAllFilters: "Clear all filters",
  authorsLabel: "Authors:",
  dateAny: "Any date",
  dateCustom: "Custom dates",
  dateMonth: "Last 30 days",
  dateRangeLabel: "Date range",
  dateToday: "Today",
  dateWeek: "Last 7 days",
  dateUnknown: "DATE UNKNOWN",
  donate: "Donate to help us serve you better",
  donateViaUpi: "Donate via UPI",
  emptyDescription: "Try a different search or category.",
  emptyTitle: "No stories in this corner.",
  endDate: "To",
  feedErrorDescription: "There may be a temporary connection issue. Try refreshing in a moment.",
  feedErrorTitle: "The brief hasn’t arrived yet.",
  feedStaleDescription: "Live updates are temporarily unavailable. Try again in a moment.",
  feedStaleTitle: "Showing the latest saved edition.",
  latestEdition: "LATEST EDITION",
  newestFirst: "Newest first",
  oldestFirst: "Oldest first",
  originalSource: "Original source",
  recentSearches: "Recent",
  relevanceFirst: "Most relevant",
  retry: "Try again",
  searchHistoryOptIn: "Save recent searches on this device",
  searchLanguageCurrent: "Current language + English",
  searchLanguageEnglish: "English originals",
  searchLanguageLabel: "Search language",
  searchPlaceholder: "Search the brief",
  startDate: "From",
  sourceLabel: "Source:",
  suggestionCategory: "Category",
  suggestionSource: "Source",
  suggestionStory: "Story",
  storyCountPlural: "{count} stories",
  storyCountSingular: "{count} story",
  storyLinkLabel: "Read the original report from {source}",
  translationFallback: "Some headlines or summaries remain in English because translation is temporarily unavailable.",
  updatedAtTemplate: "UPDATED {time} UTC",
};

let stories = [];
let selectedCategories = new Set();
let selectedSources = new Set();
let availableCategories = new Set();
let availableSources = new Set();
let storiesLoaded = false;
let localeCatalog = null;
let messages = fallbackMessages;
let activeLocale = "en";
let searchHistory = [];
let searchHistoryEnabledValue = false;
let currentSuggestions = [];
let activeSuggestionIndex = -1;
let suggestionTimer = 0;

function localeFromPath() {
  const firstSegment = window.location.pathname.split("/").filter(Boolean)[0] || "";
  return supportedLocales.has(firstSegment) ? firstSegment : "en";
}

function text(key) {
  const value = messages[key] ?? fallbackMessages[key];
  if (typeof value !== "string") {
    console.error(`Missing UI message for ${activeLocale}.${key}`);
    return key;
  }
  return value;
}

function formatMessage(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ));
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (typeof messages[key] !== "string") return;
    const value = key === "noscriptStories"
      ? formatMessage(messages[key], { count: 12 })
      : messages[key];
    element.textContent = value;
  });

  document.querySelectorAll("[data-i18n-attr]").forEach((element) => {
    for (const directive of element.dataset.i18nAttr.split(";")) {
      const [attribute, key] = directive.split(":").map((part) => part.trim());
      if (attribute && typeof messages[key] === "string") element.setAttribute(attribute, messages[key]);
    }
  });
}

function rememberLanguage(locale) {
  try {
    localStorage.setItem(languagePreferenceKey, locale);
  } catch (error) {
    console.warn("Could not save the language preference:", error);
  }
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${languagePreferenceKey}=${locale}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  } catch (error) {
    console.warn("Could not save the language cookie:", error);
  }
}

function loadSearchHistoryPreference() {
  try {
    searchHistoryEnabledValue = localStorage.getItem(searchHistoryPreferenceKey) === "true";
    searchHistory = searchHistoryEnabledValue
      ? JSON.parse(localStorage.getItem(searchHistoryKey) || "[]")
        .filter((query) => typeof query === "string" && query.length <= 120)
        .slice(0, 8)
      : [];
  } catch (error) {
    searchHistoryEnabledValue = false;
    searchHistory = [];
    console.warn("Could not load local search history:", error);
  }
  searchHistoryEnabled.checked = searchHistoryEnabledValue;
}

async function loadLocaleCatalog() {
  const response = await fetch(`/locales.json?v=${localeCatalogVersion}`, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Locale data returned ${response.status}`);
  const catalog = await response.json();
  if (!catalog || !catalog.languages || !catalog.messages) {
    throw new Error("Locale data is missing language definitions or messages");
  }
  supportedLocales = new Set(Object.keys(catalog.languages));
  activeLocale = localeFromPath();
  if (!catalog.languages[activeLocale] || !catalog.messages[activeLocale]) {
    throw new Error(`Locale data is missing ${activeLocale}`);
  }
  localeCatalog = catalog;
  messages = catalog.messages[activeLocale];
  document.documentElement.lang = activeLocale;
  languageSelect.replaceChildren(...Object.entries(catalog.languages).map(([code, language]) => new Option(language.name, code)));
  languageSelect.value = activeLocale;
  applyTranslations();
  searchSuggestions.setAttribute("aria-label", text("searchLabel"));
  loadSearchHistoryPreference();
  let savedLocale = null;
  try {
    savedLocale = localStorage.getItem(languagePreferenceKey);
  } catch (error) {
    console.warn("Could not save the language preference:", error);
  }
  rememberLanguage(supportedLocales.has(savedLocale) ? savedLocale : activeLocale);
}

languageSelect.addEventListener("change", () => {
  const nextLocale = languageSelect.value;
  if (!supportedLocales.has(nextLocale)) return;
  rememberLanguage(nextLocale);
  window.location.assign(`/${nextLocale}/`);
});

async function recordPageView() {
  const config = window.GOODTHINGS_CONFIG || {};
  if (typeof config.counterApiUrl !== "string" || !config.counterApiUrl.trim()) return;

  try {
    const response = await fetch(config.counterApiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "view",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Counter returned ${response.status}`);
    const counts = await response.json();
    if (!Number.isSafeInteger(counts.total) || !Number.isSafeInteger(counts.today)) return;
    document.querySelector("#total-views").textContent = counts.total.toLocaleString();
    document.querySelector("#today-views").textContent = counts.today.toLocaleString();
  } catch (error) {
    console.warn("Could not load page-view counts:", error);
  }
}

function configureDonationLink() {
  const link = document.querySelector("#donate-link");
  const config = window.GOODTHINGS_CONFIG || {};
  const donationUrl = typeof config.donationUrl === "string" ? config.donationUrl.trim() : "";
  const upiId = typeof config.upiId === "string" ? config.upiId.trim() : "";
  const payeeName = typeof config.payeeName === "string" ? config.payeeName.trim() : "";

  try {
    const parsedUrl = new URL(donationUrl);
    if (parsedUrl.protocol === "https:") {
      link.href = parsedUrl.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.querySelector("#donate-label").textContent = text("donate");
      link.hidden = false;
      return;
    }
  } catch {
    // Continue to the UPI option when no HTTPS payment page is configured.
  }

  if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(upiId)) return;
  const payment = new URLSearchParams({ pa: upiId, cu: "INR", tn: "Support Good things to know today" });
  if (payeeName) payment.set("pn", payeeName);
  link.href = `upi://pay?${payment.toString()}`;
  document.querySelector("#donate-label").textContent = text("donateViaUpi");
  link.hidden = false;
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = safeDate(value);
  if (!date) return text("dateUnknown");
  const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}

function categoryLabel(category) {
  const labels = messages.categories || fallbackMessages.categories;
  return labels[category] || category || labels.General;
}

function formatUpdatedAt(value) {
  const date = safeDate(value);
  if (!date) return text("latestEdition");
  const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
  return formatMessage(text("updatedAtTemplate"), { time });
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function categorySortValue(name) {
  const priority = categoryPriority[name] ?? Number.MAX_SAFE_INTEGER;
  return [priority, name || ""].join("|");
}

function populateFilters() {
  const categories = new Map();
  const sources = new Set();
  for (const story of stories) {
    if (story.category) categories.set(story.category, (categories.get(story.category) || 0) + 1);
    for (const source of story.sources || []) {
      const sourceName = source.source || source.name;
      if (sourceName) sources.add(sourceName);
    }
  }

  categoryNav.replaceChildren();
  const allButton = makeCategoryButton(text("allCategories"), "all", stories.length);
  categoryNav.append(allButton);
  const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
  [...categories.entries()].sort(([left], [right]) => {
    const leftValue = categorySortValue(left);
    const rightValue = categorySortValue(right);
    return leftValue.localeCompare(rightValue, locale);
  }).forEach(([name, count], index) => {
    categoryNav.append(makeCategoryButton(categoryLabel(name), name, count, categoryColors[index % categoryColors.length]));
  });

  const sourceNames = new Set(sources);
  availableCategories = new Set(categories.keys());
  availableSources = sourceNames;
  sourceOptions.replaceChildren();
  [...sourceNames].sort((a, b) => a.localeCompare(b, locale)).forEach((name, index) => {
    const label = makeElement("label", "filter-option");
    const checkbox = makeElement("input");
    checkbox.type = "checkbox";
    checkbox.value = name;
    checkbox.id = `source-option-${index}`;
    checkbox.checked = selectedSources.has(name);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedSources.add(name);
      else selectedSources.delete(name);
      updateSourceFilterSummary();
      renderWithUrl();
    });
    label.append(checkbox, document.createTextNode(name));
    sourceOptions.append(label);
  });
  updateCategoryButtons();
  updateSourceFilterSummary();
}

function makeCategoryButton(label, value, count, color) {
  const isActive = value === "all" ? selectedCategories.size === 0 : selectedCategories.has(value);
  const button = makeElement("button", `category-button${isActive ? " is-active" : ""}`);
  button.type = "button";
  button.dataset.category = value;
  button.setAttribute("aria-pressed", String(isActive));
  if (color) button.style.setProperty("--category-color", color);
  button.append(document.createTextNode(label));
  const countElement = makeElement("span", "category-count", String(count));
  button.append(countElement);
  return button;
}

function updateCategoryButtons() {
  categoryNav.querySelectorAll("[data-category]").forEach((button) => {
    const category = button.dataset.category;
    const isActive = category === "all" ? selectedCategories.size === 0 : selectedCategories.has(category);
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function updateSourceFilterSummary() {
  const names = [...selectedSources];
  if (!names.length) {
    sourceFilterSummary.textContent = text("allSources");
  } else if (names.length <= 2) {
    sourceFilterSummary.textContent = names.join(", ");
  } else {
    sourceFilterSummary.textContent = `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  }
}

function updateDateInputs() {
  dateRangeInputs.hidden = dateRange.value !== "custom";
}

function visibleStories() {
  const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
  return searchStories(stories, searchInput.value, {
    locale,
    language: searchLanguage.value,
    categories: selectedCategories,
    sources: selectedSources,
    dateRange: dateRange.value,
    from: searchFrom.value,
    to: searchTo.value,
    sort: sortOrder.value,
  });
}

function makeStoryTeaser(story) {
  const raw = (story.summary || story.excerpt || story.title || "").replace(/https?:\/\/\S+/gi, "");
  const cleaned = raw.replace(/\s+/g, " ").replace(/[\u2018\u2019\u201C\u201D]/g, "").trim();
  if (!cleaned) return [];

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 10) return [cleaned];

  const chunkCount = Math.min(10, Math.max(2, Math.ceil(words.length / 12)));
  const chunkSize = Math.ceil(words.length / chunkCount);
  const lines = [];

  for (let index = 0; index < words.length; index += chunkSize) {
    const chunk = words.slice(index, index + chunkSize).join(" ");
    if (chunk) lines.push(chunk);
    if (lines.length >= 10) break;
  }

  return lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function renderEditorialBrief(element, editorial, query) {
  if (!editorial || typeof editorial !== "object") return;

  const why = typeof editorial.whyItMatters === "string" ? editorial.whyItMatters.trim() : "";
  const facts = Array.isArray(editorial.keyFacts)
    ? editorial.keyFacts.filter((fact) => typeof fact === "string" && fact.trim()).slice(0, 8)
    : [];
  const whatNext = typeof editorial.whatToWatch === "string" ? editorial.whatToWatch.trim() : "";
  const author = typeof editorial.author === "string" ? editorial.author.trim() : "";
  const reviewedAt = typeof editorial.reviewedAt === "string" ? editorial.reviewedAt.trim() : "";
  if (!why && !facts.length && !whatNext) return;

  const brief = makeElement("aside", "editorial-brief");
  brief.setAttribute("aria-label", "Editorial briefing");
  brief.append(makeElement("span", "editorial-label", "Editorial briefing"));

  if (why) {
    const paragraph = makeElement("p");
    paragraph.append(makeElement("strong", "", "Why it matters: "));
    appendHighlightedText(paragraph, why, query);
    brief.append(paragraph);
  }
  if (facts.length) {
    const factsHeading = makeElement("p");
    factsHeading.append(makeElement("strong", "", "Key facts"));
    brief.append(factsHeading);
    const list = makeElement("ul", "editorial-facts");
    facts.forEach((fact) => {
      const item = makeElement("li");
      appendHighlightedText(item, fact, query);
      list.append(item);
    });
    brief.append(list);
  }
  if (whatNext) {
    const paragraph = makeElement("p");
    paragraph.append(makeElement("strong", "", "What to watch: "));
    appendHighlightedText(paragraph, whatNext, query);
    brief.append(paragraph);
  }
  if (author || reviewedAt) {
    const byline = [author ? `Reviewed by ${author}` : "", reviewedAt ? `Reviewed ${reviewedAt}` : ""].filter(Boolean).join(" · ");
    brief.append(makeElement("p", "editorial-byline", byline));
  }
  element.append(brief);
}

function renderSourceSynthesis(element, sourceSynthesis, query) {
  if (!Array.isArray(sourceSynthesis) || sourceSynthesis.length < 2) return false;
  const items = sourceSynthesis.filter((item) => item && typeof item.text === "string" && item.text.trim());
  if (items.length < 2) return false;

  const synthesis = makeElement("aside", "source-synthesis");
  synthesis.setAttribute("aria-label", "The story across sources");
  synthesis.append(makeElement("span", "editorial-label", "The story, across sources"));
  synthesis.append(makeElement("p", "source-synthesis-note", "Key details highlighted by each publisher; accounts may differ."));
  const list = makeElement("ul");
  items.forEach((item) => {
    const row = makeElement("li");
    const sourceName = typeof item.source === "string" && item.source.trim()
      ? item.source.trim()
      : text("originalSource");
    const sourceUrl = typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : "";
    if (sourceUrl) {
      const sourceLink = makeElement("a", "source-synthesis-source", sourceName);
      sourceLink.href = sourceUrl;
      sourceLink.target = "_blank";
      sourceLink.rel = "noopener noreferrer";
      row.append(sourceLink, document.createTextNode(": "));
    } else {
      row.append(makeElement("strong", "source-synthesis-source", `${sourceName}: `));
    }
    appendHighlightedText(row, item.text, query);
    list.append(row);
  });
  synthesis.append(list);
  element.append(synthesis);
  return true;
}

function appendHighlightedText(element, value, query) {
  const content = String(value || "");
  const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
  const ranges = highlightRanges(content, query, locale);
  if (!ranges.length) {
    element.textContent = content;
    return;
  }

  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) element.append(document.createTextNode(content.slice(cursor, start)));
    const mark = makeElement("mark", "", content.slice(start, end));
    element.append(mark);
    cursor = end;
  }
  if (cursor < content.length) element.append(document.createTextNode(content.slice(cursor)));
}

function renderStory(story, index, query) {
  const article = makeElement("article", "story-card");
  article.style.animationDelay = `${Math.min(index, 8) * 35}ms`;
  const meta = makeElement("div", "story-meta");
  const category = makeElement("span", "story-category", categoryLabel(story.category || "General"));
  const date = makeElement("time", "story-date", formatDate(story.publishedAt));
  const parsedDate = safeDate(story.publishedAt);
  if (parsedDate) date.dateTime = parsedDate.toISOString();
  meta.append(category, date);

  const storyUrl = (() => {
    const candidate = story.url || story.link || (Array.isArray(story.sources) ? story.sources[0]?.url || story.sources[0]?.link : "");
    return typeof candidate === "string" && /^https?:\/\//i.test(candidate) ? candidate : "";
  })();

  const body = makeElement("div", "story-body");
  const title = makeElement("h3", "story-title");
  const titleLink = makeElement("a");
  appendHighlightedText(titleLink, story.title || text("originalSource"), query);
  const leadSource = (story.sources || [])[0];
  const leadSourceName = leadSource?.source || leadSource?.name || text("originalSource");
  titleLink.setAttribute("aria-label", formatMessage(text("storyLinkLabel"), {
    title: story.title || text("originalSource"),
    source: leadSourceName,
  }));
  if (story.storyPageUrl) {
    titleLink.href = story.storyPageUrl;
  } else if (storyUrl) {
    titleLink.href = storyUrl;
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
  } else {
    titleLink.href = "#";
    titleLink.setAttribute("aria-disabled", "true");
    titleLink.tabIndex = -1;
    titleLink.style.pointerEvents = "none";
  }
  title.append(titleLink);
  body.append(title);

  const sources = story.sources || [];
  const hasLicensedSummary = sources.some((source) => source.licenseUrl);
  const summaryText = typeof story.summary === "string" ? story.summary.trim() : "";
  const fullTextSummary = typeof story.fullTextSummary === "string" ? story.fullTextSummary.trim() : "";
  if (fullTextSummary && hasLicensedSummary) {
    const summary = makeElement("aside", "full-text-summary");
    summary.append(makeElement("span", "editorial-label", "Full article summary"));
    const paragraph = makeElement("p");
    appendHighlightedText(paragraph, fullTextSummary, query);
    summary.append(paragraph);
    body.append(summary);
  } else if (hasLicensedSummary && summaryText) {
    const summary = makeElement("p", "story-excerpt story-long-summary");
    appendHighlightedText(summary, summaryText, query);
    body.append(summary);
  } else {
    const teaserLines = makeStoryTeaser(story);
    if (teaserLines.length) {
      const teaser = makeElement("div", "story-summary");
      teaserLines.forEach((line) => {
        const lineElement = makeElement("span", "story-summary-line");
        appendHighlightedText(lineElement, line, query);
        teaser.append(lineElement);
      });
      body.append(teaser);
    }
  }
  const hasSourceSynthesis = renderSourceSynthesis(body, story.sourceSynthesis, query);
  renderEditorialBrief(body, story.editorial, query);
  for (const coverage of hasSourceSynthesis ? [] : story.additionalCoverage || []) {
    if (!coverage.excerpt) continue;
    const additional = makeElement("p", "story-excerpt additional-coverage");
    additional.append(makeElement("strong", "", formatMessage(text("alsoReportedBy"), { source: coverage.source || coverage.name || text("originalSource") })));
    additional.append(document.createTextNode(coverage.excerpt));
    body.append(additional);
  }

  const sourceLine = makeElement("div", "story-source");
  sourceLine.append(makeElement("span", "", sources.length > 1 ? text("coverageLabel") : text("sourceLabel")));
  const authors = sources.flatMap((source) => Array.isArray(source.authors) ? source.authors : []);
  if (authors.length) {
    const authorList = makeElement("span", "story-authors", `${text("authorsLabel")} ${authors.join(", ")}`);
    sourceLine.append(authorList);
  }
  sources.forEach((source, sourceIndex) => {
    if (sourceIndex > 0) sourceLine.append(makeElement("span", "source-dot"));
    if (typeof source.licenseUrl === "string" && /^https?:\/\//i.test(source.licenseUrl)) {
      const licenseLink = makeElement("a", "read-link", "CC BY 4.0");
      licenseLink.href = source.licenseUrl;
      licenseLink.target = "_blank";
      licenseLink.rel = "noopener noreferrer";
      sourceLine.append(licenseLink);
    }
    const sourceName = source.source || source.name || text("originalSource");
    const sourceLink = makeElement("a", "read-link", `${sourceName} ↗`);
    sourceLink.href = source.url;
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceLink.setAttribute("aria-label", formatMessage(text("storyLinkLabel"), {
      title: story.title || text("originalSource"),
      source: sourceName,
    }));
    sourceLine.append(sourceLink);
  });
  body.append(sourceLine);
  article.append(meta, body);
  return article;
}

function render() {
  if (!storiesLoaded) return;
  const matches = visibleStories();
  const showOnePerCategory = selectedCategories.size === 0
    && !searchInput.value.trim()
    && sortOrder.value === "relevance";
  const results = showOnePerCategory ? onePerCategory(matches) : limitStories(matches);
  const countTemplate = text(results.length === 1 ? "storyCountSingular" : "storyCountPlural");
  storyCount.textContent = formatMessage(countTemplate, { count: results.length });
  const categoryCounts = new Map();
  for (const story of stories) {
    const category = story.category || "General";
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  }
  categoryNav.querySelectorAll("[data-category]").forEach((button) => {
    const category = button.dataset.category;
    const count = category === "all"
      ? (showOnePerCategory ? results.length : Math.min(stories.length, MAX_STORIES_PER_TAB))
      : Math.min(categoryCounts.get(category) || 0, MAX_STORIES_PER_TAB);
    button.querySelector(".category-count").textContent = String(count);
  });
  updateCategoryButtons();
  updateSourceFilterSummary();
  storyList.replaceChildren(...results.map(({ story }, index) => renderStory(story, index, searchInput.value)));
  emptyState.hidden = results.length !== 0;
}

async function loadBrief() {
  storyList.setAttribute("aria-busy", "true");
  errorState.hidden = true;
  emptyState.hidden = true;
  translationNotice.hidden = true;
  if (!stories.length && !storyList.querySelector(".story-card") && loadingState) storyList.replaceChildren(loadingState);
  try {
    const response = await fetch("/data/feeds.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Feed data returned ${response.status}`);
    const data = await response.json();
    const feedStories = Array.isArray(data.groups)
      ? data.groups
          .filter((group) => group && Array.isArray(group.sources) && group.sources.some((source) => /^https?:\/\//i.test(source.url || "")))
          .map((group) => ({
            ...group,
            url: group.url || group.sources?.[0]?.url || "",
            id: group.id || group.url || group.sources?.[0]?.url || "",
            source: group.source || group.sources?.[0]?.source || group.sources?.[0]?.name || "",
          }))
      : (Array.isArray(data.entries) ? data.entries.filter((story) => story && /^https?:\/\//i.test(story.url || "")).map((story) => ({
          id: story.url,
          title: story.title,
          url: story.url,
          category: story.category,
          publishedAt: story.publishedAt,
          summary: story.excerpt,
          sources: [{ name: story.source, url: story.url, title: story.title, excerpt: story.excerpt }],
        })) : []);
    stories = feedStories.map((story) => ({
      ...story,
      originalTitle: story.originalTitle || story.title || "",
      originalSummary: story.originalSummary || story.fullTextSummary || story.summary || story.excerpt || "",
      localizedCategory: categoryLabel(story.category || "General"),
    }));
    storiesLoaded = true;
    populateFilters();
    restoreSearchState();
    updatedAt.textContent = formatUpdatedAt(data.generatedAt);
    const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
    document.querySelector("#issue-number").textContent = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(new Date().getDate());
    render();
    await loadIndexedTranslations();
  } catch (error) {
    console.error("Could not load the brief:", error);
    const hasStories = storyList.querySelector(".story-card") !== null;
    if (hasStories) {
      errorState.querySelector("h3").textContent = text("feedStaleTitle");
      errorState.querySelector("p").textContent = text("feedStaleDescription");
    } else {
      storyList.replaceChildren();
      errorState.querySelector("h3").textContent = text("feedErrorTitle");
      errorState.querySelector("p").textContent = text("feedErrorDescription");
    }
    errorState.hidden = false;
  } finally {
    storyList.setAttribute("aria-busy", "false");
  }
}

async function loadIndexedTranslations() {
  if (!stories.length) return;
  try {
    const response = await fetch(`/api/translations?language=${encodeURIComponent(activeLocale)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Indexed translations returned ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.articles)) throw new Error("Indexed translations returned an invalid response.");

    const indexedByStoryKey = new Map(payload.articles.map((article) => [article.story_key, article]));
    let missingTranslations = 0;
    for (const story of stories) {
      const storyKey = typeof story.id === "string" && story.id ? story.id : story.url;
      const indexed = indexedByStoryKey.get(storyKey);
      if (!indexed) {
        if (activeLocale !== "en") missingTranslations += 1;
        continue;
      }
      story.storyPageUrl = `/${activeLocale}/story/${indexed.article_id}`;
      if (activeLocale !== "en") {
        if (typeof indexed.title !== "string" || typeof indexed.summary !== "string") {
          missingTranslations += 1;
          story.storyPageUrl = "";
          continue;
        }
        story.title = indexed.title;
        story.summary = indexed.summary;
      }
    }

    clearSearchIndex();
    render();
    if (missingTranslations) {
      translationNotice.textContent = text("translationFallback");
      translationNotice.hidden = false;
    }
  } catch (error) {
    console.warn("Could not load indexed translations:", error);
    if (activeLocale !== "en") {
      translationNotice.textContent = text("translationFallback");
      translationNotice.hidden = false;
    }
  }
}

function validDateParameter(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === Number(value.slice(0, 4))
    && date.getMonth() + 1 === Number(value.slice(5, 7))
    && date.getDate() === Number(value.slice(8, 10));
}

function restoreSearchState() {
  const params = new URLSearchParams(window.location.search);
  searchInput.value = (params.get("q") || "").slice(0, 120);
  const category = params.getAll("category").find((value) => availableCategories.has(value));
  selectedCategories = new Set(category ? [category] : []);
  selectedSources = new Set(params.getAll("source").filter((source) => availableSources.has(source)).slice(0, 20));
  dateRange.value = ["today", "week", "month", "custom"].includes(params.get("date")) ? params.get("date") : "any";
  searchFrom.value = dateRange.value === "custom" && validDateParameter(params.get("from")) ? params.get("from") : "";
  searchTo.value = dateRange.value === "custom" && validDateParameter(params.get("to")) ? params.get("to") : "";
  searchLanguage.value = params.get("language") === "en" ? "en" : "all";
  sortOrder.value = ["newest", "oldest"].includes(params.get("sort")) ? params.get("sort") : "relevance";
  sourceOptions.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.checked = selectedSources.has(checkbox.value);
  });
  updateCategoryButtons();
  updateSourceFilterSummary();
  updateDateInputs();
  writeSearchState();
}

function writeSearchState() {
  const url = new URL(window.location.href);
  for (const key of ["q", "category", "source", "date", "from", "to", "language", "sort"]) {
    url.searchParams.delete(key);
  }
  const query = searchInput.value.trim().slice(0, 120);
  if (query) url.searchParams.set("q", query);
  if (selectedCategories.size) url.searchParams.set("category", [...selectedCategories][0]);
  [...selectedSources].sort().forEach((source) => url.searchParams.append("source", source));
  if (dateRange.value !== "any") url.searchParams.set("date", dateRange.value);
  if (dateRange.value === "custom") {
    if (validDateParameter(searchFrom.value)) url.searchParams.set("from", searchFrom.value);
    if (validDateParameter(searchTo.value)) url.searchParams.set("to", searchTo.value);
  }
  if (searchLanguage.value !== "all") url.searchParams.set("language", searchLanguage.value);
  if (sortOrder.value !== "relevance") url.searchParams.set("sort", sortOrder.value);

  const searchStateActive = Boolean(
    query || selectedCategories.size || selectedSources.size || dateRange.value !== "any"
      || searchLanguage.value !== "all" || sortOrder.value !== "relevance",
  );
  document.querySelector("#search-robots").content = searchStateActive ? "noindex,follow" : "index,follow";
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}

function renderWithUrl() {
  render();
  writeSearchState();
}

function queryMatches(value, query) {
  const locale = localeCatalog?.languages?.[activeLocale]?.locale || activeLocale;
  const queryTokens = tokenize(query, locale);
  if (!queryTokens.length) return false;
  const valueTokens = tokenize(value, locale);
  return queryTokens.every((queryToken) => valueTokens.some((valueToken) => valueToken.includes(queryToken)));
}

function buildSuggestions(query) {
  const suggestions = [];
  const trimmedQuery = query.trim();
  if (searchHistoryEnabledValue) {
    searchHistory
      .filter((item) => !trimmedQuery || queryMatches(item, trimmedQuery))
      .slice(0, 3)
      .forEach((value) => suggestions.push({ kind: "recent", value }));
  }

  if (trimmedQuery) {
    visibleStories().slice(0, 5).forEach(({ story }) => {
      suggestions.push({ kind: "story", value: story.title || "", story });
    });
    [...availableCategories]
      .filter((category) => queryMatches(`${categoryLabel(category)} ${category}`, trimmedQuery))
      .slice(0, 3)
      .forEach((value) => suggestions.push({ kind: "category", value }));
    [...availableSources]
      .filter((source) => queryMatches(source, trimmedQuery))
      .slice(0, 3)
      .forEach((value) => suggestions.push({ kind: "source", value }));
  }
  return suggestions.slice(0, 8);
}

function setSuggestionActive(index) {
  activeSuggestionIndex = currentSuggestions.length
    ? (index + currentSuggestions.length) % currentSuggestions.length
    : -1;
  searchSuggestions.querySelectorAll("[role='option']").forEach((option, optionIndex) => {
    const active = optionIndex === activeSuggestionIndex;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", String(active));
  });
  if (activeSuggestionIndex < 0) {
    searchInput.removeAttribute("aria-activedescendant");
  } else {
    const activeOption = searchSuggestions.querySelector(`#search-suggestion-${activeSuggestionIndex}`);
    searchInput.setAttribute("aria-activedescendant", activeOption.id);
    activeOption.scrollIntoView({ block: "nearest" });
  }
}

function renderSuggestions(query) {
  currentSuggestions = buildSuggestions(query);
  activeSuggestionIndex = -1;
  searchSuggestions.replaceChildren();
  const typeLabels = {
    category: text("suggestionCategory"),
    recent: text("recentSearches"),
    source: text("suggestionSource"),
    story: text("suggestionStory"),
  };
  currentSuggestions.forEach((suggestion, index) => {
    const option = makeElement("button", "search-suggestion");
    option.type = "button";
    option.id = `search-suggestion-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.tabIndex = -1;
    option.dataset.index = String(index);
    const type = makeElement("span", "search-suggestion-type", typeLabels[suggestion.kind]);
    const value = makeElement("span", "search-suggestion-value");
    appendHighlightedText(value, suggestion.value, query);
    option.append(type, value);
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectSuggestion(suggestion));
    searchSuggestions.append(option);
  });
  suggestionsPopover.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  clearSearchHistoryButton.hidden = !searchHistoryEnabledValue || searchHistory.length === 0;
  searchInput.removeAttribute("aria-activedescendant");
}

function closeSuggestions() {
  suggestionsPopover.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  activeSuggestionIndex = -1;
}

function scheduleSuggestions() {
  window.clearTimeout(suggestionTimer);
  currentSuggestions = [];
  activeSuggestionIndex = -1;
  suggestionsPopover.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  suggestionTimer = window.setTimeout(() => renderSuggestions(searchInput.value), 120);
}

function saveSearchHistory(query) {
  const value = query.trim().slice(0, 120);
  if (!searchHistoryEnabledValue || !value) return;
  searchHistory = [value, ...searchHistory.filter((item) => item !== value)].slice(0, 8);
  try {
    localStorage.setItem(searchHistoryKey, JSON.stringify(searchHistory));
  } catch (error) {
    console.warn("Could not save local search history:", error);
  }
}

function selectSuggestion(suggestion) {
  if (suggestion.kind === "category") {
    selectedCategories = new Set([suggestion.value]);
  } else if (suggestion.kind === "source") {
    selectedSources.has(suggestion.value)
      ? selectedSources.delete(suggestion.value)
      : selectedSources.add(suggestion.value);
    sourceOptions.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = selectedSources.has(checkbox.value);
    });
  } else {
    searchInput.value = suggestion.value;
    if (suggestion.kind !== "recent") saveSearchHistory(searchInput.value);
  }
  renderWithUrl();
  closeSuggestions();
  searchInput.focus();
}

categoryNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  const category = button.dataset.category;
  if (category === "all") {
    selectedCategories.clear();
  } else {
    selectedCategories = new Set([category]);
  }
  renderWithUrl();
});

searchInput.addEventListener("input", () => {
  renderWithUrl();
  scheduleSuggestions();
});
searchInput.addEventListener("focus", () => renderSuggestions(searchInput.value));
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" && currentSuggestions.length) {
    event.preventDefault();
    setSuggestionActive(activeSuggestionIndex + 1);
  } else if (event.key === "ArrowUp" && currentSuggestions.length) {
    event.preventDefault();
    setSuggestionActive(activeSuggestionIndex <= 0 ? currentSuggestions.length - 1 : activeSuggestionIndex - 1);
  } else if (event.key === "Enter") {
    if (activeSuggestionIndex >= 0) {
      event.preventDefault();
      selectSuggestion(currentSuggestions[activeSuggestionIndex]);
    } else {
      saveSearchHistory(searchInput.value);
      renderWithUrl();
      closeSuggestions();
    }
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
});
searchInput.addEventListener("blur", () => {
  window.setTimeout(() => {
    if (!suggestionsPopover.contains(document.activeElement)) closeSuggestions();
  }, 100);
});
sortOrder.addEventListener("change", renderWithUrl);
dateRange.addEventListener("change", () => {
  updateDateInputs();
  renderWithUrl();
});
searchFrom.addEventListener("change", renderWithUrl);
searchTo.addEventListener("change", renderWithUrl);
searchLanguage.addEventListener("change", renderWithUrl);
searchHistoryEnabled.addEventListener("change", () => {
  searchHistoryEnabledValue = searchHistoryEnabled.checked;
  try {
    localStorage.setItem(searchHistoryPreferenceKey, String(searchHistoryEnabledValue));
    if (!searchHistoryEnabledValue) {
      localStorage.removeItem(searchHistoryKey);
      searchHistory = [];
    } else {
      searchHistory = JSON.parse(localStorage.getItem(searchHistoryKey) || "[]")
        .filter((query) => typeof query === "string" && query.length <= 120)
        .slice(0, 8);
    }
  } catch (error) {
    console.warn("Could not update local search history settings:", error);
  }
  renderSuggestions(searchInput.value);
});
clearSearchHistoryButton.addEventListener("click", () => {
  searchHistory = [];
  try {
    localStorage.removeItem(searchHistoryKey);
  } catch (error) {
    console.warn("Could not clear local search history:", error);
  }
  renderSuggestions(searchInput.value);
});
window.addEventListener("popstate", () => {
  restoreSearchState();
  render();
  if (document.activeElement === searchInput) renderSuggestions(searchInput.value);
  else closeSuggestions();
});
document.addEventListener("pointerdown", (event) => {
  if (!suggestionsPopover.contains(event.target) && !searchInput.contains(event.target)) closeSuggestions();
});
function clearAllSearchFilters() {
  selectedCategories.clear();
  selectedSources.clear();
  searchInput.value = "";
  dateRange.value = "any";
  searchFrom.value = "";
  searchTo.value = "";
  searchLanguage.value = "all";
  sortOrder.value = "relevance";
  sourceOptions.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.checked = false;
  });
  updateDateInputs();
  closeSuggestions();
  renderWithUrl();
}

document.querySelector("#reset-filters").addEventListener("click", clearAllSearchFilters);
document.querySelector("#clear-all-filters").addEventListener("click", clearAllSearchFilters);
document.querySelector("#retry-load").addEventListener("click", loadBrief);

async function initialize() {
  try {
    await loadLocaleCatalog();
  } catch (error) {
    console.error("Could not load localized UI data:", error);
    messages = fallbackMessages;
    translationNotice.textContent = "Language data is unavailable. Some controls may remain in English.";
    translationNotice.hidden = false;
  }
  configureDonationLink();
  recordPageView();
  loadBrief();
}

initialize();