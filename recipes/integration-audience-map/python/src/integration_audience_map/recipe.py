"""Integration audience map: which companies in your list show the technologies you integrate with.

Workflow for each row:
1. Take the company identifier: `company_id` when filled, otherwise the normalised `domain`.
2. Read Tech Intel (GET /tech-intel) without evidence, following next_cursor up to max_pages pages.
3. Match every retrieved technology against each configured target using only explicit product
   slugs, vendor slugs and exact, case-insensitive aliases of the product or vendor name.
4. Keep a match only when its confidence and recency meet min_confidence and max_recency.
5. Build one measure per target, and for the match rule, over the unique companies in the list.

Target results per company:
- observed: a retrieved technology matched the target and met the thresholds;
- not_observed: no qualifying match, and every page of the technology list was retrieved;
- not_observed_in_pages_retrieved: no qualifying match, but the technology list is incomplete.
"Not observed" means not observed in retrieved data. It never means the company does not use it.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import FATAL_KINDS, PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, details_json, esc, kv, note, table

NAME = "integration-audience-map"
TITLE = "Integration audience map"
DESCRIPTION = ("Shows which companies in the list you supply have the technologies you integrate with in their "
               "Firmable Tech Intel, with confidence, recency and last observed date, and counts each target "
               "across the list with its denominator.")

CONFIDENCE_RANK = {"low": 1, "medium": 2, "high": 3}
RECENCY_RANK = {"30d": 1, "90d": 2, "older": 3}
STATUS_TONE = {"matched": "good", "not_observed": "neutral", "not_observed_incomplete": "review",
               "no_data": "unknown", "invalid_input": "error", "access_denied": "error",
               "error": "error", "not_processed": "unknown"}
RESULT_TONE = {"observed": "good", "not_observed": "neutral", "not_observed_in_pages_retrieved": "review"}
RESULT_TEXT = {
    "observed": "Observed in retrieved data.",
    "not_observed": "Not observed in retrieved data.",
    "not_observed_in_pages_retrieved": "Not observed in the pages retrieved. The technology list is incomplete.",
}
STOP_TEXT = {
    "page_limit": "the page limit was reached",
    "error": "a later page failed",
    "budget": "the credit limit was reached",
    "repeated_cursor": "the API returned a cursor it had already returned",
}
TECH_KEYS = ["product", "product_slug", "vendor", "vendor_slug", "filter", "filter_slug", "category",
             "category_slug", "pillar_slug", "confidence", "recency", "last_observed", "nature"]
OUTCOMES = ["observed", "not_observed", "not_observed_in_pages_retrieved", "no_data", "error", "not_processed"]
FRAMING = ("This is audience research within the list you supplied. An observed technology is not proof of demand "
           "for an integration, of compatibility with your product, or of buying intent.")
NO_SEGMENT = "(no segment)"

_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TOP_KEYS = {"targets", "match", "min_confidence", "max_recency", "max_pages", "min_answered"}
_TARGET_KEYS = {"id", "label", "product_slugs", "vendor_slugs", "aliases"}
MAX_TARGETS = 50
MAX_PAGES_LIMIT = 25


# ----- configuration and input ---------------------------------------------------------------

def _rank(ranks: dict[str, int], value: Any, default: int) -> int:
    return ranks.get(value, default) if isinstance(value, str) else default


def _text_list(value: Any, where: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ConfigError(f"{where} must be a list of non-empty text values.")
    return [v.strip() for v in value]


def _whole(raw: dict[str, Any], key: str, default: int, low: int, high: int | None) -> int:
    v = raw.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or v < low or (high is not None and v > high):
        span = f"from {low} to {high}" if high is not None else f"of {low} or more"
        raise ConfigError(f"{key} must be a whole number {span}.")
    return v


def _choice(raw: dict[str, Any], key: str, default: str, allowed: list[str]) -> str:
    v = raw.get(key, default)
    if not isinstance(v, str) or v not in allowed:
        raise ConfigError(f"{key} must be one of: {', '.join(allowed)}.")
    return v


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    targets_raw = raw.get("targets")
    if not isinstance(targets_raw, list) or not targets_raw:
        raise ConfigError("targets must be a non-empty list.")
    if len(targets_raw) > MAX_TARGETS:
        raise ConfigError(f"targets can hold at most {MAX_TARGETS} items.")
    targets: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, t in enumerate(targets_raw, start=1):
        if not isinstance(t, dict):
            raise ConfigError(f"targets[{i}] must be an object.")
        extra = sorted(set(t) - _TARGET_KEYS)
        if extra:
            raise ConfigError(f"targets[{i}] has unknown key(s): {', '.join(extra)}")
        tid = t.get("id")
        if not isinstance(tid, str) or not _ID.match(tid):
            raise ConfigError(f"targets[{i}].id must be 1 to 40 lower-case letters, digits or underscores.")
        if tid in seen:
            raise ConfigError(f"targets[{i}].id {tid!r} is used twice.")
        seen.add(tid)
        label = t.get("label", tid)
        if not isinstance(label, str) or not label.strip():
            raise ConfigError(f"targets[{i}].label must be text.")
        m = {k: _text_list(t.get(k), f"targets[{i}].{k}") for k in ("product_slugs", "vendor_slugs", "aliases")}
        if not (m["product_slugs"] or m["vendor_slugs"] or m["aliases"]):
            raise ConfigError(f"targets[{i}] needs at least one product slug, vendor slug or alias.")
        targets.append({"id": tid, "label": label.strip(), **m})
    return {
        "targets": targets,
        "match": _choice(raw, "match", "any", ["any", "all"]),
        "min_confidence": _choice(raw, "min_confidence", "low", ["low", "medium", "high"]),
        "max_recency": _choice(raw, "max_recency", "older", ["older", "90d", "30d"]),
        "max_pages": _whole(raw, "max_pages", 5, 1, MAX_PAGES_LIMIT),
        "min_answered": _whole(raw, "min_answered", 5, 1, None),
    }


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["domain", "company_id"])


def company_ref(row: dict[str, str]) -> tuple[str | None, dict[str, str] | None, str | None]:
    """Returns (key, Tech Intel identifier, problem). company_id wins over domain when both are filled."""
    cid = row.get("company_id") or ""
    if cid:
        if not _COMPANY_ID.match(cid):
            return None, None, f'company_id "{cid}" is not a valid Firmable company ID.'
        return f"id:{cid}", {"id": cid}, None
    raw = row.get("domain") or ""
    d = normalise_domain(raw)
    if not d:
        return None, None, f'domain "{raw}" is not a valid domain.'
    return f"fqdn:{d}", {"fqdn": d}, None


def _unique_keys(rows: list[dict[str, str]]) -> list[str]:
    out: list[str] = []
    for r in rows:
        key = company_ref(r)[0]
        if key and key not in out:
            out.append(key)
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_unique_keys(rows))
    pages = config["max_pages"]
    return [PlannedCall("GET /tech-intel", f"Up to {pages} page(s) of Tech Intel for each unique valid company",
                        n * pages, [("tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n))])]


# ----- matching ------------------------------------------------------------------------------

def _t(value: Any) -> str:
    return "not returned" if value is None else str(value)


def match_basis(item: dict[str, Any], target: dict[str, Any]) -> list[str]:
    basis: list[str] = []
    if isinstance(item.get("product_slug"), str) and item["product_slug"] in target["product_slugs"]:
        basis.append(f"product_slug {item['product_slug']}")
    if isinstance(item.get("vendor_slug"), str) and item["vendor_slug"] in target["vendor_slugs"]:
        basis.append(f"vendor_slug {item['vendor_slug']}")
    aliases = [a.lower() for a in target["aliases"]]
    for field in ("product", "vendor"):
        value = item.get(field)
        if isinstance(value, str) and value.strip().lower() in aliases:
            basis.append(f"alias of {field} name {value}")
    return basis


def threshold_misses(item: dict[str, Any], min_confidence: str, max_recency: str) -> list[str]:
    """Reasons an item fails the thresholds. A value the docs do not define fails any threshold above the lowest."""
    misses: list[str] = []
    if min_confidence != "low" and _rank(CONFIDENCE_RANK, item.get("confidence"), 0) < CONFIDENCE_RANK[min_confidence]:
        misses.append(f"confidence {_t(item.get('confidence'))} is below {min_confidence}")
    if max_recency != "older" and _rank(RECENCY_RANK, item.get("recency"), 99) > RECENCY_RANK[max_recency]:
        misses.append(f"recency {_t(item.get('recency'))} is older than {max_recency}")
    return misses


def technology(item: dict[str, Any]) -> dict[str, Any]:
    return {k: item.get(k) for k in TECH_KEYS}


# ----- Tech Intel retrieval ------------------------------------------------------------------

def _record_error(ctx: RunContext, row_id: str | None, err: dict[str, Any], stop: bool = False) -> dict[str, Any]:
    entry = {"row_id": row_id, **err}
    ctx.errors.append(entry)
    if (stop or err.get("kind") in FATAL_KINDS) and ctx.stopped is None:
        ctx.stopped = entry
    return entry


def fetch(ctx: RunContext, memo: dict[str, Any], key: str, identifier: dict[str, str], row_id: str,
          max_pages: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Reads Tech Intel once per company key. A repeated key reuses the first result, errors included."""
    if key in memo:
        return memo[key]
    ti = ctx.client.get_tech_intel(identifier, with_evidence=False, max_pages=max_pages)
    err = ti["error"]
    entry = _record_error(ctx, row_id, err, stop=err.get("kind") == "forbidden") if err else None
    items = [i for i in ti["items"] if isinstance(i, dict)]
    info = {"company_id": ti["id"], "total": ti["total"], "retrieved": len(items),
            "pages_fetched": ti["pages_fetched"], "complete": ti["complete"], "stop_reason": ti["stop_reason"],
            "error": entry}
    memo[key] = (info, items)
    return memo[key]


