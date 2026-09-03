import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mobile = join(root, "apps", "mobile");
const forbiddenDependencies = ["@niagacore/db-local", "expo-sqlite", "expo-background-task", "expo-task-manager"];
const forbiddenSource = ["@niagacore/db-local", "expo-sqlite", "SQLiteProvider", "openDatabaseAsync", "SQLCipher"];

const packageJson = JSON.parse(await readFile(join(mobile, "package.json"), "utf8"));
const appJson = JSON.parse(await readFile(join(mobile, "app.json"), "utf8"));
const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
const violations = [];

for (const name of forbiddenDependencies) {
  if (dependencies[name]) violations.push(`dependency:${name}`);
}

const plugins = appJson.expo?.plugins ?? [];
for (const plugin of plugins) {
  const name = Array.isArray(plugin) ? plugin[0] : plugin;
  if (forbiddenDependencies.includes(name)) violations.push(`plugin:${name}`);
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) {
      const source = await readFile(path, "utf8");
      for (const token of forbiddenSource) {
        if (source.includes(token)) violations.push(`${relative(root, path)}:${token}`);
      }
    }
  }
}

await walk(join(mobile, "src"));

try {
  await access(join(root, "packages", "db-local", "package.json"));
  violations.push("workspace-package:packages/db-local");
} catch {
  // Expected: paket database lokal tidak boleh ada.
}

const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
for (const token of ["packages/db-local:", "expo-sqlite@", "expo-background-task@", "expo-task-manager@"]) {
  if (lockfile.includes(token)) violations.push(`lockfile:${token}`);
}

if (violations.length) {
  console.error(`Supabase-only check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log("Supabase-only check passed: no SQLite/SQLCipher package, lockfile entry, mobile dependency, plugin, or source import.");
