'use strict';
const News = require('../shared/news');
const MAX_XML_BYTES = 1024 * 1024, FEED_TIMEOUT_MS = 4500;
function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  }).replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}
function plainText(value, max = 700) {
  return News.cleanText(decodeEntities(decodeEntities(value).replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' '), max);
}
function parseRssFeed(xml, feed = {}, now = Date.now()) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_XML_BYTES) throw new Error('News feed exceeded the size limit.');
  if (!/<(?:rss|rdf:RDF)\b/i.test(xml)) throw new Error('The news source returned an invalid feed.');
  const items = []; let examined = 0;
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (++examined > 120 || items.length >= 60) break;
    const item = match[1], tag = name => item.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'))?.[1] || '';
    const source = plainText(tag('source'), 100);
    let title = plainText(tag('title'), 400);
    if (source && title.toLowerCase().endsWith(' - ' + source.toLowerCase())) title = title.slice(0, -source.length - 3).trim();
    // Google News often supplies a related-story list rather than an excerpt.
    const rawDescription = decodeEntities(tag('description'));
    const description = /<(?:ol|ul)\b/i.test(rawDescription) ? '' : plainText(rawDescription);
    const place = News.cleanText(feed.place, 80).toLocaleLowerCase('en-US');
    const sourceUrl = decodeEntities(item.match(/<source\b[^>]*\burl=["']([^"']+)["']/i)?.[1] || '');
    const article = News.normalizeArticle({ title, link: decodeEntities(tag('link')).trim(), description, source, sourceUrl, pubDate: plainText(tag('pubDate'), 100), topics: feed.topic ? [feed.topic] : [], localMatch: !!place && (title + ' ' + description).toLocaleLowerCase('en-US').includes(place) }, now);
    if (article) items.push(article);
  }
  return items;
}
function buildQueries(payload) {
  const request = News.request(payload), { city, state, country, topics } = request;
  const quote = value => '"' + value.replace(/["\\]/g, ' ') + '"';
  const local = [city, state, country].filter(Boolean).map(quote).join(' ');
  const definitions = { business: 'business economy', world: 'world news', technology: 'technology', sports: 'sports', science: 'science research', politics: 'politics', entertainment: 'entertainment' };
  const feeds = topics.length ? topics.flatMap(topic => {
    if (topic === 'local') return city || state ? [{ topic, query: local + ' news', place: city || state }] : [];
    return [{ topic, query: definitions[topic] + (country && topic !== 'world' ? ' ' + quote(country) : ''), place: '' }];
  }) : [{ topic: '', query: country ? quote(country) + ' news' : 'top news', place: '' }, ...(city || state ? [{ topic: 'local', query: local + ' news', place: city || state }] : [])];
  const editions = { 'united states': 'US', usa: 'US', us: 'US', 'united kingdom': 'GB', uk: 'GB', canada: 'CA', india: 'IN', australia: 'AU', 'new zealand': 'NZ', singapore: 'SG', ireland: 'IE', 'south africa': 'ZA' };
  const edition = editions[country.toLowerCase()] || 'US';
  return feeds.map(feed => ({ ...feed, url: 'https://news.google.com/rss/search?' + new URLSearchParams({ q: feed.query + ' when:2d', hl: 'en-' + edition, gl: edition, ceid: edition + ':en' }) }));
}
async function readBoundedText(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_XML_BYTES) throw new Error('News feed exceeded the size limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_XML_BYTES) throw new Error('News feed exceeded the size limit.');
    return text;
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_XML_BYTES) { await reader.cancel(); throw new Error('News feed exceeded the size limit.'); }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
function createNewsService({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = FEED_TIMEOUT_MS } = {}) {
  async function fetchBundle(payload = {}) {
    const request = News.request(payload), feeds = buildQueries(request), started = now();
    const results = await Promise.allSettled(feeds.map(async feed => {
      const controller = new AbortController(); let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('News feed timed out.')); }, timeoutMs); });
      try {
        return await Promise.race([timeout, (async () => {
          const response = await fetchImpl(feed.url, { signal: controller.signal, credentials: 'omit', headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Olanga Desktop Assistant' } });
          if (!response.ok) { await response.body?.cancel?.(); throw new Error('News source unavailable (' + response.status + ').'); }
          return parseRssFeed(await readBoundedText(response), feed, started);
        })()]);
      } finally { clearTimeout(timer); controller.abort(); }
    }));
    const successful = results.filter(result => result.status === 'fulfilled');
    if (feeds.length && !successful.length) throw new Error('News sources are unavailable. Try Refresh again later.');
    const ranked = News.rankArticles(successful.flatMap(result => result.value), { topics: request.topics, limit: request.limit, now: started });
    return { locationLabel: [request.city, request.state, request.country].filter(Boolean).join(', ') || 'Location not set', countryLabel: request.country || '', topics: request.topics, generatedAt: new Date(started).toISOString(), articles: ranked.articles,
      coverage: { requestedFeeds: feeds.length, successfulFeeds: successful.length, failedFeeds: results.length - successful.length, localUnavailable: request.topics.includes('local') && !request.city && !request.state, duplicateCount: ranked.duplicateCount, availableCount: ranked.availableCount, publishers: ranked.publishers, undatedCount: ranked.undatedCount, maxAgeHours: 72 } };
  }
  return { fetchBundle };
}
module.exports = { createNewsService, buildQueries, parseRssFeed, decodeEntities, plainText, readBoundedText, MAX_XML_BYTES, FEED_TIMEOUT_MS };
