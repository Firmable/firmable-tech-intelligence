import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { ASSET, RECIPE, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("ecosystem-explorer");
const tmp = () => mkdtempSync(join(tmpdir(), "eco-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const tech = (result: Json, key: string): Json => result.summary.technologies.find((t: Json) => t.key === key);

test("happy path statuses and calls", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => rows[`h${i}`].status), [
    "listed", "listed", "no_technology_data", "listed_incomplete", "listed", "listed", "invalid_input",
    "company_not_found", "listed", "listed"]);
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.length, 10);
  assert.deepEqual(transport.sent[6].query, { id: "f900000000005" });
  assert.ok(rows.h4.status_reason.includes("page limit was reached: 3 of 40"));
  assert.equal(rows.h10.status_reason, "The complete list was retrieved: 1 technology in 1 page(s).");
});

test("duplicates and the same company are counted once", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.equal(rows.h6.duplicate_of, "h1");
  assert.equal(rows.h9.same_company_as, "h5");
  const c = result.summary.cohort;
  assert.deepEqual([c.input_rows, c.cohort_companies, c.companies_with_data, c.no_data, c.not_found], [10, 7, 5, 1, 1]);
  assert.deepEqual([c.duplicate_rows, c.same_company_rows, c.invalid_input_rows, c.incomplete_lists], [1, 1, 1, 1]);
  assert.deepEqual(tech(result, "zendesk").observed_row_ids, ["h1", "h4", "h5"]);
});

test("measures state denominators and keep unknown separate", async () => {
  const [result] = await run("happy");
  const slack = tech(result, "slack").overall;
  assert.deepEqual([slack.observed, slack.not_observed, slack.not_observed_in_pages_retrieved], [4, 1, 0]);
  assert.equal(slack.observed_share_pct, 80);
  const sf = tech(result, "salesforce-sales-cloud").overall;
  assert.deepEqual([sf.observed, sf.not_observed, sf.not_observed_in_pages_retrieved], [3, 1, 1]);
  assert.equal(sf.observed_share_pct, 75);
  assert.equal(sf.unknown_share_pct, 20);
  assert.ok(sf.text.includes("75.0% (3 of 4") && sf.text.includes("for 1 of 5 (20.0%)"));
  assert.deepEqual(result.summary.technologies.slice(0, 3).map((t: Json) => t.key), ["slack", "salesforce-sales-cloud", "zendesk"]);
});

test("groups have their own denominators", async () => {
  const [result] = await run("happy");
  const s = result.summary;
  assert.deepEqual(s.groups, ["fintech", "retail", "(no value)"]);
  assert.equal(s.group_cohorts[0].companies_with_data, 2);
  const fin = tech(result, "slack").by_group.fintech;
  assert.deepEqual([fin.observed, fin.companies_with_data, fin.observed_share_pct], [2, 2, 100]);
  assert.equal(s.group_conflicts, 1);
});

test("strongest item is kept for a repeated product", async () => {
  const [result] = await run("happy");
  const slack = byId(result).h1.technologies.find((t: Json) => t.key === "slack");
  assert.equal(slack.confidence, "high");
  assert.equal(slack.items_returned, 2);
  assert.deepEqual(tech(result, "salesforce-sales-cloud").by_confidence, { high: 2, medium: 1 });
});

test("co-occurrence has denominators and a fixed note", async () => {
  const [result] = await run("happy");
  const co = result.summary.cooccurrence;
  assert.deepEqual(co.listed, ["salesforce-sales-cloud", "slack", "zendesk"]);
  const p = co.pairs[0];
  assert.deepEqual([p.a, p.b, p.both, p.companies_with_a, p.companies_with_b], ["salesforce-sales-cloud", "slack", 2, 3, 4]);
  assert.equal(p.share_of_a_pct, 66.7);
  assert.ok(result.coverage.some((c: string) => c.includes("does not show integration, compatibility")));
});

test("upstream data problems are surfaced, not corrected", async () => {
  const [result] = await run("happy");
  assert.deepEqual(result.summary.classification_conflicts, [
    { product_slug: "zendesk", field: "category_slug", values: ["business-applications", "customer-service"] }]);
  assert.equal(result.summary.technologies_without_slug, 1);
});

test("errors are kept and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.tech_intel.error.status, 500);
  assert.equal(rows.e2.status, "listed_incomplete");
  assert.equal(rows.e2.tech_intel.error.kind, "timeout");
  assert.equal(rows.e3.tech_intel.error.kind, "invalid_response");
  assert.equal(rows.e4.tech_intel.error.kind, "insufficient_credits");
  assert.equal(rows.e5.status, "not_processed");
  assert.equal(result.credits.requests_with_uncertain_charge, 2);
  assert.equal(transport.sent.length, 5);
});

