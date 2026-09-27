import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { access, requireThat, type Store } from "./core.js";
import { allowedRelease, type Release } from "./publication.js";
import { path } from "./app.js";
import {
  validateSourceArtifacts,
  staticSourceTypes,
  type SourceArtifact,
} from "./source-artifacts.js";

// Immutable package bytes only. No path supplied by an HTTP user is read from disk.
export function registerSourceArtifacts(app: FastifyInstance, store: Store) {
  app.get(
    "/api/domains/:domain/releases/:id/source-artifacts/:artifactId",
    async (request, reply) => {
      const domain = path(request, "domain");
      access(store, request.actor, domain);
      const release = store.get<Release>("release", path(request, "id"));
      requireThat(release?.domain === domain, 404, "NOT_FOUND");
      allowedRelease(store, request.actor, release);
      const artifacts =
        (
          release.bundle as typeof release.bundle & {
            sourceArtifacts?: SourceArtifact[];
          }
        ).sourceArtifacts ?? [];
      const artifact = artifacts.find(
        (a) => a.id === path(request, "artifactId"),
      );
      requireThat(artifact, 404, "NOT_FOUND");
      validateSourceArtifacts([artifact], staticSourceTypes);
      return reply
        .type(artifact.mediaType)
        .header(
          "Content-Disposition",
          `attachment; filename="${artifact.id}${extname(artifact.path)}"`,
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .send(
          Buffer.from(
            artifact.content,
            artifact.kind === "excerpt" ? "utf8" : "base64",
          ),
        );
    },
  );
}
