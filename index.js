#!/usr/bin/env node
/**
 * dataset-mcp: MCP server over the jayjex Data Vault catalog.
 *
 * Catalog: https://jayjex.github.io/data-vault/catalog.json
 * Full files: https://github.com/jayjex/dataset-mcp/releases/tag/data-v1
 *
 * Tools:
 *  - list_datasets()                        : every dataset in the catalog (+ full-query availability)
 *  - get_dataset_info(slug)                 : catalog entry + release manifest (sizes, sha256, attribution, query tips)
 *  - get_sample(slug, format)               : free sample rows ("json" default, or "csv")
 *  - query_dataset(slug, {...})             : filter + paginate the FULL released file (100 rows/call)
 *  - get_stats(slug, {...})                 : row counts, unique counts, numeric min/max/mean, top-N frequencies
 *
 * The server ships no data files. Full CSV/JSON files download once from the public
 * GitHub release into a local cache (~/.cache/dataset-mcp/) and are validated against
 * the manifest sha256 on every load.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = "1.1.3";
const CATALOG_URL =
  process.env.DATA_VAULT_CATALOG_URL ||
  "https://jayjex.github.io/data-vault/catalog.json";
const SAMPLE_BASE =
  process.env.DATA_VAULT_SAMPLE_BASE ||
  "https://jayjex.github.io/data-vault/data";
const MANIFEST_URL =
  process.env.DATASET_MCP_MANIFEST_URL ||
  "https://raw.githubusercontent.com/jayjex/dataset-mcp/main/data/manifest.json";
const MANIFEST_FALLBACK_URL =
  "https://github.com/jayjex/dataset-mcp/releases/download/data-v1/manifest.json";
const CACHE_DIR =
  process.env.DATASET_MCP_CACHE_DIR || join(homedir(), ".cache", "dataset-mcp");
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_SAMPLE_CHARS = 200_000;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const MAX_ROWS_PER_CALL = 100;
const DEFAULT_ROWS_PER_CALL = 20;
const MAX_TOP = 50;

let catalogCache = null; // { fetchedAt, catalog }
let manifestCache = null; // { fetchedAt, manifest }

// ---------------------------------------------------------------- fetch utils

async function fetchWithRetry(url, { timeoutMs, accept }) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} fetching ${url}`);
        err.statusCode = res.status;
        throw err;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
        throw err; // client errors: retrying will not help
      }
    }
  }
  throw lastErr;
}

async function fetchText(url) {
  const res = await fetchWithRetry(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    accept: "application/json, text/csv, text/*;q=0.8, */*;q=0.5",
  });
  return res.text();
}

// ---------------------------------------------------------------- catalog

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

// ---------------------------------------------------------------- manifest

async function getManifest() {
  if (manifestCache && Date.now() - manifestCache.fetchedAt < MANIFEST_TTL_MS) {
    return manifestCache.manifest;
  }
  let raw;
  try {
    raw = await fetchText(MANIFEST_URL);
  } catch (err) {
    raw = await fetchText(MANIFEST_FALLBACK_URL);
  }
  const manifest = JSON.parse(raw);
  if (!manifest || !manifest.datasets || typeof manifest.datasets !== "object") {
    throw new Error(`manifest at ${MANIFEST_URL} has no datasets object`);
  }
  manifestCache = { fetchedAt: Date.now(), manifest };
  return manifest;
}

function findManifestEntry(manifest, slug) {
  const key = String(slug || "").trim().toLowerCase();
  const entry = manifest.datasets[key];
  if (!entry) {
    const slugs = Object.keys(manifest.datasets).join(", ");
    const err = new Error(`Unknown queryable slug "${slug}". Queryable slugs: ${slugs}`);
    err.statusCode = 404;
    throw err;
  }
  return entry;
}

