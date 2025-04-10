import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetchOpenApiSpec } from "./api.js";
import { generateZodSchema } from "./api.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const STATSIG_API_URL = "https://api.statsig.com/console/v1/gates";
const STATSIG_EXPERIMENT_API_URL = "https://api.statsig.com/console/v1/experiments";

// Function to create a gate using the Statsig Console API
async function createGate(gate: { name: string; isEnabled: boolean; description: string }) {
  const payload = {
    name: gate.name,
    idType: "userID",
    description: gate.description,
  };

  const headers = {
    "Content-Type": "application/json",
    "STATSIG-API-KEY": process.env.STATSIG_API_KEY || "[KEY MISSING]",
    "STATSIG-API-VERSION": "20240601"
  };

  console.error('Sending request to Statsig:', {
    url: STATSIG_API_URL,
    method: 'POST',
    payload: payload,
    headers: headers
  });

  try {
    const response = await fetch(STATSIG_API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create gate: ${response.status} ${text}. Payload: ${JSON.stringify(payload)} Headers: ${JSON.stringify(headers)}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error creating gate:", error);
    return { error: error instanceof Error ? error.message : error };
  }
}

// Function to create an experiment using the Statsig Console API
async function createExperiment(experiment: {
  name: string;
  hypothesis: string;
  groups: Array<{
    name: string;
    size: number;
    parameterValues: Record<string, any>;
  }>;
}) {
  const payload = {
    name: experiment.name,
    hypothesis: experiment.hypothesis,
    idType: "userID",
    groups: experiment.groups,
    allocation: 100,
  };

  const headers = {
    "Content-Type": "application/json",
    "STATSIG-API-KEY": process.env.STATSIG_API_KEY || "[KEY MISSING]",
    "STATSIG-API-VERSION": "20240601"
  };

  console.error('Sending request to Statsig:', {
    url: STATSIG_EXPERIMENT_API_URL,
    method: 'POST',
    payload: payload,
    headers: headers
  });

  try {
    const response = await fetch(STATSIG_EXPERIMENT_API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create experiment: ${response.status} ${text}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error creating experiment:", error);
    return { error: error instanceof Error ? error.message : error };
  }
}

const server = new McpServer({
  name: "statsig",
  version: "1.0.0",
});

server.tool(
  "create-gate",
  "Create a Statsig gate by name",
  {
    name: z.string().min(3).max(100).describe("Name of the gate"),
    isEnabled: z.boolean().describe("Whether the gate is enabled"),
    description: z.string().max(1000).describe("Description of the gate")
  },
  async ({ name, isEnabled, description }) => {
    const result = await createGate({ name, isEnabled, description });
    return {
      content: [
        {
          type: "text",
          text: `${result.message}\n\nAdd this comment next to the gate check:\n// Gate "${name}" - https://console.statsig.com/gates/${name}`
        }
      ]
    };
  }
);

server.tool(
  "create-experiment",
  "Create a Statsig experiment",
  {
    name: z.string().min(3).max(100).describe("Name of the experiment"),
    hypothesis: z.string().max(1000).describe("A statement that will be tested by this experiment"),
    testGroupParams: z.record(z.any()).describe("JSON object containing parameter values for the test group in key value pairs. Should be called in code with .getExperiment(user, 'experimentName').get('KEYNAME', 'default value'). Control and test must have the same keys."),
    controlGroupParams: z.record(z.any()).describe("JSON object containing parameter values for the control group in key value pairs. Should be called in code with .getExperiment(user, 'experimentName').get('KEYNAME', 'default value'). Control and test must have the same keys.")
  },
  async ({ name, hypothesis, testGroupParams, controlGroupParams }) => {
    const groups = [
      {
        name: "control",
        size: 50,
        parameterValues: controlGroupParams
      },
      {
        name: "test",
        size: 50,
        parameterValues: testGroupParams
      }
    ];
    
    const result = await createExperiment({ name, hypothesis, groups });
    return {
      content: [
        {
          type: "text",
          text: `${result.message}\n\nAdd this comment next to the experiment check:\n// Experiment "${name}" - https://console.statsig.com/experiments/${name}`
        }
      ]
    };
  }
);

async function buildTools(server: McpServer, specUrl: string) {
  const spec = await fetchOpenApiSpec("https://api.statsig.com/openapi/20240601.json");
  const schema = generateZodSchema(spec);
  const toolNames = new Set<string>();
  for (const path in schema) {
    for (const method in schema[path]) {
      // Only do get for now
      const { summary, parameters } = schema[path][method];
      const desc = summary ? `${summary} (Call ${method.toUpperCase()} ${path})` : `Get statsig-${method}-${path}`;

      let toolName = desc.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 64);
      if (toolNames.has(toolName)) {
        // has to be unique
        toolName = `${toolName}-${toolNames.size}`;
      }
      toolNames.add(toolName);

      server.tool(
        toolName,
        desc,
        parameters,
        async (params) => {
          return { content: [{ type: "text", text: "TODO" }] };
        }
      );
    }
  }
}

const STATSIG_OPENAPI_URL = "https://api.statsig.com/openapi/20240601.json";
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
      console.log(summary, description, JSON.stringify(zodToJsonSchema(z.object(parameters)), null, 2));
    }
  }
}

//derp();