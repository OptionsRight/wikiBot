import { cp } from "node:fs/promises";
await cp("web", "dist/web", { recursive: true });
await cp("python", "dist/python", {
  recursive: true,
  filter: (path) => !path.includes("__pycache__"),
});
await cp("contracts", "dist/contracts", { recursive: true });
