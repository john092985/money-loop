import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
const userId = process.env.APP_USER_ID || "demo-user";

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the Money Loop MCP server.");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

const server = new McpServer({
  name: "money-loop-spending",
  version: "0.1.0",
});

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const groupByValues = ["category", "subcategory", "merchant", "day"];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoKey(days) {
  const date = new Date();
  date.setDate(date.getDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

function monthStartKey() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().slice(0, 10);
}

function dateOrDefault(value, fallback) {
  return value && datePattern.test(value) ? value : fallback;
}

function limitOrDefault(value, fallback = 50, max = 250) {
  return Math.min(Math.max(Number(value || fallback), 1), max);
}

function jsonResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function addFilter(filters, params, sql, value) {
  params.push(value);
  filters.push(sql.replace("?", `$${params.length}`));
}

function transactionSelect() {
  return `
    SELECT
      id,
      date::text AS date,
      merchant,
      raw_merchant,
      amount::float AS amount,
      direction,
      category,
      subcategory,
      location,
      confidence::float AS confidence,
      category_source,
      plaid_category,
      plaid_detailed_category,
      pending
    FROM transactions
  `;
}

async function queryTransactions({
  startDate,
  endDate,
  category,
  merchant,
  direction,
  includePending = false,
  limit = 50,
}) {
  const filters = ["user_id = $1"];
  const params = [userId];

  addFilter(filters, params, "date >= ?", startDate);
  addFilter(filters, params, "date <= ?", endDate);

  if (category) {
    addFilter(filters, params, "category ILIKE ?", category);
  }

  if (merchant) {
    addFilter(filters, params, "(merchant ILIKE ? OR raw_merchant ILIKE ?)", `%${merchant}%`);
    params.push(`%${merchant}%`);
    filters[filters.length - 1] = `(merchant ILIKE $${params.length - 1} OR raw_merchant ILIKE $${params.length})`;
  }

  if (direction) {
    addFilter(filters, params, "direction = ?", direction);
  }

  if (!includePending) {
    filters.push("pending = FALSE");
  }

  params.push(limitOrDefault(limit));
  const result = await pool.query(
    `
      ${transactionSelect()}
      WHERE ${filters.join(" AND ")}
      ORDER BY date DESC, amount DESC
      LIMIT $${params.length}
    `,
    params
  );

  return result.rows;
}

function summarizeRows(rows, groupBy) {
  const groups = new Map();
  let totalExpense = 0;
  let totalIncome = 0;

  for (const row of rows) {
    if (row.direction === "expense") {
      totalExpense += Number(row.amount || 0);
    } else if (row.direction === "income") {
      totalIncome += Math.abs(Number(row.amount || 0));
    }

    const key =
      groupBy === "day"
        ? row.date
        : row[groupBy] || (groupBy === "subcategory" ? "Uncategorized" : "Other");

    if (!groups.has(key)) {
      groups.set(key, { name: key, totalExpense: 0, totalIncome: 0, count: 0 });
    }

    const group = groups.get(key);
    group.count += 1;

    if (row.direction === "expense") {
      group.totalExpense += Number(row.amount || 0);
    } else if (row.direction === "income") {
      group.totalIncome += Math.abs(Number(row.amount || 0));
    }
  }

  return {
    totalExpense: Number(totalExpense.toFixed(2)),
    totalIncome: Number(totalIncome.toFixed(2)),
    net: Number((totalIncome - totalExpense).toFixed(2)),
    count: rows.length,
    groups: Array.from(groups.values())
      .map((group) => ({
        ...group,
        totalExpense: Number(group.totalExpense.toFixed(2)),
        totalIncome: Number(group.totalIncome.toFixed(2)),
      }))
      .sort((a, b) => b.totalExpense - a.totalExpense),
  };
}

function isTakeout(row) {
  const text = [
    row.merchant,
    row.raw_merchant,
    row.category,
    row.subcategory,
    row.plaid_detailed_category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    row.direction === "expense" &&
    row.category === "Dining" &&
    (text.includes("delivery") ||
      text.includes("takeout") ||
      text.includes("doordash") ||
      text.includes("uber eats") ||
      text.includes("ubereats") ||
      text.includes("grubhub") ||
      text.includes("postmates"))
  );
}

server.registerTool(
  "get_transactions",
  {
    title: "Get transactions",
    description:
      "Read cleaned Money Loop transactions for a date range, with optional category or merchant filters.",
    inputSchema: {
      start_date: z.string().regex(datePattern).optional(),
      end_date: z.string().regex(datePattern).optional(),
      category: z.string().optional(),
      merchant: z.string().optional(),
      direction: z.enum(["expense", "income"]).optional(),
      include_pending: z.boolean().optional(),
      limit: z.number().int().positive().max(250).optional(),
    },
  },
  async (input) => {
    const rows = await queryTransactions({
      startDate: dateOrDefault(input.start_date, monthStartKey()),
      endDate: dateOrDefault(input.end_date, todayKey()),
      category: input.category,
      merchant: input.merchant,
      direction: input.direction,
      includePending: input.include_pending,
      limit: input.limit,
    });

    return jsonResult({
      user_id: userId,
      count: rows.length,
      transactions: rows,
    });
  }
);

server.registerTool(
  "summarize_spending",
  {
    title: "Summarize spending",
    description:
      "Summarize spending and income by category, subcategory, merchant, or day for a date range.",
    inputSchema: {
      start_date: z.string().regex(datePattern).optional(),
      end_date: z.string().regex(datePattern).optional(),
      group_by: z.enum(groupByValues).optional(),
      include_pending: z.boolean().optional(),
    },
  },
  async (input) => {
    const startDate = dateOrDefault(input.start_date, monthStartKey());
    const endDate = dateOrDefault(input.end_date, todayKey());
    const groupBy = input.group_by || "category";
    const rows = await queryTransactions({
      startDate,
      endDate,
      includePending: input.include_pending,
      limit: 250,
    });

    return jsonResult({
      user_id: userId,
      period: { start_date: startDate, end_date: endDate },
      group_by: groupBy,
      ...summarizeRows(rows, groupBy),
    });
  }
);

server.registerTool(
  "get_takeout_spending",
  {
    title: "Get takeout spending",
    description: "Find likely takeout or food delivery spending for a date range.",
    inputSchema: {
      start_date: z.string().regex(datePattern).optional(),
      end_date: z.string().regex(datePattern).optional(),
      limit: z.number().int().positive().max(250).optional(),
    },
  },
  async (input) => {
    const startDate = dateOrDefault(input.start_date, monthStartKey());
    const endDate = dateOrDefault(input.end_date, todayKey());
    const rows = await queryTransactions({
      startDate,
      endDate,
      direction: "expense",
      limit: input.limit || 250,
    });
    const takeout = rows.filter(isTakeout);

    return jsonResult({
      user_id: userId,
      period: { start_date: startDate, end_date: endDate },
      total: Number(takeout.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2)),
      count: takeout.length,
      transactions: takeout,
    });
  }
);

