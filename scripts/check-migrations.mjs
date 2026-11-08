#!/usr/bin/env node
/**
 * CI guard (spec §18 / §12): every DB migration must ship with both an UP and a DOWN file
 * so it is reversible. Fails the build if a version is missing its pair.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.cwd(), "db", "migrations");
const files = readdirSync(dir);

const versions = new Map(); // version -> { up, down }
for (const f of files) {
  const m = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(f);
  if (!m) {
    console.error(`✗ Unexpected file in db/migrations (expected <version>_<name>.(up|down).sql): ${f}`);
    process.exit(1);
  }
  const [, version, , dir2] = m;
  const entry = versions.get(version) ?? {};
  entry[dir2] = f;
  versions.set(version, entry);
}

let ok = true;
for (const [version, entry] of [...versions].sort()) {
  if (!entry.up || !entry.down) {
    ok = false;
    console.error(`✗ Migration ${version} is missing its ${entry.up ? "down" : "up"} file.`);
  } else {
    console.log(`✓ ${version}: ${entry.up} / ${entry.down}`);
  }
}

if (!ok) {
  console.error("Migration pairing check FAILED.");
  process.exit(1);
}
console.log(`Migration pairing check passed (${versions.size} migration(s)).`);
