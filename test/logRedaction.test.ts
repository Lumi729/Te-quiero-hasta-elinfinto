import assert from "node:assert/strict";
import test from "node:test";
import { installLogRedaction, redact, secretValues } from "../src/logRedaction.js";

test("console output never carries the NetEase cookie or Bridge tokens", () => {
  const env = { NETEASE_COOKIE: "MUSIC_U=secretmusicu123456; __csrf=csrfvalue99; os=pc", BRIDGE_INGEST_TOKEN: "ingest-token-abcdef" } as NodeJS.ProcessEnv;
  const lines: string[] = [];
  const sink = { log: (...a: unknown[]) => lines.push(a.join(" ")), info: () => {}, warn: (...a: unknown[]) => lines.push(a.join(" ")), error: (...a: unknown[]) => lines.push(a.join(" ")), debug: () => {} };
  installLogRedaction(env, sink);
  sink.log("[ERR]", { status: 502, body: { code: 502 }, cookie: ["MUSIC_U=refreshedvalue777; Path=/", "MUSIC_A_T=abc123456; Path=/"] });
  sink.error("ingest with ingest-token-abcdef failed; raw secretmusicu123456 and csrfvalue99");
  sink.warn("GET /listener/events?session=abc.def&x=1 Authorization: Bearer eyJhbGciOi.payload-sig");
  const all = lines.join("\n");
  for (const leaked of ["refreshedvalue777", "abc123456", "ingest-token-abcdef", "secretmusicu123456", "csrfvalue99", "abc.def", "eyJhbGciOi"]) assert.ok(!all.includes(leaked), leaked);
  assert.match(all, /status: 502/, "the useful parts of the log stay");
  assert.match(all, /MUSIC_U=<hidden>/);
  assert.deepEqual(secretValues({} as NodeJS.ProcessEnv), []);
  assert.equal(redact("os=pc ok", secretValues(env)), "os=pc ok", "short harmless values stay");
});
