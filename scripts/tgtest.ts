/** Unit tests for the Telegram pure helpers (no bot boot, no I/O). */
import { splitChunks, parseCb } from "../src/surfaces/telegram-util";

let fail = 0;
const check = (n: string, c: boolean) => {
  console.log(`${c ? "✓" : "✗"} ${n}`);
  if (!c) fail++;
};

// parseCb
check("parseCb approve", JSON.stringify(parseCb("v1|a|abc")) === JSON.stringify({ decision: true, id: "abc" }));
check("parseCb deny + dotted id", JSON.stringify(parseCb("v1|d|lk3.42")) === JSON.stringify({ decision: false, id: "lk3.42" }));
check("parseCb rejects garbage", parseCb("garbage") === null);
check("parseCb rejects bad decision", parseCb("v1|x|id") === null);
check("parseCb rejects empty id", parseCb("v1|a|") === null);

// splitChunks
check("short text → 1 chunk", splitChunks("hello").length === 1);
check("empty → 0 chunks", splitChunks("").length === 0);
const long = "a".repeat(10000);
const ch = splitChunks(long);
check("long text chunked", ch.length > 1);
check("every chunk ≤ 3900", ch.every((c) => c.length <= 3900));
check("no-whitespace content fully covered", ch.join("").length === long.length);

// surrogate-pair safety: emoji straddling the 3899/3900 boundary
const s = "a".repeat(3899) + "😀" + "b".repeat(3000);
const ch2 = splitChunks(s);
const wellFormed = ch2.every((c) => {
  const last = c.charCodeAt(c.length - 1);
  const first = c.charCodeAt(0);
  const loneHighEnd = last >= 0xd800 && last <= 0xdbff;
  const loneLowStart = first >= 0xdc00 && first <= 0xdfff;
  return !loneHighEnd && !loneLowStart;
});
check("surrogate pair never bisected", wellFormed);
check("emoji preserved across split", ch2.join("").includes("😀"));

// prefers line/space breaks when available
const para = "x".repeat(2000) + "\n\n" + "y".repeat(3000);
const ch3 = splitChunks(para);
check("breaks on paragraph boundary", ch3[0] === "x".repeat(2000));

console.log(fail === 0 ? "\nTG UTIL OK ✓" : `\n${fail} FAILED ✗`);
process.exit(fail ? 1 : 0);
