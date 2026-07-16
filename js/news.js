/* ============================================
   OLANGA — NEWS BRIEF (RSS bundle via main process + NVIDIA chat)
   ============================================ */

const newsModelSelect = document.getElementById('newsModelSelect');
const newsRefreshBtn = document.getElementById('newsRefreshBtn');
const newsExportBtn = document.getElementById('newsExportBtn');
const newsAiToggleBtn = document.getElementById('newsAiToggleBtn');
const newsTopicChips = document.querySelectorAll('.news-topic-chip');
const newsAiSidebar = document.getElementById('newsAiSidebar');
const newsAiCloseBtn = document.getElementById('newsAiCloseBtn');
const newsAiChat = document.getElementById('newsAiChat');
const newsAiInput = document.getElementById('newsAiInput');
const newsAiSendBtn = document.getElementById('newsAiSendBtn');
const newsAiModelSelect = document.getElementById('newsAiModelSelect');
const newsAiStatusDot = document.getElementById('newsAiStatusDot');
const newsAiStatusText = document.getElementById('newsAiStatusText');
const newsArticle = document.getElementById('newsArticle');
const newsEmptyState = document.getElementById('newsEmptyState');
const newsLocationBadge = document.getElementById('newsLocationBadge');
const newsUpdatedBadge = document.getElementById('newsUpdatedBadge');
const newsSourceBadge = document.getElementById('newsSourceBadge');

let newsBriefData = null;
let newsBundleData = null;
let newsAiChatHistory = [];
let newsAiChatSummary = '';
let newsAiSidebarOpen = false;
let newsLastLocationKey = '';
const defaultNewsTopics = ['local', 'business', 'world', 'technology'];

function getNewsModelName(selectedModel) {
  return 'meta/llama-3.1-8b-instruct';
}

