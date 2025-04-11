import {
  OpenAPIObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
} from "openapi3-ts/oas30";
import { ZodTypeAny, z } from "zod";

import { fetchOpenApiSpec } from "./api.js";

export type ApiSchema = Record<
  string, // base path
  Record<
    string, // method
    {
      summary?: string;
      parameters: Record<string, z.ZodType>;
      pathParameters?: string[];
      description?: string;
      isWHN: boolean;
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

  private openApiSchemaToZod(
    schemaObject: SchemaObject | ReferenceObject
  ): z.ZodType {
    if ("$ref" in schemaObject) {
      throw new Error("$ref in param schema not supported");
    }

    if (schemaObject.type) {
      if (Array.isArray(schemaObject.type)) {
        throw new Error("Array type not supported");
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
            return z.array(this.openApiSchemaToZod(schemaObject.items));
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
        schemaObject.oneOf.map((schema) => this.openApiSchemaToZod(schema)) as [
          ZodTypeAny,
          ZodTypeAny,
          ...ZodTypeAny[]
        ]
      );
    } else {
      throw new Error("unsupported schema object");
    }
  }

  private openApiParameterToZod(
    parameter: ParameterObject
  ): z.ZodType | undefined {
    if (!parameter.schema) {
      return undefined;
    }
    let schema = this.openApiSchemaToZod(parameter.schema);
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

    for (const [path, pathItem] of Object.entries(this.openApiSpec.paths)) {
      for (const method of this.HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation || !operation.tags || !operation.tags.includes(this.INCLUDE_TAG)) {
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
          isWHN: operation.tags.some((tag) => tag.includes(this.WHN_TAG_SUBSTR)),
        };
      }
    }

    return schema;
  }
}
