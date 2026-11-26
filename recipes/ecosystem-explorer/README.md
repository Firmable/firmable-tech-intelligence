# Ecosystem explorer

Counts which technologies Firmable Tech Intel observed across a cohort of companies you supply, and which technologies were observed at the same companies. Every count states its denominator. The report includes an explorer page with filters, a co-occurrence panel and a company drilldown.

## Business problem

Strategy, market research, partnerships and product teams want to know which technologies are common in a set of companies they care about. They also want to know which technologies tend to appear at the same companies, to plan integrations, partnerships or positioning.

This recipe reads Firmable Tech Intel for each company in your list and counts each technology across the list. A count only describes the companies you supplied. The Firmable REST API has no company search and no lookup by technology, so the cohort always comes from your input file. A count from this recipe never describes a market, sector or population.

## Inputs

**Input file** (CSV or JSON). One row per company.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | A Firmable company ID, such as `f000000740279`. When a row has both, the company ID is used. |
| `company_name` | No | Shown in the report and the explorer. Kept as given. |
| `segment` or any other column | No | Kept with the row. Name it in `group_by` to see every count per group. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `max_pages` | `15` | The most Tech Intel pages read per company, from 1 to 25. A page holds up to 100 technologies, or 10 with evidence. |
| `with_evidence` | `false` | Requests the evidence behind each technology (`withEvidence=true`). Each page then costs 0.2 credits and holds 10 technologies. |
| `min_companies` | `2` | A technology appears in the co-occurrence view only when it was observed in at least this many companies. |
| `cooccurrence_top` | `40` | How many technologies the co-occurrence view pairs: the ones observed at the most companies, from 2 to 200. Pairing every technology in a large cohort makes the report too large to open. |
| `min_answered` | `5` | A share is shown only when at least this many companies answered. Fewer answers are reported as "too few answers to compare". |
| `group_by` | `null` | The name of an input column, such as `segment`. Every count is then also reported per group. |
| `categories` | `[]` | Category slugs to count, such as `business-applications`. The filter is applied after retrieval. An empty list counts every category. |

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /tech-intel?fqdn=` or `?id=` | First page, once per unique valid company | Up to 5 credits, paid once per company by your organisation |
| `GET /tech-intel?...&cursor=` | Each further page, up to `max_pages` in total | Free without evidence |
| Any of the above with `withEvidence=true` | When `with_evidence` is true | Plus 0.2 credits for every page |

Tech Intel accepts one company per request, so there is no batching. Rows that repeat a company identifier reuse the earlier result and are not requested again.

## Workflow

1. Read and validate the input and configuration.
2. For each row, use `company_id` when present, otherwise the normalised domain.
3. Read Tech Intel, following `next_cursor` until the last page or `max_pages`.
4. Record whether each company's technology list is complete, and why it stopped.
5. Keep one entry per `product_slug` for each company, set aside categories outside `categories`, and count each technology across the cohort.
6. Count co-occurrence for every pair of technologies observed in at least `min_companies` companies.
7. Write `report.html` (with the explorer page), `results.csv` and `results.json`.

## Rules

**Company outcomes.** Each row gets one status:

| Status | Rule |
| - | - |
| `listed` | Every page of the technology list was retrieved. |
| `listed_incomplete` | Some pages were retrieved, and the list is incomplete. The reason says why: the page limit, a later page failing, the credit limit, or a repeated cursor. |
| `no_technology_data` | Firmable knows the company but holds no technology data for it (`total` 0). |
| `company_not_found` | Tech Intel returned 404. |
| `access_denied` | Tech Intel returned 403 Forbidden, so the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. |
| `invalid_input` | The domain or company ID is not valid. |
| `error` | The first page failed. |
| `not_processed` | The run stopped before this row. |

**One company, one count.** A row that repeats an earlier identifier is marked `duplicate_of`. A row whose identifier resolves to a Firmable ID already returned for an earlier row is marked `same_company_as`. Both are counted once, under the earlier row. When these rows carry a different group value, the first row's value is used and the coverage notes say so.

**One technology per company.** A technology is identified by its `product_slug`. When a company's list returns the same product more than once, for example under two filters, the recipe keeps the item with the highest confidence (`high`, then `medium`, then `low`), then the latest `last_observed`, then the first returned. `items_returned` records how many items were merged. An item with no `product_slug` is not counted, and the count is reported.

**Measures per technology.** Each technology gets one measure block for the cohort, and one per group when `group_by` is set. The block counts unique companies:

| Field | Meaning |
| - | - |
| `cohort_companies` | Unique companies in the input (or in the group). |
| `companies_asked` | Unique companies the recipe requested. |
| `companies_with_data` | Companies with at least one technology retrieved, or with an incomplete list. |
| `observed` | Companies with data where the technology was observed. |
| `not_observed` | Companies with a complete list where the technology was not observed. |
| `not_observed_in_pages_retrieved` | Companies with an incomplete list where the technology was not seen. These are unknown, not "not observed". |
| `no_data`, `not_found`, `error`, `not_processed` | Companies without data, by reason. |
| `observed_share_pct` | `observed` over `answered`, where `answered` is `observed` plus `not_observed`. Shown only when `answered` is at least `min_answered`. |
| `unknown_share_pct` | `not_observed_in_pages_retrieved` over `companies_with_data`. |
| `text` | The same counts as a sentence, such as "Observed in 3 of 5 companies with data in this cohort." |

Percentages are rounded half up to one decimal place.

**Confidence and recency.** For each technology, `by_confidence` and `by_recency` count the observed companies by the `confidence` and `recency` values as returned. A missing value is counted as `not returned`.

**Co-occurrence.** For each pair of technologies that were each observed in at least `min_companies` companies, `both` counts the companies where both were observed. `share_of_a_pct` is `both` over the companies with A, shown only when that denominator is at least `min_answered`. Co-occurrence does not show integration, compatibility or that the two technologies are used together.

**Classification conflicts.** When the same `product_slug` comes back with a different `category_slug` or `vendor_slug` at different companies, the first value returned is shown and every value is listed under `classification_conflicts`. The recipe does not correct upstream data.

## Output

- `report.html`: cohort coverage, the explorer page, the 50 most observed technologies, the co-occurrence pairs, every company with its status, then the standard coverage, credits and raw response sections.
- The explorer page has a technology table with filters for category, vendor, group and confidence, and a search box. Selecting a technology shows the technologies observed at the same companies, with denominators. The company drilldown lists one company's technologies with confidence, recency, last observed and nature. It runs in the page with no network calls and works on a phone.
- `results.csv`: one row per input row, in input order, with the status, reason, totals, completeness and the counted `product_slug` values.
- `results.json`: everything, including each company's technologies, every measure block, the co-occurrence pairs and the request ledger.

`confidence`, `recency`, `last_observed`, `nature`, categories and vendors come from the API and are shown unchanged.

## Estimated cost

For 100 unique companies without evidence: up to 500 credits, whatever `max_pages` is, because later pages are free. With evidence and `max_pages` of 3, add up to 60 credits for evidence pages, 560 credits in total. Technologies are paid once per company, so companies your organisation already paid for cost nothing without evidence. The example input of 6 companies costs up to 30 credits. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-ecosystem-explorer --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-ecosystem-explorer --input examples/input.csv --config config.example.json --out out --live --max-credits 30
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 30
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- The cohort is your input file. The REST API has no company search and no reverse lookup by technology, so this recipe cannot find companies that use a technology. It only counts the companies you supply.
- Every count describes this cohort only. It does not describe a market, sector or population.
- A 403 response means the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. Check the key in the developer portal.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge" and its reservation is kept.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written.
- Nothing is retried automatically.
- "Not observed" means not observed in retrieved data. It never means the company does not use the technology.
- A low `max_pages` leaves large technology lists incomplete. Technologies not seen in an incomplete list are counted as `not_observed_in_pages_retrieved`, not as `not_observed`.
- Co-occurrence does not show integration, compatibility or use together.
- Tech Intel reports observed technology signals with Firmable's confidence and recency. It does not report spend, licence count or active usage, and a detected technology does not prove buying intent.
- With evidence on, the recipe summarises each technology's evidence: evidence count, records listed, records with no location and capped types. The API lists up to 25 records per type, so `evidence_count` can be higher than the records listed. Full evidence records are in the raw responses.
- Classification conflicts are reported, not corrected.
