# Web Search MCP Server

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-brightgreen)](https://apify.com/actors)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

An Apify Actor that runs a persistent **Model Context Protocol (MCP) server**, giving AI assistants real-time web search capabilities. Connect Claude Desktop, Cursor, or any MCP-compatible AI client to search the web without leaving your workflow.

## Features

- 🔍 **search_web** — Search the web via DuckDuckGo (free, no key) or Brave Search (higher quality)
- 📰 **search_news** — Search for recent news articles
- 📄 **fetch_page** — Fetch and extract clean text content from any URL
- 🔐 **Domain whitelist** — Restrict `fetch_page` to approved domains
- 📊 **Audit log** — Optionally log all searches to an Apify dataset
- ⚡ **Always-on** — Runs in Apify Standby mode for persistent 24/7 availability

## Quick Start

### 1. Run on Apify

1. Go to the [Apify Console](https://console.apify.com) and find this actor
2. Click **Try for free** → configure inputs → **Start**
3. Copy the **Standby URL** from the actor run logs (looks like `https://web-search-mcp.username.apify.actor`)

### 2. Connect to Claude Desktop

Add the following to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-STANDBY-URL/sse"]
    }
  }
}
```

Restart Claude Desktop and you'll see the tools appear in the interface.

### 3. Connect to Cursor / other MCP clients

Set the SSE URL to: `https://YOUR-STANDBY-URL/sse`

## Input Configuration

| Parameter | Type | Default | Description |
|---|---|---|---|
| `defaultMaxResults` | integer | `10` | Default number of results returned per search |
| `braveApiKey` | string | — | Optional [Brave Search API key](https://brave.com/search/api/) for better results |
| `enableFetchTool` | boolean | `true` | Enable the `fetch_page` tool |
| `enableNewsTool` | boolean | `true` | Enable the `search_news` tool |
| `allowedDomains` | string[] | `[]` | Whitelist domains for `fetch_page` (empty = all allowed) |
| `logSearches` | boolean | `false` | Log all queries to the Apify dataset |

## MCP Tools Reference

### `search_web`

Search the web and get ranked results.

**Parameters:**
- `query` (string, required) — The search query
- `maxResults` (integer, optional, default: 10) — Number of results (1–50)
- `safeSearch` (enum, optional) — `strict`, `moderate`, or `off`

**Returns:** Ranked list of results with title, URL, and snippet.

---

### `search_news`

Search for recent news articles.

**Parameters:**
- `query` (string, required) — News search query
- `maxResults` (integer, optional) — Number of articles (1–20)

**Returns:** List of news articles with publication time when available.

---

### `fetch_page`

Fetch a web page and return its clean text content.

**Parameters:**
- `url` (string, required) — Full URL to fetch
- `maxLength` (integer, optional, default: 8000) — Max characters (500–50000)

**Returns:** Page title, meta description, and extracted body text.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/sse` | GET | MCP SSE connection endpoint |
| `/messages?sessionId=X` | POST | MCP message handler |
| `/health` | GET | Health check + active sessions |
| `/` | GET | Server info and instructions |

## Architecture

```
AI Client (Claude, Cursor, etc.)
        │ SSE connection
        ▼
  Express HTTP Server (:3000)
        │
  MCP Server (McpServer)
        │
  ┌─────┴──────────┐
  │   Search Tools  │
  └─────┬──────────┘
        │
  ┌─────┴─────────────────────┐
  │ DuckDuckGo HTML API        │ (default, no key needed)
  │ Brave Search REST API      │ (optional, with API key)
  └────────────────────────────┘
```

## Local Development

```bash
git clone https://github.com/your-org/web-search-mcp
cd web-search-mcp
npm install
npm start
```

The server starts on `http://localhost:3000`. Connect any MCP client to `http://localhost:3000/sse`.

## Example Usage (in Claude)

Once connected, you can ask Claude:

> *"Search for the latest news about AI regulations in Europe"*

> *"What are the top Python web frameworks in 2025? Search the web and summarize."*

> *"Fetch the content from https://example.com/blog/post and summarize the key points."*

## License

Apache 2.0 — see [LICENSE](LICENSE)