test("forbidden means access denied and stops", async () => {
  const [result, transport] = await run("forbidden");
  const rows = byId(result);
  assert.equal(rows.f1.status, "access_denied");
  assert.equal(rows.f1.status_reason, "Firmable returned 403 Forbidden for Tech Intel. This API key c" +
    "annot use this endpoint. The run stops, because later requests would be refused too.");
  assert.equal(rows.f2.status, "not_processed");
  assert.equal(result.errors[0].kind, "forbidden");
  assert.equal(transport.sent.length, 1);
});

test("credit limit stops before the next company", async () => {
  const [result, transport] = await run("budget", { maxCredits: 6 });
  const rows = byId(result);
  assert.equal(rows.b1.status, "listed");
  assert.equal(rows.b2.tech_intel.error.kind, "budget_exceeded");
  assert.equal(rows.b3.status, "not_processed");
  assert.equal(transport.sent.length, 1);
});

test("evidence summary flags missing locations and truncation", async () => {
  const [result, transport] = await run("evidence");
  assert.deepEqual(transport.sent[0].query, { fqdn: "acme.example", withEvidence: "true" });
  const sf = byId(result)["row-1"].technologies[0].evidence;
  assert.equal(sf.records_truncated, true);
  assert.equal(sf.records_without_location, 1);
  assert.deepEqual(byId(result)["row-1"].technologies[1].evidence, { status: "none_returned" });
  assert.equal(result.summary.evidence.records_without_location, 1);
});

test("category filter is applied after retrieval", async () => {
  const [result] = await run("categories");
  assert.deepEqual(result.summary.technologies.map((t: Json) => t.key), ["snowflake", "salesforce-sales-cloud"]);
  assert.equal(result.summary.technologies_set_aside, 2);
});

test("too few answers hides the share", async () => {
  const [result] = await run("defaults");
  const sf = tech(result, "salesforce-sales-cloud").overall;
  assert.equal(sf.observed_share_pct, null);
  assert.ok(sf.text.includes("Too few answers to compare: 3 answered, minimum 5."));
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Bold</b>"));
  assert.match(html, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.ok(html.includes('<script type="application/json" id="explorer-data">'));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("explorer script uses no HTML sinks or network", () => {
  const js = readFileSync(ASSET, "utf-8");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function",
    "fetch(", "XMLHttpRequest", "</script"]) {
    assert.ok(!js.includes(sink), sink);
  }
});

test("plan counts unique companies and pages", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const [call] = plan(rows, cfg);
  assert.equal(call.requests, 16);
  assert.equal(call.toDict().published_estimate_upper_bound, 40);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.max_pages = 26; }, "max_pages must be a whole number from 1 to 25"],
  [(c) => { c.max_pages = true; }, "max_pages must be a whole number"],
  [(c) => { c.min_companies = 0; }, "min_companies must be a whole number from 1 or more"],
  [(c) => { c.min_answered = "5"; }, "min_answered must be a whole number"],
  [(c) => { c.with_evidence = "yes"; }, "with_evidence must be true or false"],
  [(c) => { c.group_by = ""; }, "group_by must be the name of an input column"],
  [(c) => { c.group_by = "row_id"; }, "group_by cannot be row_id"],
  [(c) => { c.categories = ["data", ""]; }, "categories must be a list of category slugs"],
  [(c) => { c.colour = "orange"; }, "Unknown configuration key"],
];
for (const [mutate, message] of bad) {
  test(`invalid config: ${message}`, () => {
    const cfg = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
    mutate(cfg);
    assert.throws(() => loadConfig(cfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 40);
});

test("CLI live needs a limit and a key", async () => {
  const out = tmp();
  const args = ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out];
  assert.equal(await cliMain(RECIPE, [...args, "--live"]), 2);
  delete process.env.FIRMABLE_API_KEY;
  assert.equal(await cliMain(RECIPE, [...args, "--live", "--max-credits", "5"]), 2);
});

test("CLI rejects bad input", async () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "name\nAcme\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});

test("cooccurrence_top limits pairs and is validated", async () => {
  const { loadConfig: lc } = await import("../src/recipe.js");
  assert.equal(lc({}).cooccurrence_top, 40);
  assert.throws(() => lc({ cooccurrence_top: 1 }), ConfigError);
  assert.throws(() => lc({ cooccurrence_top: 201 }), ConfigError);
});
