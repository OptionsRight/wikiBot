import { z } from "zod";
import { requireThat } from "../core.js";
import type { EvidenceContext } from "./context.js";

export const formalBlockSchema = z
  .object({
    seq: z.number().int().positive(),
    text: z.string().min(1).max(12000),
    pageIds: z.array(z.string()).max(20),
    claimVersionIds: z.array(z.string()).max(100),
    evidenceIds: z.array(z.string()).max(100),
    outcome: z.enum(["answer", "knowledge_gap", "clarification"]),
  })
  .strict();
export type FormalBlock = z.infer<typeof formalBlockSchema>;
export function validateFormalBlock(
  block: FormalBlock,
  context: EvidenceContext,
  expectedSeq: number,
) {
  requireThat(block.seq === expectedSeq, 502, "BLOCK_SEQUENCE_INVALID");
  requireThat(
    block.pageIds.every((id) => context.pages.some((p) => p.pageId === id)),
    502,
    "INVALID_CITATION",
  );
  requireThat(
    block.claimVersionIds.every(
      (id) =>
        context.claims.some((c) => c.versionId === id) &&
        context.pages.some(
          (p) =>
            block.pageIds.includes(p.pageId) && p.claimVersionIds.includes(id),
        ),
    ),
    502,
    "INVALID_CLAIM_CITATION",
  );
  requireThat(
    block.evidenceIds.every(
      (id) =>
        context.evidence.some((e) => e.evidenceId === id) &&
        block.claimVersionIds.some((cid) =>
          context.claims
            .find((c) => c.versionId === cid)
            ?.evidenceIds.includes(id),
        ),
    ),
    502,
    "INVALID_EVIDENCE_CITATION",
  );
  requireThat(
    block.claimVersionIds.every((cid) =>
      context.claims
        .find((c) => c.versionId === cid)!
        .evidenceIds.some((eid) => block.evidenceIds.includes(eid)),
    ),
    502,
    "CLAIM_SUPPORT_REQUIRED",
  );
  if (block.outcome === "answer") {
    requireThat(block.pageIds.length > 0, 502, "CITATION_REQUIRED");
    if (context.mode === "claims")
      requireThat(
        block.claimVersionIds.length > 0 && block.evidenceIds.length > 0,
        502,
        "CLAIM_SUPPORT_REQUIRED",
      );
  }
}
/** Closed newline-delimited JSON records. A final marker cannot authorize blocks. */
export class FormalBlockParser {
  private buffer = "";
  private bytes = 0;
  readonly blocks: FormalBlock[] = [];
  complete = false;
  constructor(
    private context: EvidenceContext,
    private onBlock?: (block: FormalBlock) => void,
  ) {}
  push(delta: string) {
    this.bytes += Buffer.byteLength(delta);
    requireThat(this.bytes <= 100000, 502, "OUTPUT_BUDGET_EXCEEDED");
    this.buffer += delta;
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"),
        line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (line) this.line(line);
    }
  }
  finish() {
    if (this.buffer.trim()) this.line(this.buffer.trim());
    this.buffer = "";
    requireThat(
      this.complete && this.blocks.length > 0,
      502,
      "MODEL_OUTPUT_INCOMPLETE",
    );
  }
  private line(line: string) {
    requireThat(!this.complete, 502, "BLOCK_AFTER_FINAL");
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      requireThat(false, 502, "MODEL_PROTOCOL_INVALID");
    }
    if (
      record &&
      typeof record === "object" &&
      "type" in record &&
      record.type === "final"
    ) {
      const final = z
        .object({
          type: z.literal("final"),
          count: z.number().int().positive(),
        })
        .strict()
        .parse(record);
      requireThat(
        final.count === this.blocks.length,
        502,
        "FINAL_COUNT_MISMATCH",
      );
      this.complete = true;
      return;
    }
    const block = formalBlockSchema.parse(record);
    requireThat(this.blocks.length < 20, 502, "BLOCK_LIMIT");
    validateFormalBlock(block, this.context, this.blocks.length + 1);
    this.onBlock?.(block); // Persistence must complete before any delivery sees it.
    this.blocks.push(block);
  }
}
