import { mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { demoModel } from "../src/demo-model.js";
import { sampleBundle } from "../test/helpers.js";
await mkdir(".local", { recursive: true, mode: 0o700 });
try {
  await access(".local/wikibot.sqlite");
  throw new Error(
    "Database already exists. Use a separate working directory for a fresh demo.",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const operator = randomBytes(32).toString("base64url");
const app = await buildApp({
  database: ".local/wikibot.sqlite",
  bootstrap: { token: operator, subject: "demo-operator" },
  model: demoModel,
});
async function post(
  method: "POST" | "PUT",
  url: string,
  payload: unknown,
  token = operator,
) {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  });
  if (r.statusCode >= 400) throw new Error(r.body);
  return r.json();
}
try {
  await post("POST", "/api/domains", { id: "demo", name: "合成演示领域" });
  await post("PUT", "/api/domains/demo/members/demo-admin", {
    role: "admin",
    expectedVersion: 0,
  });
  await post("PUT", "/api/domains/demo/members/demo-member", {
    role: "member",
    expectedVersion: 0,
  });
  const admin = (await post("POST", "/api/identities/demo-admin/tokens", {}))
      .token,
    member = (await post("POST", "/api/identities/demo-member/tokens", {}))
      .token;
  await post("POST", "/api/models/qualify", {
    model: "test-model",
    revision: "r1",
    expectedEpoch: 0,
    evidence: "合成演示模型，仅用于演示产品交互，不是业务评估",
  });
  const bundle = sampleBundle(),
    r = await post("POST", "/api/domains/demo/submissions", bundle, admin);
  for (const c of bundle.cases)
    await post(
      "POST",
      `/api/domains/demo/releases/${r.id}/evaluations`,
      { caseId: c.id, descriptorHash: r.descriptorHash },
      admin,
    );
  const reviewed = await post(
    "POST",
    `/api/domains/demo/releases/${r.id}/review`,
    {
      expectedVersion: r.version,
      descriptorHash: r.descriptorHash,
      evidence: "演示数据和合成模型人工核对，仅用于本地交互",
      approved: true,
    },
    admin,
  );
  await post(
    "POST",
    `/api/domains/demo/releases/${r.id}/activate`,
    {
      expectedVersion: reviewed.version,
      expectedEpoch: r.baseEpoch,
      expectedActive: r.baseActive,
      descriptorHash: r.descriptorHash,
    },
    admin,
  );
  await writeFile(
    ".local/demo-access.json",
    JSON.stringify({ operator, admin, member }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(
    "Demo prepared. Access tokens are in .local/demo-access.json (not logged or committed). Run: WIKIBOT_DEMO=1 npm run dev\n",
  );
} finally {
  await app.close();
}
