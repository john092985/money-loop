import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import pg from "pg";
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json());

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-nano";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../.data");
const statePath = path.join(dataDir, "state.json");
const keyPath = path.join(dataDir, "local-storage-key");
const publicDir = path.resolve(__dirname, "../public");
const distDir = path.resolve(__dirname, "../dist");
const stateStorageKey = process.env.APP_USER_ID || "demo-user";
const databaseUrl = process.env.DATABASE_URL || "";
const dbPool = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    })
  : null;

app.use(express.static(publicDir));
app.use(express.static(distDir));

const emptyDemoItem = {
  accessToken: null,
  itemId: null,
  cursor: null,
  transactions: [],
};

let demoItem = await loadDemoItem();

const categoryRules = [
  { category: "Dining", patterns: ["coffee", "restaurant", "cafe", "starbucks", "mcdonald"] },
  { category: "Groceries", patterns: ["market", "grocery", "whole foods", "supermarket"] },
  { category: "Transport", patterns: ["uber", "lyft", "metro", "transit", "parking"] },
  { category: "Shopping", patterns: ["amazon", "target", "walmart", "store"] },
  { category: "Travel", patterns: ["airline", "hotel", "booking", "airbnb"] },
  { category: "Subscription", patterns: ["netflix", "spotify", "apple", "subscription"] },
  { category: "Income", patterns: ["payroll", "direct deposit"] },
];

const allowedCategories = [
  "Dining",
  "Groceries",
  "Transport",
  "Shopping",
  "Housing",
  "Utilities",
  "Healthcare",
  "Education",
  "Entertainment",
  "Subscription",
  "Travel",
  "Transfer",
  "Payment",
  "Income",
  "Other",
];

const plaidCategoryMap = {
  BANK_FEES: "Payment",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Dining",
  GENERAL_MERCHANDISE: "Shopping",
  GOVERNMENT_AND_NON_PROFIT: "Other",
  HOME_IMPROVEMENT: "Housing",
  INCOME: "Income",
  LOAN_PAYMENTS: "Payment",
  MEDICAL: "Healthcare",
  PERSONAL_CARE: "Healthcare",
  RENT_AND_UTILITIES: "Housing",
  TRANSFER_IN: "Transfer",
  TRANSFER_OUT: "Transfer",
  TRANSPORTATION: "Transport",
  TRAVEL: "Travel",
};

async function readStorageSecret() {
  await fs.mkdir(dataDir, { recursive: true });

  if (process.env.APP_STORAGE_SECRET) {
    return process.env.APP_STORAGE_SECRET;
  }

  try {
    return await fs.readFile(keyPath, "utf8");
  } catch {
    const generatedSecret = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(keyPath, generatedSecret, { mode: 0o600 });
    return generatedSecret;
  }
}

async function encryptionKey() {
  const secret = await readStorageSecret();
  return crypto.createHash("sha256").update(secret).digest();
}

async function encryptText(value) {
  if (!value) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: encrypted.toString("base64"),
  };
}

