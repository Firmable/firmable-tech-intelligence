# Integration audience map

Shows which companies in a list you supply have the technologies you integrate with in their Firmable Tech Intel. Reports each match with its confidence, recency and last observed date, and counts each target across the list with its denominator.

## Business problem

A partnerships, product or strategy team wants to size the audience for an integration within a known list of companies, such as current customers, a target account list or an event attendee list. They need to know how many of those companies show the partner technology, and how sure that observation is.

This recipe reads Firmable Tech Intel for each company in the list and matches it against an explicit list of target technologies. It reports per company and per target, and it states every count with the number of companies it was counted out of.

This is audience research within the list you supplied. An observed technology is not proof of demand for an integration, of compatibility with your product, or of buying intent.

## Inputs

**Input file** (CSV or JSON). One row per company.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | The Firmable company ID, such as `f000000740279`. Used instead of `domain` when both are filled. |
| `segment` | No | Your own grouping. When the column exists, every measure is also reported per segment. An empty value is grouped as `(no segment)`. |
| `company_name` | No | Shown in the report. Kept as given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| Any other column | No | Kept with the row in `results.json`. |

The cohort is the file you supply. The REST API has no company search and no reverse lookup by technology, so this recipe cannot find companies outside your list.

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `targets` | Required | The technologies to look for, 1 to 50. |
| `targets[].id` | Required | A short identifier, lower-case letters, digits and underscores. |
| `targets[].label` | The id | The name shown in reports. |
| `targets[].product_slugs` | `[]` | Tech Intel `product_slug` values that match exactly. |
| `targets[].vendor_slugs` | `[]` | Tech Intel `vendor_slug` values that match exactly. |
| `targets[].aliases` | `[]` | Names that match a technology's `product` or `vendor` name exactly, ignoring case and surrounding spaces. |
| `match` | `any` | `any`: a company matches when at least one target is observed. `all`: a company matches when every target is observed. |
| `min_confidence` | `low` | The lowest Tech Intel `confidence` that counts as observed: `low`, `medium` or `high`. |
| `max_recency` | `older` | The oldest Tech Intel `recency` that counts as observed: `30d`, `90d` or `older`. |
| `max_pages` | `5` | The most Tech Intel pages read per company, from 1 to 25. Each page holds up to 100 technologies. |
| `min_answered` | `5` | The fewest answered companies a measure needs before its share is shown. |

