import csv
import json

import pytest

from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures
from stack_talk_tracks.recipe import RECIPE, fill, load_config, md, plan

F = fixtures_dir("stack-talk-tracks")


def run(name, max_credits=100.0, out=None):
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv", config_path=F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def test_happy_path_statuses():
    result, transport = run("happy")
    rows = by_id(result)
    assert {k: r["status"] for k, r in rows.items()} == {
        "s1": "tracks_suggested", "s2": "tracks_skipped", "s3": "no_track_matched_incomplete",
        "s4": "no_track_matched", "s5": "tracks_suggested", "s6": "no_data", "s7": "tracks_suggested",
        "s8": "invalid_input"}
    assert rows["s7"]["duplicate_of"] == "s1"
    assert transport.unused() == []
    assert len(transport.sent) == 7


def test_templates_are_filled_from_the_matched_item():
    rows = by_id(run("happy")[0])
    s1 = rows["s1"]["suggestions"]
    assert [s["track_id"] for s in s1] == ["crm_sync", "warehouse", "warehouse"]   # max_items_per_track is 2
    assert s1[0]["text"] == ("Acme *Example* runs Salesforce Sales Cloud from Salesforce. Ask how they keep it in "
                             "sync with the rest of their stack.")
    assert s1[0]["label_note"] == "Suggested, not a fact"
    assert s1[1]["fact"]["product"] == "Snowflake" and s1[1]["fact"]["confidence"] == "medium"
    assert s1[1]["fact"]["match_basis"] == ["category_slug data-warehousing"]


def test_missing_placeholder_skips_the_track():
    rows = by_id(run("happy")[0])
    assert rows["s2"]["suggestions"] == []
    assert [s["missing_placeholders"] for s in rows["s2"]["skipped"]] == [["company_name"], ["company_name"]]
    assert rows["s5"]["skipped"][0]["reason"] == "No value for: last_observed."


def test_below_threshold_match_is_not_used():
    rows = by_id(run("happy")[0])
    assert rows["s4"]["below_threshold"][0]["threshold_miss"] == "confidence low is below medium"
    assert rows["s4"]["suggestions"] == []


def test_markdown_is_escaped_and_labelled(tmp_path):
    run("happy", out=tmp_path)
    text = (tmp_path / "talk-tracks.md").read_text()
    assert text.count("> **Suggested, not a fact**") == 7
    assert "## \\# Epsilon \\| Example (row s5)" in text
    assert "runs Sales\\|Cloud Plus \\*beta\\* from Salesforce" in text
    assert "Technology fact: Snowflake by Snowflake, category Data Warehousing. Confidence medium" in text
    assert "- Warehouse reporting for Data\\_Lake \\[x\\]: No value for: last\\_observed." in text


def test_md_and_fill_helpers():
    assert md("# a_b|c\nd") == "\\# a\\_b\\|c d"
    assert md("<x> `y` [z] \\") == "\\<x\\> \\`y\\` \\[z\\] \\\\"
    assert fill("{product} at {company_name}", {"product": "P", "company_name": "C"}) == "P at C"


def test_errors_are_kept_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["status"] == "error"
    assert rows["e2"]["status"] == "tracks_suggested" and rows["e2"]["tech_intel"]["error"]["kind"] == "timeout"
    assert rows["e3"]["tech_intel"]["error"]["kind"] == "invalid_response"
    assert rows["e5"]["status"] == "not_processed"
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
    assert by_id(result)["b2"]["tech_intel"]["error"]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 1


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert 'class="template"' in html and "Acme *Example*" in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert rows[0]["suggestions"].startswith("crm_sync (Suggested, not a fact): Acme *Example* runs")
    assert rows[4]["company_name"] == "# Epsilon | Example"
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_plan_counts_pages_per_unique_company():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    call = plan(RECIPE.read_input(F / "happy.input.csv"), cfg)[0]
    assert call.requests == 12 and call.to_dict()["published_estimate_upper_bound"] == 30.0


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(tracks=[]), "tracks must be a non-empty list"),
    (lambda c: c.update(tracks=c["tracks"] * 7), "at most 20"),
    (lambda c: c["tracks"][0].update(template="{company} uses {product}"), "unknown placeholder {company}"),
    (lambda c: c["tracks"][0].update(template="Hello {product"), "brace that is not part of a placeholder"),
    (lambda c: c["tracks"][0].update(template=" "), "template must be text"),
    (lambda c: c["tracks"][0].update(when={}), "needs at least one product slug"),
    (lambda c: c["tracks"][0]["when"].update(min_confidence="very"), "min_confidence must be one of"),
    (lambda c: c["tracks"][0]["when"].update(id="x"), "when has unknown key"),
    (lambda c: c["tracks"][1].update(id="crm_sync"), "used twice"),
    (lambda c: c.update(max_items_per_track=6), "max_items_per_track must be a whole number from 1 to 5"),
    (lambda c: c.update(max_pages=0), "max_pages must be a whole number"),
    (lambda c: c.update(colour="orange"), "Unknown configuration key"),
])
def test_invalid_config(mutate, message):
    cfg = json.loads((F / "config.json").read_text())
    mutate(cfg)
    with pytest.raises(ConfigError, match=message.replace("{", r"\{").replace("}", r"\}")):
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
