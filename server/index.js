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
const displayDays = 30;
const historyDays = 120;
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
  { category: "Dining", subcategory: "Coffee", patterns: ["coffee", "starbucks", "peet"] },
  {
    category: "Dining",
    subcategory: "Fast Casual",
    patterns: ["sweetgreen", "chipotle", "mcdonald", "taco", "burger", "pizza"],
  },
  {
    category: "Dining",
    subcategory: "Food Delivery",
    patterns: ["doordash", "door dash", "ubereats", "uber eats", "grubhub", "postmates", "delivery"],
  },
  { category: "Dining", subcategory: "Restaurant", patterns: ["restaurant", "cafe", "bar"] },
  { category: "Groceries", subcategory: "Grocery", patterns: ["market", "grocery", "whole foods", "supermarket", "trader joe"] },
  { category: "Transport", subcategory: "Rideshare", patterns: ["uber", "lyft"] },
  { category: "Transport", subcategory: "Transit", patterns: ["metro", "transit", "bart", "clipper", "parking"] },
  { category: "Shopping", subcategory: "Retail", patterns: ["amazon", "target", "walmart", "store", "shop"] },
  { category: "Travel", subcategory: "Flights", patterns: ["airline", "united", "delta", "southwest"] },
  { category: "Travel", subcategory: "Lodging", patterns: ["hotel", "booking", "airbnb"] },
  { category: "Subscription", subcategory: "Software", patterns: ["openai", "apple", "google", "subscription"] },
  { category: "Subscription", subcategory: "Media", patterns: ["netflix", "spotify", "hulu"] },
  { category: "Income", subcategory: "Payroll", patterns: ["payroll", "direct deposit"] },
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

