import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  status: number,
  code: string,
  message?: string,
): asserts condition {
  if (!condition) throw new Fault(status, code, message);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function id(): string {
  return randomUUID();
}
export interface Entity {
  id: string;
  domain: string;
  version: number;
}
export interface Identity {
  subject: string;
  platform: boolean;
}
export interface Domain extends Entity {
  name: string;
  active: string | null;
  epoch: number;
  maintenance: boolean;
}
export interface Grant extends Entity {
  subject: string;
  role: "member" | "admin";
  enabled: boolean;
  tags?: ("business" | "technical")[];
}
interface CommandReceipt extends Entity {
  outcomes: { operation: string; objectId?: string }[];
}
export function defaultStyle(grant: Grant): "business" | "technical" {
  return grant.tags?.includes("technical") ? "technical" : "business";
}

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    requireThat(
      Number(this.db.prepare("PRAGMA user_version").get()?.user_version) <= 3,
      503,
      "DATABASE_VERSION_UNSUPPORTED",
    );
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,domain TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS objects_scope ON objects(kind,domain);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,subject TEXT NOT NULL,platform INTEGER NOT NULL,expires INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'api');
      CREATE TABLE IF NOT EXISTS commands(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS operational_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,request_id TEXT NOT NULL,route TEXT NOT NULL,code TEXT NOT NULL,status INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS operational_events_time ON operational_events(at);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,domain TEXT NOT NULL,operation TEXT NOT NULL,object_id TEXT NOT NULL);
      `);
    if (
      !this.db
        .prepare("PRAGMA table_info(tokens)")
        .all()
        .some((c) => c.name === "kind")
    )
      this.db.exec(
        "ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'api'",
      );
    this.db.exec("PRAGMA user_version=3");
  }
  close() {
    this.db.close();
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get<T extends Entity>(kind: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  list<T extends Entity>(kind: string, domain?: string): T[] {
    const rows =
      domain === undefined
        ? this.db.prepare("SELECT data FROM objects WHERE kind=?").all(kind)
        : this.db
            .prepare("SELECT data FROM objects WHERE kind=? AND domain=?")
            .all(kind, domain);
    return rows.map((row) => JSON.parse(row.data as string) as T);
  }
  put<T extends Entity>(kind: string, entity: T): T {
    this.db
      .prepare(
        "INSERT INTO objects(kind,id,domain,version,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,data=excluded.data",
      )
      .run(
        kind,
        entity.id,
        entity.domain,
        entity.version,
        JSON.stringify(entity),
      );
    return structuredClone(entity);
  }
  remove(kind: string, key: string) {
    this.db.prepare("DELETE FROM objects WHERE kind=? AND id=?").run(kind, key);
  }
  token(
    token: string,
    actor: Identity,
    expires = Date.now() + 86400000,
    kind: "api" | "session" = "api",
  ) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO tokens(hash,subject,platform,expires,kind) VALUES(?,?,?,?,?)",
      )
      .run(hash(token), actor.subject, Number(actor.platform), expires, kind);
  }
  clearTokens() {
    this.db.prepare("DELETE FROM tokens").run();
  }
  revokeToken(token: string) {
    this.db.prepare("DELETE FROM tokens WHERE hash=?").run(hash(token));
  }
  identify(
    token: string,
    kind: "api" | "session" = "api",
  ): Identity | undefined {
    const row = this.db
      .prepare(
        "SELECT subject,platform FROM tokens WHERE hash=? AND expires>? AND kind=?",
      )
      .get(hash(token), Date.now(), kind) as
      { subject: string; platform: number } | undefined;
    return row
      ? { subject: row.subject, platform: Boolean(row.platform) }
      : undefined;
  }
  audit(actor: Identity, domain: string, operation: string, object: string) {
    this.db
      .prepare(
        "INSERT INTO audit(at,actor,domain,operation,object_id) VALUES(?,?,?,?,?)",
      )
      .run(Date.now(), actor.subject, domain, operation, object);
  }
  auditLog(domain: string) {
    return this.db
      .prepare("SELECT * FROM audit WHERE domain=? ORDER BY id DESC LIMIT 200")
      .all(domain);
  }
  operationalEvent(
    requestId: string,
    route: string,
    code: string,
    status: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO operational_events(at,request_id,route,code,status) VALUES(?,?,?,?,?)",
      )
      .run(Date.now(), requestId, route, code, status);
  }
  operationalEvents(since = 0) {
    return this.db
      .prepare(
        "SELECT at,request_id AS requestId,route,code,status FROM operational_events WHERE at>=? ORDER BY id DESC LIMIT 200",
      )
      .all(since);
  }
  cleanupOperationalData(eventCutoff: number, now: number) {
    const eventsRemoved = Number(
      this.db
        .prepare("DELETE FROM operational_events WHERE at<?")
        .run(eventCutoff).changes,
    );
    const tokensRemoved = Number(
      this.db.prepare("DELETE FROM tokens WHERE expires<=?").run(now).changes,
    );
    let loginsRemoved = 0;
    for (const login of this.list<Entity & { expires: number }>("login")) {
      if (login.expires <= now) {
        this.remove("login", login.id);
        loginsRemoved++;
      }
    }
    return { eventsRemoved, tokensRemoved, loginsRemoved };
  }
  commandReceipt(actor: Identity, domain: string, key: string) {
    const receipt = this.get<CommandReceipt>(
      "command-receipt",
      hash([actor.subject, domain, key]),
    );
    return receipt?.outcomes.length === 1 ? receipt.outcomes[0] : undefined;
  }
  command<T>(
    actor: Identity,
    domain: string,
    operation: string,
    key: string,
    body: unknown,
    authorize: () => void,
    execute: () => T,
  ): T {
    requireThat(
      key.length > 0 && key.length <= 200,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    return this.tx(() => {
      authorize();
      const recordReceipt = (result: T) => {
        if (!key.startsWith("wecom:")) return;
        const receiptId = hash([actor.subject, domain, key]);
        const previous = this.get<CommandReceipt>("command-receipt", receiptId);
        const outcomes = previous?.outcomes ?? [];
        if (!outcomes.some((o) => o.operation === operation))
          outcomes.push({
            operation,
            objectId: (result as { id?: string } | null)?.id,
          });
        this.put<CommandReceipt>("command-receipt", {
          id: receiptId,
          domain,
          version: (previous?.version ?? 0) + 1,
          outcomes,
        });
      };
      const scope = hash([actor.subject, domain, operation]),
        digest = hash(body);
      const old = this.db
        .prepare("SELECT digest,result FROM commands WHERE scope=? AND key=?")
        .get(scope, key) as { digest: string; result: string } | undefined;
      if (old) {
        requireThat(old.digest === digest, 409, "IDEMPOTENCY_CONFLICT");
        const result = JSON.parse(old.result) as T;
        recordReceipt(result);
        return result;
      }
      const result = execute();
      this.db
        .prepare(
          "INSERT INTO commands(scope,key,digest,result) VALUES(?,?,?,?)",
        )
        .run(scope, key, digest, JSON.stringify(result));
      recordReceipt(result);
      this.audit(
        actor,
        domain,
        operation,
        (result as { id?: string })?.id ?? domain,
      );
      return result;
    });
  }
}
export function access(
  store: Store,
  actor: Identity,
  domain: string,
  admin = false,
): Grant {
  const d = store.get<Domain>("domain", domain);
  requireThat(d, 404, "NOT_FOUND");
  requireThat(!d.maintenance, 503, "RECOVERY_VERIFICATION_REQUIRED");
  const grant = store.get<Grant>("grant", `${domain}:${actor.subject}`);
  requireThat(
    grant?.enabled && (!admin || grant.role === "admin"),
    403,
    "FORBIDDEN",
  );
  return grant;
}
export function version(entity: Entity, expected: number) {
  requireThat(entity.version === expected, 409, "VERSION_CONFLICT");
}
