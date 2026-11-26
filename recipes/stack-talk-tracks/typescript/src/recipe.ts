/**
 * Stack talk tracks: suggested talking points from fixed templates and each account's observed technologies.
 * Mirrors recipes/stack-talk-tracks/python/src/stack_talk_tracks/recipe.py; see that file and the recipe
 * README for the matching and template rules.
 */
import {
  ConfigError, FATAL_KINDS, Json, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, card, detailsJson, esc, kv, normaliseDomain, note, pricing, pyRepr, readRows,
} from "firmable-api-client";

export const NAME = "stack-talk-tracks";
export const TITLE = "Stack talk tracks";
export const DESCRIPTION = "Suggests talking points for each account from fixed templates filled with technologies observed in " +
  "its Firmable Tech Intel, each shown beside the technology fact it came from.";

export const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
export const PLACEHOLDERS = ["company_name", "product", "vendor", "category", "last_observed"];
const SUGGESTED = "Suggested, not a fact";
const STATUS_TONE: Record<string, string> = {
  tracks_suggested: "good", tracks_skipped: "review", no_track_matched: "neutral", no_track_matched_incomplete: "review",
  no_data: "unknown", invalid_input: "error", access_denied: "error", error: "error", not_processed: "unknown",
};
const STOP_TEXT: Record<string, string> = {
  page_limit: "the page limit was reached",
  error: "a later page failed",
  budget: "the credit limit was reached",
  repeated_cursor: "the API returned a cursor it had already returned",
};
const TECH_KEYS = ["product", "product_slug", "vendor", "vendor_slug", "filter", "filter_slug", "category",
  "category_slug", "pillar_slug", "confidence", "recency", "last_observed", "nature"];
const MD_INTRO = "Suggested talking points built from fixed templates and Firmable Tech Intel facts. Each suggestion " +
  "is labelled \"Suggested, not a fact\". The technology fact it came from is shown separately. A " +
  "detected technology does not prove buying intent, spend, licence count or active usage.";
const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /\{([^{}]*)\}/g;
const TOP_KEYS = new Set(["tracks", "max_pages", "max_items_per_track"]);
const TRACK_KEYS = new Set(["id", "label", "when", "template"]);
const WHEN_KEYS = new Set(["product_slugs", "vendor_slugs", "category_slugs", "aliases", "min_confidence"]);
const MAX_TRACKS = 20;
const MAX_TEMPLATE = 1000;
const MAX_PAGES_LIMIT = 25;

const rank = (m: Record<string, number>, v: unknown, def: number): number =>
  (typeof v === "string" && Object.prototype.hasOwnProperty.call(m, v) ? m[v] : def);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const s_ = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const t_ = (v: unknown): string => (v === null || v === undefined ? "not returned" : String(v));

// ----- configuration and input ---------------------------------------------------------------

function textList(value: unknown, where: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) {
    throw new ConfigError(`${where} must be a list of non-empty text values.`);
  }
  return value.map((v: string) => v.trim());
}

