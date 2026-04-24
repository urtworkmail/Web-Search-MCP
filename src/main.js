/**
 * Web Search MCP Server
 * Apify Actor that runs a persistent MCP (Model Context Protocol) server
 * giving AI assistants real-time web search capabilities.
 *
 * Tools exposed:
 *   - search_web        Search the web via DuckDuckGo or Brave Search
 *   - search_news       Search for recent news articles
 *   - fetch_page        Fetch and extract text content from any URL
 *
 * Connect your MCP client (Claude Desktop, Cursor, etc.) to the /sse endpoint
 * printed in the actor log once the server starts.
 */

import { Actor, log } from 'apify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import got from 'got';
import * as cheerio from 'cheerio';
import { z } from 'zod';

// ─── Constants ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.ACTOR_STANDBY_PORT ?? 3000);
const SERVER_VERSION = '1.0.0';
const USER_AGENT =
  'Mozilla/5.0 (compatible; ApifyWebSearchMCP/1.0; +https://apify.com)';

// ─── Init ─────────────────────────────────────────────────────────────────────
await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  defaultMaxResults = 10,
  braveApiKey = null,
  enableFetchTool = true,
  enableNewsTool = true,
  allowedDomains = [],
  logSearches = false,
} = input;

log.info('Starting Web Search MCP Server', {
  port: PORT,
  engine: braveApiKey ? 'Brave Search' : 'DuckDuckGo',
  enableFetchTool,
  enableNewsTool,
});

// ─── Search helpers ───────────────────────────────────────────────────────────

/**
 * Search DuckDuckGo HTML interface (no API key required).
 */
async function searchDuckDuckGo(query, maxResults = 10, safeSearch = 'moderate') {
  const safeMap = { strict: '1', moderate: '-1', off: '-2' };
  const params = new URLSearchParams({
    q: query,
    b: '',
    kl: 'wt-wt',
    kp: safeMap[safeSearch] ?? '-1',
  });

  const response = await got.post('https://html.duckduckgo.com/html/', {
    form: { q: query, b: '', kl: 'wt-wt' },
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
    timeout: { request: 15000 },
  });

  const $ = cheerio.load(response.body);
  const results = [];

  $('.result__body').each((i, el) => {
    if (results.length >= maxResults) return false;

    const titleEl = $(el).find('.result__a');
    const snippetEl = $(el).find('.result__snippet');
    const urlEl = $(el).find('.result__url');

    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();
    let url = titleEl.attr('href') ?? '';

    // DDG wraps links — extract the real URL
    if (url.startsWith('/l/?')) {
      try {
        const parsed = new URL('https://duckduckgo.com' + url);
        url = parsed.searchParams.get('uddg') ?? url;
      } catch { /* keep as-is */ }
    }

    if (title && url && !url.startsWith('//duckduckgo')) {
      results.push({ title, url, snippet, position: results.length + 1 });
    }
  });

  return results;
}

/**
 * Search using the Brave Search API (requires API key).
 */
async function searchBrave(query, maxResults = 10, type = 'web') {
  const endpoint =
    type === 'news'
      ? 'https://api.search.brave.com/res/v1/news/search'
      : 'https://api.search.brave.com/res/v1/web/search';

  const response = await got
    .get(endpoint, {
      searchParams: { q: query, count: Math.min(maxResults, 20) },
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveApiKey,
      },
      timeout: { request: 15000 },
    })
    .json();

  const items =
    type === 'news'
      ? (response.results ?? [])
      : (response.web?.results ?? []);

  return items.slice(0, maxResults).map((r, i) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? r.extra_snippets?.[0] ?? '',
    position: i + 1,
    ...(r.age ? { publishedAt: r.age } : {}),
  }));
}

/**
 * Unified search — uses Brave if key available, falls back to DuckDuckGo.
 */
async function search(query, maxResults, type = 'web') {
  if (braveApiKey) {
    return searchBrave(query, maxResults, type);
  }
  if (type === 'news') {
    return searchDuckDuckGo(`${query} news`, maxResults);
  }
  return searchDuckDuckGo(query, maxResults);
}

