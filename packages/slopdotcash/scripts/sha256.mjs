import { createHash } from "node:crypto";

/** Synchronous native hashing for Node build and evidence scripts. */
export function sha256Hex(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
