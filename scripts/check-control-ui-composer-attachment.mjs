#!/usr/bin/env node
// Fails when the built Control UI lacks the attachment-visible phone rule.
// Usage: node scripts/check-control-ui-composer-attachment.mjs [dist/control-ui]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "dist/control-ui";
const MARKER = "openclaw-composer-attachment-visible";
const assets = join(root, "assets");
const hits = readdirSync(assets)
  .filter((name) => name.endsWith(".css"))
  .filter((name) => readFileSync(join(assets, name), "utf8").includes(MARKER));
if (hits.length === 0) {
  console.error(`${MARKER} missing from ${assets}/*.css: the attached-image phone fix was dropped`);
  process.exit(1);
}
console.log(`${MARKER} present in ${hits.join(", ")}`);
