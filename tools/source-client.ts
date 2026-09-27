import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireThat } from "../src/core.js";

export async function sourceConfiguration(file: string) {
  const config = z
    .object({
      server: z.url(),
      domain: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      root: z.string(),
      records: z.string(),
    })
    .strict()
    .parse(JSON.parse(await readFile(file, "utf8")));
  const server = new URL(config.server);
  requireThat(
    (server.protocol === "https:" ||
      (server.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname))) &&
      !server.username &&
      !server.password &&
      server.pathname === "/" &&
      !server.search &&
      !server.hash,
    400,
    "INVALID_SOURCE_HELPER_ORIGIN",
  );
  return config;
}

export function sourceClient(
  config: Awaited<ReturnType<typeof sourceConfiguration>>,
  token: string,
) {
  const server = new URL(config.server);
  return async (
    method: string,
    route: string,
    payload?: unknown,
    idem: string = randomUUID(),
  ) => {
    const target = new URL(route, server);
    requireThat(
      target.origin === server.origin,
      400,
      "INVALID_SOURCE_HELPER_ORIGIN",
    );
    const response = await fetch(target, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idem,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const value = (await response.json()) as any;
    requireThat(
      response.ok,
      response.status,
      typeof value?.error?.code === "string"
        ? value.error.code
        : "SOURCE_SERVICE_FAILED",
    );
    return value;
  };
}
