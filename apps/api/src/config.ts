import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  APP_MODE: z.enum(["local", "production"]).default("local"),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  API_ORIGIN: z.url().default("http://localhost:4000"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/venture_studio"),
  MONGODB_DB: z.string().min(1).default("venture_studio"),
  BETTER_AUTH_SECRET: z.string().min(32).default("local-only-change-me-32-characters-minimum"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.email().default("Venture Studio <noreply@example.invalid>"),
  ALLOW_DEV_AUTH: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  R2_ENDPOINT: z.url().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("venture-studio-local"),
  LOCAL_UPLOAD_DIR: z.string().default(".data/uploads"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(source);
  if (config.APP_MODE === "production") {
    if (config.ALLOW_DEV_AUTH) throw new Error("ALLOW_DEV_AUTH is forbidden in production");
    if (config.BETTER_AUTH_SECRET.startsWith("local-only")) throw new Error("BETTER_AUTH_SECRET must be configured in production");
    if (!config.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required in production");
    if (!config.R2_ENDPOINT || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) throw new Error("R2 credentials are required in production");
  }
  return config;
}