def unavailable(info: dict[str, Any]) -> tuple[str, str] | None:
    """The status and reason when there is nothing to match against, otherwise None."""
    err = info["error"] or {}
    if info["pages_fetched"] == 0:
        if err.get("kind") == "not_found":
            return "no_data", "Tech Intel has no company for this identifier (404)."
        if err.get("kind") == "forbidden":
            return "access_denied", ("Firmable returned 403 Forbidden for Tech Intel. This API key cannot "
                                     "use this endpoint. The run stops, because later requests would be refused too.")
        return "error", f"Tech Intel could not be read: {err.get('message')}"
    if info["complete"] and info["retrieved"] == 0:
        return "no_data", "Firmable holds no technology data for this company (total 0)."
    return None


def incomplete_text(info: dict[str, Any]) -> str:
    total = info["total"]
    total_text = str(total) if isinstance(total, int) else "an unknown number of"
    why = STOP_TEXT.get(info["stop_reason"], info["stop_reason"])
    return (f"The technology list is incomplete because {why}: {info['retrieved']} of {total_text} "
            f"technologies were retrieved in {info['pages_fetched']} page(s).")


def data_notes(info: dict[str, Any], items: list[dict[str, Any]]) -> list[str]:
    """Inconsistencies in the returned data. They are reported, not corrected."""
    notes: list[str] = []
    total = info["total"]
    if info["complete"] and isinstance(total, int) and total != len(items):
        notes.append(f"The API reported a total of {total} technologies but returned {len(items)} across all pages.")
    first_conf: dict[str, Any] = {}
    conflicting: list[str] = []
    for it in items:
        slug = it.get("product_slug")
        if not isinstance(slug, str):
            continue
        if slug in first_conf and first_conf[slug] != it.get("confidence") and slug not in conflicting:
            conflicting.append(slug)
        first_conf.setdefault(slug, it.get("confidence"))
    for slug in conflicting:
        notes.append(f"Product {slug} appears more than once with different confidence values. Each entry is "
                     "shown as returned.")
    unnamed = sum(1 for it in items if not it.get("product") and not it.get("product_slug"))
    if unnamed:
        notes.append(f"{unnamed} technology item(s) have no product name or product slug, so they cannot match "
                     "a target.")
    return notes


