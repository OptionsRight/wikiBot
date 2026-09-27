import { z } from "zod";
import { extname } from "node:path";
import { hash, requireThat } from "./core.js";
import { readSource, sourcePath } from "./source-files.js";

export const staticSourceTypes = ["image/png", "image/jpeg"] as const;
export const sourceArtifactSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    path: z.string().min(1).max(300),
    kind: z.enum(["excerpt", "attachment"]),
    mediaType: z.enum(["text/plain", ...staticSourceTypes]),
    content: z.string().max(1400000),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const sourceArtifactsSchema = z.array(sourceArtifactSchema).max(100);
export type SourceArtifact = z.infer<typeof sourceArtifactSchema>;
export type SourceArtifactInput = Omit<SourceArtifact, "content" | "hash">;
export function validateSourceArtifacts(
  input: unknown,
  approvedTypes: readonly string[] = [],
) {
  const artifacts = sourceArtifactsSchema.parse(input);
  requireThat(
    new Set(artifacts.map((a) => a.id)).size === artifacts.length &&
      new Set(artifacts.map((a) => a.path)).size === artifacts.length,
    400,
    "DUPLICATE_SOURCE_ARTIFACT",
  );
  let total = 0;
  for (const a of artifacts) {
    sourcePath(a.path);
    requireThat(
      hash(a.content) === a.hash,
      400,
      "SOURCE_ARTIFACT_HASH_MISMATCH",
    );
    const bytes = Buffer.from(
      a.content,
      a.kind === "excerpt" ? "utf8" : "base64",
    );
    requireThat(
      bytes.length <= (a.kind === "excerpt" ? 200000 : 1024 * 1024),
      413,
      "SOURCE_ARTIFACT_TOO_LARGE",
    );
    total += bytes.length;
    if (a.kind === "excerpt")
      requireThat(
        a.mediaType === "text/plain" &&
          [".md", ".txt"].includes(extname(a.path)),
        400,
        "INVALID_SOURCE_EXCERPT",
      );
    else {
      requireThat(
        approvedTypes.includes(a.mediaType),
        400,
        "SOURCE_ATTACHMENT_TYPE_NOT_APPROVED",
      );
      requireThat(
        bytes.toString("base64") === a.content,
        400,
        "INVALID_SOURCE_ENCODING",
      );
      const png =
        a.mediaType === "image/png" &&
        extname(a.path) === ".png" &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg =
        a.mediaType === "image/jpeg" &&
        [".jpg", ".jpeg"].includes(extname(a.path)) &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255;
      requireThat(png || jpg, 400, "INVALID_STATIC_SOURCE_ATTACHMENT");
    }
  }
  requireThat(total <= 2 * 1024 * 1024, 413, "SOURCE_ARTIFACTS_TOO_LARGE");
  return artifacts;
}
export async function captureSourceArtifacts(
  root: string,
  inputs: SourceArtifactInput[],
  approvedTypes: readonly string[] = [],
) {
  const artifacts: SourceArtifact[] = [];
  for (const a of inputs) {
    const bytes = await readSource(
      root,
      a.path,
      a.kind === "excerpt" ? 200000 : 1024 * 1024,
    );
    const content =
      a.kind === "excerpt"
        ? new TextDecoder("utf8", { fatal: true }).decode(bytes)
        : bytes.toString("base64");
    artifacts.push({ ...a, content, hash: hash(content) });
  }
  return validateSourceArtifacts(artifacts, approvedTypes);
}
