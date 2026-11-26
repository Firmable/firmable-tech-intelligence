/**
 * Tech fit tiers: assigns each account a sales tier from fixed rules over its observed technologies.
 * Mirrors recipes/tech-fit-tiers/python/src/tech_fit_tiers/recipe.py; see that file and the recipe
 * README for the signal results and the tier rules.
 */
import {
  ConfigError, FATAL_KINDS, Json, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, card, detailsJson, esc, kv, normaliseDomain, note, pricing, pyRepr, readRows, table,
} from "firmable-api-client";

export const NAME = "tech-fit-tiers";
export const TITLE = "Tech fit tiers";
export const DESCRIPTION = "Assigns each account a sales tier from fixed rules over the technologies observed in its Firmable " +
  "Tech Intel, and shows the signals and technology facts behind each tier.";

export const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
const STATUS_TONE: Record<string, string> = {
  tier_assigned: "good", no_tier: "neutral", needs_review: "review", no_data: "unknown", invalid_input: "error",
  access_denied: "error", error: "error", not_processed: "unknown",
};
const SIGNAL_TONE: Record<string, string> = { observed: "good", not_observed: "neutral", not_observed_in_pages_retrieved: "review" };
const TIER_TONE: Record<string, string> = { met: "good", not_met: "neutral", undetermined: "review" };
const RESULT_TEXT: Record<string, string> = {
  observed: "Observed in retrieved data.",
  not_observed: "Not observed in retrieved data.",
  not_observed_in_pages_retrieved: "Not observed in the pages retrieved. The technology list is incomplete.",
};
const STOP_TEXT: Record<string, string> = {
  page_limit: "the page limit was reached",
  error: "a later page failed",
  budget: "the credit limit was reached",
  repeated_cursor: "the API returned a cursor it had already returned",
};
const TECH_KEYS = ["product", "product_slug", "vendor", "vendor_slug", "filter", "filter_slug", "category",
  "category_slug", "pillar_slug", "confidence", "recency", "last_observed", "nature"];
const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOP_KEYS = new Set(["signals", "tiers", "max_pages", "with_evidence"]);
const SIGNAL_KEYS = new Set(["id", "label", "product_slugs", "vendor_slugs", "category_slugs", "aliases", "min_confidence"]);
const TIER_KEYS = new Set(["id", "label", "when"]);
const WHEN_KEYS = ["all", "any", "none"];
const MAX_SIGNALS = 30;
const MAX_TIERS = 10;
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

function idLabel(item: Json, where: string, seen: Set<string>): [string, string] {
  const iid = item.id;
  if (typeof iid !== "string" || !ID.test(iid)) throw new ConfigError(`${where}.id must be 1 to 40 lower-case letters, digits or underscores.`);
  if (seen.has(iid)) throw new ConfigError(`${where}.id ${pyRepr(iid)} is used twice.`);
  seen.add(iid);
  const label = item.label ?? iid;
  if (typeof label !== "string" || !label.trim()) throw new ConfigError(`${where}.label must be text.`);
  return [iid, label.trim()];
}

