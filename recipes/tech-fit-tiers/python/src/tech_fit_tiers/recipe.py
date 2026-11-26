"""Tech fit tiers: assigns each account a sales tier from fixed rules over its observed technologies.

Workflow for each row:
1. Take the company identifier: `company_id` when filled, otherwise the normalised `domain`.
2. Read Tech Intel (GET /tech-intel), with evidence when configured, following next_cursor up to max_pages.
3. Check each configured signal: explicit product, vendor or category slugs, or exact aliases of the
   product or vendor name, at or above the signal's min_confidence.
4. Check the tiers in order. The first tier whose conditions are met is assigned.

Signal results:
- observed: a retrieved technology matched the signal at or above its min_confidence;
- not_observed: no qualifying match, and every page of the technology list was retrieved;
- not_observed_in_pages_retrieved: no qualifying match, but the technology list is incomplete.
An unknown signal never satisfies a condition. A `none` condition is met only on a complete list.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import FATAL_KINDS, PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, card, details_json, esc, kv, note, table

NAME = "tech-fit-tiers"
TITLE = "Tech fit tiers"
DESCRIPTION = ("Assigns each account a sales tier from fixed rules over the technologies observed in its Firmable "
               "Tech Intel, and shows the signals and technology facts behind each tier.")

CONFIDENCE_RANK = {"low": 1, "medium": 2, "high": 3}
STATUS_TONE = {"tier_assigned": "good", "no_tier": "neutral", "needs_review": "review", "no_data": "unknown",
               "invalid_input": "error", "access_denied": "error", "error": "error", "not_processed": "unknown"}
SIGNAL_TONE = {"observed": "good", "not_observed": "neutral", "not_observed_in_pages_retrieved": "review"}
TIER_TONE = {"met": "good", "not_met": "neutral", "undetermined": "review"}
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
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TOP_KEYS = {"signals", "tiers", "max_pages", "with_evidence"}
_SIGNAL_KEYS = {"id", "label", "product_slugs", "vendor_slugs", "category_slugs", "aliases", "min_confidence"}
_TIER_KEYS = {"id", "label", "when"}
_WHEN_KEYS = ("all", "any", "none")
MAX_SIGNALS = 30
MAX_TIERS = 10
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


def _id_label(item: dict[str, Any], where: str, seen: set[str]) -> tuple[str, str]:
    iid = item.get("id")
    if not isinstance(iid, str) or not _ID.match(iid):
        raise ConfigError(f"{where}.id must be 1 to 40 lower-case letters, digits or underscores.")
    if iid in seen:
        raise ConfigError(f"{where}.id {iid!r} is used twice.")
    seen.add(iid)
    label = item.get("label", iid)
    if not isinstance(label, str) or not label.strip():
        raise ConfigError(f"{where}.label must be text.")
    return iid, label.strip()


def load_signal(s: Any, where: str, seen: set[str]) -> dict[str, Any]:
    if not isinstance(s, dict):
        raise ConfigError(f"{where} must be an object.")
    extra = sorted(set(s) - _SIGNAL_KEYS)
    if extra:
        raise ConfigError(f"{where} has unknown key(s): {', '.join(extra)}")
    sid, label = _id_label(s, where, seen)
    m = {k: _text_list(s.get(k), f"{where}.{k}")
         for k in ("product_slugs", "vendor_slugs", "category_slugs", "aliases")}
    if not any(m.values()):
        raise ConfigError(f"{where} needs at least one product slug, vendor slug, category slug or alias.")
    mc = s.get("min_confidence", "low")
    if _rank(CONFIDENCE_RANK, mc, 0) == 0:
        raise ConfigError(f"{where}.min_confidence must be one of: low, medium, high.")
    return {"id": sid, "label": label, **m, "min_confidence": mc}


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    signals_raw = raw.get("signals")
    if not isinstance(signals_raw, list) or not signals_raw:
        raise ConfigError("signals must be a non-empty list.")
    if len(signals_raw) > MAX_SIGNALS:
        raise ConfigError(f"signals can hold at most {MAX_SIGNALS} items.")
    seen: set[str] = set()
    signals = [load_signal(s, f"signals[{i}]", seen) for i, s in enumerate(signals_raw, start=1)]
    tiers_raw = raw.get("tiers")
    if not isinstance(tiers_raw, list) or not tiers_raw:
        raise ConfigError("tiers must be a non-empty list.")
    if len(tiers_raw) > MAX_TIERS:
        raise ConfigError(f"tiers can hold at most {MAX_TIERS} items.")
    tier_seen: set[str] = set()
    tiers = []
    for i, t in enumerate(tiers_raw, start=1):
        where = f"tiers[{i}]"
        if not isinstance(t, dict):
            raise ConfigError(f"{where} must be an object.")
        extra = sorted(set(t) - _TIER_KEYS)
        if extra:
            raise ConfigError(f"{where} has unknown key(s): {', '.join(extra)}")
        tid, label = _id_label(t, where, tier_seen)
        when = t.get("when")
        if not isinstance(when, dict):
            raise ConfigError(f"{where}.when must be an object.")
        extra = sorted(set(when) - set(_WHEN_KEYS))
        if extra:
            raise ConfigError(f"{where}.when has unknown key(s): {', '.join(extra)}")
        w = {k: _text_list(when.get(k), f"{where}.when.{k}") for k in _WHEN_KEYS}
        if not any(w.values()):
            raise ConfigError(f"{where}.when needs at least one signal in all, any or none.")
        for k in _WHEN_KEYS:
            missing = [x for x in w[k] if x not in seen]
            if missing:
                raise ConfigError(f"{where}.when.{k} names unknown signal(s): {', '.join(missing)}")
        both = [x for x in w["none"] if x in w["all"] or x in w["any"]]
        if both:
            raise ConfigError(f"{where}.when uses signal(s) in none and in all or any: {', '.join(both)}")
        tiers.append({"id": tid, "label": label, "when": w})
    for key in ("with_evidence",):
        if not isinstance(raw.get(key, False), bool):
            raise ConfigError(f"{key} must be true or false.")
    max_pages = raw.get("max_pages", 5)
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or not 1 <= max_pages <= MAX_PAGES_LIMIT:
        raise ConfigError(f"max_pages must be a whole number from 1 to {MAX_PAGES_LIMIT}.")
    return {"signals": signals, "tiers": tiers, "max_pages": max_pages,
            "with_evidence": raw.get("with_evidence", False)}


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


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    keys: list[str] = []
    for r in rows:
        key = company_ref(r)[0]
        if key and key not in keys:
            keys.append(key)
    n = len(keys)
    pages = config["max_pages"]
    parts = [("tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n))]
    if config["with_evidence"]:
        parts.append(("tech_intel_evidence", pricing.round4(pricing.TECH_INTEL_EVIDENCE_REQUEST * n * pages)))
    return [PlannedCall("GET /tech-intel", f"Up to {pages} page(s) of Tech Intel for each unique valid company",
                        n * pages, parts)]


# ----- matching ------------------------------------------------------------------------------

def _t(value: Any) -> str:
    return "not returned" if value is None else str(value)


def match_basis(item: dict[str, Any], sig: dict[str, Any]) -> list[str]:
    basis: list[str] = []
    for field, key in (("product_slug", "product_slugs"), ("vendor_slug", "vendor_slugs"),
                       ("category_slug", "category_slugs")):
        if isinstance(item.get(field), str) and item[field] in sig[key]:
            basis.append(f"{field} {item[field]}")
    aliases = [a.lower() for a in sig["aliases"]]
    for field in ("product", "vendor"):
        value = item.get(field)
        if isinstance(value, str) and value.strip().lower() in aliases:
            basis.append(f"alias of {field} name {value}")
    return basis


def technology(item: dict[str, Any]) -> dict[str, Any]:
    return {k: item.get(k) for k in TECH_KEYS}


def evidence(item: dict[str, Any], with_evidence: bool) -> dict[str, Any]:
    """The evidence fields as returned, with counts of records that have no source location."""
    if not with_evidence:
        return {"status": "not_requested"}
    ev = item.get("evidence_detail")
    if not isinstance(ev, dict):
        return {"status": "none_returned", "notes": ["No evidence was returned for this technology."]}
    records = [r for r in ev.get("records") or [] if isinstance(r, dict)]
    no_location = sum(1 for r in records if not isinstance(r.get("location"), str) or not r["location"].strip())
    by_type = [t for t in ev.get("evidence_by_type") or [] if isinstance(t, dict)]
    capped = [t["type"] for t in by_type if t.get("capped") is True and isinstance(t.get("type"), str)]
    count = ev.get("evidence_count")
    notes: list[str] = []
    if no_location:
        notes.append(f"{no_location} evidence record(s) have no source location.")
    if isinstance(count, int) and len(records) < count:
        notes.append(f"{len(records)} of {count} evidence record(s) are listed.")
    if capped:
        notes.append(f"The source reported more evidence than it sent for: {', '.join(capped)}. Those counts are "
                     "minimums.")
    return {"status": "returned", "confidence": ev.get("confidence"), "first_seen": ev.get("first_seen"),
            "last_seen": ev.get("last_seen"), "evidence_count": count, "evidence_by_type": by_type,
            "records_listed": len(records), "records_without_location": no_location, "capped_types": capped,
            "records": records, "notes": notes}


def check_signal(sig: dict[str, Any], items: list[dict[str, Any]], complete: bool,
                 with_evidence: bool) -> dict[str, Any]:
    matches, below = [], []
    for item in items:
        basis = match_basis(item, sig)
        if not basis:
            continue
        entry = {"match_basis": basis, "technology": technology(item)}
        if _rank(CONFIDENCE_RANK, item.get("confidence"), 0) < CONFIDENCE_RANK[sig["min_confidence"]]:
            below.append({**entry, "threshold_miss": f"confidence {_t(item.get('confidence'))} is below "
                                                     f"{sig['min_confidence']}"})
        else:
            matches.append({**entry, "evidence": evidence(item, with_evidence)})
    result = "observed" if matches else ("not_observed" if complete else "not_observed_in_pages_retrieved")
    return {"signal_id": sig["id"], "label": sig["label"], "result": result, "result_text": RESULT_TEXT[result],
            "matches": matches, "below_threshold": below}


# ----- tiers ---------------------------------------------------------------------------------

def condition(kind: str, ids: list[str], results: dict[str, str]) -> str:
    """yes, no or unknown for one condition list. An empty list is met."""
    if not ids:
        return "yes"
    vals = [results[i] for i in ids]
    if kind == "all":
        if "not_observed" in vals:
            return "no"
        return "yes" if all(v == "observed" for v in vals) else "unknown"
    if kind == "any":
        if "observed" in vals:
            return "yes"
        return "no" if all(v == "not_observed" for v in vals) else "unknown"
    if "observed" in vals:
        return "no"
    return "yes" if all(v == "not_observed" for v in vals) else "unknown"


def check_tier(tier: dict[str, Any], results: dict[str, str]) -> dict[str, Any]:
    conds = {k: condition(k, tier["when"][k], results) for k in _WHEN_KEYS if tier["when"][k]}
    if "no" in conds.values():
        outcome = "not_met"
    elif all(v == "yes" for v in conds.values()):
        outcome = "met"
    else:
        outcome = "undetermined"
    return {"tier_id": tier["id"], "label": tier["label"], "result": outcome, "conditions": conds}


def assign(tiers: list[dict[str, Any]], results: dict[str, str]) -> tuple[str, str, dict[str, Any] | None,
                                                                          list[str], list[dict[str, Any]]]:
    checks = [check_tier(t, results) for t in tiers]
    open_tiers: list[dict[str, Any]] = []
    for c in checks:
        if c["result"] == "met":
            if open_tiers:
                names = ", ".join(t["label"] for t in open_tiers)
                return ("needs_review",
                        f"{c['label']} applies in retrieved data, but {names} ranks higher and could not be ruled "
                        "out because the technology list is incomplete.", c, [t["tier_id"] for t in open_tiers], checks)
            return "tier_assigned", f"{c['label']} is the first tier whose conditions are met.", c, [], checks
        if c["result"] == "undetermined":
            open_tiers.append(c)
    if open_tiers:
        names = ", ".join(t["label"] for t in open_tiers)
        return ("needs_review", f"No tier is met in retrieved data. {names} could apply, because the technology "
                                "list is incomplete.", None, [t["tier_id"] for t in open_tiers], checks)
    return "no_tier", "No tier's conditions are met in a complete technology list.", None, [], checks


# ----- Tech Intel retrieval ------------------------------------------------------------------

def _record_error(ctx: RunContext, row_id: str | None, err: dict[str, Any], stop: bool = False) -> dict[str, Any]:
    entry = {"row_id": row_id, **err}
    ctx.errors.append(entry)
    if (stop or err.get("kind") in FATAL_KINDS) and ctx.stopped is None:
        ctx.stopped = entry
    return entry


def fetch(ctx: RunContext, memo: dict[str, Any], key: str, identifier: dict[str, str], row_id: str,
          max_pages: int, with_evidence: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Reads Tech Intel once per company key. A repeated key reuses the first result, errors included."""
    if key in memo:
        return memo[key]
    ti = ctx.client.get_tech_intel(identifier, with_evidence=with_evidence, max_pages=max_pages)
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
    return notes