function findFileEntry(entry, file) {
  if (!file) {
    const def = entry.files.find((f) => f.file === entry.default_file);
    if (def) return def;
  }
  const key = String(file || "").trim();
  const hit = entry.files.find((f) => f.file.toLowerCase() === key.toLowerCase());
  if (!hit) {
    const err = new Error(
      `Unknown file "${file}" for this dataset. Files: ${entry.files.map((f) => f.file).join(", ")} (default: ${entry.default_file})`
    );
    err.statusCode = 404;
    throw err;
  }
  return hit;
}

// ---------------------------------------------------------------- file cache

function cachePath(fileName) {
  return join(CACHE_DIR, fileName);
}

async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function downloadToFile(url, destPath) {
  const res = await fetchWithRetry(url, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    accept: "application/octet-stream, text/csv, application/json, */*",
  });
  const tmp = destPath + ".part-" + Math.random().toString(36).slice(2);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, destPath);
}

/**
 * Make sure the released file is in the local cache and matches the manifest
 * sha256. Download once, re-verify on every load; a hash mismatch (stale or
 * corrupted cache, or a manifest update) forces a fresh download.
 */
async function ensureCached(fileEntry) {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = cachePath(fileEntry.file);
  try {
    const st = await stat(path);
    if (st.isFile()) {
      const hash = await sha256File(path);
      if (hash === fileEntry.sha256) return path;
      // stale cache from an older release: drop and re-download
      await rm(path, { force: true });
    }
  } catch {
    // not cached yet
  }
  await downloadToFile(fileEntry.url, path);
  const hash = await sha256File(path);
  if (fileEntry.sha256 && hash !== fileEntry.sha256) {
    await rm(path, { force: true });
    throw new Error(
      `Downloaded ${fileEntry.file} failed sha256 verification (expected ${fileEntry.sha256}, got ${hash})`
    );
  }
  await writeFile(
    path + ".meta.json",
    JSON.stringify({ file: fileEntry.file, sha256: hash, cachedAt: new Date().toISOString() }, null, 2)
  );
  return path;
}

// ---------------------------------------------------------------- CSV parsing (RFC 4180, zero deps)

/**
 * Parse CSV text into { header: string[], rows: string[][] }.
 * Handles quoted fields, escaped quotes (""),
 * embedded commas and newlines, and CRLF line endings.
 */
export function parseCsv(text) {
  const header = [];
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;
  const n = text.length;

  function pushField() {
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  }
  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // trailing field without newline
  if (field !== "" || row.length > 0) pushRow();

  // drop a possible empty final row
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  if (rows.length) {
    for (const f of rows[0]) header.push(f);
    rows.shift();
  }
  // ragged rows: pad short rows, keep everything
  return { header, rows };
}

function rowsToObjects(header, rows) {
  return rows.map((r) => {
    const o = {};
    for (let c = 0; c < header.length; c++) o[header[c]] = r[c] === undefined ? "" : r[c];
    return o;
  });
}

function parseJsonRows(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("JSON file is not an array of records");
  return data;
}

async function loadRecords(fileEntry) {
  const path = await ensureCached(fileEntry);
  const text = await readFile(path, "utf8");
  if (fileEntry.file.toLowerCase().endsWith(".json")) {
    return { records: parseJsonRows(text), text: null };
  }
  const { header, rows } = parseCsv(text);
  return { records: rowsToObjects(header, rows), text: null, header };
}

// ---------------------------------------------------------------- filtering

