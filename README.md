# A Simple MCP Server for Statsig

Uses the Console API: https://docs.statsig.com/console-api/introduction to provide basic functionality, for now gate and experiment creation


## Usage

Set it up in Cursor:
 - Go to Cursor > Cursor Settings > MCP
 - Add a new global MCP server
 - Add the following json to the mcp.json file

```
{
  "mcpServers": {
    "Statsig": {
      "command": "node /<path>/index.js",
      "env": {
        "STATSIG_API_KEY": "console-YOUR-CONSOLE-KEY"
      }
    }
  }
}

```
- Run **npm run build**
