import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  Trading212RateLimitError,
  assertReadOnlyEquityGetPath,
  brokerFactEnvelope,
  buildHistoryPath,
  collectHistoryPages,
  createTrading212Get,
  parseHistoryPage,
  parseRetryAfterMs,
  resolveHistoryNextPath,
  retryDelayMs,
} from "./trading212.ts";

const fakeAuth = "Basic " + Buffer.from("unit-test-key:unit-test-secret").toString("base64");

function withFakeCredentials(run: () => Promise<void>): Promise<void> {
  const previousKey = process.env.TRADING212_API_KEY;
  const previousSecret = process.env.TRADING212_API_SECRET;
  process.env.TRADING212_API_KEY = "unit-test-key";
  process.env.TRADING212_API_SECRET = "unit-test-secret";

  return run().finally(() => {
    if (previousKey === undefined) {
      delete process.env.TRADING212_API_KEY;
    } else {
      process.env.TRADING212_API_KEY = previousKey;
    }

    if (previousSecret === undefined) {
      delete process.env.TRADING212_API_SECRET;
    } else {
      process.env.TRADING212_API_SECRET = previousSecret;
    }
  });
}

test("retry delay honors Retry-After and grows exponentially", () => {
  assert.equal(parseRetryAfterMs("10", 0), 10_000);
  assert.equal(parseRetryAfterMs(null, 0), null);

  const withHeader = retryDelayMs(0, "10", 0, () => 0);
  assert.equal(withHeader, 10_000);

  assert.equal(retryDelayMs(0, null, 0, () => 0), 1_000);
  assert.equal(retryDelayMs(1, null, 0, () => 0), 2_000);
  assert.equal(retryDelayMs(3, null, 0, () => 0), 8_000);
  assert.equal(retryDelayMs(0, "120", 0, () => 0), 30_000);
});

test("history paths stay on the live read-only endpoint", () => {
  assert.equal(
    buildHistoryPath("/equity/history/orders", {
      limit: 50,
      cursor: 10,
      ticker: "AAPL_US_EQ",
    }),
    "/equity/history/orders?limit=50&cursor=10&ticker=AAPL_US_EQ"
  );

  assert.equal(
    resolveHistoryNextPath(
      "/api/v0/equity/history/orders?limit=50&cursor=10",
      "/equity/history/orders"
    ),
    "/equity/history/orders?limit=50&cursor=10"
  );

  assert.throws(
    () =>
      resolveHistoryNextPath(
        "https://evil.example/api/v0/equity/history/orders",
        "/equity/history/orders"
      ),
    /live\.trading212\.com/
  );

  assert.throws(
    () =>
      resolveHistoryNextPath(
        "/api/v0/equity/orders/limit",
        "/equity/history/orders"
      ),
    /leaves the requested history endpoint/
  );

  assert.throws(() => assertReadOnlyEquityGetPath("/equity/orders/limit"), /read-only/);
  assert.doesNotThrow(() => assertReadOnlyEquityGetPath("/equity/pies/15"));
});

test("null-like nextPagePath values do not continue pagination", () => {
  assert.deepEqual(parseHistoryPage({ items: [], nextPagePath: "null&ticker=AAPL_US_EQ" }), {
    items: [],
    nextPagePath: null,
  });
});