function asNum(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const t = String(v).trim();
  if (t === "") return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const NUMERIC_STRING = /^\s*-?\d+(\.\d+)?\s*$/;

function compareCell(cell, op, value) {
  const cellStr = cell === null || cell === undefined ? "" : String(cell);
  const valStr = value === null || value === undefined ? "" : String(value);
  const cellNum = asNum(cellStr);
  const valNum = asNum(valStr);
  const bothNumeric =
    Number.isFinite(cellNum) && Number.isFinite(valNum) &&
    (typeof value === "number" || NUMERIC_STRING.test(valStr));

  switch (op) {
    case "=":
      if (bothNumeric) return cellNum === valNum;
      return cellStr.trim() === valStr.trim();
    case "contains":
      return cellStr.toLowerCase().includes(valStr.toLowerCase());
    case "gt":
      if (bothNumeric) return cellNum > valNum;
      if (cellStr === "" ) return false;
      return cellStr > valStr; // lexicographic fallback (dates, ids)
    case "lt":
      if (bothNumeric) return cellNum < valNum;
      if (cellStr === "") return false;
      return cellStr < valStr;
    default:
      return undefined;
  }
}

function applyWhere(records, where) {
  if (!where || where.length === 0) return { records, errors: [] };
  const errors = [];
  const validOps = new Set(["=", "contains", "gt", "lt"]);
  const clauses = where.map((w, idx) => {
    if (!w || typeof w !== "object" || !w.column || !validOps.has(w.op)) {
      errors.push(`where[${idx}]: needs {column, op, value} with op one of =, contains, gt, lt`);
      return null;
    }
    return w;
  });
  if (errors.length) return { records: null, errors };
  const filtered = records.filter((rec) =>
    clauses.every((w) => compareCell(rec[w.column], w.op, w.value))
  );
  return { records: filtered, errors };
}

function selectColumns(records, columns) {
  if (!columns || columns.length === 0) return { records, columns: null };
  const wanted = [...new Set(columns.map(String))];
  return { records, columns: wanted };
}

// ---------------------------------------------------------------- stats

function numericStats(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (const v of values) {
    const n = asNum(v);
    if (!Number.isFinite(n)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
    sum += n;
    count++;
  }
  if (count === 0) return null;
  return { min, max, mean: sum / count, numeric_count: count };
}

// ---------------------------------------------------------------- catalog helpers

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
    sample: d.sample ? { csv: d.sample.csv, json: d.sample.json } : undefined,
    full_data: d.full_data,
    page: d.page,
  };
}

function releaseLink() {
  return "https://github.com/jayjex/dataset-mcp/releases/tag/data-v1";
}

// ---------------------------------------------------------------- MCP server

const server = new McpServer(
  { name: "dataset-mcp", version: VERSION },
  {
    instructions:
      "Public dataset catalog with full query access. list_datasets shows every dataset; query_dataset filters and paginates the FULL released files (100 rows per call, use offset to page through); get_stats summarizes a column (uniques, numeric min/max/mean, top-N); get_sample fetches a small preview. " +
      "query_dataset and get_stats download the file once from the public GitHub release into a local cache keyed by sha256, so repeat calls are instant. " +
      "Examples: query_dataset(\"hud-fmr-2026\", { where: [{column: \"state\", op: \"=\", value: \"TX\"}], limit: 5 }); query_dataset(\"hud-fmr-2027\", { where: [{column: \"state\", op: \"=\", value: \"CA\"}], limit: 5 }); query_dataset(\"hud-fmr-by-zip-2027\", { where: [{column: \"state\", op: \"=\", value: \"TX\"}], limit: 5 }); query_dataset(\"hud-fmr-by-zip-2027\", { where: [{column: \"zip\", op: \"=\", value: \"95060\"}] }); query_dataset(\"hud-fmr-metro-2027\", { file: \"most-expensive-2br.csv\", limit: 10 }); query_dataset(\"nfl-games\", { where: [{column: \"season\", op: \"=\", value: 2025}], limit: 10 }); get_stats(\"airbnb-six-cities\", { file: \"airbnb-new-york-city.csv\", column: \"price\" }).",
  }
);

