import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { bundleV2Schema } from "../src/procedures.js";
import {
  normalizedSchema,
  profileSchema,
  normalizationTaskSchema,
  wireHash,
  wireCanonical,
} from "../src/knowledge/contracts.js";
import { semanticReportSchema } from "../src/knowledge/semantic-evaluation.js";
await mkdir("contracts/knowledge", { recursive: true });
for (const [name, schema] of Object.entries({
  "bundle-v2": bundleV2Schema,
  "normalized-document-v1": normalizedSchema,
  "normalizer-profile-v1": profileSchema,
  "normalization-task-v1": normalizationTaskSchema,
  "semantic-report-v1": semanticReportSchema,
}))
  await writeFile(
    `contracts/knowledge/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
const vector = {
  z: ['中文😀\n\t\\"', null, true, false, -9007199254740991],
  A: 0,
  a: { z: 1, A: 2, _: 3 },
};
await writeFile(
  "contracts/knowledge/hash-v1.json",
  JSON.stringify(
    {
      algorithm: "sha256-utf8-ascii-key-canonical-json-integers-v1",
      value: vector,
      canonical: wireCanonical(vector),
      sha256: wireHash(vector),
    },
    null,
    2,
  ) + "\n",
);
