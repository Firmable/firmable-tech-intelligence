"""Stack talk tracks: suggested talking points from fixed templates and each account's observed technologies.

Workflow for each row:
1. Take the company identifier: `company_id` when filled, otherwise the normalised `domain`.
2. Read Tech Intel (GET /tech-intel) without evidence, following next_cursor up to max_pages pages.
3. For each track, find the technologies that match its signal at or above its min_confidence.
4. Fill the track's template from the matched technology and the row's company_name. A template with a
   placeholder that has no value is skipped and listed, never filled with a guess.

Every filled track is a suggestion, labelled "Suggested, not a fact", and is shown beside the technology
fact it came from.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import FATAL_KINDS, PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, card, details_json, esc, kv, note

NAME = "stack-talk-tracks"
TITLE = "Stack talk tracks"
DESCRIPTION = ("Suggests talking points for each account from fixed templates filled with technologies observed in "
               "its Firmable Tech Intel, each shown beside the technology fact it came from.")

CONFIDENCE_RANK = {"low": 1, "medium": 2, "high": 3}
PLACEHOLDERS = ["company_name", "product", "vendor", "category", "last_observed"]
SUGGESTED = "Suggested, not a fact"
STATUS_TONE = {"tracks_suggested": "good", "tracks_skipped": "review", "no_track_matched": "neutral",
               "no_track_matched_incomplete": "review", "no_data": "unknown", "invalid_input": "error",
               "access_denied": "error", "error": "error", "not_processed": "unknown"}
STOP_TEXT = {
    "page_limit": "the page limit was reached",
    "error": "a later page failed",
    "budget": "the credit limit was reached",
    "repeated_cursor": "the API returned a cursor it had already returned",
}
TECH_KEYS = ["product", "product_slug", "vendor", "vendor_slug", "filter", "filter_slug", "category",
             "category_slug", "pillar_slug", "confidence", "recency", "last_observed", "nature"]
MD_INTRO = ("Suggested talking points built from fixed templates and Firmable Tech Intel facts. Each suggestion "
            "is labelled \"Suggested, not a fact\". The technology fact it came from is shown separately. A "
            "detected technology does not prove buying intent, spend, licence count or active usage.")
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TOKEN = re.compile(r"\{([^{}]*)\}")
_MD_SPECIAL = re.compile(r"([\\`*_\[\]<>|])")
_TOP_KEYS = {"tracks", "max_pages", "max_items_per_track"}
_TRACK_KEYS = {"id", "label", "when", "template"}
_WHEN_KEYS = {"product_slugs", "vendor_slugs", "category_slugs", "aliases", "min_confidence"}
MAX_TRACKS = 20
MAX_TEMPLATE = 1000
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


def template_placeholders(template: str, where: str) -> list[str]:
    """The placeholders a template uses, in order of first use. Rejects unknown names and stray braces."""
    names: list[str] = []
    for name in _TOKEN.findall(template):
        if name not in PLACEHOLDERS:
            raise ConfigError(f"{where} uses an unknown placeholder {{{name}}}. Allowed: "
                              + ", ".join("{" + p + "}" for p in PLACEHOLDERS))
        if name not in names:
            names.append(name)
    rest = _TOKEN.sub("", template)
    if "{" in rest or "}" in rest:
        raise ConfigError(f"{where} has a brace that is not part of a placeholder.")
    return names


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    tracks_raw = raw.get("tracks")
    if not isinstance(tracks_raw, list) or not tracks_raw:
        raise ConfigError("tracks must be a non-empty list.")
    if len(tracks_raw) > MAX_TRACKS:
        raise ConfigError(f"tracks can hold at most {MAX_TRACKS} items.")
    tracks = []
    seen: set[str] = set()
    for i, t in enumerate(tracks_raw, start=1):
        where = f"tracks[{i}]"
        if not isinstance(t, dict):
            raise ConfigError(f"{where} must be an object.")
        extra = sorted(set(t) - _TRACK_KEYS)
        if extra:
            raise ConfigError(f"{where} has unknown key(s): {', '.join(extra)}")
        tid = t.get("id")
        if not isinstance(tid, str) or not _ID.match(tid):
            raise ConfigError(f"{where}.id must be 1 to 40 lower-case letters, digits or underscores.")
        if tid in seen:
            raise ConfigError(f"{where}.id {tid!r} is used twice.")
        seen.add(tid)
        label = t.get("label", tid)
        if not isinstance(label, str) or not label.strip():
            raise ConfigError(f"{where}.label must be text.")
        when = t.get("when")
        if not isinstance(when, dict):
            raise ConfigError(f"{where}.when must be an object.")
        extra = sorted(set(when) - _WHEN_KEYS)
        if extra:
            raise ConfigError(f"{where}.when has unknown key(s): {', '.join(extra)}")
        m = {k: _text_list(when.get(k), f"{where}.when.{k}")
             for k in ("product_slugs", "vendor_slugs", "category_slugs", "aliases")}
        if not any(m.values()):
            raise ConfigError(f"{where}.when needs at least one product slug, vendor slug, category slug or alias.")
        mc = when.get("min_confidence", "low")
        if _rank(CONFIDENCE_RANK, mc, 0) == 0:
            raise ConfigError(f"{where}.when.min_confidence must be one of: low, medium, high.")
        template = t.get("template")
        if not isinstance(template, str) or not template.strip():
            raise ConfigError(f"{where}.template must be text.")
        if len(template) > MAX_TEMPLATE:
            raise ConfigError(f"{where}.template can hold at most {MAX_TEMPLATE} characters.")
        uses = template_placeholders(template, f"{where}.template")
        tracks.append({"id": tid, "label": label.strip(), "when": {**m, "min_confidence": mc},
                       "template": template.strip(), "placeholders": uses})
    max_pages = raw.get("max_pages", 5)
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or not 1 <= max_pages <= MAX_PAGES_LIMIT:
        raise ConfigError(f"max_pages must be a whole number from 1 to {MAX_PAGES_LIMIT}.")
    per = raw.get("max_items_per_track", 1)
    if not isinstance(per, int) or isinstance(per, bool) or not 1 <= per <= 5:
        raise ConfigError("max_items_per_track must be a whole number from 1 to 5.")
    return {"tracks": tracks, "max_pages": max_pages, "max_items_per_track": per}


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
    return [PlannedCall("GET /tech-intel", f"Up to {pages} page(s) of Tech Intel for each unique valid company",
                        n * pages, [("tech_intel", pricing.round4(pricing.TECH_INTEL_COMPANY * n))])]


# ----- matching and filling ------------------------------------------------------------------

def _t(value: Any) -> str:
    return "not returned" if value is None else str(value)


def match_basis(item: dict[str, Any], when: dict[str, Any]) -> list[str]:
    basis: list[str] = []
    for field, key in (("product_slug", "product_slugs"), ("vendor_slug", "vendor_slugs"),
                       ("category_slug", "category_slugs")):
        if isinstance(item.get(field), str) and item[field] in when[key]:
            basis.append(f"{field} {item[field]}")
    aliases = [a.lower() for a in when["aliases"]]
    for field in ("product", "vendor"):
        value = item.get(field)
        if isinstance(value, str) and value.strip().lower() in aliases:
            basis.append(f"alias of {field} name {value}")
    return basis


def _value(v: Any) -> str | None:
    if isinstance(v, str):
        return v.strip() or None
    if isinstance(v, bool) or v is None or isinstance(v, (dict, list)):
        return None
    return str(v)


def fill(template: str, values: dict[str, str | None]) -> str:
    return _TOKEN.sub(lambda m: values[m.group(1)] or "", template)


def md(text: Any) -> str:
    """Escapes API and input text for Markdown: \\ ` * _ [ ] < > | and a leading #. Line breaks become spaces."""
    s = re.sub(r"[\r\n]+", " ", str(text))
    s = _MD_SPECIAL.sub(r"\\\1", s)
    return "\\" + s if s.startswith("#") else s


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


# ----- run -----------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    coverage = [
        "Every talk track is a suggestion built from a fixed template in the configuration. It is not a fact "
        "about the company, and no language model wrote it.",
        "Placeholders are filled only from Tech Intel fields and the company_name input column. A track with a "
        "placeholder that has no value is skipped and listed, not filled with a guess.",
        "A detected technology does not prove buying intent, spend, licence count or active usage.",
        "A track that did not match means its technology was not observed in retrieved data. This does not "
        "mean the company does not use it.",
        "Accounts come from the input file you supplied. The REST API has no company search and no reverse "
        "lookup by technology.",
    ]
    memo: dict[str, Any] = {}
    first_row: dict[str, str] = {}

    def one(row: dict[str, str]) -> dict[str, Any]:
        key, identifier, problem = company_ref(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "company_name": _value(row.get("company_name")),
                                "duplicate_of": None, "tech_intel": None, "suggestions": [], "skipped": [],
                                "below_threshold": []}
        if problem or key is None or identifier is None:
            return {**base, "status": "invalid_input", "status_reason": problem}
        if key in first_row:
            base["duplicate_of"] = first_row[key]
        else:
            first_row[key] = row["row_id"]
        info, items = fetch(ctx, memo, key, identifier, row["row_id"], cfg["max_pages"])
        base["tech_intel"] = info
        gone = unavailable(info)
        if gone:
            return {**base, "status": gone[0], "status_reason": gone[1]}
        suggestions, skipped, below = [], [], []
        for t in cfg["tracks"]:
            used = 0
            for item in items:
                basis = match_basis(item, t["when"])
                if not basis:
                    continue
                if _rank(CONFIDENCE_RANK, item.get("confidence"), 0) < CONFIDENCE_RANK[t["when"]["min_confidence"]]:
                    below.append({"track_id": t["id"], "product": item.get("product"),
                                  "confidence": item.get("confidence"),
                                  "threshold_miss": f"confidence {_t(item.get('confidence'))} is below "
                                                    f"{t['when']['min_confidence']}"})
                    continue
                if used >= cfg["max_items_per_track"]:
                    continue
                used += 1
                values = {"company_name": base["company_name"], "product": _value(item.get("product")),
                          "vendor": _value(item.get("vendor")), "category": _value(item.get("category")),
                          "last_observed": _value(item.get("last_observed"))}
                missing = [p for p in t["placeholders"] if values[p] is None]
                fact = {**{k: item.get(k) for k in TECH_KEYS}, "match_basis": basis}
                if missing:
                    skipped.append({"track_id": t["id"], "label": t["label"], "product": item.get("product"),
                                    "missing_placeholders": missing,
                                    "reason": f"No value for: {', '.join(missing)}."})
                    continue
                suggestions.append({"track_id": t["id"], "label": t["label"], "label_note": SUGGESTED,
                                    "text": fill(t["template"], values), "fact": fact})
        base.update(suggestions=suggestions, skipped=skipped, below_threshold=below)
        complete = info["complete"]
        tail = "" if complete else " " + incomplete_text(info)
        n = len(cfg["tracks"])
        tracks_hit = []
        for s in suggestions:
            if s["label"] not in tracks_hit:
                tracks_hit.append(s["label"])
        if suggestions:
            return {**base, "status": "tracks_suggested",
                    "status_reason": f"{len(suggestions)} suggestion(s) from {len(tracks_hit)} of {n} track(s): "
                                     f"{', '.join(tracks_hit)}.{tail}"}
        if skipped:
            return {**base, "status": "tracks_skipped",
                    "status_reason": f"{len(skipped)} matching track(s) were skipped because a placeholder had no "
                                     f"value.{tail}"}
        if complete:
            return {**base, "status": "no_track_matched",
                    "status_reason": f"None of the {n} track(s) matched a technology in retrieved data. All "
                                     "technologies were retrieved."}
        return {**base, "status": "no_track_matched_incomplete",
                "status_reason": f"None of the {n} track(s) matched a technology in the pages retrieved.{tail}"}

    rows = ctx.run_rows(ctx.rows, one)
    counts: dict[str, int] = {}
    track_counts = {t["id"]: {"suggested": 0, "skipped": 0} for t in cfg["tracks"]}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        for s in r.get("suggestions") or []:
            track_counts[s["track_id"]]["suggested"] += 1
        for s in r.get("skipped") or []:
            track_counts[s["track_id"]]["skipped"] += 1
    dupes = sum(1 for r in rows if r.get("duplicate_of"))
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company identifier; their API responses were reused, "
                        "not requested again.")
    skipped_total = sum(len(r.get("skipped") or []) for r in rows)
    if skipped_total:
        coverage.append(f"{skipped_total} track(s) were skipped because a placeholder had no value. They are "
                        "listed per account.")
    incomplete = sum(1 for r in rows if r.get("tech_intel") and r["tech_intel"]["pages_fetched"]
                     and not r["tech_intel"]["complete"])
    if incomplete:
        coverage.append(f"{incomplete} row(s) have an incomplete technology list (max_pages is {cfg['max_pages']}). "
                        "Tracks may match technologies on pages that were not retrieved.")
    return {"rows": rows, "summary": {"status_counts": counts, "track_counts": track_counts},
            "coverage": coverage}


# ----- outputs -------------------------------------------------------------------------------

def _s(value: Any) -> str:
    return "" if value is None else str(value)


CSV_COLUMNS = ["row_id", "domain", "company_id", "company_name", "duplicate_of", "status", "status_reason",
               "firmable_id", "technologies_total", "technologies_retrieved", "list_complete", "tracks_suggested",
               "suggestions", "source_technologies", "skipped_tracks"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        sug = r.get("suggestions") or []
        ti = r.get("tech_intel") or {}
        inp = r["input"]
        out.append({
            "row_id": r["row_id"], "domain": inp.get("domain"), "company_id": inp.get("company_id"),
            "company_name": inp.get("company_name"), "duplicate_of": r.get("duplicate_of"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message"),
            "firmable_id": ti.get("company_id"), "technologies_total": ti.get("total"),
            "technologies_retrieved": ti.get("retrieved"), "list_complete": ti.get("complete"),
            "tracks_suggested": [s["track_id"] for s in sug],
            "suggestions": [f"{s['track_id']} ({SUGGESTED}): {s['text']}" for s in sug],
            "source_technologies": [f"{s['track_id']}:{_s(s['fact'].get('product'))}({_s(s['fact'].get('confidence'))},"
                                    f"{_s(s['fact'].get('recency'))},{_s(s['fact'].get('last_observed'))})" for s in sug],
            "skipped_tracks": [f"{s['track_id']}:{_s(s['product'])} ({s['reason']})" for s in r.get("skipped") or []],
        })
    return out


def _title(r: dict[str, Any]) -> str:
    inp = r["input"]
    return inp.get("company_name") or inp.get("domain") or inp.get("company_id") or r["row_id"]


def _fact_line(f: dict[str, Any]) -> str:
    return (f"Technology fact: {md(_t(f.get('product')))} by {md(_t(f.get('vendor')))}, category "
            f"{md(_t(f.get('category')))}. Confidence {md(_t(f.get('confidence')))}, recency "
            f"{md(_t(f.get('recency')))}, last observed {md(_t(f.get('last_observed')))}. Matched by "
            f"{md('; '.join(f['match_basis']))}.")


def markdown(result: dict[str, Any]) -> dict[str, str]:
    lines = ["# Stack talk tracks", "", MD_INTRO, ""]
    for r in result["rows"]:
        reason = r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message") or ""
        lines += [f"## {md(_title(r))} (row {md(r['row_id'])})", "", f"Status: {md(r['status'])}. {md(reason)}", ""]
        for s in r.get("suggestions") or []:
            lines += [f"### {md(s['label'])}", "", f"> **{SUGGESTED}**", ">", f"> {md(s['text'])}", "",
                      _fact_line(s["fact"]), ""]
        if r.get("skipped"):
            lines += ["Skipped tracks:", ""]
            lines += [f"- {md(s['label'])} for {md(_t(s['product']))}: {md(s['reason'])}" for s in r["skipped"]]
            lines.append("")
    return {"talk-tracks.md": "\n".join(lines).rstrip("\n") + "\n"}


def render(report: Any, result: dict[str, Any]) -> None:
    counts = result["summary"].get("status_counts", {})
    report.add("Result", "Talk track summary",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + note("Every talk track below is a suggestion from a fixed template, not a fact. The technology "
                      "fact it came from is shown beside it. A detected technology does not prove buying intent.",
                      "unknown"))
    cards = []
    for r in result["rows"]:
        status = r["status"]
        reason = r.get("status_reason") or r.get("reason") or (r.get("error") or {}).get("message") or ""
        left = f"<p>{esc(reason)}</p>"
        ti = r.get("tech_intel")
        if ti:
            left += kv([("Firmable ID", ti.get("company_id")), ("Technologies in Firmable", ti.get("total")),
                        ("Technologies retrieved", ti.get("retrieved")), ("List complete", ti.get("complete"))])
        if r.get("duplicate_of"):
            left += note(f"Same company as row {esc(r['duplicate_of'])}; responses were reused.", "info")
        for s in r.get("skipped") or []:
            left += note(esc(f"Skipped {s['label']} for {_t(s['product'])}: {s['reason']}"), "review")
        for b in r.get("below_threshold") or []:
            left += note(esc(f"{_t(b['product'])} matched track {b['track_id']} but was not used: "
                             f"{b['threshold_miss']}."), "unknown")
        right = ""
        for s in r.get("suggestions") or []:
            f = s["fact"]
            right += (f"<h3>{esc(s['label'])}</h3><div class=\"template\"><p class=\"eyebrow\">{esc(SUGGESTED)}</p>"
                      f"<p>{esc(s['text'])}</p></div>"
                      + kv([("Technology fact", Raw(f"{esc(_t(f.get('product')))} by {esc(_t(f.get('vendor')))}")),
                            ("Category", f.get("category")), ("Confidence", f.get("confidence")),
                            ("Recency", f.get("recency")), ("Last observed", f.get("last_observed")),
                            ("Matched by", "; ".join(f["match_basis"]))]))
        if r.get("suggestions"):
            right += details_json("Suggestions as JSON", r["suggestions"])
        cards.append(card(_title(r), badge(status.replace("_", " "), STATUS_TONE.get(status, "neutral")), left,
                          right or "<p class=\"muted\">No talk track for this row.</p>", sub=f"Row {r['row_id']}"))
    report.add("Accounts", "Each account with its suggested talk tracks", "".join(cards))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render,
                markdown=markdown)
