import type {
  OpenAPIObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
  OperationObject,
} from "openapi3-ts/oas30";
import { ZodTypeAny, z } from "zod";

export async function fetchOpenApiSpec(
  specUrl: string
): Promise<OpenAPIObject> {
  const response = await fetch(specUrl);
  if (!response.ok) {
    throw new Error(`Error fetching openapi spec. Status: ${response.status}`);
  }
  const json = await response.json();
  return json as OpenAPIObject;
}

type ApiSchema = Record<
  string,
  {
    methods: string[];
    summary?: string;
    description?: string;
    parameters: Record<string, z.ZodType>;
    pathParameters: string[];
    methodDescriptions: Record<
      string,
      { summary?: string; description?: string }
    >;
  }
>;

const methods = [
  "get",
  "post",
  "put",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

function ensureParameterObject(
  parameter: ParameterObject | ReferenceObject
): parameter is ParameterObject {
  return "$ref" in parameter ? false : true;
}

function convertSchemaObjectToZod(
  schemaObject: SchemaObject | ReferenceObject
): z.ZodType {
  if ("$ref" in schemaObject) {
    throw new Error("$ref in param schema not supported");
  }
  if (schemaObject.type) {
    if (Array.isArray(schemaObject.type)) {
      throw new Error("array type not supported");
    }
    let schema: z.ZodType = (() => {
      switch (schemaObject.type) {
        case "integer":
          return z.number();
        case "number":
          return z.number();
        case "string":
          return z.string();
        case "boolean":
          return z.boolean();
        case "object":
          throw new Error("object param not supported");
        case "null":
          throw new Error("null param not supported");
        case "array":
          if (!schemaObject.items) {
            throw new Error("array type schema does not have items");
          }
          return z.array(convertSchemaObjectToZod(schemaObject.items));
        default:
          schemaObject.type as never;
          throw new Error(`Unsupported type: ${schemaObject.type}`);
      }
    })();
    if (schemaObject.nullable) {
      schema = schema.nullable();
    }
    return schema;
  } else if (schemaObject.oneOf) {
    // zod prefers to know about the array types at compile time. This makes this work, and we can't infer a typescript type which is fine.
    return z.union(
      schemaObject.oneOf.map(convertSchemaObjectToZod) as [
        ZodTypeAny,
        ZodTypeAny,
        ...ZodTypeAny[]
      ]
    );
  } else {
    throw new Error("unsupported schema object");
  }
}

function convertParameterToZod(
  parameter: ParameterObject
): z.ZodType | undefined {
  if (!parameter.schema) {
    return undefined;
  }
  let schema = convertSchemaObjectToZod(parameter.schema);
  if (!parameter.required) {
    schema = schema.optional();
  }
  if (parameter.description) {
    schema = schema.describe(parameter.description);
  }
  return schema;
}

function convertParametersToZod(
  parameters: (ParameterObject | ReferenceObject)[] | undefined
): Record<string, z.ZodType> {
  if (!parameters) {
    return {};
  }
  return Object.fromEntries(
    parameters
      .filter(ensureParameterObject)
      .map((param) => [param.name, convertParameterToZod(param)])
      .filter(([_, zod]) => zod !== undefined)
  );
}

function mergeParameters(operations: Record<string, OperationObject>): {
  parameters: Record<string, z.ZodType>;
  pathParameters: string[];
  methodDescriptions: Record<
    string,
    { summary?: string; description?: string }
  >;
} {
  const allParameters: Record<string, z.ZodType> = {};
  const pathParameters: Set<string> = new Set();
  const methodDescriptions: Record<
    string,
    { summary?: string; description?: string }
  > = {};

  for (const [method, operation] of Object.entries(operations)) {
    methodDescriptions[method] = {
      summary: operation.summary,
      description: operation.description,
    };

    const methodParams = convertParametersToZod(operation.parameters);
    for (const [paramName, paramSchema] of Object.entries(methodParams)) {
      if (allParameters[paramName]) {
        allParameters[paramName] = z.union([
          allParameters[paramName],
          paramSchema,
        ]);
      } else {
        allParameters[paramName] = paramSchema;
      }
    }

    const methodPathParams = (operation.parameters ?? [])
      .filter((p) => "in" in p && p.in === "path")
      .map((p) => ("in" in p ? p.name : null))
      .filter((p): p is string => p != null);

    methodPathParams.forEach((param) => pathParameters.add(param));
  }

  return {
    parameters: allParameters,
    pathParameters: Array.from(pathParameters),
    methodDescriptions,
  };
}

export function generateZodSchema(spec: OpenAPIObject): ApiSchema {
  const schema: ApiSchema = {};

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const availableMethods: string[] = [];
    const operationsByMethod: Record<string, OperationObject> = {};

    for (const method of methods) {
      const operation = pathItem[method];
      if (operation) {
        availableMethods.push(method);
        operationsByMethod[method] = operation;
      }
    }

    if (availableMethods.length === 0) {
      continue;
    }

    const { parameters, pathParameters, methodDescriptions } =
      mergeParameters(operationsByMethod);

    schema[path] = {
      methods: availableMethods,
      summary: operationsByMethod[availableMethods[0]]?.summary,
      description: operationsByMethod[availableMethods[0]]?.description,
      parameters,
      pathParameters,
      methodDescriptions,
    };
  }

  return schema;
}
