'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const News = require('../../shared/news');
const { createNewsService, buildQueries, parseRssFeed, MAX_XML_BYTES } = require('../../desktop/news-service');
const NOW = Date.parse('2026-10-12T18:00:00Z');
const story = (title, extras = {}) => ({ title, link: 'https://publisher.example/' + encodeURIComponent(title), source: 'Publisher', pubDate: new Date(NOW - 3600000).toISOString(), topics: ['technology'], ...extras });
const item = (title, extras = '') => '<item><title><![CDATA[' + title + ' - Example]]></title><link>https://example.com/' + encodeURIComponent(title) + '</link><source url="https://example.com">Example</source><description><![CDATA[<p>A &amp; B report &#x1F30D;.</p>]]></description>' + extras + '</item>';
const rss = content => '<rss version="2.0"><channel>' + content + '</channel></rss>';
const response = (text, ok = true, status = 200) => ({ ok, status, headers: { get: () => null }, text: async () => text });

test('RSS parsing keeps source text, safe links and dates without treating invalid dates as fresh', () => {
  const parsed = parseRssFeed(rss(item('Fresh story', '<pubDate>Mon, 12 Oct 2026 17:00:00 GMT</pubDate>') + item('Missing date') + item('Broken date', '<pubDate>nonsense</pubDate>')), { topic: 'technology' }, NOW);
  assert.equal(parsed.length, 3); assert.equal(parsed[0].title, 'Fresh story'); assert.equal(parsed[0].source, 'Example');
  assert.equal(parsed[0].description, 'A & B report 🌍.'); assert.equal(parsed[0].pubDate, '2026-10-12T17:00:00.000Z');
  assert.equal(parsed[1].pubDate, null); assert.equal(parsed[2].pubDate, null);
  assert.deepEqual(parsed[0].topics, ['technology']);
});

test('feed aggregate lists are not presented as if they were article excerpts', () => {
  const xml = '<rss><channel><item><title>A story</title><link>https://example.com/one</link><description>&lt;ol&gt;&lt;li&gt;Other headline&lt;/li&gt;&lt;/ol&gt;</description></item></channel></rss>';
  assert.equal(parseRssFeed(xml, {}, NOW)[0].description, '');
});

test('bad URLs, old stories, far-future dates and malformed input are bounded and excluded', () => {
  for (const link of ['javascript:alert(1)', 'file:///secret', 'https://user:pass@example.com/', 'https://localhost/a', 'http://127.0.0.1/a', 'http://192.168.1.1/a', 'https://example.com/ a']) assert.equal(News.normalizeArticle(story('Bad', { link }), NOW), null, link);
  assert.equal(News.normalizeArticle(story('Old', { pubDate: '2025-01-01T00:00:00Z' }), NOW), null);
  assert.equal(News.normalizeArticle(story('Future', { pubDate: '2030-01-01T00:00:00Z' }), NOW), null);
  assert.equal(News.normalizeArticle(story('Broken', { pubDate: {} }), NOW).pubDate, null);
  assert.equal(News.safeUrl('https://example.com/a?utm_source=feed&id=2#section'), 'https://example.com/a?id=2');
  assert.throws(() => parseRssFeed('<html>Failure</html>', {}, NOW), /invalid feed/);
  assert.throws(() => parseRssFeed('a'.repeat(MAX_XML_BYTES + 1), {}, NOW), /size limit/);
  assert.equal(News.request({ city: 'x'.repeat(200), topics: Array(100).fill('technology'), limit: 999 }).city.length, 80);
  assert.deepEqual(News.request({ topics: ['bad', 'world', 'world', 5] }).topics, ['world']);
});

test('ranking deduplicates syndicated headlines and tracking URLs while retaining the freshest copy', () => {
  const ranked = News.rankArticles([story('Same headline!', { pubDate: '2026-10-11T01:00:00Z' }), story('Same headline', { source: 'Other', link: 'https://other.example/new', pubDate: '2026-10-12T17:00:00Z', topics: ['business'] }), story('Changed headline', { link: 'https://other.example/new?utm_source=x' })], { now: NOW, topics: ['technology', 'business'] });
  assert.equal(ranked.articles.length, 1); assert.equal(ranked.duplicateCount, 2);
  assert.equal(ranked.articles[0].pubDate, '2026-10-12T17:00:00.000Z');
  assert.deepEqual(ranked.articles[0].topics.sort(), ['business', 'technology']);
});

test('ranking prioritizes dated relevant stories and balances topics and publishers', () => {
  const articles = [story('Unknown date', { pubDate: null }), story('Technology one'), story('Technology two'), story('Technology three'), story('Business perspective', { topics: ['business'], source: 'Different publisher' }), story('Unselected sports', { topics: ['sports'] })];
  const result = News.rankArticles(articles, { now: NOW, limit: 4, topics: ['technology', 'business'] });
  assert.equal(result.articles.length, 4); assert.ok(result.articles.slice(0, 2).some(item => item.source === 'Different publisher'));
  assert.ok(!result.articles.some(item => item.title === 'Unselected sports')); assert.equal(result.articles.some(item => !item.pubDate), false);
});

