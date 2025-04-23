import type {
  OpenAPIObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
  RequestBodyObject,
  ComponentsObject,
  PathItemObject,
  OperationObject,
} from "openapi3-ts/oas30";
import { z, ZodTypeAny } from "zod";

type ZodSchema = ZodTypeAny;

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
    requestBody?: Record<string, ZodSchema>;
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
  components?: ComponentsObject | undefined
): ZodSchema {
  if ("$ref" in schemaObject) {
    const resolved = resolveReference(schemaObject.$ref, components ?? {});
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
      .map((param) => {
        const zodSchema = convertParameterToZod(param);
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
  const components = spec.components ?? {};

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
      requestBody: convertRequestBodyToZod(
        operationsByMethod[availableMethods[0]].requestBody,
        components
      ),
      pathParameters,
      methodDescriptions,
    };
  }

  return schema;
}
