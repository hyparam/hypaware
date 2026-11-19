#!/usr/bin/env node
// One-shot rules-only page: digest + render, no model labelling. ~2.5s.
// usage: node build.mjs [--from D] [--to D] [--remote T] [--out report.html]
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
const here = dirname(fileURLToPath(import.meta.url)); const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const digest = join(tmpdir(), `usage-digest-${process.pid}.json`);
const pass = ["--from", "--to", "--remote", "--attrib-window-min"].flatMap((k) => opt(k) ? [k, opt(k)] : []);
execFileSync(process.execPath, [join(here, "..", "..", "hypaware-usage-by-task", "scripts", "digest.mjs"), ...pass, "--out", digest], { stdio: "inherit" });
execFileSync(process.execPath, [join(here, "render.mjs"), "--digest", digest, ...(opt("--out") ? ["--out", opt("--out")] : [])], { stdio: "inherit" });