server.tool(
  "list_datasets",
  "List every dataset in the jayjex Data Vault catalog: slug, name, niche, row counts, sample URLs, plus whether the full files are queryable through query_dataset (release sizes included).",
  {},
  async () => {
    const catalog = await getCatalog();
    let manifest = null;
    try {
      manifest = await getManifest();
    } catch {
      manifest = null;
    }
    const datasets = catalog.datasets.map((d) => {
      const entry = manifest ? manifest.datasets[d.slug] : null;
      const out = briefEntry(d);
      if (entry) {
        const dataFiles = entry.files.filter((f) => f.type === "data" || f.rows !== undefined);
        out.full_query = {
          available: true,
          release: releaseLink(),
          default_file: entry.default_file,
          files: entry.files.map((f) => ({ file: f.file, rows: f.rows, bytes: f.bytes, type: f.type })),
          total_bytes: entry.files.reduce((a, f) => a + (f.bytes || 0), 0),
          data_rows: dataFiles.reduce((a, f) => a + (f.rows || 0), 0),
        };
      } else {
        out.full_query = { available: false };
      }
      return out;
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              catalog: catalog.name,
              url: CATALOG_URL,
              last_built: catalog.last_built,
              count: datasets.length,
              full_query_hint:
                "Use query_dataset(slug, {where, columns, limit, offset}) to pull any number of rows in pages of up to 100; get_stats(slug, {column}) for summaries.",
              datasets,
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
  "Full entry for one dataset: catalog metadata (columns, stats, sample URLs, license, page) merged with the release manifest (file sizes, sha256, row counts, attribution, query tips).",
  { slug: z.string().describe("Dataset slug, e.g. \"hud-fmr-2026\" or \"nfl-games\"") },
  async ({ slug }) => {
    const catalog = await getCatalog();
    const d = findDataset(catalog, slug);
    let manifest = null;
    try {
      manifest = await getManifest();
    } catch {
      manifest = null;
    }
    const entry = manifest ? manifest.datasets[String(slug).toLowerCase()] : null;
    const out = { ...d };
    if (entry) {
      out.full_query = {
        available: true,
        release: releaseLink(),
        attribution: entry.attribution,
        license: entry.license,
        query_tips: entry.query_tips,
        default_file: entry.default_file,
        files: entry.files,
        full_size_bytes: entry.files.reduce((a, f) => a + (f.bytes || 0), 0),
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
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

server.tool(
  "query_dataset",
  "Filter and paginate the FULL released file for a dataset. Downloads the file once from the public release into a local cache (validated by sha256), then filters in memory. Max 100 rows per call; pass next_offset to keep paging.",
  {
    slug: z.string().describe("Queryable dataset slug, e.g. \"hud-fmr-2026\", \"hud-fmr-2027\", \"hud-fmr-metro-2027\", \"nfl-games\", \"airbnb-six-cities\", \"earn-bounties\""),
    file: z
      .string()
      .optional()
      .describe("Released file to query when a dataset has several (e.g. airbnb-six-cities has one file per city). Defaults to the dataset's main file."),
    columns: z
      .array(z.string())
      .optional()
      .describe("Return only these columns, in this order. Defaults to all columns."),
    where: z
      .array(
        z.object({
          column: z.string().describe("Column name to filter on"),
          op: z.enum(["=", "contains", "gt", "lt"]).describe("Filter operator; contains is case-insensitive, gt/lt fall back to lexicographic compare for non-numeric values"),
          value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to compare against"),
        })
      )
      .optional()
      .describe("Filter clauses, all must match (AND)."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(DEFAULT_ROWS_PER_CALL)
      .describe(`Rows to return per call, capped at ${MAX_ROWS_PER_CALL}.`),
    offset: z.number().int().min(0).optional().default(0).describe("Row offset into the filtered result set."),
    format: z.enum(["json", "csv"]).optional().default("json").describe("json returns objects; csv returns the page as CSV text."),
  },
  async ({ slug, file, columns, where, limit, offset, format }) => {
    const manifest = await getManifest();
    const entry = findManifestEntry(manifest, slug);
    const fileEntry = findFileEntry(entry, file);

    let { records, header } = await loadRecords(fileEntry);
    if (!header) {
      // JSON files: derive header from union of keys
      header = [...new Set(records.flatMap((r) => Object.keys(r)))];
    }

    const whereRes = applyWhere(records, where);
    if (whereRes.errors && whereRes.errors.length) {
      throw new Error(whereRes.errors.join("; "));
    }
    const filtered = whereRes.records;
    const totalMatched = filtered.length;

    const capped = Math.min(limit, MAX_ROWS_PER_CALL);
    const page = filtered.slice(offset, offset + capped);
    const nextOffset = offset + capped < totalMatched ? offset + capped : null;

    let outColumns = header;
    if (columns && columns.length) {
      const wanted = [...new Set(columns.map(String))];
      const valid = new Set(header);
      const unknown = wanted.filter((c) => !valid.has(c));
      if (unknown.length) {
        throw new Error(`Unknown column(s): ${unknown.join(", ")}. Available columns: ${header.join(", ")}`);
      }
      outColumns = wanted;
    }

    const base = {
      slug: entry.name ? String(slug) : String(slug),
      file: fileEntry.file,
      file_url: fileEntry.url,
      sha256: fileEntry.sha256,
      total_rows_in_file: fileEntry.rows ?? records.length,
      total_matched: totalMatched,
      offset,
      returned: page.length,
      next_offset: nextOffset,
      columns: outColumns,
    };

    if (format === "csv") {
      const esc = (v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvText =
        outColumns.map(esc).join(",") +
        "\n" +
        page.map((r) => outColumns.map((c) => esc(r[c])).join(",")).join("\n");
      return {
        content: [{ type: "text", text: JSON.stringify({ ...base, format: "csv", csv: csvText }, null, 2) }],
      };
    }

    const rows = page.map((r) => {
      const o = {};
      for (const c of outColumns) o[c] = r[c] === undefined ? "" : r[c];
      return o;
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ ...base, format: "json", rows }, null, 2) }],
    };
  }
);

server.tool(
  "get_stats",
  "Column statistics over the full released file: row count, non-empty and unique counts, numeric min/max/mean, and (for one column) top-N value frequencies.",
  {
    slug: z.string().describe("Queryable dataset slug"),
    file: z.string().optional().describe("Released file to profile when a dataset has several. Defaults to the main file."),
    column: z.string().optional().describe("Column to profile in depth (adds top-N frequencies). Omit for a summary of every column."),
    top: z.number().int().min(1).optional().default(10).describe(`How many top values to return when column is given, capped at ${MAX_TOP}.`),
  },
  async ({ slug, file, column, top }) => {
    const manifest = await getManifest();
    const entry = findManifestEntry(manifest, slug);
    const fileEntry = findFileEntry(entry, file);
    const { records } = await loadRecords(fileEntry);

    if (!records.length) {
      return { content: [{ type: "text", text: JSON.stringify({ slug, file: fileEntry.file, rows: 0 }) }] };
    }

    // For JSON: union of keys; for CSV the loader returns records as objects already
    const allColumns = [...new Set(records.flatMap((r) => Object.keys(r)))];

    if (column) {
      if (!allColumns.includes(column)) {
        throw new Error(`Unknown column "${column}". Available columns: ${allColumns.join(", ")}`);
      }
      const values = records.map((r) => r[column]);
      const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
      const uniq = new Set(nonEmpty.map((v) => String(v)));
      const freq = new Map();
      for (const v of nonEmpty) {
        const k = String(v);
        freq.set(k, (freq.get(k) || 0) + 1);
      }
      const topN = Math.min(top || 10, MAX_TOP);
      const topValues = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([value, count]) => ({ value, count }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                slug,
                file: fileEntry.file,
                rows: records.length,
                column,
                non_empty: nonEmpty.length,
                empty: records.length - nonEmpty.length,
                unique_count: uniq.size,
                numeric: numericStats(nonEmpty),
                top_values: topValues,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const summary = allColumns.map((c) => {
      const values = records.map((r) => r[c]);
      const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
      const uniq = new Set(nonEmpty.map((v) => String(v)));
      return {
        column: c,
        non_empty: nonEmpty.length,
        unique_count: uniq.size,
        numeric: numericStats(nonEmpty),
      };
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { slug, file: fileEntry.file, rows: records.length, column_count: allColumns.length, columns: summary },
            null,
            2
          ),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