/**
 * Fetch a page and return clean text content.
 */
async function fetchPageContent(url, maxLength = 8000) {
  // Domain whitelist check
  if (allowedDomains.length > 0) {
    try {
      const hostname = new URL(url).hostname;
      const allowed = allowedDomains.some(
        (d) => hostname === d || hostname.endsWith(`.${d}`)
      );
      if (!allowed) {
        return `Error: Domain "${hostname}" is not in the allowed domains list.`;
      }
    } catch {
      return 'Error: Invalid URL provided.';
    }
  }

  const response = await got.get(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: { request: 20000 },
    followRedirect: true,
  });

  const contentType = response.headers['content-type'] ?? '';

  // Return plain text/JSON as-is (trimmed)
  if (contentType.includes('text/plain') || contentType.includes('application/json')) {
    return response.body.slice(0, maxLength);
  }

  // Parse HTML
  const $ = cheerio.load(response.body);

  // Remove noise
  $('script, style, nav, footer, header, aside, noscript, iframe, [role="banner"]').remove();

  // Try to find main content
  const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
  let mainContent = '';
  for (const sel of mainSelectors) {
    const el = $(sel).first();
    if (el.length) {
      mainContent = el.text();
      break;
    }
  }

  const text = (mainContent || $('body').text())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  const title = $('title').text().trim();
  const description = $('meta[name="description"]').attr('content') ?? '';

  return `Title: ${title}\nDescription: ${description}\n\n${text}${text.length >= maxLength ? '\n\n[Content truncated]' : ''}`;
}

// ─── MCP Server setup ─────────────────────────────────────────────────────────

const mcpServer = new McpServer({
  name: 'web-search-mcp',
  version: SERVER_VERSION,
});

