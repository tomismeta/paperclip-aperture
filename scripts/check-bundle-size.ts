import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BundleBudget = {
  label: string;
  path: string;
  maxBytes: number;
};

const BUNDLE_BUDGETS: BundleBudget[] = [
  { label: "UI bundle", path: "dist/ui/index.js", maxBytes: 100_000 },
  { label: "Worker bundle", path: "dist/worker.js", maxBytes: 700_000 },
  { label: "Manifest bundle", path: "dist/manifest.js", maxBytes: 10_000 },
];

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const results = await Promise.all(BUNDLE_BUDGETS.map(async (budget) => {
    const absolutePath = path.join(repoRoot, budget.path);
    const file = await stat(absolutePath);
    return {
      ...budget,
      bytes: file.size,
    };
  }));

  let hasFailure = false;

  for (const result of results) {
    const usage = ((result.bytes / result.maxBytes) * 100).toFixed(1);
    const line = `${result.label}: ${formatBytes(result.bytes)} / ${formatBytes(result.maxBytes)} (${usage}%)`;
    if (result.bytes > result.maxBytes) {
      hasFailure = true;
      console.error(`FAIL ${line}`);
    } else {
      console.log(`PASS ${line}`);
    }
  }

  if (hasFailure) {
    throw new Error("One or more bundle budgets were exceeded.");
  }
}

await main();
