#!/usr/bin/env node
/**
 * Wiki Lint — health checks for the compiled wiki.
 *
 * In the LLM-wiki pattern, drift (pages silently going stale as the underlying
 * knowledge moves) is the primary failure mode, and a periodic lint pass is
 * the countermeasure. Because Open Brain keeps SQL as the source of truth,
 * most checks here are cheap structural queries — no LLM calls.
 *
 * Checks:
 *   1. STALE pages     — entities.last_seen_at newer than page generated_at.
 *   2. ORPHAN pages    — page's entity_id no longer exists in entities.
 *   3. MISSING pages   — recently-seen entities with >= min-linked thoughts
 *                        but no compiled page (bounded scan).
 *   4. CONTRADICTIONS  — thought_edges rows with relation='contradicts' where
 *                        neither side has been superseded (per the classifier
 *                        convention: (from=A, to=B, 'supersedes') = A replaces
 *                        B, so a resolved side appears as to_thought_id).
 *   5. LINK HYGIENE    — dangling [[wikilinks]] (target page not yet written;
 *                        informational — they are "write later" markers) and
 *                        pages with zero inbound wikilinks.
 *
 * Writes {out-dir}/lint-report.md + lint-report.json (regenerated wholesale).
 * Exit code 0 unless --strict is passed AND stale/orphan/contradiction
 * findings exist.
 *
 * Usage:
 *   node recipes/wiki-compiler/lint-wiki.mjs [--out-dir <path>] [--min-linked N]
 *        [--missing-scan N] [--max-report N] [--strict]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "compiled-wiki");

// ── env + args ──────────────────────────────────────────────────────────────

function loadDotEnv() {
  for (const rel of [".env", ".env.local"]) {
    const p = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    minLinked: 3,
    missingScan: 150,
    maxReport: 30,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--out-dir") args.outDir = path.resolve(REPO_ROOT, next());
    else if (a.startsWith("--out-dir=")) args.outDir = path.resolve(REPO_ROOT, a.slice(10));
    else if (a === "--min-linked") args.minLinked = Number(next()) || args.minLinked;
    else if (a === "--missing-scan") args.missingScan = Number(next()) || args.missingScan;
    else if (a === "--max-report") args.maxReport = Number(next()) || args.maxReport;
    else if (a === "--strict") args.strict = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

// ── PostgREST client (read-only usage) ──────────────────────────────────────

function createSupabase(env) {
  const base = String(env.OPEN_BRAIN_URL || "").replace(/\/$/, "");
  const key = env.OPEN_BRAIN_SERVICE_KEY;
  if (!base || !key) {
    throw new Error("OPEN_BRAIN_URL and OPEN_BRAIN_SERVICE_KEY are required.");
  }
  return {
    async get(resource, query) {
      const url = `${base}/rest/v1/${resource}?${query}`;
      const res = await fetch(url, {
        headers: { apikey: key, authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        throw new Error(`GET ${resource} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return await res.json();
    },
  };
}

async function fetchAll(sb, resource, baseQuery, { pageSize = 1000, cap = 5000 } = {}) {
  const rows = [];
  for (let offset = 0; offset < cap; offset += pageSize) {
    const page = await sb.get(resource, `${baseQuery}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── page scanning ───────────────────────────────────────────────────────────

function scanEntityPages(entitiesDir) {
  const pages = [];
  let files = [];
  try {
    files = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return pages;
  }
  for (const f of files) {
    const p = path.join(entitiesDir, f);
    let raw;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const idMatch = raw.slice(0, 2048).match(/^entity_id:\s*(\S+)/m);
    const genMatch = raw.slice(0, 2048).match(/^generated_at:\s*(\S+)/m);
    const nameMatch = raw.slice(0, 2048).match(/^entity_name:\s*(.*)$/m);
    const wikilinks = [];
    for (const m of raw.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) {
      wikilinks.push(m[1].trim());
    }
    pages.push({
      file: f,
      slug: f.replace(/\.md$/, ""),
      entityId: idMatch ? String(idMatch[1]) : null,
      generatedAt: genMatch ? genMatch[1] : null,
      name: nameMatch ? nameMatch[1].replace(/^"|"$/g, "") : f,
      wikilinks,
    });
  }
  return pages;
}

// ── checks ──────────────────────────────────────────────────────────────────

async function checkStaleAndOrphans(sb, pages) {
  const ids = pages.map((p) => p.entityId).filter(Boolean);
  const known = new Map();
  for (const c of chunk(Array.from(new Set(ids)), 100)) {
    const rows = await sb.get(
      "entities",
      `select=id,canonical_name,last_seen_at&id=in.(${c.join(",")})`,
    );
    for (const r of rows) known.set(String(r.id), r);
  }
  const stale = [];
  const orphans = [];
  for (const p of pages) {
    if (!p.entityId) continue;
    const row = known.get(p.entityId);
    if (!row) {
      orphans.push({ file: p.file, entity_id: p.entityId, name: p.name });
      continue;
    }
    const gen = Date.parse(p.generatedAt || "");
    const seen = Date.parse(row.last_seen_at || "");
    if (!Number.isNaN(gen) && !Number.isNaN(seen) && seen > gen) {
      stale.push({
        file: p.file,
        entity_id: p.entityId,
        name: row.canonical_name,
        generated_at: p.generatedAt,
        last_seen_at: row.last_seen_at,
        days_behind: Math.round((seen - gen) / 86400000),
      });
    }
  }
  stale.sort((a, b) => b.days_behind - a.days_behind);
  return { stale, orphans };
}

async function checkMissingPages(sb, pages, minLinked, scanLimit) {
  const havePage = new Set(pages.map((p) => p.entityId).filter(Boolean));
  const ents = await sb.get(
    "entities",
    `select=id,entity_type,canonical_name,last_seen_at&order=last_seen_at.desc&limit=${scanLimit}`,
  );
  const missing = [];
  for (const e of ents) {
    if (havePage.has(String(e.id))) continue;
    // Head-count only up to minLinked rows — cheap eligibility probe.
    const rows = await sb.get(
      "thought_entities",
      `select=thought_id&entity_id=eq.${e.id}&limit=${minLinked}`,
    );
    if (rows.length >= minLinked) {
      missing.push({
        entity_id: e.id,
        name: e.canonical_name,
        type: e.entity_type,
        last_seen_at: e.last_seen_at,
      });
    }
  }
  return { missing, scanned: ents.length };
}

async function checkContradictions(sb, maxReport) {
  let contradicts;
  try {
    contradicts = await fetchAll(
      sb,
      "thought_edges",
      "select=from_thought_id,to_thought_id,confidence,created_at&relation=eq.contradicts&order=created_at.desc",
    );
  } catch (err) {
    // thought_edges may not exist on brains without the typed-edges schema.
    return { unresolved: [], skipped: true, reason: err.message };
  }
  if (contradicts.rows.length === 0) return { unresolved: [], skipped: false };

  const { rows: supersedes } = await fetchAll(
    sb,
    "thought_edges",
    "select=from_thought_id,to_thought_id&relation=eq.supersedes",
  );
  // (from=A, to=B, 'supersedes') = A replaces B → B is settled.
  const superseded = new Set(supersedes.map((s) => String(s.to_thought_id)));

  const unresolved = contradicts.rows.filter(
    (c) => !superseded.has(String(c.from_thought_id)) && !superseded.has(String(c.to_thought_id)),
  );

  // Attach short content previews for the reported subset.
  const report = unresolved.slice(0, maxReport);
  const previewIds = Array.from(
    new Set(report.flatMap((c) => [c.from_thought_id, c.to_thought_id])),
  );
  const contents = new Map();
  for (const c of chunk(previewIds, 50)) {
    const rows = await sb.get(
      "thoughts",
      `select=id,content&id=in.(${c.map((id) => `"${id}"`).join(",")})`,
    );
    for (const r of rows) contents.set(String(r.id), String(r.content || ""));
  }
  const preview = (id) => {
    const c = contents.get(String(id));
    return c ? c.replace(/\s+/g, " ").slice(0, 140) : "(content unavailable)";
  };
  return {
    unresolved: report.map((c) => ({
      from: c.from_thought_id,
      to: c.to_thought_id,
      confidence: c.confidence,
      created_at: c.created_at,
      from_preview: preview(c.from_thought_id),
      to_preview: preview(c.to_thought_id),
    })),
    total_unresolved: unresolved.length,
    total_contradictions: contradicts.rows.length,
    truncated_scan: contradicts.truncated,
    skipped: false,
  };
}

function checkLinkHygiene(pages) {
  const slugs = new Set(pages.map((p) => p.slug));
  const inbound = new Map();
  const dangling = new Map(); // target -> count
  for (const p of pages) {
    for (const target of p.wikilinks) {
      if (slugs.has(target)) {
        inbound.set(target, (inbound.get(target) || 0) + 1);
      } else {
        dangling.set(target, (dangling.get(target) || 0) + 1);
      }
    }
  }
  const unlinked = pages.filter((p) => !inbound.has(p.slug)).map((p) => p.slug);
  const danglingSorted = Array.from(dangling.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([target, count]) => ({ target, count }));
  return { dangling: danglingSorted, unlinked_count: unlinked.length, unlinked };
}

// ── report rendering ────────────────────────────────────────────────────────

function renderMarkdown(report, args) {
  const L = [];
  L.push("# Wiki Lint Report", "");
  L.push(`> Generated ${report.generated_at} — ${report.page_count} entity page(s) scanned.`);
  L.push("> This file is generated by lint-wiki.mjs. Do not edit by hand.", "");
  L.push("## Summary", "");
  L.push(`- Stale pages: **${report.stale.length}**`);
  L.push(`- Orphan pages (entity deleted/merged): **${report.orphans.length}**`);
  L.push(`- Missing pages (eligible, no page): **${report.missing.length}** (scanned ${report.missing_scanned} recent entities)`);
  if (report.contradictions.skipped) {
    L.push(`- Contradictions: _skipped (${report.contradictions.reason})_`);
  } else {
    L.push(
      `- Unresolved contradictions: **${report.contradictions.total_unresolved ?? 0}** / ${report.contradictions.total_contradictions ?? 0} total`,
    );
  }
  L.push(`- Dangling wikilinks: **${report.links.dangling.length}** distinct target(s)`);
  L.push(`- Pages with no inbound wikilink: **${report.links.unlinked_count}**`, "");

  if (report.stale.length > 0) {
    L.push("## Stale pages", "", "Evidence moved after the page was generated. Regenerate (incremental compile picks these up).", "");
    for (const s of report.stale.slice(0, args.maxReport)) {
      L.push(`- ${s.name} (\`${s.file}\`) — ${s.days_behind} day(s) behind (page ${String(s.generated_at).slice(0, 10)}, last seen ${String(s.last_seen_at).slice(0, 10)})`);
    }
    if (report.stale.length > args.maxReport) L.push(`- … and ${report.stale.length - args.maxReport} more (see lint-report.json)`);
    L.push("");
  }

  if (report.orphans.length > 0) {
    L.push("## Orphan pages", "", "The entity behind these pages no longer exists (deleted or merged). Delete the page or re-point it.", "");
    for (const o of report.orphans.slice(0, args.maxReport)) {
      L.push(`- \`${o.file}\` (entity_id ${o.entity_id})`);
    }
    L.push("");
  }

  if (report.missing.length > 0) {
    L.push("## Missing pages", "", `Entities with >= ${args.minLinked} linked thoughts and no compiled page.`, "");
    for (const m of report.missing.slice(0, args.maxReport)) {
      L.push(`- ${m.name} (${m.type}, entity_id ${m.entity_id}) — last seen ${String(m.last_seen_at).slice(0, 10)}`);
    }
    L.push("");
  }

  if (!report.contradictions.skipped && (report.contradictions.unresolved || []).length > 0) {
    L.push("## Unresolved contradictions", "", "Thought pairs flagged `contradicts` where neither side has been superseded. Capture a correcting thought (which creates a `supersedes` edge) to settle each one.", "");
    for (const c of report.contradictions.unresolved) {
      L.push(`- [#${c.from}] "${c.from_preview}"`);
      L.push(`  ⇄ [#${c.to}] "${c.to_preview}"`);
    }
    L.push("");
  }

  if (report.links.dangling.length > 0) {
    L.push("## Dangling wikilinks (informational)", "", "Targets referenced but not yet written — natural \"write this later\" markers. The most-referenced ones are the best candidates for the next compile.", "");
    for (const d of report.links.dangling.slice(0, args.maxReport)) {
      L.push(`- [[${d.target}]] — referenced ${d.count}×`);
    }
    L.push("");
  }

  return L.join("\n").trimEnd() + "\n";
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node recipes/wiki-compiler/lint-wiki.mjs [--out-dir <path>] [--min-linked N] [--missing-scan N] [--max-report N] [--strict]",
    );
    return;
  }
  const sb = createSupabase(process.env);
  const entitiesDir = path.join(args.outDir, "entities");
  const pages = scanEntityPages(entitiesDir);
  if (pages.length === 0) {
    console.warn(`[wiki-lint] no entity pages under ${entitiesDir}; nothing to lint.`);
    return;
  }
  console.log(`[wiki-lint] scanning ${pages.length} page(s)…`);

  const [{ stale, orphans }, missingRes, contradictions] = await Promise.all([
    checkStaleAndOrphans(sb, pages),
    checkMissingPages(sb, pages, args.minLinked, args.missingScan),
    checkContradictions(sb, args.maxReport),
  ]);
  const links = checkLinkHygiene(pages);

  const report = {
    generated_at: new Date().toISOString(),
    page_count: pages.length,
    stale,
    orphans,
    missing: missingRes.missing,
    missing_scanned: missingRes.scanned,
    contradictions,
    links,
  };

  fs.writeFileSync(
    path.join(args.outDir, "lint-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(args.outDir, "lint-report.md"), renderMarkdown(report, args), "utf8");

  console.log(
    `[wiki-lint] stale=${stale.length} orphans=${orphans.length} missing=${missingRes.missing.length} ` +
      `contradictions=${contradictions.skipped ? "skipped" : (contradictions.total_unresolved ?? 0)} ` +
      `dangling-links=${links.dangling.length} unlinked-pages=${links.unlinked_count}`,
  );
  console.log(`[wiki-lint] report -> ${path.join(args.outDir, "lint-report.md")}`);

  const hardFindings =
    stale.length + orphans.length + (contradictions.total_unresolved ?? 0);
  if (args.strict && hardFindings > 0) {
    console.error(`[wiki-lint] --strict: ${hardFindings} hard finding(s).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[wiki-lint] FAILED:", err.stack || err.message);
  process.exit(1);
});