/** The placeholders a template uses, in order of first use. Rejects unknown names and stray braces. */
export function templatePlaceholders(template: string, where: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const name = m[1];
    if (!PLACEHOLDERS.includes(name)) {
      throw new ConfigError(`${where} uses an unknown placeholder {${name}}. Allowed: ` +
        PLACEHOLDERS.map((p) => `{${p}}`).join(", "));
    }
    if (!names.includes(name)) names.push(name);
  }
  const rest = template.replace(TOKEN, "");
  if (rest.includes("{") || rest.includes("}")) throw new ConfigError(`${where} has a brace that is not part of a placeholder.`);
  return names;
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const tracksRaw = raw.tracks;
  if (!Array.isArray(tracksRaw) || !tracksRaw.length) throw new ConfigError("tracks must be a non-empty list.");
  if (tracksRaw.length > MAX_TRACKS) throw new ConfigError(`tracks can hold at most ${MAX_TRACKS} items.`);
  const tracks: Json[] = [];
  const seen = new Set<string>();
  tracksRaw.forEach((t: Json, idx: number) => {
    const where = `tracks[${idx + 1}]`;
    if (!isObj(t)) throw new ConfigError(`${where} must be an object.`);
    let extra = Object.keys(t).filter((k) => !TRACK_KEYS.has(k)).sort();
    if (extra.length) throw new ConfigError(`${where} has unknown key(s): ${extra.join(", ")}`);
    const tid = t.id;
    if (typeof tid !== "string" || !ID.test(tid)) throw new ConfigError(`${where}.id must be 1 to 40 lower-case letters, digits or underscores.`);
    if (seen.has(tid)) throw new ConfigError(`${where}.id ${pyRepr(tid)} is used twice.`);
    seen.add(tid);
    const label = t.label ?? tid;
    if (typeof label !== "string" || !label.trim()) throw new ConfigError(`${where}.label must be text.`);
    const when = t.when;
    if (!isObj(when)) throw new ConfigError(`${where}.when must be an object.`);
    extra = Object.keys(when).filter((k) => !WHEN_KEYS.has(k)).sort();
    if (extra.length) throw new ConfigError(`${where}.when has unknown key(s): ${extra.join(", ")}`);
    const m: Record<string, string[]> = {};
    for (const k of ["product_slugs", "vendor_slugs", "category_slugs", "aliases"]) m[k] = textList(when[k], `${where}.when.${k}`);
    if (!Object.values(m).some((v) => v.length)) {
      throw new ConfigError(`${where}.when needs at least one product slug, vendor slug, category slug or alias.`);
    }
    const mc = when.min_confidence ?? "low";
    if (rank(CONFIDENCE_RANK, mc, 0) === 0) throw new ConfigError(`${where}.when.min_confidence must be one of: low, medium, high.`);
    const template = t.template;
    if (typeof template !== "string" || !template.trim()) throw new ConfigError(`${where}.template must be text.`);
    if (template.length > MAX_TEMPLATE) throw new ConfigError(`${where}.template can hold at most ${MAX_TEMPLATE} characters.`);
    const uses = templatePlaceholders(template, `${where}.template`);
    tracks.push({ id: tid, label: label.trim(), when: { ...m, min_confidence: mc }, template: template.trim(), placeholders: uses });
  });
  const maxPages = raw.max_pages ?? 5;
  if (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new ConfigError(`max_pages must be a whole number from 1 to ${MAX_PAGES_LIMIT}.`);
  }
  const per = raw.max_items_per_track ?? 1;
  if (typeof per !== "number" || !Number.isInteger(per) || per < 1 || per > 5) {
    throw new ConfigError("max_items_per_track must be a whole number from 1 to 5.");
  }
  return { tracks, max_pages: maxPages, max_items_per_track: per };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["domain", "company_id"] });
}

