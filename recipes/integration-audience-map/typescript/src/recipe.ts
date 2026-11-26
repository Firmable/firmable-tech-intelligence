/**
 * Integration audience map: which companies in your list show the technologies you integrate with.
 * Mirrors recipes/integration-audience-map/python/src/integration_audience_map/recipe.py; see that
 * file and the recipe README for the matching rules, target results and measures.
 */
import {
  ConfigError, FATAL_KINDS, Json, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, detailsJson, esc, kv, normaliseDomain, note, pricing, pyRepr, readRows, table,
} from "firmable-api-client";

export const NAME = "integration-audience-map";
export const TITLE = "Integration audience map";
export const DESCRIPTION = "Shows which companies in the list you supply have the technologies you integrate with in their " +
  "Firmable Tech Intel, with confidence, recency and last observed date, and counts each target " +
  "across the list with its denominator.";

export const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
export const RECENCY_RANK: Record<string, number> = { "30d": 1, "90d": 2, older: 3 };
const STATUS_TONE: Record<string, string> = {
  matched: "good", not_observed: "neutral", not_observed_incomplete: "review", no_data: "unknown",
  invalid_input: "error", access_denied: "error", error: "error", not_processed: "unknown",
};
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
const OUTCOMES = ["observed", "not_observed", "not_observed_in_pages_retrieved", "no_data", "error", "not_processed"];
const FRAMING = "This is audience research within the list you supplied. An observed technology is not proof of demand " +
  "for an integration, of compatibility with your product, or of buying intent.";
const NO_SEGMENT = "(no segment)";

const ID = /^[a-z0-9_]{1,40}$/;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOP_KEYS = new Set(["targets", "match", "min_confidence", "max_recency", "max_pages", "min_answered"]);
const TARGET_KEYS = new Set(["id", "label", "product_slugs", "vendor_slugs", "aliases"]);
const MAX_TARGETS = 50;
const MAX_PAGES_LIMIT = 25;

const rank = (m: Record<string, number>, v: unknown, def: number): number =>
  (typeof v === "string" && Object.prototype.hasOwnProperty.call(m, v) ? m[v] : def);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const t_ = (v: unknown): string => (v === null || v === undefined ? "not returned" : String(v));

// ----- configuration and input ---------------------------------------------------------------

function textList(value: unknown, where: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) {
    throw new ConfigError(`${where} must be a list of non-empty text values.`);
  }
  return value.map((v: string) => v.trim());
}

function whole(raw: Json, key: string, def: number, low: number, high: number | null): number {
  const v = raw[key] ?? def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < low || (high !== null && v > high)) {
    const span = high !== null ? `from ${low} to ${high}` : `of ${low} or more`;
    throw new ConfigError(`${key} must be a whole number ${span}.`);
  }
  return v;
}

