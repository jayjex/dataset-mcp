#!/usr/bin/env node
/**
 * dataset-mcp — MCP server over the jayjex Data Vault catalog.
 *
 * Catalog: https://jayjex.github.io/data-vault/catalog.json
 * Samples are fetched on demand from jayjex.github.io — the server ships no data.
 *
 * Tools:
 *  - list_datasets()                — every dataset in the catalog
 *  - get_dataset_info(slug)         — full catalog entry for one dataset
 *  - get_sample(slug, format)       — free sample rows ("json" default, or "csv")
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.0.0";
const CATALOG_URL =
  process.env.DATA_VAULT_CATALOG_URL ||
  "https://jayjex.github.io/data-vault/catalog.json";
const SAMPLE_BASE =
  process.env.DATA_VAULT_SAMPLE_BASE ||
  "https://jayjex.github.io/data-vault/data";
const FETCH_TIMEOUT_MS = 15000;
const MAX_SAMPLE_CHARS = 200_000;
const CATALOG_TTL_MS = 10 * 60 * 1000;

let catalogCache = null; // { fetchedAt, catalog }

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json, text/csv, text/*;q=0.8, */*;q=0.5" },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} fetching ${url}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.text();
}

async function getCatalog() {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.catalog;
  }
  const raw = await fetchText(CATALOG_URL);
  const catalog = JSON.parse(raw);
  if (!catalog || !Array.isArray(catalog.datasets)) {
    throw new Error(`catalog at ${CATALOG_URL} has no datasets[] array`);
  }
  catalogCache = { fetchedAt: Date.now(), catalog };
  return catalog;
}

function findDataset(catalog, slug) {
  const key = String(slug || "").trim().toLowerCase();
  const ds = catalog.datasets.find((d) => String(d.slug).toLowerCase() === key);
  if (ds) return ds;
  const slugs = catalog.datasets.map((d) => d.slug).join(", ");
  const err = new Error(`Unknown dataset slug "${slug}". Available slugs: ${slugs}`);
  err.statusCode = 404;
  throw err;
}

function briefEntry(d) {
  return {
    slug: d.slug,
    name: d.name,
    niche: d.niche,
    description: d.description,
    stats: d.stats,
    sample: d.sample
      ? { csv: d.sample.csv, json: d.sample.json }
      : undefined,
    full_data: d.full_data,
    page: d.page,
  };
}

const server = new McpServer(
  { name: "dataset-mcp", version: VERSION },
  {
    instructions:
      "Browse the jayjex Data Vault catalog: free CSV/JSON samples for public datasets (sports betting lines, HUD fair market rents, Airbnb listings, crypto bounties, scraping scripts). " +
      "Use list_datasets to see what exists, get_dataset_info for one dataset's full entry, get_sample to pull free sample rows. " +
      "Samples fetch live from jayjex.github.io, so calls need network access. Full packs are optional paid downloads, never required for sampling.",
  }
);

server.tool(
  "list_datasets",
  "List every dataset in the jayjex Data Vault catalog: slug, name, niche, row counts, sample URLs, and whether a full pack exists.",
  {},
  async () => {
    const catalog = await getCatalog();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              catalog: catalog.name,
              url: CATALOG_URL,
              last_built: catalog.last_built,
              count: catalog.datasets.length,
              datasets: catalog.datasets.map(briefEntry),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_dataset_info",
  "Full catalog entry for one dataset: columns, stats, sample URLs, extra files, license, full-pack availability and price.",
  { slug: z.string().describe("Dataset slug, e.g. \"hud-fmr-2026\" or \"nfl-games\"") },
  async ({ slug }) => {
    const catalog = await getCatalog();
    const d = findDataset(catalog, slug);
    return {
      content: [{ type: "text", text: JSON.stringify(d, null, 2) }],
    };
  }
);

server.tool(
  "get_sample",
  "Fetch free sample rows for one dataset. format \"json\" (default) returns the sample.json structure with records; \"csv\" returns raw sample.csv text.",
  {
    slug: z.string().describe("Dataset slug, e.g. \"hud-fmr-2026\""),
    format: z
      .enum(["json", "csv"])
      .default("json")
      .describe("Sample format to fetch"),
  },
  async ({ slug, format }) => {
    const catalog = await getCatalog();
    const d = findDataset(catalog, slug);
    const url =
      format === "csv"
        ? d.sample?.csv || `${SAMPLE_BASE}/${d.slug}/sample.csv`
        : d.sample?.json || `${SAMPLE_BASE}/${d.slug}/sample.json`;
    let text = await fetchText(url);
    let truncated = false;
    if (text.length > MAX_SAMPLE_CHARS) {
      text = text.slice(0, MAX_SAMPLE_CHARS);
      truncated = true;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            slug: d.slug,
            format,
            source: url,
            bytes: truncated ? MAX_SAMPLE_CHARS : Buffer.byteLength(text),
            truncated,
            data: text,
          }),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
