import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, measure, pct, plan } from "../src/recipe.js";

const F = fixturesDir("integration-audience-map");
const tmp = () => mkdtempSync(join(tmpdir(), "iam-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const targets = (row: Json): Record<string, Json> => Object.fromEntries(row.targets.map((t: Json) => [t.target_id, t]));

test("happy path statuses", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"].map((k) => rows[k].status), [
    "matched", "not_observed_incomplete", "no_data", "matched", "invalid_input", "no_data", "matched", "matched"]);
  assert.equal(rows.h4.duplicate_of, "h1");
  assert.equal(rows.h8.same_company_as, "h1");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.length, 8);
});

test("thresholds keep below-threshold matches separate", async () => {
  const rows = byId((await run("happy"))[0]);
  const h1 = targets(rows.h1);
  assert.equal(h1.salesforce.result, "observed");
  assert.equal(h1.hubspot.result, "not_observed");
  assert.deepEqual(h1.hubspot.below_threshold[0].threshold_misses, ["confidence low is below medium"]);
  assert.deepEqual(h1.snowflake.below_threshold[0].threshold_misses, ["recency older is older than 90d"]);
  assert.equal(targets(rows.h2).salesforce.result, "not_observed_in_pages_retrieved");
});

test("matching is exact", async () => {
  const rows = byId((await run("happy"))[0]);
  const snow = targets(rows.h7).snowflake;
  assert.deepEqual(snow.matches.map((m: Json) => m.technology.product), ["SNOWFLAKE"]);
  assert.deepEqual(snow.matches[0].match_basis, ["product_slug snowflake", "alias of product name SNOWFLAKE"]);
});

test("conflicting data is reported, not corrected", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.equal(rows.h7.data_notes[0], "The API reported a total of 5 technologies but returned 4 across all pages.");
  assert.ok(rows.h7.data_notes[1].includes("snowflake appears more than once"));
});

test("measures count unique companies with denominators", async () => {
  const s = (await run("happy"))[0].summary;
  assert.equal(s.unique_companies, 5);
  assert.deepEqual(s.by_target.salesforce.observed_share, { numerator: 1, denominator: 2, percent: 50 });
  assert.deepEqual(s.by_target.salesforce.unknown_share, { numerator: 1, denominator: 3, percent: 33.3 });
  assert.deepEqual(Object.keys(s.by_segment), ["Enterprise", "Mid-market", "(no segment)"]);
  assert.ok(s.by_segment["Mid-market"].audience.text.startsWith("Too few answers to compare: 0 answered"));
});

test("all rule", async () => {
  const [result] = await run("all-rule");
  const rows = byId(result);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => rows[`a${n}`].status), [
    "matched", "not_observed", "not_observed", "matched", "not_observed", "not_observed_incomplete", "matched"]);
  assert.deepEqual(result.summary.audience.observed_share, { numerator: 3, denominator: 6, percent: 50 });
});

test("errors are kept and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.tech_intel.error.status, 500);
  assert.equal(rows.e2.tech_intel.error.kind, "timeout");
  assert.equal(rows.e3.tech_intel.error.kind, "invalid_response");
  assert.equal(rows.e4.tech_intel.error.kind, "insufficient_credits");
  assert.equal(rows.e5.status, "not_processed");
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

test("budget stops before the second company", async () => {
  const [result, transport] = await run("budget", { maxCredits: 7 });
  const rows = byId(result);
  assert.equal(rows.b2.tech_intel.error.kind, "budget_exceeded");
  assert.equal(rows.b3.status, "not_processed");
  assert.equal(transport.sent.length, 1);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Delta</b>"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("pct and measure rules", () => {
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(2, 3), 66.7);
  assert.equal(pct(1, 8), 12.5);
  const m = measure(["observed", "not_observed", "no_data", "error", "not_processed"], 5);
  assert.equal(m.companies_asked, 4);
  assert.equal(m.enough_answers, false);
});

test("plan counts pages per unique company", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const call = plan(RECIPE.readInput(join(F, "happy.input.csv")), cfg)[0];
  assert.equal(call.requests, 12);
  assert.equal(call.toDict().published_estimate_upper_bound, 30);
});

const mutations: [(c: Json) => void, string][] = [
  [(c) => { c.targets = []; }, "targets must be a non-empty list"],
  [(c) => { c.targets[0].vendor_slugs = []; }, "needs at least one product slug"],
  [(c) => { c.targets[0].category_slugs = ["crm"]; }, "has unknown key"],
  [(c) => { c.targets[1].id = "salesforce"; }, "used twice"],
  [(c) => { c.targets[0].aliases = [""]; }, "non-empty text values"],
  [(c) => { c.match = "most"; }, "match must be one of: any, all"],
  [(c) => { c.min_confidence = "certain"; }, "min_confidence must be one of"],
  [(c) => { c.max_recency = "7d"; }, "max_recency must be one of"],
  [(c) => { c.max_pages = 26; }, "max_pages must be a whole number from 1 to 25"],
  [(c) => { c.min_answered = 0; }, "min_answered must be a whole number of 1 or more"],
  [(c) => { c.colour = "orange"; }, "Unknown configuration key"],
];
for (const [mutate, message] of mutations) {
  test(`invalid config: ${message}`, () => {
    const cfg = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
    mutate(cfg);
    assert.throws(() => loadConfig(cfg), (e: unknown) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("cli plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).requests_upper_bound, 12);
});

test("cli live needs a limit and a key", async () => {
  const args = ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", tmp()];
  assert.equal(await cliMain(RECIPE, [...args, "--live"]), 2);
  delete process.env.FIRMABLE_API_KEY;
  assert.equal(await cliMain(RECIPE, [...args, "--live", "--max-credits", "5"]), 2);
});

test("cli rejects bad input", async () => {
  const dir = tmp();
  const bad = join(dir, "in.csv");
  writeFileSync(bad, "name\nAcme\n");
  assert.equal(await cliMain(RECIPE, ["--input", bad, "--config", join(F, "config.json"), "--out", dir]), 2);
});
