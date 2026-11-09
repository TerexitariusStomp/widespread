type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };


export async function safeParseJsonRequest(request: Request): Promise<JsonValue | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}
