/** Real HTTP and migrated SQLite exercise the hourly cleanup and intake renewal together. */
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { sqliteD1 } from "../tests/sqlite-d1";
import { runScheduledMaintenance } from "../workers/identity";

test("a failed intake renewal fails the job, preserves evidence, and still cleans expired state", async () => {
  const { db, sqlite } = sqliteD1(
    readdirSync("migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  );
  const previous = "2026-10-21T12:00:00.000Z";
  const now = new Date("2026-10-22T12:00:00.000Z");
  const expired = "a".repeat(64);
  const live = "b".repeat(64);
  sqlite
    .query("INSERT INTO private_intake_status VALUES (1,1,?)")
    .run(previous);
  sqlite
    .query(
      "INSERT INTO identity_rate_limits VALUES (?,1,1,2),(?,1,9999999998,9999999999)",
    )
    .run(expired, live);
  let available = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      available
        ? Response.json({ enabled: true })
        : new Response("unavailable", { status: 503 }),
  });
  const run = () =>
    runScheduledMaintenance({ IDENTITY_DB: db }, now, (_url, init) =>
      fetch(server.url, init),
    );
  try {
    await expect(run()).rejects.toThrow("scheduled maintenance failed");
    expect(
      sqlite
        .query("SELECT enabled,verified_at FROM private_intake_status")
        .get(),
    ).toEqual({ enabled: 1, verified_at: previous });
    expect(
      sqlite.query("SELECT key_hash FROM identity_rate_limits").all(),
    ).toEqual([{ key_hash: live }]);
    available = true;
    await run();
    expect(
      sqlite
        .query("SELECT enabled,verified_at FROM private_intake_status")
        .get(),
    ).toEqual({ enabled: 1, verified_at: now.toISOString() });
  } finally {
    server.stop(true);
    sqlite.close();
  }
});
