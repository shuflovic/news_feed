// src/utils/fetcher.js
const Parser = require('rss-parser');
const parser = new Parser();

/**
 * Fetches a source and returns an array of items:
 * [{ title, link, published, content }]
 */
async function fetchSource(source) {
  // Very simple handling for RSS feeds only (extend later)
  if (source.type === 'rss') {
    const feed = await parser.parseURL(source.url);
    return feed.items.map(i => ({
      title: i.title,
      link: i.link,
      published: i.pubDate,
      content: i.contentSnippet || i.content || ''
    }));
  }
  // TODO: add JSON/HTML handling
  return [];
}

module.exports = { fetchSource };