const plaidSubcategoryMap = {
  FOOD_AND_DRINK_COFFEE: "Coffee",
  FOOD_AND_DRINK_FAST_FOOD: "Fast Food",
  FOOD_AND_DRINK_RESTAURANT: "Restaurant",
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: "Online Shopping",
  GENERAL_MERCHANDISE_SUPERSTORES: "Retail",
  RENT_AND_UTILITIES_RENT: "Rent",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: "Utilities",
  TRANSFER_IN_DEPOSIT: "Deposit",
  TRANSFER_OUT_ACCOUNT_TRANSFER: "Account Transfer",
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "Rideshare",
  TRAVEL_FLIGHTS: "Flights",
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
      transactions: filterTransactionsByDays(rawState.transactions || [], historyDays).sort((a, b) =>
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
    transactions: filterTransactionsByDays(demoItem.transactions || [], historyDays),
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

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateFromKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function filterTransactionsByRange(transactions, start, end) {
  const startKey = typeof start === "string" ? start : dateKey(start);
  const endKey = typeof end === "string" ? end : dateKey(end);

  return transactions.filter(
    (transaction) => transaction.date >= startKey && transaction.date <= endKey
  );
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

function titleCase(value) {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 3 && /^[a-z]+$/.test(word)) {
        return word.toUpperCase();
      }

      return word[0].toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function cleanMerchantName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Unknown Merchant";

  const cleaned = raw
    .replace(/^(TST|SQ|SP|POS|DEBIT|CARD|CHECKCARD|PURCHASE|AUTH)\*?\s*/i, "")
    .replace(/\b(ID|REF|AUTH|CO|INC|LLC)\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi, "")
    .replace(/[#*]\s*\d+\b/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\b(ONLINE|PURCHASE|PAYMENT|THANK YOU|THANK)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[,\-.]+$/g, "")
    .trim();

  return titleCase(cleaned || raw);
}

function extractLocation(transaction, merchantText) {
  const city = transaction.location?.city || transaction.location?.region || "";
  if (city) return titleCase(city);

  const match = String(merchantText || "").match(
    /\b([A-Z][A-Z .'-]{2,})\s+(CA|NY|WA|TX|OR|FL|IL|MA|NJ|PA|DC)\b/
  );

  return match ? titleCase(match[1].trim()) : null;
}

function classifyTransaction(transaction) {
  if (transaction.amount < 0) {
    return { category: "Income", subcategory: "Income", confidence: 0.98, source: "amount" };
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
    return {
      category: match.category,
      subcategory: match.subcategory || null,
      confidence: 0.86,
      source: "rule",
    };
  }

  const plaidPrimary = transaction.personal_finance_category?.primary;
  const plaidDetailed = transaction.personal_finance_category?.detailed;
  const mappedPlaidCategory = plaidCategoryMap[plaidPrimary];

  if (mappedPlaidCategory) {
    return {
      category: mappedPlaidCategory,
      subcategory: plaidSubcategoryMap[plaidDetailed] || null,
      confidence: 0.78,
      source: "plaid",
    };
  }

  return { category: "Other", subcategory: null, confidence: 0.45, source: "fallback" };
}

function normalizeTransaction(transaction) {
  const { category, subcategory, confidence, source } = classifyTransaction(transaction);
  const rawMerchant = transaction.name || transaction.merchant_name || "Unknown Merchant";
  const merchant = cleanMerchantName(transaction.merchant_name || transaction.name);

  return {
    id: transaction.transaction_id,
    date: transaction.date,
    rawMerchant,
    merchant,
    amount: transaction.amount,
    direction: transaction.amount < 0 ? "income" : "expense",
    category,
    subcategory,
    location: extractLocation(transaction, rawMerchant),
    confidence,
    categorySource: source,
    plaidCategory: transaction.personal_finance_category?.primary || null,
    plaidDetailedCategory: transaction.personal_finance_category?.detailed || null,
    pending: transaction.pending,
  };
}

async function classifyWithLLM(transactions) {
  if (!openai) return transactions;

  const candidates = transactions.filter(
    (transaction) =>
      transaction.direction === "expense" &&
      (!String(transaction.categorySource || "").startsWith("llm:") ||
        !transaction.subcategory ||
        typeof transaction.confidence !== "number")
  );

  if (candidates.length === 0) return transactions;

  const classificationById = new Map();
  const chunkSize = 24;

  for (let index = 0; index < candidates.length; index += chunkSize) {
    const chunk = candidates.slice(index, index + chunkSize);
    const response = await openai.responses.create({
      model: openaiModel,
      instructions:
        "Clean and classify bank transactions for a personal spending dashboard. Convert messy raw merchant text into a short human-readable merchant name. Use only the allowed categories. Add a practical subcategory, city/location if obvious, and confidence from 0 to 1. Do not give financial advice.",
      input: JSON.stringify({
        allowed_categories: allowedCategories,
        transactions: chunk.map((transaction) => ({
          id: transaction.id,
          date: transaction.date,
          raw_merchant: transaction.rawMerchant,
          merchant: transaction.merchant,
          amount: transaction.amount,
          plaid_category: transaction.plaidCategory,
          plaid_detailed_category: transaction.plaidDetailedCategory,
          current_category: transaction.category,
          current_subcategory: transaction.subcategory,
          current_location: transaction.location,
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
                    merchant: { type: "string" },
                    category: { type: "string", enum: allowedCategories },
                    subcategory: { type: "string" },
                    location: { type: "string" },
                    confidence: { type: "number" },
                  },
                  required: ["id", "merchant", "category", "subcategory", "location", "confidence"],
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
        classificationById.set(item.id, item);
      }
    }
  }

  return transactions.map((transaction) => {
    const classification = classificationById.get(transaction.id);

    if (!classification) {
      return transaction;
    }

    return {
      ...transaction,
      merchant: cleanMerchantName(classification.merchant || transaction.merchant),
      category: classification.category,
      subcategory: classification.subcategory || transaction.subcategory,
      location: classification.location || transaction.location,
      confidence: Math.max(transaction.confidence || 0, classification.confidence),
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

function moneyText(value) {
  return `$${Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

function topMerchants(transactions, limit = 3) {
  const totals = transactions
    .filter((transaction) => transaction.direction === "expense" && !transaction.pending)
    .reduce((acc, transaction) => {
      acc[transaction.merchant] = (acc[transaction.merchant] || 0) + transaction.amount;
      return acc;
    }, {});

  return Object.entries(totals)
    .map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function topCategories(transactions, limit = 3) {
  return buildSummary(transactions).categoryBreakdown.slice(0, limit);
}

function totalExpenses(transactions) {
  return Number(
    transactions
      .filter((transaction) => transaction.direction === "expense" && !transaction.pending)
      .reduce((sum, transaction) => sum + transaction.amount, 0)
      .toFixed(2)
  );
}

function takeoutTransactions(transactions) {
  return transactions.filter((transaction) => {
    const text = [
      transaction.merchant,
      transaction.rawMerchant,
      transaction.category,
      transaction.subcategory,
      transaction.plaidDetailedCategory,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      transaction.direction === "expense" &&
      transaction.category === "Dining" &&
      (text.includes("delivery") ||
        text.includes("takeout") ||
        text.includes("doordash") ||
        text.includes("uber eats") ||
        text.includes("ubereats") ||
        text.includes("grubhub") ||
        text.includes("postmates"))
    );
  });
}

function categoryDeltaDrivers(currentTransactions, previousTransactions, limit = 2) {
  const current = buildSummary(currentTransactions).categoryBreakdown;
  const previous = new Map(
    buildSummary(previousTransactions).categoryBreakdown.map((category) => [
      category.name,
      category.value,
    ])
  );

  return current
    .map((category) => ({
      name: category.name,
      value: category.value,
      delta: Number((category.value - (previous.get(category.name) || 0)).toFixed(2)),
    }))
    .filter((category) => category.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, limit);
}

function monthAverage(transactions, startMonth, monthCount, filterFn) {
  const totals = [];

  for (let index = 0; index < monthCount; index += 1) {
    const start = addMonths(startMonth, -index);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    const monthTransactions = filterTransactionsByRange(transactions, start, end);
    totals.push(totalExpenses(filterFn ? monthTransactions.filter(filterFn) : monthTransactions));
  }

  if (totals.length === 0) return 0;

  return Number((totals.reduce((sum, value) => sum + value, 0) / totals.length).toFixed(2));
}

function buildSpendingReports(transactions) {
  const today = endOfDay();
  const currentMonthStart = startOfMonth(today);
  const previousMonthStart = addMonths(currentMonthStart, -1);
  const previousMonthSameDay = new Date(
    previousMonthStart.getFullYear(),
    previousMonthStart.getMonth(),
    Math.min(today.getDate(), new Date(previousMonthStart.getFullYear(), previousMonthStart.getMonth() + 1, 0).getDate())
  );
  const currentWeekStart = dateFromKey(daysAgoKey(7));
  const previousWeekStart = dateFromKey(daysAgoKey(14));
  const previousWeekEnd = new Date(currentWeekStart);
  previousWeekEnd.setDate(previousWeekEnd.getDate() - 1);

  const currentMonth = filterTransactionsByRange(transactions, currentMonthStart, today);
  const previousMonthSamePeriod = filterTransactionsByRange(
    transactions,
    previousMonthStart,
    previousMonthSameDay
  );
  const currentWeek = filterTransactionsByRange(transactions, currentWeekStart, today);
  const previousWeek = filterTransactionsByRange(
    transactions,
    previousWeekStart,
    previousWeekEnd
  );

  const monthSpent = totalExpenses(currentMonth);
  const previousMonthSpent = totalExpenses(previousMonthSamePeriod);
  const monthDelta = Number((monthSpent - previousMonthSpent).toFixed(2));
  const weekSpent = totalExpenses(currentWeek);
  const previousWeekSpent = totalExpenses(previousWeek);
  const weekDelta = Number((weekSpent - previousWeekSpent).toFixed(2));
  const drivers = categoryDeltaDrivers(currentMonth, previousMonthSamePeriod);
  const takeoutSpent = totalExpenses(takeoutTransactions(currentMonth));
  const threeMonthTakeoutAverage = monthAverage(
    transactions,
    addMonths(currentMonthStart, -1),
    3,
    (transaction) => takeoutTransactions([transaction]).length > 0
  );
  const takeoutDeltaPercent =
    threeMonthTakeoutAverage > 0
      ? Math.round(((takeoutSpent - threeMonthTakeoutAverage) / threeMonthTakeoutAverage) * 100)
      : null;
  const driverText = drivers.length
    ? `增长主要来自 ${drivers.map((driver) => driver.name).join(" 和 ")}。`
    : monthDelta > 0
      ? "增长分布在多个类别。"
      : "整体没有明显增长类别。";
  const takeoutText =
    takeoutSpent > 0 && takeoutDeltaPercent !== null
      ? `你在外卖上花了 ${moneyText(takeoutSpent)}，${
          takeoutDeltaPercent >= 0 ? "已经超过" : "低于"
        }过去三个月平均水平 ${Math.abs(takeoutDeltaPercent)}%。`
      : takeoutSpent > 0
        ? `你在外卖上花了 ${moneyText(takeoutSpent)}。`
        : "这个月目前没有明显外卖支出。";

  return {
    monthly: {
      title: "Monthly Summary",
      period: `${dateKey(currentMonthStart)} to ${dateKey(today)}`,
      total: monthSpent,
      comparisonTotal: previousMonthSpent,
      delta: monthDelta,
      text:
        monthSpent > 0
          ? `你本月目前花了 ${moneyText(monthSpent)}，比上月同期${
              monthDelta >= 0 ? "高" : "低"
            } ${moneyText(Math.abs(monthDelta))}。${driverText}${takeoutText}`
          : "同步交易后会自动生成本月消费总结。",
      drivers,
      takeout: {
        total: takeoutSpent,
        threeMonthAverage: threeMonthTakeoutAverage,
        deltaPercent: takeoutDeltaPercent,
      },
    },
    weekly: {
      title: "Weekly Summary",
      period: `${dateKey(currentWeekStart)} to ${dateKey(today)}`,
      total: weekSpent,
      comparisonTotal: previousWeekSpent,
      delta: weekDelta,
      text:
        weekSpent > 0
          ? `最近 7 天花了 ${moneyText(weekSpent)}，比前 7 天${
              weekDelta >= 0 ? "高" : "低"
            } ${moneyText(Math.abs(weekDelta))}。主要支出集中在 ${
              topCategories(currentWeek, 2).map((category) => category.name).join(" 和 ") || "少数交易"
            }。`
          : "最近 7 天没有已入账消费。",
      drivers: categoryDeltaDrivers(currentWeek, previousWeek),
    },
  };
}

function buildSpendingInsight(monthTransactions, weekTransactions) {
  const monthSummary = buildSummary(monthTransactions);
  const weekSummary = buildSummary(weekTransactions);
  const previousWeekSummary = buildSummary(
    monthTransactions.filter((transaction) => {
      const currentWeekStart = daysAgoKey(7);
      const previousWeekStart = daysAgoKey(14);
      return transaction.date >= previousWeekStart && transaction.date < currentWeekStart;
    })
  );
  const topCategory = monthSummary.categoryBreakdown[0];
  const weekDelta = Number(
    (weekSummary.totalExpense - previousWeekSummary.totalExpense).toFixed(2)
  );
  const merchants = topMerchants(monthTransactions, 3);
  const merchantText = merchants.length
    ? `Top merchants: ${merchants.map((merchant) => `${merchant.name} ${moneyText(merchant.value)}`).join(", ")}.`
    : "No top merchants yet.";
  const comparisonText =
    previousWeekSummary.totalExpense > 0
      ? `Last 7 days are ${moneyText(Math.abs(weekDelta))} ${
          weekDelta >= 0 ? "above" : "below"
        } the previous 7 days.`
      : "Previous-week comparison will appear after more transactions.";

  return {
    headline:
      monthSummary.totalExpense > 0
        ? `You spent ${moneyText(monthSummary.totalExpense)} in the last 30 days.`
        : "Connect and sync to generate a spending summary.",
    month:
      topCategory
        ? `The biggest category is ${topCategory.name} at ${moneyText(topCategory.value)}. ${merchantText}`
        : "No spending categories yet.",
    week: `${comparisonText} This week spending is ${moneyText(weekSummary.totalExpense)}.`,
    topCategoryName: topCategory?.name || null,
    topMerchants: merchants,
  };
}

function withTransactionDefaults(transaction) {
  const merchant = cleanMerchantName(transaction.merchant || transaction.rawMerchant || "Unknown Merchant");

  return {
    ...transaction,
    rawMerchant: transaction.rawMerchant || transaction.merchant || merchant,
    merchant,
    category: transaction.category || "Other",
    subcategory: transaction.subcategory || null,
    location: transaction.location || null,
    confidence: Number(transaction.confidence ?? 0.6),
    pending: Boolean(transaction.pending),
  };
}

function buildDashboardPayload(transactions) {
  const historyTransactions = filterTransactionsByDays(
    transactions.map(withTransactionDefaults),
    historyDays
  );
  const monthTransactions = filterTransactionsByDays(historyTransactions, displayDays);
  const weekTransactions = filterTransactionsByDays(monthTransactions, 7);

  return {
    transactions: monthTransactions,
    summary: buildSummary(monthTransactions),
    insight: buildSpendingInsight(monthTransactions, weekTransactions),
    reports: buildSpendingReports(historyTransactions),
    week: {
      transactions: weekTransactions,
      summary: buildSummary(weekTransactions),
      dailySpending: buildDailySpending(weekTransactions, 7),
    },
  };
}

function detectAnomalies(transactions, limit = 5) {
  const expenses = transactions
    .filter((transaction) => transaction.direction === "expense" && !transaction.pending)
    .sort((a, b) => b.amount - a.amount);

  if (expenses.length === 0) return [];

  const average = expenses.reduce((sum, transaction) => sum + transaction.amount, 0) / expenses.length;
  const variance =
    expenses.reduce((sum, transaction) => sum + (transaction.amount - average) ** 2, 0) /
    expenses.length;
  const stddev = Math.sqrt(variance);
  const threshold = Math.max(average + stddev * 1.7, 100);

  return expenses
    .filter((transaction) => transaction.amount >= threshold)
    .slice(0, limit)
    .map((transaction) => ({
      merchant: transaction.merchant,
      date: transaction.date,
      amount: transaction.amount,
      category: transaction.category,
      reason: `${moneyText(transaction.amount)} is above your recent typical transaction size.`,
    }));
}

function savingsOpportunities(transactions, limit = 4) {
  const discretionaryCategories = new Set([
    "Dining",
    "Shopping",
    "Entertainment",
    "Subscription",
    "Travel",
    "Transport",
  ]);

  return buildSummary(
    transactions.filter((transaction) => discretionaryCategories.has(transaction.category))
  )
    .categoryBreakdown.slice(0, limit)
    .map((category) => ({
      category: category.name,
      amount: category.value,
      suggestion: `Review recurring or low-value ${category.name.toLowerCase()} spending first.`,
    }));
}

function buildQueryContext() {
  const historyTransactions = filterTransactionsByDays(
    demoItem.transactions.map(withTransactionDefaults),
    historyDays
  );
  const currentMonth = filterTransactionsByRange(
    historyTransactions,
    startOfMonth(),
    endOfDay()
  );
  const reports = buildSpendingReports(historyTransactions);

  return {
    generatedAt: new Date().toISOString(),
    reports,
    currentMonthSummary: buildSummary(currentMonth),
    takeoutThisMonth: totalExpenses(takeoutTransactions(currentMonth)),
    anomalies: detectAnomalies(historyTransactions),
    savings: savingsOpportunities(currentMonth),
    transactions: historyTransactions.slice(0, 90).map((transaction) => ({
      date: transaction.date,
      merchant: transaction.merchant,
      rawMerchant: transaction.rawMerchant,
      amount: transaction.amount,
      direction: transaction.direction,
      category: transaction.category,
      subcategory: transaction.subcategory,
      location: transaction.location,
      pending: transaction.pending,
    })),
  };
}

function fallbackQueryAnswer(question, context) {
  const normalizedQuestion = String(question || "").toLowerCase();

  if (normalizedQuestion.includes("外卖") || normalizedQuestion.includes("takeout") || normalizedQuestion.includes("delivery")) {
    return `你这个月外卖花了 ${moneyText(context.takeoutThisMonth)}。`;
  }

  if (
    normalizedQuestion.includes("不正常") ||
    normalizedQuestion.includes("异常") ||
    normalizedQuestion.includes("unusual") ||
    normalizedQuestion.includes("abnormal")
  ) {
    if (context.anomalies.length === 0) {
      return "最近没有发现明显不正常的大额消费。";
    }

    const top = context.anomalies[0];
    return `最需要看一眼的是 ${top.date} 的 ${top.merchant}，金额 ${moneyText(top.amount)}，类别是 ${top.category}。`;
  }

  if (
    normalizedQuestion.includes("省钱") ||
    normalizedQuestion.includes("save") ||
    normalizedQuestion.includes("哪里")
  ) {
    if (context.savings.length === 0) {
      return "目前可分析的可选消费不多；同步更多交易后我会优先看餐饮、购物、订阅和交通。";
    }

    const top = context.savings[0];
    return `优先从 ${top.category} 看起，本月这类支出约 ${moneyText(top.amount)}。`;
  }

  return context.reports.monthly.text;
}

async function answerSpendingQuestion(question) {
  const context = buildQueryContext();

  if (!openai) {
    return {
      answer: fallbackQueryAnswer(question, context),
      context,
      source: "rule",
    };
  }

  const response = await openai.responses.create({
    model: openaiModel,
    instructions:
      "You are a concise personal spending analyst. Answer in Chinese. Use only the provided transaction context. If the data is insufficient, say what is missing. Do not give investment, credit, tax, or legal advice.",
    input: JSON.stringify({
      question,
      context,
    }),
  });

  return {
    answer: response.output_text?.trim() || fallbackQueryAnswer(question, context),
    context: {
      reports: context.reports,
      anomalies: context.anomalies,
      savings: context.savings,
      takeoutThisMonth: context.takeoutThisMonth,
    },
    source: `llm:${openaiModel}`,
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
        days_requested: historyDays,
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
      filterTransactionsByDays(added.map(normalizeTransaction), historyDays)
    );
    const normalizedModified = await classifyWithLLM(
      filterTransactionsByDays(modified.map(normalizeTransaction), historyDays)
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
    demoItem.transactions = await classifyWithLLM(
      filterTransactionsByDays(Array.from(byId.values()).map(withTransactionDefaults), historyDays)
    );
    demoItem.transactions = demoItem.transactions.sort((a, b) => b.date.localeCompare(a.date));
    await saveDemoItem();

    res.json({
      connected: Boolean(demoItem.accessToken),
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

app.get("/api/reports", (req, res) => {
  const historyTransactions = filterTransactionsByDays(
    demoItem.transactions.map(withTransactionDefaults),
    historyDays
  );
  res.json(buildSpendingReports(historyTransactions));
});

app.post("/api/query", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();

    if (!question) {
      res.status(400).json({ error: "Missing question." });
      return;
    }

    res.json(await answerSpendingQuestion(question));
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
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
