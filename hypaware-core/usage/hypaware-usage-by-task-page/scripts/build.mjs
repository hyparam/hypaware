#!/usr/bin/env node
// One-shot rules-only page: digest + render, no model labelling. ~2.5s.
// usage: node build.mjs [--from D] [--to D] [--remote T] [--out report.html]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
const here = dirname(fileURLToPath(import.meta.url)); const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
// the digest holds recorded prompts: it goes to a folder only this user can read, removed when the page is written
const dir = mkdtempSync(join(tmpdir(), "usage-")), digest = join(dir, "digest.json");
const pass = ["--from", "--to", "--remote", "--attrib-window-min"].flatMap((k) => opt(k) ? [k, opt(k)] : []);
try {
  execFileSync(process.execPath, [join(here, "..", "..", "hypaware-usage-by-task", "scripts", "digest.mjs"), ...pass, "--out", digest], { stdio: "inherit" });
  execFileSync(process.execPath, [join(here, "render.mjs"), "--digest", digest, ...(opt("--out") ? ["--out", opt("--out")] : [])], { stdio: "inherit" });
} finally { rmSync(dir, { recursive: true, force: true }); }
