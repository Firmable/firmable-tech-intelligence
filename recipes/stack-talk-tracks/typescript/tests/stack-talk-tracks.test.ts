import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, fill, loadConfig, md, plan } from "../src/recipe.js";

const F = fixturesDir("stack-talk-tracks");
const tmp = () => mkdtempSync(join(tmpdir(), "stt-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));

test("happy path statuses", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.status])), {
    s1: "tracks_suggested", s2: "tracks_skipped", s3: "no_track_matched_incomplete", s4: "no_track_matched",
    s5: "tracks_suggested", s6: "no_data", s7: "tracks_suggested", s8: "invalid_input" });
  assert.equal(rows.s7.duplicate_of, "s1");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.length, 7);
});

test("templates are filled from the matched item", async () => {
  const s1 = byId((await run("happy"))[0]).s1.suggestions;
  assert.deepEqual(s1.map((s: Json) => s.track_id), ["crm_sync", "warehouse", "warehouse"]);
  assert.equal(s1[0].text, "Acme *Example* runs Salesforce Sales Cloud from Salesforce. Ask how they keep it in " +
    "sync with the rest of their stack.");
  assert.equal(s1[0].label_note, "Suggested, not a fact");
  assert.deepEqual(s1[1].fact.match_basis, ["category_slug data-warehousing"]);
});

test("missing placeholder skips the track", async () => {
  const rows = byId((await run("happy"))[0]);
  assert.deepEqual(rows.s2.skipped.map((s: Json) => s.missing_placeholders), [["company_name"], ["company_name"]]);
  assert.equal(rows.s5.skipped[0].reason, "No value for: last_observed.");
});

test("below-threshold match is not used", async () => {
  const s4 = byId((await run("happy"))[0]).s4;
  assert.equal(s4.below_threshold[0].threshold_miss, "confidence low is below medium");
  assert.deepEqual(s4.suggestions, []);
});

test("markdown is escaped and labelled", async () => {
  const out = tmp();
  await run("happy", { out });
  const text = readFileSync(join(out, "talk-tracks.md"), "utf-8");
  assert.equal(text.split("> **Suggested, not a fact**").length - 1, 7);
  assert.ok(text.includes("## \\# Epsilon \\| Example (row s5)"));
  assert.ok(text.includes("runs Sales\\|Cloud Plus \\*beta\\* from Salesforce"));
  assert.ok(text.includes("- Warehouse reporting for Data\\_Lake \\[x\\]: No value for: last\\_observed."));
});

test("md and fill helpers", () => {
  assert.equal(md("# a_b|c\nd"), "\\# a\\_b\\|c d");
  assert.equal(md("<x> `y` [z] \\"), "\\<x\\> \\`y\\` \\[z\\] \\\\");
  assert.equal(fill("{product} at {company_name}", { product: "P", company_name: "C" }), "P at C");
});

test("errors are kept and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.status, "error");
  assert.equal(rows.e2.tech_intel.error.kind, "timeout");
  assert.equal(rows.e3.tech_intel.error.kind, "invalid_response");
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
  assert.equal(byId(result).b2.tech_intel.error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 1);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  assert.ok(readFileSync(join(out, "report.html"), "utf-8").includes('class="template"'));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("plan counts pages per unique company", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const call = plan(RECIPE.readInput(join(F, "happy.input.csv")), cfg)[0];
  assert.equal(call.requests, 12);
  assert.equal(call.toDict().published_estimate_upper_bound, 30);
});

const mutations: [(c: Json) => void, string][] = [
  [(c) => { c.tracks = []; }, "tracks must be a non-empty list"],
  [(c) => { c.tracks = [...c.tracks, ...c.tracks, ...c.tracks, ...c.tracks, ...c.tracks, ...c.tracks, ...c.tracks]; }, "at most 20"],
  [(c) => { c.tracks[0].template = "{company} uses {product}"; }, "unknown placeholder {company}"],
  [(c) => { c.tracks[0].template = "Hello {product"; }, "brace that is not part of a placeholder"],
  [(c) => { c.tracks[0].template = " "; }, "template must be text"],
  [(c) => { c.tracks[0].when = {}; }, "needs at least one product slug"],
  [(c) => { c.tracks[0].when.min_confidence = "very"; }, "min_confidence must be one of"],
  [(c) => { c.tracks[0].when.id = "x"; }, "when has unknown key"],
  [(c) => { c.tracks[1].id = "crm_sync"; }, "used twice"],
  [(c) => { c.max_items_per_track = 6; }, "max_items_per_track must be a whole number from 1 to 5"],
  [(c) => { c.max_pages = 0; }, "max_pages must be a whole number"],
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
