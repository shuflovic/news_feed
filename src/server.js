// src/server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetcher = require('./utils/fetcher');
const ai = require('./utils/ai');



const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Define paths
const sourcesPath = path.join(__dirname, 'data/sources.json');
const articlesPath = path.join(__dirname, 'data/articles.json');

// ---------- Initialize data files ----------
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(sourcesPath)) {
  fs.writeFileSync(sourcesPath, '[]');
}
if (!fs.existsSync(articlesPath)) {
  fs.writeFileSync(articlesPath, '[]');
}

// Auto-fetch articles on server startup
setTimeout(() => {
  console.log('Auto-fetching articles on server startup...');
  fetchArticles()
    .then(result => {
      console.log('Startup fetch result:', result.message);
    })
    .catch(err => {
      console.error('Startup fetch error:', err.message);
      // Continue server operation even if fetch fails
    });
}, 1000); // Wait 1 second for server to fully start

// ---------- API ----------
// 1️⃣ Get current sources
app.get('/api/sources', (req, res) => {
  try {
    const src = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    res.json(src);
  } catch (e) {
    console.error('Error reading sources:', e);
    res.status(500).json({ error: 'Failed to read sources' });
  }
});

// 2️⃣ Add a new source
app.post('/api/sources', (req, res) => {
  try {
    const { name, url, type } = req.body;
    if (!name || !url || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    const id = Date.now();
    sources.push({ id, name, url, type, enabled: true });
    fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2));
    res.json({ success: true, id });
  } catch (e) {
    console.error('Error adding source:', e);
    res.status(500).json({ error: 'Failed to add source' });
  }
});

// 2b️⃣ Delete a source
app.delete('/api/sources/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    let sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    sources = sources.filter(s => s.id !== id);
    fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2));
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting source:', e);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

// 3️⃣ Get the feed (latest articles)
app.get('/api/feed', (req, res) => {
  try {
    const articles = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
    // newest first
    articles.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    res.json(articles);
  } catch (e) {
    console.error('Error reading articles:', e);
    res.status(500).json({ error: 'Failed to read articles' });
  }
});

// 4️⃣ Stock data endpoint (fetching real data from Yahoo Finance)
const STOCKS = ['TSLA', 'BTC-USD', 'TOY.TO', '^GSPC'];

async function fetchYahooFinance(symbol) {
  console.log(`[DEBUG] Starting fetch for ${symbol}`);
  console.log(`[DEBUG] typeof fetch: ${typeof fetch}`);
  console.log(`[DEBUG] typeof globalThis.fetch: ${typeof globalThis.fetch}`);
  try {
    // Using Yahoo Finance chart API via a proxy approach
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const meta = result.meta;
      const timestamps = result.timestamp;
      const prices = result.indicators.quote[0].close;
      
      const currentPrice = meta.regularMarketPrice || prices[prices.length - 1];
      const previousPrice = prices[prices.length - 2] || prices[prices.length - 1];
      const change = currentPrice - previousPrice;
      const changePercent = (change / previousPrice) * 100;
      
      return {
        symbol: symbol,
        price: currentPrice,
        change: change,
        changePercent: changePercent,
        currency: meta.currency || 'USD',
        timestamp: new Date().toISOString()
      };
    }
    
    throw new Error('Invalid response format');
  } catch (error) {
    console.error(`Error fetching ${symbol}:`, error.message);
    return null;
  }
}