/** Returns [key, Tech Intel identifier, problem]. company_id wins over domain when both are filled. */
export function companyRef(row: Row): [string | null, Record<string, string> | null, string | null] {
  const cid = row.company_id || "";
  if (cid) {
    if (!COMPANY_ID.test(cid)) return [null, null, `company_id "${cid}" is not a valid Firmable company ID.`];
    return [`id:${cid}`, { id: cid }, null];
  }
  const raw = row.domain || "";
  const d = normaliseDomain(raw);
  if (!d) return [null, null, `domain "${raw}" is not a valid domain.`];
  return [`fqdn:${d}`, { fqdn: d }, null];
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const keys: string[] = [];
  for (const r of rows) {
    const key = companyRef(r)[0];
    if (key && !keys.includes(key)) keys.push(key);
  }
  const n = keys.length;
  const pages: number = config.max_pages;
  return [new PlannedCall("GET /tech-intel", `Up to ${pages} page(s) of Tech Intel for each unique valid company`,
    n * pages, [["tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n)]])];
}

// ----- matching and filling ------------------------------------------------------------------

export function matchBasis(item: Json, when: Json): string[] {
  const basis: string[] = [];
  for (const [field, key] of [["product_slug", "product_slugs"], ["vendor_slug", "vendor_slugs"], ["category_slug", "category_slugs"]]) {
    if (typeof item[field] === "string" && when[key].includes(item[field])) basis.push(`${field} ${item[field]}`);
  }
  const aliases = when.aliases.map((a: string) => a.toLowerCase());
  for (const field of ["product", "vendor"]) {
    const value = item[field];
    if (typeof value === "string" && aliases.includes(value.trim().toLowerCase())) basis.push(`alias of ${field} name ${value}`);
  }
  return basis;
}

function value(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "boolean" || v === null || v === undefined || typeof v === "object") return null;
  return String(v);
}

export function fill(template: string, values: Record<string, string | null>): string {
  return template.replace(TOKEN, (_m, name: string) => values[name] || "");
}

/** Escapes API and input text for Markdown: \ ` * _ [ ] < > | and a leading #. Line breaks become spaces. */
export function md(text: unknown): string {
  const s = String(text).replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
  return s.startsWith("#") ? "\\" + s : s;
}

// ----- Tech Intel retrieval ------------------------------------------------------------------

function recordError(ctx: RunContext, rowId: string | null, err: Json, stop = false): Json {
  const entry = { row_id: rowId, ...err };
  ctx.errors.push(entry);
  if ((stop || FATAL_KINDS.has(err.kind)) && ctx.stopped === null) ctx.stopped = entry;
  return entry;
}

/** Reads Tech Intel once per company key. A repeated key reuses the first result, errors included. */
async function fetch(ctx: RunContext, memo: Map<string, [Json, Json[]]>, key: string, identifier: Record<string, string>,
  rowId: string, maxPages: number): Promise<[Json, Json[]]> {
  const hit = memo.get(key);
  if (hit) return hit;
  const ti = await ctx.client.getTechIntel(identifier, { withEvidence: false, maxPages });
  const err: Json = ti.error;
  const entry = err ? recordError(ctx, rowId, err, err.kind === "forbidden") : null;
  const items = ti.items.filter((i) => isObj(i));
  const info = { company_id: ti.id, total: ti.total, retrieved: items.length, pages_fetched: ti.pages_fetched,
    complete: ti.complete, stop_reason: ti.stop_reason, error: entry };
  const out: [Json, Json[]] = [info, items];
  memo.set(key, out);
  return out;
}

function unavailable(info: Json): [string, string] | null {
  const err = info.error ?? {};
  if (info.pages_fetched === 0) {
    if (err.kind === "not_found") return ["no_data", "Tech Intel has no company for this identifier (404)."];
    if (err.kind === "forbidden") {
      return ["access_denied", "Firmable returned 403 Forbidden for Tech Intel. This API key cannot " +
        "use this endpoint. The run stops, because later requests would be refused too."];
    }
    return ["error", `Tech Intel could not be read: ${err.message}`];
  }
  if (info.complete && info.retrieved === 0) return ["no_data", "Firmable holds no technology data for this company (total 0)."];
  return null;
}

function incompleteText(info: Json): string {
  const totalText = Number.isInteger(info.total) ? String(info.total) : "an unknown number of";
  const why = STOP_TEXT[info.stop_reason] ?? info.stop_reason;
  return `The technology list is incomplete because ${why}: ${info.retrieved} of ${totalText} ` +
    `technologies were retrieved in ${info.pages_fetched} page(s).`;
}

// ----- run -----------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const coverage: string[] = [
    "Every talk track is a suggestion built from a fixed template in the configuration. It is not a fact " +
      "about the company, and no language model wrote it.",
    "Placeholders are filled only from Tech Intel fields and the company_name input column. A track with a " +
      "placeholder that has no value is skipped and listed, not filled with a guess.",
    "A detected technology does not prove buying intent, spend, licence count or active usage.",
    "A track that did not match means its technology was not observed in retrieved data. This does not " +
      "mean the company does not use it.",
    "Accounts come from the input file you supplied. The REST API has no company search and no reverse " +
      "lookup by technology.",
  ];
  const memo = new Map<string, [Json, Json[]]>();
  const firstRow = new Map<string, string>();

  const one = async (row: Row): Promise<Json> => {
    const [key, identifier, problem] = companyRef(row);
    const base: Json = { row_id: row.row_id, input: row, company_name: value(row.company_name), duplicate_of: null,
      tech_intel: null, suggestions: [], skipped: [], below_threshold: [] };
    if (problem || key === null || identifier === null) return { ...base, status: "invalid_input", status_reason: problem };
    if (firstRow.has(key)) base.duplicate_of = firstRow.get(key);
    else firstRow.set(key, row.row_id);
    const [info, items] = await fetch(ctx, memo, key, identifier, row.row_id, cfg.max_pages);
    base.tech_intel = info;
    const gone = unavailable(info);
    if (gone) return { ...base, status: gone[0], status_reason: gone[1] };
    const suggestions: Json[] = [];
    const skipped: Json[] = [];
    const below: Json[] = [];
    for (const t of cfg.tracks) {
      let used = 0;
      for (const item of items) {
        const basis = matchBasis(item, t.when);
        if (!basis.length) continue;
        if (rank(CONFIDENCE_RANK, item.confidence, 0) < CONFIDENCE_RANK[t.when.min_confidence]) {
          below.push({ track_id: t.id, product: item.product ?? null, confidence: item.confidence ?? null,
            threshold_miss: `confidence ${t_(item.confidence)} is below ${t.when.min_confidence}` });
          continue;
        }
        if (used >= cfg.max_items_per_track) continue;
        used += 1;
        const values: Record<string, string | null> = { company_name: base.company_name, product: value(item.product),
          vendor: value(item.vendor), category: value(item.category), last_observed: value(item.last_observed) };
        const missing = t.placeholders.filter((p: string) => values[p] === null);
        const fact: Json = {};
        for (const k of TECH_KEYS) fact[k] = item[k] ?? null;
        fact.match_basis = basis;
        if (missing.length) {
          skipped.push({ track_id: t.id, label: t.label, product: item.product ?? null, missing_placeholders: missing,
            reason: `No value for: ${missing.join(", ")}.` });
          continue;
        }
        suggestions.push({ track_id: t.id, label: t.label, label_note: SUGGESTED, text: fill(t.template, values), fact });
      }
    }
    Object.assign(base, { suggestions, skipped, below_threshold: below });
    const complete: boolean = info.complete;
    const tail = complete ? "" : " " + incompleteText(info);
    const n = cfg.tracks.length;
    const tracksHit: string[] = [];
    for (const s of suggestions) if (!tracksHit.includes(s.label)) tracksHit.push(s.label);
    if (suggestions.length) {
      return { ...base, status: "tracks_suggested",
        status_reason: `${suggestions.length} suggestion(s) from ${tracksHit.length} of ${n} track(s): ${tracksHit.join(", ")}.${tail}` };
    }
    if (skipped.length) {
      return { ...base, status: "tracks_skipped",
        status_reason: `${skipped.length} matching track(s) were skipped because a placeholder had no value.${tail}` };
    }
    if (complete) {
      return { ...base, status: "no_track_matched",
        status_reason: `None of the ${n} track(s) matched a technology in retrieved data. All technologies were retrieved.` };
    }
    return { ...base, status: "no_track_matched_incomplete",
      status_reason: `None of the ${n} track(s) matched a technology in the pages retrieved.${tail}` };
  };

  const rows = await ctx.runRows(ctx.rows, one);
  const counts: Record<string, number> = {};
  const trackCounts: Record<string, Record<string, number>> = {};
  for (const t of cfg.tracks) trackCounts[t.id] = { suggested: 0, skipped: 0 };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    for (const s of r.suggestions ?? []) trackCounts[s.track_id].suggested += 1;
    for (const s of r.skipped ?? []) trackCounts[s.track_id].skipped += 1;
  }
  const dupes = rows.filter((r) => r.duplicate_of).length;
  if (dupes) {
    coverage.push(`${dupes} row(s) repeat an earlier company identifier; their API responses were reused, ` +
      "not requested again.");
  }
  const skippedTotal = rows.reduce((acc, r) => acc + (r.skipped ?? []).length, 0);
  if (skippedTotal) {
    coverage.push(`${skippedTotal} track(s) were skipped because a placeholder had no value. They are ` +
      "listed per account.");
  }
  const incomplete = rows.filter((r) => r.tech_intel && r.tech_intel.pages_fetched && !r.tech_intel.complete).length;
  if (incomplete) {
    coverage.push(`${incomplete} row(s) have an incomplete technology list (max_pages is ${cfg.max_pages}). ` +
      "Tracks may match technologies on pages that were not retrieved.");
  }
  return { rows, summary: { status_counts: counts, track_counts: trackCounts }, coverage };
}