// Tool: search_web
mcpServer.tool(
  'search_web',
  'Search the web and return a list of relevant results with titles, URLs and snippets.',
  {
    query: z.string().min(1).max(500).describe('The search query'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(defaultMaxResults)
      .describe('Number of results to return (1–50)'),
    safeSearch: z
      .enum(['strict', 'moderate', 'off'])
      .optional()
      .default('moderate')
      .describe('Safe-search level'),
  },
  async ({ query, maxResults = defaultMaxResults, safeSearch = 'moderate' }) => {
    log.info('search_web called', { query, maxResults });

    let results;
    try {
      results = await search(query, maxResults, 'web');
    } catch (err) {
      log.error('search_web failed', { err: err.message });
      return {
        content: [{ type: 'text', text: `Search failed: ${err.message}` }],
        isError: true,
      };
    }

    if (logSearches) {
      await Actor.pushData({
        query,
        engine: braveApiKey ? 'brave' : 'duckduckgo',
        type: 'web',
        resultsCount: results.length,
        timestamp: new Date().toISOString(),
      });
    }

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No results found for this query.' }],
      };
    }

    const formatted = results
      .map(
        (r) =>
          `[${r.position}] ${r.title}\nURL: ${r.url}\n${r.snippet ? `Snippet: ${r.snippet}` : ''}`.trim()
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} results for "${query}":\n\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: search_news (optional)
if (enableNewsTool) {
  mcpServer.tool(
    'search_news',
    'Search for recent news articles on a topic.',
    {
      query: z.string().min(1).max(500).describe('News search query'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(Math.min(defaultMaxResults, 10))
        .describe('Number of news articles to return'),
    },
    async ({ query, maxResults = 10 }) => {
      log.info('search_news called', { query, maxResults });

      let results;
      try {
        results = await search(query, maxResults, 'news');
      } catch (err) {
        log.error('search_news failed', { err: err.message });
        return {
          content: [{ type: 'text', text: `News search failed: ${err.message}` }],
          isError: true,
        };
      }

      if (logSearches) {
        await Actor.pushData({
          query,
          engine: braveApiKey ? 'brave' : 'duckduckgo',
          type: 'news',
          resultsCount: results.length,
          timestamp: new Date().toISOString(),
        });
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No news articles found.' }],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `[${r.position}] ${r.title}${r.publishedAt ? ` (${r.publishedAt})` : ''}\nURL: ${r.url}\n${r.snippet ? `Summary: ${r.snippet}` : ''}`.trim()
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} news articles for "${query}":\n\n${formatted}`,
          },
        ],
      };
    }
  );
}

// Tool: fetch_page (optional)
if (enableFetchTool) {
  mcpServer.tool(
    'fetch_page',
    'Fetch a web page and return its cleaned text content. Useful for reading an article or documentation page in full.',
    {
      url: z.string().url().describe('Full URL of the page to fetch'),
      maxLength: z
        .number()
        .int()
        .min(500)
        .max(50000)
        .optional()
        .default(8000)
        .describe('Maximum characters of content to return'),
    },
    async ({ url, maxLength = 8000 }) => {
      log.info('fetch_page called', { url });

      let content;
      try {
        content = await fetchPageContent(url, maxLength);
      } catch (err) {
        log.error('fetch_page failed', { url, err: err.message });
        return {
          content: [
            { type: 'text', text: `Failed to fetch page: ${err.message}` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: content }],
      };
    }
  );
}

// ─── Express HTTP server ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Map of sessionId → SSEServerTransport (one per MCP client connection) */
const transports = new Map();

// MCP SSE endpoint — client connects here first
app.get('/sse', async (req, res) => {
  log.info('New MCP client connected', { ip: req.ip });

  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);

  res.on('close', () => {
    log.info('MCP client disconnected', { sessionId: transport.sessionId });
    transports.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
});

// MCP messages endpoint — client sends requests here
app.post('/messages', async (req, res) => {
  const { sessionId } = req.query;
  const transport = transports.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: 'MCP session not found. Connect to /sse first.' });
  }

  await transport.handlePostMessage(req, res, req.body);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'web-search-mcp',
    version: SERVER_VERSION,
    engine: braveApiKey ? 'brave' : 'duckduckgo',
    activeSessions: transports.size,
    tools: [
      'search_web',
      ...(enableNewsTool ? ['search_news'] : []),
      ...(enableFetchTool ? ['fetch_page'] : []),
    ],
  });
});

// Root info
app.get('/', (_req, res) => {
  res.json({
    name: 'Web Search MCP Server',
    version: SERVER_VERSION,
    mcpEndpoint: '/sse',
    messagesEndpoint: '/messages',
    healthEndpoint: '/health',
    instructions:
      'Add this server to your MCP client (e.g., Claude Desktop) using the SSE endpoint URL.',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, () => {
  const url = process.env.ACTOR_STANDBY_URL
    ? `${process.env.ACTOR_STANDBY_URL}`
    : `http://localhost:${PORT}`;

  log.info('═══════════════════════════════════════════════════════');
  log.info('  Web Search MCP Server is ready!');
  log.info(`  MCP SSE endpoint : ${url}/sse`);
  log.info(`  Health check     : ${url}/health`);
  log.info('  Add this to Claude Desktop config:');
  log.info('  {');
  log.info('    "mcpServers": {');
  log.info('      "web-search": {');
  log.info('        "command": "npx",');
  log.info('        "args": ["mcp-remote", "${url}/sse"]');
  log.info('      }');
  log.info('    }');
  log.info('  }');
  log.info('═══════════════════════════════════════════════════════');
});

// Fallback for SDK versions < 3.12.0
if (typeof Actor.standby === 'function') {
  await Actor.standby();
} else {
  log.warning('Actor.standby() is not available in SDK v3.7.0. Using manual stay-alive.');
  // This promise never resolves, keeping the Node.js process and Express server active.
  await new Promise(() => {}); 
}

// Note: In manual stay-alive mode, the code below will only execute on process termination
process.on('SIGINT', async () => {
  httpServer.close(async () => {
    log.info('HTTP server closed');
    await Actor.exit();
  });
});
