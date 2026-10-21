import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);
export const semanticSchema = z
  .object({
    version: z.literal("omniseedos.semantic/v1"),
    capabilityHierarchy: z
      .array(
        z
          .object({
            capability: id,
            parent: id.optional(),
            dependsOn: z.array(id).default([]),
          })
          .strict(),
      )
      .default([]),
    entityTypes: z
      .array(
        z
          .object({
            id,
            fields: z
              .record(id, z.enum(["string", "number", "boolean", "json"]))
              .default({}),
            required: z.array(id).default([]),
            indexed: z.array(id).default([]),
          })
          .strict(),
      )
      .default([]),
    relationships: z
      .array(
        z
          .object({
            id,
            from: id,
            to: id,
            kind: z.enum([
              "containment",
              "dependency",
              "applicability",
              "provenance",
            ]),
            inheritScope: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    scopes: z
      .array(
        z
          .object({
            id,
            entityType: id,
            parent: id.optional(),
            permissions: z
              .array(z.enum(["discover", "view", "export"]))
              .default(["discover", "view"]),
          })
          .strict(),
      )
      .default([]),
    migration: z
      .object({
        version: z.literal("omniseedos.data-migration/v1"),
        defaults: z.record(id, z.record(id, z.json())).default({}),
        removeFields: z.record(id, z.array(id)).default({}),
        removeTypes: z.array(id).default([]),
      })
      .strict()
      .optional(),
    search: z
      .object({
        version: z.literal(1),
        traversal: z.array(id).default([]),
        maxDepth: z.number().int().min(0).max(16).default(4),
        ranking: z
          .object({
            relevance: z.number().min(0).max(1),
            precedent: z.number().min(0).max(1),
            evidence: z.number().min(0).max(1),
            recency: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict()
      .default({
        version: 1,
        traversal: [],
        maxDepth: 4,
        ranking: {
          relevance: 0.5,
          precedent: 0.2,
          evidence: 0.2,
          recency: 0.1,
        },
      }),
  })
  .strict();
export type CompanySemanticDeclaration = z.input<typeof semanticSchema>;
export type CompiledSemantics = z.output<typeof semanticSchema>;
export function validateSemantics(input: unknown, capabilities: string[]) {
  const result = semanticSchema.safeParse(input);
  if (!result.success)
    return result.error.issues.map(
      (i) => `spec.semantic.${i.path.join(".")}: ${i.message}`,
    );
  const s = result.data,
    errors: string[] = [];
  function unique(values: string[], label: string) {
    if (new Set(values).size !== values.length)
      errors.push(`Duplicate ${label}`);
  }
  function ref(value: string, values: string[], label: string) {
    if (!values.includes(value)) errors.push(`Unknown ${label}: ${value}`);
  }
  function acyclic(
    rows: Array<{ id: string; parents: string[] }>,
    label: string,
  ) {
    const done = new Set<string>(),
      visiting = new Set<string>(),
      map = new Map(rows.map((r) => [r.id, r.parents]));
    function walk(key: string) {
      if (visiting.has(key)) {
        errors.push(`Cyclic ${label}: ${key}`);
        return;
      }
      if (done.has(key)) return;
      visiting.add(key);
      for (const parent of map.get(key) ?? []) walk(parent);
      visiting.delete(key);
      done.add(key);
    }
    for (const row of rows) walk(row.id);
  }
  unique(
    s.entityTypes.map((e) => e.id),
    "entity type",
  );
  unique(
    s.relationships.map((e) => e.id),
    "relationship",
  );
  unique(
    s.scopes.map((e) => e.id),
    "scope",
  );
  unique(
    s.capabilityHierarchy.map((e) => e.capability),
    "capability hierarchy",
  );
  if (s.entityTypes.some((e) => e.id === "documents"))
    errors.push("The table ID documents is reserved for the document library");
  for (const e of s.entityTypes)
    for (const field of [...e.required, ...e.indexed])
      ref(field, Object.keys(e.fields), "field");
  for (const c of s.capabilityHierarchy) {
    ref(c.capability, capabilities, "capability");
    for (const p of [...c.dependsOn, ...(c.parent ? [c.parent] : [])])
      ref(p, capabilities, "capability");
  }
  for (const r of s.relationships) {
    ref(
      r.from,
      s.entityTypes.map((e) => e.id),
      "entity type",
    );
    ref(
      r.to,
      s.entityTypes.map((e) => e.id),
      "entity type",
    );
    if (r.inheritScope && r.kind !== "containment")
      errors.push("Scope inheritance requires containment");
  }
  for (const scope of s.scopes) {
    ref(
      scope.entityType,
      s.entityTypes.map((e) => e.id),
      "entity type",
    );
    if (scope.parent)
      ref(
        scope.parent,
        s.scopes.map((e) => e.id),
        "scope",
      );
  }
  for (const r of s.search.traversal)
    ref(
      r,
      s.relationships.map((e) => e.id),
      "traversal relationship",
    );
  if (
    Math.abs(Object.values(s.search.ranking).reduce((a, b) => a + b, 0) - 1) >
    1e-9
  )
    errors.push("Search ranking weights must sum to one");
  acyclic(
    s.capabilityHierarchy.map((c) => ({
      id: c.capability,
      parents: [...c.dependsOn, ...(c.parent ? [c.parent] : [])],
    })),
    "capability hierarchy",
  );
  acyclic(
    s.scopes.map((c) => ({ id: c.id, parents: c.parent ? [c.parent] : [] })),
    "scope hierarchy",
  );
  acyclic(
    s.entityTypes.map((c) => ({
      id: c.id,
      parents: s.relationships
        .filter((r) => r.from === c.id && r.kind === "containment")
        .map((r) => r.to),
    })),
    "containment",
  );
  if (s.migration) {
    for (const [type, fields] of Object.entries(s.migration.defaults)) {
      const entity = s.entityTypes.find((e) => e.id === type);
      if (!entity) {
        errors.push(`Unknown migration entity: ${type}`);
        continue;
      }
      for (const [field, value] of Object.entries(fields)) {
        const expected = entity.fields[field];
        if (
          !expected ||
          value === null ||
          (expected !== "json" && typeof value !== expected)
        )
          errors.push(`Invalid migration default: ${type}.${field}`);
      }
    }
    for (const [type, fields] of Object.entries(s.migration.removeFields))
      for (const field of fields)
        if (s.entityTypes.find((e) => e.id === type)?.fields[field])
          errors.push(`Removed field still declared: ${type}.${field}`);
    for (const type of s.migration.removeTypes)
      if (s.entityTypes.some((e) => e.id === type))
        errors.push(`Removed table still declared: ${type}`);
  }
  return errors;
}