function choice(raw: Json, key: string, def: string, allowed: string[]): string {
  const v = raw[key] ?? def;
  if (typeof v !== "string" || !allowed.includes(v)) throw new ConfigError(`${key} must be one of: ${allowed.join(", ")}.`);
  return v;
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const targetsRaw = raw.targets;
  if (!Array.isArray(targetsRaw) || !targetsRaw.length) throw new ConfigError("targets must be a non-empty list.");
  if (targetsRaw.length > MAX_TARGETS) throw new ConfigError(`targets can hold at most ${MAX_TARGETS} items.`);
  const targets: Json[] = [];
  const seen = new Set<string>();
  targetsRaw.forEach((t: Json, idx: number) => {
    const i = idx + 1;
    if (!isObj(t)) throw new ConfigError(`targets[${i}] must be an object.`);
    const extra = Object.keys(t).filter((k) => !TARGET_KEYS.has(k)).sort();
    if (extra.length) throw new ConfigError(`targets[${i}] has unknown key(s): ${extra.join(", ")}`);
    const tid = t.id;
    if (typeof tid !== "string" || !ID.test(tid)) throw new ConfigError(`targets[${i}].id must be 1 to 40 lower-case letters, digits or underscores.`);
    if (seen.has(tid)) throw new ConfigError(`targets[${i}].id ${pyRepr(tid)} is used twice.`);
    seen.add(tid);
    const label = t.label ?? tid;
    if (typeof label !== "string" || !label.trim()) throw new ConfigError(`targets[${i}].label must be text.`);
    const m: Record<string, string[]> = {};
    for (const k of ["product_slugs", "vendor_slugs", "aliases"]) m[k] = textList(t[k], `targets[${i}].${k}`);
    if (!(m.product_slugs.length || m.vendor_slugs.length || m.aliases.length)) {
      throw new ConfigError(`targets[${i}] needs at least one product slug, vendor slug or alias.`);
    }
    targets.push({ id: tid, label: label.trim(), ...m });
  });
  return {
    targets,
    match: choice(raw, "match", "any", ["any", "all"]),
    min_confidence: choice(raw, "min_confidence", "low", ["low", "medium", "high"]),
    max_recency: choice(raw, "max_recency", "older", ["older", "90d", "30d"]),
    max_pages: whole(raw, "max_pages", 5, 1, MAX_PAGES_LIMIT),
    min_answered: whole(raw, "min_answered", 5, 1, null),
  };
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

function uniqueKeys(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const key = companyRef(r)[0];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueKeys(rows).length;
  const pages: number = config.max_pages;
  return [new PlannedCall("GET /tech-intel", `Up to ${pages} page(s) of Tech Intel for each unique valid company`,
    n * pages, [["tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n)]])];
}

// ----- matching ------------------------------------------------------------------------------

export function matchBasis(item: Json, target: Json): string[] {
  const basis: string[] = [];
  if (typeof item.product_slug === "string" && target.product_slugs.includes(item.product_slug)) basis.push(`product_slug ${item.product_slug}`);
  if (typeof item.vendor_slug === "string" && target.vendor_slugs.includes(item.vendor_slug)) basis.push(`vendor_slug ${item.vendor_slug}`);
  const aliases = target.aliases.map((a: string) => a.toLowerCase());
  for (const field of ["product", "vendor"]) {
    const value = item[field];
    if (typeof value === "string" && aliases.includes(value.trim().toLowerCase())) basis.push(`alias of ${field} name ${value}`);
  }
  return basis;
}

/** Reasons an item fails the thresholds. A value the docs do not define fails any threshold above the lowest. */
export function thresholdMisses(item: Json, minConfidence: string, maxRecency: string): string[] {
  const misses: string[] = [];
  if (minConfidence !== "low" && rank(CONFIDENCE_RANK, item.confidence, 0) < CONFIDENCE_RANK[minConfidence]) {
    misses.push(`confidence ${t_(item.confidence)} is below ${minConfidence}`);
  }
  if (maxRecency !== "older" && rank(RECENCY_RANK, item.recency, 99) > RECENCY_RANK[maxRecency]) {
    misses.push(`recency ${t_(item.recency)} is older than ${maxRecency}`);
  }
  return misses;
}

function technology(item: Json): Json {
  const out: Json = {};
  for (const k of TECH_KEYS) out[k] = item[k] ?? null;
  return out;
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
  const total = info.total;
  const totalText = Number.isInteger(total) ? String(total) : "an unknown number of";
  const why = STOP_TEXT[info.stop_reason] ?? info.stop_reason;
  return `The technology list is incomplete because ${why}: ${info.retrieved} of ${totalText} ` +
    `technologies were retrieved in ${info.pages_fetched} page(s).`;
}

/** Inconsistencies in the returned data. They are reported, not corrected. */
function dataNotes(info: Json, items: Json[]): string[] {
  const notes: string[] = [];
  const total = info.total;
  if (info.complete && Number.isInteger(total) && total !== items.length) {
    notes.push(`The API reported a total of ${total} technologies but returned ${items.length} across all pages.`);
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
  const unnamed = items.filter((it) => !it.product && !it.product_slug).length;
  if (unnamed) {
    notes.push(`${unnamed} technology item(s) have no product name or product slug, so they cannot match ` +
      "a target.");
  }
  return notes;
}

// ----- measures ------------------------------------------------------------------------------

/** n over d as a percentage rounded half up to one decimal, identical in Python and TypeScript. */
export function pct(n: number, d: number): number {
  return Math.floor((n * 1000) / d + 0.5) / 10;
}

export function measure(outcomes: string[], minAnswered: number): Json {
  const counts: Record<string, number> = {};
  for (const k of OUTCOMES) counts[k] = 0;
  let below = 0;
  for (const o of outcomes) {
    const [name, flag] = o.split("+");
    counts[name] += 1;
    if (flag === "below") below += 1;
  }
  const answered = counts.observed + counts.not_observed;
  const withData = answered + counts.not_observed_in_pages_retrieved;
  const observedShare = answered ? { numerator: counts.observed, denominator: answered, percent: pct(counts.observed, answered) } : null;
  const unknownShare = withData ? { numerator: counts.not_observed_in_pages_retrieved, denominator: withData,
    percent: pct(counts.not_observed_in_pages_retrieved, withData) } : null;
  const enough = answered >= minAnswered;
  let text: string;
  if (!enough) text = `Too few answers to compare: ${answered} answered, ${minAnswered} needed.`;
  else text = `Observed at ${counts.observed} of ${answered} answered companies in this cohort (${observedShare!.percent.toFixed(1)}%).`;
  if (unknownShare && unknownShare.numerator) {
    text += ` ${unknownShare.numerator} of ${withData} companies with data had an incomplete list ` +
      `(${unknownShare.percent.toFixed(1)}%) and are not counted as answered.`;
  }
  return { companies_in_cohort: outcomes.length, companies_asked: outcomes.length - counts.not_processed,
    ...counts, observed_below_threshold: below, answered, observed_share: observedShare, unknown_share: unknownShare,
    enough_answers: enough, text };
}

function targetOutcome(row: Json, tid: string): string {
  if (row.status === "access_denied") return "error";
  if (["no_data", "error", "not_processed"].includes(row.status)) return row.status;
  const t = row.targets.find((x: Json) => x.target_id === tid);
  return t.result + (t.below_threshold.length ? "+below" : "");
}

function audienceOutcome(row: Json): string {
  if (row.status === "access_denied") return "error";
  if (["no_data", "error", "not_processed"].includes(row.status)) return row.status;
  return ({ matched: "observed", not_observed: "not_observed", not_observed_incomplete: "not_observed_in_pages_retrieved" } as Record<string, string>)[row.status];
}

function measures(rows: Json[], cfg: Json): Json {
  const byTarget: Json = {};
  for (const t of cfg.targets) byTarget[t.id] = measure(rows.map((r) => targetOutcome(r, t.id)), cfg.min_answered);
  return { audience: measure(rows.map(audienceOutcome), cfg.min_answered), by_target: byTarget };
}

// ----- run -----------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const coverage: string[] = [
    "The cohort is the input file you supplied. The REST API has no company search and no reverse lookup " +
      "by technology, so this recipe cannot find companies outside your list.",
    FRAMING,
    "A target that was not matched is not observed in retrieved data. This does not mean the company " +
      "does not use it.",
    "Matching uses only the product slugs, vendor slugs and exact aliases in the configuration. There is " +
      "no fuzzy matching.",
    "Each measure counts unique companies, not input rows. A share is observed over answered companies " +
      "(observed plus not observed in a complete list); incomplete lists, no data and errors are counted " +
      "beside it, not in it.",
  ];
  if (cfg.min_confidence !== "low" || cfg.max_recency !== "older") {
    coverage.push(`Only technologies with confidence ${cfg.min_confidence} or higher and recency ` +
      `${cfg.max_recency} or newer count as observed. Matches below these thresholds are listed separately.`);
  }
  const memo = new Map<string, [Json, Json[]]>();
  const firstRow = new Map<string, string>();
  const firstCompany = new Map<string, string>();
  const hasSegment = ctx.rows.some((r) => "segment" in r);

  const one = async (row: Row): Promise<Json> => {
    const [key, identifier, problem] = companyRef(row);
    const base: Json = { row_id: row.row_id, input: row, company_key: key,
      segment: hasSegment ? (row.segment || NO_SEGMENT) : null, duplicate_of: null, same_company_as: null,
      tech_intel: null, targets: [], data_notes: [] };
    if (problem || key === null || identifier === null) return { ...base, status: "invalid_input", status_reason: problem };
    if (firstRow.has(key)) base.duplicate_of = firstRow.get(key);
    else firstRow.set(key, row.row_id);
    const [info, items] = await fetch(ctx, memo, key, identifier, row.row_id, cfg.max_pages);
    base.tech_intel = info;
    const fid = info.company_id;
    if (typeof fid === "string" && fid && base.duplicate_of === null) {
      if (firstCompany.has(fid)) base.same_company_as = firstCompany.get(fid);
      else firstCompany.set(fid, row.row_id);
    }
    const gone = unavailable(info);
    if (gone) return { ...base, status: gone[0], status_reason: gone[1] };

    const complete: boolean = info.complete;
    base.data_notes = dataNotes(info, items);
    const targetsOut: Json[] = [];
    for (const t of cfg.targets) {
      const matches: Json[] = [];
      const below: Json[] = [];
      for (const item of items) {
        const basis = matchBasis(item, t);
        if (!basis.length) continue;
        const misses = thresholdMisses(item, cfg.min_confidence, cfg.max_recency);
        const entry = { match_basis: basis, technology: technology(item) };
        if (misses.length) below.push({ ...entry, threshold_misses: misses });
        else matches.push(entry);
      }
      const result = matches.length ? "observed" : (complete ? "not_observed" : "not_observed_in_pages_retrieved");
      targetsOut.push({ target_id: t.id, label: t.label, result, result_text: RESULT_TEXT[result], matches, below_threshold: below });
    }
    base.targets = targetsOut;

    const observed = targetsOut.filter((t) => t.result === "observed");
    const n = targetsOut.length;
    const met = cfg.match === "all" ? observed.length === n : observed.length > 0;
    const tail = complete ? "" : " " + incompleteText(info);
    const labels = observed.map((t) => t.label).join(", ");
    const seenText = `${observed.length} of ${n} target(s) observed in retrieved data` + (observed.length ? `: ${labels}.` : ".");
    const rule = cfg.match === "all" ? "all targets" : "at least one target";
    if (met) return { ...base, status: "matched", status_reason: `${seenText} The match rule needs ${rule}.${tail}` };
    if (complete) {
      return { ...base, status: "not_observed", status_reason: `${seenText} The match rule needs ${rule}. All technologies were retrieved.` };
    }
    return { ...base, status: "not_observed_incomplete", status_reason: `${seenText} The match rule needs ${rule}.${tail}` };
  };

  const rows = await ctx.runRows(ctx.rows, one);

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const seenKeys = new Set<string>();
  const unique: Json[] = [];
  rows.forEach((r, idx) => {
    const src = ctx.rows[idx];
    const key = "company_key" in r ? r.company_key : companyRef(src)[0];
    if (!key || r.status === "invalid_input" || seenKeys.has(key) || r.same_company_as) return;
    seenKeys.add(key);
    unique.push({ ...r, segment: "segment" in r ? r.segment : (hasSegment ? (src.segment || NO_SEGMENT) : null) });
  });
  const summary: Json = {
    status_counts: counts,
    rows: rows.length,
    invalid_rows: counts.invalid_input ?? 0,
    repeated_rows: rows.filter((r) => r.duplicate_of || r.same_company_as).length,
    unique_companies: unique.length,
    match_rule: cfg.match,
    ...measures(unique, cfg),
  };
  if (hasSegment) {
    const groups = new Map<string, Json[]>();
    for (const r of unique) {
      if (!groups.has(r.segment)) groups.set(r.segment, []);
      groups.get(r.segment)!.push(r);
    }
    const bySegment: Json = {};
    for (const [g, rs] of groups) bySegment[g] = measures(rs, cfg);
    summary.by_segment = bySegment;
  }
  if (summary.repeated_rows) {
    coverage.push(`${summary.repeated_rows} row(s) repeat a company already in the list. A repeated identifier ` +
      "reuses the earlier response, and each company is counted once.");
  }
  const incomplete = unique.filter((r) => r.status === "not_observed_incomplete" ||
    (r.status === "matched" && !(r.tech_intel ?? {}).complete)).length;
  if (incomplete) {
    coverage.push(`${incomplete} company(ies) have an incomplete technology list (max_pages is ` +
      `${cfg.max_pages}). Targets not matched for them are not observed in the pages retrieved.`);
  }
  const noted = rows.filter((r) => (r.data_notes ?? []).length).length;
  if (noted) {
    coverage.push(`${noted} row(s) have inconsistencies in the returned Tech Intel data. They are shown as ` +
      "returned and not corrected.");
  }
  return { rows, summary, coverage };
}

// ----- outputs -------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id", "segment", "duplicate_of", "same_company_as", "status",
  "status_reason", "firmable_id", "technologies_total", "technologies_retrieved", "list_complete",
  "targets_observed", "target_results", "matched_technologies", "below_threshold", "data_notes"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const targets: Json[] = r.targets ?? [];
    const ti = r.tech_intel ?? {};
    const inp = r.input;
    const matched: string[] = [];
    const below: string[] = [];
    for (const t of targets) {
      for (const m of t.matches) {
        const tech = m.technology;
        matched.push(`${t.target_id}:${s(tech.product)}(${s(tech.confidence)},${s(tech.recency)},${s(tech.last_observed)})`);
      }
      for (const m of t.below_threshold) {
        const tech = m.technology;
        below.push(`${t.target_id}:${s(tech.product)}(${s(tech.confidence)},${s(tech.recency)})`);
      }
    }
    return {
      row_id: r.row_id, domain: inp.domain ?? null, company_id: inp.company_id ?? null, segment: r.segment ?? null,
      duplicate_of: r.duplicate_of ?? null, same_company_as: r.same_company_as ?? null, status: r.status,
      status_reason: r.status_reason || r.reason || (r.error ?? {}).message || null,
      firmable_id: ti.company_id ?? null, technologies_total: ti.total ?? null,
      technologies_retrieved: ti.retrieved ?? null, list_complete: ti.complete ?? null,
      targets_observed: targets.filter((t) => t.result === "observed").map((t) => t.target_id),
      target_results: targets.map((t) => `${t.target_id}=${t.result}`),
      matched_technologies: matched, below_threshold: below, data_notes: r.data_notes ?? [],
    };
  });
}

const share = (x: Json): string => (!x ? "none answered" : `${x.numerator} of ${x.denominator} (${x.percent.toFixed(1)}%)`);

function measureRows(ms: Json, labels: Record<string, string>, cfg: Json): unknown[][] {
  const entries: [string, Json][] = [[`Match rule (${cfg.match})`, ms.audience]];
  for (const [tid, m] of Object.entries(ms.by_target)) entries.push([labels[tid], m]);
  return entries.map(([label, m]) => [label, m.companies_in_cohort, m.companies_asked, m.observed, m.not_observed,
    m.not_observed_in_pages_retrieved, m.observed_below_threshold, m.no_data, m.error,
    m.enough_answers ? share(m.observed_share) : "too few answers to compare", share(m.unknown_share)]);
}

const MEASURE_HEADERS = ["Measure", "Companies", "Asked", "Observed", "Not observed", "Not observed in pages retrieved",
  "Below threshold", "No data", "Error", "Observed share of answered", "Incomplete share"];

export function render(report: Report, result: Json): void {
  const summary = result.summary;
  const cfg = result.input.config;
  const labels: Record<string, string> = Object.fromEntries(cfg.targets.map((t: Json) => [t.id, t.label]));
  const counts: Record<string, number> = summary.status_counts ?? {};
  report.add("Result", "Audience in this list",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    note(esc(FRAMING), "unknown") +
    kv([["Input rows", summary.rows], ["Unique companies", summary.unique_companies],
      ["Rows repeating a company", summary.repeated_rows], ["Invalid rows", summary.invalid_rows],
      ["Match rule", summary.match_rule]]));
  if (summary.audience) {
    report.add("Measures", "Each target across this cohort", table(MEASURE_HEADERS, measureRows(summary, labels, cfg)) +
      '<p class="muted">Counts are unique companies in this cohort. Below threshold is a subset of not ' +
      "observed and not observed in pages retrieved.</p>");
  }
  if (summary.by_segment) {
    let body = "";
    for (const [seg, ms] of Object.entries(summary.by_segment)) body += `<h3>${esc(seg)}</h3>` + table(MEASURE_HEADERS, measureRows(ms, labels, cfg));
    report.add("Segments", "Each target by segment", body);
  }
  const rowsHtml: unknown[][] = [];
  let details = "";
  for (const r of result.rows) {
    const targets: Json[] = r.targets ?? [];
    const name = r.input.company_name || r.input.domain || r.input.company_id || r.row_id;
    const observed: string[] = [];
    for (const t of targets) {
      for (const m of t.matches) {
        const tech = m.technology;
        observed.push(`${t.label}: ${t_(tech.product)} (${t_(tech.confidence)}, ${t_(tech.recency)}, last observed ${t_(tech.last_observed)})`);
      }
    }
    const reason = r.status_reason || r.reason || r.error?.message || "";
    const notes = (r.data_notes ?? []).map((n: string) => note(esc(n), "unknown")).join("");
    rowsHtml.push([r.row_id, name, new Raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")),
      new Raw(observed.map((o) => esc(o)).join("<br>") || '<span class="muted">none</span>'), new Raw(esc(reason) + notes)]);
    if (targets.length) details += detailsJson(`Row ${r.row_id}: target results as JSON`, targets);
  }
  report.add("Companies", "Each company in input order",
    table(["Row", "Company", "Status", "Observed targets", "Reason"], rowsHtml) + details);
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