// ----- outputs -------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id", "company_name", "duplicate_of", "status", "status_reason",
  "firmable_id", "technologies_total", "technologies_retrieved", "list_complete", "tracks_suggested",
  "suggestions", "source_technologies", "skipped_tracks"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const sug: Json[] = r.suggestions ?? [];
    const ti = r.tech_intel ?? {};
    const inp = r.input;
    return {
      row_id: r.row_id, domain: inp.domain ?? null, company_id: inp.company_id ?? null, company_name: inp.company_name ?? null,
      duplicate_of: r.duplicate_of ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || (r.error ?? {}).message || null,
      firmable_id: ti.company_id ?? null, technologies_total: ti.total ?? null,
      technologies_retrieved: ti.retrieved ?? null, list_complete: ti.complete ?? null,
      tracks_suggested: sug.map((s) => s.track_id),
      suggestions: sug.map((s) => `${s.track_id} (${SUGGESTED}): ${s.text}`),
      source_technologies: sug.map((s) => `${s.track_id}:${s_(s.fact.product)}(${s_(s.fact.confidence)},` +
        `${s_(s.fact.recency)},${s_(s.fact.last_observed)})`),
      skipped_tracks: (r.skipped ?? []).map((s: Json) => `${s.track_id}:${s_(s.product)} (${s.reason})`),
    };
  });
}