// Get all stocks
app.get('/api/stocks', async (req, res) => {
  try {
    const results = await Promise.all(STOCKS.map(fetchYahooFinance));
    const stocks = results.filter(s => s !== null);
    res.json(stocks);
  } catch (e) {
    console.error('Error fetching stocks:', e);
    res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

// Get single stock (for backward compatibility)
app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const stock = await fetchYahooFinance(symbol);
    
    if (!stock) {
      return res.status(404).json({ error: 'Symbol not found' });
    }
    
    res.json(stock);
  } catch (e) {
    console.error('Error fetching stock:', e);
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

// ---------- Manual Fetch Endpoint ----------
let isRunning = false;
const MAX_ARTICLES = 200;

async function fetchArticles() {
  if (isRunning) {
    return { success: false, message: 'Fetch already in progress' };
  }
  
  isRunning = true;
  console.log('Starting manual fetch...');
  
  try {
    const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    let articles = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
    let newCount = 0;

    for (const src of sources.filter(s => s.enabled)) {
      try {
        console.log(`Fetching from ${src.name}...`);
        const items = await fetcher.fetchSource(src);
        
        for (const it of items) {
          // skip if already stored (by link)
          if (articles.find(a => a.link === it.link)) continue;

          const summary = await ai.summarize(it.content);
          articles.push({
            sourceId: src.id,
            sourceName: src.name,
            title: it.title,
            link: it.link,
            published_at: it.published,
            summary,
            fetched_at: new Date().toISOString()
          });
          newCount++;
        }
      } catch (e) {
        console.error(`Error processing ${src.name}:`, e.message);
      }
    }

    // Keep only the most recent articles
    if (articles.length > MAX_ARTICLES) {
      articles = articles
        .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at))
        .slice(0, MAX_ARTICLES);
    }

    fs.writeFileSync(articlesPath, JSON.stringify(articles, null, 2));
    console.log(`Fetch complete. Total articles: ${articles.length}, New: ${newCount}`);
    return { success: true, message: `Fetched ${newCount} new articles. Total: ${articles.length}` };
  } catch (e) {
    console.error('Error in fetch:', e.message);
    return { success: false, message: e.message };
  } finally {
    isRunning = false;
  }
}

app.post('/api/fetch', async (req, res) => {
  const result = await fetchArticles();
  // If it's a form submission (browser), redirect back to text view
  if (req.headers['content-type']?.includes('application/x-www-form-urlencoded') || !req.headers['accept']?.includes('application/json')) {
    res.redirect('/text');
  } else {
    res.json(result);
  }
});

// ---------- Text/Terminal-friendly endpoints ----------
app.get('/text/plain', (req, res) => {
  try {
    const articles = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
    articles.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    
    // Find the most recent fetch time
    let lastUpdated = 'Never';
    if (articles.length > 0) {
      const lastFetch = articles
        .map(a => new Date(a.fetched_at))
        .sort((a, b) => b - a)[0];
      lastUpdated = lastFetch.toLocaleString();
    }
    
    let text = '=== NEWS FEED ===\n\n';
    text += `Total articles: ${articles.length}\n`;
    text += `Last updated: ${lastUpdated}\n`;
    text += `Generated: ${new Date().toLocaleString()}\n`;
    text += '\n' + '='.repeat(80) + '\n\n';
    
    if (articles.length === 0) {
      text += 'No articles yet. Add sources and POST to /api/fetch to load them.\n';
    } else {
      for (let i = 0; i < articles.length; i++) {
        const a = articles[i];
        const date = new Date(a.published_at).toLocaleString();
        text += `${i + 1}. ${a.title}\n`;
        text += `   Source: ${a.sourceName} | ${date}\n`;
        text += `   Link: ${a.link}\n`;
        text += `   ${a.summary.replace(/\n/g, ' ')}\n`;
        text += '\n' + '-'.repeat(80) + '\n\n';
      }
    }
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (e) {
    console.error('Error generating plain text view:', e);
    res.status(500).send('Error loading feed\n');
  }
});

app.get('/text', (req, res) => {
  try {
    const articles = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
    articles.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    
    // Find the most recent fetch time
    let lastUpdated = 'Never';
    if (articles.length > 0) {
      const lastFetch = articles
        .map(a => new Date(a.fetched_at))
        .sort((a, b) => b - a)[0];
      lastUpdated = lastFetch.toLocaleString();
    }
    
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>News Feed - Text Mode</title>
  <style>
    body { font-family: monospace; line-height: 1.6; max-width: 80ch; margin: 2rem auto; padding: 0 1rem; }
    h1 { border-bottom: 2px solid #000; padding-bottom: 0.5rem; margin-bottom: 0.5rem; }
    .last-updated-line { font-weight: bold; color: #0066cc; margin: 0.5rem 0 1rem 0; }
    h2 { margin-top: 2rem; }
    .article { margin: 2rem 0; border-bottom: 1px solid #ccc; padding-bottom: 1rem; }
    .meta { color: #666; font-size: 0.9em; }
    a { color: #0066cc; text-decoration: underline; }
    a:hover { background: #0066cc; color: #fff; }
    .nav { margin: 1rem 0; padding: 1rem; background: #f5f5f5; }
    .nav a { margin-right: 2rem; }
  </style>
</head>
<body>
  <h1>News Feed - Text Mode</h1>
  <p class="last-updated-line">Last updated: ${lastUpdated}</p>
  <div class="nav">
    <a href="/graphical">[Graphical Version]</a>
    <a href="/text">[Refresh]</a>
    <form method="POST" action="/api/fetch" style="display:inline;" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Fetching...';">
      <button type="submit" style="font-family:monospace;cursor:pointer;">[Fetch Articles]</button>
    </form>
    <span>Articles: ${articles.length}</span>
  </div>
  
  <main>`;
    
    if (articles.length === 0) {
      html += '<p>No articles yet. Add sources and click "Fetch Articles" to load them.</p>';
    } else {
      for (const a of articles) {
        const date = new Date(a.published_at).toLocaleString();
        html += `
  <article class="article">
    <h2><a href="${a.link}">${escapeHtml(a.title)}</a></h2>
    <p>${escapeHtml(a.summary)}</p>
    <p class="meta">${escapeHtml(date)} | Source: ${escapeHtml(a.sourceName)}</p>
  </article>`;
      }
    }
    
    html += `
  </main>
  
  <footer>
    <p>-- End of feed --</p>
    <p><a href="#">[Back to top]</a></p>
  </footer>
</body>
</html>`;
    
    res.send(html);
  } catch (e) {
    console.error('Error generating text view:', e);
    res.status(500).send('<h1>Error loading feed</h1>');
  }
});

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------- Serve the frontend ----------
app.use(express.static(path.join(__dirname, '../public')));

// Redirect root to text view (default)
app.get('/', (req, res) => {
  res.redirect('/text');
});

// Graphical version
app.get('/graphical', (req, res) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('<h1>404 - Not Found</h1>');
  }
});

// Catch-all for SPA routing
app.use((req, res) => {
  res.status(404).send('<h1>404 - Not Found</h1>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Text mode is default. Use /graphical for the graphical version.');
});