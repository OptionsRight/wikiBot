import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  bundleSchema,
  validateBundle,
  identifier,
  type Bundle,
  type Page,
} from "./procedures.js";
import { hash, requireThat } from "./core.js";
import { readSourceText, sourceInventory } from "./source-files.js";
import {
  sourceArtifactSchema,
  captureSourceArtifacts,
  type SourceArtifact,
} from "./source-artifacts.js";
import { validateSourceLinks } from "./source-formats.js";
import {
  ControlledSource,
  manualMaintenanceAdapter,
} from "./controlled-source.js";

// A snapshot input declares pages without content; the content is read from
// the workspace and must match the declared hash at capture time.
const manifestSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: identifier,
            path: z.string().min(1).max(300),
            title: z.string().min(1).max(300),
            hash: z.string().length(64),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    sourceArtifacts: z
      .array(sourceArtifactSchema.omit({ content: true }))
      .max(100)
      .optional(),
    cases: bundleSchema.shape.cases,
    config: bundleSchema.shape.config,
  })
  .strict();

export async function snapshot(
  root: string,
  manifest: unknown,
  options: {
    approvedAttachmentTypes?: string[];
    correctionStore?: string;
  } = {},
): Promise<Bundle & { sourceArtifacts?: SourceArtifact[] }> {
  const input = manifestSchema.parse(manifest),
    base = await realpath(root);
  if (options.correctionStore)
    await new ControlledSource(
      options.correctionStore,
      manualMaintenanceAdapter(),
    ).verifyCorrections(base, input.pages);
  const read = (path: string) => readSourceText(base, path);
  const initialInventory = await sourceInventory(base);
  const pages: Page[] = [];
  for (const page of input.pages) {
    const content = await read(page.path);
    requireThat(hash(content) === page.hash, 409, "SOURCE_BASELINE_CONFLICT");
    pages.push({ ...page, content });
  }
  // A second complete read detects changes during capture. Operators must still pause all writers.
  for (const page of pages)
    requireThat(
      hash(await read(page.path)) === page.hash,
      409,
      "SOURCE_CHANGED_DURING_SNAPSHOT",
    );
  const sourceArtifacts = input.sourceArtifacts
    ? await captureSourceArtifacts(
        base,
        input.sourceArtifacts.map(({ hash: _hash, ...a }) => a),
        options.approvedAttachmentTypes,
      )
    : undefined;
  if (sourceArtifacts) {
    requireThat(
      sourceArtifacts.every(
        (a, i) => a.hash === input.sourceArtifacts![i]!.hash,
      ),
      409,
      "SOURCE_BASELINE_CONFLICT",
    );
    requireThat(
      !sourceArtifacts.some((a) =>
        pages.some((p) => p.id === a.id || p.path === a.path),
      ),
      400,
      "DUPLICATE_SOURCE_ARTIFACT",
    );
  }
  requireThat(
    hash(await sourceInventory(base)) === hash(initialInventory),
    409,
    "SOURCE_DIRECTORY_CHANGED",
  );
  validateSourceLinks(
    pages,
    (sourceArtifacts ?? []).map((a) => a.path),
  );
  const result = {
    pages,
    cases: input.cases,
    config: input.config,
    ...(sourceArtifacts ? { sourceArtifacts } : {}),
  };
  requireThat(
    Buffer.byteLength(JSON.stringify({ ...result, sourceArtifacts })) <=
      4 * 1024 * 1024,
    413,
    "SNAPSHOT_TOO_LARGE",
  );
  const bundle = bundleSchema.parse(result);
  validateBundle(bundle);
  if (options.correctionStore)
    await new ControlledSource(
      options.correctionStore,
      manualMaintenanceAdapter(),
    ).verifyCorrections(base, input.pages);
  return bundle;
}
