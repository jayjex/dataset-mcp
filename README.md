# dataset-mcp

MCP server over the [jayjex Data Vault](https://jayjex.github.io/data-vault/). Sample data is free, and since v1.1.0 the full released files are queryable too: filter, paginate, and summarize every row without downloading anything yourself.

Full data lives in a public GitHub release ([data-v1](https://github.com/jayjex/dataset-mcp/releases/tag/data-v1), 24 MB across 26 files). The server downloads a file once into `~/.cache/dataset-mcp/`, pins the cache to the manifest SHA-256, and then answers queries from memory.

## Datasets

Browse the full catalog at [jayjex.github.io/data-vault](https://jayjex.github.io/data-vault/): 51,895 HUD rent rows, 7,548 NFL games, 90,169 Airbnb listings. Samples are free, and this server queries the full files at no cost.

| slug | what it is | rows | license |
|---|---|---|---|
| `nfl-games` | NFL games with scores, closing spreads, totals, moneylines, 1999-2026 | 7,548 + 2 derived tables | CC BY 4.0 (nflverse) |
| `hud-fmr-2026` | HUD Fair Market Rents FY2026, rent by ZIP, county, and state | 51,895 + 2 tables | Public domain (US government data) |
| `hud-fmr-2027` | HUD Fair Market Rents FY2027, effective October 1, 2026, same three tables | 51,871 + 2 tables | Public domain (US government data) |
| `airbnb-six-cities` | Airbnb listings in Austin, Nashville, Denver, NYC, Las Vegas, San Diego | 90,169 across 6 files | CC BY 4.0 (Inside Airbnb) |
| `earn-bounties` | Superteam Earn listings: cards, full descriptions, 186+ API routes | 51 cards / 28 descriptions | Public API aggregate |
| `scraper-pack` | Playwright scraping scripts (samples only) | n/a | See data-vault page |

## Tools

- `list_datasets()`: every dataset in the catalog plus full-query availability and release sizes.
- `get_dataset_info(slug)`: catalog entry merged with the release manifest: file list with row counts, byte sizes, SHA-256, attribution, and query tips.
- `get_sample(slug, format)`: free preview rows, about 22 per dataset.
- `query_dataset(slug, {file?, columns?, where?, limit?, offset?, format?})`: filter and paginate the full file. `where` clauses support `=`, `contains` (case-insensitive), `gt`, `lt`; numeric compare when both sides are numeric, lexicographic fallback for dates and strings. 100 rows per call, `next_offset` pages through the rest.
- `get_stats(slug, {file?, column?, top?})`: row count, non-empty and unique counts, numeric min/max/mean, top-N value frequencies.

## Query examples

New York, NY rents from the FY2027 ZIP table (51,871 rows, rates effective October 1, 2026):

```
query_dataset("hud-fmr-2027", {
  where: [{ column: "state", op: "=", value: "NY" }],
  limit: 5
})
```

Returns `total_matched: 2397` with rows like:

```json
{
  "zip": "10001",
  "area_name": "New York, NY HUD Metro FMR Area",
  "state": "NY",
  "fmr_2br": "4460"
}
```

Texas rents from the FY2026 ZIP table:

```
query_dataset("hud-fmr-2026", {
  where: [{ column: "state", op: "=", value: "TX" }],
  limit: 5
})
```

Returns `total_matched: 3247` with rows like:

```json
{
  "zip": "76437",
  "area_name": "Abilene, TX MSA",
  "state": "TX",
  "fmr_2br": "1090"
}
```

Every 2025 NFL game (285 matched):

```
query_dataset("nfl-games", {
  where: [{ column: "season", op: "=", value: 2025 }],
  limit: 10
})
```

NYC Airbnb price stats:

```
get_stats("airbnb-six-cities", { file: "airbnb-new-york-city.csv", column: "price" })
```

Returns `rows: 30234, min: 4.58, max: 31210.79, mean: 267.35` plus the most common prices.

Filter JSON without converting to CSV:

```
query_dataset("earn-bounties", {
  where: [{ column: "rewardAmount", op: "gt", value: 5000 }],
  columns: ["title", "rewardAmount", "token"]
})
```

`format: "csv"` returns the page as CSV text if your pipeline prefers raw rows.

## Config

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dataset-mcp": {
      "command": "npx",
      "args": ["-y", "github:jayjex/dataset-mcp"]
    }
  }
}
```

pi, Codex, or other TOML-based agents:

```toml
[mcp_servers.dataset-mcp]
command = "npx"
args = ["-y", "github:jayjex/dataset-mcp"]
```

npm 12 refuses git-based installs by default (`EALLOWGIT`). Pass the flag through npx:

```json
{
  "mcpServers": {
    "dataset-mcp": {
      "command": "npx",
      "args": ["--allow-git=all", "-y", "github:jayjex/dataset-mcp"]
    }
  }
}
```

or set `allow-git=github.com` once in your `~/.npmrc`. npm 10 and 11 need no flag.

Once the npm package is published, `npx -y @jayjex/dataset-mcp` does the same thing as the git form, with no allow-git flag needed.

## How it works

Three HTTPS sources, no API key, no auth, no tracking:

- `https://jayjex.github.io/data-vault/catalog.json`: dataset index (cached 10 minutes).
- `https://raw.githubusercontent.com/jayjex/dataset-mcp/main/data/manifest.json`: release manifest with per-file SHA-256, rows, bytes, and download URLs (cached 10 minutes).
- `https://github.com/jayjex/dataset-mcp/releases/download/data-v1/<file>`: the full files themselves, streamed into the local cache on first query.

A cached file is re-verified against the manifest hash on every load, so a stale or corrupted cache triggers one fresh download instead of serving wrong data. If a tool returns a network error, check that your agent can reach github.com and raw.githubusercontent.com.

Environment overrides:

- `DATA_VAULT_CATALOG_URL`: catalog URL (default above).
- `DATA_VAULT_SAMPLE_BASE`: sample base URL (default `https://jayjex.github.io/data-vault/data`).
- `DATASET_MCP_MANIFEST_URL`: manifest URL (default above).
- `DATASET_MCP_CACHE_DIR`: cache directory (default `~/.cache/dataset-mcp`).

## Licenses

MIT for the server code. Per-dataset licenses ship in the manifest and in `get_dataset_info`: public domain for US government data, CC BY 4.0 where the sources require attribution (nflverse, Inside Airbnb). Keep the attribution lines when you republish the data.

## Roadmap

Query access is free and unlimited. A paid per-call tier over x402 is planned for high-volume commercial scraping of the same files; the free query path stays.
