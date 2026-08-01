import type { ReactNode } from "react";

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: string[];
  const?: unknown;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  minLength?: number;
};

type OpenApiDocument = {
  info: {
    title: string;
    description?: string;
  };
  paths: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
};

type Operation = {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: "path" | "query" | "header" | "cookie";
    required?: boolean;
    description?: string;
    schema?: JsonSchema;
  }>;
  requestBody?: {
    description?: string;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema }>;
    }
  >;
};

type OpenApiRouteGroupProps = {
  spec: OpenApiDocument;
};

const methodClass: Record<string, string> = {
  get: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  post: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  put: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  patch: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  delete: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
};

export function OpenApiRouteGroup({ spec }: OpenApiRouteGroupProps) {
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      anchorId: operationAnchorId(path, method, operation),
      path,
      method,
      operation
    }))
  );

  return (
    <div className="not-prose mt-6 grid gap-8">
      <nav className="text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">
          Routes
        </h2>
        <div className="mt-3 grid gap-1.5">
          {operations.map(({ anchorId, path, method, operation }) => (
            <a
              key={anchorId}
              href={`#${anchorId}`}
              className="group flex flex-wrap items-center gap-2 py-1.5 text-fd-muted-foreground hover:text-fd-foreground"
            >
              <span
                className={`rounded-md border px-2 py-1 font-mono text-[11px] font-semibold uppercase ${
                  methodClass[method] ??
                  "border-fd-border bg-fd-muted text-fd-muted-foreground"
                }`}
              >
                {method}
              </span>
              <code className="text-xs text-fd-foreground group-hover:underline">
                {path}
              </code>
              <span className="text-xs text-fd-muted-foreground">
                {operation.summary ?? operation.operationId ?? path}
              </span>
            </a>
          ))}
        </div>
      </nav>

      {operations.map(({ anchorId, path, method, operation }) => (
        <section
          id={anchorId}
          key={`${method}:${path}`}
          className="scroll-mt-24 rounded-lg border bg-fd-card p-4 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`#${anchorId}`}
              className="group flex flex-wrap items-center gap-2 rounded-md hover:opacity-90"
              aria-label={`Link to ${method.toUpperCase()} ${path}`}
            >
              <span
                className={`rounded-md border px-2 py-1 font-mono text-xs font-semibold uppercase ${
                  methodClass[method] ??
                  "border-fd-border bg-fd-muted text-fd-muted-foreground"
                }`}
              >
                {method}
              </span>
              <code className="rounded bg-fd-muted px-2 py-1 text-fd-foreground group-hover:underline">
                {path}
              </code>
            </a>
            {operation.security ? (
              <span className="rounded-md border border-fd-border px-2 py-1 text-xs text-fd-muted-foreground">
                Bearer token
              </span>
            ) : null}
          </div>

          <div className="mt-3">
            <h3 className="text-base font-semibold text-fd-foreground">
              {operation.summary ?? operation.operationId ?? path}
            </h3>
            {operation.description ? (
              <p className="mt-2 max-w-3xl leading-6 text-fd-muted-foreground">
                {operation.description}
              </p>
            ) : null}
            {operation.operationId ? (
              <p className="mt-2 font-mono text-xs text-fd-muted-foreground">
                {operation.operationId}
              </p>
            ) : null}
          </div>

          <div className="mt-5 grid gap-5">
            <Parameters parameters={operation.parameters} spec={spec} />
            <RequestBody operation={operation} spec={spec} />
            <Responses operation={operation} spec={spec} />
          </div>
        </section>
      ))}
    </div>
  );
}

