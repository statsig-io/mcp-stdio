# A Simple MCP Server for Statsig

Uses the Console API: https://docs.statsig.com/console-api/introduction to provide basic functionality, for now gate and experiment creation


## Usage

Add it to Cursor by adding this to your mcp.json:

```
{
  "mcpServers": {
    "Statsig": {
      "command": "node /Users/brocklumbard/Desktop/Repos/mcp-statsig/src/index.ts",
      "env": {
        "STATSIG_API_KEY": "console-YOUR-CONSOLE-KEY"
      }
    }
  }
}

```