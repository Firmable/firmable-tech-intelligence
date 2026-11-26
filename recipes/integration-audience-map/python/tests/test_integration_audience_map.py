import csv
import json

import pytest

from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures
from integration_audience_map.recipe import RECIPE, load_config, measure, pct, plan

F = fixtures_dir("integration-audience-map")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def targets(row):
    return {t["target_id"]: t for t in row["targets"]}


def test_happy_path_statuses():
    result, transport = run("happy")
    rows = by_id(result)
    assert [rows[k]["status"] for k in ("h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8")] == [
        "matched", "not_observed_incomplete", "no_data", "matched", "invalid_input", "no_data", "matched", "matched"]
    assert rows["h4"]["duplicate_of"] == "h1"
    assert rows["h8"]["same_company_as"] == "h1"
    assert rows["h6"]["status_reason"] == "Tech Intel has no company for this identifier (404)."
    assert transport.unused() == []
    assert len(transport.sent) == 8          # h4 reuses h1; h5 is never requested


def test_thresholds_keep_below_threshold_matches_separate():
    rows = by_id(run("happy")[0])
    h1 = targets(rows["h1"])
    assert h1["salesforce"]["result"] == "observed"
    assert h1["hubspot"]["result"] == "not_observed"
    assert h1["hubspot"]["below_threshold"][0]["threshold_misses"] == ["confidence low is below medium"]
    assert h1["snowflake"]["below_threshold"][0]["threshold_misses"] == ["recency older is older than 90d"]
    assert targets(rows["h2"])["salesforce"]["result"] == "not_observed_in_pages_retrieved"
    assert "page limit was reached: 6 of 250" in rows["h2"]["status_reason"]


def test_matching_is_exact():
    rows = by_id(run("happy")[0])
    snow = targets(rows["h7"])["snowflake"]
    assert [m["technology"]["product"] for m in snow["matches"]] == ["SNOWFLAKE"]
    assert snow["matches"][0]["match_basis"] == ["product_slug snowflake", "alias of product name SNOWFLAKE"]
    assert all(m["technology"]["product"] != "Snowflake Connector" for m in snow["below_threshold"])


def test_conflicting_data_is_reported_not_corrected():
    rows = by_id(run("happy")[0])
    notes = rows["h7"]["data_notes"]
    assert notes[0] == "The API reported a total of 5 technologies but returned 4 across all pages."
    assert "snowflake appears more than once" in notes[1]
    assert notes[2].startswith("1 technology item(s) have no product name")


def test_measures_count_unique_companies_with_denominators():
    result, _ = run("happy")
    s = result["summary"]
    assert s["unique_companies"] == 5 and s["repeated_rows"] == 2 and s["invalid_rows"] == 1
    sf = s["by_target"]["salesforce"]
    assert (sf["observed"], sf["not_observed"], sf["not_observed_in_pages_retrieved"], sf["no_data"]) == (1, 1, 1, 2)
    assert sf["observed_share"] == {"numerator": 1, "denominator": 2, "percent": 50.0}
    assert sf["unknown_share"] == {"numerator": 1, "denominator": 3, "percent": 33.3}
    assert s["by_target"]["snowflake"]["observed_below_threshold"] == 2
    assert list(s["by_segment"]) == ["Enterprise", "Mid-market", "(no segment)"]
    assert s["by_segment"]["Mid-market"]["audience"]["text"].startswith("Too few answers to compare: 0 answered")


def test_all_rule():
    result, _ = run("all-rule")
    rows = by_id(result)
    assert [rows[f"a{n}"]["status"] for n in range(1, 8)] == [
        "matched", "not_observed", "not_observed", "matched", "not_observed", "not_observed_incomplete", "matched"]
    aud = result["summary"]["audience"]
    assert aud["observed_share"] == {"numerator": 3, "denominator": 6, "percent": 50.0}
    assert aud["text"] == ("Observed at 3 of 6 answered companies in this cohort (50.0%). 1 of 7 companies with data "
                           "had an incomplete list (14.3%) and are not counted as answered.")


def test_errors_are_kept_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["status"] == "error" and rows["e1"]["tech_intel"]["error"]["status"] == 500
    assert rows["e2"]["status"] == "matched" and rows["e2"]["tech_intel"]["error"]["kind"] == "timeout"
    assert rows["e3"]["tech_intel"]["error"]["kind"] == "invalid_response"
    assert rows["e4"]["tech_intel"]["error"]["kind"] == "insufficient_credits"
    assert rows["e5"]["status"] == "not_processed"
    assert result["summary"]["audience"]["not_processed"] == 1
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


def test_budget_stops_before_the_second_company():
    result, transport = run("budget", max_credits=7)
    rows = by_id(result)
    assert rows["b1"]["status"] == "matched"
    assert rows["b2"]["tech_intel"]["error"]["kind"] == "budget_exceeded"
    assert rows["b3"]["status"] == "not_processed"
    assert len(transport.sent) == 1


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Delta</b>" not in html and "&lt;b&gt;Delta&lt;/b&gt;" in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"]
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_pct_and_measure_rules():
    assert pct(1, 3) == 33.3 and pct(2, 3) == 66.7 and pct(1, 8) == 12.5
    m = measure(["observed", "not_observed", "no_data", "error", "not_processed"], 5)
    assert m["companies_in_cohort"] == 5 and m["companies_asked"] == 4 and m["answered"] == 2
    assert m["enough_answers"] is False


def test_plan_counts_pages_per_unique_company():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    call = plan(rows, cfg)[0]
    assert call.requests == 12            # 6 unique valid companies, 2 pages each
    assert call.to_dict()["published_estimate_upper_bound"] == 30.0


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(targets=[]), "targets must be a non-empty list"),
    (lambda c: c["targets"][0].update(vendor_slugs=[]), "needs at least one product slug"),
    (lambda c: c["targets"][0].update(category_slugs=["crm"]), "has unknown key"),
    (lambda c: c["targets"][1].update(id="salesforce"), "used twice"),
    (lambda c: c["targets"][0].update(id="Sales Force"), "lower-case letters"),
    (lambda c: c["targets"][0].update(aliases=[""]), "non-empty text values"),
    (lambda c: c.update(match="most"), "match must be one of: any, all"),
    (lambda c: c.update(min_confidence="certain"), "min_confidence must be one of"),
    (lambda c: c.update(max_recency="7d"), "max_recency must be one of"),
    (lambda c: c.update(max_pages=26), "max_pages must be a whole number from 1 to 25"),
    (lambda c: c.update(min_answered=0), "min_answered must be a whole number of 1 or more"),
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
    assert json.loads((tmp_path / "plan.json").read_text())["requests_upper_bound"] == 12
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
