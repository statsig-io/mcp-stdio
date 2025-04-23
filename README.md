# A Simple MCP Server for Statsig

Uses the Console API: https://docs.statsig.com/console-api/introduction to provide basic functionality, for now gate and experiment creation


## Usage
Clone this repository and run - 
```
npm i
npm run build
```


Add the Statsig MCP server to Cursor using the following steps - 
- Navigate to Cursor > Settings > Cursor Settings > MCP
- Add a new global MCP server
- Add the following json to your mcp.json

Add the Statsig MCP server to Claude Desktop - 
- Download the Claude Desktop App
- Navigate to /Users/<user>/Library/Application Support/Claude/claude_desktop_config.json
- Add the following json to your file

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
