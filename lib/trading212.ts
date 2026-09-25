/**
 * Single read-only Trading 212 client.
 * Every upstream call is GET, serialized, and spaced. There is no write method.
 */

export const TRADING212_BASE_URL = "https://live.trading212.com/api/v0";
export const MIN_TRADING212_SPACING_MS = 350;
export const MAX_RATE_LIMIT_RETRIES = 4;

const READ_ONLY_METHOD = "GET";

/**
 * Cap one 429 sleep so a runaway Retry-After cannot stall the shared queue.
 * Typical Trading 212 Retry-After values for these endpoints sit well under this.
 */
const MAX_RETRY_DELAY_MS = 30_000;
const EXPONENTIAL_BASE_MS = 1_000;
const MAX_EXPONENTIAL_MS = 30_000;
const JITTER_MS = 250;

const HISTORY_ENDPOINTS = [
  "/equity/history/orders",
  "/equity/history/transactions",
  "/equity/history/dividends",
] as const;

export type HistoryEndpoint = (typeof HISTORY_ENDPOINTS)[number];

type QueueState = {
  chain: Promise<unknown>;
  nextAllowedAt: number;
};

export type Trading212ClientOptions = {
  fetchImpl?: typeof fetch;
  minSpacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  state?: QueueState;
};

export class Trading212RateLimitError extends Error {
  readonly code = "RATE_LIMITED" as const;

  constructor() {
    super(
      "RATE_LIMITED: Trading 212 returned HTTP 429 after 4 retries."
    );
    this.name = "RATE_LIMITED";
  }
}

const globalQueue = globalThis as typeof globalThis & {
  __aureliaTrading212Queue?: QueueState;
};

function sharedQueueState(): QueueState {
  if (!globalQueue.__aureliaTrading212Queue) {
    globalQueue.__aureliaTrading212Queue = {
      chain: Promise.resolve(),
      nextAllowedAt: 0,
    };
  }

  return globalQueue.__aureliaTrading212Queue;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parseRetryAfterMs(
  header: string | null,
  nowMs: number
): number | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }

  const dateMs = Date.parse(trimmed);

  if (Number.isNaN(dateMs)) {
    return null;
  }

  return Math.max(0, dateMs - nowMs);
}

export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  nowMs: number,
  random: () => number
): number {
  const exponential = Math.min(
    MAX_EXPONENTIAL_MS,
    EXPONENTIAL_BASE_MS * 2 ** attempt
  );
  const jitter = Math.floor(Math.max(0, random()) * JITTER_MS);
  const retryAfter = parseRetryAfterMs(retryAfterHeader, nowMs);
  const base = retryAfter == null ? exponential : Math.max(retryAfter, exponential);

  return Math.min(MAX_RETRY_DELAY_MS, base + jitter);
}

export function assertReadOnlyEquityGetPath(path: string): void {
  if (!path.startsWith("/equity/") || path.includes("..") || path.includes("://")) {
    throw new Error("Refusing a Trading 212 path outside the read-only equity API.");
  }

  const pathname = path.split("?")[0];
  const allowed =
    pathname === "/equity/account/summary" ||
    pathname === "/equity/positions" ||
    pathname === "/equity/pies" ||
    pathname === "/equity/orders" ||
    pathname === "/equity/history/orders" ||
    pathname === "/equity/history/transactions" ||
    pathname === "/equity/history/dividends" ||
    isPieDetailPath(pathname);

  if (!allowed) {
    throw new Error("Refusing a Trading 212 path outside the read-only equity API.");
  }
}

function isPieDetailPath(pathname: string): boolean {
  if (!pathname.startsWith("/equity/pies/")) {
    return false;
  }

  return /^-?[0-9]+$/.test(pathname.slice("/equity/pies/".length));
}

export function resolveHistoryNextPath(
  nextPagePath: string,
  expectedPathname: HistoryEndpoint
): string {
  const trimmed = nextPagePath.trim();
  let relative: string;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let url: URL;

    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("Refusing a malformed Trading 212 nextPagePath.");
    }

    if (url.protocol !== "https:" || url.hostname !== "live.trading212.com") {
      throw new Error("Refusing a nextPagePath outside https://live.trading212.com.");
    }

    if (url.username || url.password || url.port) {
      throw new Error("Refusing a nextPagePath with credentials or a non-default port.");
    }

    if (!url.pathname.startsWith("/api/v0/")) {
      throw new Error("Refusing a nextPagePath outside /api/v0.");
    }

    relative = `${url.pathname.slice("/api/v0".length)}${url.search}`;
  } else if (trimmed.startsWith("/api/v0/")) {
    relative = trimmed.slice("/api/v0".length);
  } else if (trimmed.startsWith("/equity/")) {
    relative = trimmed;
  } else {
    throw new Error("Refusing a nextPagePath that is not a Trading 212 history path.");
  }

  if (relative.includes("..") || relative.includes("\\") || relative.includes(" ")) {
    throw new Error("Refusing an unsafe Trading 212 nextPagePath.");
  }

  const pathname = relative.split("?")[0];

  if (pathname !== expectedPathname) {
    throw new Error("Refusing a nextPagePath that leaves the requested history endpoint.");
  }

  return relative;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("limit must be an integer from 1 to 50.");
  }

  return limit;
}

