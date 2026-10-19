#!/usr/bin/env bun
/**
 * orp — pick an OpenRouter upstream provider for a known model, then launch
 * `ori pi` with that provider pinned through a small Pi extension.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import {
  deleteKeyringKey,
  getKeyringKey,
  keyringBackend,
  keyringLocation,
  setKeyringKey,
} from "./keyring.ts";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const ROUTING_EXTENSION = fileURLToPath(
  new URL("./routing-extension.ts", import.meta.url)
);

type SortMode = "price" | "tps" | "value";

interface CliOptions {
  model?: string;
  apiKey?: string;
  provider?: string;
  reasoningEffort?: string;
  sort: SortMode;
  allowFallbacks: boolean;
  list: boolean;
  json: boolean;
  noLaunch: boolean;
  noKeyring: boolean;
  yes: boolean;
  passthrough: string[];
}

interface EndpointPricing {
  prompt?: string;
  completion?: string;
}

interface Percentiles {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
}

interface RawEndpoint {
  name: string;
  provider_name?: string;
  tag?: string;
  status?: number;
  pricing?: EndpointPricing;
  throughput_last_30m?: Percentiles | null;
  latency_last_30m?: Percentiles | null;
  uptime_last_30m?: number | null;
  supported_parameters?: string[];
}

interface ProviderRow {
  slug: string;
  provider: string;
  tag: string;
  inputPerM: number;
  outputPerM: number;
  totalPerM: number;
  tps: number;
  latency: number;
  uptime: number;
  score: number;
}

const usage = `
orp — choose an OpenRouter provider and launch ori pi

Usage:
  orp [--model <id>] [options] [-- <ori-pi args>]
  orp --model deepseek/deepseek-chat
  orp --model deepseek/deepseek-chat --provider deepinfra --yes

Model:
  --model, -m <id>          OpenRouter model id (or set MODEL / OPENROUTER_MODEL)
                             If omitted, orp prompts for it.

Provider selection:
  --api-key <key>            OpenRouter key for the pricing API (throughput/latency)
  --no-keyring               Do not read/prompt the OS keyring
  --provider <slug>          Preselect provider, e.g. deepinfra (skips the picker)
  --sort price|tps|value     Ranking for the top 5 table (default: price)
  --no-fallback              Pass allow_fallbacks: false
  --reasoning-effort <lvl>   Forwarded to ori pi

Keyring:
  orp key status             Show keyring backend and whether a key is stored
  orp key set                Prompt for a key and save it to the OS keyring
  orp key clear              Delete the stored key

Output / launch:
  --list                     Print the top 5 table and exit
  --json                     Print JSON and exit
  --no-launch                Pick a provider but do not launch ori pi
  --yes, -y                  Skip the launch confirmation

Passthrough:
  Arguments after -- are forwarded to 'ori pi' after -e <routing extension>.
  Unknown flags before -- are treated as passthrough too.

Environment:
  OPENROUTER_API_KEY         Overrides the keyring. Required for throughput/latency
                             data; without a key the endpoints API returns nulls.
  ORI_OPENROUTER_BASE_URL    Optional API base (default: https://openrouter.ai/api/v1)
`.trim();

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    sort: "price",
    allowFallbacks: true,
    list: false,
    json: false,
    noLaunch: false,
    noKeyring: false,
    yes: false,
    passthrough: [],
  };

  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  opts.passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  const takeValue = (args: string[], index: number, inline: string[]): string => {
    if (inline.length > 0) return inline.join("=");
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${args[index]}`);
    return value;
  };

  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i]!;
    const [flag, ...inline] = arg.split("=");

    switch (flag) {
      case "--model":
      case "-m":
        opts.model = takeValue(head, i, inline);
        if (inline.length === 0) i += 1;
        break;
      case "--api-key":
        opts.apiKey = takeValue(head, i, inline);
        if (inline.length === 0) i += 1;
        break;
      case "--provider":
        opts.provider = takeValue(head, i, inline);
        if (inline.length === 0) i += 1;
        break;
      case "--reasoning-effort":
        opts.reasoningEffort = takeValue(head, i, inline);
        if (inline.length === 0) i += 1;
        break;
      case "--sort": {
        const value = takeValue(head, i, inline);
        if (value !== "price" && value !== "tps" && value !== "value") {
          throw new Error("--sort must be price, tps, or value");
        }
        opts.sort = value;
        if (inline.length === 0) i += 1;
        break;
      }
      case "--no-fallback":
        opts.allowFallbacks = false;
        break;
      case "--list":
        opts.list = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--no-launch":
        opts.noLaunch = true;
        break;
      case "--no-keyring":
        opts.noKeyring = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--help":
      case "-h":
        console.log(usage);
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          opts.passthrough.push(arg);
        } else if (!opts.model) {
          opts.model = arg;
        } else {
          opts.passthrough.push(arg);
        }
    }
  }

  return opts;
}

function apiBaseUrl(): string {
  return (process.env.ORI_OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
}

function normalizeProvider(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function providerSlug(endpoint: RawEndpoint): string {
  const fromTag = endpoint.tag?.split("/")[0]?.trim();
  if (fromTag) return normalizeProvider(fromTag);
  return normalizeProvider(endpoint.provider_name ?? endpoint.name);
}

function perMillion(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : Number.NaN;
}

function p50(value: Percentiles | null | undefined): number {
  return Number.isFinite(value?.p50) ? (value?.p50 as number) : 0;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "?";
  if (value === 0) return "free";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTps(value: number): string {
  return value > 0 ? value.toFixed(1) : "—";
}

function formatLatency(value: number): string {
  return value > 0 ? `${value.toFixed(2)}s` : "—";
}

function formatUptime(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${value.toFixed(1)}%` : "—";
}

function rankRows(endpoints: RawEndpoint[], mode: SortMode): ProviderRow[] {
  const enriched: ProviderRow[] = endpoints
    .map((endpoint) => {
      const inputPerM = perMillion(endpoint.pricing?.prompt);
      const outputPerM = perMillion(endpoint.pricing?.completion);
      const totalPerM = inputPerM + outputPerM;
      const tps = p50(endpoint.throughput_last_30m);
      return {
        slug: providerSlug(endpoint),
        provider: endpoint.provider_name ?? endpoint.name,
        tag: endpoint.tag ?? "",
        inputPerM,
        outputPerM,
        totalPerM,
        tps,
        // The endpoints API reports latency percentiles in milliseconds.
        latency: p50(endpoint.latency_last_30m) / 1000,
        uptime: endpoint.uptime_last_30m ?? 0,
        score: tps > 0 && totalPerM > 0 ? tps / totalPerM : 0,
      };
    })
    .filter(
      (row) =>
        row.slug.length > 0 &&
        Number.isFinite(row.inputPerM) &&
        Number.isFinite(row.outputPerM) &&
        row.inputPerM >= 0 &&
        row.outputPerM >= 0
    );

  const pool = enriched.filter((row) => row.slug.length > 0);

  const comparator = (a: ProviderRow, b: ProviderRow): number => {
    if (mode === "tps") return b.tps - a.tps || a.totalPerM - b.totalPerM;
    if (mode === "value") return b.score - a.score || b.tps - a.tps;
    return a.totalPerM - b.totalPerM || b.tps - a.tps;
  };

  // A provider order entry is a provider slug, not an endpoint. Keep the best
  // endpoint per provider for the same slug.
  const seen = new Set<string>();
  return pool.sort(comparator).filter((row) => {
    if (seen.has(row.slug)) return false;
    seen.add(row.slug);
    return true;
  });
}

function printTable(model: string, rows: ProviderRow[], mode: SortMode): void {
  const top = rows.slice(0, 5);
  const header = [
    "Provider".padEnd(22),
    "Input $/M".padStart(11),
    "Output $/M".padStart(11),
    "tps".padStart(8),
    "latency".padStart(9),
    "uptime".padStart(8),
  ].join("  ");

  console.log(`\nModel: ${model}`);
  console.log(`Ranking: ${mode} (top 5 providers)\n`);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of top) {
    console.log(
      [
        row.slug.padEnd(22),
        formatPrice(row.inputPerM).padStart(11),
        formatPrice(row.outputPerM).padStart(11),
        formatTps(row.tps).padStart(8),
        formatLatency(row.latency).padStart(9),
        formatUptime(row.uptime).padStart(8),
      ].join("  ")
    );
  }
  console.log();
}

function resolveApiKey(
  explicit: string | undefined,
  useKeyring: boolean
): { key?: string; source: string } {
  const fromFlag = explicit?.trim();
  if (fromFlag) return { key: fromFlag, source: "--api-key" };

  for (const name of [
    "OPENROUTER_API_KEY",
    "OR_API_KEY",
    "OPENROUTER_KEY",
  ] as const) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, source: name };
  }

  if (useKeyring) {
    const key = getKeyringKey();
    if (key) return { key, source: "system keyring" };
  }

  return { source: "none" };
}

async function handleKeyCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== "key") return false;
  const subcommand = argv[1] ?? "status";

  if (subcommand === "status") {
    const envKey = Boolean(
      process.env.OPENROUTER_API_KEY?.trim() ||
        process.env.OR_API_KEY?.trim() ||
        process.env.OPENROUTER_KEY?.trim()
    );
    const stored = getKeyringKey();
    console.log(`keyring backend: ${keyringLocation()}`);
    console.log(`stored key:      ${stored ? "yes" : "no"}`);
    console.log(`env key:         ${envKey ? "set" : "not set"}`);
    if (envKey) console.log("resolution:      environment (overrides keyring)");
    else if (stored) console.log("resolution:      system keyring");
    else console.log("resolution:      none");
    return true;
  }

  if (subcommand === "clear") {
    if (!keyringBackend()) {
      console.error("No keyring backend found (install libsecret-tools or python3-keyring).");
      process.exitCode = 1;
      return true;
    }
    const removed = deleteKeyringKey();
    console.log(removed ? "Removed stored OpenRouter key." : "No stored key to remove.");
    return true;
  }

  if (subcommand === "set") {
    if (!keyringBackend()) {
      console.error("No keyring backend found (install libsecret-tools or python3-keyring).");
      process.exitCode = 1;
      return true;
    }
    const value = await password({
      message: "OpenRouter API key (hidden, stored in the OS keyring)",
      validate: (input) => (input?.trim() ? undefined : "Key cannot be empty"),
    });
    if (isCancel(value)) {
      cancel("Cancelled");
      return true;
    }
    const saved = setKeyringKey(String(value).trim());
    if (saved) {
      console.log("Saved OpenRouter key to the system keyring.");
    } else {
      console.error("Failed to save key to the system keyring.");
      process.exitCode = 1;
    }
    return true;
  }

  console.error(`Unknown key subcommand: ${subcommand}`);
  console.error("Use: orp key status | orp key set | orp key clear");
  process.exitCode = 1;
  return true;
}

async function fetchEndpoints(
  model: string,
  key: string | undefined
): Promise<RawEndpoint[]> {
  const path = model
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(`${apiBaseUrl()}/models/${path}/endpoints`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });

  if (!response.ok) {
    throw new Error(
      `OpenRouter endpoints request failed (${response.status}): ${await response.text()}`
    );
  }

  const body = (await response.json()) as {
    data?: { endpoints?: RawEndpoint[] };
  };
  return body.data?.endpoints ?? [];
}

async function promptModel(): Promise<string> {
  const value = await text({
    message: "OpenRouter model ID",
    placeholder: "deepseek/deepseek-chat",
    validate: (input) =>
      input && input.includes("/") ? undefined : "Use an author/slug model id",
  });
  if (isCancel(value)) {
    cancel("Cancelled");
    process.exit(0);
  }
  return String(value).trim();
}

async function pickProvider(
  model: string,
  rows: ProviderRow[]
): Promise<ProviderRow> {
  const top = rows.slice(0, 5);
  const value = await select({
    message: `Provider for ${model}`,
    options: top.map((row) => ({
      value: row.slug,
      label: `${row.slug}  ${formatPrice(row.inputPerM)} in / ${formatPrice(row.outputPerM)} out  ${formatTps(row.tps)} tps`,
      hint: row.tag || undefined,
    })),
  });

  if (isCancel(value)) {
    cancel("Cancelled");
    process.exit(0);
  }

  return top.find((row) => row.slug === value) ?? top[0]!;
}

function findProvider(rows: ProviderRow[], wanted: string): ProviderRow | undefined {
  const slug = normalizeProvider(wanted);
  return rows.find(
    (row) =>
      row.slug === slug ||
      normalizeProvider(row.provider) === slug ||
      row.provider.toLowerCase() === wanted.toLowerCase()
  );
}

function launch(
  model: string,
  provider: ProviderRow,
  opts: CliOptions
): number {
  const args = ["pi", "--model", model];
  if (opts.reasoningEffort) {
    args.push("--reasoning-effort", opts.reasoningEffort);
  }
  args.push("--", "-e", ROUTING_EXTENSION, ...opts.passthrough);

  log.info(
    `Launching: ori ${args.join(" ")}\nPinned provider: ${provider.slug} (fallbacks: ${opts.allowFallbacks ? "on" : "off"})`
  );

  const result = spawnSync("ori", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENROUTER_PROVIDER_ORDER: provider.slug,
      OPENROUTER_ALLOW_FALLBACKS: opts.allowFallbacks ? "1" : "0",
    },
  });

  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await handleKeyCommand(argv)) return;

  const opts = parseArgs(argv);

  if (!opts.json) intro("OpenRouter provider picker for ori pi");

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const model =
    opts.model?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    (interactive ? await promptModel() : "");

  if (!model) {
    throw new Error("No model given. Pass --model <author/slug> or set MODEL.");
  }

  let { key: apiKey, source: apiKeySource } = resolveApiKey(
    opts.apiKey,
    !opts.noKeyring
  );

  if (!apiKey && interactive && !opts.noKeyring) {
    const addKey = await confirm({
      message:
        "No OpenRouter API key found. Store one in the system keyring now?",
      initialValue: true,
    });
    if (!isCancel(addKey) && addKey) {
      const value = await password({
        message: "OpenRouter API key (hidden)",
        validate: (input) => (input?.trim() ? undefined : "Key cannot be empty"),
      });
      if (!isCancel(value) && value) {
        apiKey = String(value).trim();
        apiKeySource = "prompt";
        if (!keyringBackend() || !setKeyringKey(apiKey)) {
          log.warn("Could not save the keyring; using it for this run only.");
        }
      }
    }
  }

  if (!apiKey) {
    process.stderr.write(
      "warning: no OpenRouter API key found. The endpoints API only returns\n" +
        "         throughput (tps) and latency to authenticated requests, so those\n" +
        "         columns will be blank. Set OPENROUTER_API_KEY, pass --api-key,\n" +
        "         or run `orp key set`.\n"
    );
  } else if (!opts.json && !opts.list) {
    log.info(`API key source: ${apiKeySource}`);
  }

  const spin = spinner();
  if (!opts.json && !opts.list) spin.start(`Fetching providers for ${model}`);
  const endpoints = await fetchEndpoints(model, apiKey);
  const rows = rankRows(endpoints, opts.sort);
  if (!opts.json && !opts.list) {
    spin.stop(`${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} found`);
  }

  if (rows.length === 0) {
    throw new Error(`No usable providers returned for ${model}`);
  }

  if (opts.json) {
    console.log(JSON.stringify({ model, rows }, null, 2));
    return;
  }

  printTable(model, rows, opts.sort);

  let chosen: ProviderRow | undefined;
  if (opts.provider) {
    chosen = findProvider(rows, opts.provider);
    if (!chosen) {
      throw new Error(
        `Provider "${opts.provider}" not found. Available: ${rows
          .slice(0, 10)
          .map((row) => row.slug)
          .join(", ")}`
      );
    }
    log.info(`Selected provider: ${chosen.slug}`);
  } else if (opts.list || !interactive) {
    log.info("No interactive terminal; re-run with --provider <slug> to launch.");
    return;
  } else {
    chosen = await pickProvider(model, rows);
  }

  if (opts.noLaunch) {
    log.info(`Selected ${chosen.slug}; --no-launch set, exiting.`);
    outro("Done");
    return;
  }

  if (interactive && !opts.yes) {
    const yes = await confirm({
      message: `Launch ori pi with ${model} pinned to ${chosen.slug}?`,
      initialValue: true,
    });
    if (isCancel(yes) || !yes) {
      cancel("Not launched");
      return;
    }
  }

  const status = launch(model, chosen, opts);
  process.exitCode = status;
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
