/* Source-only news ranking and bounded local reading preferences. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaNews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TOPICS = Object.freeze(['local', 'business', 'world', 'technology', 'sports', 'science', 'politics', 'entertainment']);
  const DEFAULT_TOPICS = Object.freeze(['local', 'business', 'world', 'technology']);
  const PREFS_KEY = 'olanga_news_preferences_v1', READ_KEY = 'olanga_news_read_v1';
  const MAX_AGE_MS = 72 * 60 * 60 * 1000, READ_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const cleanText = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  function topics(value, fallback = []) {
    return Array.isArray(value) ? [...new Set(value.slice(0, 100).filter(item => TOPICS.includes(item)))].slice(0, TOPICS.length) : [...fallback];
  }
  function preferences(value) {
    const source = value && typeof value === 'object' ? value : {};
    const selected = topics(source.topics, DEFAULT_TOPICS);
    return { topics: selected.length ? selected : [...DEFAULT_TOPICS], limit: [6, 12, 18].includes(source.limit) ? source.limit : 12, unreadOnly: source.unreadOnly === true };
  }
  function request(value) {
    const source = value && typeof value === 'object' ? value : {};
    return { city: cleanText(source.city, 80), state: cleanText(source.state, 80), country: cleanText(source.country, 80), topics: topics(source.topics), limit: [6, 12, 18].includes(source.limit) ? source.limit : 12 };
  }
  function safeUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return '';
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      const host = url.hostname.toLowerCase();
      if (!host.includes('.') || /(?:^|\.)localhost$/.test(host) || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || host.startsWith('[')) return '';
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch (_) { return ''; }
  }
  function canonicalHeadline(value) {
    return cleanText(value).toLocaleLowerCase('en-US').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function storyId(article) {
    const value = canonicalHeadline(article?.title || '') || safeUrl(article?.link);
    let hash = 2166136261;
    for (const character of value) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return 'story_' + (hash >>> 0).toString(36);
  }
  function publication(value, now = Date.now()) {
    if (!value || typeof value !== 'string' || value.length > 100) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now + 10 * 60 * 1000 ? new Date(timestamp).toISOString() : null;
  }
  function normalizeArticle(value, now = Date.now()) {
    if (!value || typeof value !== 'object') return null;
    const title = cleanText(value.title, 400), link = safeUrl(value.link);
    if (!title || !link) return null;
    let source = cleanText(value.source, 100) || new URL(link).hostname.replace(/^www\./, '');
    const sourceUrl = safeUrl(value.sourceUrl);
    const pubDate = publication(value.pubDate, now);
    const rawDate = typeof value.pubDate === 'string' ? Date.parse(value.pubDate) : NaN;
    if (Number.isFinite(rawDate) && (rawDate > now + 10 * 60 * 1000 || now - rawDate > MAX_AGE_MS)) return null;
    let description = cleanText(value.description, 700);
    if (canonicalHeadline(description) === canonicalHeadline(title) || canonicalHeadline(description) === canonicalHeadline(title + ' ' + source)) description = '';
    const article = { title, link, description, source, sourceUrl, pubDate, topics: topics(value.topics), localMatch: value.localMatch === true };
    article.id = storyId(article);
    return article;
  }
  function rankArticles(values, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now(), limit = Math.min(18, Math.max(1, Number(options.limit) || 12));
    const selected = topics(options.topics);
    const byTitle = new Map(), byLink = new Map();
    let dropped = 0, duplicateCount = 0;
    for (const value of (Array.isArray(values) ? values : []).slice(0, 480)) {
      const article = normalizeArticle(value, now);
      if (!article || (selected.length && article.topics.length && !article.topics.some(topic => selected.includes(topic)))) { dropped++; continue; }
      const titleKey = canonicalHeadline(article.title);
      const duplicates = [...new Set([byTitle.get(titleKey), byLink.get(article.link)].filter(Boolean))];
      if (duplicates.length) {
        duplicateCount += duplicates.length;
        const duplicate = duplicates[0], candidates = [...duplicates, article];
        const mergedTopics = [...new Set(candidates.flatMap(item => item.topics))], localMatch = candidates.some(item => item.localMatch);
        const newest = candidates.reduce((best, item) => item.pubDate && (!best.pubDate || item.pubDate > best.pubDate) ? item : best);
        Object.assign(duplicate, newest, { topics: mergedTopics, localMatch });
        // A renamed headline can connect two previously separate URL/title groups.
        // Point every alias to the merged group so no stale duplicate survives.
        if (duplicates.length > 1) for (const map of [byTitle, byLink]) for (const [key, value] of map) if (duplicates.includes(value)) map.set(key, duplicate);
        byTitle.set(titleKey, duplicate); byLink.set(article.link, duplicate);
        continue;
      }
      byTitle.set(titleKey, article); byLink.set(article.link, article);
    }
    const remaining = [...new Set(byTitle.values())], availableCount = remaining.length, chosen = [], publisherCounts = new Map(), topicCounts = new Map();
    const publisher = article => article.sourceUrl ? new URL(article.sourceUrl).hostname.replace(/^www\./, '') : canonicalHeadline(article.source);
    while (remaining.length && chosen.length < limit) {
      remaining.sort((a, b) => score(b) - score(a) || (b.pubDate || '').localeCompare(a.pubDate || '') || a.title.localeCompare(b.title));
      const article = remaining.shift(); chosen.push(article);
      const source = publisher(article); publisherCounts.set(source, (publisherCounts.get(source) || 0) + 1);
      for (const topic of article.topics) topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
    function score(article) {
      const hours = article.pubDate ? Math.max(0, (now - Date.parse(article.pubDate)) / 3600000) : 100;
      const freshness = article.pubDate ? Math.max(0, 36 - hours / 2) : -20;
      const interests = article.topics.filter(topic => selected.includes(topic));
      return freshness + (article.localMatch && selected.includes('local') ? 9 : 0) + interests.reduce((sum, topic) => sum + 12 / (1 + (topicCounts.get(topic) || 0)), 0) - (publisherCounts.get(publisher(article)) || 0) * 16;
    }
    return { articles: chosen, duplicateCount, dropped, availableCount, publishers: new Set(chosen.map(publisher)).size, undatedCount: chosen.filter(article => !article.pubDate).length };
  }
  function readItems(value, now = Date.now()) {
    if (!Array.isArray(value)) return [];
    const unique = new Map();
    for (const item of value.slice(-500)) if (item && /^story_[a-z0-9]{1,10}$/.test(item.id) && Number.isFinite(item.at) && item.at <= now + 60000 && now - item.at <= READ_AGE_MS) unique.set(item.id, { id: item.id, at: item.at });
    return [...unique.values()].sort((a, b) => a.at - b.at).slice(-250);
  }
  return { TOPICS, DEFAULT_TOPICS, PREFS_KEY, READ_KEY, MAX_AGE_MS, cleanText, topics, preferences, request, safeUrl, canonicalHeadline, storyId, publication, normalizeArticle, rankArticles, readItems };
});