# ----- measures ------------------------------------------------------------------------------

def pct(n: int, d: int) -> float:
    """n over d as a percentage rounded half up to one decimal, identical in Python and TypeScript."""
    return math.floor(n * 1000 / d + 0.5) / 10


def measure(outcomes: list[str], min_answered: int) -> dict[str, Any]:
    counts = {k: 0 for k in OUTCOMES}
    below = 0
    for o in outcomes:
        name, _, flag = o.partition("+")
        counts[name] += 1
        if flag == "below":
            below += 1
    answered = counts["observed"] + counts["not_observed"]
    with_data = answered + counts["not_observed_in_pages_retrieved"]
    observed_share = ({"numerator": counts["observed"], "denominator": answered,
                       "percent": pct(counts["observed"], answered)} if answered else None)
    unknown_share = ({"numerator": counts["not_observed_in_pages_retrieved"], "denominator": with_data,
                      "percent": pct(counts["not_observed_in_pages_retrieved"], with_data)} if with_data else None)
    enough = answered >= min_answered
    if not enough:
        text = f"Too few answers to compare: {answered} answered, {min_answered} needed."
    else:
        text = (f"Observed at {counts['observed']} of {answered} answered companies in this cohort "
                f"({observed_share['percent']:.1f}%).")
    if unknown_share and unknown_share["numerator"]:
        text += (f" {unknown_share['numerator']} of {with_data} companies with data had an incomplete list "
                 f"({unknown_share['percent']:.1f}%) and are not counted as answered.")
    return {"companies_in_cohort": len(outcomes), "companies_asked": len(outcomes) - counts["not_processed"],
            **counts, "observed_below_threshold": below, "answered": answered,
            "observed_share": observed_share, "unknown_share": unknown_share, "enough_answers": enough,
            "text": text}


