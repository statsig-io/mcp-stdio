import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenApiToZod } from "./testing.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_STATSIG_API_URL_BASE = "https://latest.statsigapi.net";

function getUrlBase() {
  return process.env.STATSIG_HOST || DEFAULT_STATSIG_API_URL_BASE;
}

function getOpenApiUrl() {
  return `${getUrlBase()}/openapi/20240601.json`;
}

const API_HEADERS = {
  "Content-Type": "application/json",
  "STATSIG-API-KEY": process.env.STATSIG_API_KEY || "[KEY MISSING]",
  "STATSIG-API-VERSION": "20240601",
};

const server = new McpServer({
  name: "statsig",
  version: "1.0.0",
});

async function isWarehouseNative(): Promise<boolean | null> {
  const response = await fetch(`${getUrlBase()}/console/v1/company`, {
    headers: API_HEADERS,
  });
  if (!response.ok) {
    return null;
  }
  const json = await response.json();
  if (typeof json.data?.isWarehouseNative !== "boolean") {
    return null;
  }
  return json.data.isWarehouseNative;
}

async function buildTools(
  server: McpServer,
  specUrl: string,
  showWarehouseNative: boolean
) {
  const converter = await new OpenApiToZod(specUrl).initialize();
  const schema = converter.specToZod();
  const toolNames = new Set<string>();

  for (const [endpoint, methods] of Object.entries(schema)) {
    let toolName = endpoint.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 40);
    if (toolNames.has(toolName)) {
      toolName = `${toolName}-${toolNames.size}`;
    }
    toolNames.add(toolName);

    // Fixed filter function with return statement
    const methodsToUse = Object.entries(methods).filter(([_, methodArray]) => {
      return methodArray.some((method) => method.isWHN === showWarehouseNative);
    });

    if (methodsToUse.length === 0) {
      continue;
    }

    const methodsInfo = methodsToUse
      .map(([methodName, methodDetails]) => {
        const subDetailString = methodDetails
          .map((methodDetailObject) => {
            if (methodDetailObject.ending) {
              return `When using parameter ${
                methodDetailObject.ending
              } on ${methodName}; (${methodDetailObject.ending}): ${
                methodDetailObject.summary || "No summary available"
              }`;
            } else {
              return `${methodDetailObject.summary || "No summary available"}`;
            }
          })
          .join("\n");
        return `${methodName}: ${
          subDetailString || "No summary available for endpoint"
        }`;
      })
      .join("\n");

    const description =
      `API endpoint: ${endpoint}\n` +
      `Available methods: ${methodsToUse
        .map(([method]) => method.toUpperCase())
        .join(", ")}\n` +
      `---\n` +
      methodsInfo;

    const methodNames = methodsToUse.map(([method]) => method);
    let enhancedParameters: Record<string, z.ZodType> = {
      method: z
        .enum(methodNames as [string, ...string[]])
        .describe(
          `HTTP method to use. Available methods: ${methodNames.join(", ")}`
        ),
    };

    // Complete the map function to process method parameters
    methodsToUse.forEach(([methodName, methodDetails]) => {
      methodDetails.forEach((detail) => {
        if (Object.keys(detail.parameters).length > 0) {
          const paramKey = detail.ending
            ? `${methodName}_${detail.ending}_params`
            : `${methodName}_params`;

          enhancedParameters[paramKey] = z
            .object(detail.parameters)
            .optional()
            .describe(
              detail.ending
                ? `Parameters for ${methodName} with '${detail.ending}' ending`
                : `Parameters for ${methodName}`
            );
        }
      });
    });

    server.tool(toolName, description, enhancedParameters, async (params) => {
      const { method, ...otherParams } = params;
      const methodToUse = method || methodNames[0];
      const methodArray =
        methodsToUse.find(([m]) => m === methodToUse)?.[1] || [];

      let operationConfig;
      let methodParams = {};
      let endingToUse;

      if (methodArray.length === 1) {
        operationConfig = methodArray[0];
        const paramKey = operationConfig.ending
          ? `${methodToUse}_${operationConfig.ending}_params`
          : `${methodToUse}_params`;
        methodParams = otherParams[paramKey] || {};
        endingToUse = operationConfig.ending;
      } else {
        for (const config of methodArray) {
          if (config.ending) {
            const paramKey = `${methodToUse}_${config.ending}_params`;
            if (paramKey in otherParams) {
              operationConfig = config;
              methodParams = otherParams[paramKey] || {};
              endingToUse = config.ending;
              break;
            }
          }
        }

        if (!operationConfig) {
          operationConfig = methodArray[0];
          const paramKey = operationConfig.ending
            ? `${methodToUse}_${operationConfig.ending}_params`
            : `${methodToUse}_params`;
          methodParams = otherParams[paramKey] || {};
          endingToUse = operationConfig.ending;
        }
      }

      if (!operationConfig) {
        throw new Error(`No configuration found for method ${methodToUse}`);
      }

      const pathParameters = operationConfig.pathParameters || [];
      let interpolatedPath = endpoint;

      // For PUT with endings, we need to append the ending to the path
      if (methodToUse === "put" && endingToUse) {
        interpolatedPath = `${interpolatedPath}/${endingToUse}`;
      }

      const searchParams = new URLSearchParams();
      for (const [paramName, paramValue] of Object.entries(methodParams)) {
        if (pathParameters.includes(paramName)) {
          interpolatedPath = interpolatedPath.replace(
            `{${paramName}}`,
            encodeURIComponent(String(paramValue))
          );
        } else {
          if (paramValue != null) {
            searchParams.set(paramName, String(paramValue));
          }
        }
      }

      const queryString = searchParams.toString();
      const url = `${getUrlBase()}${interpolatedPath}${
        queryString ? `?${queryString}` : ""
      }`;
      console.error(`Sending request to ${url}`);

      try {
        const response = await fetch(url, {
          method: methodToUse,
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
  const specUrl = getOpenApiUrl();
  console.error(`Using API spec from ${specUrl}`);
  const isWHN = await isWarehouseNative();
  // For now, lets give everyone false here as the WHN flag isn't consistent
  await buildTools(server, specUrl, false);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Statsig MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
