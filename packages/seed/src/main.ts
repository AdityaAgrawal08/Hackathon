/**
 * CLI entry: writes fixture files + meta with sha256 content hashes.
 * Byte-determinism (T4 gate): same invocation ⇒ identical file bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateCorpus } from "./generate.js";

const OUT_DIR = resolve(import.meta.dirname ?? ".", "fixtures");

function emit(name: "training" | "demo", customerCount: number, targetEvents: number) {
  const corpus = generateCorpus(name, { customerCount, targetEvents });
  const body = JSON.stringify(
    { seedLabel: corpus.meta.seedLabel, customers: corpus.customers, events: corpus.events },
    null,
    2,
    );
  const sha256 = createHash("sha256").update(body).digest("hex");
  const meta = { ...corpus.meta, sha256 };
  return { body, meta };
}

function main() {
  const which = process.argv.includes("--corpus")
    ? (process.argv[process.argv.indexOf("--corpus") + 1] ?? "all")
    : "all";

  mkdirSync(OUT_DIR, { recursive: true });
  const metas: unknown[] = [];

  if (which === "all" || which === "training") {
    const t = emit("training", 1200, 5000);
    writeFileSync(join(OUT_DIR, "training.json"), t.body);
    metas.push(t.meta);
    console.log(`training: ${t.meta.customerCount} customers, ${t.meta.eventCount} events, sha ${t.meta.sha256.slice(0, 12)}…`);
  }
  if (which === "all" || which === "demo") {
    const d = emit("demo", 60, 230);
    writeFileSync(join(OUT_DIR, "demo.json"), d.body);
    metas.push(d.meta);
    console.log(`demo: ${d.meta.customerCount} customers, ${d.meta.eventCount} events, sha ${d.meta.sha256.slice(0, 12)}…`);
  }
  writeFileSync(join(OUT_DIR, "meta.json"), `${JSON.stringify(metas, null, 2)}\n`);
}

main();
