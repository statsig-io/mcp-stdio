import {
  OpenAPIObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
  ComponentsObject,
  RequestBodyObject,
} from "openapi3-ts/oas30";
import { ZodTypeAny, z } from "zod";

import { fetchOpenApiSpec } from "./api.js";

type ZodSchema = ZodTypeAny;
export type ApiSchema = Record<
  string, // base path
  Record<
    string, // method
    {
      summary?: string;
      parameters: Record<string, ZodSchema>;
      pathParameters?: string[];
      description?: string;
      isWHN: boolean;
      requestBody?: Record<string, ZodSchema>;
    }
  >
>;

export class OpenApiToZod {
  private HTTP_METHODS = [
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "trace",
  ] as const;
  private INCLUDE_TAG = "MCP";
  private WHN_TAG_SUBSTR = "(Warehouse Native)";
  private openApiSpec: OpenAPIObject | null = null;
  constructor(private specUrl: string) {
    this.specUrl = specUrl;
  }

  async initialize(): Promise<OpenApiToZod> {
    this.openApiSpec = await fetchOpenApiSpec(this.specUrl);
    return this;
  }

  resolveReference<T>(ref: string, components: ComponentsObject): T {
    const parts = ref.replace(/^#\/components\//, "").split("/");
    let result: any = components;

    for (const part of parts) {
      result = result?.[part];
      if (!result) throw new Error(`Could not resolve reference: ${ref}`);
    }

    return result as T;
  }

  private ensureParameterObject(
    parameter: ParameterObject | ReferenceObject
  ): parameter is ParameterObject {
    return "$ref" in parameter ? false : true;
  }

  private openApiParameterArrayToZod(
    parameters: (ParameterObject | ReferenceObject)[] | undefined
  ): Record<string, z.ZodType> {
    if (!parameters) {
      return {};
    }
    return Object.fromEntries(
      parameters
        .filter((param) => this.ensureParameterObject(param))
        .map((param) => [param.name, this.openApiParameterToZod(param)])
        .filter(([_, zod]) => zod !== undefined)
    );
  }

  private extractPathParameters(
    parameters: (ParameterObject | ReferenceObject)[] | undefined
  ): string[] {
    if (!parameters) {
      return [];
    }

    return parameters
      .filter((param) => "in" in param && param.in === "path")
      .map((param) => (param as ParameterObject).name);
  }

  convertRequestBodyToZod(
    requestBody: RequestBodyObject | ReferenceObject | undefined,
    components: ComponentsObject
  ): Record<string, ZodSchema> | undefined {
    if (!requestBody) return undefined;

    const actual =
      "$ref" in requestBody
        ? this.resolveReference<RequestBodyObject>(requestBody.$ref, components)
        : requestBody;

    const content = actual.content ?? {};

    const mediaTypeObject = content["application/json"];

    if (!mediaTypeObject?.schema) return undefined;

    const schema = this.convertSchemaObjectToZod(
      mediaTypeObject.schema,
      components
    );

    const result: Record<string, ZodSchema> = {};

    if (actual.required) {
      result["application/json"] = schema;
    } else {
      result["application/json"] = schema.optional();
    }

    return result;
  }

  private convertSchemaObjectToZod(
    schemaObject: any,
    components?: ComponentsObject | undefined
  ): ZodSchema {
    if ("$ref" in schemaObject) {
      const resolved = this.resolveReference(
        schemaObject.$ref,
        components ?? {}
      );
      return this.convertSchemaObjectToZod(resolved, components);
    }

    if (schemaObject.enum && schemaObject.enum.length > 0) {
      const enumValues = schemaObject.enum as [string, ...string[]];
      return z.enum(enumValues);
    }
    if (schemaObject.allOf) {
      return schemaObject.allOf
        .map((s: any) => this.convertSchemaObjectToZod(s, components))
        .reduce((a: ZodSchema, b: ZodSchema) => z.intersection(a, b));
    }

    if (schemaObject.oneOf) {
      return z.union(
        schemaObject.oneOf.map((s: any) =>
          this.convertSchemaObjectToZod(s, components)
        )
      );
    }

    if (schemaObject.anyOf) {
      return z.union(
        schemaObject.anyOf.map((s: any) =>
          this.convertSchemaObjectToZod(s, components)
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
            this.convertSchemaObjectToZod(schemaObject.items, components)
          );
          break;
        case "object":
          const shape: Record<string, ZodSchema> = {};
          const required = new Set(schemaObject.required ?? []);
          for (const [key, prop] of Object.entries(
            schemaObject.properties ?? {}
          )) {
            const zodProp = this.convertSchemaObjectToZod(prop, components);
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

  private openApiParameterToZod(
    parameter: ParameterObject
  ): z.ZodType | undefined {
    if (!parameter.schema) {
      return undefined;
    }
    let schema = this.convertSchemaObjectToZod(parameter.schema);
    if (!parameter.required) {
      schema = schema.optional();
    }
    if (parameter.description) {
      schema = schema.describe(parameter.description);
    }
    return schema;
  }

  specToZod(): ApiSchema {
    const schema: ApiSchema = {};
    if (this.openApiSpec == null) {
      return schema;
    }
    const components = this.openApiSpec.components ?? {};

    for (const [path, pathItem] of Object.entries(this.openApiSpec.paths)) {
      for (const method of this.HTTP_METHODS) {
        const operation = pathItem[method];
        if (
          !operation ||
          !operation.tags ||
          !operation.tags.includes(this.INCLUDE_TAG)
        ) {
          continue;
        }
        if (!(path in schema)) {
          schema[path] = {};
        }

        const parameters = this.openApiParameterArrayToZod(
          operation.parameters
        );
        const pathParameters = this.extractPathParameters(operation.parameters);
        schema[path][method] = {
          summary: operation.summary,
          parameters,
          pathParameters,
          description: operation.description,
          isWHN: operation.tags.some((tag) =>
            tag.includes(this.WHN_TAG_SUBSTR)
          ),
          requestBody: this.convertRequestBodyToZod(
            operation.requestBody,
            components
          ),
        };
      }
    }

    return schema;
  }
}
