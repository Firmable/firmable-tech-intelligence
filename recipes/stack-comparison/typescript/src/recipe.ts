/**
 * Stack comparison: what a small set of companies' observed stacks share, and where they differ.
 * Mirrors recipes/stack-comparison/python/src/stack_comparison/recipe.py; see that file and the
 * recipe README for the matrix values and the shared and unique lists.
 */
import {
  ConfigError, FATAL_KINDS, InputError, Json, PlannedCall, Raw, Recipe, Report, RunContext, Row,
  badge, bulletList, kv, normaliseDomain, note, pricing, readRows, table,
} from "firmable-api-client";

export const NAME = "stack-comparison";
export const TITLE = "Stack comparison";
export const DESCRIPTION = "Compares the technologies Firmable Tech Intel observed at 2 to 20 companies: what every company " +
  "with data shares, what some share, and what was observed at only one.";

const STATUS_TONE: Record<string, string> = {
  listed: "good", listed_incomplete: "review", no_technology_data: "unknown", company_not_found: "unknown",
  access_denied: "error", invalid_input: "error", error: "error", not_processed: "unknown",
};
const CELL_TONE: Record<string, string> = {
  observed: "good", not_observed: "neutral", not_observed_in_pages_retrieved: "review", no_data: "unknown",
};
const CELL_TEXT: Record<string, string> = {
  observed: "observed", not_observed: "not observed (complete list)",
  not_observed_in_pages_retrieved: "not observed in pages retrieved", no_data: "no data",
};
const STOP_TEXT: Record<string, string> = {
  page_limit: "the page limit was reached",
  error: "a later page failed",
  budget: "the credit limit was reached",
  repeated_cursor: "the API returned a cursor it had already returned",
};
const CONFIDENCE_ORDER = ["high", "medium", "low"];
const LEVEL_FIELDS: Record<string, [string, string]> = { product: ["product_slug", "product"], category: ["category_slug", "category"] };
const TOP_KEYS = new Set(["max_pages", "with_evidence", "level"]);
const COMPANY_ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_PAGES_LIMIT = 25;
const MIN_ROWS = 2;
const MAX_ROWS = 20;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const nn = (v: unknown): Json => (v === undefined ? null : v);

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const maxPages = raw.max_pages ?? 3;
  if (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new ConfigError(`max_pages must be a whole number from 1 to ${MAX_PAGES_LIMIT}.`);
  }
  const withEvidence = raw.with_evidence ?? false;
  if (typeof withEvidence !== "boolean") throw new ConfigError("with_evidence must be true or false.");
  const level = raw.level ?? "product";
  if (typeof level !== "string" || !(level in LEVEL_FIELDS)) throw new ConfigError("level must be product or category.");
  return { max_pages: maxPages, with_evidence: withEvidence, level };
}

