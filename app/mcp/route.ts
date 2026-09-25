import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import {
  brokerFactEnvelope,
  collectHistoryPages,
  trading212Get,
} from "../../lib/trading212";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe("Page size. Defaults to 50. Maximum 50.");

const pagesSchema = z
  .number()
  .int()
  .min(1)
  .max(3)
  .optional()
  .describe(
    "How many broker pages to fetch by following nextPagePath. Defaults to 1. Maximum 3."
  );

const cursorSchema = z
  .union([z.number().int().nonnegative(), z.string().min(1).max(200)])
  .optional()
  .describe("Broker pagination cursor. Omit on the first page.");

const tickerSchema = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe("Instrument ticker filter, for example AAPL_US_EQ.");

const handler = createMcpHandler((server) => {
  server.registerTool(
    "get_account_summary",
    {
      title: "Get Trading 212 Account Summary",
      description:
        "Get the broker-verified Trading 212 account summary. Read-only. TRADE AUTHORITY: NONE.",
      inputSchema: z.object({}).strict(),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const account = await trading212Get("/equity/account/summary");

      return jsonContent(account);
    }
  );

  server.registerTool(
    "get_positions",
    {
      title: "Get Trading 212 Positions",
      description:
        "Get all current broker-verified open Trading 212 positions. Read-only. TRADE AUTHORITY: NONE.",
      inputSchema: z.object({}).strict(),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const positions = await trading212Get("/equity/positions");

      return jsonContent(positions);
    }
  );

  server.registerTool(
    "get_portfolio_state",
    {
      title: "Get Aurelia Portfolio State",
      description:
        "Get the current broker-verified Trading 212 account summary and open positions for Aurelia portfolio analysis. Read-only. TRADE AUTHORITY: NONE.",
      inputSchema: z.object({}).strict(),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const account = await trading212Get("/equity/account/summary");
      const positions = await trading212Get("/equity/positions");

      const portfolioState = {
        source: "Trading 212",
        environment: "live",
        brokerVerified: true,
        readOnly: true,
        asOf: new Date().toISOString(),
        account,
        positions,
      };

      return jsonContent(portfolioState);
    }
  );

  server.registerTool(
    "get_pies",
    {
      title: "Get Trading 212 Pies",
      description:
        "List all Trading 212 pies for the account (pie id, cash, value/result metadata as returned by the broker). Read-only. Uses deprecated/unsupported Trading 212 Pie GET endpoints solely for pie identity — no mandate mapping. TRADE AUTHORITY: NONE.",
      inputSchema: z.object({}).strict(),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const pies = await trading212Get("/equity/pies");

      return jsonContent(pies);
    }
  );

  server.registerTool(
    "get_pie_detail",
    {
      title: "Get Trading 212 Pie Detail",
      description:
        "Fetch one Trading 212 pie by id, including settings.name and instrument membership/quantities as returned by the broker. Read-only. Uses deprecated/unsupported Trading 212 Pie GET endpoints solely for pie identity — no mandate mapping. TRADE AUTHORITY: NONE.",
      inputSchema: z
        .object({
          pieId: z.number().int(),
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ pieId }) => {
      const pie = await trading212Get(`/equity/pies/${pieId}`);

      return jsonContent(pie);
    }
  );

  server.registerTool(
    "get_open_orders",
    {
      title: "Get Trading 212 Open Orders",
      description:
        "List broker open and pending Trading 212 equity orders (GET /equity/orders) as returned by the broker. Read-only proxy. TRADE AUTHORITY: NONE. Does not place, modify, or cancel orders.",
      inputSchema: z.object({}).strict(),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const orders = await trading212Get("/equity/orders");

      return jsonContent(brokerFactEnvelope({ orders }));
    }
  );

  server.registerTool(
    "get_order_history",
    {
      title: "Get Trading 212 Order History",
      description:
        "Fetch broker historical equity orders (GET /equity/history/orders). Read-only proxy of broker JSON. Optional cursor, ticker, and limit (default 50, max 50). pages defaults to 1 and max 3; pages above 1 follow nextPagePath. Items are concatenated in broker page order and are not deduplicated. TRADE AUTHORITY: NONE. Does not place, modify, or cancel orders. Mark-to-market valuation changes are not orders.",
      inputSchema: z
        .object({
          cursor: cursorSchema,
          ticker: tickerSchema,
          limit: limitSchema,
          pages: pagesSchema,
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ cursor, ticker, limit, pages }) => {
      const pageLimit = limit ?? 50;
      const pagesRequested = pages ?? 1;
      const history = await collectHistoryPages(trading212Get, {
        pathname: "/equity/history/orders",
        cursor,
        ticker,
        limit: pageLimit,
        pages: pagesRequested,
      });

      return jsonContent(
        brokerFactEnvelope({
          items: history.items,
          nextPagePath: history.nextPagePath,
          pagination: {
            limit: pageLimit,
            cursor: cursor ?? null,
            ticker: ticker ?? null,
            pagesRequested,
            pagesFetched: history.pagesFetched,
            hasMore: history.nextPagePath !== null,
          },
        })
      );
    }
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get Trading 212 Transactions",
      description:
        "Fetch broker cash-movement history (GET /equity/history/transactions): deposits, withdrawals, fees, transfers, and interest as reported by Trading 212. Read-only proxy. Optional cursor, time, and limit (default 50, max 50). pages defaults to 1 and max 3. TRADE AUTHORITY: NONE. Does not move cash. Mark-to-market and unrealized P&L are not transactions and are not computed.",
      inputSchema: z
        .object({
          cursor: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe("Broker pagination cursor. Omit on the first page."),
          time: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe(
              "ISO-8601 timestamp. Retrieve transactions starting from this time."
            ),
          limit: limitSchema,
          pages: pagesSchema,
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ cursor, time, limit, pages }) => {
      const pageLimit = limit ?? 50;
      const pagesRequested = pages ?? 1;
      const history = await collectHistoryPages(trading212Get, {
        pathname: "/equity/history/transactions",
        cursor,
        time,
        limit: pageLimit,
        pages: pagesRequested,
      });

      return jsonContent(
        brokerFactEnvelope({
          items: history.items,
          nextPagePath: history.nextPagePath,
          pagination: {
            limit: pageLimit,
            cursor: cursor ?? null,
            time: time ?? null,
            pagesRequested,
            pagesFetched: history.pagesFetched,
            hasMore: history.nextPagePath !== null,
          },
        })
      );
    }
  );

  server.registerTool(
    "get_dividends",
    {
      title: "Get Trading 212 Dividends",
      description:
        "Fetch broker paid-out dividend history (GET /equity/history/dividends). Read-only proxy of broker JSON. Optional cursor, ticker, and limit (default 50, max 50). pages defaults to 1 and max 3; pages above 1 follow nextPagePath. TRADE AUTHORITY: NONE. Does not reinvest dividends or create dividend entries.",
      inputSchema: z
        .object({
          cursor: cursorSchema,
          ticker: tickerSchema,
          limit: limitSchema,
          pages: pagesSchema,
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ cursor, ticker, limit, pages }) => {
      const pageLimit = limit ?? 50;
      const pagesRequested = pages ?? 1;
      const history = await collectHistoryPages(trading212Get, {
        pathname: "/equity/history/dividends",
        cursor,
        ticker,
        limit: pageLimit,
        pages: pagesRequested,
      });

      return jsonContent(
        brokerFactEnvelope({
          items: history.items,
          nextPagePath: history.nextPagePath,
          pagination: {
            limit: pageLimit,
            cursor: cursor ?? null,
            ticker: ticker ?? null,
            pagesRequested,
            pagesFetched: history.pagesFetched,
            hasMore: history.nextPagePath !== null,
          },
        })
      );
    }
  );
});

const verifyToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  const expectedToken = process.env.AURELIA_MCP_TOKEN;

  if (!expectedToken || !bearerToken) {
    return undefined;
  }

  if (bearerToken !== expectedToken) {
    return undefined;
  }

  return {
    token: bearerToken,
    scopes: ["portfolio:read"],
    clientId: "aurelia-grok",
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ["portfolio:read"],
});

export { authHandler as GET, authHandler as POST };
