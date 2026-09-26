import { cp } from "node:fs/promises";
await cp("web", "dist/web", { recursive: true });
