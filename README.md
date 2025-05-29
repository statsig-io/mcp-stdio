# Statsig MCP Server

This server implements the Model Context Protocol (MCP) for Statsig API integration, supporting both stdio and SSE transports.

## Installation

```bash
npm install
npm run build
```

## Usage

### Integration with MCP Client Config

To use this server with an MCP client, configure your `mcp.json` as follows:

#### Using stdio transport (default)

```json
{
  "mcpServers": {
    "Statsig": {
      "command": "node /path/to/build/index.js",
      "env": {
        "STATSIG_API_KEY": "console-YOUR-CONSOLE-KEY"
      }
    }
  }
}
```

#### Using SSE transport

SSE protocols with some clients (for example, Cursor) today don't support headers. This server accepts requests with the Statsig API key in the query parameters. While this data is encrypted when using HTTPS, we recommend you proceed with caution.

```json
{
  "mcpServers": {
    "Statsig": {
      "url": "http://localhost:3000/sse?STATSIG_API_KEY=console-<your-console-key>"
    }
  }
}
```