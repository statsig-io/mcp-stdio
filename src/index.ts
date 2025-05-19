import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { createServer } from "./serverSetup.js";

async function main() {
  // Check for transport type from environment variable. npm run start:sse will set MCP_TRANSPORT=sse
  const transportType = process.env.MCP_TRANSPORT?.toLowerCase() || "stdio";
  
  // Initialize server without API key for now (will be created per request in SSE mode). Will be used if its not SSE
  let server = await createServer();

  if (transportType === "sse") {
    const app = express();
    let transport: SSEServerTransport | null = null;
    
    app.get("/sse", async (req, res) => {
      // Extract API key from query parameters
      const statsigApiKey = req.query.STATSIG_API_KEY as string;
      if (statsigApiKey) {
        // For SSE mode, create a new server instance with the request API key
        server = await createServer(statsigApiKey);
      } else {
        // Use the default server with environment variable API key if available
        console.debug("No API key found in request, using environment variable if available");
      }
      
      // Create transport
      transport = new SSEServerTransport("/messages", res);
      server.connect(transport);
      console.debug("Statsig MCP Server connected via SSE");
    });
    
    app.post("/messages", (req, res) => {
      if (transport) {
        transport.handlePostMessage(req, res);
      } else {
        res.status(400).send("No active SSE transport");
      }
    });
    
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    app.listen(port, () => {
      console.debug(`Statsig MCP Server running on SSE at http://localhost:${port}/sse`);
    });
  } else {
    // Default to stdio transport with environment variable API key
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
