import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenApi } from "../openapi.js";
import { operationsToTools } from "../tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findSpec(): string {
  if (process.env.LEARNWORLDS_OPENAPI_PATH) return resolve(process.env.LEARNWORLDS_OPENAPI_PATH);
  const bundled = resolve(__dirname, "..", "..", "spec", "learnworlds-openapi.yaml");
  if (!existsSync(bundled)) throw new Error(`Spec not found at ${bundled}`);
  return bundled;
}

const { operations } = loadOpenApi(findSpec());
const tools = operationsToTools(operations);

const counts = { read: 0, write: 0, delete: 0 };
const byTag = new Map<string, { read: number; write: number; delete: number }>();

for (const t of tools) {
  const cat = t.annotations.destructiveHint
    ? "delete"
    : t.annotations.readOnlyHint
    ? "read"
    : "write";
  counts[cat]++;
  const tag = t.operation.tags[0] ?? "(untagged)";
  const row = byTag.get(tag) ?? { read: 0, write: 0, delete: 0 };
  row[cat]++;
  byTag.set(tag, row);
}

console.log(`Loaded ${operations.length} operations → ${tools.length} MCP tools.\n`);
console.log(`Read-only:   ${counts.read}`);
console.log(`Write:       ${counts.write}`);
console.log(`Destructive: ${counts.delete}`);

console.log("\nBy tag (read / write / delete):");
for (const [tag, row] of [...byTag.entries()].sort()) {
  console.log(
    `  ${tag.padEnd(28)} ${String(row.read).padStart(3)}  ${String(row.write).padStart(3)}  ${String(row.delete).padStart(3)}`,
  );
}

console.log("\nSample tools:");
for (const t of tools.slice(0, 20)) {
  const flag = t.annotations.destructiveHint
    ? "🔴"
    : t.annotations.readOnlyHint
    ? "🟢"
    : "🟡";
  console.log(`  ${flag}  ${t.name.padEnd(48)}  ${t.annotations.title ?? ""}`);
}

// Look for naming collisions
const seen = new Set<string>();
const dups: string[] = [];
for (const t of tools) {
  if (seen.has(t.name)) dups.push(t.name);
  seen.add(t.name);
}
if (dups.length > 0) console.warn("\n⚠️  Duplicate names:", dups);
else console.log("\nAll tool names unique ✓");
