# Tech fit tiers

Assigns each account a sales tier from fixed rules over the technologies observed in its Firmable Tech Intel. Shows the signals and the technology facts behind each tier, and marks an account for review when an incomplete technology list leaves a higher tier undetermined.

## Business problem

A sales or marketing team wants to split an account list into tiers by observed stack. For example, accounts running Salesforce and a cloud data warehouse go first, and accounts running a legacy CRM drop a tier. Doing this by hand is slow and inconsistent between reps.

This recipe applies the same written rules to every account. Each tier is a set of conditions over named technology signals, and the first tier whose conditions are met is assigned. Every tier decision shows the signals it used and the Tech Intel facts behind them.

This recipe tiers accounts by rules you write. It differs from the gtm-starter-kit `tech-sales-opportunities` recipe, which lists each target technology with its evidence and assigns no tier.

## Inputs

**Input file** (CSV or JSON). One row per account.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | The Firmable company ID. Used instead of `domain` when both are filled. |
| `company_name` | No | Shown in the report and CSV. Kept as given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| Any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `signals` | Required | The technology signals the tiers use, 1 to 30. |
| `signals[].id` | Required | A short identifier, lower-case letters, digits and underscores. |
| `signals[].label` | The id | The name shown in reports. |
| `signals[].product_slugs` | `[]` | Tech Intel `product_slug` values that match exactly. |
| `signals[].vendor_slugs` | `[]` | Tech Intel `vendor_slug` values that match exactly. |
| `signals[].category_slugs` | `[]` | Tech Intel `category_slug` values that match exactly. |
| `signals[].aliases` | `[]` | Names that match a technology's `product` or `vendor` name exactly, ignoring case and surrounding spaces. |
| `signals[].min_confidence` | `low` | The lowest Tech Intel `confidence` that counts: `low`, `medium` or `high`. |
| `tiers` | Required | The tiers in priority order, 1 to 10. |
| `tiers[].id`, `tiers[].label` | Required, the id | The tier identifier and display name. |
| `tiers[].when.all` | `[]` | Signals that must all be observed. |
| `tiers[].when.any` | `[]` | Signals of which at least one must be observed. |
| `tiers[].when.none` | `[]` | Signals that must not be observed. |
| `max_pages` | `5` | The most Tech Intel pages read per company, from 1 to 25. |
| `with_evidence` | `false` | Requests the evidence behind each technology (`withEvidence=true`). Pages then hold 10 technologies instead of 100, and each page costs 0.2 credits. |

Each signal needs at least one slug or alias. Each tier needs at least one signal in `all`, `any` or `none`, and every named signal must exist. A signal cannot appear in `none` and in `all` or `any` of the same tier.

## API calls

| Call | When | Cost |
| - | - | - |
| `GET /tech-intel?fqdn=` or `?id=` | First page, once per unique valid company | Up to 5 credits, paid once per company per organisation; plus 0.2 credits with evidence |
| `GET /tech-intel?...&cursor=` | Each further page, up to `max_pages` in total | Free without evidence; 0.2 credits with evidence |

A repeated identifier in the input reuses the earlier response and is not requested again.

## Workflow

1. Read and validate the input and configuration.
2. For each row: take `company_id` when filled, otherwise the normalised `domain`.
3. Read Tech Intel, following `next_cursor` until the last page or `max_pages`.
4. Check every signal against the retrieved technologies.
5. Check the tiers in order and assign the first one that is met.
6. Write `report.html`, `results.csv` and `results.json`.

## Rules

A technology matches a signal when its `product_slug`, `vendor_slug` or `category_slug` is in the signal's lists, or its `product` or `vendor` name equals an alias, ignoring case and surrounding spaces. There is no fuzzy or partial matching. A match counts only when its `confidence` is at or above the signal's `min_confidence`, in the order `low`, `medium`, `high`. A match below that is listed under `below_threshold` with the reason.

Each signal gets one result per account:

| Result | Rule |
| - | - |
| `observed` | At least one retrieved technology matched at or above `min_confidence`. |
| `not_observed` | No qualifying match, and every page of the technology list was retrieved. |
| `not_observed_in_pages_retrieved` | No qualifying match, but the technology list is incomplete. |

Each condition is `yes`, `no` or `unknown`:

| Condition | yes | no | unknown |
| - | - | - | - |
| `all` | Every signal observed. | Any signal not observed in a complete list. | Otherwise. |
| `any` | At least one signal observed. | Every signal not observed in a complete list. | Otherwise. |
| `none` | Every signal not observed in a complete list. | Any signal observed. | Otherwise. |

A tier is `met` when every condition it uses is yes, `not_met` when any is no, and `undetermined` otherwise. An unknown signal never satisfies a condition, so a `none` condition is met only on a complete technology list.

Each account gets one status:

| Status | Rule |
| - | - |
| `tier_assigned` | A tier is met and no higher tier is undetermined. |
| `needs_review` | A higher tier is undetermined because the list is incomplete. `tier_id` holds the tier met in retrieved data, if any, and `review_tiers` lists the undetermined tiers above it. |
| `no_tier` | No tier is met in a complete technology list. |
| `no_data` | Firmable holds no technology data for the company (`total` 0), or Tech Intel returned 404. |
| `invalid_input` | The domain or company ID is not valid. |
| `access_denied` | Tech Intel returned 403 Forbidden, so the API key cannot use Tech Intel. The run stops, and later rows are marked `not_processed`. |
| `error` | The first Tech Intel page failed. |
| `not_processed` | The run stopped before this row. |

## Evidence and data checks

With evidence on, each matched technology shows its evidence fields as returned: confidence, first and last seen, evidence count, the counts by type and every listed record. The recipe reports records with no source location, fewer records listed than `evidence_count`, and evidence types the API marks as `capped`. Records are shown as returned, not dropped.

The recipe also reports, in `data_notes`, when the API's `total` differs from the technologies returned in a complete list, and when the same `product_slug` appears more than once with different confidence values.

## Output

- `report.html`: a status summary and a tier table, then one card per account with its tier, each tier check, each signal result, the matched technologies and their evidence. The raw requests and responses are at the end.
- `results.csv`: one row per input row, in input order, with the status, tier, tiers to review, list completeness, signal results and matched technologies.
- `results.json`: everything, including every tier check, every signal match as returned and the request ledger.

`confidence`, `recency`, `last_observed`, `nature` and evidence fields come from the API and are shown unchanged.

## Estimated cost

For 100 unique accounts without evidence: up to 500 credits for the first page of each company. Further pages are free. With evidence and `max_pages` of 5, add up to 100 credits for evidence pages. Technologies are paid once per company per organisation. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see the [Python](python/README.md) and [TypeScript](typescript/README.md) READMEs.

```bash
# Python, plan mode (no API calls)
firmable-tech-fit-tiers --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-tech-fit-tiers --input examples/input.csv --config config.example.json --out out --live --max-credits 30
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
- A tier is the result of your rules. It is not a score, a forecast or a model output.
- A detected technology does not prove buying intent, spend, licence count or active usage.
- "Not observed" means not observed in retrieved data. It never means the company does not use the technology.
- A low `max_pages`, or evidence on with its 10 technologies a page, leaves large lists incomplete. Those accounts are more often `needs_review`.
- Accounts come from your input file. The API cannot list companies by technology.
- Tech Intel accepts one company per request. The recipe reads one company at a time.
