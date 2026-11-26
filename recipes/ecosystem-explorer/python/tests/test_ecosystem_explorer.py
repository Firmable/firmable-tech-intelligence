import csv
import json
import re

import pytest

from ecosystem_explorer.recipe import ASSET, RECIPE, load_config, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("ecosystem-explorer")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    inp = F / f"{name}.input.csv"
    return run_with_fixtures(RECIPE, input_path=inp, config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def tech(result, key):
    return next(t for t in result["summary"]["technologies"] if t["key"] == key)


def test_happy_path_statuses_and_calls():
    result, transport = run("happy")
    rows = by_id(result)
    assert [rows[f"h{i}"]["status"] for i in range(1, 11)] == [
        "listed", "listed", "no_technology_data", "listed_incomplete", "listed", "listed", "invalid_input",
        "company_not_found", "listed", "listed"]
    assert transport.unused() == []
    # The duplicate domain (h6) is not requested again: 10 requests for 8 unique valid identifiers.
    assert len(transport.sent) == 10
    assert transport.sent[6].query == {"id": "f900000000005"}
    assert "page limit was reached: 3 of 40" in rows["h4"]["status_reason"]
    assert rows["h10"]["status_reason"] == "The complete list was retrieved: 1 technology in 1 page(s)."


def test_duplicates_and_same_company_are_counted_once():
    result, _ = run("happy")
    rows = by_id(result)
    assert rows["h6"]["duplicate_of"] == "h1"
    assert rows["h9"]["same_company_as"] == "h5"
    c = result["summary"]["cohort"]
    assert (c["input_rows"], c["cohort_companies"], c["companies_with_data"], c["no_data"], c["not_found"]) == (10, 7, 5, 1, 1)
    assert (c["duplicate_rows"], c["same_company_rows"], c["invalid_input_rows"], c["incomplete_lists"]) == (1, 1, 1, 1)
    assert tech(result, "zendesk")["observed_row_ids"] == ["h1", "h4", "h5"]


def test_measures_state_denominators_and_keep_unknown_separate():
    result, _ = run("happy")
    slack = tech(result, "slack")["overall"]
    assert (slack["observed"], slack["not_observed"], slack["not_observed_in_pages_retrieved"]) == (4, 1, 0)
    assert slack["observed_share_pct"] == 80.0 and slack["answered"] == 5
    sf = tech(result, "salesforce-sales-cloud")["overall"]
    # Delta's list is incomplete, so Salesforce there is unknown, not "not observed".
    assert (sf["observed"], sf["not_observed"], sf["not_observed_in_pages_retrieved"]) == (3, 1, 1)
    assert sf["observed_share_pct"] == 75.0 and sf["unknown_share_pct"] == 20.0
    assert sf["text"].startswith("Observed in 3 of 5 companies with data in this cohort.")
    assert "75.0% (3 of 4" in sf["text"] and "for 1 of 5 (20.0%)" in sf["text"]
    assert [t["key"] for t in result["summary"]["technologies"]][:3] == ["slack", "salesforce-sales-cloud", "zendesk"]


def test_groups_have_their_own_denominators():
    result, _ = run("happy")
    s = result["summary"]
    assert s["groups"] == ["fintech", "retail", "(no value)"]
    assert s["group_cohorts"][0] == {"group": "fintech", "cohort_companies": 3, "companies_asked": 3,
                                     "companies_with_data": 2, "no_data": 0, "not_found": 1, "error": 0,
                                     "not_processed": 0}
    fin = tech(result, "slack")["by_group"]["fintech"]
    assert (fin["observed"], fin["companies_with_data"], fin["observed_share_pct"]) == (2, 2, 100.0)
    ret = tech(result, "hubspot-crm")["by_group"]["retail"]
    assert ret["observed"] == 0 and ret["enough_answers"] is False
    assert s["group_conflicts"] == 1
    assert any("different segment value" in c for c in result["coverage"])


def test_strongest_item_is_kept_for_a_repeated_product():
    result, _ = run("happy")
    slack = next(t for t in by_id(result)["h1"]["technologies"] if t["key"] == "slack")
    assert slack["confidence"] == "high" and slack["items_returned"] == 2
    assert tech(result, "salesforce-sales-cloud")["by_confidence"] == {"high": 2, "medium": 1}


def test_cooccurrence_has_denominators_and_a_fixed_note():
    result, _ = run("happy")
    co = result["summary"]["cooccurrence"]
    assert co["listed"] == ["salesforce-sales-cloud", "slack", "zendesk"]
    pair = co["pairs"][0]
    assert (pair["a"], pair["b"], pair["both"], pair["companies_with_a"], pair["companies_with_b"]) == (
        "salesforce-sales-cloud", "slack", 2, 3, 4)
    assert pair["share_of_a_pct"] == 66.7 and pair["share_of_b_pct"] == 50.0
    assert "bold-crm" not in co["listed"]
    assert any("does not show integration, compatibility" in c for c in result["coverage"])


def test_upstream_data_problems_are_surfaced_not_corrected():
    result, _ = run("happy")
    s = result["summary"]
    assert s["classification_conflicts"] == [{"product_slug": "zendesk", "field": "category_slug",
                                              "values": ["business-applications", "customer-service"]}]
    assert tech(result, "zendesk")["category_slug"] == "business-applications"
    assert s["technologies_without_slug"] == 1
    assert any("have no product_slug" in c for c in result["coverage"])
    assert any("does not correct upstream data" in c for c in result["coverage"])


def test_errors_are_kept_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["status"] == "error" and rows["e1"]["tech_intel"]["error"]["status"] == 500
    assert rows["e2"]["status"] == "listed_incomplete" and rows["e2"]["tech_intel"]["error"]["kind"] == "timeout"
    assert rows["e3"]["tech_intel"]["error"]["kind"] == "invalid_response"
    assert rows["e4"]["tech_intel"]["error"]["kind"] == "insufficient_credits"
    assert rows["e5"]["status"] == "not_processed" and rows["e5"]["technologies"] == []
    assert result["summary"]["cohort"]["not_processed"] == 1
    assert result["credits"]["requests_with_uncertain_charge"] == 2
    assert result["coverage"][0].startswith("The run stopped early")
    assert len(transport.sent) == 5


def test_forbidden_means_access_denied_and_stops():
    result, transport = run("forbidden")
    rows = by_id(result)
    assert rows["f1"]["status"] == "access_denied"
    assert rows["f1"]["status_reason"] == ("Firmable returned 403 Forbidden for Tech Intel. This API key c"
                                           "annot use this endpoint. The run stops, because later requests would be refused too.")
    assert rows["f2"]["status"] == "not_processed"
    assert result["errors"][0]["kind"] == "forbidden"
    assert len(transport.sent) == 1


def test_credit_limit_stops_before_the_next_company():
    result, transport = run("budget", max_credits=6)
    rows = by_id(result)
    assert rows["b1"]["status"] == "listed"
    assert rows["b2"]["tech_intel"]["error"]["kind"] == "budget_exceeded"
    assert rows["b3"]["status"] == "not_processed"
    assert len(transport.sent) == 1


def test_evidence_summary_flags_missing_locations_and_truncation():
    result, transport = run("evidence")
    assert transport.sent[0].query == {"fqdn": "acme.example", "withEvidence": "true"}
    sf = by_id(result)["row-1"]["technologies"][0]["evidence"]
    assert sf["records_listed"] == 2 and sf["evidence_count"] == 30 and sf["records_truncated"] is True
    assert sf["records_without_location"] == 1 and sf["capped_types"] == ["job_ad"]
    assert by_id(result)["row-1"]["technologies"][1]["evidence"] == {"status": "none_returned"}
    assert result["summary"]["evidence"] == {"records_without_location": 1, "technologies_with_truncated_records": 1,
                                             "technologies_without_evidence": 2}
    assert any("have no location" in c for c in result["coverage"])


def test_category_filter_is_applied_after_retrieval():
    result, _ = run("categories")
    assert [t["key"] for t in result["summary"]["technologies"]] == ["snowflake", "salesforce-sales-cloud"]
    assert result["summary"]["technologies_set_aside"] == 2
    assert by_id(result)["row-2"]["technologies_set_aside"] == 1
    assert any("Only technologies in these categories" in c for c in result["coverage"])


def test_too_few_answers_hides_the_share():
    result, _ = run("defaults")
    sf = tech(result, "salesforce-sales-cloud")["overall"]
    assert sf["observed_share_pct"] is None and sf["enough_answers"] is False
    assert "Too few answers to compare: 3 answered, minimum 5." in sf["text"]
    assert result["summary"]["cooccurrence"]["pairs"] == []
    assert "groups" in result["summary"] and result["summary"]["groups"] == []


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Bold</b>" not in html
    assert re.search(r"script-src 'sha256-[A-Za-z0-9+/=]+'", html)
    assert '<script type="application/json" id="explorer-data">' in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == [f"h{i}" for i in range(1, 11)]
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_explorer_script_uses_no_html_sinks_or_network():
    js = ASSET.read_text()
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function",
                 "fetch(", "XMLHttpRequest", "</script"):
        assert sink not in js, sink
    assert "textContent" in js and "createElement" in js


