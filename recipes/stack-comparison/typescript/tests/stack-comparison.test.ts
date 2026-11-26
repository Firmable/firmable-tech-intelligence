import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, InputError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, mdEscape, plan } from "../src/recipe.js";

const F = fixturesDir("stack-comparison");
const tmp = () => mkdtempSync(join(tmpdir(), "stack-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const techs = (result: Json): Record<string, Json> => Object.fromEntries(result.summary.technologies.map((t: Json) => [t.key, t]));

test("happy path statuses and calls", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => rows[`s${i}`].status), [
    "listed", "listed", "listed_incomplete", "listed", "listed", "company_not_found", "no_technology_data"]);
  assert.equal(rows.s5.duplicate_of, "s1");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.length, 7);
});

test("matrix keeps the four cell values distinct", async () => {
  const [result] = await run("happy");
  assert.deepEqual(techs(result)["salesforce-sales-cloud"].cells, {
    s1: "observed", s2: "observed", s3: "not_observed_in_pages_retrieved", s4: "observed", s6: "no_data", s7: "no_data" });
  assert.equal(techs(result).zendesk.cells.s2, "not_observed");
});

test("shared and unique lists", async () => {
  const [result] = await run("happy");
  const s = result.summary;
  assert.deepEqual(s.shared_by_all, ["slack"]);
  assert.deepEqual(s.shared_by_some.map((x: Json) => x.key), ["salesforce-sales-cloud"]);
  const unique = Object.fromEntries(s.unique_to_one.map((u: Json) => [u.key, u]));
  assert.deepEqual(Object.keys(unique).sort(), ["bold-crm", "hubspot-crm", "snowflake", "zendesk"]);
  assert.equal(unique.snowflake.confirmed, true);
  assert.equal(unique.zendesk.confirmed, false);
});

test("strongest item is shown for a repeated product", async () => {
  const [result] = await run("happy");
  const slack = byId(result).s4.technologies.find((x: Json) => x.key === "slack");
  assert.equal(slack.confidence, "high");
  assert.equal(slack.last_observed, "2026-11-20");
});

test("category level", async () => {
  const [result] = await run("category");
  const s = result.summary;
  assert.deepEqual(s.shared_by_all, ["collaboration"]);
  assert.equal(techs(result).collaboration.vendor, null);
  assert.deepEqual(byId(result)["row-1"].technologies[0].products, ["slack"]);
  assert.deepEqual(s.unique_to_one.map((u: Json) => u.key), ["business-applications", "data"]);
});

test("one company with data compares nothing", async () => {
  const [result] = await run("one-with-data");
  assert.equal(byId(result).o2.same_company_as, "o1");
  assert.deepEqual(result.summary.shared_by_all, []);
  assert.equal(techs(result)["salesforce-sales-cloud"].sharing, "not_compared");
});

test("errors are kept and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.tech_intel.error.status, 500);
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
  assert.equal(byId(result).b2.tech_intel.error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 1);
});

test("evidence summary", async () => {
  const [result] = await run("evidence");
  const ev = byId(result)["row-1"].technologies[0].evidence;
  assert.equal(ev.records_without_location, 1);
  assert.equal(ev.records_truncated, true);
  assert.equal(result.summary.evidence_records_without_location, 1);
});

test("markdown is escaped and complete", async () => {
  const out = tmp();
  await run("happy", { out });
  const md = readFileSync(join(out, "comparison.md"), "utf-8");
  assert.ok(md.includes("| \\#1 Beta \\| Pty | s2 | listed |"));
  assert.ok(md.includes("\\<b\\>Bold\\</b\\> \\*CRM\\* \\| \\[x\\] (bold-crm)"));
  assert.ok(!md.includes("<b>"));
});

test("mdEscape", () => {
  assert.equal(mdEscape("# a_b|c\nd"), "\\# a\\_b\\|c d");
  assert.equal(mdEscape(null), "");
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  assert.ok(!readFileSync(join(out, "report.html"), "utf-8").includes("<b>Bold</b>"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("input needs 2 to 20 rows", () => {
  const d = tmp();
  writeFileSync(join(d, "one.csv"), "domain\nacme.example\n");
  assert.throws(() => RECIPE.readInput(join(d, "one.csv")), (e: Error) => e instanceof InputError && e.message.includes("not 1"));
  writeFileSync(join(d, "many.csv"), "domain\n" + Array.from({ length: 21 }, (_, i) => `c${i}.example\n`).join(""));
  assert.throws(() => RECIPE.readInput(join(d, "many.csv")), (e: Error) => e instanceof InputError && e.message.includes("not 21"));
});

test("plan counts unique companies and pages", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const [call] = plan(RECIPE.readInput(join(F, "happy.input.csv")), cfg);
  assert.equal(call.requests, 12);
  assert.equal(call.toDict().published_estimate_upper_bound, 30);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.max_pages = 0; }, "max_pages must be a whole number from 1 to 25"],
  [(c) => { c.max_pages = 2.5; }, "max_pages must be a whole number"],
  [(c) => { c.with_evidence = 1; }, "with_evidence must be true or false"],
  [(c) => { c.level = "vendor"; }, "level must be product or category"],
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
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 30);
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
  writeFileSync(join(d, "in.csv"), "name\nAcme\nBeta\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
