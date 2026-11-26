"""Stack comparison: what a small set of companies' observed stacks share, and where they differ.

Workflow:
1. Read 2 to 20 companies. Each row has a `domain` or a Firmable `company_id`.
2. For each unique valid company, read Tech Intel (GET /tech-intel), following next_cursor up to
   max_pages pages, and record whether the list is complete.
3. Build a technology-by-company matrix at product level (product_slug) or category level
   (category_slug).
4. List what is shared by every company with data, shared by some, and unique to one.

Matrix cells:
- observed: the technology was observed in the retrieved data;
- not_observed: not observed, and the company's technology list is complete;
- not_observed_in_pages_retrieved: not observed, but the company's list is incomplete;
- no_data: no technology data was retrieved for the company.
"Not observed" means not observed in retrieved data. It never means the company does not use it.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError, InputError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import FATAL_KINDS, PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, bullet_list, esc, kv, note, table

NAME = "stack-comparison"
TITLE = "Stack comparison"
DESCRIPTION = ("Compares the technologies Firmable Tech Intel observed at 2 to 20 companies: what every company "
               "with data shares, what some share, and what was observed at only one.")

STATUS_TONE = {"listed": "good", "listed_incomplete": "review", "no_technology_data": "unknown",
               "company_not_found": "unknown", "access_denied": "error", "invalid_input": "error",
               "error": "error", "not_processed": "unknown"}
CELL_TONE = {"observed": "good", "not_observed": "neutral", "not_observed_in_pages_retrieved": "review",
             "no_data": "unknown"}
CELL_TEXT = {"observed": "observed", "not_observed": "not observed (complete list)",
             "not_observed_in_pages_retrieved": "not observed in pages retrieved", "no_data": "no data"}
STOP_TEXT = {
    "page_limit": "the page limit was reached",
    "error": "a later page failed",
    "budget": "the credit limit was reached",
    "repeated_cursor": "the API returned a cursor it had already returned",
}
CONFIDENCE_ORDER = ["high", "medium", "low"]
LEVEL_FIELDS = {"product": ("product_slug", "product"), "category": ("category_slug", "category")}
_TOP_KEYS = {"max_pages", "with_evidence", "level"}
_COMPANY_ID = re.compile(r"^[A-Za-z0-9]{1,40}$")
MAX_PAGES_LIMIT = 25
MIN_ROWS = 2
MAX_ROWS = 20


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    max_pages = raw.get("max_pages", 3)
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or not 1 <= max_pages <= MAX_PAGES_LIMIT:
        raise ConfigError(f"max_pages must be a whole number from 1 to {MAX_PAGES_LIMIT}.")
    with_evidence = raw.get("with_evidence", False)
    if not isinstance(with_evidence, bool):
        raise ConfigError("with_evidence must be true or false.")
    level = raw.get("level", "product")
    if level not in LEVEL_FIELDS:
        raise ConfigError("level must be product or category.")
    return {"max_pages": max_pages, "with_evidence": with_evidence, "level": level}


def read_input(path: Path) -> list[dict[str, str]]:
    rows = read_rows(path, any_of=["domain", "company_id"])
    if not MIN_ROWS <= len(rows) <= MAX_ROWS:
        raise InputError(f"A stack comparison needs {MIN_ROWS} to {MAX_ROWS} input rows, not {len(rows)}.")
    return rows


def _subject(row: dict[str, str]) -> tuple[dict[str, str] | None, str | None, str]:
    """Returns (identifier, subject key, reason when invalid). company_id wins over domain."""
    cid = (row.get("company_id") or "").strip()
    if cid:
        if not _COMPANY_ID.match(cid):
            return None, None, f"Not a valid Firmable company ID: {cid}"
        return {"id": cid}, f"id:{cid}", ""
    raw = row.get("domain") or ""
    domain = normalise_domain(raw)
    if not domain:
        return None, None, f"Not a valid domain: {raw}"
    return {"fqdn": domain}, f"fqdn:{domain}", ""


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    keys: list[str] = []
    for r in rows:
        _, key, _ = _subject(r)
        if key and key not in keys:
            keys.append(key)
    n = len(keys)
    pages = config["max_pages"]
    parts = [("tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n))]
    if config["with_evidence"]:
        parts.append(("tech_intel_evidence", pricing.round4(pricing.TECH_INTEL_EVIDENCE_REQUEST * n * pages)))
    return [PlannedCall("GET /tech-intel", f"Up to {pages} page(s) of Tech Intel for each unique valid company",
                        n * pages, parts)]


def _rank(item: dict[str, Any]) -> int:
    c = item.get("confidence")
    return CONFIDENCE_ORDER.index(c) if c in CONFIDENCE_ORDER else len(CONFIDENCE_ORDER)


def _last(item: dict[str, Any]) -> str:
    v = item.get("last_observed")
    return v if isinstance(v, str) else ""


def _evidence_summary(ev: Any) -> dict[str, Any]:
    if not isinstance(ev, dict):
        return {"status": "none_returned"}
    records = [r for r in (ev.get("records") or []) if isinstance(r, dict)]
    no_location = len([r for r in records if not isinstance(r.get("location"), str) or not r["location"].strip()])
    count = ev.get("evidence_count")
    return {"status": "returned", "confidence": ev.get("confidence"), "first_seen": ev.get("first_seen"),
            "last_seen": ev.get("last_seen"), "evidence_count": count, "records_listed": len(records),
            "records_without_location": no_location,
            "records_truncated": isinstance(count, int) and len(records) < count}


def _entries(items: list[dict[str, Any]], level: str, with_evidence: bool) -> tuple[list[dict[str, Any]], int]:
    """One entry per key at the chosen level. The entry shows the strongest item: highest confidence,
    then latest last_observed, then the first returned. Returns (entries, items with no key)."""
    key_field, label_field = LEVEL_FIELDS[level]
    chosen: dict[str, dict[str, Any]] = {}
    products: dict[str, list[str]] = {}
    order: list[str] = []
    no_key = 0
    for item in items:
        k = item.get(key_field)
        if not isinstance(k, str) or not k.strip():
            no_key += 1
            continue
        if k not in chosen:
            chosen[k] = item
            products[k] = []
            order.append(k)
        else:
            cur = chosen[k]
            if _rank(item) < _rank(cur) or (_rank(item) == _rank(cur) and _last(item) > _last(cur)):
                chosen[k] = item
        p = item.get("product_slug")
        if isinstance(p, str) and p and p not in products[k]:
            products[k].append(p)
    out = []
    for k in order:
        item = chosen[k]
        e = {"key": k, "label": item.get(label_field), "vendor": item.get("vendor") if level == "product" else None,
             "category": item.get("category"), "products": products[k], "confidence": item.get("confidence"),
             "recency": item.get("recency"), "last_observed": item.get("last_observed"), "nature": item.get("nature")}
        if with_evidence:
            e["evidence"] = _evidence_summary(item.get("evidence_detail"))
        out.append(e)
    return out, no_key


def _record_error(ctx: RunContext, row_id: str | None, err: dict[str, Any], stop: bool = False) -> dict[str, Any]:
    entry = {"row_id": row_id, **err}
    ctx.errors.append(entry)
    if (stop or err.get("kind") in FATAL_KINDS) and ctx.stopped is None:
        ctx.stopped = entry
    return entry


def _label(row: dict[str, Any]) -> str:
    inp = row.get("input") or {}
    ident = row.get("identifier") or {}
    return (inp.get("company_name") or ident.get("fqdn") or ident.get("id") or inp.get("domain")
            or inp.get("company_id") or row["row_id"])


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    client = ctx.client
    level = cfg["level"]
    coverage = [
        "The comparison covers only the companies in your input file. It does not describe a market or sector.",
        "A technology that was not found is not observed in retrieved data. This does not mean the company does "
        "not use it.",
        "Tech Intel reports observed technology signals with Firmable's confidence and recency. A detected "
        "technology does not prove buying intent, spend or active usage.",
    ]
    if level == "category":
        coverage.append("Compared at category level: a category is observed at a company when any product in that "
                        "category was observed there.")
    if not cfg["with_evidence"]:
        coverage.append("Evidence was not requested (with_evidence is false).")

    first_by_subject: dict[str, str] = {}
    results_by_row: dict[str, dict[str, Any]] = {}
    row_by_company_id: dict[str, str] = {}

    def one(row: dict[str, str]) -> dict[str, Any]:
        identifier, key, reason = _subject(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "identifier": identifier,
                                "duplicate_of": None, "same_company_as": None, "tech_intel": None,
                                "technologies": [], "items_without_key": 0}
        if key is None:
            return {**base, "status": "invalid_input", "status_reason": reason}
        if key in first_by_subject:
            first = results_by_row[first_by_subject[key]]
            copy = {k: v for k, v in first.items() if k not in ("row_id", "input", "duplicate_of", "same_company_as")}
            out = {**base, **copy, "duplicate_of": first["row_id"]}
            results_by_row[row["row_id"]] = out
            return out
        first_by_subject[key] = row["row_id"]

        ti = client.get_tech_intel(identifier, with_evidence=cfg["with_evidence"], max_pages=cfg["max_pages"])
        err = ti["error"]
        entry = None
        if err:
            entry = _record_error(ctx, row["row_id"], err, stop=err.get("kind") == "forbidden")
        items = [i for i in ti["items"] if isinstance(i, dict)]
        base["tech_intel"] = {"company_id": ti["id"], "total": ti["total"], "retrieved": len(items),
                              "pages_fetched": ti["pages_fetched"], "complete": ti["complete"],
                              "stop_reason": ti["stop_reason"], "error": entry}
        cid = ti["id"]
        if isinstance(cid, str) and cid:
            if cid in row_by_company_id:
                base["same_company_as"] = row_by_company_id[cid]
            else:
                row_by_company_id[cid] = row["row_id"]
        if ti["pages_fetched"] == 0:
            kind = (err or {}).get("kind")
            if kind == "not_found":
                out = {**base, "status": "company_not_found",
                       "status_reason": "Tech Intel has no company for this identifier (404)."}
            elif kind == "forbidden":
                out = {**base, "status": "access_denied",
                       "status_reason": ("Firmable returned 403 Forbidden for Tech Intel. This API key cannot "
                                         "use this endpoint. The run stops, because later requests would be refused too.")}
            else:
                out = {**base, "status": "error",
                       "status_reason": f"Tech Intel could not be read: {(err or {}).get('message')}"}
            results_by_row[row["row_id"]] = out
            return out

        entries, no_key = _entries(items, level, cfg["with_evidence"])
        base.update(technologies=entries, items_without_key=no_key)
        total = ti["total"]
        total_text = str(total) if isinstance(total, int) else "an unknown number of"
        if not items and ti["complete"]:
            out = {**base, "status": "no_technology_data",
                   "status_reason": "Firmable holds no technology data for this company (total 0)."}
        elif ti["complete"]:
            out = {**base, "status": "listed",
                   "status_reason": (f"The complete list was retrieved: {total_text} "
                                     f"{'technology' if total == 1 else 'technologies'} in {ti['pages_fetched']} page(s).")}
        else:
            why = STOP_TEXT.get(ti["stop_reason"], ti["stop_reason"])
            out = {**base, "status": "listed_incomplete",
                   "status_reason": (f"The technology list is incomplete because {why}: {len(items)} of {total_text} "
                                     f"technologies were retrieved in {ti['pages_fetched']} page(s).")}
        results_by_row[row["row_id"]] = out
        return out

    rows = ctx.run_rows(ctx.rows, one)
    for r in rows:
        # Rows the shared runner filled in (not_processed, or an exception) get the same fields.
        if "tech_intel" not in r:
            identifier, _, _ = _subject(r["input"])
            for k, v in (("identifier", identifier), ("duplicate_of", None), ("same_company_as", None),
                         ("tech_intel", None), ("technologies", []), ("items_without_key", 0)):
                r.setdefault(k, v)
            r.setdefault("status_reason", r.get("reason") or (r.get("error") or {}).get("message") or "")
    summary = _compare(rows, cfg)

    dupes = len([r for r in rows if r.get("duplicate_of")])
    same = len([r for r in rows if r.get("same_company_as")])
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company identifier. Their results were reused and the "
                        "company appears once in the comparison.")
    if same:
        coverage.append(f"{same} row(s) resolved to a Firmable company ID already returned for an earlier row. The "
                        "company appears once in the comparison, under the earlier row.")
    c = summary["counts"]
    if c["incomplete_lists"]:
        coverage.append(f"{c['incomplete_lists']} company list(s) are incomplete (max_pages is {cfg['max_pages']}). "
                        "Technologies not seen in them are not observed in the pages retrieved, so shared and unique "
                        "lists may change with more pages.")
    if c["companies_with_data"] < 2:
        coverage.append(f"Only {c['companies_with_data']} company(ies) returned technology data. Shared and unique "
                        "lists need at least two companies with data, so they are empty.")
    if summary["items_without_key"]:
        coverage.append(f"{summary['items_without_key']} retrieved technology item(s) have no "
                        f"{LEVEL_FIELDS[level][0]} and are not compared.")
    if summary.get("evidence_records_without_location"):
        coverage.append(f"{summary['evidence_records_without_location']} evidence record(s) have no location, so "
                        "their source cannot be shown.")
    return {"rows": rows, "summary": summary, "coverage": coverage}


def _compare(rows: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    status_counts: dict[str, int] = {}
    for r in rows:
        status_counts[r["status"]] = status_counts.get(r["status"], 0) + 1
    companies = [r for r in rows if r["status"] != "invalid_input" and not r.get("duplicate_of")
                 and not r.get("same_company_as")]
    with_data = [r for r in companies if r["status"] in ("listed", "listed_incomplete")]
    data_ids = [r["row_id"] for r in with_data]
    has = {r["row_id"]: {t["key"]: t for t in r["technologies"]} for r in with_data}

    info: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for r in with_data:
        for t in r["technologies"]:
            if t["key"] not in info:
                info[t["key"]] = {"label": t.get("label"), "vendor": t.get("vendor"), "category": t.get("category")}
                order.append(t["key"])

    def cell(r: dict[str, Any], k: str) -> str:
        if r["row_id"] not in has:
            return "no_data"
        if k in has[r["row_id"]]:
            return "observed"
        return "not_observed" if r["tech_intel"]["complete"] else "not_observed_in_pages_retrieved"

    techs = []
    for k in order:
        cells = {r["row_id"]: cell(r, k) for r in companies}
        observed = [i for i in data_ids if cells[i] == "observed"]
        not_obs = [i for i in data_ids if cells[i] == "not_observed"]
        unknown = [i for i in data_ids if cells[i] == "not_observed_in_pages_retrieved"]
        if len(data_ids) < 2:
            sharing = "not_compared"
        elif len(observed) == len(data_ids):
            sharing = "all"
        elif len(observed) >= 2:
            sharing = "some"
        else:
            sharing = "one"
        techs.append({"key": k, **info[k], "cells": cells, "observed_in": observed, "not_observed_in": not_obs,
                      "not_observed_in_pages_retrieved": unknown, "observed_count": len(observed),
                      "sharing": sharing,
                      "details": {i: {f: has[i][k].get(f) for f in ("confidence", "recency", "last_observed")}
                                  for i in observed}})
    techs.sort(key=lambda t: (-t["observed_count"], t["key"]))

    labels = {r["row_id"]: _label(r) for r in companies}
    unique = []
    for t in techs:
        if t["sharing"] != "one":
            continue
        who = t["observed_in"][0]
        unknown = len(t["not_observed_in_pages_retrieved"])
        if unknown:
            text = (f"Observed only at {labels[who]} in retrieved data. Not observed in the pages retrieved for "
                    f"{unknown} other company(ies), so it may not be unique.")
        else:
            text = f"Observed only at {labels[who]}. Every other company with data has a complete list."
        unique.append({"key": t["key"], "row_id": who, "confirmed": unknown == 0, "text": text})

    some = []
    for t in techs:
        if t["sharing"] != "some":
            continue
        text = f"Observed at {len(t['observed_in'])} of {len(data_ids)} companies with data: " + \
               ", ".join(labels[i] for i in t["observed_in"]) + "."
        if t["not_observed_in_pages_retrieved"]:
            text += (f" Not observed in the pages retrieved for {len(t['not_observed_in_pages_retrieved'])} "
                     "company(ies).")
        some.append({"key": t["key"], "text": text})

    out: dict[str, Any] = {
        "status_counts": status_counts, "level": cfg["level"],
        "companies": [{"row_id": r["row_id"], "label": labels[r["row_id"]], "status": r["status"],
                       "complete": (r.get("tech_intel") or {}).get("complete"),
                       "compared": r["row_id"] in has} for r in companies],
        "counts": {"input_rows": len(rows), "companies": len(companies), "companies_with_data": len(with_data),
                   "incomplete_lists": len([r for r in with_data if not r["tech_intel"]["complete"]]),
                   "technologies": len(techs), "shared_by_all": len([t for t in techs if t["sharing"] == "all"]),
                   "shared_by_some": len(some), "unique_to_one": len(unique)},
        "technologies": techs,
        "shared_by_all": [t["key"] for t in techs if t["sharing"] == "all"],
        "shared_by_some": some,
        "unique_to_one": unique,
        "items_without_key": sum(r.get("items_without_key") or 0 for r in companies),
    }
    if cfg["with_evidence"]:
        out["evidence_records_without_location"] = sum(
            (t.get("evidence") or {}).get("records_without_location") or 0 for r in with_data for t in r["technologies"])
    return out


# ----- outputs -------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "domain", "company_id_input", "company", "status", "status_reason", "duplicate_of",
               "same_company_as", "firmable_id", "technologies_total", "technologies_retrieved",
               "technologies_compared", "pages_fetched", "list_complete", "shared_by_all", "unique_to_this_company"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    s = result["summary"]
    shared = set(s["shared_by_all"])
    out = []
    for r in result["rows"]:
        ti = r.get("tech_intel") or {}
        inp = r.get("input") or {}
        anchor = r.get("duplicate_of") or r.get("same_company_as") or r["row_id"]
        mine = [t["key"] for t in r.get("technologies") or []]
        out.append({
            "row_id": r["row_id"], "domain": inp.get("domain"), "company_id_input": inp.get("company_id"),
            "company": _label(r), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "duplicate_of": r.get("duplicate_of"), "same_company_as": r.get("same_company_as"),
            "firmable_id": ti.get("company_id"), "technologies_total": ti.get("total"),
            "technologies_retrieved": ti.get("retrieved"), "technologies_compared": len(mine) if ti else None,
            "pages_fetched": ti.get("pages_fetched"), "list_complete": ti.get("complete"),
            "shared_by_all": len([k for k in mine if k in shared]),
            "unique_to_this_company": [u["key"] for u in s["unique_to_one"] if u["row_id"] == anchor],
        })
    return out


def md_escape(value: Any) -> str:
    """Escapes API and input text for Markdown: \\ ` * _ [ ] < > | and a leading #."""
    if value is None:
        return ""
    s = re.sub(r"[\r\n\t]", " ", str(value))
    s = re.sub(r"([\\`*_\[\]<>|])", r"\\\1", s)
    if s.startswith("#"):
        s = "\\" + s
    return s


