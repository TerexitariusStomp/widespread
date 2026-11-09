// Applies D1 migrations to the in-memory test database before any suite
// runs. singleWorker + isolatedStorage:false means all files share one
// database — applyD1Migrations is idempotent, so one application is enough.
import { applyD1Migrations, env } from "cloudflare:test";
import { readAppD1Migrations } from "./util/d1Migrations";

await applyD1Migrations((env as { DB: D1Database }).DB, readAppD1Migrations());
