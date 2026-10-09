import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** JSON Schema for a zod shape, inlined (no $ref), as the HTTP providers expect. */
export function toJsonSchema(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { name, $refStrategy: 'none' }) as Record<string, unknown>;
  // zod-to-json-schema nests the shape under definitions[name] when a name is given
  const definitions = json.definitions as Record<string, unknown> | undefined;
  const inner = definitions?.[name];
  if (inner && typeof inner === 'object') {
    return inner as Record<string, unknown>;
  }
  delete json.$schema;
  return json;
}

/** Render a prompt template: every {name} becomes vars[name]. Unknown names are left as-is. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole
  );
}