export function loadSignal(s: Json, where: string, seen: Set<string>): Json {
  if (!isObj(s)) throw new ConfigError(`${where} must be an object.`);
  const extra = Object.keys(s).filter((k) => !SIGNAL_KEYS.has(k)).sort();
  if (extra.length) throw new ConfigError(`${where} has unknown key(s): ${extra.join(", ")}`);
  const [sid, label] = idLabel(s, where, seen);
  const m: Record<string, string[]> = {};
  for (const k of ["product_slugs", "vendor_slugs", "category_slugs", "aliases"]) m[k] = textList(s[k], `${where}.${k}`);
  if (!Object.values(m).some((v) => v.length)) {
    throw new ConfigError(`${where} needs at least one product slug, vendor slug, category slug or alias.`);
  }
  const mc = s.min_confidence ?? "low";
  if (rank(CONFIDENCE_RANK, mc, 0) === 0) throw new ConfigError(`${where}.min_confidence must be one of: low, medium, high.`);
  return { id: sid, label, ...m, min_confidence: mc };
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const signalsRaw = raw.signals;
  if (!Array.isArray(signalsRaw) || !signalsRaw.length) throw new ConfigError("signals must be a non-empty list.");
  if (signalsRaw.length > MAX_SIGNALS) throw new ConfigError(`signals can hold at most ${MAX_SIGNALS} items.`);
  const seen = new Set<string>();
  const signals = signalsRaw.map((s: Json, i: number) => loadSignal(s, `signals[${i + 1}]`, seen));
  const tiersRaw = raw.tiers;
  if (!Array.isArray(tiersRaw) || !tiersRaw.length) throw new ConfigError("tiers must be a non-empty list.");
  if (tiersRaw.length > MAX_TIERS) throw new ConfigError(`tiers can hold at most ${MAX_TIERS} items.`);
  const tierSeen = new Set<string>();
  const tiers: Json[] = [];
  tiersRaw.forEach((t: Json, idx: number) => {
    const where = `tiers[${idx + 1}]`;
    if (!isObj(t)) throw new ConfigError(`${where} must be an object.`);
    let extra = Object.keys(t).filter((k) => !TIER_KEYS.has(k)).sort();
    if (extra.length) throw new ConfigError(`${where} has unknown key(s): ${extra.join(", ")}`);
    const [tid, label] = idLabel(t, where, tierSeen);
    const when = t.when;
    if (!isObj(when)) throw new ConfigError(`${where}.when must be an object.`);
    extra = Object.keys(when).filter((k) => !WHEN_KEYS.includes(k)).sort();
    if (extra.length) throw new ConfigError(`${where}.when has unknown key(s): ${extra.join(", ")}`);
    const w: Record<string, string[]> = {};
    for (const k of WHEN_KEYS) w[k] = textList(when[k], `${where}.when.${k}`);
    if (!Object.values(w).some((v) => v.length)) throw new ConfigError(`${where}.when needs at least one signal in all, any or none.`);
    for (const k of WHEN_KEYS) {
      const missing = w[k].filter((x) => !seen.has(x));
      if (missing.length) throw new ConfigError(`${where}.when.${k} names unknown signal(s): ${missing.join(", ")}`);
    }
    const both = w.none.filter((x) => w.all.includes(x) || w.any.includes(x));
    if (both.length) throw new ConfigError(`${where}.when uses signal(s) in none and in all or any: ${both.join(", ")}`);
    tiers.push({ id: tid, label, when: w });
  });
  if (typeof (raw.with_evidence ?? false) !== "boolean") throw new ConfigError("with_evidence must be true or false.");
  const maxPages = raw.max_pages ?? 5;
  if (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new ConfigError(`max_pages must be a whole number from 1 to ${MAX_PAGES_LIMIT}.`);
  }
  return { signals, tiers, max_pages: maxPages, with_evidence: raw.with_evidence ?? false };
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
  const parts: [string, number][] = [["tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n)]];
  if (config.with_evidence) parts.push(["tech_intel_evidence", pricing.round4(pricing.TECH_INTEL_EVIDENCE_REQUEST * n * pages)]);
  return [new PlannedCall("GET /tech-intel", `Up to ${pages} page(s) of Tech Intel for each unique valid company`, n * pages, parts)];
}

// ----- matching ------------------------------------------------------------------------------

export function matchBasis(item: Json, sig: Json): string[] {
  const basis: string[] = [];
  for (const [field, key] of [["product_slug", "product_slugs"], ["vendor_slug", "vendor_slugs"], ["category_slug", "category_slugs"]]) {
    if (typeof item[field] === "string" && sig[key].includes(item[field])) basis.push(`${field} ${item[field]}`);
  }
  const aliases = sig.aliases.map((a: string) => a.toLowerCase());
  for (const field of ["product", "vendor"]) {
    const value = item[field];
    if (typeof value === "string" && aliases.includes(value.trim().toLowerCase())) basis.push(`alias of ${field} name ${value}`);
  }
  return basis;
}

function technology(item: Json): Json {
  const out: Json = {};
  for (const k of TECH_KEYS) out[k] = item[k] ?? null;
  return out;
}

/** The evidence fields as returned, with counts of records that have no source location. */
function evidence(item: Json, withEvidence: boolean): Json {
  if (!withEvidence) return { status: "not_requested" };
  const ev = item.evidence_detail;
  if (!isObj(ev)) return { status: "none_returned", notes: ["No evidence was returned for this technology."] };
  const records: Json[] = (ev.records ?? []).filter((r: unknown) => isObj(r));
  const noLocation = records.filter((r) => typeof r.location !== "string" || !r.location.trim()).length;
  const byType: Json[] = (ev.evidence_by_type ?? []).filter((t: unknown) => isObj(t));
  const capped: string[] = byType.filter((t) => t.capped === true && typeof t.type === "string").map((t) => t.type);
  const count = ev.evidence_count ?? null;
  const notes: string[] = [];
  if (noLocation) notes.push(`${noLocation} evidence record(s) have no source location.`);
  if (Number.isInteger(count) && records.length < count) notes.push(`${records.length} of ${count} evidence record(s) are listed.`);
  if (capped.length) {
    notes.push(`The source reported more evidence than it sent for: ${capped.join(", ")}. Those counts are ` +
      "minimums.");
  }
  return { status: "returned", confidence: ev.confidence ?? null, first_seen: ev.first_seen ?? null,
    last_seen: ev.last_seen ?? null, evidence_count: count, evidence_by_type: byType, records_listed: records.length,
    records_without_location: noLocation, capped_types: capped, records, notes };
}

export function checkSignal(sig: Json, items: Json[], complete: boolean, withEvidence: boolean): Json {
  const matches: Json[] = [];
  const below: Json[] = [];
  for (const item of items) {
    const basis = matchBasis(item, sig);
    if (!basis.length) continue;
    const entry = { match_basis: basis, technology: technology(item) };
    if (rank(CONFIDENCE_RANK, item.confidence, 0) < CONFIDENCE_RANK[sig.min_confidence]) {
      below.push({ ...entry, threshold_miss: `confidence ${t_(item.confidence)} is below ${sig.min_confidence}` });
    } else {
      matches.push({ ...entry, evidence: evidence(item, withEvidence) });
    }
  }
  const result = matches.length ? "observed" : (complete ? "not_observed" : "not_observed_in_pages_retrieved");
  return { signal_id: sig.id, label: sig.label, result, result_text: RESULT_TEXT[result], matches, below_threshold: below };
}

// ----- tiers ---------------------------------------------------------------------------------

/** yes, no or unknown for one condition list. An empty list is met. */
export function condition(kind: string, ids: string[], results: Record<string, string>): string {
  if (!ids.length) return "yes";
  const vals = ids.map((i) => results[i]);
  if (kind === "all") {
    if (vals.includes("not_observed")) return "no";
    return vals.every((v) => v === "observed") ? "yes" : "unknown";
  }
  if (kind === "any") {
    if (vals.includes("observed")) return "yes";
    return vals.every((v) => v === "not_observed") ? "no" : "unknown";
  }
  if (vals.includes("observed")) return "no";
  return vals.every((v) => v === "not_observed") ? "yes" : "unknown";
}

function checkTier(tier: Json, results: Record<string, string>): Json {
  const conds: Record<string, string> = {};
  for (const k of WHEN_KEYS) if (tier.when[k].length) conds[k] = condition(k, tier.when[k], results);
  const vals = Object.values(conds);
  const outcome = vals.includes("no") ? "not_met" : (vals.every((v) => v === "yes") ? "met" : "undetermined");
  return { tier_id: tier.id, label: tier.label, result: outcome, conditions: conds };
}

function assign(tiers: Json[], results: Record<string, string>): [string, string, Json | null, string[], Json[]] {
  const checks = tiers.map((t) => checkTier(t, results));
  const open: Json[] = [];
  for (const c of checks) {
    if (c.result === "met") {
      if (open.length) {
        const names = open.map((t) => t.label).join(", ");
        return ["needs_review", `${c.label} applies in retrieved data, but ${names} ranks higher and could not be ruled ` +
          "out because the technology list is incomplete.", c, open.map((t) => t.tier_id), checks];
      }
      return ["tier_assigned", `${c.label} is the first tier whose conditions are met.`, c, [], checks];
    }
    if (c.result === "undetermined") open.push(c);
  }
  if (open.length) {
    const names = open.map((t) => t.label).join(", ");
    return ["needs_review", `No tier is met in retrieved data. ${names} could apply, because the technology ` +
      "list is incomplete.", null, open.map((t) => t.tier_id), checks];
  }
  return ["no_tier", "No tier's conditions are met in a complete technology list.", null, [], checks];
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
  rowId: string, maxPages: number, withEvidence: boolean): Promise<[Json, Json[]]> {
  const hit = memo.get(key);
  if (hit) return hit;
  const ti = await ctx.client.getTechIntel(identifier, { withEvidence, maxPages });
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

/** Inconsistencies in the returned data. They are reported, not corrected. */
function dataNotes(info: Json, items: Json[]): string[] {
  const notes: string[] = [];
  if (info.complete && Number.isInteger(info.total) && info.total !== items.length) {
    notes.push(`The API reported a total of ${info.total} technologies but returned ${items.length} across all pages.`);
  }
  const firstConf = new Map<string, unknown>();
  const conflicting: string[] = [];
  for (const it of items) {
    const slug = it.product_slug;
    if (typeof slug !== "string") continue;
    if (firstConf.has(slug) && firstConf.get(slug) !== (it.confidence ?? null) && !conflicting.includes(slug)) conflicting.push(slug);
    if (!firstConf.has(slug)) firstConf.set(slug, it.confidence ?? null);
  }
  for (const slug of conflicting) {
    notes.push(`Product ${slug} appears more than once with different confidence values. Each entry is ` +
      "shown as returned.");
  }
  return notes;
}

// ----- run -----------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const coverage: string[] = [
    "Tiers come from the fixed rules in the configuration. They are not a score, a forecast or a model " +
      "output.",
    "A detected technology does not prove buying intent, spend, licence count or active usage.",
    "A signal that was not matched is not observed in retrieved data. This does not mean the company does " +
      "not use it.",
    "An unknown signal never satisfies a condition. A none condition is met only when the whole technology " +
      "list was retrieved.",
    "Matching uses only the product, vendor and category slugs and exact aliases in the configuration. There " +
      "is no fuzzy matching.",
    "Accounts come from the input file you supplied. The REST API has no company search and no reverse " +
      "lookup by technology.",
  ];
  if (!cfg.with_evidence) coverage.push("Evidence was not requested (with_evidence is false), so no evidence records are shown.");
  const memo = new Map<string, [Json, Json[]]>();
  const firstRow = new Map<string, string>();

  const one = async (row: Row): Promise<Json> => {
    const [key, identifier, problem] = companyRef(row);
    const base: Json = { row_id: row.row_id, input: row, duplicate_of: null, tech_intel: null, tier_id: null,
      tier_label: null, review_tiers: [], tier_checks: [], signals: [], data_notes: [] };
    if (problem || key === null || identifier === null) return { ...base, status: "invalid_input", status_reason: problem };
    if (firstRow.has(key)) base.duplicate_of = firstRow.get(key);
    else firstRow.set(key, row.row_id);
    const [info, items] = await fetch(ctx, memo, key, identifier, row.row_id, cfg.max_pages, cfg.with_evidence);
    base.tech_intel = info;
    const gone = unavailable(info);
    if (gone) return { ...base, status: gone[0], status_reason: gone[1] };
    const complete: boolean = info.complete;
    base.data_notes = dataNotes(info, items);
    const signals = cfg.signals.map((s: Json) => checkSignal(s, items, complete, cfg.with_evidence));
    base.signals = signals;
    const results: Record<string, string> = Object.fromEntries(signals.map((s: Json) => [s.signal_id, s.result]));
    const [status, reasonText, tier, review, checks] = assign(cfg.tiers, results);
    base.tier_checks = checks;
    base.review_tiers = review;
    if (tier !== null) {
      base.tier_id = tier.tier_id;
      base.tier_label = tier.label;
    }
    const observed = signals.filter((s: Json) => s.result === "observed").map((s: Json) => s.label);
    let reason = reasonText + (observed.length ? ` Signals observed: ${observed.join(", ")}.` : " No signal was observed.");
    if (!complete) reason += " " + incompleteText(info);
    return { ...base, status, status_reason: reason };
  };

  const rows = await ctx.runRows(ctx.rows, one);
  const counts: Record<string, number> = {};
  const tierCounts: Record<string, number> = {};
  const reviewCounts: Record<string, number> = {};
  for (const t of cfg.tiers) { tierCounts[t.id] = 0; reviewCounts[t.id] = 0; }
  const signalCounts: Record<string, Record<string, number>> = {};
  for (const s of cfg.signals) {
    signalCounts[s.id] = {};
    for (const k of Object.keys(RESULT_TEXT)) signalCounts[s.id][k] = 0;
  }
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "tier_assigned") tierCounts[r.tier_id] += 1;
    if (r.status === "needs_review" && r.tier_id) reviewCounts[r.tier_id] += 1;
    for (const s of r.signals ?? []) signalCounts[s.signal_id][s.result] += 1;
  }
  const dupes = rows.filter((r) => r.duplicate_of).length;
  if (dupes) {
    coverage.push(`${dupes} row(s) repeat an earlier company identifier; their API responses were reused, ` +
      "not requested again.");
  }
  const review = counts.needs_review ?? 0;
  if (review) {
    coverage.push(`${review} row(s) need review because an incomplete technology list left one or more ` +
      `tiers undetermined (max_pages is ${cfg.max_pages}).`);
  }
  let noLoc = 0;
  for (const r of rows) for (const s of r.signals ?? []) for (const m of s.matches) noLoc += m.evidence.records_without_location ?? 0;
  if (noLoc) coverage.push(`${noLoc} evidence record(s) have no source location. They are shown as returned.`);
  const noted = rows.filter((r) => (r.data_notes ?? []).length).length;
  if (noted) {
    coverage.push(`${noted} row(s) have inconsistencies in the returned Tech Intel data. They are shown as ` +
      "returned and not corrected.");
  }
  return { rows, summary: { status_counts: counts, tier_counts: tierCounts, needs_review_candidate_counts: reviewCounts,
    signal_counts: signalCounts }, coverage };
}