Each target needs at least one slug or alias. Slugs are compared exactly, so copy them from a Tech Intel response rather than guessing them.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /tech-intel?fqdn=` or `?id=` | First page, once per unique valid company | Up to 5 credits, paid once per company per organisation |
| `GET /tech-intel?...&cursor=` | Each further page, up to `max_pages` in total | Free |

Evidence is not requested. A repeated identifier in the input reuses the earlier response and is not requested again.

## Workflow

1. Read and validate the input and configuration.
2. For each row: take `company_id` when filled, otherwise the normalised `domain`.
3. Read Tech Intel, following `next_cursor` until the last page or `max_pages`.
4. Match every retrieved technology against every target, then apply `min_confidence` and `max_recency`.
5. Set each target's result and the company's status.
6. Count each target, and the match rule, over the unique companies, and per segment when present.
7. Write `report.html`, `results.csv` and `results.json`.

## Matching rules

A technology matches a target when any of these is true:

- its `product_slug` is in `product_slugs`;
- its `vendor_slug` is in `vendor_slugs`;
- its `product` or `vendor` name equals an alias, ignoring case and surrounding spaces.

There is no fuzzy or partial matching. An alias of `Snowflake` does not match a product named `Snowflake Connector`. Every match records which rule matched it in `match_basis`.

A matched technology counts as observed only when its `confidence` is at or above `min_confidence` and its `recency` is at or newer than `max_recency`. The order is `low`, `medium`, `high` for confidence and `30d`, `90d`, `older` for recency. A value outside these lists fails any threshold above the lowest. Matches that fail a threshold are listed under `below_threshold` with the reason, and do not count as observed.

Each target gets one result per company:

| Result | Rule |
| - | - |
| `observed` | At least one retrieved technology matched and met the thresholds. |
| `not_observed` | No qualifying match, and every page of the technology list was retrieved. |
| `not_observed_in_pages_retrieved` | No qualifying match, but the technology list is incomplete. The unread pages were not checked. |

Each company gets one status:

| Status | Rule |
| - | - |
| `matched` | The match rule is met: one target observed with `any`, every target observed with `all`. |
| `not_observed` | The match rule is not met in a complete technology list. The reason lists any targets that were observed. |
| `not_observed_incomplete` | The match rule is not met in the pages retrieved, and the list is incomplete. |
| `no_data` | Firmable holds no technology data for the company (`total` 0), or Tech Intel returned 404 for the identifier. |
| `invalid_input` | The domain or company ID is not valid. |
| `access_denied` | Tech Intel returned 403 Forbidden, so the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. |
| `error` | The first Tech Intel page failed. |
| `not_processed` | The run stopped before this row. |

A list is incomplete when the page limit was reached, a later page failed, the credit limit was reached, or the API repeated a cursor. Pages already fetched are kept and matched.

## Measures

Each measure counts unique companies, not input rows. A row that repeats an earlier identifier is marked `duplicate_of`. A row whose identifier differs but whose Tech Intel response has the same Firmable ID as an earlier row is marked `same_company_as`. Both kinds of repeated row are left out of the counts.

There is one measure for the match rule and one per target. Each measure reports:

| Field | Meaning |
| - | - |
| `companies_in_cohort` | Unique valid companies in the input. |
| `companies_asked` | Companies whose Tech Intel was requested. |
| `observed` | Companies where the target was observed. |
| `not_observed` | Companies where the target was not observed in a complete list. |
| `not_observed_in_pages_retrieved` | Companies where the target was not observed in an incomplete list. |
| `observed_below_threshold` | Companies where the target matched only below the thresholds. This is a subset of the two not observed counts. |
| `no_data`, `error`, `not_processed` | Companies with no data, an error, or no request. |
| `answered` | `observed` plus `not_observed`. |
| `observed_share` | `observed` over `answered`, with numerator, denominator and percentage. |
| `unknown_share` | `not_observed_in_pages_retrieved` over the companies with data, shown beside the observed share. |
| `enough_answers` | False when `answered` is below `min_answered`. The share is then shown as "too few answers to compare". |

Percentages are rounded half up to one decimal place. A measure describes this cohort only. It does not describe a market, sector or population.

## Data checks

The recipe reports these inconsistencies in `data_notes` and does not correct them:

- the API's `total` differs from the number of technologies returned across all pages of a complete list;
- the same `product_slug` appears more than once with different `confidence` values;
- a technology has no product name and no product slug, so it cannot match a target.

## Output

- `report.html`: a status summary, the measures table for the match rule and each target, the same table per segment, and one row per company with its observed targets and reason. The raw requests and responses are at the end.
- `results.csv`: one row per input row, in input order, with the status, reason, totals, target results, matched technologies, below-threshold matches and data notes.
- `results.json`: everything, including every matched technology as returned, the measures and the request ledger.

`confidence`, `recency`, `last_observed` and `nature` come from the API and are shown unchanged.

## Estimated cost

For 100 unique companies: up to 500 credits for the first page of each company. Further pages are free without evidence. Technologies are paid once per company per organisation, so companies your organisation already paid for cost nothing. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see the [Python](python/README.md) and [TypeScript](typescript/README.md) READMEs.

```bash
# Python, plan mode (no API calls)
firmable-integration-audience-map --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-integration-audience-map --input examples/input.csv --config config.example.json --out out --live --max-credits 30
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 30
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A 403 response means the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. Check the key in the developer portal.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge" and its reservation is kept.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written, and later rows are marked `not_processed`.
- Nothing is retried automatically.
- "Not observed" means not observed in retrieved data. It never means the company does not use the technology.
- Tech Intel reports observed technology signals with Firmable's confidence and recency. It does not report active usage, spend, licence count or integration readiness, and this recipe does not infer them.
- The cohort is the list you supply. The API cannot list every company that uses a technology.
- A low `max_pages` leaves large technology lists incomplete. Targets not matched for those companies are counted as not observed in the pages retrieved, outside the observed share.
- Two rows with different identifiers for the same company are detected only when Tech Intel returns the same Firmable ID for both.
- Tech Intel accepts one company per request. The recipe reads one company at a time.
