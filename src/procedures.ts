import { z } from "zod";
import { hash, requireThat } from "./core.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const value = z.union([z.string().max(200), z.boolean()]);
export type InputValue = z.infer<typeof value>;
export type Condition =
  | { field: string; op: "eq"; value: InputValue }
  | { field: string; op: "in"; values: InputValue[] }
  | { all: Condition[] }
  | { any: Condition[] };
const condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ field: identifier, op: z.literal("eq"), value }).strict(),
    z
      .object({
        field: identifier,
        op: z.literal("in"),
        values: z.array(value).min(1).max(100),
      })
      .strict(),
    z.object({ all: z.array(condition).max(20) }).strict(),
    z.object({ any: z.array(condition).max(20) }).strict(),
  ]),
);
export const procedureSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(100)).max(30),
    version: z.string().min(1).max(50),
    pageId: identifier,
    pageHash: z.string().length(64),
    scope: z.string().min(1).max(2000),
    owner: z.string().min(1).max(200),
    inputs: z
      .array(
        z
          .object({
            id: identifier,
            type: z.enum(["enum", "boolean"]),
            values: z.array(value).min(1).max(50),
            required: z.boolean(),
            semanticVersion: z.string().min(1).max(50),
            question: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(12),
    supportedWhen: condition,
    notApplicableWhen: condition.optional(),
    nodes: z
      .array(
        z
          .object({
            id: identifier,
            kind: z.enum([
              "applicability",
              "prerequisite",
              "material",
              "step",
              "constraint",
              "completion",
            ]),
            text: z.string().min(1).max(8000),
            dependsOn: z.array(identifier).max(100),
            citations: z.array(identifier).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    alwaysRequired: z.array(identifier).max(100),
    branches: z
      .array(
        z
          .object({
            id: identifier,
            when: condition,
            requiredNodes: z.array(identifier).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const bundleSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: identifier,
            path: z.string().min(1).max(300),
            title: z.string().min(1).max(300),
            content: z.string().max(200000),
            hash: z.string().length(64),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    procedures: z.array(procedureSchema).min(1).max(100),
    cases: z
      .array(
        z
          .object({
            id: identifier,
            procedureId: identifier,
            question: z.string().min(1).max(4000),
            inputs: z.record(z.string(), value),
            expectedCode: z.string(),
            expectedNodes: z.array(identifier).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    config: z
      .object({
        model: z.string().min(1).max(200),
        modelRevision: z.string().min(1).max(200),
        promptVersion: z.literal("1"),
        templateVersion: z.literal("1"),
        retrievalVersion: z.literal("1"),
        protocolVersion: z.literal("1"),
        evaluationVersion: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();
export type Bundle = z.infer<typeof bundleSchema>;
export type Procedure = z.infer<typeof procedureSchema>;
type Truth = boolean | "unknown";

export function evaluate(
  c: Condition,
  inputs: Record<string, InputValue>,
): Truth {
  if ("all" in c) {
    const values = c.all.map((x) => evaluate(x, inputs));
    return values.includes(false)
      ? false
      : values.includes("unknown")
        ? "unknown"
        : true;
  }
  if ("any" in c) {
    const values = c.any.map((x) => evaluate(x, inputs));
    return values.includes(true)
      ? true
      : values.includes("unknown")
        ? "unknown"
        : false;
  }
  if (!(c.field in inputs)) return "unknown";
  return c.op === "eq"
    ? inputs[c.field] === c.value
    : c.values.includes(inputs[c.field]!);
}
function unique(values: string[]) {
  return new Set(values).size === values.length;
}
function validateCondition(c: Condition, p: Procedure, depth = 0) {
  requireThat(depth < 12, 400, "CONDITION_TOO_DEEP");
  if ("all" in c || "any" in c) {
    for (const x of "all" in c ? c.all : c.any)
      validateCondition(x, p, depth + 1);
    return;
  }
  const field = p.inputs.find((x) => x.id === c.field);
  requireThat(field, 400, "UNKNOWN_INPUT");
  const values = c.op === "eq" ? [c.value] : c.values;
  requireThat(
    values.every((x) => field.values.includes(x)),
    400,
    "INVALID_CONDITION_VALUE",
  );
}
export function validateBundle(bundle: Bundle): void {
  requireThat(unique(bundle.cases.map((c) => c.id)), 400, "DUPLICATE_CASE");
  requireThat(
    unique(bundle.pages.map((p) => p.id)) &&
      unique(bundle.pages.map((p) => p.path)) &&
      unique(bundle.procedures.map((p) => p.id)),
    400,
    "DUPLICATE_ID",
  );
  for (const page of bundle.pages) {
    requireThat(
      !page.path.startsWith("/") &&
        !page.path.includes("\\") &&
        page.path
          .split("/")
          .every(
            (s) =>
              /^[\p{L}\p{N}_ .-]+$/u.test(s) &&
              !s.startsWith(".") &&
              s.trim() === s,
          ) &&
        page.path.endsWith(".md"),
      400,
      "INVALID_PAGE_PATH",
    );
    requireThat(hash(page.content) === page.hash, 400, "CONTENT_HASH_MISMATCH");
  }
  for (const p of bundle.procedures) {
    requireThat(
      bundle.pages.some(
        (page) => page.id === p.pageId && page.hash === p.pageHash,
      ),
      400,
      "PROCEDURE_PAGE_MISMATCH",
    );
    requireThat(
      unique(p.nodes.map((n) => n.id)) &&
        unique(p.inputs.map((i) => i.id)) &&
        unique(p.branches.map((b) => b.id)),
      400,
      "DUPLICATE_ID",
    );
    for (const field of p.inputs) {
      requireThat(
        new Set(field.values).size === field.values.length,
        400,
        "DUPLICATE_INPUT_VALUE",
      );
      requireThat(
        field.values.every(
          (v) => typeof v === (field.type === "boolean" ? "boolean" : "string"),
        ),
        400,
        "INVALID_INPUT_TYPE",
      );
      if (field.type === "boolean")
        requireThat(
          field.values.includes(true) && field.values.includes(false),
          400,
          "INCOMPLETE_BOOLEAN_DOMAIN",
        );
    }
    const nodes = new Map(p.nodes.map((n) => [n.id, n]));
    const visited = new Set<string>();
    function visit(nodeId: string, ancestors: Set<string>) {
      if (visited.has(nodeId)) return;
      const node = nodes.get(nodeId);
      requireThat(node, 400, "UNKNOWN_NODE");
      requireThat(!ancestors.has(nodeId), 400, "NODE_CYCLE");
      for (const d of node.dependsOn) visit(d, new Set([...ancestors, nodeId]));
      visited.add(nodeId);
    }
    for (const n of p.nodes) {
      visit(n.id, new Set());
      requireThat(
        n.citations.every((c) => bundle.pages.some((page) => page.id === c)),
        400,
        "INVALID_CITATION",
      );
    }
    validateCondition(p.supportedWhen, p);
    if (p.notApplicableWhen) validateCondition(p.notApplicableWhen, p);
    for (const b of p.branches) {
      validateCondition(b.when, p);
      const ids = new Set([...p.alwaysRequired, ...b.requiredNodes]);
      requireThat(
        [...ids].every((n) => nodes.has(n)),
        400,
        "UNKNOWN_NODE",
      );
      requireThat(
        [...ids].some((n) => nodes.get(n)!.kind === "completion"),
        400,
        "COMPLETION_REQUIRED",
      );
      requireThat(
        [...ids].every((n) => nodes.get(n)!.dependsOn.every((d) => ids.has(d))),
        400,
        "MISSING_DEPENDENCY",
      );
    }
    let combinations: Record<string, InputValue>[] = [{}];
    for (const field of p.inputs) {
      requireThat(
        combinations.length * field.values.length <= 4096,
        400,
        "COVERAGE_NOT_PROVABLE",
      );
      combinations = combinations.flatMap((c) =>
        field.values.map((v) => ({ ...c, [field.id]: v })),
      );
    }
    for (const inputs of combinations) {
      const count = p.branches.filter(
        (b) => evaluate(b.when, inputs) === true,
      ).length;
      const supported = evaluate(p.supportedWhen, inputs) === true,
        excluded =
          p.notApplicableWhen && evaluate(p.notApplicableWhen, inputs) === true;
      requireThat(count <= 1, 400, "PROCEDURE_BRANCH_CONFLICT");
      requireThat(!(supported && excluded), 400, "SUPPORT_CONFLICT");
      requireThat(!supported || count === 1, 400, "PROCEDURE_BRANCH_GAP");
      requireThat(
        !count || (supported && !excluded),
        400,
        "BRANCH_OUTSIDE_SUPPORT",
      );
    }
    for (const b of p.branches)
      requireThat(
        bundle.cases.some(
          (c) =>
            c.procedureId === p.id && guidance(p, c.inputs).branch === b.id,
        ),
        400,
        "BRANCH_CASE_REQUIRED",
      );
  }
  for (const c of bundle.cases) {
    const p = bundle.procedures.find((p) => p.id === c.procedureId);
    requireThat(p, 400, "CASE_PROCEDURE_MISSING");
    requireThat(
      Object.entries(c.inputs).every(([k, v]) =>
        p.inputs.some((f) => f.id === k && f.values.includes(v)),
      ),
      400,
      "INVALID_CASE_INPUT",
    );
    const result = guidance(p, c.inputs);
    requireThat(
      result.code === c.expectedCode &&
        hash(result.nodes.map((n) => n.id)) === hash(c.expectedNodes),
      400,
      "CASE_EXPECTATION_FAILED",
    );
  }
}
export function guidance(p: Procedure, inputs: Record<string, InputValue>) {
  const branchValues = p.branches.map((b) => evaluate(b.when, inputs));
  if (branchValues.filter((v) => v === true).length > 1)
    return { code: "PROCEDURE_BRANCH_CONFLICT", nodes: [], questions: [] };
  const missing = p.inputs.filter((f) => !(f.id in inputs));
  if (
    p.inputs.some((f) => f.required && !(f.id in inputs)) ||
    evaluate(p.supportedWhen, inputs) === "unknown" ||
    branchValues.includes("unknown")
  )
    return {
      code: "CLARIFICATION_REQUIRED",
      nodes: [],
      questions: missing.map((f) => ({
        id: f.id,
        question: f.question,
        options: f.values,
      })),
    };
  if (p.notApplicableWhen && evaluate(p.notApplicableWhen, inputs) === true)
    return { code: "PROCEDURE_NOT_APPLICABLE", nodes: [], questions: [] };
  if (evaluate(p.supportedWhen, inputs) === false)
    return { code: "PROCEDURE_COVERAGE_GAP", nodes: [], questions: [] };
  const branch = p.branches[branchValues.indexOf(true)];
  if (!branch)
    return { code: "PROCEDURE_BRANCH_GAP", nodes: [], questions: [] };
  const needed = new Set([...p.alwaysRequired, ...branch.requiredNodes]),
    ordered: Procedure["nodes"] = [];
  function append(nodeId: string) {
    if (ordered.some((n) => n.id === nodeId)) return;
    const n = p.nodes.find((n) => n.id === nodeId)!;
    for (const dep of n.dependsOn) append(dep);
    ordered.push(n);
  }
  for (const nodeId of needed) append(nodeId);
  return { code: "GUIDANCE", branch: branch.id, nodes: ordered, questions: [] };
}
