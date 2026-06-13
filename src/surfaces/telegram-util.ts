/**
 * Pure helpers for the Telegram surface (extracted so they're unit-testable
 * without booting the bot). No I/O.
 */

export const SAFE = 3900; // stay under Telegram's 4096-char limit

/** Split into chunks under `limit`, preferring paragraph/line/space breaks; never bisects an emoji. */
export function splitChunks(text: string, limit = SAFE): string[] {
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > limit) {
    let cutAt = limit;
    const code = rem.charCodeAt(limit);
    if (code >= 0xdc00 && code <= 0xdfff) cutAt = limit - 1; // low surrogate at boundary → back off
    const slice = rem.slice(0, cutAt);
    let cut = slice.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = slice.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = slice.lastIndexOf(" ");
    if (cut <= 0) cut = slice.length;
    chunks.push(rem.slice(0, cut));
    rem = rem.slice(cut).replace(/^\s+/, "");
  }
  if (rem.length > 0) chunks.push(rem);
  return chunks;
}

/** Parse an approval button's callback_data: "v1|a|<id>" / "v1|d|<id>". */
export function parseCb(data: string): { decision: boolean; id: string } | null {
  const [ver, d, id] = data.split("|");
  if (ver !== "v1" || (d !== "a" && d !== "d") || !id) return null;
  return { decision: d === "a", id };
}
