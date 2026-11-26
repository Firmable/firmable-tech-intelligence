# Stack talk tracks

Suggests talking points for each account from fixed templates filled with technologies observed in its Firmable Tech Intel. Each suggestion is labelled "Suggested, not a fact" and is shown beside the technology fact it came from.

## Business problem

A rep preparing outreach wants an opening line that refers to the account's actual stack, such as the CRM or the team chat tool it runs. Writing these by hand for every account is slow, and a generated line can state things that are not true.

This recipe fills templates you write with technology facts that Tech Intel returned for the account. It never writes free text. A template whose placeholder has no value is skipped and listed, not filled with a guess.

## Inputs

**Input file** (CSV or JSON). One row per account.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | The Firmable company ID. Used instead of `domain` when both are filled. |
| `company_name` | For `{company_name}` | The name used for the `{company_name}` placeholder. Tech Intel does not return a company name. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| Any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `tracks` | Required | The talk tracks, 1 to 20. |
| `tracks[].id` | Required | A short identifier, lower-case letters, digits and underscores. |
| `tracks[].label` | The id | The name shown in outputs. |
| `tracks[].when.product_slugs` | `[]` | Tech Intel `product_slug` values that match exactly. |
| `tracks[].when.vendor_slugs` | `[]` | Tech Intel `vendor_slug` values that match exactly. |
| `tracks[].when.category_slugs` | `[]` | Tech Intel `category_slug` values that match exactly. |
| `tracks[].when.aliases` | `[]` | Names that match a technology's `product` or `vendor` name exactly, ignoring case and surrounding spaces. |
| `tracks[].when.min_confidence` | `low` | The lowest Tech Intel `confidence` that counts: `low`, `medium` or `high`. |
| `tracks[].template` | Required | The suggestion text, up to 1,000 characters, with placeholders. |
| `max_items_per_track` | `1` | The most matched technologies one track is filled from per account, from 1 to 5. |
| `max_pages` | `5` | The most Tech Intel pages read per company, from 1 to 25. |

The `when` object is a signal, as in the `tech-fit-tiers` recipe, without an id or label. It needs at least one slug or alias.

Templates accept these placeholders only:

| Placeholder | Filled from |
| - | - |
| `{company_name}` | The row's `company_name` column |
| `{product}` | The matched technology's `product` |
| `{vendor}` | The matched technology's `vendor` |
| `{category}` | The matched technology's `category` |
| `{last_observed}` | The matched technology's `last_observed` |

An unknown placeholder or a brace outside a placeholder is a configuration error.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /tech-intel?fqdn=` or `?id=` | First page, once per unique valid company | Up to 5 credits, paid once per company per organisation |
| `GET /tech-intel?...&cursor=` | Each further page, up to `max_pages` in total | Free |

Evidence is not requested. A repeated identifier in the input reuses the earlier response and is not requested again.

## Workflow

1. Read and validate the input and configuration, including every template.
2. For each row: take `company_id` when filled, otherwise the normalised `domain`.
3. Read Tech Intel, following `next_cursor` until the last page or `max_pages`.
4. For each track, take the matching technologies in the order the API returned them, up to `max_items_per_track`.
5. Fill the template from each technology, or skip it when a placeholder it uses has no value.
6. Write `talk-tracks.md`, `report.html`, `results.csv` and `results.json`.

## Rules

A technology matches a track when its `product_slug`, `vendor_slug` or `category_slug` is in the track's `when` lists, or its `product` or `vendor` name equals an alias, ignoring case and surrounding spaces. There is no fuzzy or partial matching. A match below `min_confidence` is not used and is listed under `below_threshold`.

A placeholder has no value when the field is missing, null or empty. The track is then skipped for that technology and listed with the missing placeholders. Placeholder values are inserted as returned.

Each account gets one status:

| Status | Rule |
| - | - |
| `tracks_suggested` | At least one track was filled. |
| `tracks_skipped` | Tracks matched, but every one was skipped because a placeholder had no value. |
| `no_track_matched` | No track matched, and every page of the technology list was retrieved. |
| `no_track_matched_incomplete` | No track matched in the pages retrieved, and the list is incomplete. |
| `no_data` | Firmable holds no technology data for the company (`total` 0), or Tech Intel returned 404. |
| `invalid_input` | The domain or company ID is not valid. |
| `access_denied` | Tech Intel returned 403 Forbidden, so the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. |
| `error` | The first Tech Intel page failed. |
| `not_processed` | The run stopped before this row. |

## Output

- `talk-tracks.md`: one section per account in input order. Each suggestion is a block quote headed "Suggested, not a fact", followed by a separate line with the technology fact: product, vendor, category, confidence, recency, last observed and the match rule. Skipped tracks are listed with the reason. API and input text is escaped for Markdown, and line breaks in it become spaces.
- `report.html`: a status summary, then one card per account with each suggestion in a dashed template box beside its technology fact, skipped tracks and below-threshold matches. The raw requests and responses are at the end.
- `results.csv`: one row per input row, in input order, with the status, the suggestions labelled "Suggested, not a fact", the source technologies and the skipped tracks.
- `results.json`: everything, including every suggestion with its source technology as returned and the request ledger.

## Estimated cost

For 100 unique accounts: up to 500 credits for the first page of each company. Further pages are free. Technologies are paid once per company per organisation. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see the [Python](python/README.md) and [TypeScript](typescript/README.md) READMEs.

```bash
# Python, plan mode (no API calls)
firmable-stack-talk-tracks --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-stack-talk-tracks --input examples/input.csv --config config.example.json --out out --live --max-credits 20
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 20
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A 403 response means the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. Check the key in the developer portal.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge" and its reservation is kept.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written, and later rows are marked `not_processed`.
- Nothing is retried automatically.
- Every talk track is a suggestion from your template. It is not a fact about the company. Check it before you use it.
- A detected technology does not prove buying intent, spend, licence count or active usage.
- "Not observed" means not observed in retrieved data. A track that did not match does not mean the company does not use the technology.
- Tech Intel does not return the company name, so `{company_name}` needs the `company_name` input column.
- A low `max_pages` leaves large technology lists incomplete, and tracks may match technologies on pages that were not read.
- Accounts come from your input file. The API cannot list companies by technology.
