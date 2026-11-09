// Utility formatting and content helpers

/**
 * Detects if content is binary by checking for non-text bytes
 * @param bytes - Content to check
 * @returns True if content appears to be binary
 * @note Checks first 8KB for null bytes or control characters
 */
export function detectBinary(bytes: Uint8Array): boolean {
  // Check first 8KB for null bytes or non-text characters
  const checkLength = Math.min(8192, bytes.length);
  for (let i = 0; i < checkLength; i++) {
    const byte = bytes[i];
    // Null byte or control characters (except tab, newline, carriage return)
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      return true;
    }
  }
  return false;
}

/**
 * Converts byte array to text, handling various encodings
 * @param bytes - Raw bytes to decode
 * @returns Decoded text string
 * @note Handles UTF-8, UTF-16 LE/BE with BOM detection
 */
export function bytesToText(bytes: Uint8Array): string {
  if (!bytes || bytes.byteLength === 0) return "";
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // UTF-16 LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    } catch {}
  }
  // UTF-16 BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    } catch {}
  }
  // Default to UTF-8
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return "(binary content)";
  }
}

/**
 * GitHub-style relative time ("3 days ago", "2 hours ago").
 * Falls back to a date for entries older than ~1 year.
 */
export function formatWhen(epochSeconds: number, tz: string): string {
  try {
    const offsetMatch = tz.match(/^([+-])(\d{2})(\d{2})$/);
    const utcDate = new Date(epochSeconds * 1000);
    if (!offsetMatch) {
      const iso = utcDate.toISOString();
      const noMs = iso.replace(/\.\d{3}Z$/, "Z");
      return noMs.replace("T", " ").replace("Z", " UTC");
    }

    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3]);
    const offsetMinutes = sign * (hours * 60 + minutes);
    const localDate = new Date(utcDate.getTime() + offsetMinutes * 60_000);
    const pad = (value: number) => String(value).padStart(2, "0");

    return (
      `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth() + 1)}-` +
      `${pad(localDate.getUTCDate())} ${pad(localDate.getUTCHours())}:` +
      `${pad(localDate.getUTCMinutes())}:${pad(localDate.getUTCSeconds())} ${tz}`
    );
  } catch {
    return String(epochSeconds);
  }
}
