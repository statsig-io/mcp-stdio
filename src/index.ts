import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenApiToZod } from "./testing.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
  const converter = await new OpenApiToZod(STATSIG_OPENAPI_URL).initialize();
  const schema = converter.specToZod();
  const toolNames = new Set<string>();

  for (const [endpoint, methods] of Object.entries(schema)) {
    let toolName = endpoint.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 40);
    if (toolNames.has(toolName)) {
      toolName = `${toolName}-${toolNames.size}`;
    }
    toolNames.add(toolName);

    const methodsInfo = Object.values(methods)
      .map((methodInfo) => {
        return `${methodInfo.summary?.toUpperCase()}: ${
          methodInfo.summary
        } || "No summary available"`;
      })
      .join("\n");

    const description =
      `API endpoint: ${endpoint}\n` +
      `Available methods: ${Object.keys(methods).join(", ").toUpperCase()}\n` +
      `---\n` +
      methodsInfo;

    const methodNames = Object.keys(methods);
    let enhancedParameters: Record<string, z.ZodType> = {
      method: z
        .enum(methodNames as [string, ...string[]])
        .describe(
          `HTTP method to use. Available methods: ${methodNames.join(", ")}`
        ),
    };

    for (const [method, methodData] of Object.entries(methods)) {
      if (methodData.parameters) {
        enhancedParameters[`${method}_params`] = z.object(methodData.parameters).optional();
      }
    }

    server.tool(toolName, description, enhancedParameters, async (params) => {
      const { method, ...requestParams } = params;
      const parameters = requestParams[`${method}_params`];
      const searchParams = new URLSearchParams();
      for (const [paramName, paramValue] of Object.entries(parameters)) {
        searchParams.set(paramName, String(paramValue));
      }
      const queryString = searchParams.toString();
      const url = `${STATSIG_API_URL_BASE}${endpoint}${
        queryString ? `?${queryString}` : ""
      }`;

      try {
        const response = await fetch(url, {
          method: method as string,
          headers: API_HEADERS,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API Error (${response.status}): ${errorText}`);
        }
        let responseData;
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          responseData = await response.json();
          return {
            content: [
              { type: "text", text: JSON.stringify(responseData, null, 2) },
            ],
          };
        } else {
          responseData = await response.text();
          return { content: [{ type: "text", text: responseData }] };
        }
      } catch (error) {
        throw new Error(`Error calling the API: ${(error as Error).message}`);
      }
    });
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