# ----- run -----------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    coverage = [
        "Tiers come from the fixed rules in the configuration. They are not a score, a forecast or a model "
        "output.",
        "A detected technology does not prove buying intent, spend, licence count or active usage.",
        "A signal that was not matched is not observed in retrieved data. This does not mean the company does "
        "not use it.",
        "An unknown signal never satisfies a condition. A none condition is met only when the whole technology "
        "list was retrieved.",
        "Matching uses only the product, vendor and category slugs and exact aliases in the configuration. There "
        "is no fuzzy matching.",
        "Accounts come from the input file you supplied. The REST API has no company search and no reverse "
        "lookup by technology.",
    ]
    if not cfg["with_evidence"]:
        coverage.append("Evidence was not requested (with_evidence is false), so no evidence records are shown.")
    memo: dict[str, Any] = {}
    first_row: dict[str, str] = {}

    def one(row: dict[str, str]) -> dict[str, Any]:
        key, identifier, problem = company_ref(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "duplicate_of": None, "tech_intel": None,
                                "tier_id": None, "tier_label": None, "review_tiers": [], "tier_checks": [],
                                "signals": [], "data_notes": []}
        if problem or key is None or identifier is None:
            return {**base, "status": "invalid_input", "status_reason": problem}
        if key in first_row:
            base["duplicate_of"] = first_row[key]
        else:
            first_row[key] = row["row_id"]
        info, items = fetch(ctx, memo, key, identifier, row["row_id"], cfg["max_pages"], cfg["with_evidence"])
        base["tech_intel"] = info
        gone = unavailable(info)
        if gone:
            return {**base, "status": gone[0], "status_reason": gone[1]}
        complete = info["complete"]
        base["data_notes"] = data_notes(info, items)
        signals = [check_signal(s, items, complete, cfg["with_evidence"]) for s in cfg["signals"]]
        base["signals"] = signals
        results = {s["signal_id"]: s["result"] for s in signals}
        status, reason, tier, review, checks = assign(cfg["tiers"], results)
        base["tier_checks"] = checks
        base["review_tiers"] = review
        if tier is not None:
            base["tier_id"] = tier["tier_id"]
            base["tier_label"] = tier["label"]
        observed = [s["label"] for s in signals if s["result"] == "observed"]
        reason += (f" Signals observed: {', '.join(observed)}." if observed else " No signal was observed.")
        if not complete:
            reason += " " + incomplete_text(info)
        return {**base, "status": status, "status_reason": reason}

    rows = ctx.run_rows(ctx.rows, one)
    counts: dict[str, int] = {}
    tier_counts = {t["id"]: 0 for t in cfg["tiers"]}
    review_counts = {t["id"]: 0 for t in cfg["tiers"]}
    signal_counts = {s["id"]: {k: 0 for k in RESULT_TEXT} for s in cfg["signals"]}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if r["status"] == "tier_assigned":
            tier_counts[r["tier_id"]] += 1
        if r["status"] == "needs_review" and r.get("tier_id"):
            review_counts[r["tier_id"]] += 1
        for s in r.get("signals") or []:
            signal_counts[s["signal_id"]][s["result"]] += 1
    dupes = sum(1 for r in rows if r.get("duplicate_of"))
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company identifier; their API responses were reused, "
                        "not requested again.")
    review = counts.get("needs_review", 0)
    if review:
        coverage.append(f"{review} row(s) need review because an incomplete technology list left one or more "
                        f"tiers undetermined (max_pages is {cfg['max_pages']}).")
    no_loc = sum(m["evidence"].get("records_without_location", 0) for r in rows for s in r.get("signals") or []
                 for m in s["matches"])
    if no_loc:
        coverage.append(f"{no_loc} evidence record(s) have no source location. They are shown as returned.")
    noted = sum(1 for r in rows if r.get("data_notes"))
    if noted:
        coverage.append(f"{noted} row(s) have inconsistencies in the returned Tech Intel data. They are shown as "
                        "returned and not corrected.")
    summary = {"status_counts": counts, "tier_counts": tier_counts, "needs_review_candidate_counts": review_counts,
               "signal_counts": signal_counts}
    return {"rows": rows, "summary": summary, "coverage": coverage}