export function clampPages(pages: number | undefined): number {
  if (pages === undefined) {
    return 1;
  }

  if (!Number.isInteger(pages) || pages < 1 || pages > 3) {
    throw new Error("pages must be an integer from 1 to 3.");
  }

  return pages;
}

export function buildHistoryPath(
  pathname: HistoryEndpoint,
  query: {
    limit: number;
    cursor?: string | number;
    ticker?: string;
    time?: string;
  }
): string {
  const search = new URLSearchParams();
  search.set("limit", String(query.limit));

  if (query.cursor !== undefined) {
    search.set("cursor", String(query.cursor));
  }

  if (query.ticker !== undefined) {
    search.set("ticker", query.ticker);
  }

  if (query.time !== undefined) {
    search.set("time", query.time);
  }

  return `${pathname}?${search.toString()}`;
}

function normalizeNextPagePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed === "null" || trimmed.startsWith("null&") || trimmed.startsWith("null?")) {
    return null;
  }

  return trimmed;
}

export function parseHistoryPage(body: unknown): {
  items: unknown[];
  nextPagePath: string | null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Trading 212 history response was not a JSON object.");
  }

  const record = body as Record<string, unknown>;
  const items = record.items === undefined ? [] : record.items;

  if (!Array.isArray(items)) {
    throw new Error("Trading 212 history response items was not an array.");
  }

  return {
    items,
    nextPagePath: normalizeNextPagePath(record.nextPagePath),
  };
}

export async function collectHistoryPages(
  get: (path: string) => Promise<unknown>,
  args: {
    pathname: HistoryEndpoint;
    limit?: number;
    pages?: number;
    cursor?: string | number;
    ticker?: string;
    time?: string;
  }
): Promise<{
  items: unknown[];
  nextPagePath: string | null;
  pagesFetched: number;
}> {
  const limit = clampLimit(args.limit);
  const pages = clampPages(args.pages);
  let path = buildHistoryPath(args.pathname, {
    limit,
    cursor: args.cursor,
    ticker: args.ticker,
    time: args.time,
  });
  const items: unknown[] = [];
  let nextPagePath: string | null = null;
  let pagesFetched = 0;

  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const body = await get(path);
    const page = parseHistoryPage(body);
    pagesFetched += 1;
    items.push(...page.items);
    nextPagePath = page.nextPagePath;

    if (!nextPagePath || pageIndex === pages - 1) {
      break;
    }

    path = resolveHistoryNextPath(nextPagePath, args.pathname);
  }

  return { items, nextPagePath, pagesFetched };
}

function getTrading212Authorization(): string {
  const apiKey = process.env.TRADING212_API_KEY;
  const apiSecret = process.env.TRADING212_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("Trading 212 credentials are not configured on the server.");
  }

  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  return `Basic ${credentials}`;
}

export function createTrading212Get(
  options: Trading212ClientOptions = {}
): (path: string) => Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const minSpacingMs = options.minSpacingMs ?? MIN_TRADING212_SPACING_MS;
  const state = options.state ?? {
    chain: Promise.resolve(),
    nextAllowedAt: 0,
  };

  async function performGet(path: string): Promise<unknown> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const response = await fetchImpl(`${TRADING212_BASE_URL}${path}`, {
        method: READ_ONLY_METHOD,
        headers: {
          Authorization: getTrading212Authorization(),
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (response.status !== 429) {
        if (!response.ok) {
          const body = await response.text();

          throw new Error(
            `Trading 212 API request failed (${response.status}): ${body}`
          );
        }

        return response.json();
      }

      await response.text().catch(() => undefined);

      if (attempt === MAX_RATE_LIMIT_RETRIES) {
        throw new Trading212RateLimitError();
      }

      const delay = retryDelayMs(
        attempt,
        response.headers.get("retry-after"),
        now(),
        random
      );

      await sleep(delay);
    }

    throw new Trading212RateLimitError();
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = state.chain.then(async () => {
      const wait = state.nextAllowedAt - now();

      if (wait > 0) {
        await sleep(wait);
      }

      try {
        return await task();
      } finally {
        state.nextAllowedAt = now() + minSpacingMs;
      }
    });

    state.chain = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  return async function trading212Get(path: string): Promise<unknown> {
    assertReadOnlyEquityGetPath(path);

    return enqueue(() => performGet(path));
  };
}

export const trading212Get = createTrading212Get({
  state: sharedQueueState(),
});

export function brokerFactEnvelope<T extends Record<string, unknown>>(
  data: T,
  asOf = new Date().toISOString()
) {
  return {
    source: "Trading 212" as const,
    environment: "live" as const,
    brokerVerified: true as const,
    readOnly: true as const,
    tradeAuthority: "NONE" as const,
    asOf,
    dataClass: "BROKER_FACT" as const,
    ...data,
  };
}