server.registerTool(
  "find_unusual_spending",
  {
    title: "Find unusual spending",
    description:
      "Return unusually large posted expenses compared with recent transaction size distribution.",
    inputSchema: {
      days: z.number().int().positive().max(120).optional(),
      limit: z.number().int().positive().max(25).optional(),
    },
  },
  async (input) => {
    const days = Math.min(input.days || 30, 120);
    const rows = await queryTransactions({
      startDate: daysAgoKey(days),
      endDate: todayKey(),
      direction: "expense",
      limit: 250,
    });
    const amounts = rows.map((row) => Number(row.amount || 0));
    const average = amounts.reduce((sum, amount) => sum + amount, 0) / (amounts.length || 1);
    const variance =
      amounts.reduce((sum, amount) => sum + (amount - average) ** 2, 0) /
      (amounts.length || 1);
    const standardDeviation = Math.sqrt(variance);
    const minimumThreshold = Math.max(100, average + standardDeviation);
    const unusual = rows
      .filter((row) => Number(row.amount || 0) >= minimumThreshold)
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
      .slice(0, limitOrDefault(input.limit, 8, 25));

    return jsonResult({
      user_id: userId,
      period_days: days,
      baseline: {
        average: Number(average.toFixed(2)),
        standard_deviation: Number(standardDeviation.toFixed(2)),
        minimum_threshold: Number(minimumThreshold.toFixed(2)),
      },
      count: unusual.length,
      transactions: unusual,
    });
  }
);

server.registerTool(
  "get_savings_opportunities",
  {
    title: "Get savings opportunities",
    description:
      "Rank discretionary categories and merchants that may be useful places to review spending.",
    inputSchema: {
      start_date: z.string().regex(datePattern).optional(),
      end_date: z.string().regex(datePattern).optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
  },
  async (input) => {
    const startDate = dateOrDefault(input.start_date, monthStartKey());
    const endDate = dateOrDefault(input.end_date, todayKey());
    const discretionary = new Set([
      "Dining",
      "Shopping",
      "Entertainment",
      "Subscription",
      "Travel",
      "Transport",
    ]);
    const rows = (
      await queryTransactions({
        startDate,
        endDate,
        direction: "expense",
        limit: 250,
      })
    ).filter((row) => discretionary.has(row.category));
    const byCategory = summarizeRows(rows, "category").groups.slice(
      0,
      limitOrDefault(input.limit, 6, 20)
    );
    const byMerchant = summarizeRows(rows, "merchant").groups.slice(
      0,
      limitOrDefault(input.limit, 6, 20)
    );

    return jsonResult({
      user_id: userId,
      period: { start_date: startDate, end_date: endDate },
      categories: byCategory,
      merchants: byMerchant,
      note: "These are spending review targets, not financial advice.",
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