test("pages default to a single page and cap additional follows at 3", async () => {
  const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path);
    const cursor = new URL(`https://live.trading212.com/api/v0${path}`).searchParams.get("cursor");

    if (!cursor) {
      return {
        items: [{ id: 1 }],
        nextPagePath: "/api/v0/equity/history/transactions?limit=50&cursor=abc",
      };
    }

    if (cursor === "abc") {
      return {
        items: [{ id: 2 }],
        nextPagePath: "/api/v0/equity/history/transactions?limit=50&cursor=def",
      };
    }

    return {
      items: [{ id: 3 }],
      nextPagePath: "/api/v0/equity/history/transactions?limit=50&cursor=ghi",
    };
  };

  const first = await collectHistoryPages(get, {
    pathname: "/equity/history/transactions",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(first.items, [{ id: 1 }]);
  assert.equal(first.pagesFetched, 1);
  assert.equal(
    first.nextPagePath,
    "/api/v0/equity/history/transactions?limit=50&cursor=abc"
  );

  calls.length = 0;
  const three = await collectHistoryPages(get, {
    pathname: "/equity/history/transactions",
    pages: 3,
    time: "2026-01-01T00:00:00Z",
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(three.items, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(three.pagesFetched, 3);
  assert.match(calls[0], /limit=50/);
  assert.match(calls[0], /time=2026-01-01T00%3A00%3A00Z/);
});

test("upstream calls are serialized GETs and 429 retries then stop", async () => {
  await withFakeCredentials(async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const urls: string[] = [];

    const queued = createTrading212Get({
      minSpacingMs: 350,
      sleep: async () => undefined,
      now: () => 0,
      random: () => 0,
      fetchImpl: async (input, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        urls.push(String(input));
        assert.equal(init?.method, "GET");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), fakeAuth);

        if (urls.length === 1) {
          await gate;
        }

        inFlight -= 1;
        return new Response("{}", { status: 200 });
      },
    });

    const both = Promise.all([
      queued("/equity/orders"),
      queued("/equity/positions"),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(urls.length, 1);
    assert.equal(maxInFlight, 1);
    releaseFirst?.();
    await both;
    assert.equal(urls.length, 2);
    assert.equal(maxInFlight, 1);
    assert.equal(urls[0], "https://live.trading212.com/api/v0/equity/orders");
    assert.equal(urls[1], "https://live.trading212.com/api/v0/equity/positions");

    let attempts = 0;
    const sleeps: number[] = [];
    const limited = createTrading212Get({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000,
      random: () => 0,
      fetchImpl: async () => {
        attempts += 1;

        if (attempts === 1) {
          return new Response("slow down", {
            status: 429,
            headers: { "Retry-After": "10" },
          });
        }

        return new Response("slow down", { status: 429 });
      },
    });

    await assert.rejects(
      limited("/equity/history/orders?limit=50"),
      Trading212RateLimitError
    );
    assert.equal(attempts, 5);
    assert.deepEqual(sleeps, [10_000, 2_000, 4_000, 8_000]);

    let failureCalls = 0;
    const failing = createTrading212Get({
      fetchImpl: async () => {
        failureCalls += 1;
        return new Response("nope", { status: 400 });
      },
    });
    await assert.rejects(
      failing("/equity/orders"),
      /Trading 212 API request failed \(400\)/
    );
    assert.equal(failureCalls, 1);
  });
});

test("broker fact envelope marks read-only broker facts", () => {
  const envelope = brokerFactEnvelope(
    { orders: [] },
    "2026-09-25T00:00:00.000Z"
  );

  assert.deepEqual(Object.keys(envelope), [
    "source",
    "environment",
    "brokerVerified",
    "readOnly",
    "tradeAuthority",
    "asOf",
    "dataClass",
    "orders",
  ]);
  assert.equal(envelope.source, "Trading 212");
  assert.equal(envelope.environment, "live");
  assert.equal(envelope.brokerVerified, true);
  assert.equal(envelope.readOnly, true);
  assert.equal(envelope.tradeAuthority, "NONE");
  assert.equal(envelope.dataClass, "BROKER_FACT");
});

test("source has no Trading 212 write routes", () => {
  const source = [
    readFileSync(new URL("./trading212.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../app/mcp/route.ts", import.meta.url), "utf8"),
  ].join("\n");

  assert.equal(source.includes('method: "POST"'), false);
  assert.equal(source.includes('method: "PUT"'), false);
  assert.equal(source.includes('method: "DELETE"'), false);
  assert.equal(source.includes('method: "PATCH"'), false);
  assert.equal(source.includes("/equity/orders/limit"), false);
  assert.equal(source.includes("/equity/orders/market"), false);
  assert.equal(source.includes("/equity/orders/stop"), false);
  assert.equal(source.includes("PERSONAL_NAV"), false);
  assert.equal(source.includes("MOMS_NAV"), false);
  assert.equal(source.includes("Promise.all"), false);
  assert.match(source, /const READ_ONLY_METHOD = "GET"/);
});
