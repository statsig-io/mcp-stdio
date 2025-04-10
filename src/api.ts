import type { OpenAPIObject, ParameterObject, ReferenceObject, SchemaObject } from "openapi3-ts/oas30";
import { ZodTypeAny, z } from "zod";

export async function fetchOpenApiSpec(specUrl: string): Promise<OpenAPIObject> {
  const response = await fetch(specUrl);
  if (!response.ok) {
    throw new Error(`Error fetching openapi spec. Status: ${response.status}`);
  }
  const json = await response.json();
  return json as OpenAPIObject;
}

type ApiSchema = Record<
  string,
  Record<string, {
    summary?: string,
    description?: string,
    parameters: Record<string, z.ZodType>,
    pathParameters: string[],
  }>
>;

const methods = ["get", "post", "put", "delete", "options", "head", "patch", "trace"] as const;

function ensureParameterObject(parameter: ParameterObject | ReferenceObject): parameter is ParameterObject {
  return "$ref" in parameter ? false : true;
}

function convertSchemaObjectToZod(schemaObject: SchemaObject | ReferenceObject): z.ZodType {
  if ('$ref' in schemaObject) {
    throw new Error('$ref in param schema not supported');
  }
  if (schemaObject.type) {
    if (Array.isArray(schemaObject.type)) {
      throw new Error('array type not supported');
    }
    let schema: z.ZodType = (() => {
    switch (schemaObject.type) {
      case 'integer':
        return z.number();
        case 'number':
          return z.number();
        case 'string':
          return z.string();
        case 'boolean':
          return z.boolean();
        case 'object':
          throw new Error('object param not supported');
        case 'null':
          throw new Error('null param not supported');
        case 'array':
          if (!schemaObject.items) {
            throw new Error('array type schema does not have items');
          }
          return z.array(convertSchemaObjectToZod(schemaObject.items));
        default:
          (schemaObject.type as never);
          throw new Error(`Unsupported type: ${schemaObject.type}`);
      }
    })();
    if (schemaObject.nullable) {
      schema = schema.nullable();
    }
    return schema;
  } else if (schemaObject.oneOf) {
    // zod prefers to know about the array types at compile time. This makes this work, and we can't infer a typescript type which is fine.
    return z.union(schemaObject.oneOf.map(convertSchemaObjectToZod) as [ZodTypeAny, ZodTypeAny,...ZodTypeAny[]]);
  } else {
    throw new Error('unsupported schema object');
  }
}

function convertParameterToZod(parameter: ParameterObject): z.ZodType | undefined {
  if (!parameter.schema) {
    return undefined;
  }
  const schema = convertSchemaObjectToZod(parameter.schema);
  if (!parameter.required) {
    return schema.optional();
  }
  return schema;
}

function convertParametersToZod(parameters: (ParameterObject | ReferenceObject)[] | undefined): Record<string, z.ZodType> {
  if (!parameters) {
    return {};
  }
  return Object.fromEntries(
    parameters
      .filter(ensureParameterObject)
      .map(param => [param.name, convertParameterToZod(param)])
      .filter(([_, zod]) => zod !== undefined)
  );
}

export function generateZodSchema(spec: OpenAPIObject): ApiSchema {
  const schema: ApiSchema = {};
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    schema[path] = {};

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }
      schema[path][method] = {
        summary: operation.summary,
        description: operation.description,
        pathParameters: (operation.parameters ?? []).filter(p => 'in' in p && p.in === 'path').map(p => 'in' in p ? p.name : null).filter((p): p is string => p != null),
        parameters: convertParametersToZod(operation.parameters),
      };
    }
  }
  return schema;
}