// ----- outputs -------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id", "company_name", "duplicate_of", "status", "status_reason",
  "tier_id", "tier_label", "review_tiers", "firmable_id", "technologies_total",
  "technologies_retrieved", "list_complete", "signals_observed", "signal_results",
  "matched_technologies", "data_notes"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const signals: Json[] = r.signals ?? [];
    const ti = r.tech_intel ?? {};
    const inp = r.input;
    const matched: string[] = [];
    for (const s of signals) {
      for (const m of s.matches) {
        const tech = m.technology;
        matched.push(`${s.signal_id}:${s_(tech.product)}(${s_(tech.confidence)},${s_(tech.recency)},${s_(tech.last_observed)})`);
      }
    }
    return {
      row_id: r.row_id, domain: inp.domain ?? null, company_id: inp.company_id ?? null, company_name: inp.company_name ?? null,
      duplicate_of: r.duplicate_of ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || (r.error ?? {}).message || null,
      tier_id: r.tier_id ?? null, tier_label: r.tier_label ?? null, review_tiers: r.review_tiers ?? [],
      firmable_id: ti.company_id ?? null, technologies_total: ti.total ?? null,
      technologies_retrieved: ti.retrieved ?? null, list_complete: ti.complete ?? null,
      signals_observed: signals.filter((s) => s.result === "observed").map((s) => s.signal_id),
      signal_results: signals.map((s) => `${s.signal_id}=${s.result}`),
      matched_technologies: matched, data_notes: r.data_notes ?? [],
    };
  });
}

