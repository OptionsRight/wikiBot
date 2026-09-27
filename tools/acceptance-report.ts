import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const duration = z.number().finite().nonnegative().nullable();
const sampleSchema = z
  .object({
    id: z.string().min(1),
    usefulFirstMs: duration,
    completeMs: duration,
    outcome: z.enum([
      "success",
      "failed",
      "unknown",
      "incomplete",
      "over_limit",
    ]),
  })
  .strict();
const inputSchema = z
  .object({
    kind: z.enum(["synthetic", "real"]),
    approvalReference: z.string().min(1),
    descriptorHash: z.string().regex(/^[a-f0-9]{64}$/),
    frozenAt: z.number().finite().nonnegative(),
    startedAt: z.number().finite().nonnegative(),
    ordinaryRequestIds: z.array(z.string().min(1)).min(1),
    samples: z.array(sampleSchema),
  })
  .strict();

function percentiles(values: number[]) {
  values.sort((a, b) => a - b);
  const percentile = (p: number) =>
    values[Math.ceil(values.length * p) - 1] ?? null;
  return {
    observed: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

// Offline arithmetic over an approved, frozen request roster. This does not
// authenticate the evidence or substitute for expert/environment acceptance.
export function summarizeAcceptance(value: unknown) {
  const input = inputSchema.parse(value);
  const ids = new Set(input.ordinaryRequestIds);
  if (
    input.frozenAt > input.startedAt ||
    ids.size !== input.ordinaryRequestIds.length
  )
    throw new Error("Invalid frozen request roster");
  const samples = new Map<string, z.infer<typeof sampleSchema>>();
  for (const sample of input.samples) {
    if (!ids.has(sample.id) || samples.has(sample.id))
      throw new Error("Duplicate or unplanned request");
    if (
      sample.usefulFirstMs !== null &&
      sample.completeMs !== null &&
      sample.usefulFirstMs > sample.completeMs
    )
      throw new Error("First useful delivery cannot follow complete delivery");
    samples.set(sample.id, sample);
  }
  const failures: { id: string; reasons: string[] }[] = [];
  for (const id of input.ordinaryRequestIds) {
    const sample = samples.get(id);
    const reasons: string[] = [];
    if (!sample) reasons.push("missing_sample");
    else {
      if (sample.outcome !== "success") reasons.push(sample.outcome);
      if (sample.usefulFirstMs === null || sample.usefulFirstMs > 3000)
        reasons.push("useful_first_over_3s_or_missing");
      if (sample.completeMs === null || sample.completeMs > 10000)
        reasons.push("complete_over_10s_or_missing");
    }
    if (reasons.length) failures.push({ id, reasons });
  }
  const denominator = ids.size,
    jointSuccesses = denominator - failures.length;
  const jointRate = jointSuccesses / denominator;
  return {
    kind: input.kind,
    approvalReference: input.approvalReference,
    descriptorHash: input.descriptorHash,
    denominator,
    observed: samples.size,
    jointSuccesses,
    jointRate,
    usefulFirstMs: percentiles(
      input.samples.flatMap((s) =>
        s.usefulFirstMs === null ? [] : [s.usefulFirstMs],
      ),
    ),
    completeMs: percentiles(
      input.samples.flatMap((s) =>
        s.completeMs === null ? [] : [s.completeMs],
      ),
    ),
    failures,
    accepted: input.kind === "real" && denominator >= 1000 && jointRate >= 0.95,
    limitation:
      "SLO arithmetic only; input provenance, approved workload, expert quality and real channel evidence require independent review. Missing observations remain failures; latency percentiles include observed values only.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2])
    throw new Error("Usage: npm run acceptance:report -- <frozen-run.json>");
  const report = summarizeAcceptance(
    JSON.parse(await readFile(process.argv[2], "utf8")),
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
