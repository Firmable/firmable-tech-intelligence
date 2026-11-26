"""Ecosystem explorer: which technologies appear across a cohort, and which appear together.

Workflow:
1. Read the cohort the user supplied. Each row has a `domain` or a Firmable `company_id`.
2. For each unique valid company, read Tech Intel (GET /tech-intel), following next_cursor up to
   max_pages pages. There is no batch endpoint, so companies are read one at a time.
3. Record whether each company's technology list is complete.
4. Count, per technology, the companies where it was observed, out of the companies with data.
5. Count, for each pair of technologies observed in at least min_companies companies, the
   companies where both were observed.

A technology not seen in an incomplete list is "not observed in the pages retrieved". It is never
counted as not observed. Co-occurrence does not show integration, compatibility or use together.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import FATAL_KINDS, PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, details_json, esc, kv, note, table

NAME = "ecosystem-explorer"
TITLE = "Ecosystem explorer"
DESCRIPTION = ("Counts which technologies Firmable Tech Intel observed across a cohort of companies you supply, "
               "and which technologies were observed at the same companies, with denominators.")

ASSET = Path(__file__).resolve().parents[3] / "assets" / "explorer.js"

STATUS_TONE = {"listed": "good", "listed_incomplete": "review", "no_technology_data": "unknown",
               "company_not_found": "unknown", "access_denied": "error", "invalid_input": "error",
               "error": "error", "not_processed": "unknown"}
STOP_TEXT = {
    "page_limit": "the page limit was reached",
    "error": "a later page failed",
    "budget": "the credit limit was reached",
    "repeated_cursor": "the API returned a cursor it had already returned",
}
CONFIDENCE_ORDER = ["high", "medium", "low"]
RECENCY_ORDER = ["30d", "90d", "older"]
NO_GROUP = "(no value)"
NOT_RETURNED = "not returned"
TECH_FIELDS = ["product", "product_slug", "vendor", "vendor_slug", "filter", "filter_slug", "category",
               "category_slug", "pillar_slug", "confidence", "recency", "last_observed", "nature"]

_TOP_KEYS = {"max_pages", "with_evidence", "min_companies", "min_answered", "group_by", "categories",
             "cooccurrence_top"}
_COMPANY_ID = re.compile(r"^[A-Za-z0-9]{1,40}$")
MAX_PAGES_LIMIT = 25


def _whole(raw: dict[str, Any], key: str, default: int, low: int, high: int | None) -> int:
    v = raw.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or v < low or (high is not None and v > high):
        upper = f" to {high}" if high is not None else " or more"
        raise ConfigError(f"{key} must be a whole number from {low}{upper}.")
    return v


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    max_pages = _whole(raw, "max_pages", 15, 1, MAX_PAGES_LIMIT)
    with_evidence = raw.get("with_evidence", False)
    if not isinstance(with_evidence, bool):
        raise ConfigError("with_evidence must be true or false.")
    min_companies = _whole(raw, "min_companies", 2, 1, None)
    min_answered = _whole(raw, "min_answered", 5, 1, None)
    cooccurrence_top = _whole(raw, "cooccurrence_top", 40, 2, 200)
    group_by = raw.get("group_by")
    if group_by is not None and (not isinstance(group_by, str) or not group_by.strip()):
        raise ConfigError("group_by must be the name of an input column, or null.")
    if isinstance(group_by, str) and group_by.strip() == "row_id":
        raise ConfigError("group_by cannot be row_id.")
    cats = raw.get("categories")
    if cats is None:
        categories: list[str] = []
    elif not isinstance(cats, list) or not all(isinstance(c, str) and c.strip() for c in cats):
        raise ConfigError("categories must be a list of category slugs, such as business-applications.")
    else:
        categories = []
        for c in cats:
            if c.strip() not in categories:
                categories.append(c.strip())
    return {"max_pages": max_pages, "with_evidence": with_evidence, "min_companies": min_companies,
            "min_answered": min_answered, "group_by": group_by.strip() if isinstance(group_by, str) else None,
            "categories": categories, "cooccurrence_top": cooccurrence_top}


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["domain", "company_id"])


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


def _unique_subjects(rows: list[dict[str, str]]) -> list[str]:
    out: list[str] = []
    for r in rows:
        _, key, _ = _subject(r)
        if key and key not in out:
            out.append(key)
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_unique_subjects(rows))
    pages = config["max_pages"]
    parts = [("tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n))]
    if config["with_evidence"]:
        parts.append(("tech_intel_evidence", pricing.round4(pricing.TECH_INTEL_EVIDENCE_REQUEST * n * pages)))
    return [PlannedCall("GET /tech-intel", f"Up to {pages} page(s) of Tech Intel for each unique valid company",
                        n * pages, parts)]


# ----- helpers shared by run and the measures ------------------------------------------------

def pct_tenths(part: int, whole: int) -> int:
    """part / whole as a percentage in tenths, rounded half up, using whole numbers only."""
    return (part * 1000 * 2 + whole) // (whole * 2)


def pct_text(part: int, whole: int) -> str:
    t = pct_tenths(part, whole)
    return f"{t // 10}.{t % 10}%"


def pct_value(part: int, whole: int) -> float:
    return pct_tenths(part, whole) / 10


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
    by_type = [t for t in (ev.get("evidence_by_type") or []) if isinstance(t, dict)]
    capped = [t["type"] for t in by_type if t.get("capped") is True and isinstance(t.get("type"), str)]
    count = ev.get("evidence_count")
    return {"status": "returned", "confidence": ev.get("confidence"), "first_seen": ev.get("first_seen"),
            "last_seen": ev.get("last_seen"), "evidence_count": count, "records_listed": len(records),
            "records_without_location": no_location, "capped_types": capped,
            "records_truncated": isinstance(count, int) and len(records) < count}


def _technologies(items: list[dict[str, Any]], with_evidence: bool,
                  categories: list[str]) -> tuple[list[dict[str, Any]], int, int]:
    """One entry per product_slug, keeping the strongest item: highest confidence, then latest
    last_observed, then the first returned. Returns (technologies, set aside by category, no slug)."""
    chosen: dict[str, dict[str, Any]] = {}
    counts: dict[str, int] = {}
    order: list[str] = []
    filtered = 0
    no_slug = 0
    for item in items:
        slug = item.get("product_slug")
        if not isinstance(slug, str) or not slug.strip():
            no_slug += 1
            continue
        if categories and item.get("category_slug") not in categories:
            filtered += 1
            continue
        if slug not in chosen:
            chosen[slug] = item
            counts[slug] = 1
            order.append(slug)
            continue
        counts[slug] += 1
        cur = chosen[slug]
        if _rank(item) < _rank(cur) or (_rank(item) == _rank(cur) and _last(item) > _last(cur)):
            chosen[slug] = item
    out = []
    for slug in order:
        item = chosen[slug]
        t = {k: item.get(k) for k in TECH_FIELDS}
        t["key"] = slug
        t["items_returned"] = counts[slug]
        if with_evidence:
            t["evidence"] = _evidence_summary(item.get("evidence_detail"))
        out.append(t)
    return out, filtered, no_slug


def _record_error(ctx: RunContext, row_id: str | None, err: dict[str, Any], stop: bool = False) -> dict[str, Any]:
    entry = {"row_id": row_id, **err}
    ctx.errors.append(entry)
    if (stop or err.get("kind") in FATAL_KINDS) and ctx.stopped is None:
        ctx.stopped = entry
    return entry


def _measure(observed: int, not_observed: int, unknown: int, base: dict[str, int], min_answered: int) -> dict[str, Any]:
    with_data = base["companies_with_data"]
    answered = observed + not_observed
    enough = answered >= min_answered and answered > 0
    out: dict[str, Any] = dict(base)
    out.update({"observed": observed, "not_observed": not_observed,
                "not_observed_in_pages_retrieved": unknown, "answered": answered,
                "observed_share_pct": pct_value(observed, answered) if enough else None,
                "unknown_share_pct": pct_value(unknown, with_data) if with_data else None,
                "enough_answers": enough})
    if with_data == 0:
        out["text"] = "No company in this cohort returned technology data."
        return out
    text = f"Observed in {observed} of {with_data} companies with data in this cohort."
    if enough:
        text += (f" Observed share of answered companies: {pct_text(observed, answered)} ({observed} of {answered}; "
                 "answered means observed, or not observed in a complete list).")
    else:
        text += f" Too few answers to compare: {answered} answered, minimum {min_answered}."
    if unknown:
        text += f" Not observed in the pages retrieved for {unknown} of {with_data} ({pct_text(unknown, with_data)})."
    out["text"] = text
    return out


def _sort_key_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


# ----- run -----------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    client = ctx.client
    group_by = cfg["group_by"]
    coverage = [
        "The cohort is the input file you supplied. The REST API has no company search and no lookup by "
        "technology, so these counts describe the companies checked, not a market, sector or population.",
        "Every count states its denominator. Shares are observed over answered companies, where answered means "
        "observed, or not observed in a complete technology list.",
        "A technology that was not found is not observed in retrieved data. This does not mean the company does "
        "not use it.",
        "Co-occurrence counts the companies where both technologies were observed. It does not show integration, "
        "compatibility or that the two are used together.",
        "Tech Intel reports observed technology signals with Firmable's confidence and recency. A detected "
        "technology does not prove buying intent, spend or active usage.",
    ]
    if not cfg["with_evidence"]:
        coverage.append("Evidence was not requested (with_evidence is false).")

    first_by_subject: dict[str, str] = {}
    results_by_row: dict[str, dict[str, Any]] = {}
    row_by_company_id: dict[str, str] = {}
    group_column_seen = any(group_by in r for r in ctx.rows) if group_by else True

    def group_of(row: dict[str, str]) -> str | None:
        if not group_by:
            return None
        v = (row.get(group_by) or "").strip()
        return v or NO_GROUP

    def one(row: dict[str, str]) -> dict[str, Any]:
        identifier, key, reason = _subject(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "identifier": identifier,
                                "group": group_of(row), "duplicate_of": None, "same_company_as": None,
                                "tech_intel": None, "technologies": [], "technologies_set_aside": 0,
                                "technologies_without_slug": 0}
        if key is None:
            return {**base, "status": "invalid_input", "status_reason": reason}
        if key in first_by_subject:
            first = results_by_row[first_by_subject[key]]
            copy = {k: v for k, v in first.items() if k not in ("row_id", "input", "group", "duplicate_of",
                                                                 "same_company_as")}
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
        techs, set_aside, no_slug = _technologies(items, cfg["with_evidence"], cfg["categories"])
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

        base.update(technologies=techs, technologies_set_aside=set_aside, technologies_without_slug=no_slug)
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
            for k, v in (("identifier", identifier), ("group", group_of(r["input"])), ("duplicate_of", None),
                         ("same_company_as", None), ("tech_intel", None), ("technologies", []),
                         ("technologies_set_aside", 0), ("technologies_without_slug", 0)):
                r.setdefault(k, v)
            r.setdefault("status_reason", r.get("reason") or (r.get("error") or {}).get("message") or "")
    summary = _summarise(rows, cfg)

    dupes = len([r for r in rows if r.get("duplicate_of")])
    same = len([r for r in rows if r.get("same_company_as")])
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company identifier. Their results were reused and "
                        "they are counted once.")
    if same:
        coverage.append(f"{same} row(s) resolved to a Firmable company ID already returned for an earlier row. "
                        "They are counted once, under the earlier row.")
    if summary["group_conflicts"]:
        coverage.append(f"{summary['group_conflicts']} repeated row(s) carry a different {group_by} value from "
                        "the first row for the same company. The first row's value was used.")
    if group_by and not group_column_seen:
        coverage.append(f"No input row has a {group_by} column, so every company is in the group {NO_GROUP}.")
    c = summary["cohort"]
    if c["incomplete_lists"]:
        coverage.append(f"{c['incomplete_lists']} company list(s) are incomplete (max_pages is {cfg['max_pages']}). "
                        "Technologies not seen in them are not observed in the pages retrieved, and are not counted "
                        "as not observed.")
    if cfg["categories"]:
        coverage.append(f"Only technologies in these categories are counted: {', '.join(cfg['categories'])}. "
                        f"{summary['technologies_set_aside']} retrieved technology item(s) in other categories "
                        "were set aside.")
    if summary["technologies_without_slug"]:
        coverage.append(f"{summary['technologies_without_slug']} retrieved technology item(s) have no product_slug "
                        "and are not counted.")
    if summary["classification_conflicts"]:
        coverage.append(f"{len(summary['classification_conflicts'])} technology(ies) were returned with more than "
                        "one category or vendor across companies. The first value returned is shown, and every "
                        "value is listed under classification_conflicts. This code does not correct upstream data.")
    ev = summary.get("evidence")
    if ev:
        if ev["records_without_location"]:
            coverage.append(f"{ev['records_without_location']} evidence record(s) have no location, so their "
                            "source cannot be shown.")
        if ev["technologies_with_truncated_records"]:
            coverage.append(f"{ev['technologies_with_truncated_records']} technology result(s) list fewer evidence "
                            "records than their evidence_count. The API lists up to 25 records per type.")
    coverage.append(f"A share is shown only when at least {cfg['min_answered']} companies answered (min_answered). "
                    f"The co-occurrence view lists technologies observed in at least {cfg['min_companies']} "
                    "companies (min_companies).")
    coverage.append(f"Co-occurrence pairs only the {cfg['cooccurrence_top']} technologies observed at the most "
                    f"companies (cooccurrence_top). {summary['cooccurrence']['not_paired']} more technologies met "
                    "min_companies and were not paired.")
    return {"rows": rows, "summary": summary, "coverage": coverage}


def _summarise(rows: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    min_answered = cfg["min_answered"]
    status_counts: dict[str, int] = {}
    for r in rows:
        status_counts[r["status"]] = status_counts.get(r["status"], 0) + 1

    # One entry per company: rows that are not duplicates and not the same company as an earlier row.
    companies = [r for r in rows if r["status"] != "invalid_input" and not r.get("duplicate_of")
                 and not r.get("same_company_as")]
    first_group = {r["row_id"]: r.get("group") for r in companies}
    group_conflicts = 0
    for r in rows:
        anchor = r.get("duplicate_of") or r.get("same_company_as")
        if anchor and r.get("group") != first_group.get(anchor) and anchor in first_group:
            group_conflicts += 1

    def state(r: dict[str, Any]) -> str:
        s = r["status"]
        if s in ("listed", "listed_incomplete"):
            return "with_data"
        if s == "no_technology_data":
            return "no_data"
        if s == "company_not_found":
            return "not_found"
        if s == "not_processed":
            return "not_processed"
        return "error"

    def base_counts(members: list[dict[str, Any]]) -> dict[str, int]:
        st = [state(r) for r in members]
        return {"cohort_companies": len(members),
                "companies_asked": len([s for s in st if s != "not_processed"]),
                "companies_with_data": st.count("with_data"), "no_data": st.count("no_data"),
                "not_found": st.count("not_found"), "error": st.count("error"),
                "not_processed": st.count("not_processed")}

    with_data = [r for r in companies if state(r) == "with_data"]
    has: dict[str, dict[str, dict[str, Any]]] = {}   # row_id -> tech key -> tech
    info: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    conflicts: dict[str, dict[str, list[Any]]] = {}
    for r in with_data:
        has[r["row_id"]] = {}
        for t in r["technologies"]:
            k = t["key"]
            has[r["row_id"]][k] = t
            if k not in info:
                info[k] = {f: t.get(f) for f in ("product", "product_slug", "vendor", "vendor_slug", "category",
                                                   "category_slug", "filter")}
                order.append(k)
                conflicts[k] = {"category_slug": [t.get("category_slug")], "vendor_slug": [t.get("vendor_slug")]}
            else:
                for f in ("category_slug", "vendor_slug"):
                    if t.get(f) not in conflicts[k][f]:
                        conflicts[k][f].append(t.get(f))

    groups: list[str] = []
    if cfg["group_by"]:
        for r in companies:
            if r.get("group") not in groups:
                groups.append(r["group"])
    group_members = {g: [r for r in companies if r.get("group") == g] for g in groups}
    overall_base = base_counts(companies)
    group_base = {g: base_counts(m) for g, m in group_members.items()}

    def block(k: str, members: list[dict[str, Any]], base: dict[str, int]) -> dict[str, Any]:
        o = n = u = 0
        for r in members:
            if state(r) != "with_data":
                continue
            if k in has[r["row_id"]]:
                o += 1
            elif r["tech_intel"]["complete"]:
                n += 1
            else:
                u += 1
        return _measure(o, n, u, base, min_answered)

    technologies = []
    for k in order:
        observed_rows = [r for r in with_data if k in has[r["row_id"]]]
        by_conf: dict[str, int] = {}
        by_rec: dict[str, int] = {}
        for r in observed_rows:
            t = has[r["row_id"]][k]
            cv = t.get("confidence") if isinstance(t.get("confidence"), str) else NOT_RETURNED
            rv = t.get("recency") if isinstance(t.get("recency"), str) else NOT_RETURNED
            by_conf[cv] = by_conf.get(cv, 0) + 1
            by_rec[rv] = by_rec.get(rv, 0) + 1
        entry = {"key": k, **info[k], "overall": block(k, companies, overall_base),
                 "by_confidence": by_conf, "by_recency": by_rec,
                 "observed_row_ids": [r["row_id"] for r in observed_rows]}
        if groups:
            entry["by_group"] = {g: block(k, group_members[g], group_base[g]) for g in groups}
        technologies.append(entry)
    technologies.sort(key=lambda t: (-t["overall"]["observed"], t["key"]))

    eligible = [t["key"] for t in technologies if t["overall"]["observed"] >= cfg["min_companies"]]
    listed = sorted(eligible[:cfg["cooccurrence_top"]])
    not_paired = len(eligible) - len(listed)
    observed_count = {t["key"]: t["overall"]["observed"] for t in technologies}
    pairs = []
    for i, a in enumerate(listed):
        for b in listed[i + 1:]:
            both = len([r for r in with_data if a in has[r["row_id"]] and b in has[r["row_id"]]])
            if not both:
                continue
            wa, wb = observed_count[a], observed_count[b]
            pairs.append({"a": a, "b": b, "both": both, "companies_with_a": wa, "companies_with_b": wb,
                          "share_of_a_pct": pct_value(both, wa) if wa >= min_answered else None,
                          "share_of_b_pct": pct_value(both, wb) if wb >= min_answered else None,
                          "text": (f"{both} of {wa} companies with {a} also show {b}. "
                                   f"{both} of {wb} companies with {b} also show {a}.")})
    pairs.sort(key=lambda p: (-p["both"], p["a"], p["b"]))

    conflict_list = []
    for k in sorted(conflicts):
        for f in ("category_slug", "vendor_slug"):
            if len(conflicts[k][f]) > 1:
                conflict_list.append({"product_slug": k, "field": f,
                                      "values": sorted(conflicts[k][f], key=_sort_key_text)})

    cohort = dict(overall_base)
    cohort.update({"input_rows": len(rows), "invalid_input_rows": status_counts.get("invalid_input", 0),
                   "duplicate_rows": len([r for r in rows if r.get("duplicate_of")]),
                   "same_company_rows": len([r for r in rows if r.get("same_company_as")]),
                   "incomplete_lists": len([r for r in with_data if not r["tech_intel"]["complete"]]),
                   "technologies_observed": len(technologies)})
    out: dict[str, Any] = {
        "status_counts": status_counts, "cohort": cohort, "group_by": cfg["group_by"], "groups": groups,
        "group_cohorts": [{"group": g, **group_base[g]} for g in groups],
        "technologies": technologies,
        "cooccurrence": {"min_companies": cfg["min_companies"], "top": cfg["cooccurrence_top"], "listed": listed,
                         "not_paired": not_paired, "pairs": pairs},
        "classification_conflicts": conflict_list, "group_conflicts": group_conflicts,
        "technologies_set_aside": sum(r.get("technologies_set_aside") or 0 for r in companies),
        "technologies_without_slug": sum(r.get("technologies_without_slug") or 0 for r in companies),
    }
    if cfg["with_evidence"]:
        no_loc = trunc = none = 0
        for r in with_data:
            for t in r["technologies"]:
                ev = t.get("evidence") or {}
                if ev.get("status") != "returned":
                    none += 1
                    continue
                no_loc += ev.get("records_without_location") or 0
                if ev.get("records_truncated"):
                    trunc += 1
        out["evidence"] = {"records_without_location": no_loc, "technologies_with_truncated_records": trunc,
                           "technologies_without_evidence": none}
    return out


# ----- outputs -------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "domain", "company_id_input", "group", "status", "status_reason", "duplicate_of",
               "same_company_as", "firmable_id", "technologies_total", "technologies_retrieved",
               "technologies_counted", "pages_fetched", "list_complete", "stop_reason", "technologies"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        ti = r.get("tech_intel") or {}
        inp = r.get("input") or {}
        techs = r.get("technologies") or []
        out.append({
            "row_id": r["row_id"], "domain": inp.get("domain"), "company_id_input": inp.get("company_id"),
            "group": r.get("group"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "duplicate_of": r.get("duplicate_of"), "same_company_as": r.get("same_company_as"),
            "firmable_id": ti.get("company_id"), "technologies_total": ti.get("total"),
            "technologies_retrieved": ti.get("retrieved"), "technologies_counted": len(techs) if ti else None,
            "pages_fetched": ti.get("pages_fetched"), "list_complete": ti.get("complete"),
            "stop_reason": ti.get("stop_reason"), "technologies": [t["key"] for t in techs],
        })
    return out


def _label(r: dict[str, Any]) -> str:
    inp = r.get("input") or {}
    ident = r.get("identifier") or {}
    return (inp.get("company_name") or ident.get("fqdn") or ident.get("id") or inp.get("domain")
            or inp.get("company_id") or r["row_id"])


def explorer_data(result: dict[str, Any]) -> dict[str, Any]:
    """The data the explorer page script reads. Everything comes from results.json."""
    s = result["summary"]
    companies = []
    for r in result["rows"]:
        if r.get("duplicate_of") or r.get("same_company_as") or r["status"] == "invalid_input":
            continue
        ti = r.get("tech_intel") or {}
        companies.append({
            "row_id": r["row_id"], "label": _label(r), "group": r.get("group"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or "",
            "complete": ti.get("complete"), "total": ti.get("total"), "retrieved": ti.get("retrieved"),
            "technologies": [{k: t.get(k) for k in ("key", "product", "vendor", "category", "confidence", "recency",
                                                     "last_observed", "nature")} for t in r.get("technologies") or []],
        })
    techs = []
    for t in s["technologies"]:
        techs.append({k: t.get(k) for k in ("key", "product", "vendor", "vendor_slug", "category", "category_slug",
                                             "overall", "by_group", "by_confidence", "by_recency")})
    return {"group_by": s.get("group_by"), "groups": s.get("groups") or [], "technologies": techs,
            "companies": companies, "pairs": s["cooccurrence"]["pairs"], "listed": s["cooccurrence"]["listed"],
            "min_companies": s["cooccurrence"]["min_companies"], "cohort": s["cohort"]}


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    c = s["cohort"]
    counts = s.get("status_counts", {})
    body = ("<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                             for k, v in counts.items()) + "</p>"
            + kv([("Input rows", c["input_rows"]), ("Companies in the cohort", c["cohort_companies"]),
                  ("Companies asked", c["companies_asked"]), ("Companies with data", c["companies_with_data"]),
                  ("Of which incomplete lists", c["incomplete_lists"]), ("No technology data", c["no_data"]),
                  ("Not found", c["not_found"]), ("Errors", c["error"]), ("Not processed", c["not_processed"]),
                  ("Invalid input rows", c["invalid_input_rows"]),
                  ("Technologies observed", c["technologies_observed"])])
            + note("These counts describe this cohort only. The cohort is the input file you supplied, not a "
                   "market or sector. Not observed means not observed in retrieved data.", "unknown"))
    report.add("Result", "Cohort coverage", body)

    report.add("Explore", "Technology explorer",
               '<div id="explorer"><p class="muted">The interactive explorer needs JavaScript. The tables below '
               'show the same counts.</p></div>'
               + note("Co-occurrence counts companies where both technologies were observed. It does not show "
                      "integration, compatibility or use together.", "unknown"))
    report.add_data("explorer-data", explorer_data(result))
    report.add_script(ASSET.read_text(encoding="utf-8"))

    techs = s["technologies"]
    rows = []
    for t in techs[:50]:
        o = t["overall"]
        share = f"{o['observed_share_pct']}% of {o['answered']}" if o["enough_answers"] else "too few answers to compare"
        rows.append([t.get("product"), t.get("vendor"), t.get("category"),
                     f"{o['observed']} of {o['companies_with_data']}", share,
                     o["not_observed_in_pages_retrieved"],
                     ", ".join(f"{k}: {v}" for k, v in t["by_confidence"].items())])
    tbody = (table(["Technology", "Vendor", "Category", "Observed (of companies with data)", "Share of answered",
                    "Not observed in pages retrieved", "Confidence"], rows)
             if rows else "<p>No technologies were observed.</p>")
    if len(techs) > 50:
        tbody += f'<p class="muted">The 50 most observed of {len(techs)} technologies are shown. All are in results.json.</p>'
    report.add("Technologies", "Most observed technologies", tbody)

    pairs = s["cooccurrence"]["pairs"]
    prow = [[p["a"], p["b"], p["both"], p["companies_with_a"], p["companies_with_b"], p["text"]] for p in pairs[:50]]
    pbody = (table(["Technology A", "Technology B", "Companies with both", "With A", "With B", "Reading"], prow)
             if prow else f"<p>No pair of technologies was observed together among technologies seen in at least "
                          f"{esc(s['cooccurrence']['min_companies'])} companies.</p>")
    report.add("Co-occurrence", "Technologies observed at the same companies", pbody)

    crow = []
    for r in result["rows"]:
        ti = r.get("tech_intel") or {}
        crow.append([r["row_id"], _label(r), r.get("group") or "",
                     Raw(badge(r["status"].replace("_", " "), STATUS_TONE.get(r["status"], "neutral"))),
                     ti.get("retrieved"), ti.get("total"), ti.get("complete"),
                     r.get("status_reason") or r.get("reason") or "",
                     r.get("duplicate_of") or r.get("same_company_as") or ""])
    report.add("Companies", "Each company in the cohort",
               table(["Row", "Company", "Group", "Status", "Retrieved", "Total", "Complete", "Reason", "Same as row"],
                     crow)
               + (details_json("Classification conflicts as JSON", s["classification_conflicts"])
                  if s["classification_conflicts"] else ""))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
