import csv
import json

import pytest

from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures
from tech_fit_tiers.recipe import RECIPE, condition, load_config, plan

F = fixtures_dir("tech-fit-tiers")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def signals(row):
    return {s["signal_id"]: s for s in row["signals"]}


def test_happy_path_tiers():
    result, transport = run("happy")
    rows = by_id(result)
    got = {k: (r["status"], r["tier_id"]) for k, r in rows.items()}
    assert got == {
        "t1": ("tier_assigned", "tier_1"), "t2": ("tier_assigned", "tier_2"), "t3": ("needs_review", "tier_2"),
        "t4": ("tier_assigned", "tier_2"), "t5": ("no_tier", None), "t6": ("no_data", None),
        "t7": ("tier_assigned", "tier_1"), "t8": ("invalid_input", None), "t9": ("needs_review", None),
    }
    assert rows["t7"]["duplicate_of"] == "t1"
    assert transport.unused() == []
    assert len(transport.sent) == 9


def test_none_condition_needs_a_complete_list():
    rows = by_id(run("happy")[0])
    t3 = rows["t3"]
    assert t3["review_tiers"] == ["tier_1"]
    assert t3["tier_checks"][0] == {"tier_id": "tier_1", "label": "Tier 1", "result": "undetermined",
                                    "conditions": {"all": "yes", "none": "unknown"}}
    assert signals(t3)["legacy_crm"]["result"] == "not_observed_in_pages_retrieved"
    assert "Tier 1 ranks higher and could not be ruled out" in t3["status_reason"]
    assert rows["t9"]["review_tiers"] == ["tier_1", "tier_2", "tier_3"]


def test_legacy_crm_blocks_tier_1():
    rows = by_id(run("happy")[0])
    assert rows["t2"]["tier_checks"][0]["conditions"] == {"all": "yes", "none": "no"}
    assert signals(rows["t2"])["legacy_crm"]["matches"][0]["match_basis"] == ["alias of product name Legacy CRM"]


def test_min_confidence_and_category_matching():
    rows = by_id(run("happy")[0])
    t4 = signals(rows["t4"])
    assert t4["salesforce"]["result"] == "not_observed"
    assert t4["salesforce"]["below_threshold"][0]["threshold_miss"] == "confidence low is below medium"
    assert t4["marketing_automation"]["matches"][0]["match_basis"] == ["category_slug marketing-automation"]
    assert t4["warehouse"]["matches"][0]["match_basis"] == ["alias of product name BIGQUERY"]


def test_evidence_without_source_location_is_flagged():
    rows = by_id(run("happy")[0])
    ev = signals(rows["t1"])["salesforce"]["matches"][0]["evidence"]
    assert ev["status"] == "returned" and ev["records_without_location"] == 2
    assert ev["notes"] == ["2 evidence record(s) have no source location.", "3 of 40 evidence record(s) are listed.",
                           "The source reported more evidence than it sent for: job_ad. Those counts are minimums."]
    assert ev["records"][1]["location"] == ""


def test_no_evidence_mode():
    result, transport = run("no-evidence")
    m = signals(result["rows"][0])["salesforce"]["matches"][0]
    assert m["evidence"] == {"status": "not_requested"}
    assert transport.sent[0].query == {"fqdn": "acme.example"}


def test_summary_counts():
    s = run("happy")[0]["summary"]
    assert s["tier_counts"] == {"tier_1": 2, "tier_2": 2, "tier_3": 0}
    assert s["needs_review_candidate_counts"] == {"tier_1": 0, "tier_2": 1, "tier_3": 0}
    assert s["status_counts"]["needs_review"] == 2


def test_errors_are_kept_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["tech_intel"]["error"]["status"] == 503
    assert rows["e2"]["tech_intel"]["error"]["kind"] == "timeout"
    assert rows["e3"]["tech_intel"]["error"]["kind"] == "invalid_response"
    assert rows["e4"]["tech_intel"]["error"]["kind"] == "insufficient_credits"
    assert rows["e5"]["status"] == "not_processed"
    assert result["credits"]["requests_with_uncertain_charge"] == 3
    assert len(transport.sent) == 4


def test_forbidden_means_access_denied_and_stops():
    result, transport = run("forbidden")
    rows = by_id(result)
    assert rows["f1"]["status"] == "access_denied"
    assert rows["f1"]["status_reason"] == ("Firmable returned 403 Forbidden for Tech Intel. This API key c"
                                           "annot use this endpoint. The run stops, because later requests would be refused too.")
    assert rows["f2"]["status"] == "not_processed"
    assert result["errors"][0]["kind"] == "forbidden"
    assert len(transport.sent) == 1


def test_budget_stops_before_the_second_company():
    result, transport = run("budget", max_credits=7)
    rows = by_id(result)
    assert rows["b1"]["status"] == "tier_assigned"
    assert rows["b2"]["tech_intel"]["error"]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 1


def test_condition_rules():
    r = {"a": "observed", "b": "not_observed", "c": "not_observed_in_pages_retrieved"}
    assert condition("all", ["a", "c"], r) == "unknown" and condition("all", ["a", "b"], r) == "no"
    assert condition("any", ["b", "c"], r) == "unknown" and condition("any", ["b"], r) == "no"
    assert condition("none", ["b"], r) == "yes" and condition("none", ["c"], r) == "unknown"
    assert condition("none", ["a", "c"], r) == "no" and condition("any", [], r) == "yes"


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == [f"t{n}" for n in range(1, 10)]
    assert rows[2]["review_tiers"] == "tier_1"
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()
    assert "no source location" in (tmp_path / "report.html").read_text()


def test_plan_counts_evidence_pages():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    call = plan(RECIPE.read_input(F / "happy.input.csv"), cfg)[0]
    assert call.requests == 14           # 7 unique valid companies, 2 pages each
    assert call.to_dict()["published_estimate_upper_bound"] == 37.8


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(signals=[]), "signals must be a non-empty list"),
    (lambda c: c.update(tiers=[]), "tiers must be a non-empty list"),
    (lambda c: c["signals"][0].update(vendor_slugs=[]), "needs at least one product slug"),
    (lambda c: c["signals"][0].update(min_confidence="sure"), "min_confidence must be one of"),
    (lambda c: c["signals"][1].update(id="salesforce"), "used twice"),
    (lambda c: c["tiers"][0]["when"].update(all=["nope"]), "names unknown signal"),
    (lambda c: c["tiers"][0]["when"].update(none=["salesforce"]), "in none and in all or any"),
    (lambda c: c["tiers"][0].update(when={}), "needs at least one signal"),
    (lambda c: c["tiers"][0]["when"].update(maybe=["salesforce"]), "when has unknown key"),
    (lambda c: c.update(max_pages=0), "max_pages must be a whole number"),
    (lambda c: c.update(with_evidence="yes"), "with_evidence must be true or false"),
    (lambda c: c.update(colour="orange"), "Unknown configuration key"),
])
def test_invalid_config(mutate, message):
    cfg = json.loads((F / "config.json").read_text())
    mutate(cfg)
    with pytest.raises(ConfigError, match=message):
        load_config(cfg)


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 37.8
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name\nAcme\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
