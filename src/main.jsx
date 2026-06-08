import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePlaidLink } from "react-plaid-link";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./styles.css";

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }

  return data;
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function shortDate(date) {
  if (!date) return "";
  return date.slice(5).replace("-", "/");
}

function ConnectBank({ onConnected, onStatus }) {
  const [linkToken, setLinkToken] = useState(null);

  useEffect(() => {
    let ignore = false;

    api("/api/plaid/create-link-token", { method: "POST" })
      .then((data) => {
        if (!ignore) setLinkToken(data.link_token);
      })
      .catch((error) => onStatus(error.message));

    return () => {
      ignore = true;
    };
  }, [onStatus]);

  const onSuccess = useCallback(
    async (publicToken) => {
      onStatus("Connecting account...");
      await api("/api/plaid/exchange-public-token", {
        method: "POST",
        body: JSON.stringify({ public_token: publicToken }),
      });
      onStatus("Connected. Sync the last 30 days when ready.");
      onConnected();
    },
    [onConnected, onStatus]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
  });

  return (
    <button className="primaryButton" onClick={() => open()} disabled={!ready}>
      Connect
    </button>
  );
}

function MiniStat({ label, value, tone }) {
  return (
    <div className="miniStat">
      <span>{label}</span>
      <strong className={tone || ""}>{value}</strong>
    </div>
  );
}

function DailyBars({ data }) {
  const max = Math.max(...data.map((day) => day.amount), 1);

  return (
    <div className="dailyBars">
      {data.map((day) => (
        <div className="dailyBarItem" key={day.date}>
          <div className="dailyBarTrack">
            <span style={{ height: `${Math.max((day.amount / max) * 100, day.amount ? 8 : 0)}%` }} />
          </div>
          <small>{day.label}</small>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState("Ready.");
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [week, setWeek] = useState(null);
  const [insight, setInsight] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const applyDashboardData = (data) => {
    setTransactions(data.transactions || []);
    setSummary(data.summary || null);
    setWeek(data.week || null);
    setInsight(data.insight || null);
  };

  const loadTransactions = useCallback(async () => {
    const data = await api("/api/transactions");
    applyDashboardData(data);
  }, []);

  useEffect(() => {
    loadTransactions().catch(() => {});
  }, [loadTransactions]);

  const syncTransactions = async () => {
    setIsSyncing(true);
    setStatus("Syncing last 30 days and classifying with AI...");

    try {
      const data = await api("/api/plaid/sync-transactions", { method: "POST" });
      applyDashboardData(data);
      setStatus(`Updated ${data.transactions?.length || 0} transactions from the last 30 days.`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const disconnect = async () => {
    await api("/api/disconnect", { method: "POST" });
    setTransactions([]);
    setSummary(null);
    setWeek(null);
    setInsight(null);
    setStatus("Disconnected locally.");
  };

  const chartData = useMemo(
    () => (summary?.categoryBreakdown || []).slice(0, 5),
    [summary]
  );
  const weekTransactions = week?.transactions || [];
  const largestWeekTransaction = weekTransactions
    .filter((transaction) => transaction.direction === "expense")
    .slice()
    .sort((a, b) => b.amount - a.amount)[0];

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <p className="eyebrow">Personal spending</p>
          <h1>Money Loop</h1>
        </div>
        <button className="iconButton" onClick={disconnect} title="Disconnect local data">
          x
        </button>
      </header>

      <section className="balancePanel">
        <div className="balanceHeader">
          <span>Last 30 days</span>
          <b>{transactions.length} txns</b>
        </div>
        <strong className="balanceAmount">{money(summary?.totalExpense)}</strong>
        <p>{status}</p>
        <div className="actions">
          <ConnectBank
            onConnected={loadTransactions}
            onStatus={(message) => setStatus(message)}
          />
          <button className="secondaryButton" onClick={syncTransactions} disabled={isSyncing}>
            {isSyncing ? "Syncing" : "Sync"}
          </button>
        </div>
      </section>

      <section className="miniStats">
        <MiniStat label="Income" value={money(summary?.totalIncome)} tone="income" />
        <MiniStat
          label="Net"
          value={money((summary?.totalIncome || 0) - (summary?.totalExpense || 0))}
        />
        <MiniStat label="AI sorted" value="Auto" tone="ai" />
      </section>

      <section className="panel insightPanel">
        <div className="sectionHeader">
          <div>
            <h2>Monthly Brief</h2>
            <p>Auto cleaned and categorized</p>
          </div>
          <span>{insight?.topCategoryName || "Ready"}</span>
        </div>
        <strong>{insight?.headline || "Connect and sync to generate a spending summary."}</strong>
        <p>{insight?.month || "No spending categories yet."}</p>
        <p>{insight?.week || "Weekly comparison will appear after sync."}</p>
        {insight?.topMerchants?.length ? (
          <div className="merchantChips">
            {insight.topMerchants.slice(0, 3).map((merchant) => (
              <span key={merchant.name}>
                {merchant.name} <b>{money(merchant.value)}</b>
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="weekPanel">
        <div className="sectionHeader">
          <div>
            <h2>Last 7 Days</h2>
            <p>Spending from recent posted transactions</p>
          </div>
          <strong>{money(week?.summary?.totalExpense)}</strong>
        </div>
        <DailyBars data={week?.dailySpending || []} />
        {largestWeekTransaction ? (
          <div className="weekCallout">
            <span>Largest</span>
            <b>{largestWeekTransaction.merchant}</b>
            <strong>{money(largestWeekTransaction.amount)}</strong>
          </div>
        ) : (
          <p className="emptyText">No expenses in the last 7 days.</p>
        )}
      </section>

      <section className="panel">
        <div className="sectionHeader">
          <div>
            <h2>Categories</h2>
            <p>Last 30 days</p>
          </div>
          <span>{chartData.length} groups</span>
        </div>
        {chartData.length > 0 ? (
          <div className="chartWrap">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 4, right: 16 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={92}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={(value) => money(value)} />
                <Bar dataKey="value" radius={[0, 7, 7, 0]} fill="#0f766e" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="emptyText">Connect and sync to see category spending.</p>
        )}
      </section>

      <section className="panel">
        <div className="sectionHeader">
          <div>
            <h2>Transactions</h2>
            <p>Recent month only</p>
          </div>
          <span>{transactions.length}</span>
        </div>
        <div className="transactionList">
          {transactions.slice(0, 20).map((transaction) => (
            <article className="transactionRow" key={transaction.id}>
              <div className="merchantIcon">{transaction.merchant?.slice(0, 1) || "?"}</div>
              <div className="transactionCopy">
                <strong>{transaction.merchant}</strong>
                <span>
                  {shortDate(transaction.date)} · {transaction.category}
                  {transaction.subcategory ? ` · ${transaction.subcategory}` : ""}
                  {transaction.location ? ` · ${transaction.location}` : ""}
                </span>
                <small>
                  {transaction.rawMerchant && transaction.rawMerchant !== transaction.merchant
                    ? `Cleaned from ${transaction.rawMerchant}`
                    : "Cleaned merchant"}
                  {typeof transaction.confidence === "number"
                    ? ` · ${Math.round(transaction.confidence * 100)}%`
                    : ""}
                </small>
              </div>
              <b className={transaction.direction === "income" ? "income" : ""}>
                {transaction.direction === "income" ? "+" : "-"}
                {money(Math.abs(transaction.amount))}
              </b>
            </article>
          ))}
          {transactions.length === 0 && (
            <p className="emptyText">No transactions loaded yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