def _tech_name(t: dict[str, Any]) -> str:
    return f"{md_escape(t.get('label') or t['key'])} ({md_escape(t['key'])})"


def markdown(result: dict[str, Any]) -> dict[str, str]:
    s = result["summary"]
    c = s["counts"]
    labels = {co["row_id"]: co["label"] for co in s["companies"]}
    lines = ["# Stack comparison", "",
             f"Level: {s['level']}. Companies compared: {c['companies']}. Companies with technology data: "
             f"{c['companies_with_data']}. Incomplete lists: {c['incomplete_lists']}.", "",
             "\"Observed\" means Firmable Tech Intel observed the technology in the retrieved data. \"Not observed\" "
             "means not observed in retrieved data, not that the company does not use it. This comparison covers "
             "only these companies.", "",
             "## Companies", "",
             "| Company | Row | Status | Technologies retrieved | Total | List complete |",
             "| - | - | - | - | - | - |"]
    by_row = {r["row_id"]: r for r in result["rows"]}
    for co in s["companies"]:
        ti = by_row[co["row_id"]].get("tech_intel") or {}
        lines.append(f"| {md_escape(co['label'])} | {md_escape(co['row_id'])} | {co['status'].replace('_', ' ')} | "
                     f"{md_escape(ti.get('retrieved'))} | {md_escape(ti.get('total'))} | "
                     f"{'yes' if ti.get('complete') else 'no'} |")
    techs = {t["key"]: t for t in s["technologies"]}
    lines += ["", "## Shared by every company with data", ""]
    lines += [f"- {_tech_name(techs[k])}" for k in s["shared_by_all"]] or ["None."]
    lines += ["", "## Shared by some companies", ""]
    lines += [f"- {_tech_name(techs[x['key']])}: {md_escape(x['text'])}" for x in s["shared_by_some"]] or ["None."]
    lines += ["", "## Observed at only one company", ""]
    lines += [f"- {_tech_name(techs[x['key']])}: {md_escape(x['text'])}" for x in s["unique_to_one"]] or ["None."]
    lines += ["", "## Matrix", ""]
    compared = s["companies"]
    if s["technologies"]:
        lines.append("| Technology | " + " | ".join(md_escape(labels[co["row_id"]]) for co in compared) + " |")
        lines.append("| - |" + " - |" * len(compared))
        for t in s["technologies"]:
            lines.append(f"| {_tech_name(t)} | " + " | ".join(CELL_TEXT[t["cells"][co["row_id"]]] for co in compared)
                         + " |")
    else:
        lines.append("No technologies were observed.")
    lines += ["", "## Coverage and limitations", ""]
    lines += [f"- {md_escape(x)}" for x in result.get("coverage") or []]
    return {"comparison.md": "\n".join(lines) + "\n"}


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    c = s["counts"]
    counts = s.get("status_counts", {})
    report.add("Result", "Comparison summary",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + kv([("Level", s["level"]), ("Companies compared", c["companies"]),
                     ("Companies with technology data", c["companies_with_data"]),
                     ("Incomplete lists", c["incomplete_lists"]), ("Technologies observed", c["technologies"]),
                     ("Shared by every company with data", c["shared_by_all"]),
                     ("Shared by some", c["shared_by_some"]), ("Observed at only one", c["unique_to_one"])])
               + note("Not observed means not observed in retrieved data. It does not mean the company does not "
                      "use the technology.", "unknown"))
    techs = {t["key"]: t for t in s["technologies"]}

    def name(k: str) -> str:
        t = techs[k]
        return f"{t.get('label') or k} ({k})"

    body = "<h3>Shared by every company with data</h3>" + (bullet_list(name(k) for k in s["shared_by_all"]) or "<p>None.</p>")
    body += "<h3>Shared by some companies</h3>" + (bullet_list(f"{name(x['key'])}: {x['text']}" for x in s["shared_by_some"])
                                                    or "<p>None.</p>")
    body += "<h3>Observed at only one company</h3>" + (bullet_list(f"{name(x['key'])}: {x['text']}" for x in s["unique_to_one"])
                                                        or "<p>None.</p>")
    report.add("Lists", "Shared and unique technologies", body)

    companies = s["companies"]
    if s["technologies"]:
        mrows = [[name(t["key"])] + [Raw(badge(CELL_TEXT[t["cells"][co["row_id"]]], CELL_TONE[t["cells"][co["row_id"]]]))
                                     for co in companies] for t in s["technologies"]]
        mbody = table(["Technology"] + [co["label"] for co in companies], mrows)
    else:
        mbody = "<p>No technologies were observed.</p>"
    report.add("Matrix", "Technology by company", mbody)

    crow = []
    for r in result["rows"]:
        ti = r.get("tech_intel") or {}
        crow.append([r["row_id"], _label(r), Raw(badge(r["status"].replace("_", " "), STATUS_TONE.get(r["status"], "neutral"))),
                     ti.get("retrieved"), ti.get("total"), ti.get("complete"),
                     r.get("status_reason") or r.get("reason") or "", r.get("duplicate_of") or r.get("same_company_as") or ""])
    report.add("Companies", "Each input row",
               table(["Row", "Company", "Status", "Retrieved", "Total", "Complete", "Reason", "Same as row"], crow))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render,
                markdown=markdown)
