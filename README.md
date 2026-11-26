# firmable-tech-intelligence

Examples that call the [Firmable Tech Intelligence API](https://docs.firmable.com/api-reference/tech-intelligence.md) directly. Tech Intelligence lists the technologies Firmable has observed at a company, with confidence, recency, the last date observed and, optionally, the evidence behind each one.

**Who it is for:** Product, partnerships and market research teams who want to understand technology ecosystems across a list of companies, and sales teams who want to tier accounts and prepare talking points from observed stacks.

Every example has a Python and a TypeScript implementation that produce the same results. The examples call Firmable's REST endpoints (`GET /tech-intel`) with an API key and apply rules you can read and change in each configuration file.

**This is API code with no LLM integration.** The examples do not call OpenAI, Anthropic or any other model provider, and use no agent framework. They do not use MCP. For sales workflows across several Firmable APIs, see [gtm-starter-kit](https://github.com/Firmable/gtm-starter-kit).

## Examples

| Example | For | What it does |
| - | - | - |
| [ecosystem-explorer](recipes/ecosystem-explorer) | Flagship, research | Shows which technologies appear across your company list and which appear together, in an interactive explorer with company drilldowns |
| [stack-comparison](recipes/stack-comparison) | Research | Compares the observed stacks of up to 20 companies: shared, different and unknown |
| [integration-audience-map](recipes/integration-audience-map) | Research, partnerships | Finds the companies in your list whose observed stacks include the technologies you integrate with |
| [tech-fit-tiers](recipes/tech-fit-tiers) | Sales | Assigns accounts to outreach tiers with ordered rules on observed technologies |
| [stack-talk-tracks](recipes/stack-talk-tracks) | Sales | Fills your talking-point templates from each account's observed technologies, kept separate from the facts |

Each example folder has a README with its question, inputs, the endpoints and fields it uses, rules, cost and commands, plus `python/README.md` and `typescript/README.md`.

## Quick start

Requires Python 3.11 to 3.13 or Node.js 22 or 24.

```bash
git clone https://github.com/Firmable/firmable-tech-intelligence.git && cd firmable-tech-intelligence

# Python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

# TypeScript
npm ci && npm run build
```

## Plan mode and live mode

Every run is plan mode unless you add `--live`. There is no demo mode with sample data.

| | Plan mode (default) | Live mode |
| - | - | - |
| Calls the API | No | Yes |
| Needs a key | No | `FIRMABLE_API_KEY` |
| Spends credits | No | Up to `--max-credits` |
| Writes | `plan.json`: the calls and the most credits they could use | `report.html`, `results.csv`, `results.json`, and Markdown files for the briefs |

Plan the flagship:

```bash
cd recipes/ecosystem-explorer
firmable-ecosystem-explorer --input examples/input.csv --config config.example.json --out out
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out
```

Run it live:

1. Create a developer key at [platform.firmable.com](https://platform.firmable.com). See [docs/authentication.md](docs/authentication.md).
2. `export FIRMABLE_API_KEY=fbl_dev_...` (or copy `.env.example` to `.env` and load it in your shell; never commit it).
3. Add `--live --max-credits N`, using the upper bound plan mode printed:

```bash
firmable-ecosystem-explorer --input examples/input.csv --config config.example.json --out out --live --max-credits 10
```

Open `out/report.html` in a browser. Replace `examples/input.csv` with your own list of companies.

## Interpreting the results

- Live runs spend developer credits. See [docs/credits-and-pricing.md](docs/credits-and-pricing.md).
- `--max-credits` is a limit enforced by this code before each request. It is not a cap on your Firmable account.
- A timeout or server error on a paid call may still have been charged. Reports count these separately. Nothing is retried automatically.
- Every count and percentage applies to the companies in your input file. It does not describe a market, sector or population.
- `unknown` means Firmable does not hold the fact. It is never treated as no.
- Not observed in the retrieved data does not mean it does not exist.
- Recipes flag data problems they can detect. They do not correct upstream data.
- The REST API has no general company search, so every cohort is the list of companies you supply.
- Two technologies observed at the same company do not show that they are integrated, compatible or used together.
- A detected technology does not prove buying intent, spend or active use.

## Documentation

- [Getting started](docs/getting-started.md)
- [Authentication](docs/authentication.md)
- [Credits and pricing](docs/credits-and-pricing.md)
- [API reference](docs/api-reference.md)
- [Understanding results](docs/understanding-results.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)

## Supported versions

| Runtime | Versions tested in CI |
| - | - |
| Python | 3.11, 3.12, 3.13 |
| Node.js | 22, 24 |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