def _target_outcome(row: dict[str, Any], tid: str) -> str:
    if row["status"] == "access_denied":
        return "error"
    if row["status"] in ("no_data", "error", "not_processed"):
        return row["status"]
    t = next(x for x in row["targets"] if x["target_id"] == tid)
    return t["result"] + ("+below" if t["below_threshold"] else "")


def _audience_outcome(row: dict[str, Any]) -> str:
    status = row["status"]
    if status == "access_denied":
        return "error"
    if status in ("no_data", "error", "not_processed"):
        return status
    return {"matched": "observed", "not_observed": "not_observed",
            "not_observed_incomplete": "not_observed_in_pages_retrieved"}[status]


def _measures(rows: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "audience": measure([_audience_outcome(r) for r in rows], cfg["min_answered"]),
        "by_target": {t["id"]: measure([_target_outcome(r, t["id"]) for r in rows], cfg["min_answered"])
                      for t in cfg["targets"]},
    }


# ----- run -----------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    coverage = [
        "The cohort is the input file you supplied. The REST API has no company search and no reverse lookup "
        "by technology, so this recipe cannot find companies outside your list.",
        FRAMING,
        "A target that was not matched is not observed in retrieved data. This does not mean the company "
        "does not use it.",
        "Matching uses only the product slugs, vendor slugs and exact aliases in the configuration. There is "
        "no fuzzy matching.",
        "Each measure counts unique companies, not input rows. A share is observed over answered companies "
        "(observed plus not observed in a complete list); incomplete lists, no data and errors are counted "
        "beside it, not in it.",
    ]
    if cfg["min_confidence"] != "low" or cfg["max_recency"] != "older":
        coverage.append(f"Only technologies with confidence {cfg['min_confidence']} or higher and recency "
                        f"{cfg['max_recency']} or newer count as observed. Matches below these thresholds are "
                        "listed separately.")
    memo: dict[str, Any] = {}
    first_row: dict[str, str] = {}
    first_company: dict[str, str] = {}
    has_segment = any("segment" in r for r in ctx.rows)

    def one(row: dict[str, str]) -> dict[str, Any]:
        key, identifier, problem = company_ref(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "company_key": key,
                                "segment": (row.get("segment") or NO_SEGMENT) if has_segment else None,
                                "duplicate_of": None, "same_company_as": None, "tech_intel": None,
                                "targets": [], "data_notes": []}
        if problem or key is None or identifier is None:
            return {**base, "status": "invalid_input", "status_reason": problem}
        if key in first_row:
            base["duplicate_of"] = first_row[key]
        else:
            first_row[key] = row["row_id"]
        info, items = fetch(ctx, memo, key, identifier, row["row_id"], cfg["max_pages"])
        base["tech_intel"] = info
        fid = info["company_id"]
        if isinstance(fid, str) and fid and base["duplicate_of"] is None:
            if fid in first_company:
                base["same_company_as"] = first_company[fid]
            else:
                first_company[fid] = row["row_id"]
        gone = unavailable(info)
        if gone:
            return {**base, "status": gone[0], "status_reason": gone[1]}

        complete = info["complete"]
        base["data_notes"] = data_notes(info, items)
        targets_out = []
        for t in cfg["targets"]:
            matches, below = [], []
            for item in items:
                basis = match_basis(item, t)
                if not basis:
                    continue
                misses = threshold_misses(item, cfg["min_confidence"], cfg["max_recency"])
                entry = {"match_basis": basis, "technology": technology(item)}
                if misses:
                    below.append({**entry, "threshold_misses": misses})
                else:
                    matches.append(entry)
            result = "observed" if matches else ("not_observed" if complete else "not_observed_in_pages_retrieved")
            targets_out.append({"target_id": t["id"], "label": t["label"], "result": result,
                                "result_text": RESULT_TEXT[result], "matches": matches, "below_threshold": below})
        base["targets"] = targets_out

        observed = [t for t in targets_out if t["result"] == "observed"]
        n = len(targets_out)
        met = len(observed) == n if cfg["match"] == "all" else bool(observed)
        tail = "" if complete else " " + incomplete_text(info)
        labels = ", ".join(t["label"] for t in observed)
        seen_text = f"{len(observed)} of {n} target(s) observed in retrieved data" + (f": {labels}." if observed else ".")
        rule = "all targets" if cfg["match"] == "all" else "at least one target"
        if met:
            return {**base, "status": "matched", "status_reason": f"{seen_text} The match rule needs {rule}.{tail}"}
        if complete:
            return {**base, "status": "not_observed",
                    "status_reason": f"{seen_text} The match rule needs {rule}. All technologies were retrieved."}
        return {**base, "status": "not_observed_incomplete",
                "status_reason": f"{seen_text} The match rule needs {rule}.{tail}"}

    rows = ctx.run_rows(ctx.rows, one)

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    seen_keys: set[str] = set()
    unique: list[dict[str, Any]] = []
    for r, src in zip(rows, ctx.rows):
        key = r.get("company_key") if "company_key" in r else company_ref(src)[0]
        if not key or r.get("status") == "invalid_input" or key in seen_keys or r.get("same_company_as"):
            continue
        seen_keys.add(key)
        unique.append({**r, "segment": r.get("segment") if "segment" in r else
                       ((src.get("segment") or NO_SEGMENT) if has_segment else None)})
    summary: dict[str, Any] = {
        "status_counts": counts,
        "rows": len(rows),
        "invalid_rows": counts.get("invalid_input", 0),
        "repeated_rows": sum(1 for r in rows if r.get("duplicate_of") or r.get("same_company_as")),
        "unique_companies": len(unique),
        "match_rule": cfg["match"],
        **_measures(unique, cfg),
    }
    if has_segment:
        groups: dict[str, list[dict[str, Any]]] = {}
        for r in unique:
            groups.setdefault(r["segment"], []).append(r)
        summary["by_segment"] = {g: _measures(rs, cfg) for g, rs in groups.items()}
    if summary["repeated_rows"]:
        coverage.append(f"{summary['repeated_rows']} row(s) repeat a company already in the list. A repeated "
                        "identifier reuses the earlier response, and each company is counted once.")
    incomplete = sum(1 for r in unique if r["status"] == "not_observed_incomplete"
                     or (r["status"] == "matched" and not (r["tech_intel"] or {}).get("complete")))
    if incomplete:
        coverage.append(f"{incomplete} company(ies) have an incomplete technology list (max_pages is "
                        f"{cfg['max_pages']}). Targets not matched for them are not observed in the pages retrieved.")
    noted = sum(1 for r in rows if r.get("data_notes"))
    if noted:
        coverage.append(f"{noted} row(s) have inconsistencies in the returned Tech Intel data. They are shown as "
                        "returned and not corrected.")
    return {"rows": rows, "summary": summary, "coverage": coverage}


