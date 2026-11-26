/**
 * Ecosystem explorer: which technologies appear across a cohort, and which appear together.
 * Mirrors recipes/ecosystem-explorer/python/src/ecosystem_explorer/recipe.py; see that file and the
 * recipe README for the workflow, the measures and the co-occurrence rules.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConfigError, FATAL_KINDS, Json, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, detailsJson, esc, kv, normaliseDomain, note, pricing, readRows, table,
} from "firmable-api-client";

export const NAME = "ecosystem-explorer";
export const TITLE = "Ecosystem explorer";
export const DESCRIPTION = "Counts which technologies Firmable Tech Intel observed across a cohort of companies you supply, " +
  "and which technologies were observed at the same companies, with denominators.";

export const ASSET = fileURLToPath(new URL("../../../assets/explorer.js", import.meta.url));

const STATUS_TONE: Record<string, string> = {
  listed: "good", listed_incomplete: "review", no_technology_data: "unknown", company_not_found: "unknown",
  access_denied: "error", invalid_input: "error", error: "error", not_processed: "unknown",
};
const STOP_TEXT: Record<string, string> = {
  page_limit: "the page limit was reached",
  error: "a later page failed",
  budget: "the credit limit was reached",
  repeated_cursor: "the API returned a cursor it had already returned",
};
const CONFIDENCE_ORDER = ["high", "medium", "low"];
const NO_GROUP = "(no value)";
const NOT_RETURNED = "not returned";
const TECH_FIELDS = ["product", "product_slug", "vendor", "vendor_slug", "filter", "filter_slug", "category",
  "category_slug", "pillar_slug", "confidence", "recency", "last_observed", "nature"];
const TOP_KEYS = new Set(["max_pages", "with_evidence", "min_companies", "min_answered", "group_by", "categories",
  "cooccurrence_top"]);
const COMPANY_ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_PAGES_LIMIT = 25;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const textKey = (v: unknown): string => (typeof v === "string" ? v : "");
const nn = (v: unknown): Json => (v === undefined ? null : v);

function whole(raw: Json, key: string, def: number, low: number, high: number | null): number {
  const v = raw[key] ?? def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < low || (high !== null && v > high)) {
    const upper = high !== null ? ` to ${high}` : " or more";
    throw new ConfigError(`${key} must be a whole number from ${low}${upper}.`);
  }
  return v;
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const maxPages = whole(raw, "max_pages", 15, 1, MAX_PAGES_LIMIT);
  const withEvidence = raw.with_evidence ?? false;
  if (typeof withEvidence !== "boolean") throw new ConfigError("with_evidence must be true or false.");
  const minCompanies = whole(raw, "min_companies", 2, 1, null);
  const minAnswered = whole(raw, "min_answered", 5, 1, null);
  const cooccurrenceTop = whole(raw, "cooccurrence_top", 40, 2, 200);
  const groupBy = raw.group_by ?? null;
  if (groupBy !== null && (typeof groupBy !== "string" || !groupBy.trim())) {
    throw new ConfigError("group_by must be the name of an input column, or null.");
  }
  if (typeof groupBy === "string" && groupBy.trim() === "row_id") throw new ConfigError("group_by cannot be row_id.");
  const cats = raw.categories ?? null;
  const categories: string[] = [];
  if (cats !== null) {
    if (!Array.isArray(cats) || !cats.every((c) => typeof c === "string" && c.trim())) {
      throw new ConfigError("categories must be a list of category slugs, such as business-applications.");
    }
    for (const c of cats as string[]) if (!categories.includes(c.trim())) categories.push(c.trim());
  }
  return {
    max_pages: maxPages, with_evidence: withEvidence, min_companies: minCompanies, min_answered: minAnswered,
    group_by: typeof groupBy === "string" ? groupBy.trim() : null, categories, cooccurrence_top: cooccurrenceTop,
  };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["domain", "company_id"] });
}

function subject(row: Row): [Record<string, string> | null, string | null, string] {
  const cid = (row.company_id ?? "").trim();
  if (cid) {
    if (!COMPANY_ID.test(cid)) return [null, null, `Not a valid Firmable company ID: ${cid}`];
    return [{ id: cid }, `id:${cid}`, ""];
  }
  const rawDomain = row.domain ?? "";
  const domain = normaliseDomain(rawDomain);
  if (!domain) return [null, null, `Not a valid domain: ${rawDomain}`];
  return [{ fqdn: domain }, `fqdn:${domain}`, ""];
}

function uniqueSubjects(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const key = subject(r)[1];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueSubjects(rows).length;
  const pages: number = config.max_pages;
  const parts: [string, number][] = [["tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n)]];
  if (config.with_evidence) parts.push(["tech_intel_evidence", pricing.round4(pricing.TECH_INTEL_EVIDENCE_REQUEST * n * pages)]);
  return [new PlannedCall("GET /tech-intel", `Up to ${pages} page(s) of Tech Intel for each unique valid company`, n * pages, parts)];
}

// ----- helpers shared by run and the measures ------------------------------------------------

export function pctTenths(part: number, wholeN: number): number {
  return Math.floor((part * 1000 * 2 + wholeN) / (wholeN * 2));
}
export function pctText(part: number, wholeN: number): string {
  const t = pctTenths(part, wholeN);
  return `${Math.floor(t / 10)}.${t % 10}%`;
}
const pctValue = (part: number, wholeN: number): number => pctTenths(part, wholeN) / 10;

function rank(item: Json): number {
  const i = CONFIDENCE_ORDER.indexOf(item.confidence);
  return i >= 0 ? i : CONFIDENCE_ORDER.length;
}
const last = (item: Json): string => (typeof item.last_observed === "string" ? item.last_observed : "");

function evidenceSummary(ev: Json): Json {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return { status: "none_returned" };
  const records = (Array.isArray(ev.records) ? ev.records : []).filter((r: Json) => r && typeof r === "object" && !Array.isArray(r));
  const noLocation = records.filter((r: Json) => typeof r.location !== "string" || !r.location.trim()).length;
  const byType = (Array.isArray(ev.evidence_by_type) ? ev.evidence_by_type : []).filter((t: Json) => t && typeof t === "object");
  const capped = byType.filter((t: Json) => t.capped === true && typeof t.type === "string").map((t: Json) => t.type);
  const count = nn(ev.evidence_count);
  return {
    status: "returned", confidence: nn(ev.confidence), first_seen: nn(ev.first_seen), last_seen: nn(ev.last_seen),
    evidence_count: count, records_listed: records.length, records_without_location: noLocation, capped_types: capped,
    records_truncated: Number.isInteger(count) && records.length < count,
  };
}

function technologies(items: Json[], withEvidence: boolean, categories: string[]): [Json[], number, number] {
  const chosen = new Map<string, Json>();
  const counts = new Map<string, number>();
  let filtered = 0;
  let noSlug = 0;
  for (const item of items) {
    const slug = item.product_slug;
    if (typeof slug !== "string" || !slug.trim()) { noSlug += 1; continue; }
    if (categories.length && !categories.includes(item.category_slug)) { filtered += 1; continue; }
    if (!chosen.has(slug)) { chosen.set(slug, item); counts.set(slug, 1); continue; }
    counts.set(slug, (counts.get(slug) as number) + 1);
    const cur = chosen.get(slug);
    if (rank(item) < rank(cur) || (rank(item) === rank(cur) && last(item) > last(cur))) chosen.set(slug, item);
  }
  const out: Json[] = [];
  for (const [slug, item] of chosen) {
    const t: Json = {};
    for (const k of TECH_FIELDS) t[k] = nn(item[k]);
    t.key = slug;
    t.items_returned = counts.get(slug);
    if (withEvidence) t.evidence = evidenceSummary(item.evidence_detail);
    out.push(t);
  }
  return [out, filtered, noSlug];
}

function recordError(ctx: RunContext, rowId: string | null, err: Json, stop = false): Json {
  const entry = { row_id: rowId, ...err };
  ctx.errors.push(entry);
  if ((stop || FATAL_KINDS.has(err.kind)) && ctx.stopped === null) ctx.stopped = entry;
  return entry;
}

function measure(observed: number, notObserved: number, unknown: number, base: Json, minAnswered: number): Json {
  const withData: number = base.companies_with_data;
  const answered = observed + notObserved;
  const enough = answered >= minAnswered && answered > 0;
  const out: Json = {
    ...base, observed, not_observed: notObserved, not_observed_in_pages_retrieved: unknown, answered,
    observed_share_pct: enough ? pctValue(observed, answered) : null,
    unknown_share_pct: withData ? pctValue(unknown, withData) : null,
    enough_answers: enough,
  };
  if (withData === 0) {
    out.text = "No company in this cohort returned technology data.";
    return out;
  }
  let text = `Observed in ${observed} of ${withData} companies with data in this cohort.`;
  if (enough) {
    text += ` Observed share of answered companies: ${pctText(observed, answered)} (${observed} of ${answered}; ` +
      "answered means observed, or not observed in a complete list).";
  } else {
    text += ` Too few answers to compare: ${answered} answered, minimum ${minAnswered}.`;
  }
  if (unknown) text += ` Not observed in the pages retrieved for ${unknown} of ${withData} (${pctText(unknown, withData)}).`;
  out.text = text;
  return out;
}

// ----- run -----------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const client = ctx.client;
  const groupBy: string | null = cfg.group_by;
  const coverage: string[] = [
    "The cohort is the input file you supplied. The REST API has no company search and no lookup by " +
      "technology, so these counts describe the companies checked, not a market, sector or population.",
    "Every count states its denominator. Shares are observed over answered companies, where answered means " +
      "observed, or not observed in a complete technology list.",
    "A technology that was not found is not observed in retrieved data. This does not mean the company does " +
      "not use it.",
    "Co-occurrence counts the companies where both technologies were observed. It does not show integration, " +
      "compatibility or that the two are used together.",
    "Tech Intel reports observed technology signals with Firmable's confidence and recency. A detected " +
      "technology does not prove buying intent, spend or active usage.",
  ];
  if (!cfg.with_evidence) coverage.push("Evidence was not requested (with_evidence is false).");

  const firstBySubject = new Map<string, string>();
  const resultsByRow = new Map<string, Json>();
  const rowByCompanyId = new Map<string, string>();
  const groupColumnSeen = groupBy ? ctx.rows.some((r) => groupBy in r) : true;
  const groupOf = (row: Row): string | null => {
    if (!groupBy) return null;
    const v = (row[groupBy] ?? "").trim();
    return v || NO_GROUP;
  };

  const one = async (row: Row): Promise<Json> => {
    const [identifier, key, reason] = subject(row);
    const base: Json = {
      row_id: row.row_id, input: row, identifier, group: groupOf(row), duplicate_of: null, same_company_as: null,
      tech_intel: null, technologies: [], technologies_set_aside: 0, technologies_without_slug: 0,
    };
    if (key === null || identifier === null) return { ...base, status: "invalid_input", status_reason: reason };
    if (firstBySubject.has(key)) {
      const first = resultsByRow.get(firstBySubject.get(key) as string);
      const copy: Json = {};
      for (const [k, v] of Object.entries(first)) {
        if (!["row_id", "input", "group", "duplicate_of", "same_company_as"].includes(k)) copy[k] = v;
      }
      const out = { ...base, ...copy, duplicate_of: first.row_id };
      resultsByRow.set(row.row_id, out);
      return out;
    }
    firstBySubject.set(key, row.row_id);

    const ti = await client.getTechIntel(identifier, { withEvidence: cfg.with_evidence, maxPages: cfg.max_pages });
    const err: Json = ti.error;
    let entry: Json = null;
    if (err) entry = recordError(ctx, row.row_id, err, err.kind === "forbidden");
    const items = ti.items.filter((i: Json) => i && typeof i === "object" && !Array.isArray(i));
    const [techs, setAside, noSlug] = technologies(items, cfg.with_evidence, cfg.categories);
    base.tech_intel = {
      company_id: nn(ti.id), total: nn(ti.total), retrieved: items.length, pages_fetched: ti.pages_fetched,
      complete: ti.complete, stop_reason: ti.stop_reason, error: entry,
    };
    const cid = ti.id;
    if (typeof cid === "string" && cid) {
      if (rowByCompanyId.has(cid)) base.same_company_as = rowByCompanyId.get(cid);
      else rowByCompanyId.set(cid, row.row_id);
    }

    let out: Json;
    if (ti.pages_fetched === 0) {
      const kind = err?.kind;
      if (kind === "not_found") {
        out = { ...base, status: "company_not_found", status_reason: "Tech Intel has no company for this identifier (404)." };
      } else if (kind === "forbidden") {
        out = {
          ...base, status: "access_denied",
          status_reason: "Firmable returned 403 Forbidden for Tech Intel. This API key cannot " +
            "use this endpoint. The run stops, because later requests would be refused too.",
        };
      } else {
        out = { ...base, status: "error", status_reason: `Tech Intel could not be read: ${err?.message}` };
      }
      resultsByRow.set(row.row_id, out);
      return out;
    }

    Object.assign(base, { technologies: techs, technologies_set_aside: setAside, technologies_without_slug: noSlug });
    const total = ti.total;
    const totalText = Number.isInteger(total) ? String(total) : "an unknown number of";
    if (!items.length && ti.complete) {
      out = { ...base, status: "no_technology_data", status_reason: "Firmable holds no technology data for this company (total 0)." };
    } else if (ti.complete) {
      out = { ...base, status: "listed", status_reason: `The complete list was retrieved: ${totalText} ` +
          `${total === 1 ? "technology" : "technologies"} in ${ti.pages_fetched} page(s).` };
    } else {
      const why = STOP_TEXT[ti.stop_reason] ?? ti.stop_reason;
      out = {
        ...base, status: "listed_incomplete",
        status_reason: `The technology list is incomplete because ${why}: ${items.length} of ${totalText} ` +
          `technologies were retrieved in ${ti.pages_fetched} page(s).`,
      };
    }
    resultsByRow.set(row.row_id, out);
    return out;
  };

  const rows = await ctx.runRows(ctx.rows, one);
  for (const r of rows) {
    // Rows the shared runner filled in (not_processed, or an exception) get the same fields.
    if (!("tech_intel" in r)) {
      const defaults: [string, Json][] = [["identifier", subject(r.input)[0]], ["group", groupOf(r.input)], ["duplicate_of", null],
        ["same_company_as", null], ["tech_intel", null], ["technologies", []], ["technologies_set_aside", 0],
        ["technologies_without_slug", 0]];
      for (const [k, v] of defaults) if (!(k in r)) r[k] = v;
      if (!("status_reason" in r)) r.status_reason = r.reason || r.error?.message || "";
    }
  }
  const summary = summarise(rows, cfg);

  const dupes = rows.filter((r) => r.duplicate_of).length;
  const same = rows.filter((r) => r.same_company_as).length;
  if (dupes) {
    coverage.push(`${dupes} row(s) repeat an earlier company identifier. Their results were reused and ` +
      "they are counted once.");
  }
  if (same) {
    coverage.push(`${same} row(s) resolved to a Firmable company ID already returned for an earlier row. ` +
      "They are counted once, under the earlier row.");
  }
  if (summary.group_conflicts) {
    coverage.push(`${summary.group_conflicts} repeated row(s) carry a different ${groupBy} value from ` +
      "the first row for the same company. The first row's value was used.");
  }
  if (groupBy && !groupColumnSeen) coverage.push(`No input row has a ${groupBy} column, so every company is in the group ${NO_GROUP}.`);
  const c = summary.cohort;
  if (c.incomplete_lists) {
    coverage.push(`${c.incomplete_lists} company list(s) are incomplete (max_pages is ${cfg.max_pages}). ` +
      "Technologies not seen in them are not observed in the pages retrieved, and are not counted " +
      "as not observed.");
  }
  if (cfg.categories.length) {
    coverage.push(`Only technologies in these categories are counted: ${cfg.categories.join(", ")}. ` +
      `${summary.technologies_set_aside} retrieved technology item(s) in other categories ` +
      "were set aside.");
  }
  if (summary.technologies_without_slug) {
    coverage.push(`${summary.technologies_without_slug} retrieved technology item(s) have no product_slug ` +
      "and are not counted.");
  }
  if (summary.classification_conflicts.length) {
    coverage.push(`${summary.classification_conflicts.length} technology(ies) were returned with more than ` +
      "one category or vendor across companies. The first value returned is shown, and every " +
      "value is listed under classification_conflicts. This code does not correct upstream data.");
  }
  const ev = summary.evidence;
  if (ev) {
    if (ev.records_without_location) {
      coverage.push(`${ev.records_without_location} evidence record(s) have no location, so their ` +
        "source cannot be shown.");
    }
    if (ev.technologies_with_truncated_records) {
      coverage.push(`${ev.technologies_with_truncated_records} technology result(s) list fewer evidence ` +
        "records than their evidence_count. The API lists up to 25 records per type.");
    }
  }
  coverage.push(`A share is shown only when at least ${cfg.min_answered} companies answered (min_answered). ` +
    `The co-occurrence view lists technologies observed in at least ${cfg.min_companies} ` +
    "companies (min_companies).");
  coverage.push(`Co-occurrence pairs only the ${cfg.cooccurrence_top} technologies observed at the most ` +
    `companies (cooccurrence_top). ${summary.cooccurrence.not_paired} more technologies met ` +
    "min_companies and were not paired.");
  return { rows, summary, coverage };
}

function summarise(rows: Json[], cfg: Json): Json {
  const minAnswered: number = cfg.min_answered;
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  const companies = rows.filter((r) => r.status !== "invalid_input" && !r.duplicate_of && !r.same_company_as);
  const firstGroup = new Map<string, Json>(companies.map((r) => [r.row_id, nn(r.group)]));
  let groupConflicts = 0;
  for (const r of rows) {
    const anchor = r.duplicate_of || r.same_company_as;
    if (anchor && firstGroup.has(anchor) && nn(r.group) !== firstGroup.get(anchor)) groupConflicts += 1;
  }

  const state = (r: Json): string => {
    const s = r.status;
    if (s === "listed" || s === "listed_incomplete") return "with_data";
    if (s === "no_technology_data") return "no_data";
    if (s === "company_not_found") return "not_found";
    if (s === "not_processed") return "not_processed";
    return "error";
  };
  const baseCounts = (members: Json[]): Json => {
    const st = members.map(state);
    const n = (v: string) => st.filter((x) => x === v).length;
    return {
      cohort_companies: members.length, companies_asked: st.filter((x) => x !== "not_processed").length,
      companies_with_data: n("with_data"), no_data: n("no_data"), not_found: n("not_found"), error: n("error"),
      not_processed: n("not_processed"),
    };
  };

  const withData = companies.filter((r) => state(r) === "with_data");
  const has = new Map<string, Map<string, Json>>();
  const info = new Map<string, Json>();
  const conflicts = new Map<string, Record<string, Json[]>>();
  for (const r of withData) {
    const m = new Map<string, Json>();
    has.set(r.row_id, m);
    for (const t of r.technologies) {
      const k = t.key;
      m.set(k, t);
      if (!info.has(k)) {
        const i: Json = {};
        for (const f of ["product", "product_slug", "vendor", "vendor_slug", "category", "category_slug", "filter"]) i[f] = nn(t[f]);
        info.set(k, i);
        conflicts.set(k, { category_slug: [nn(t.category_slug)], vendor_slug: [nn(t.vendor_slug)] });
      } else {
        const c = conflicts.get(k) as Record<string, Json[]>;
        for (const f of ["category_slug", "vendor_slug"]) if (!c[f].includes(nn(t[f]))) c[f].push(nn(t[f]));
      }
    }
  }

  const groups: string[] = [];
  if (cfg.group_by) for (const r of companies) if (!groups.includes(r.group)) groups.push(r.group);
  const groupMembers = new Map<string, Json[]>(groups.map((g) => [g, companies.filter((r) => r.group === g)]));
  const overallBase = baseCounts(companies);
  const groupBase = new Map<string, Json>(groups.map((g) => [g, baseCounts(groupMembers.get(g) as Json[])]));

  const block = (k: string, members: Json[], base: Json): Json => {
    let o = 0, n = 0, u = 0;
    for (const r of members) {
      if (state(r) !== "with_data") continue;
      if ((has.get(r.row_id) as Map<string, Json>).has(k)) o += 1;
      else if (r.tech_intel.complete) n += 1;
      else u += 1;
    }
    return measure(o, n, u, base, minAnswered);
  };

  const techList: Json[] = [];
  for (const [k, i] of info) {
    const observedRows = withData.filter((r) => (has.get(r.row_id) as Map<string, Json>).has(k));
    const byConf: Record<string, number> = {};
    const byRec: Record<string, number> = {};
    for (const r of observedRows) {
      const t = (has.get(r.row_id) as Map<string, Json>).get(k);
      const cv = typeof t.confidence === "string" ? t.confidence : NOT_RETURNED;
      const rv = typeof t.recency === "string" ? t.recency : NOT_RETURNED;
      byConf[cv] = (byConf[cv] ?? 0) + 1;
      byRec[rv] = (byRec[rv] ?? 0) + 1;
    }
    const entry: Json = {
      key: k, ...i, overall: block(k, companies, overallBase), by_confidence: byConf, by_recency: byRec,
      observed_row_ids: observedRows.map((r) => r.row_id),
    };
    if (groups.length) {
      entry.by_group = {};
      for (const g of groups) entry.by_group[g] = block(k, groupMembers.get(g) as Json[], groupBase.get(g));
    }
    techList.push(entry);
  }
  techList.sort((a, b) => b.overall.observed - a.overall.observed || cmp(a.key, b.key));

  const eligible = techList.filter((t) => t.overall.observed >= cfg.min_companies).map((t) => t.key as string);
  const listed = eligible.slice(0, cfg.cooccurrence_top).sort(cmp);
  const notPaired = eligible.length - listed.length;
  const observedCount = new Map<string, number>(techList.map((t) => [t.key, t.overall.observed]));
  const pairs: Json[] = [];
  listed.forEach((a, i) => {
    for (const b of listed.slice(i + 1)) {
      const both = withData.filter((r) => {
        const m = has.get(r.row_id) as Map<string, Json>;
        return m.has(a) && m.has(b);
      }).length;
      if (!both) continue;
      const wa = observedCount.get(a) as number;
      const wb = observedCount.get(b) as number;
      pairs.push({
        a, b, both, companies_with_a: wa, companies_with_b: wb,
        share_of_a_pct: wa >= minAnswered ? pctValue(both, wa) : null,
        share_of_b_pct: wb >= minAnswered ? pctValue(both, wb) : null,
        text: `${both} of ${wa} companies with ${a} also show ${b}. ` +
          `${both} of ${wb} companies with ${b} also show ${a}.`,
      });
    }
  });
  pairs.sort((p, q) => q.both - p.both || cmp(p.a, q.a) || cmp(p.b, q.b));

  const conflictList: Json[] = [];
  for (const k of [...conflicts.keys()].sort(cmp)) {
    const c = conflicts.get(k) as Record<string, Json[]>;
    for (const f of ["category_slug", "vendor_slug"]) {
      if (c[f].length > 1) conflictList.push({ product_slug: k, field: f, values: [...c[f]].sort((x, y) => cmp(textKey(x), textKey(y))) });
    }
  }

  const cohort: Json = {
    ...overallBase, input_rows: rows.length, invalid_input_rows: statusCounts.invalid_input ?? 0,
    duplicate_rows: rows.filter((r) => r.duplicate_of).length,
    same_company_rows: rows.filter((r) => r.same_company_as).length,
    incomplete_lists: withData.filter((r) => !r.tech_intel.complete).length,
    technologies_observed: techList.length,
  };
  const out: Json = {
    status_counts: statusCounts, cohort, group_by: cfg.group_by, groups,
    group_cohorts: groups.map((g) => ({ group: g, ...groupBase.get(g) })),
    technologies: techList,
    cooccurrence: { min_companies: cfg.min_companies, top: cfg.cooccurrence_top, listed, not_paired: notPaired, pairs },
    classification_conflicts: conflictList, group_conflicts: groupConflicts,
    technologies_set_aside: companies.reduce((s, r) => s + (r.technologies_set_aside || 0), 0),
    technologies_without_slug: companies.reduce((s, r) => s + (r.technologies_without_slug || 0), 0),
  };
  if (cfg.with_evidence) {
    let noLoc = 0, trunc = 0, none = 0;
    for (const r of withData) {
      for (const t of r.technologies) {
        const e = t.evidence ?? {};
        if (e.status !== "returned") { none += 1; continue; }
        noLoc += e.records_without_location || 0;
        if (e.records_truncated) trunc += 1;
      }
    }
    out.evidence = { records_without_location: noLoc, technologies_with_truncated_records: trunc, technologies_without_evidence: none };
  }
  return out;
}

// ----- outputs -------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id_input", "group", "status", "status_reason", "duplicate_of",
  "same_company_as", "firmable_id", "technologies_total", "technologies_retrieved", "technologies_counted",
  "pages_fetched", "list_complete", "stop_reason", "technologies"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const ti = r.tech_intel ?? {};
    const inp = r.input ?? {};
    const techs: Json[] = r.technologies ?? [];
    return {
      row_id: r.row_id, domain: inp.domain, company_id_input: inp.company_id, group: r.group, status: r.status,
      status_reason: r.status_reason || r.reason || r.error?.message,
      duplicate_of: r.duplicate_of, same_company_as: r.same_company_as, firmable_id: ti.company_id,
      technologies_total: ti.total, technologies_retrieved: ti.retrieved,
      technologies_counted: r.tech_intel ? techs.length : null, pages_fetched: ti.pages_fetched,
      list_complete: ti.complete, stop_reason: ti.stop_reason, technologies: techs.map((t) => t.key),
    };
  });
}

function label(r: Json): string {
  const inp = r.input ?? {};
  const ident = r.identifier ?? {};
  return inp.company_name || ident.fqdn || ident.id || inp.domain || inp.company_id || r.row_id;
}

/** The data the explorer page script reads. Everything comes from results.json. */
export function explorerData(result: Json): Json {
  const s = result.summary;
  const companies: Json[] = [];
  for (const r of result.rows) {
    if (r.duplicate_of || r.same_company_as || r.status === "invalid_input") continue;
    const ti = r.tech_intel ?? {};
    companies.push({
      row_id: r.row_id, label: label(r), group: nn(r.group), status: r.status,
      status_reason: r.status_reason || r.reason || "", complete: nn(ti.complete), total: nn(ti.total),
      retrieved: nn(ti.retrieved),
      technologies: (r.technologies ?? []).map((t: Json) => {
        const o: Json = {};
        for (const k of ["key", "product", "vendor", "category", "confidence", "recency", "last_observed", "nature"]) o[k] = nn(t[k]);
        return o;
      }),
    });
  }
  const techs = s.technologies.map((t: Json) => {
    const o: Json = {};
    for (const k of ["key", "product", "vendor", "vendor_slug", "category", "category_slug", "overall", "by_group",
      "by_confidence", "by_recency"]) o[k] = nn(t[k]);
    return o;
  });
  return {
    group_by: nn(s.group_by), groups: s.groups ?? [], technologies: techs, companies, pairs: s.cooccurrence.pairs,
    listed: s.cooccurrence.listed, min_companies: s.cooccurrence.min_companies, cohort: s.cohort,
  };
}

