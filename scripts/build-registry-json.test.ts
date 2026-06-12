// Golden-in-sync guard for the fetchable `registry.json` artifact. Mirrors the
// cloud's `openapi.golden.yaml` test: regenerating from the YAML source must
// reproduce the committed file byte-for-byte, so a `providers/*.yaml` or
// `canonical.yaml` edit that forgets to rebuild the artifact fails CI.
//
//   fix: bun run build-registry-json && git add registry.json

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { buildRegistryJson, REGISTRY_JSON_PATH } from "./build-registry-json";

test("registry.json is in sync with the YAML source", async () => {
  const committed = await readFile(REGISTRY_JSON_PATH, "utf8");
  const built = await buildRegistryJson();
  expect(built).toBe(committed);
});