function operationAnchorId(
  path: string,
  method: string,
  operation: Operation
) {
  if (operation.operationId) {
    return operation.operationId;
  }

  return `${method}-${path}`
    .replace(/^\W+/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

function Parameters(props: {
  parameters: Operation["parameters"];
  spec: OpenApiDocument;
}) {
  if (!props.parameters?.length) {
    return null;
  }

  return (
    <DocSection title="Parameters">
      <div className="overflow-x-auto rounded-md border border-fd-border">
        <table className="w-full min-w-[520px] border-collapse text-left">
          <thead className="bg-fd-muted/50 text-xs uppercase text-fd-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Location</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {props.parameters.map((parameter) => (
              <tr key={`${parameter.in}:${parameter.name}`} className="border-t border-fd-border">
                <td className="px-3 py-2 align-top">
                  <code>{parameter.name}</code>
                  {parameter.required ? <Required /> : null}
                </td>
                <td className="px-3 py-2 align-top text-fd-muted-foreground">
                  {parameter.in}
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs">
                  {schemaType(parameter.schema, props.spec)}
                </td>
                <td className="px-3 py-2 align-top text-fd-muted-foreground">
                  {parameter.description ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DocSection>
  );
}

function RequestBody(props: { operation: Operation; spec: OpenApiDocument }) {
  const body = props.operation.requestBody;
  if (!body?.content) {
    return (
      <DocSection title="Request">
        <p className="text-fd-muted-foreground">No request body.</p>
      </DocSection>
    );
  }

  return (
    <DocSection title="Request">
      {body.description ? (
        <p className="mb-3 text-fd-muted-foreground">{body.description}</p>
      ) : null}
      <MediaSchemas content={body.content} spec={props.spec} />
    </DocSection>
  );
}

function Responses(props: { operation: Operation; spec: OpenApiDocument }) {
  const responses = Object.entries(props.operation.responses ?? {});
  if (responses.length === 0) {
    return null;
  }

  return (
    <DocSection title="Responses">
      <div className="grid gap-4">
        {responses.map(([status, response]) => (
          <div key={status} className="rounded-md border border-fd-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-fd-muted px-2 py-1 text-xs">
                {status}
              </code>
              {response.description ? (
                <span className="text-fd-muted-foreground">
                  {response.description}
                </span>
              ) : null}
            </div>
            {response.content ? (
              <div className="mt-3">
                <MediaSchemas content={response.content} spec={props.spec} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </DocSection>
  );
}

function MediaSchemas(props: {
  content: Record<string, { schema?: JsonSchema }>;
  spec: OpenApiDocument;
}) {
  return (
    <div className="grid gap-3">
      {Object.entries(props.content).map(([mediaType, media]) => (
        <div key={mediaType} className="grid gap-3">
          <div className="font-mono text-xs text-fd-muted-foreground">
            {mediaType}
          </div>
          {media.schema ? (
            <SchemaWithReferences schema={media.schema} spec={props.spec} />
          ) : (
            <p className="text-fd-muted-foreground">No schema.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function SchemaWithReferences(props: {
  schema: JsonSchema;
  spec: OpenApiDocument;
}) {
  const rootName = schemaName(props.schema);
  const references = collectReferences(props.schema, props.spec).filter(
    (name) => name !== rootName
  );

  return (
    <div className="grid gap-3">
      <SchemaCard schema={props.schema} spec={props.spec} title={rootName} />
      {references.length > 0 ? (
        <details className="rounded-md border border-fd-border p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase text-fd-muted-foreground">
            Referenced Schemas
          </summary>
          <div className="mt-3 grid gap-3">
            {references.map((name) => {
              const schema = props.spec.components?.schemas?.[name];
              return schema ? (
                <SchemaCard
                  key={name}
                  schema={schema}
                  spec={props.spec}
                  title={name}
                />
              ) : null;
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SchemaCard(props: {
  schema: JsonSchema;
  spec: OpenApiDocument;
  title?: string;
}) {
  const schema = resolveSchema(props.schema, props.spec);
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  if (!Object.keys(properties).length) {
    return (
      <div className="rounded-md border border-fd-border p-3">
        <SchemaHeader title={props.title} schema={schema} spec={props.spec} />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-fd-border">
      <div className="p-3">
        <SchemaHeader title={props.title} schema={schema} spec={props.spec} />
      </div>
      <div className="overflow-x-auto border-t border-fd-border">
        <table className="w-full min-w-[620px] border-collapse text-left">
          <thead className="bg-fd-muted/50 text-xs uppercase text-fd-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(properties).map(([name, property]) => {
              const resolvedProperty = resolveSchema(property, props.spec);
              return (
                <tr key={name} className="border-t border-fd-border">
                  <td className="px-3 py-2 align-top">
                    <code>{name}</code>
                    {required.has(name) ? <Required /> : null}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs">
                    {schemaType(property, props.spec)}
                  </td>
                  <td className="px-3 py-2 align-top text-fd-muted-foreground">
                    {property.description ?? resolvedProperty.description ?? ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SchemaHeader(props: {
  title?: string;
  schema: JsonSchema;
  spec: OpenApiDocument;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {props.title ? (
          <code className="rounded bg-fd-muted px-2 py-1 text-xs">
            {props.title}
          </code>
        ) : null}
        <span className="font-mono text-xs text-fd-muted-foreground">
          {schemaType(props.schema, props.spec)}
        </span>
      </div>
      {props.schema.description ? (
        <p className="mt-2 text-fd-muted-foreground">
          {props.schema.description}
        </p>
      ) : null}
    </div>
  );
}

function DocSection(props: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">
        {props.title}
      </h4>
      {props.children}
    </section>
  );
}

function Required() {
  return (
    <span className="ml-2 rounded bg-fd-muted px-1.5 py-0.5 text-[10px] uppercase text-fd-muted-foreground">
      required
    </span>
  );
}

function resolveSchema(schema: JsonSchema, spec: OpenApiDocument): JsonSchema {
  const name = schemaName(schema);
  if (!name) {
    return schema;
  }

  const referenced = spec.components?.schemas?.[name];
  if (!referenced) {
    return schema;
  }

  return {
    ...referenced,
    description: schema.description ?? referenced.description
  };
}

function schemaName(schema?: JsonSchema) {
  return schema?.$ref?.replace(/^#\/components\/schemas\//, "");
}

function schemaType(schema: JsonSchema | undefined, spec: OpenApiDocument): string {
  if (!schema) {
    return "unknown";
  }

  const name = schemaName(schema);
  if (name) {
    return name;
  }

  const resolved = resolveSchema(schema, spec);
  if (resolved.enum?.length) {
    return resolved.enum.map((value) => JSON.stringify(value)).join(" | ");
  }

  if ("const" in resolved) {
    return JSON.stringify(resolved.const);
  }

  if (resolved.type === "array") {
    return `${schemaType(resolved.items, spec)}[]`;
  }

  const type = Array.isArray(resolved.type)
    ? resolved.type.join(" | ")
    : resolved.type ?? "object";
  const format = resolved.format ? `<${resolved.format}>` : "";
  const minLength =
    typeof resolved.minLength === "number"
      ? ` minLength:${resolved.minLength}`
      : "";
  return `${type}${format}${minLength}`;
}

function collectReferences(schema: JsonSchema, spec: OpenApiDocument) {
  const names = new Set<string>();
  visitSchema(schema, spec, names, new Set<string>());
  return [...names];
}

function visitSchema(
  schema: JsonSchema | undefined,
  spec: OpenApiDocument,
  names: Set<string>,
  seen: Set<string>
) {
  if (!schema) {
    return;
  }

  const name = schemaName(schema);
  if (name) {
    names.add(name);
    if (seen.has(name)) {
      return;
    }

    seen.add(name);
    visitSchema(spec.components?.schemas?.[name], spec, names, seen);
    return;
  }

  for (const property of Object.values(schema.properties ?? {})) {
    visitSchema(property, spec, names, seen);
  }

  visitSchema(schema.items, spec, names, seen);
}
