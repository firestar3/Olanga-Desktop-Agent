const https = require('https');
const searchTerm = "Ed Sheeran Shape of You";
const query = encodeURIComponent(`site:open.spotify.com/track ${searchTerm}`);

https.get(`https://html.duckduckgo.com/html/?q=${query}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const match = data.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
    if (match && match[1]) {
      console.log(`spotify:track:${match[1]}`);
    } else {
      console.log("Not found via scraping, would fallback to search");
    }
  });
}).on('error', (e) => {
  console.log("Error", e);
});
