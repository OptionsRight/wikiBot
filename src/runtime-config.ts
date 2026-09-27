import { z } from "zod";

type Environment = Record<string, string | undefined>;
const mapping = z.record(z.string().min(1), z.string().min(1));
const botSchema = z
  .object({
    botId: z.string().min(1),
    domain: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    members: mapping,
    notifications: z.boolean().default(false),
    notificationRecipients: mapping.default({}),
    groups: z.array(z.string().min(1)).default([]),
  })
  .strict();

export function wecomConfiguration(env: Environment) {
  if (env.WECOM_ENABLED !== "1") return [];
  const configured = env.WECOM_BOTS_JSON
    ? JSON.parse(env.WECOM_BOTS_JSON)
    : [
        {
          botId: env.WECOM_BOT_ID,
          domain: env.WECOM_DOMAIN,
          secretEnv: "WECOM_SECRET",
          members: JSON.parse(env.WECOM_MEMBERS_JSON ?? "{}"),
          notifications: env.WECOM_NOTIFICATIONS_ENABLED === "1",
          notificationRecipients: JSON.parse(
            env.WECOM_NOTIFICATION_RECIPIENTS_JSON ?? "{}",
          ),
          groups: JSON.parse(env.WECOM_GROUPS_JSON ?? "[]"),
        },
      ];
  const bots = z.array(botSchema).min(1).max(50).parse(configured);
  if (new Set(bots.map((b) => b.botId)).size !== bots.length)
    throw new Error("DUPLICATE_BOT_ID");
  return bots.map(({ secretEnv, ...bot }) => {
    const secret = env[secretEnv];
    if (!secret) throw new Error("WECOM_SECRET_NOT_CONFIGURED");
    return { ...bot, secret };
  });
}

export function operationalRetention(env: Environment) {
  if (!env.OPERATIONAL_RETENTION_MS && !env.OPERATIONAL_RETENTION_POLICY)
    return undefined;
  return z
    .object({
      eventRetentionMs: z
        .number()
        .int()
        .min(60000)
        .max(365 * 86400000),
      policyId: z.string().trim().min(1).max(200),
    })
    .parse({
      eventRetentionMs: Number(env.OPERATIONAL_RETENTION_MS),
      policyId: env.OPERATIONAL_RETENTION_POLICY,
    });
}
