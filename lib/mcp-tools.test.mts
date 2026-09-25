import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const TEST_TOKEN = "local-readonly-tools-check";
const EXPECTED_TOOLS = [
  "get_account_summary",
  "get_positions",
  "get_portfolio_state",
  "get_pies",
  "get_pie_detail",
  "get_open_orders",
  "get_order_history",
  "get_transactions",
  "get_dividends",
];

type CapturedRequest = {
  url: string;
  method: string;
  startedAt: number;
};

test("tools/list exposes nine read-only tools and new tools proxy broker JSON", async () => {
  const previousToken = process.env.AURELIA_MCP_TOKEN;
  const previousKey = process.env.TRADING212_API_KEY;
  const previousSecret = process.env.TRADING212_API_SECRET;
  const previousFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];

  process.env.AURELIA_MCP_TOKEN = TEST_TOKEN;
  delete process.env.TRADING212_API_KEY;
  delete process.env.TRADING212_API_SECRET;

  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";
    requests.push({ url, method, startedAt: Date.now() });
    const pathname = new URL(url).pathname;

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (pathname === "/api/v0/equity/orders") {
      return json([{ id: 7, status: "NEW", ticker: "AAPL_US_EQ" }]);
    }

    if (pathname === "/api/v0/equity/history/orders") {
      const cursor = new URL(url).searchParams.get("cursor");

      if (!cursor) {
        return json({
          items: [{ order: { id: 1, ticker: "AAPL_US_EQ" } }],
          nextPagePath: "/api/v0/equity/history/orders?limit=20&cursor=99",
        });
      }

      return json({
        items: [{ order: { id: 2, ticker: "MSFT_US_EQ" } }],
        nextPagePath: null,
      });
    }

    if (pathname === "/api/v0/equity/history/transactions") {
      return json({
        items: [{ type: "DEPOSIT", amount: 10, reference: "dep-1" }],
        nextPagePath: null,
      });
    }

    if (pathname === "/api/v0/equity/history/dividends") {
      return json({
        items: [{ type: "DIVIDEND", ticker: "AAPL_US_EQ", amount: 1.2 }],
        nextPagePath: null,
      });
    }

    if (pathname === "/api/v0/equity/account/summary") {
      return json({ cash: 42 });
    }

    if (pathname === "/api/v0/equity/positions") {
      return json([{ ticker: "AAPL_US_EQ", quantity: 1 }]);
    }

    return json({ unexpected: pathname }, 500);
  };

  const { GET, POST } = await import("../app/mcp/route.ts");
  const endpoint = new URL("http://127.0.0.1/mcp");
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: {
      token: async () => TEST_TOKEN,
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);

      if (!headers.has("authorization")) {
        headers.set("authorization", `Bearer ${TEST_TOKEN}`);
      }

      const authed = new Request(request, { headers });

      if (authed.method === "GET") {
        return GET(authed);
      }

      return POST(authed);
    },
  });
  const client = new Client({
    name: "aurelia-readonly-tools-test",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    assert.deepEqual(names, EXPECTED_TOOLS);
    assert.equal(listed.tools.length, 9);

    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.match(tool.description ?? "", /TRADE AUTHORITY: NONE/);
    }

    const newTools = listed.tools.filter((tool) =>
      [
        "get_open_orders",
        "get_order_history",
        "get_transactions",
        "get_dividends",
      ].includes(tool.name)
    );
    assert.equal(newTools.length, 4);

    const invalid = await client.callTool({
      name: "get_order_history",
      arguments: { limit: 51, pages: 4 },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 0);

    process.env.TRADING212_API_KEY = "unit-test-key";
    process.env.TRADING212_API_SECRET = "unit-test-secret";

    const openOrders = await readTool(client, "get_open_orders", {});
    assertBrokerEnvelope(openOrders);
    assert.deepEqual(openOrders.orders, [
      { id: 7, status: "NEW", ticker: "AAPL_US_EQ" },
    ]);

    const history = await readTool(client, "get_order_history", { pages: 2 });
    assertBrokerEnvelope(history);
    assert.equal(history.pagination.limit, 50);
    assert.equal(history.pagination.pagesRequested, 2);
    assert.equal(history.pagination.pagesFetched, 2);
    assert.equal(history.pagination.hasMore, false);
    assert.equal(history.nextPagePath, null);
    assert.deepEqual(
      history.items.map((item: { order: { id: number } }) => item.order.id),
      [1, 2]
    );

    const transactions = await readTool(client, "get_transactions", {
      time: "2026-01-01T00:00:00Z",
    });
    assertBrokerEnvelope(transactions);
    assert.equal(transactions.pagination.time, "2026-01-01T00:00:00Z");
    assert.equal(transactions.items[0].type, "DEPOSIT");

    const dividends = await readTool(client, "get_dividends", {
      ticker: "AAPL_US_EQ",
      limit: 10,
    });
    assertBrokerEnvelope(dividends);
    assert.equal(dividends.pagination.limit, 10);
    assert.equal(dividends.pagination.ticker, "AAPL_US_EQ");
    assert.equal(dividends.items[0].type, "DIVIDEND");

    const summary = await readTool(client, "get_account_summary", {});
    assert.deepEqual(summary, { cash: 42 });
    assert.equal("dataClass" in summary, false);

    const beforePortfolio = requests.length;
    const portfolio = await readTool(client, "get_portfolio_state", {});
    assert.equal(portfolio.source, "Trading 212");
    assert.equal(portfolio.environment, "live");
    assert.equal(portfolio.brokerVerified, true);
    assert.equal(portfolio.readOnly, true);
    assert.equal(typeof portfolio.asOf, "string");
    assert.deepEqual(portfolio.account, { cash: 42 });
    assert.deepEqual(portfolio.positions, [{ ticker: "AAPL_US_EQ", quantity: 1 }]);
    assert.equal("tradeAuthority" in portfolio, false);
    assert.equal("dataClass" in portfolio, false);

    const portfolioCalls = requests.slice(beforePortfolio);
    assert.deepEqual(
      portfolioCalls.map((call) => new URL(call.url).pathname),
      ["/api/v0/equity/account/summary", "/api/v0/equity/positions"]
    );
    assert.ok(portfolioCalls[1].startedAt - portfolioCalls[0].startedAt >= 340);

    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.method, "GET");
      assert.equal(new URL(request.url).hostname, "live.trading212.com");
      assert.ok(request.url.startsWith("https://live.trading212.com/api/v0/"));
    }

    const orderHistoryUrls = requests
      .map((request) => request.url)
      .filter((url) => url.includes("/equity/history/orders"));
    assert.match(orderHistoryUrls[0], /limit=50/);
    assert.match(orderHistoryUrls[1], /cursor=99/);
  } finally {
    await client.close().catch(() => undefined);
    globalThis.fetch = previousFetch;

    if (previousToken === undefined) {
      delete process.env.AURELIA_MCP_TOKEN;
    } else {
      process.env.AURELIA_MCP_TOKEN = previousToken;
    }

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
  }
});

async function readTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, never>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true);
  const text = result.content?.find((item) => item.type === "text");
  assert.ok(text && "text" in text);
  return JSON.parse(text.text) as Record<string, never>;
}

function assertBrokerEnvelope(body: Record<string, unknown>) {
  assert.equal(body.source, "Trading 212");
  assert.equal(body.environment, "live");
  assert.equal(body.brokerVerified, true);
  assert.equal(body.readOnly, true);
  assert.equal(body.tradeAuthority, "NONE");
  assert.equal(body.dataClass, "BROKER_FACT");
  assert.equal(typeof body.asOf, "string");
  assert.match(String(body.asOf), /^\d{4}-\d{2}-\d{2}T/);
}