def test_plan_counts_unique_companies_and_pages():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    [call] = plan(rows, cfg)
    assert call.requests == 16                  # 8 unique valid identifiers x 2 pages
    assert call.to_dict()["published_estimate_upper_bound"] == 40.0
    cfg["with_evidence"] = True
    assert plan(rows, cfg)[0].to_dict()["published_estimate_upper_bound"] == 43.2


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(max_pages=26), "max_pages must be a whole number from 1 to 25"),
    (lambda c: c.update(max_pages=True), "max_pages must be a whole number"),
    (lambda c: c.update(min_companies=0), "min_companies must be a whole number from 1 or more"),
    (lambda c: c.update(min_answered="5"), "min_answered must be a whole number"),
    (lambda c: c.update(with_evidence="yes"), "with_evidence must be true or false"),
    (lambda c: c.update(group_by=""), "group_by must be the name of an input column"),
    (lambda c: c.update(group_by="row_id"), "group_by cannot be row_id"),
    (lambda c: c.update(categories=["data", ""]), "categories must be a list of category slugs"),
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
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 40.0
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


def test_cooccurrence_top_limits_pairs_and_is_validated():
    assert load_config({})["cooccurrence_top"] == 40
    with pytest.raises(ConfigError):
        load_config({"cooccurrence_top": 1})
    with pytest.raises(ConfigError):
        load_config({"cooccurrence_top": 201})