function getSavedLocationLabel() {
  const city = (localStorage.getItem('olanga_city') || '').trim();
  const state = (localStorage.getItem('olanga_state') || '').trim();
  const country = (localStorage.getItem('olanga_country') || '').trim();
  const parts = [city, state, country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'your area';
}

function getSavedLocationKey() {
  const city = (localStorage.getItem('olanga_city') || '').trim();
  const state = (localStorage.getItem('olanga_state') || '').trim();
  const country = (localStorage.getItem('olanga_country') || '').trim();
  return [city, state, country].filter(Boolean).join('|').toLowerCase();
}

function getSelectedNewsTopics() {
  if (!newsTopicChips || newsTopicChips.length === 0) {
    return [...defaultNewsTopics];
  }

  const selectedTopics = Array.from(newsTopicChips)
    .filter((chip) => chip.classList.contains('active'))
    .map((chip) => chip.getAttribute('data-topic'))
    .filter(Boolean);

  return selectedTopics.length > 0 ? selectedTopics : [...defaultNewsTopics];
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractJsonPayload(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

function normalizeNewsArticleData(articleData, fallbackLocationLabel) {
  const safeSection = (section) => ({
    heading: String(section?.heading || 'Update').trim(),
    paragraphs: Array.isArray(section?.paragraphs)
      ? section.paragraphs.map((paragraph) => String(paragraph || '').trim()).filter(Boolean)
      : [],
    bullets: Array.isArray(section?.bullets)
      ? section.bullets.map((bullet) => String(bullet || '').trim()).filter(Boolean)
      : []
  });

  const sections = Array.isArray(articleData?.sections) ? articleData.sections.map(safeSection).filter(section => section.heading || section.paragraphs.length || section.bullets.length) : [];
  const sources = Array.isArray(articleData?.sources) ? articleData.sources.map(source => String(source || '').trim()).filter(Boolean) : [];
  const watchList = Array.isArray(articleData?.watchList) ? articleData.watchList.map(item => String(item || '').trim()).filter(Boolean) : [];
  const sourceArticles = Array.isArray(articleData?.sourceArticles) ? articleData.sourceArticles : [];

  return {
    kicker: String(articleData?.kicker || 'Today\'s briefing').trim(),
    title: String(articleData?.title || 'Your personalized news brief').trim(),
    dek: String(articleData?.dek || 'A polished five-minute read on what matters today.').trim(),
    intro: String(articleData?.intro || '').trim(),
    sections,
    localAngle: String(articleData?.localAngle || `We looked for stories that matter around ${fallbackLocationLabel}.`).trim(),
    watchList,
    closing: String(articleData?.closing || 'We\'ll keep the briefing fresh as new headlines come in.').trim(),
    sources,
    sourceArticles,
    locationLabel: fallbackLocationLabel,
    generatedAt: articleData?.generatedAt || new Date().toISOString(),
    topics: Array.isArray(articleData?.topics) ? articleData.topics : []
  };
}

function buildNewsArticleHtml(articleData) {
  const sections = Array.isArray(articleData?.sections) ? articleData.sections : [];
  const sourceArticles = Array.isArray(articleData?.sourceArticles) ? articleData.sourceArticles : [];
  const watchList = Array.isArray(articleData?.watchList) ? articleData.watchList : [];
  const sources = Array.isArray(articleData?.sources) ? articleData.sources : [];

  const sectionHtml = sections.map((section) => {
    const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : [];
    const bullets = Array.isArray(section.bullets) ? section.bullets : [];
    return `
      <section class="news-section">
        <h3>${escapeHtml(section.heading || 'Update')}</h3>
        ${paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('')}
        ${bullets.length > 0 ? `<ul class="news-bullets">${bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
      </section>
    `;
  }).join('');

  const sourcePills = sourceArticles.slice(0, 8).map((article) => {
    const label = article.source || 'Source';
    const title = article.title || 'Story';
    const link = article.link ? `<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title);
    return `<span class="news-source-pill">${escapeHtml(label)}: ${link}</span>`;
  }).join('');

  const watchListHtml = watchList.length > 0 ? `
    <section class="news-callout">
      <h3>What to watch next</h3>
      <p>${escapeHtml(watchList.join(' '))}</p>
    </section>
  ` : '';

  const localAngleHtml = articleData?.localAngle ? `
    <section class="news-callout">
      <h3>Why this matters near you</h3>
      <p>${escapeHtml(articleData.localAngle)}</p>
    </section>
  ` : '';

  return `
    <div class="news-hero">
      <span class="news-kicker">${escapeHtml(articleData?.kicker || 'Today\'s briefing')}</span>
      <h1 class="news-headline">${escapeHtml(articleData?.title || 'Your personalized news brief')}</h1>
      <p class="news-deck">${escapeHtml(articleData?.dek || 'A polished five-minute read on what matters today.')}</p>
    </div>
    ${articleData?.intro ? `<section class="news-section"><p>${escapeHtml(articleData.intro)}</p></section>` : ''}
    ${sectionHtml}
    ${localAngleHtml}
    ${watchListHtml}
    ${articleData?.closing ? `<section class="news-section"><p>${escapeHtml(articleData.closing)}</p></section>` : ''}
    <section class="news-section">
      <h3>Sources</h3>
      <div class="news-source-row">${sourcePills || '<span class="news-source-pill">No sources available</span>'}</div>
    </section>
    ${sources.length > 0 ? `<section class="news-section"><h3>Source notes</h3>${sources.map(source => `<p>${escapeHtml(source)}</p>`).join('')}</section>` : ''}
  `;
}

function renderNewsBrief(articleData) {
  if (!newsArticle || !newsEmptyState) return;
  newsBriefData = articleData;
  newsEmptyState.classList.add('hidden');
  newsArticle.classList.toggle('hidden', !articleData);

  if (!articleData) {
    newsArticle.innerHTML = '';
    return;
  }

  newsArticle.innerHTML = buildNewsArticleHtml(articleData);
  if (newsLocationBadge) {
    newsLocationBadge.textContent = articleData.locationLabel || getSavedLocationLabel();
  }
  if (newsUpdatedBadge) {
    const generatedAt = articleData.generatedAt ? new Date(articleData.generatedAt) : new Date();
    newsUpdatedBadge.textContent = `Updated ${generatedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  if (newsSourceBadge) {
    const count = Array.isArray(articleData.sourceArticles) ? articleData.sourceArticles.length : 0;
    newsSourceBadge.textContent = `${count} headline${count === 1 ? '' : 's'} used`;
  }
}

async function loadNewsBrief(forceRefresh = false) {
  const locationKey = getSavedLocationKey();
  if (!forceRefresh && newsBriefData && newsLastLocationKey === locationKey && newsBriefData.title) {
    return;
  }

  if (newsArticle) {
    newsArticle.classList.add('hidden');
  }
  if (newsUpdatedBadge) {
    newsUpdatedBadge.classList.remove('hidden');
    newsUpdatedBadge.textContent = 'Refreshing…';
  }

  const locationPayload = {
    city: localStorage.getItem('olanga_city') || '',
    state: localStorage.getItem('olanga_state') || '',
    country: localStorage.getItem('olanga_country') || '',
    topics: getSelectedNewsTopics()
  };

  try {
    const bundle = await window.electronAPI.fetchNewsBundle(locationPayload);
    newsBundleData = bundle;
    const modelName = getNewsModelName('fast');
    const locationLabel = bundle.locationLabel || getSavedLocationLabel();
    const selectedTopics = bundle.topics || getSelectedNewsTopics();
    const sourceSummary = bundle.articles.map((article, index) => `${index + 1}. [${article.source}] ${article.title}${article.description ? ` — ${article.description}` : ''}`).join('\n');

    const systemPrompt = `You are a polished newsroom editor. Write a beautifully structured, balanced, and friendly five-minute news read.
Use only the supplied headlines and descriptions. Do not invent facts, names, dates, or quotes.
National headlines matter most; local context is secondary and should be a short closing angle.
Tailor the piece to a reader in ${locationLabel}.
Prioritize stories from the last 24 hours, and focus especially on today's developments and the past day.
Center the piece on these reader interests: ${selectedTopics.join(', ')}.
Keep the tone immediate, practical, and personal to the reader's location.
Return ONLY valid JSON with this schema:
{
  "kicker": "string",
  "title": "string",
  "dek": "string",
  "intro": "string",
  "sections": [
    {
      "heading": "string",
      "paragraphs": ["string"],
      "bullets": ["string"]
    }
  ],
  "localAngle": "string",
  "watchList": ["string"],
  "closing": "string",
  "sources": ["string"]
}
Formatting rules:
- Return JSON only, with no markdown fences, no backticks, and no commentary.
- Each section should contain 2-4 short paragraphs and optional bullets.
- Keep paragraphs plain text without markdown markup.
- Keep the total article around 700-1000 words.
- Put the biggest national story first, then the most relevant follow-ups.`;

    const userPrompt = `Location: ${locationLabel}
Generated at: ${new Date().toLocaleString()}
Topics of interest: ${selectedTopics.join(', ')}
Headlines and descriptions:
${sourceSummary || 'No headlines were returned.'}`;

    const data = await callNvidiaChat(modelName, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.5, max_tokens: 2400 });

    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonPayload(content);
    const articleData = normalizeNewsArticleData(parsed || {
      kicker: 'Today\'s briefing',
      title: 'Current news update',
      dek: 'The latest headlines, trimmed into a readable digest.',
      intro: content,
      sections: [],
      localAngle: `We looked for stories that matter around ${locationLabel}.`,
      watchList: [],
      closing: 'We\'ll keep the briefing fresh as new headlines come in.',
      sources: bundle.articles.slice(0, 8).map(article => `${article.source}: ${article.title}`),
      sourceArticles: bundle.articles
    }, locationLabel);
    articleData.generatedAt = bundle.generatedAt || new Date().toISOString();
    articleData.sourceArticles = bundle.articles;
    articleData.topics = selectedTopics;
    renderNewsBrief(articleData);
    newsLastLocationKey = locationKey;
    if (newsUpdatedBadge) {
      newsUpdatedBadge.classList.add('hidden');
    }
  } catch (error) {
    console.error('[Olanga] Failed to generate news brief:', error);
    if (newsUpdatedBadge) {
      newsUpdatedBadge.textContent = 'Failed to load';
    }
    renderNewsBrief(normalizeNewsArticleData({
      locationLabel: getSavedLocationLabel(),
      generatedAt: new Date().toISOString(),
      title: 'News brief unavailable',
      dek: 'We could not load current headlines right now.',
      intro: `Error: ${error.message}`,
      sections: [],
      localAngle: 'Check your connection and try refresh again.',
      watchList: [],
      closing: 'Once the connection is back, we can generate the full briefing.',
      sources: [],
      sourceArticles: []
    }, getSavedLocationLabel()));
    if (newsUpdatedBadge) {
      newsUpdatedBadge.classList.remove('hidden');
    }
  }
}

function getNewsAssistantSystemPrompt() {
  const locationLabel = getSavedLocationLabel();
  const articleText = newsBriefData ? JSON.stringify(newsBriefData, null, 2) : 'No article loaded yet.';
  const bundleText = newsBundleData ? JSON.stringify(newsBundleData.articles || [], null, 2) : 'No news bundle loaded yet.';
  return `You are a helpful news assistant for Olanga.
Use the current brief and news bundle to answer the user's question clearly and concisely.
Tailor answers to ${locationLabel}.
If the user asks about a headline, cite the relevant story from the bundle.
If they ask for a summary, keep it conversational and grounded in the loaded article.

Current article JSON:
${articleText}

Current headline bundle:
${bundleText}`;
}

function setNewsAiStatusIdle() {
  if (newsAiStatusDot) newsAiStatusDot.classList.remove('working', 'error');
  if (newsAiStatusText) newsAiStatusText.textContent = 'Idle';
  if (newsAiSendBtn) newsAiSendBtn.disabled = false;
}

function addNewsAiMessage(text, type) {
  if (!newsAiChat) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = `notepad-ai-message ${type}-message`;

  const label = document.createElement('span');
  label.className = 'notepad-ai-label';
  label.textContent = type === 'user' ? 'You' : 'AI';

  const textP = document.createElement('p');
  textP.className = 'notepad-ai-text';
  textP.textContent = type === 'ai' ? stripMarkdown(text) : text;

  messageDiv.appendChild(label);
  messageDiv.appendChild(textP);
  newsAiChat.appendChild(messageDiv);
  newsAiChat.scrollTop = newsAiChat.scrollHeight;

  newsAiChatHistory.push({ role: type === 'user' ? 'user' : 'assistant', content: text });
  if (newsAiChatHistory.length > 12) {
    newsAiChatHistory = newsAiChatHistory.slice(-8);
  }
}

async function sendNewsAiMessage() {
  const message = newsAiInput ? newsAiInput.value.trim() : '';
  if (!message) return;

  if (newsAiStatusDot) newsAiStatusDot.classList.add('working');
  if (newsAiStatusText) newsAiStatusText.textContent = 'Working...';
  if (newsAiSendBtn) newsAiSendBtn.disabled = true;

  addNewsAiMessage(message, 'user');
  if (newsAiInput) newsAiInput.value = '';

  try {
    const recentHistory = newsAiChatHistory.slice(-5);
    const messages = [
      { role: 'system', content: getNewsAssistantSystemPrompt() },
      ...recentHistory,
      { role: 'user', content: message }
    ];
    const data = await callNvidiaChat('meta/llama-3.1-8b-instruct', messages, { temperature: 0.4, max_tokens: 900 });
    const aiResponse = data?.choices?.[0]?.message?.content || 'I could not generate a response.';
    addNewsAiMessage(aiResponse, 'ai');
  } catch (error) {
    console.error('[Olanga] News assistant error:', error);
    addNewsAiMessage(`Sorry, I encountered an error: ${error.message}.`, 'ai');
    if (newsAiStatusDot) newsAiStatusDot.classList.add('error');
    if (newsAiStatusText) newsAiStatusText.textContent = 'Error';
  } finally {
    setNewsAiStatusIdle();
  }
}

function exportNewsBrief() {
  if (!newsBriefData || !newsArticle) {
    alert('The news brief is not ready yet.');
    return;
  }

  const title = newsBriefData.title || 'Olanga News Brief';
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body style="font-family: Arial, sans-serif; line-height: 1.6; color:#111; max-width: 860px; margin: 40px auto; padding: 0 20px;">
  ${newsArticle.innerHTML}
  </body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `olanga-news-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

if (newsAiToggleBtn && newsAiSidebar) {
  newsAiToggleBtn.addEventListener('click', () => {
    newsAiSidebarOpen = !newsAiSidebarOpen;
    newsAiSidebar.classList.toggle('hidden', !newsAiSidebarOpen);
  });
}

if (newsAiCloseBtn && newsAiSidebar) {
  newsAiCloseBtn.addEventListener('click', () => {
    newsAiSidebarOpen = false;
    newsAiSidebar.classList.add('hidden');
  });
}

if (newsRefreshBtn) {
  newsRefreshBtn.addEventListener('click', () => loadNewsBrief(true));
}

if (newsExportBtn) {
  newsExportBtn.addEventListener('click', exportNewsBrief);
}

if (newsModelSelect) {
  newsModelSelect.addEventListener('change', () => loadNewsBrief(true));
}

if (newsTopicChips && newsTopicChips.length > 0) {
  newsTopicChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      const selectedCount = Array.from(newsTopicChips).filter((node) => node.classList.contains('active')).length;
      if (selectedCount === 0) {
        defaultNewsTopics.forEach((topic) => {
          const topicChip = Array.from(newsTopicChips).find((node) => node.getAttribute('data-topic') === topic);
          if (topicChip) topicChip.classList.add('active');
        });
      }
      loadNewsBrief(true).catch((error) => {
        console.warn('[Olanga] Failed to refresh news after topic change:', error.message);
      });
    });
  });
}

if (newsAiSendBtn) {
  newsAiSendBtn.addEventListener('click', sendNewsAiMessage);
}

if (newsAiInput) {
  newsAiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendNewsAiMessage();
    }
  });
}
