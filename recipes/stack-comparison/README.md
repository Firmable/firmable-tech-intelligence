# Stack comparison

Compares the technologies Firmable Tech Intel observed at 2 to 20 companies. Builds a technology-by-company matrix and lists what every company with data shares, what some share, and what was observed at only one. Writes the comparison as Markdown as well as the standard report.

## Business problem

Strategy, partnerships and product teams often need to compare a handful of named companies: a customer against its peers, a set of partners, or a shortlist of acquisition or integration targets. They want to see where the observed stacks overlap and where they differ.

This recipe reads Firmable Tech Intel for each company and lines the results up side by side. It keeps four outcomes apart: observed, not observed in a complete list, not observed in the pages retrieved, and no data. "Not observed" never means the company does not use the technology.

## Inputs

**Input file** (CSV or JSON). One row per company, 2 to 20 rows.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | A Firmable company ID, such as `f000000740279`. When a row has both, the company ID is used. |
| `company_name` | No | Used as the column heading. Defaults to the domain or company ID. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| Any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `max_pages` | `3` | The most Tech Intel pages read per company, from 1 to 25. A page holds up to 100 technologies, or 10 with evidence. |
| `with_evidence` | `false` | Requests the evidence behind each technology (`withEvidence=true`). Each page then costs 0.2 credits and holds 10 technologies. |
| `level` | `product` | `product` compares by `product_slug`. `category` compares by `category_slug`. |

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /tech-intel?fqdn=` or `?id=` | First page, once per unique valid company | Up to 5 credits, paid once per company by your organisation |
| `GET /tech-intel?...&cursor=` | Each further page, up to `max_pages` in total | Free without evidence |
| Any of the above with `withEvidence=true` | When `with_evidence` is true | Plus 0.2 credits for every page |

Tech Intel accepts one company per request. Rows that repeat a company identifier reuse the earlier result and are not requested again.

## Workflow

1. Read and validate the input (2 to 20 rows) and the configuration.
2. For each row, use `company_id` when present, otherwise the normalised domain.
3. Read Tech Intel, following `next_cursor` until the last page or `max_pages`, and record whether the list is complete.
4. Keep one entry per `product_slug`, or per `category_slug` at category level, for each company.
5. Build the matrix and the shared and unique lists.
6. Write `report.html`, `comparison.md`, `results.csv` and `results.json`.

## Rules

**Company outcomes.** Each row gets one status: `listed` (complete list), `listed_incomplete` (some pages retrieved), `no_technology_data` (`total` 0), `company_not_found` (404), `access_denied` (403; the API key cannot use Tech Intel, the run stops and later rows are `not_processed`), `invalid_input`, `error` (the first page failed) or `not_processed` (the run stopped before this row).

**One company, one column.** A row that repeats an earlier identifier is marked `duplicate_of`. A row whose identifier resolves to a Firmable ID already returned for an earlier row is marked `same_company_as`. Both share the earlier row's column.

**One entry per technology.** When a company's list returns the same product more than once, or several products in one category at category level, the entry shows the item with the highest confidence (`high`, then `medium`, then `low`), then the latest `last_observed`, then the first returned. At category level, `products` lists every `product_slug` seen in that category.

**Matrix cells.** Every technology gets one value per company:

| Cell | Rule |
| - | - |
| `observed` | The technology was observed in the retrieved data. |
| `not_observed` | Not observed, and the company's technology list is complete. |
| `not_observed_in_pages_retrieved` | Not observed, but the company's list is incomplete. The unread pages were not checked. |
| `no_data` | No technology data was retrieved for the company: no data held, not found, an error or not processed. |

**Lists.** The lists use only companies with data, and need at least two of them:

| List | Rule |
| - | - |
| `shared_by_all` | Observed at every company with data. |
| `shared_by_some` | Observed at two or more companies with data, but not all. The text says how many other companies had incomplete lists. |
| `unique_to_one` | Observed at exactly one company with data. `confirmed` is true when every other company with data has a complete list. Otherwise the text says the technology may not be unique. |

With fewer than two companies with data, every technology is `not_compared` and the lists are empty.

## Output

- `report.html`: a summary, the shared and unique lists, the matrix with a badge per cell, and every input row with its status, then the standard coverage, credits and raw response sections.
- `comparison.md`: the companies, the three lists, the matrix and the coverage notes, as Markdown. API and input text is escaped, so a product name cannot change the Markdown structure.
- `results.csv`: one row per input row, in input order, with the status, reason, totals, completeness, the number of shared-by-all technologies observed there and the technologies unique to that company.
- `results.json`: everything, including each company's entries, each matrix cell, the confidence, recency and last observed date behind every `observed` cell, and the request ledger.

`confidence`, `recency`, `last_observed`, `nature`, categories and vendors come from the API and are shown unchanged.

## Estimated cost

Up to 5 credits per company without evidence, whatever `max_pages` is, because later pages are free. Comparing 20 companies costs up to 100 credits. With evidence and `max_pages` of 3, add up to 0.6 credits per company. Companies your organisation already paid for cost nothing without evidence. The example input of 3 companies costs up to 15 credits. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-stack-comparison --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-stack-comparison --input examples/input.csv --config config.example.json --out out --live --max-credits 15
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 15
```

The underlying requests are in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- The comparison covers only the companies in your input file. It does not describe a market or sector.
- A 403 response means the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. Check the key in the developer portal.
- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge" and its reservation is kept.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written.
- Nothing is retried automatically.
- "Not observed" means not observed in retrieved data. It never means the company does not use the technology.
- A low `max_pages` leaves large lists incomplete. A technology seen at only one company may then also be present at another company in the pages not read, so `confirmed` is false.
- Tech Intel reports observed technology signals with Firmable's confidence and recency. It does not report spend, licence count or active usage, and a detected technology does not prove buying intent.
- Category level depends on the `category_slug` Firmable returns for each product. The recipe does not reclassify products.
- With evidence on, the recipe keeps an evidence summary for each entry: evidence count, records listed and records with no location. Full evidence records are in the raw responses.