# ----- outputs -------------------------------------------------------------------------------

def _s(value: Any) -> str:
    return "" if value is None else str(value)


CSV_COLUMNS = ["row_id", "domain", "company_id", "segment", "duplicate_of", "same_company_as", "status",
               "status_reason", "firmable_id", "technologies_total", "technologies_retrieved", "list_complete",
               "targets_observed", "target_results", "matched_technologies", "below_threshold", "data_notes"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        targets = r.get("targets") or []
        ti = r.get("tech_intel") or {}
        inp = r["input"]
        matched, below = [], []
        for t in targets:
            for m in t["matches"]:
                tech = m["technology"]
                matched.append(f"{t['target_id']}:{_s(tech.get('product'))}({_s(tech.get('confidence'))},"
                               f"{_s(tech.get('recency'))},{_s(tech.get('last_observed'))})")
            for m in t["below_threshold"]:
                tech = m["technology"]
                below.append(f"{t['target_id']}:{_s(tech.get('product'))}({_s(tech.get('confidence'))},"
                             f"{_s(tech.get('recency'))})")
        out.append({
            "row_id": r["row_id"], "domain": inp.get("domain"), "company_id": inp.get("company_id"),
            "segment": r.get("segment"), "duplicate_of": r.get("duplicate_of"),
            "same_company_as": r.get("same_company_as"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "firmable_id": ti.get("company_id"), "technologies_total": ti.get("total"),
            "technologies_retrieved": ti.get("retrieved"), "list_complete": ti.get("complete"),
            "targets_observed": [t["target_id"] for t in targets if t["result"] == "observed"],
            "target_results": [f"{t['target_id']}={t['result']}" for t in targets],
            "matched_technologies": matched, "below_threshold": below, "data_notes": r.get("data_notes") or [],
        })
    return out


def _share(s: dict[str, Any] | None) -> str:
    return "none answered" if not s else f"{s['numerator']} of {s['denominator']} ({s['percent']:.1f}%)"


def _measure_rows(measures: dict[str, Any], labels: dict[str, str], cfg: dict[str, Any]) -> list[list[Any]]:
    rows = []
    entries = [("audience", f"Match rule ({cfg['match']})", measures["audience"])]
    entries += [(tid, labels[tid], m) for tid, m in measures["by_target"].items()]
    for _, label, m in entries:
        share = _share(m["observed_share"]) if m["enough_answers"] else "too few answers to compare"
        rows.append([label, m["companies_in_cohort"], m["companies_asked"], m["observed"], m["not_observed"],
                     m["not_observed_in_pages_retrieved"], m["observed_below_threshold"], m["no_data"], m["error"],
                     share, _share(m["unknown_share"])])
    return rows


MEASURE_HEADERS = ["Measure", "Companies", "Asked", "Observed", "Not observed", "Not observed in pages retrieved",
                   "Below threshold", "No data", "Error", "Observed share of answered", "Incomplete share"]


def render(report: Any, result: dict[str, Any]) -> None:
    summary = result["summary"]
    cfg = result["input"]["config"]
    labels = {t["id"]: t["label"] for t in cfg["targets"]}
    counts = summary.get("status_counts", {})
    report.add("Result", "Audience in this list",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + note(esc(FRAMING), "unknown")
               + kv([("Input rows", summary.get("rows")), ("Unique companies", summary.get("unique_companies")),
                     ("Rows repeating a company", summary.get("repeated_rows")),
                     ("Invalid rows", summary.get("invalid_rows")), ("Match rule", summary.get("match_rule"))]))
    if "audience" in summary:
        body = table(MEASURE_HEADERS, _measure_rows(summary, labels, cfg))
        body += "<p class=\"muted\">Counts are unique companies in this cohort. Below threshold is a subset of not " \
                "observed and not observed in pages retrieved.</p>"
        report.add("Measures", "Each target across this cohort", body)
    if summary.get("by_segment"):
        body = ""
        for seg, ms in summary["by_segment"].items():
            body += f"<h3>{esc(seg)}</h3>" + table(MEASURE_HEADERS, _measure_rows(ms, labels, cfg))
        report.add("Segments", "Each target by segment", body)
    rows_html = []
    details = ""
    for r in result["rows"]:
        targets = r.get("targets") or []
        name = r["input"].get("company_name") or r["input"].get("domain") or r["input"].get("company_id") or r["row_id"]
        observed = []
        for t in targets:
            for m in t["matches"]:
                tech = m["technology"]
                observed.append(f"{t['label']}: {_t(tech.get('product'))} ({_t(tech.get('confidence'))}, "
                                f"{_t(tech.get('recency'))}, last observed {_t(tech.get('last_observed'))})")
        reason = r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message") or ""
        notes = "".join(note(esc(n), "unknown") for n in r.get("data_notes") or [])
        rows_html.append([r["row_id"], name, Raw(badge(r["status"].replace("_", " "), STATUS_TONE.get(r["status"], "neutral"))),
                          Raw("<br>".join(esc(o) for o in observed) or "<span class=\"muted\">none</span>"),
                          Raw(esc(reason) + notes)])
        if targets:
            details += details_json(f"Row {r['row_id']}: target results as JSON", targets)
    report.add("Companies", "Each company in input order",
               table(["Row", "Company", "Status", "Observed targets", "Reason"], rows_html) + details)


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