test('local coverage uses only the saved place and an unknown location never becomes your area or the United States', () => {
  assert.deepEqual(buildQueries({ topics: ['local'] }), []);
  assert.ok(buildQueries({ topics: ['world'] })[0].query === 'world news');
  const local = buildQueries({ city: 'Seattle', state: 'WA', country: 'USA', topics: ['local', 'world', 'technology', 'technology'] });
  assert.equal(local.length, 3); assert.match(local[0].query, /"Seattle" "WA" "USA"/);
  assert.equal(local[1].query, 'world news'); assert.ok(new URL(local[0].url).searchParams.get('q').endsWith('when:2d'));
  assert.equal(buildQueries({ country: 'India', topics: ['business'] })[0].url.includes('gl=IN'), true);
});

test('partial feed failures keep usable sources and disclose coverage without provider calls', async () => {
  const calls = [];
  const service = createNewsService({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options }); if (new URL(url).searchParams.get('q').startsWith('world')) throw new Error('Fixture offline');
    return response(rss(item('Useful technology', '<pubDate>Mon, 12 Oct 2026 17:00:00 GMT</pubDate>')));
  } });
  const bundle = await service.fetchBundle({ topics: ['world', 'technology'] });
  assert.equal(bundle.articles.length, 1); assert.equal(bundle.coverage.failedFeeds, 1); assert.equal(bundle.coverage.successfulFeeds, 1);
  assert.equal(bundle.locationLabel, 'Location not set'); assert.equal(bundle.countryLabel, '');
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.url.startsWith('https://news.google.com/rss/search?') && call.options.credentials === 'omit'));
});

test('all failed feeds report an error while empty and locationless local feeds report an honest empty result', async () => {
  const failed = createNewsService({ now: () => NOW, fetchImpl: async () => response('', false, 503) });
  await assert.rejects(failed.fetchBundle({ topics: ['world'] }), /unavailable/);
  const empty = createNewsService({ now: () => NOW, fetchImpl: async () => response(rss('')) });
  const result = await empty.fetchBundle({ topics: ['world'] }); assert.deepEqual(result.articles, []); assert.equal(result.coverage.successfulFeeds, 1);
  const local = await empty.fetchBundle({ topics: ['local'] }); assert.deepEqual(local.articles, []); assert.equal(local.coverage.localUnavailable, true); assert.equal(local.coverage.requestedFeeds, 0);
});

test('unresponsive feeds time out and abort even if the transport ignores cancellation', async () => {
  let signal;
  const service = createNewsService({ timeoutMs: 15, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(service.fetchBundle({ topics: ['world'] }), /unavailable/); assert.equal(signal.aborted, true);
});

test('topic preferences and reading markers validate, bound and expire without retaining headline text', () => {
  assert.deepEqual(News.preferences(null), { topics: ['local', 'business', 'world', 'technology'], limit: 12, unreadOnly: false });
  assert.deepEqual(News.preferences({ topics: ['science', 'unknown'], limit: 6, unreadOnly: true }), { topics: ['science'], limit: 6, unreadOnly: true });
  const items = Array.from({ length: 300 }, (_, index) => ({ id: 'story_' + index.toString(36), at: NOW - index, headline: 'Not persisted' }));
  const clean = News.readItems([...items, { id: 'bad', at: NOW }, { id: 'story_old', at: NOW - 31 * 86400000 }, { id: 'story_future', at: NOW + 86400000 }], NOW);
  assert.equal(clean.length, 250); assert.ok(clean.every(item => Object.keys(item).sort().join(',') === 'at,id'));
});


test('renamed syndication bridges merge both existing duplicate groups and all topic tags', () => {
  const result = News.rankArticles([
    story('First title', { link: 'https://one.example/a', topics: ['technology'] }),
    story('Second title', { link: 'https://two.example/b', topics: ['business'] }),
    story('First title', { link: 'https://two.example/b', topics: ['science'], pubDate: '2026-10-12T17:30:00Z' }),
    story('Second title', { link: 'https://third.example/c', topics: ['world'] })
  ], { now: NOW });
  assert.equal(result.articles.length, 1); assert.equal(result.duplicateCount, 3);
  assert.equal(result.articles[0].pubDate, '2026-10-12T17:30:00.000Z');
  assert.deepEqual(result.articles[0].topics.sort(), ['business', 'science', 'technology', 'world']);
});

test('oversized and malformed feeds are isolated while usable feeds survive and transports close', async () => {
  const signals = []; let cancelled = false, released = false;
  const service = createNewsService({ now: () => NOW, fetchImpl: async (url, options) => {
    signals.push(options.signal);
    const query = new URL(url).searchParams.get('q');
    if (query.startsWith('world')) return { ok: true, headers: { get: () => String(MAX_XML_BYTES + 1) } };
    if (query.startsWith('business')) return { ok: true, body: { getReader: () => ({ read: async () => ({ value: Buffer.alloc(MAX_XML_BYTES + 1), done: false }), cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; } }) } };
    if (query.startsWith('science')) return response('<html>Not a feed</html>');
    return response(rss(item('Usable', '<pubDate>Mon, 12 Oct 2026 17:00:00 GMT</pubDate>')));
  } });
  const result = await service.fetchBundle({ topics: ['world', 'business', 'science', 'technology'] });
  assert.equal(result.coverage.failedFeeds, 3); assert.equal(result.articles.length, 1);
  assert.ok(cancelled && released); assert.ok(signals.every(signal => signal.aborted));
});
