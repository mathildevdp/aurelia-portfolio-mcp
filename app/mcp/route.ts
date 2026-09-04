import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const TRADING212_BASE_URL = "https://live.trading212.com/api/v0";

function getAuthorizationHeader() {
  const apiKey = process.env.TRADING212_API_KEY;
  const apiSecret = process.env.TRADING212_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Trading 212 credentials are not configured on the server."
    );
  }

  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  return `Basic ${credentials}`;
}

async function trading212Get(path: string) {
  const response = await fetch(`${TRADING212_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: getAuthorizationHeader(),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Trading 212 API request failed (${response.status}): ${body}`
    );
  }

  return response.json();
}

const handler = createMcpHandler((server) => {
  /*
   * READ ONLY
   *
   * This MCP intentionally exposes no Trading 212 order,
   * buy, sell, cancel, or modification functionality.
   */

  server.registerTool(
    "get_account_summary",
    {
      title: "Get Trading 212 Account Summary",
      description:
        "Get the broker-verified Trading 212 account summary. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const account = await trading212Get("/equity/account/summary");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(account, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_positions",
    {
      title: "Get Trading 212 Positions",
      description:
        "Get all current broker-verified open Trading 212 positions. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const positions = await trading212Get("/equity/positions");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(positions, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_portfolio_state",
    {
      title: "Get Aurelia Portfolio State",
      description:
        "Get the current broker-verified Trading 212 account summary and open positions for Aurelia portfolio analysis. Read-only.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const [account, positions] = await Promise.all([
        trading212Get("/equity/account/summary"),
        trading212Get("/equity/positions"),
      ]);

      const portfolioState = {
        source: "Trading 212",
        environment: "live",
        brokerVerified: true,
        readOnly: true,
        asOf: new Date().toISOString(),
        account,
        positions,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(portfolioState, null, 2),
          },
        ],
      };
    }
  );
});

export { handler as GET, handler as POST };