export function readInput(path: string): Row[] {
  const rows = readRows(path, { anyOf: ["domain", "company_id"] });
  if (rows.length < MIN_ROWS || rows.length > MAX_ROWS) {
    throw new InputError(`A stack comparison needs ${MIN_ROWS} to ${MAX_ROWS} input rows, not ${rows.length}.`);
  }
  return rows;
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

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const keys: string[] = [];
  for (const r of rows) {
    const key = subject(r)[1];
    if (key && !keys.includes(key)) keys.push(key);
  }
  const n = keys.length;
  const pages: number = config.max_pages;
  const parts: [string, number][] = [["tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n)]];
  if (config.with_evidence) parts.push(["tech_intel_evidence", pricing.round4(pricing.TECH_INTEL_EVIDENCE_REQUEST * n * pages)]);
  return [new PlannedCall("GET /tech-intel", `Up to ${pages} page(s) of Tech Intel for each unique valid company`, n * pages, parts)];
}

function rank(item: Json): number {
  const i = CONFIDENCE_ORDER.indexOf(item.confidence);
  return i >= 0 ? i : CONFIDENCE_ORDER.length;
}
const last = (item: Json): string => (typeof item.last_observed === "string" ? item.last_observed : "");

function evidenceSummary(ev: Json): Json {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return { status: "none_returned" };
  const records = (Array.isArray(ev.records) ? ev.records : []).filter((r: Json) => r && typeof r === "object" && !Array.isArray(r));
  const noLocation = records.filter((r: Json) => typeof r.location !== "string" || !r.location.trim()).length;
  const count = nn(ev.evidence_count);
  return {
    status: "returned", confidence: nn(ev.confidence), first_seen: nn(ev.first_seen), last_seen: nn(ev.last_seen),
    evidence_count: count, records_listed: records.length, records_without_location: noLocation,
    records_truncated: Number.isInteger(count) && records.length < count,
  };
}

function entries(items: Json[], level: string, withEvidence: boolean): [Json[], number] {
  const [keyField, labelField] = LEVEL_FIELDS[level];
  const chosen = new Map<string, Json>();
  const products = new Map<string, string[]>();
  let noKey = 0;
  for (const item of items) {
    const k = item[keyField];
    if (typeof k !== "string" || !k.trim()) { noKey += 1; continue; }
    if (!chosen.has(k)) {
      chosen.set(k, item);
      products.set(k, []);
    } else {
      const cur = chosen.get(k);
      if (rank(item) < rank(cur) || (rank(item) === rank(cur) && last(item) > last(cur))) chosen.set(k, item);
    }
    const p = item.product_slug;
    const list = products.get(k) as string[];
    if (typeof p === "string" && p && !list.includes(p)) list.push(p);
  }
  const out: Json[] = [];
  for (const [k, item] of chosen) {
    const e: Json = {
      key: k, label: nn(item[labelField]), vendor: level === "product" ? nn(item.vendor) : null, category: nn(item.category),
      products: products.get(k), confidence: nn(item.confidence), recency: nn(item.recency),
      last_observed: nn(item.last_observed), nature: nn(item.nature),
    };
    if (withEvidence) e.evidence = evidenceSummary(item.evidence_detail);
    out.push(e);
  }
  return [out, noKey];
}

function recordError(ctx: RunContext, rowId: string | null, err: Json, stop = false): Json {
  const entry = { row_id: rowId, ...err };
  ctx.errors.push(entry);
  if ((stop || FATAL_KINDS.has(err.kind)) && ctx.stopped === null) ctx.stopped = entry;
  return entry;
}

function label(row: Json): string {
  const inp = row.input ?? {};
  const ident = row.identifier ?? {};
  return inp.company_name || ident.fqdn || ident.id || inp.domain || inp.company_id || row.row_id;
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const client = ctx.client;
  const level: string = cfg.level;
  const coverage: string[] = [
    "The comparison covers only the companies in your input file. It does not describe a market or sector.",
    "A technology that was not found is not observed in retrieved data. This does not mean the company does " +
      "not use it.",
    "Tech Intel reports observed technology signals with Firmable's confidence and recency. A detected " +
      "technology does not prove buying intent, spend or active usage.",
  ];
  if (level === "category") {
    coverage.push("Compared at category level: a category is observed at a company when any product in that " +
      "category was observed there.");
  }
  if (!cfg.with_evidence) coverage.push("Evidence was not requested (with_evidence is false).");

  const firstBySubject = new Map<string, string>();
  const resultsByRow = new Map<string, Json>();
  const rowByCompanyId = new Map<string, string>();

  const one = async (row: Row): Promise<Json> => {
    const [identifier, key, reason] = subject(row);
    const base: Json = {
      row_id: row.row_id, input: row, identifier, duplicate_of: null, same_company_as: null, tech_intel: null,
      technologies: [], items_without_key: 0,
    };
    if (key === null || identifier === null) return { ...base, status: "invalid_input", status_reason: reason };
    if (firstBySubject.has(key)) {
      const first = resultsByRow.get(firstBySubject.get(key) as string);
      const copy: Json = {};
      for (const [k, v] of Object.entries(first)) {
        if (!["row_id", "input", "duplicate_of", "same_company_as"].includes(k)) copy[k] = v;
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

    const [ents, noKey] = entries(items, level, cfg.with_evidence);
    Object.assign(base, { technologies: ents, items_without_key: noKey });
    const total = ti.total;
    const totalText = Number.isInteger(total) ? String(total) : "an unknown number of";
    if (!items.length && ti.complete) {
      out = { ...base, status: "no_technology_data", status_reason: "Firmable holds no technology data for this company (total 0)." };
    } else if (ti.complete) {
      out = {
        ...base, status: "listed",
        status_reason: `The complete list was retrieved: ${totalText} ` +
          `${total === 1 ? "technology" : "technologies"} in ${ti.pages_fetched} page(s).`,
      };
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
      const defaults: [string, Json][] = [["identifier", subject(r.input)[0]], ["duplicate_of", null], ["same_company_as", null],
        ["tech_intel", null], ["technologies", []], ["items_without_key", 0]];
      for (const [k, v] of defaults) if (!(k in r)) r[k] = v;
      if (!("status_reason" in r)) r.status_reason = r.reason || r.error?.message || "";
    }
  }
  const summary = compare(rows, cfg);

  const dupes = rows.filter((r) => r.duplicate_of).length;
  const same = rows.filter((r) => r.same_company_as).length;
  if (dupes) {
    coverage.push(`${dupes} row(s) repeat an earlier company identifier. Their results were reused and the ` +
      "company appears once in the comparison.");
  }
  if (same) {
    coverage.push(`${same} row(s) resolved to a Firmable company ID already returned for an earlier row. The ` +
      "company appears once in the comparison, under the earlier row.");
  }
  const c = summary.counts;
  if (c.incomplete_lists) {
    coverage.push(`${c.incomplete_lists} company list(s) are incomplete (max_pages is ${cfg.max_pages}). ` +
      "Technologies not seen in them are not observed in the pages retrieved, so shared and unique " +
      "lists may change with more pages.");
  }
  if (c.companies_with_data < 2) {
    coverage.push(`Only ${c.companies_with_data} company(ies) returned technology data. Shared and unique ` +
      "lists need at least two companies with data, so they are empty.");
  }
  if (summary.items_without_key) {
    coverage.push(`${summary.items_without_key} retrieved technology item(s) have no ` +
      `${LEVEL_FIELDS[level][0]} and are not compared.`);
  }
  if (summary.evidence_records_without_location) {
    coverage.push(`${summary.evidence_records_without_location} evidence record(s) have no location, so ` +
      "their source cannot be shown.");
  }
  return { rows, summary, coverage };
}

function compare(rows: Json[], cfg: Json): Json {
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  const companies = rows.filter((r) => r.status !== "invalid_input" && !r.duplicate_of && !r.same_company_as);
  const withData = companies.filter((r) => r.status === "listed" || r.status === "listed_incomplete");
  const dataIds: string[] = withData.map((r) => r.row_id);
  const has = new Map<string, Map<string, Json>>(withData.map((r) => [r.row_id, new Map(r.technologies.map((t: Json) => [t.key, t]))]));

  const info = new Map<string, Json>();
  for (const r of withData) {
    for (const t of r.technologies) {
      if (!info.has(t.key)) info.set(t.key, { label: nn(t.label), vendor: nn(t.vendor), category: nn(t.category) });
    }
  }
  const cell = (r: Json, k: string): string => {
    const m = has.get(r.row_id);
    if (!m) return "no_data";
    if (m.has(k)) return "observed";
    return r.tech_intel.complete ? "not_observed" : "not_observed_in_pages_retrieved";
  };

  const techs: Json[] = [];
  for (const [k, i] of info) {
    const cells: Record<string, string> = {};
    for (const r of companies) cells[r.row_id] = cell(r, k);
    const observed = dataIds.filter((x) => cells[x] === "observed");
    const notObs = dataIds.filter((x) => cells[x] === "not_observed");
    const unknown = dataIds.filter((x) => cells[x] === "not_observed_in_pages_retrieved");
    let sharing: string;
    if (dataIds.length < 2) sharing = "not_compared";
    else if (observed.length === dataIds.length) sharing = "all";
    else if (observed.length >= 2) sharing = "some";
    else sharing = "one";
    const details: Json = {};
    for (const x of observed) {
      const t = (has.get(x) as Map<string, Json>).get(k);
      details[x] = { confidence: nn(t.confidence), recency: nn(t.recency), last_observed: nn(t.last_observed) };
    }
    techs.push({
      key: k, ...i, cells, observed_in: observed, not_observed_in: notObs, not_observed_in_pages_retrieved: unknown,
      observed_count: observed.length, sharing, details,
    });
  }
  techs.sort((a, b) => b.observed_count - a.observed_count || cmp(a.key, b.key));

  const labels = new Map<string, string>(companies.map((r) => [r.row_id, label(r)]));
  const unique: Json[] = [];
  for (const t of techs) {
    if (t.sharing !== "one") continue;
    const who: string = t.observed_in[0];
    const unknown = t.not_observed_in_pages_retrieved.length;
    const text = unknown
      ? `Observed only at ${labels.get(who)} in retrieved data. Not observed in the pages retrieved for ` +
        `${unknown} other company(ies), so it may not be unique.`
      : `Observed only at ${labels.get(who)}. Every other company with data has a complete list.`;
    unique.push({ key: t.key, row_id: who, confirmed: unknown === 0, text });
  }
  const some: Json[] = [];
  for (const t of techs) {
    if (t.sharing !== "some") continue;
    let text = `Observed at ${t.observed_in.length} of ${dataIds.length} companies with data: ` +
      t.observed_in.map((x: string) => labels.get(x)).join(", ") + ".";
    if (t.not_observed_in_pages_retrieved.length) {
      text += ` Not observed in the pages retrieved for ${t.not_observed_in_pages_retrieved.length} company(ies).`;
    }
    some.push({ key: t.key, text });
  }

  const out: Json = {
    status_counts: statusCounts, level: cfg.level,
    companies: companies.map((r) => ({
      row_id: r.row_id, label: labels.get(r.row_id), status: r.status, complete: nn(r.tech_intel?.complete),
      compared: has.has(r.row_id),
    })),
    counts: {
      input_rows: rows.length, companies: companies.length, companies_with_data: withData.length,
      incomplete_lists: withData.filter((r) => !r.tech_intel.complete).length, technologies: techs.length,
      shared_by_all: techs.filter((t) => t.sharing === "all").length, shared_by_some: some.length, unique_to_one: unique.length,
    },
    technologies: techs,
    shared_by_all: techs.filter((t) => t.sharing === "all").map((t) => t.key),
    shared_by_some: some,
    unique_to_one: unique,
    items_without_key: companies.reduce((s, r) => s + (r.items_without_key || 0), 0),
  };
  if (cfg.with_evidence) {
    let n = 0;
    for (const r of withData) for (const t of r.technologies) n += t.evidence?.records_without_location || 0;
    out.evidence_records_without_location = n;
  }
  return out;
}

// ----- outputs -------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id_input", "company", "status", "status_reason", "duplicate_of",
  "same_company_as", "firmable_id", "technologies_total", "technologies_retrieved", "technologies_compared",
  "pages_fetched", "list_complete", "shared_by_all", "unique_to_this_company"];

export function csvRows(result: Json): Record<string, unknown>[] {
  const s = result.summary;
  const shared = new Set<string>(s.shared_by_all);
  return result.rows.map((r: Json) => {
    const ti = r.tech_intel ?? {};
    const inp = r.input ?? {};
    const anchor = r.duplicate_of || r.same_company_as || r.row_id;
    const mine: string[] = (r.technologies ?? []).map((t: Json) => t.key);
    return {
      row_id: r.row_id, domain: inp.domain, company_id_input: inp.company_id, company: label(r), status: r.status,
      status_reason: r.status_reason || r.reason || r.error?.message,
      duplicate_of: r.duplicate_of, same_company_as: r.same_company_as, firmable_id: ti.company_id,
      technologies_total: ti.total, technologies_retrieved: ti.retrieved,
      technologies_compared: r.tech_intel ? mine.length : null, pages_fetched: ti.pages_fetched, list_complete: ti.complete,
      shared_by_all: mine.filter((k) => shared.has(k)).length,
      unique_to_this_company: s.unique_to_one.filter((u: Json) => u.row_id === anchor).map((u: Json) => u.key),
    };
  });
}

/** Escapes API and input text for Markdown: \ ` * _ [ ] < > | and a leading #. */
export function mdEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value).replace(/[\r\n\t]/g, " ");
  s = s.replace(/([\\`*_[\]<>|])/g, "\\$1");
  if (s.startsWith("#")) s = "\\" + s;
  return s;
}

const techName = (t: Json): string => `${mdEscape(t.label || t.key)} (${mdEscape(t.key)})`;

export function markdown(result: Json): Record<string, string> {
  const s = result.summary;
  const c = s.counts;
  const labels = new Map<string, string>(s.companies.map((co: Json) => [co.row_id, co.label]));
  let lines: string[] = ["# Stack comparison", "",
    `Level: ${s.level}. Companies compared: ${c.companies}. Companies with technology data: ` +
    `${c.companies_with_data}. Incomplete lists: ${c.incomplete_lists}.`, "",
    "\"Observed\" means Firmable Tech Intel observed the technology in the retrieved data. \"Not observed\" " +
    "means not observed in retrieved data, not that the company does not use it. This comparison covers " +
    "only these companies.", "",
    "## Companies", "",
    "| Company | Row | Status | Technologies retrieved | Total | List complete |",
    "| - | - | - | - | - | - |"];
  const byRow = new Map<string, Json>(result.rows.map((r: Json) => [r.row_id, r]));
  for (const co of s.companies) {
    const ti = (byRow.get(co.row_id) as Json).tech_intel ?? {};
    lines.push(`| ${mdEscape(co.label)} | ${mdEscape(co.row_id)} | ${co.status.replace(/_/g, " ")} | ` +
      `${mdEscape(ti.retrieved)} | ${mdEscape(ti.total)} | ${ti.complete ? "yes" : "no"} |`);
  }
  const techs = new Map<string, Json>(s.technologies.map((t: Json) => [t.key, t]));
  const orNone = (xs: string[]): string[] => (xs.length ? xs : ["None."]);
  lines = lines.concat(["", "## Shared by every company with data", ""]);
  lines = lines.concat(orNone(s.shared_by_all.map((k: string) => `- ${techName(techs.get(k))}`)));
  lines = lines.concat(["", "## Shared by some companies", ""]);
  lines = lines.concat(orNone(s.shared_by_some.map((x: Json) => `- ${techName(techs.get(x.key))}: ${mdEscape(x.text)}`)));
  lines = lines.concat(["", "## Observed at only one company", ""]);
  lines = lines.concat(orNone(s.unique_to_one.map((x: Json) => `- ${techName(techs.get(x.key))}: ${mdEscape(x.text)}`)));
  lines = lines.concat(["", "## Matrix", ""]);
  const compared: Json[] = s.companies;
  if (s.technologies.length) {
    lines.push("| Technology | " + compared.map((co) => mdEscape(labels.get(co.row_id))).join(" | ") + " |");
    lines.push("| - |" + " - |".repeat(compared.length));
    for (const t of s.technologies) {
      lines.push(`| ${techName(t)} | ` + compared.map((co) => CELL_TEXT[t.cells[co.row_id]]).join(" | ") + " |");
    }
  } else {
    lines.push("No technologies were observed.");
  }
  lines = lines.concat(["", "## Coverage and limitations", ""]);
  lines = lines.concat((result.coverage ?? []).map((x: string) => `- ${mdEscape(x)}`));
  return { "comparison.md": lines.join("\n") + "\n" };
}

export function render(report: Report, result: Json): void {
  const s = result.summary;
  const c = s.counts;
  const counts: Record<string, number> = s.status_counts ?? {};
  report.add("Result", "Comparison summary",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    kv([["Level", s.level], ["Companies compared", c.companies], ["Companies with technology data", c.companies_with_data],
      ["Incomplete lists", c.incomplete_lists], ["Technologies observed", c.technologies],
      ["Shared by every company with data", c.shared_by_all], ["Shared by some", c.shared_by_some],
      ["Observed at only one", c.unique_to_one]]) +
    note("Not observed means not observed in retrieved data. It does not mean the company does not " +
      "use the technology.", "unknown"));
  const techs = new Map<string, Json>(s.technologies.map((t: Json) => [t.key, t]));
  const name = (k: string): string => `${(techs.get(k) as Json).label || k} (${k})`;
  let body = "<h3>Shared by every company with data</h3>" + (bulletList(s.shared_by_all.map(name)) || "<p>None.</p>");
  body += "<h3>Shared by some companies</h3>" + (bulletList(s.shared_by_some.map((x: Json) => `${name(x.key)}: ${x.text}`)) || "<p>None.</p>");
  body += "<h3>Observed at only one company</h3>" + (bulletList(s.unique_to_one.map((x: Json) => `${name(x.key)}: ${x.text}`)) || "<p>None.</p>");
  report.add("Lists", "Shared and unique technologies", body);

  const companies: Json[] = s.companies;
  const mbody = s.technologies.length
    ? table(["Technology", ...companies.map((co) => co.label)], s.technologies.map((t: Json) =>
      [name(t.key), ...companies.map((co) => new Raw(badge(CELL_TEXT[t.cells[co.row_id]], CELL_TONE[t.cells[co.row_id]])))]))
    : "<p>No technologies were observed.</p>";
  report.add("Matrix", "Technology by company", mbody);

  const crow = result.rows.map((r: Json) => {
    const ti = r.tech_intel ?? {};
    return [r.row_id, label(r), new Raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")),
      ti.retrieved, ti.total, ti.complete, r.status_reason || r.reason || "", r.duplicate_of || r.same_company_as || ""];
  });
  report.add("Companies", "Each input row",
    table(["Row", "Company", "Status", "Retrieved", "Total", "Complete", "Reason", "Same as row"], crow));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render, markdown,
};
