import type {
  OpenAPIObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
  RequestBodyObject,
  ComponentsObject,
  PathItemObject,
} from "openapi3-ts/oas30";
import { z, ZodTypeAny } from "zod";

type ZodSchema = ZodTypeAny;

type ApiSchema = Record<
  string,
  Record<
    string,
    {
      summary?: string;
      description?: string;
      pathParameters: string[];
      parameters: Record<string, ZodSchema>;
      requestBody?: Record<string, ZodSchema>;
    }
  >
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

function resolveReference<T>(ref: string, components: ComponentsObject): T {
  const parts = ref.replace(/^#\/components\//, "").split("/");
  let result: any = components;

  for (const part of parts) {
    result = result?.[part];
    if (!result) throw new Error(`Could not resolve reference: ${ref}`);
  }

  return result as T;
}

function convertSchemaObjectToZod(
  schemaObject: any,
  components: ComponentsObject
): ZodSchema {
  if ("$ref" in schemaObject) {
    const resolved = resolveReference(schemaObject.$ref, components);
    return convertSchemaObjectToZod(resolved, components);
  }

  if (schemaObject.enum && schemaObject.enum.length > 0) {
    const enumValues = schemaObject.enum as [string, ...string[]];
    return z.enum(enumValues);
  }
  if (schemaObject.allOf) {
    return schemaObject.allOf
      .map((s: any) => convertSchemaObjectToZod(s, components))
      .reduce((a: ZodSchema, b: ZodSchema) => z.intersection(a, b));
  }

  if (schemaObject.oneOf) {
    return z.union(
      schemaObject.oneOf.map((s: any) =>
        convertSchemaObjectToZod(s, components)
      )
    );
  }

  if (schemaObject.anyOf) {
    return z.union(
      schemaObject.anyOf.map((s: any) =>
        convertSchemaObjectToZod(s, components)
      )
    );
  }

  if (schemaObject.type) {
    let base: ZodSchema;

    switch (schemaObject.type) {
      case "string":
        base = z.string();
        break;
      case "number":
      case "integer":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array":
        base = z.array(
          convertSchemaObjectToZod(schemaObject.items, components)
        );
        break;
      case "object":
        const shape: Record<string, ZodSchema> = {};
        const required = new Set(schemaObject.required ?? []);
        for (const [key, prop] of Object.entries(
          schemaObject.properties ?? {}
        )) {
          const zodProp = convertSchemaObjectToZod(prop, components);
          shape[key] = required.has(key) ? zodProp : zodProp.optional();
        }
        base = z.object(shape);
        break;
      default:
        base = z.any();
    }

    if (schemaObject.nullable) {
      base = base.nullable();
    }

    if (schemaObject.description) {
      base = base.describe(schemaObject.description);
    }

    return base;
  }

  return z.any();
}
function ensureParameterObject(
  parameter: ParameterObject | ReferenceObject
): parameter is ParameterObject {
  return "$ref" in parameter ? false : true;
}

function convertParameterToZod(
  parameter: ParameterObject,
  components: ComponentsObject
): z.ZodType | undefined {
  if (!parameter.schema) {
    return undefined;
  }
  const schema = convertSchemaObjectToZod(parameter.schema, components);
  if (!parameter.required) {
    return schema.optional();
  }
  return schema;
}

function convertParametersToZod(
  parameters: (ParameterObject | ReferenceObject)[] | undefined,
  components: ComponentsObject
): Record<string, z.ZodType> {
  if (!parameters) {
    return {};
  }
  return Object.fromEntries(
    parameters
      .filter(ensureParameterObject)
      .map((param) => {
        const zodSchema = convertParameterToZod(param, components);
        return zodSchema ? [param.name, zodSchema] : null;
      })
      .filter((entry): entry is [string, z.ZodTypeAny] => entry !== null)
  );
}

function convertRequestBodyToZod(
  requestBody: RequestBodyObject | ReferenceObject | undefined,
  components: ComponentsObject
): Record<string, ZodSchema> | undefined {
  if (!requestBody) return undefined;

  const actual =
    "$ref" in requestBody
      ? resolveReference<RequestBodyObject>(requestBody.$ref, components)
      : requestBody;

  const content = actual.content ?? {};

  const mediaTypeObject = content["application/json"];

  if (!mediaTypeObject?.schema) return undefined;

  const schema = convertSchemaObjectToZod(mediaTypeObject.schema, components);

  const result: Record<string, ZodSchema> = {};

  if (actual.required) {
    result["application/json"] = schema;
  } else {
    result["application/json"] = schema.optional();
  }

  return result;
}

export function generateZodSchema(spec: OpenAPIObject): ApiSchema {
  const result: ApiSchema = {};
  const components = spec.components ?? {};

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    result[path] = {};

    for (const method of methods) {
      const operation = (pathItem as PathItemObject)[method];
      if (!operation) continue;

      const mergedParams = [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? []),
      ];

      result[path][method] = {
        summary: operation.summary,
        description: operation.description,
        pathParameters: mergedParams
          .filter((p): p is ParameterObject =>
            "$ref" in p
              ? resolveReference<ParameterObject>(p.$ref, components)?.in ===
                "path"
              : p.in === "path"
          )
          .map((p) =>
            "$ref" in p
              ? resolveReference<ParameterObject>(p.$ref as string, components)
                  .name
              : p.name
          ),
        parameters: convertParametersToZod(mergedParams, components),
        requestBody: convertRequestBodyToZod(operation.requestBody, components),
      };
    }
  }

  return result;
}

export async function fetchOpenApiSpec(
  specUrl: string
): Promise<OpenAPIObject> {
  const response = await fetch(specUrl);
  if (!response.ok) {
    throw new Error(`Error fetching OpenAPI spec. Status: ${response.status}`);
  }
  return response.json() as Promise<OpenAPIObject>;
}
