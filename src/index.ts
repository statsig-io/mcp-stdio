import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetchOpenApiSpec } from "./api.js";
import { generateZodSchema } from "./api.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const STATSIG_OPENAPI_URL = "https://api.statsig.com/openapi/20240601.json";
const STATSIG_API_URL_BASE = "https://api.statsig.com";

const API_HEADERS = {
  "Content-Type": "application/json",
  "STATSIG-API-KEY": process.env.STATSIG_API_KEY || "[KEY MISSING]",
  "STATSIG-API-VERSION": "20240601",
};

const server = new McpServer({
  name: "statsig",
  version: "1.0.0",
});

async function buildTools(server: McpServer, specUrl: string) {
  const spec = await fetchOpenApiSpec(
    "https://api.statsig.com/openapi/20240601.json"
  );
  const schema = generateZodSchema(spec);
  const toolNames = new Set<string>();
  for (const path in schema) {
    for (const method in schema[path]) {
      // Only do get for now
      const { summary, parameters, pathParameters } = schema[path][method];
      const desc = summary
        ? `${summary} (Call ${method.toUpperCase()} ${path})`
        : `Get statsig-${method}-${path}`;

      let toolName = desc.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 64);
      if (toolNames.has(toolName)) {
        // has to be unique
        toolName = `${toolName}-${toolNames.size}`;
      }
      toolNames.add(toolName);

      server.tool(toolName, desc, parameters, async (params) => {
        let interpolatedPath = path;
        const searchParams = new URLSearchParams();
        for (const paramName in params) {
          if (pathParameters.includes(paramName)) {
            interpolatedPath = interpolatedPath.replace(
              `{${paramName}}`,
              params[paramName]
            );
          } else {
            searchParams.set(paramName, params[paramName]);
          }
        }
        const response = await fetch(
          `${STATSIG_API_URL_BASE}${interpolatedPath}?${searchParams.toString()}`,
          {
            method: method,
            headers: API_HEADERS,
          }
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Failed calling the API: ${response.status} ${text}`);
        }
        return { content: [{ type: "text", text: await response.text() }] };
      });
    }
  }
}

async function main() {
  await buildTools(server, STATSIG_OPENAPI_URL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Statsig MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

async function derp() {
  const schema = generateZodSchema(await fetchOpenApiSpec(STATSIG_OPENAPI_URL));
  for (const path in schema) {
    for (const method in schema[path]) {
      const { summary, description, parameters } = schema[path][method];
      console.log(
        summary,
        description,
        JSON.stringify(zodToJsonSchema(z.object(parameters)), null, 2)
      );
    }
  }
}

//derp();