const title = (r: Json): string => r.input.company_name || r.input.domain || r.input.company_id || r.row_id;

function factLine(f: Json): string {
  return `Technology fact: ${md(t_(f.product))} by ${md(t_(f.vendor))}, category ` +
    `${md(t_(f.category))}. Confidence ${md(t_(f.confidence))}, recency ` +
    `${md(t_(f.recency))}, last observed ${md(t_(f.last_observed))}. Matched by ` +
    `${md(f.match_basis.join("; "))}.`;
}

export function markdown(result: Json): Record<string, string> {
  const lines: string[] = ["# Stack talk tracks", "", MD_INTRO, ""];
  for (const r of result.rows) {
    const reason = r.status_reason || r.reason || r.error?.message || "";
    lines.push(`## ${md(title(r))} (row ${md(r.row_id)})`, "", `Status: ${md(r.status)}. ${md(reason)}`, "");
    for (const s of r.suggestions ?? []) {
      lines.push(`### ${md(s.label)}`, "", `> **${SUGGESTED}**`, ">", `> ${md(s.text)}`, "", factLine(s.fact), "");
    }
    if ((r.skipped ?? []).length) {
      lines.push("Skipped tracks:", "");
      for (const s of r.skipped) lines.push(`- ${md(s.label)} for ${md(t_(s.product))}: ${md(s.reason)}`);
      lines.push("");
    }
  }
  return { "talk-tracks.md": lines.join("\n").replace(/\n+$/, "") + "\n" };
}

export function render(report: Report, result: Json): void {
  const counts: Record<string, number> = result.summary.status_counts ?? {};
  report.add("Result", "Talk track summary",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    note("Every talk track below is a suggestion from a fixed template, not a fact. The technology " +
      "fact it came from is shown beside it. A detected technology does not prove buying intent.", "unknown"));
  const cards: string[] = [];
  for (const r of result.rows) {
    const status: string = r.status;
    const reason = r.status_reason || r.reason || r.error?.message || "";
    let left = `<p>${esc(reason)}</p>`;
    const ti = r.tech_intel;
    if (ti) {
      left += kv([["Firmable ID", ti.company_id], ["Technologies in Firmable", ti.total],
        ["Technologies retrieved", ti.retrieved], ["List complete", ti.complete]]);
    }
    if (r.duplicate_of) left += note(`Same company as row ${esc(r.duplicate_of)}; responses were reused.`, "info");
    for (const s of r.skipped ?? []) left += note(esc(`Skipped ${s.label} for ${t_(s.product)}: ${s.reason}`), "review");
    for (const b of r.below_threshold ?? []) {
      left += note(esc(`${t_(b.product)} matched track ${b.track_id} but was not used: ${b.threshold_miss}.`), "unknown");
    }
    let right = "";
    for (const s of r.suggestions ?? []) {
      const f = s.fact;
      right += `<h3>${esc(s.label)}</h3><div class="template"><p class="eyebrow">${esc(SUGGESTED)}</p>` +
        `<p>${esc(s.text)}</p></div>` +
        kv([["Technology fact", new Raw(`${esc(t_(f.product))} by ${esc(t_(f.vendor))}`)], ["Category", f.category],
          ["Confidence", f.confidence], ["Recency", f.recency], ["Last observed", f.last_observed],
          ["Matched by", f.match_basis.join("; ")]]);
    }
    if ((r.suggestions ?? []).length) right += detailsJson("Suggestions as JSON", r.suggestions);
    cards.push(card(title(r), badge(status.replace(/_/g, " "), STATUS_TONE[status] ?? "neutral"), left,
      right || '<p class="muted">No talk track for this row.</p>', `Row ${r.row_id}`));
  }
  report.add("Accounts", "Each account with its suggested talk tracks", cards.join(""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render, markdown,
};
