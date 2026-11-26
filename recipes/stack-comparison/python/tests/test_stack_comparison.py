import csv
import json

import pytest

from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError, InputError
from firmable_client.testing import fixtures_dir, run_with_fixtures
from stack_comparison.recipe import RECIPE, load_config, md_escape, plan

F = fixtures_dir("stack-comparison")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def techs(result):
    return {t["key"]: t for t in result["summary"]["technologies"]}


def test_happy_path_statuses_and_calls():
    result, transport = run("happy")
    rows = by_id(result)
    assert [rows[f"s{i}"]["status"] for i in range(1, 8)] == [
        "listed", "listed", "listed_incomplete", "listed", "listed", "company_not_found", "no_technology_data"]
    assert rows["s5"]["duplicate_of"] == "s1"
    assert transport.unused() == [] and len(transport.sent) == 7
    assert transport.sent[4].query == {"id": "f900000000005"}


def test_matrix_keeps_the_four_cell_values_distinct():
    result, _ = run("happy")
    t = techs(result)
    assert t["salesforce-sales-cloud"]["cells"] == {"s1": "observed", "s2": "observed",
                                                    "s3": "not_observed_in_pages_retrieved", "s4": "observed",
                                                    "s6": "no_data", "s7": "no_data"}
    assert t["zendesk"]["cells"]["s2"] == "not_observed"
    assert [c["row_id"] for c in result["summary"]["companies"]] == ["s1", "s2", "s3", "s4", "s6", "s7"]


def test_shared_and_unique_lists():
    result, _ = run("happy")
    s = result["summary"]
    assert s["shared_by_all"] == ["slack"]
    assert [x["key"] for x in s["shared_by_some"]] == ["salesforce-sales-cloud"]
    assert "Not observed in the pages retrieved for 1 company(ies)." in s["shared_by_some"][0]["text"]
    unique = {u["key"]: u for u in s["unique_to_one"]}
    assert set(unique) == {"bold-crm", "hubspot-crm", "snowflake", "zendesk"}
    # Delta's own list is incomplete, but every other company's list is complete, so its unique items are confirmed.
    assert unique["snowflake"]["confirmed"] is True and unique["snowflake"]["row_id"] == "s3"
    # Acme's Zendesk might also be in Delta's unread pages.
    assert unique["zendesk"]["confirmed"] is False
    assert "so it may not be unique" in unique["zendesk"]["text"]


def test_strongest_item_is_shown_for_a_repeated_product():
    result, _ = run("happy")
    slack = next(x for x in by_id(result)["s4"]["technologies"] if x["key"] == "slack")
    assert slack["confidence"] == "high" and slack["last_observed"] == "2026-11-20"
    assert techs(result)["slack"]["details"]["s4"] == {"confidence": "high", "recency": "30d",
                                                        "last_observed": "2026-11-20"}


def test_category_level():
    result, _ = run("category")
    s = result["summary"]
    assert s["level"] == "category"
    assert s["shared_by_all"] == ["collaboration"]
    coll = techs(result)["collaboration"]
    assert coll["label"] == "Collaboration" and coll["vendor"] is None
    row1 = by_id(result)["row-1"]["technologies"][0]
    assert row1["products"] == ["slack"]
    assert [u["key"] for u in s["unique_to_one"]] == ["business-applications", "data"]
    assert any("Compared at category level" in c for c in result["coverage"])


def test_one_company_with_data_compares_nothing():
    result, _ = run("one-with-data")
    s = result["summary"]
    assert by_id(result)["o2"]["same_company_as"] == "o1"
    assert s["counts"]["companies"] == 2 and s["counts"]["companies_with_data"] == 1
    assert s["shared_by_all"] == [] and s["unique_to_one"] == []
    assert techs(result)["salesforce-sales-cloud"]["sharing"] == "not_compared"
    assert any("need at least two companies with data" in c for c in result["coverage"])


def test_errors_are_kept_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["status"] == "error" and rows["e1"]["tech_intel"]["error"]["status"] == 500
    assert rows["e2"]["status"] == "listed_incomplete" and rows["e2"]["tech_intel"]["error"]["kind"] == "timeout"
    assert rows["e3"]["tech_intel"]["error"]["kind"] == "invalid_response"
    assert rows["e4"]["tech_intel"]["error"]["kind"] == "insufficient_credits"
    assert rows["e5"]["status"] == "not_processed"
    assert techs(result)["salesforce-sales-cloud"]["cells"]["e5"] == "no_data"
    assert result["credits"]["requests_with_uncertain_charge"] == 2
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
    assert len(transport.sent) == 1


def test_evidence_summary():
    result, transport = run("evidence")
    assert transport.sent[0].query == {"fqdn": "acme.example", "withEvidence": "true"}
    ev = by_id(result)["row-1"]["technologies"][0]["evidence"]
    assert ev["records_without_location"] == 1 and ev["records_truncated"] is True
    assert by_id(result)["row-2"]["technologies"][0]["evidence"] == {"status": "none_returned"}
    assert result["summary"]["evidence_records_without_location"] == 1


def test_markdown_is_escaped_and_complete(tmp_path):
    run("happy", out=tmp_path)
    md = (tmp_path / "comparison.md").read_text()
    assert md.startswith("# Stack comparison\n")
    assert "| \\#1 Beta \\| Pty | s2 | listed |" in md
    assert "\\<b\\>Bold\\</b\\> \\*CRM\\* \\| \\[x\\] (bold-crm)" in md
    assert "<b>" not in md
    assert "## Shared by every company with data\n\n- Slack (slack)\n" in md
    assert "| Salesforce Sales Cloud (salesforce-sales-cloud) | observed | observed | not observed in pages retrieved |" in md
    assert "## Coverage and limitations" in md


def test_md_escape():
    assert md_escape("# a_b|c\nd") == "\\# a\\_b\\|c d"
    assert md_escape("[x](javascript:y)") == "\\[x\\](javascript:y)"
    assert md_escape(None) == ""


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Bold</b>" not in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == [f"s{i}" for i in range(1, 8)]
    assert rows[2]["unique_to_this_company"] == "bold-crm; snowflake"
    assert rows[4]["unique_to_this_company"] == "zendesk"          # the duplicate row follows its first row
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_input_needs_2_to_20_rows(tmp_path):
    one = tmp_path / "one.csv"
    one.write_text("domain\nacme.example\n")
    with pytest.raises(InputError, match="needs 2 to 20 input rows, not 1"):
        RECIPE.read_input(one)
    many = tmp_path / "many.csv"
    many.write_text("domain\n" + "".join(f"c{i}.example\n" for i in range(21)))
    with pytest.raises(InputError, match="not 21"):
        RECIPE.read_input(many)


def test_plan_counts_unique_companies_and_pages():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    [call] = plan(rows, cfg)
    assert call.requests == 12                  # 6 unique valid identifiers x 2 pages
    assert call.to_dict()["published_estimate_upper_bound"] == 30.0
    cfg["with_evidence"] = True
    assert plan(rows, cfg)[0].to_dict()["published_estimate_upper_bound"] == 32.4


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(max_pages=0), "max_pages must be a whole number from 1 to 25"),
    (lambda c: c.update(max_pages=2.5), "max_pages must be a whole number"),
    (lambda c: c.update(with_evidence=1), "with_evidence must be true or false"),
    (lambda c: c.update(level="vendor"), "level must be product or category"),
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
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 30.0
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name\nAcme\nBeta\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