function evidenceHtml(ev: Json): string {
  if (ev.status === "not_requested") return "";
  if (ev.status === "none_returned") return note("No evidence was returned for this technology.", "unknown");
  let html = kv([["Evidence confidence", ev.confidence], ["First seen", ev.first_seen], ["Last seen", ev.last_seen],
    ["Evidence count", ev.evidence_count], ["Records listed", ev.records_listed]]);
  for (const n of ev.notes ?? []) html += note(esc(n), "unknown");
  const recs: Json[] = ev.records ?? [];
  if (recs.length) {
    html += table(["Type", "Found", "Location", "Seen", "Confidence"], recs.map((rec) => [rec.type, rec.found,
      typeof rec.location === "string" && rec.location.trim() ? rec.location : new Raw(badge("no source location", "review")),
      `${rec.first_seen || "?"} to ${rec.last_seen || "?"}`, rec.confidence]));
  }
  return html;
}

export function render(report: Report, result: Json): void {
  const summary = result.summary;
  const cfg = result.input.config;
  const counts: Record<string, number> = summary.status_counts ?? {};
  const tierRows = cfg.tiers.map((t: Json) => [t.label, (summary.tier_counts ?? {})[t.id] ?? 0,
    (summary.needs_review_candidate_counts ?? {})[t.id] ?? 0,
    Object.entries(t.when).filter(([, v]) => (v as string[]).length).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join(", ")]);
  report.add("Result", "Tier summary",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    table(["Tier", "Accounts assigned", "Needs review with this candidate", "Rule"], tierRows) +
    note("Tiers follow the fixed rules in the configuration. A detected technology does not prove " +
      "buying intent. Not observed means not observed in retrieved data.", "unknown"));
  const cards: string[] = [];
  for (const r of result.rows) {
    const status: string = r.status;
    const inp = r.input;
    const title = inp.company_name || inp.domain || inp.company_id || r.row_id;
    const reason = r.status_reason || r.reason || r.error?.message || "";
    let left = `<p>${esc(reason)}</p>`;
    if (r.tier_label) left += kv([["Tier", r.tier_label]]);
    if ((r.tier_checks ?? []).length) {
      left += table(["Tier", "Result", "Conditions"], r.tier_checks.map((c: Json) => [c.label,
        new Raw(badge(c.result.replace(/_/g, " "), TIER_TONE[c.result] ?? "neutral")),
        Object.entries(c.conditions).map(([k, v]) => `${k}: ${v}`).join(", ")]));
    }
    const ti = r.tech_intel;
    if (ti) {
      left += kv([["Firmable ID", ti.company_id], ["Technologies in Firmable", ti.total],
        ["Technologies retrieved", ti.retrieved], ["List complete", ti.complete]]);
    }
    for (const n of r.data_notes ?? []) left += note(esc(n), "unknown");
    if (r.duplicate_of) left += note(`Same company as row ${esc(r.duplicate_of)}; responses were reused.`, "info");
    let right = "";
    const signals: Json[] = r.signals ?? [];
    if (signals.length) {
      right += table(["Signal", "Result"], signals.map((s) => [s.label,
        new Raw(badge(s.result.replace(/_/g, " "), SIGNAL_TONE[s.result] ?? "neutral"))]));
      for (const s of signals) {
        for (const m of s.matches) {
          const tech = m.technology;
          right += `<h3>${esc(s.label)}: ${esc(tech.product)}</h3>` +
            kv([["Vendor", tech.vendor], ["Category", tech.category], ["Confidence", tech.confidence],
              ["Recency", tech.recency], ["Last observed", tech.last_observed], ["Nature", tech.nature],
              ["Matched by", m.match_basis.join("; ")]]) +
            evidenceHtml(m.evidence);
        }
        for (const m of s.below_threshold) {
          right += note(esc(`${s.label}: ${t_(m.technology.product)} was matched but not counted: ${m.threshold_miss}.`), "unknown");
        }
      }
      right += detailsJson("Signals as JSON", signals);
    }
    cards.push(card(title, badge(status.replace(/_/g, " "), STATUS_TONE[status] ?? "neutral"), left,
      right || '<p class="muted">No Tech Intel was retrieved for this row.</p>', `Row ${r.row_id}`));
  }
  report.add("Accounts", "Each account with its tier and signals", cards.join(""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