# ----- outputs -------------------------------------------------------------------------------

def _s(value: Any) -> str:
    return "" if value is None else str(value)


CSV_COLUMNS = ["row_id", "domain", "company_id", "company_name", "duplicate_of", "status", "status_reason",
               "tier_id", "tier_label", "review_tiers", "firmable_id", "technologies_total",
               "technologies_retrieved", "list_complete", "signals_observed", "signal_results",
               "matched_technologies", "data_notes"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        signals = r.get("signals") or []
        ti = r.get("tech_intel") or {}
        inp = r["input"]
        matched = []
        for s in signals:
            for m in s["matches"]:
                tech = m["technology"]
                matched.append(f"{s['signal_id']}:{_s(tech.get('product'))}({_s(tech.get('confidence'))},"
                               f"{_s(tech.get('recency'))},{_s(tech.get('last_observed'))})")
        out.append({
            "row_id": r["row_id"], "domain": inp.get("domain"), "company_id": inp.get("company_id"),
            "company_name": inp.get("company_name"), "duplicate_of": r.get("duplicate_of"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "tier_id": r.get("tier_id"), "tier_label": r.get("tier_label"), "review_tiers": r.get("review_tiers") or [],
            "firmable_id": ti.get("company_id"), "technologies_total": ti.get("total"),
            "technologies_retrieved": ti.get("retrieved"), "list_complete": ti.get("complete"),
            "signals_observed": [s["signal_id"] for s in signals if s["result"] == "observed"],
            "signal_results": [f"{s['signal_id']}={s['result']}" for s in signals],
            "matched_technologies": matched, "data_notes": r.get("data_notes") or [],
        })
    return out


def _evidence_html(ev: dict[str, Any]) -> str:
    if ev["status"] == "not_requested":
        return ""
    if ev["status"] == "none_returned":
        return note("No evidence was returned for this technology.", "unknown")
    html = kv([("Evidence confidence", ev.get("confidence")), ("First seen", ev.get("first_seen")),
               ("Last seen", ev.get("last_seen")), ("Evidence count", ev.get("evidence_count")),
               ("Records listed", ev.get("records_listed"))])
    for n in ev.get("notes") or []:
        html += note(esc(n), "unknown")
    recs = ev.get("records") or []
    if recs:
        html += table(["Type", "Found", "Location", "Seen", "Confidence"], [
            [rec.get("type"), rec.get("found"),
             rec.get("location") if isinstance(rec.get("location"), str) and rec["location"].strip()
             else Raw(badge("no source location", "review")),
             f"{rec.get('first_seen') or '?'} to {rec.get('last_seen') or '?'}", rec.get("confidence")]
            for rec in recs])
    return html


def render(report: Any, result: dict[str, Any]) -> None:
    summary = result["summary"]
    cfg = result["input"]["config"]
    counts = summary.get("status_counts", {})
    tier_rows = [[t["label"], (summary.get("tier_counts") or {}).get(t["id"], 0),
                  (summary.get("needs_review_candidate_counts") or {}).get(t["id"], 0),
                  ", ".join(f"{k}: {', '.join(v)}" for k, v in t["when"].items() if v)] for t in cfg["tiers"]]
    report.add("Result", "Tier summary",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + table(["Tier", "Accounts assigned", "Needs review with this candidate", "Rule"], tier_rows)
               + note("Tiers follow the fixed rules in the configuration. A detected technology does not prove "
                      "buying intent. Not observed means not observed in retrieved data.", "unknown"))
    cards = []
    for r in result["rows"]:
        status = r["status"]
        inp = r["input"]
        title = inp.get("company_name") or inp.get("domain") or inp.get("company_id") or r["row_id"]
        reason = r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message") or ""
        left = f"<p>{esc(reason)}</p>"
        if r.get("tier_label"):
            left += kv([("Tier", r["tier_label"])])
        if r.get("tier_checks"):
            left += table(["Tier", "Result", "Conditions"], [
                [c["label"], Raw(badge(c["result"].replace("_", " "), TIER_TONE.get(c["result"], "neutral"))),
                 ", ".join(f"{k}: {v}" for k, v in c["conditions"].items())] for c in r["tier_checks"]])
        ti = r.get("tech_intel")
        if ti:
            left += kv([("Firmable ID", ti.get("company_id")), ("Technologies in Firmable", ti.get("total")),
                        ("Technologies retrieved", ti.get("retrieved")), ("List complete", ti.get("complete"))])
        for n in r.get("data_notes") or []:
            left += note(esc(n), "unknown")
        if r.get("duplicate_of"):
            left += note(f"Same company as row {esc(r['duplicate_of'])}; responses were reused.", "info")
        right = ""
        signals = r.get("signals") or []
        if signals:
            right += table(["Signal", "Result"], [
                [s["label"], Raw(badge(s["result"].replace("_", " "), SIGNAL_TONE.get(s["result"], "neutral")))]
                for s in signals])
            for s in signals:
                for m in s["matches"]:
                    tech = m["technology"]
                    right += (f"<h3>{esc(s['label'])}: {esc(tech.get('product'))}</h3>"
                              + kv([("Vendor", tech.get("vendor")), ("Category", tech.get("category")),
                                    ("Confidence", tech.get("confidence")), ("Recency", tech.get("recency")),
                                    ("Last observed", tech.get("last_observed")), ("Nature", tech.get("nature")),
                                    ("Matched by", "; ".join(m["match_basis"]))])
                              + _evidence_html(m["evidence"]))
                for m in s["below_threshold"]:
                    right += note(esc(f"{s['label']}: {_t(m['technology'].get('product'))} was matched but not "
                                      f"counted: {m['threshold_miss']}."), "unknown")
            right += details_json("Signals as JSON", signals)
        cards.append(card(title, badge(status.replace("_", " "), STATUS_TONE.get(status, "neutral")), left,
                          right or "<p class=\"muted\">No Tech Intel was retrieved for this row.</p>",
                          sub=f"Row {r['row_id']}"))
    report.add("Accounts", "Each account with its tier and signals", "".join(cards))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