async function decryptText(payload) {
  if (!payload) return null;

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.value, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function loadDemoItem() {
  try {
    const rawState = await readStoredState();

    return {
      accessToken: await decryptText(rawState.accessToken),
      itemId: rawState.itemId || null,
      cursor: rawState.cursor || null,
      transactions: filterTransactionsByDays(rawState.transactions || [], 30).sort((a, b) =>
        b.date.localeCompare(a.date)
      ),
    };
  } catch {
    return { ...emptyDemoItem };
  }
}

async function saveDemoItem() {
  await writeStoredState({
    accessToken: await encryptText(demoItem.accessToken),
    itemId: demoItem.itemId,
    cursor: demoItem.cursor,
    transactions: filterTransactionsByDays(demoItem.transactions || [], 30),
    savedAt: new Date().toISOString(),
  });
}

async function ensureDatabase() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function readStoredState() {
  if (!dbPool) {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  }

  await ensureDatabase();
  const result = await dbPool.query("SELECT value FROM app_state WHERE key = $1", [
    stateStorageKey,
  ]);

  if (!result.rows[0]) {
    throw new Error("No stored state");
  }

  return result.rows[0].value;
}

async function writeStoredState(state) {
  if (!dbPool) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return;
  }

  await ensureDatabase();
  await dbPool.query(
    `
      INSERT INTO app_state (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [stateStorageKey, JSON.stringify(state)]
  );
}

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysAgoKey(days) {
  const date = new Date();
  date.setDate(date.getDate() - (days - 1));
  return dateKey(date);
}

function filterTransactionsByDays(transactions, days) {
  const start = daysAgoKey(days);
  const end = dateKey();

  return transactions.filter(
    (transaction) => transaction.date >= start && transaction.date <= end
  );
}

function buildDailySpending(transactions, days) {
  const totals = new Map();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));

  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    totals.set(dateKey(date), 0);
  }

  for (const transaction of transactions) {
    if (transaction.direction === "expense" && !transaction.pending && totals.has(transaction.date)) {
      totals.set(transaction.date, totals.get(transaction.date) + transaction.amount);
    }
  }

  return Array.from(totals.entries()).map(([date, amount]) => ({
    date,
    label: date.slice(5),
    amount: Number(amount.toFixed(2)),
  }));
}

function requirePlaidConfig(req, res, next) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    res.status(500).json({
      error: "Missing Plaid config. Copy .env.example to .env and fill PLAID_CLIENT_ID and PLAID_SECRET.",
    });
    return;
  }

  next();
}

function classifyTransaction(transaction) {
  if (transaction.amount < 0) {
    return { category: "Income", source: "amount" };
  }

  const text = [
    transaction.name,
    transaction.merchant_name,
    transaction.payment_channel,
    ...(transaction.category || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const match = categoryRules.find((rule) =>
    rule.patterns.some((pattern) => text.includes(pattern))
  );

  if (match) {
    return { category: match.category, source: "rule" };
  }

  const plaidPrimary = transaction.personal_finance_category?.primary;
  const mappedPlaidCategory = plaidCategoryMap[plaidPrimary];

  if (mappedPlaidCategory) {
    return { category: mappedPlaidCategory, source: "plaid" };
  }

  return { category: "Other", source: "fallback" };
}

function normalizeTransaction(transaction) {
  const { category, source } = classifyTransaction(transaction);

  return {
    id: transaction.transaction_id,
    date: transaction.date,
    merchant: transaction.merchant_name || transaction.name,
    amount: transaction.amount,
    direction: transaction.amount < 0 ? "income" : "expense",
    category,
    categorySource: source,
    plaidCategory: transaction.personal_finance_category?.primary || null,
    pending: transaction.pending,
  };
}

async function classifyWithLLM(transactions) {
  if (!openai) return transactions;

  const candidates = transactions.filter(
    (transaction) =>
      transaction.direction === "expense" &&
      ["Other", "Payment", "Transfer"].includes(transaction.category)
  );

  if (candidates.length === 0) return transactions;

  const categoryById = new Map();
  const chunkSize = 24;

  for (let index = 0; index < candidates.length; index += chunkSize) {
    const chunk = candidates.slice(index, index + chunkSize);
    const response = await openai.responses.create({
      model: openaiModel,
      instructions:
        "Classify bank transactions for a personal spending dashboard. Use only the allowed categories. Prefer practical consumer-spending categories. Do not give financial advice.",
      input: JSON.stringify({
        allowed_categories: allowedCategories,
        transactions: chunk.map((transaction) => ({
          id: transaction.id,
          date: transaction.date,
          merchant: transaction.merchant,
          amount: transaction.amount,
          plaid_category: transaction.plaidCategory,
          current_category: transaction.category,
        })),
      }),
      text: {
        format: {
          type: "json_schema",
          name: "transaction_categories",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              classifications: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    category: { type: "string", enum: allowedCategories },
                    confidence: { type: "number" },
                  },
                  required: ["id", "category", "confidence"],
                },
              },
            },
            required: ["classifications"],
          },
        },
      },
    });

    const parsed = JSON.parse(response.output_text);

    for (const item of parsed.classifications || []) {
      if (allowedCategories.includes(item.category) && item.confidence >= 0.55) {
        categoryById.set(item.id, item.category);
      }
    }
  }

  return transactions.map((transaction) => {
    const category = categoryById.get(transaction.id);

    if (!category) {
      return transaction;
    }

    return {
      ...transaction,
      category,
      categorySource: `llm:${openaiModel}`,
    };
  });
}

function buildSummary(transactions) {
  const posted = transactions.filter((transaction) => !transaction.pending);
  const expenses = posted.filter((transaction) => transaction.direction === "expense");
  const income = posted.filter((transaction) => transaction.direction === "income");

  const totalExpense = expenses.reduce((sum, transaction) => sum + transaction.amount, 0);
  const totalIncome = income.reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0);

  const categories = expenses.reduce((acc, transaction) => {
    acc[transaction.category] = (acc[transaction.category] || 0) + transaction.amount;
    return acc;
  }, {});

  const categoryBreakdown = Object.entries(categories)
    .map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }))
    .sort((a, b) => b.value - a.value);

  const largestTransaction = expenses
    .slice()
    .sort((a, b) => b.amount - a.amount)[0];

  return {
    totalExpense: Number(totalExpense.toFixed(2)),
    totalIncome: Number(totalIncome.toFixed(2)),
    transactionCount: posted.length,
    categoryBreakdown,
    largestTransaction,
  };
}

function buildDashboardPayload(transactions) {
  const monthTransactions = filterTransactionsByDays(transactions, 30);
  const weekTransactions = filterTransactionsByDays(monthTransactions, 7);

  return {
    transactions: monthTransactions,
    summary: buildSummary(monthTransactions),
    week: {
      transactions: weekTransactions,
      summary: buildSummary(weekTransactions),
      dailySpending: buildDailySpending(weekTransactions, 7),
    },
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, storage: dbPool ? "postgres" : "local" });
});

app.post("/api/plaid/create-link-token", requirePlaidConfig, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: "demo-user",
      },
      client_name: "Spending Agent",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      transactions: {
        days_requested: 30,
      },
      redirect_uri: process.env.PLAID_REDIRECT_URI || undefined,
    });

    res.json({ link_token: response.data.link_token });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post("/api/plaid/exchange-public-token", requirePlaidConfig, async (req, res) => {
  try {
    const { public_token: publicToken } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    demoItem = {
      accessToken: response.data.access_token,
      itemId: response.data.item_id,
      cursor: null,
      transactions: [],
    };
    await saveDemoItem();

    res.json({ item_id: demoItem.itemId });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post("/api/plaid/sync-transactions", requirePlaidConfig, async (req, res) => {
  try {
    if (!demoItem.accessToken) {
      res.status(400).json({ error: "No connected Plaid item yet." });
      return;
    }

    let cursor = demoItem.cursor;
    let hasMore = true;
    const added = [];
    const modified = [];
    const removed = [];

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: demoItem.accessToken,
        cursor,
      });

      added.push(...response.data.added);
      modified.push(...response.data.modified);
      removed.push(...response.data.removed);
      cursor = response.data.next_cursor;
      hasMore = response.data.has_more;
    }

    const byId = new Map(demoItem.transactions.map((transaction) => [transaction.id, transaction]));

    const normalizedAdded = await classifyWithLLM(
      filterTransactionsByDays(added.map(normalizeTransaction), 30)
    );
    const normalizedModified = await classifyWithLLM(
      filterTransactionsByDays(modified.map(normalizeTransaction), 30)
    );

    for (const transaction of normalizedAdded) {
      byId.set(transaction.id, transaction);
    }

    for (const transaction of normalizedModified) {
      byId.set(transaction.id, transaction);
    }

    for (const transaction of removed) {
      byId.delete(transaction.transaction_id);
    }

    demoItem.cursor = cursor;
    demoItem.transactions = filterTransactionsByDays(Array.from(byId.values()), 30).sort((a, b) =>
      b.date.localeCompare(a.date)
    );
    await saveDemoItem();

    res.json({
      item_id: demoItem.itemId,
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      ...buildDashboardPayload(demoItem.transactions),
    });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.get("/api/transactions", (req, res) => {
  res.json(buildDashboardPayload(demoItem.transactions));
});

app.get("/api/dashboard", (req, res) => {
  res.json({
    connected: Boolean(demoItem.accessToken),
    item_id: demoItem.itemId,
    ...buildDashboardPayload(demoItem.transactions),
  });
});

app.post("/api/classify-with-llm", async (req, res) => {
  try {
    if (!openai) {
      res.status(400).json({ error: "Missing OPENAI_API_KEY in .env." });
      return;
    }

    demoItem.transactions = await classifyWithLLM(demoItem.transactions);
    await saveDemoItem();

    res.json(buildDashboardPayload(demoItem.transactions));
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post("/api/disconnect", async (req, res) => {
  demoItem = {
    accessToken: null,
    itemId: null,
    cursor: null,
    transactions: [],
  };
  await saveDemoItem();

  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Plaid demo API listening on http://localhost:${port}`);
});
