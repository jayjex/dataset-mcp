# dataset-mcp

MCP server over the [jayjex Data Vault](https://jayjex.github.io/data-vault/): free sample data from every dataset in the catalog, fetched on demand.

Five datasets right now:

| slug | what it is | rows |
|---|---|---|
| `nfl-games` | NFL games with scores, closing spreads, totals, moneylines, 1999-2026 | 7,548 |
| `hud-fmr-2026` | HUD Fair Market Rents FY2026, rent by ZIP, county, and state | 51,895 |
| `airbnb-six-cities` | Airbnb listings in 6 US cities | varies |
| `earn-bounties` | Superteam Earn listings with rewards and deadlines | varies |
| `scraper-pack` | Playwright scraping scripts | n/a |

Samples are small (about 22 rows each) and free, no signup. The server ships no data. It reads the live catalog at `jayjex.github.io/data-vault`, so new datasets appear without reinstalling anything.

## Tools

- `list_datasets()` — every dataset in the catalog: slug, name, niche, row counts, sample URLs, full-pack availability.
- `get_dataset_info(slug)` — the full catalog entry for one dataset: columns, stats, extra files, license, full-pack price.
- `get_sample(slug, format)` — free sample rows. `format` is `"json"` (default, structured records) or `"csv"` (raw sample text).

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

Prefer a local clone:

```sh
git clone https://github.com/jayjex/dataset-mcp
```

```json
{
  "mcpServers": {
    "dataset-mcp": {
      "command": "node",
      "args": ["/path/to/dataset-mcp/index.js"]
    }
  }
}
```

Once the npm package is published, `npx -y @jayjex/dataset-mcp` does the same thing as the git form.

## How it works

The server fetches two things over HTTPS, nothing else:

- `https://jayjex.github.io/data-vault/catalog.json` for the dataset index (cached 10 minutes).
- `https://jayjex.github.io/data-vault/data/<slug>/sample.json` (or `sample.csv`) when a tool asks for sample rows.

No API key, no auth, no tracking. If the tools return network errors, check that your agent has network access; the GitHub Pages host has to be reachable.

Environment overrides, if you want to point it at a mirror:

- `DATA_VAULT_CATALOG_URL` — catalog URL (default above).
- `DATA_VAULT_SAMPLE_BASE` — sample base URL (default `https://jayjex.github.io/data-vault/data`).

## Sample responses

`get_sample("hud-fmr-2026")` returns records like:

```json
{
  "zip": "76437",
  "hud_area_code": "METRO10180M10180",
  "metro": "metro",
  "area_name": "Abilene, TX MSA",
  "state": "TX",
  "fmr_0br": "850",
  "fmr_2br": "1090",
  "fmr_4br": "1710"
}
```

The full 51,895-row pack (plus county and state tables) is an optional $24 download from the dataset page. Sampling is always free.

## License

MIT for the server code. Each dataset's license is in its catalog entry (`get_dataset_info`): public domain for US government data, CC BY 4.0 where sources require attribution.
