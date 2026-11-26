import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, condition, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("tech-fit-tiers");
const tmp = () => mkdtempSync(join(tmpdir(), "tft-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const signals = (row: Json): Record<string, Json> => Object.fromEntries(row.signals.map((s: Json) => [s.signal_id, s]));

test("happy path tiers", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  const got = Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, [r.status, r.tier_id]]));
  assert.deepEqual(got, {
    t1: ["tier_assigned", "tier_1"], t2: ["tier_assigned", "tier_2"], t3: ["needs_review", "tier_2"],
    t4: ["tier_assigned", "tier_2"], t5: ["no_tier", null], t6: ["no_data", null],
    t7: ["tier_assigned", "tier_1"], t8: ["invalid_input", null], t9: ["needs_review", null],
  });
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.length, 9);
});

test("none condition needs a complete list", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.deepEqual(rows.t3.review_tiers, ["tier_1"]);
  assert.deepEqual(rows.t3.tier_checks[0].conditions, { all: "yes", none: "unknown" });
  assert.deepEqual(rows.t9.review_tiers, ["tier_1", "tier_2", "tier_3"]);
});

test("min confidence and category matching", async () => {
  const t4 = signals(byId((await run("happy"))[0]).t4);
  assert.equal(t4.salesforce.result, "not_observed");
  assert.equal(t4.salesforce.below_threshold[0].threshold_miss, "confidence low is below medium");
  assert.deepEqual(t4.marketing_automation.matches[0].match_basis, ["category_slug marketing-automation"]);
  assert.deepEqual(t4.warehouse.matches[0].match_basis, ["alias of product name BIGQUERY"]);
});

test("evidence without source location is flagged", async () => {
  const ev = signals(byId((await run("happy"))[0]).t1).salesforce.matches[0].evidence;
  assert.equal(ev.records_without_location, 2);
  assert.deepEqual(ev.notes, ["2 evidence record(s) have no source location.", "3 of 40 evidence record(s) are listed.",
    "The source reported more evidence than it sent for: job_ad. Those counts are minimums."]);
});

test("no evidence mode", async () => {
  const [result, transport] = await run("no-evidence");
  assert.deepEqual(signals(result.rows[0]).salesforce.matches[0].evidence, { status: "not_requested" });
  assert.deepEqual(transport.sent[0].query, { fqdn: "acme.example" });
});

test("summary counts", async () => {
  const s = (await run("happy"))[0].summary;
  assert.deepEqual(s.tier_counts, { tier_1: 2, tier_2: 2, tier_3: 0 });
  assert.deepEqual(s.needs_review_candidate_counts, { tier_1: 0, tier_2: 1, tier_3: 0 });
});

test("errors are kept and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.tech_intel.error.status, 503);
  assert.equal(rows.e2.tech_intel.error.kind, "timeout");
  assert.equal(rows.e3.tech_intel.error.kind, "invalid_response");
  assert.equal(rows.e5.status, "not_processed");
  assert.equal(result.credits.requests_with_uncertain_charge, 3);
  assert.equal(transport.sent.length, 4);
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
  assert.equal(byId(result).b2.tech_intel.error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 1);
});

test("condition rules", () => {
  const r = { a: "observed", b: "not_observed", c: "not_observed_in_pages_retrieved" };
  assert.equal(condition("all", ["a", "c"], r), "unknown");
  assert.equal(condition("all", ["a", "b"], r), "no");
  assert.equal(condition("any", ["b", "c"], r), "unknown");
  assert.equal(condition("none", ["b"], r), "yes");
  assert.equal(condition("none", ["c"], r), "unknown");
  assert.equal(condition("none", ["a", "c"], r), "no");
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
  assert.ok(readFileSync(join(out, "report.html"), "utf-8").includes("no source location"));
});

test("plan counts evidence pages", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const call = plan(RECIPE.readInput(join(F, "happy.input.csv")), cfg)[0];
  assert.equal(call.requests, 14);
  assert.equal(call.toDict().published_estimate_upper_bound, 37.8);
});

const mutations: [(c: Json) => void, string][] = [
  [(c) => { c.signals = []; }, "signals must be a non-empty list"],
  [(c) => { c.tiers = []; }, "tiers must be a non-empty list"],
  [(c) => { c.signals[0].vendor_slugs = []; }, "needs at least one product slug"],
  [(c) => { c.signals[0].min_confidence = "toString"; }, "min_confidence must be one of"],
  [(c) => { c.signals[1].id = "salesforce"; }, "used twice"],
  [(c) => { c.tiers[0].when.all = ["nope"]; }, "names unknown signal"],
  [(c) => { c.tiers[0].when.none = ["salesforce"]; }, "in none and in all or any"],
  [(c) => { c.tiers[0].when = {}; }, "needs at least one signal"],
  [(c) => { c.tiers[0].when.maybe = ["salesforce"]; }, "when has unknown key"],
  [(c) => { c.max_pages = 0; }, "max_pages must be a whole number"],
  [(c) => { c.with_evidence = "yes"; }, "with_evidence must be true or false"],
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
  assert.equal(await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]), 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 37.8);
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
