/**
 * CLI wrapper around src/lib/weavyConverter.
 *
 * Usage:
 *   npx tsx scripts/weavy-to-nodebanana.ts <input.json> [output.json]
 *   npx tsx scripts/weavy-to-nodebanana.ts <inputDir>/ <outputDir>/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  convertWeavyToNB,
  type ConversionReport,
  type WeavyFile,
} from "../src/lib/weavyConverter";

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/_+/g, "_");
}

function processFile(inputPath: string, outputPath: string): ConversionReport {
  const raw = fs.readFileSync(inputPath, "utf8");
  const weavy = JSON.parse(raw) as WeavyFile;
  const nb = convertWeavyToNB(weavy, path.basename(inputPath));
  fs.writeFileSync(outputPath, JSON.stringify(nb, null, 2));
  return nb._conversion_report!;
}

function printReport(r: ConversionReport): void {
  const ratio = r.totalWeavyNodes > 0
    ? Math.round((r.convertedNodes / r.totalWeavyNodes) * 100)
    : 0;
  console.log(`\n${r.inputFile}`);
  console.log(`  ${r.convertedNodes}/${r.totalWeavyNodes} nodes converted (${ratio}%), ${r.placeholderNodes} placeholders`);
  console.log(`  edges: ${r.edgesIn} → ${r.edgesOut} (${r.edgeOrphans} orphans), ${r.bypassedRouters} routers bypassed, ${r.groupsCreated} groups`);
  if (Object.keys(r.unmappedTypes).length > 0) console.log(`  unmapped types:`, r.unmappedTypes);
  if (Object.keys(r.unmappedModels).length > 0) console.log(`  unmapped models:`, r.unmappedModels);
  if (r.warnings.length > 0) {
    console.log(`  warnings: ${r.warnings.length}`);
    for (const w of r.warnings.slice(0, 3)) console.log(`    - ${w}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx tsx scripts/weavy-to-nodebanana.ts <input.json|dir/> [output.json|dir/]");
    process.exit(1);
  }
  const inputArg = args[0];
  const outputArg = args[1];

  if (isDir(inputArg)) {
    const outDir = outputArg ?? path.join(path.dirname(inputArg), "converted");
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs.readdirSync(inputArg).filter((f) => f.endsWith(".json"));
    let totalIn = 0, totalConv = 0, totalPh = 0;
    for (const f of files) {
      const inP = path.join(inputArg, f);
      const outP = path.join(outDir, sanitizeFilename(f.replace(/^weavy-/, "").replace(/\.json$/, "") + ".json"));
      const r = processFile(inP, outP);
      printReport(r);
      totalIn += r.totalWeavyNodes;
      totalConv += r.convertedNodes;
      totalPh += r.placeholderNodes;
    }
    console.log(`\n=== Summary: ${files.length} files, ${totalConv}/${totalIn} nodes converted (${totalPh} placeholders) ===`);
  } else {
    const outputPath = outputArg ?? inputArg.replace(/\.json$/, ".nb.json");
    const r = processFile(inputArg, outputPath);
    printReport(r);
    console.log(`\nWrote: ${outputPath}`);
  }
}

main();