export function render(report: Report, result: Json): void {
  const s = result.summary;
  const c = s.cohort;
  const counts: Record<string, number> = s.status_counts ?? {};
  const body = "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    kv([["Input rows", c.input_rows], ["Companies in the cohort", c.cohort_companies], ["Companies asked", c.companies_asked],
      ["Companies with data", c.companies_with_data], ["Of which incomplete lists", c.incomplete_lists],
      ["No technology data", c.no_data], ["Not found", c.not_found], ["Errors", c.error], ["Not processed", c.not_processed],
      ["Invalid input rows", c.invalid_input_rows], ["Technologies observed", c.technologies_observed]]) +
    note("These counts describe this cohort only. The cohort is the input file you supplied, not a " +
      "market or sector. Not observed means not observed in retrieved data.", "unknown");
  report.add("Result", "Cohort coverage", body);

  report.add("Explore", "Technology explorer",
    '<div id="explorer"><p class="muted">The interactive explorer needs JavaScript. The tables below ' +
    "show the same counts.</p></div>" +
    note("Co-occurrence counts companies where both technologies were observed. It does not show " +
      "integration, compatibility or use together.", "unknown"));
  report.addData("explorer-data", explorerData(result));
  report.addScript(readFileSync(ASSET, "utf-8"));

  const techs: Json[] = s.technologies;
  const rows = techs.slice(0, 50).map((t) => {
    const o = t.overall;
    const share = o.enough_answers ? `${o.observed_share_pct}% of ${o.answered}` : "too few answers to compare";
    return [t.product, t.vendor, t.category, `${o.observed} of ${o.companies_with_data}`, share,
      o.not_observed_in_pages_retrieved, Object.entries(t.by_confidence).map(([k, v]) => `${k}: ${v}`).join(", ")];
  });
  let tbody = rows.length
    ? table(["Technology", "Vendor", "Category", "Observed (of companies with data)", "Share of answered",
      "Not observed in pages retrieved", "Confidence"], rows)
    : "<p>No technologies were observed.</p>";
  if (techs.length > 50) tbody += `<p class="muted">The 50 most observed of ${techs.length} technologies are shown. All are in results.json.</p>`;
  report.add("Technologies", "Most observed technologies", tbody);

  const pairs: Json[] = s.cooccurrence.pairs;
  const prow = pairs.slice(0, 50).map((p) => [p.a, p.b, p.both, p.companies_with_a, p.companies_with_b, p.text]);
  const pbody = prow.length
    ? table(["Technology A", "Technology B", "Companies with both", "With A", "With B", "Reading"], prow)
    : `<p>No pair of technologies was observed together among technologies seen in at least ${esc(s.cooccurrence.min_companies)} companies.</p>`;
  report.add("Co-occurrence", "Technologies observed at the same companies", pbody);

  const crow = result.rows.map((r: Json) => {
    const ti = r.tech_intel ?? {};
    return [r.row_id, label(r), r.group ?? "", new Raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")),
      ti.retrieved, ti.total, ti.complete, r.status_reason || r.reason || "", r.duplicate_of || r.same_company_as || ""];
  });
  report.add("Companies", "Each company in the cohort",
    table(["Row", "Company", "Group", "Status", "Retrieved", "Total", "Complete", "Reason", "Same as row"], crow) +
    (s.classification_conflicts.length ? detailsJson("Classification conflicts as JSON", s.classification_conflicts) : ""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
