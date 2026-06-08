# Spending Agent Plaid Demo

Mobile-first Plaid demo for connecting a bank, syncing the latest 30 days of transactions, auto-classifying low-confidence transactions with a small LLM, and showing a weekly spending view.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local env file:

```bash
cp .env.example .env
```

3. Fill these values in `.env` from Plaid Dashboard:

```bash
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox
```

Optional LLM categorization:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-nano
```

The app first uses local rules and Plaid categories. It only sends low-confidence categories like `Other`, `Payment`, and `Transfer` to the small LLM. The model receives transaction date, merchant, amount, and Plaid's high-level category, not Plaid tokens or account numbers.

Optional persistent storage secret:

```bash
APP_STORAGE_SECRET=any-long-random-string
APP_USER_ID=demo-user
DATABASE_URL=
```

If `DATABASE_URL` is empty, the backend creates a local key in `.data/local-storage-key` and stores encrypted state in `.data/state.json`. If `DATABASE_URL` is set, the backend stores encrypted state in Postgres. On Render, always set a stable `APP_STORAGE_SECRET`; otherwise encrypted Plaid tokens may become unreadable after a redeploy.

4. Run the app:

```bash
npm run dev
```

5. Open:

```text
http://localhost:5173
```

For phone testing on the same Wi-Fi, use your Mac's LAN IP with the Vite port, for example:

```text
http://192.168.1.20:5173
```

## Sandbox Flow

1. Tap `Connect Bank`.
2. Pick a Plaid Sandbox institution.
3. Use Plaid Sandbox credentials shown in Link.
4. Tap `Sync`.
5. The app fetches the latest 30 days, auto-runs AI classification when configured, and shows a last-7-days spending module.

## Notes

- This demo stores the Plaid `access_token` encrypted in `.data/state.json`.
- Restarting the server preserves the connected item, cursor, and recent-month transactions.
- If `DATABASE_URL` is set, state is stored in a Postgres `app_state` table instead of `.data/state.json`.
- A production app must encrypt tokens, persist cursors, support disconnect, and avoid logging sensitive fields.
- LLM classification is optional. If `OPENAI_API_KEY` is missing, the app stays fully rule/Plaid based.
- The UI intentionally shows only recent-month transactions and a separate recent-week spending summary.

## Native iPhone App

The native SwiftUI app lives here:

```text
ios/MoneyLoop/MoneyLoop.xcodeproj
```

Open it with Xcode:

```bash
open ios/MoneyLoop/MoneyLoop.xcodeproj
```

Run the Vite/backend app first:

```bash
npm run dev
```

For iPhone testing, the phone and Mac must be on the same Wi-Fi. In the Money Loop app settings, set the server URL to your Mac LAN address with port `5173`, for example:

```text
http://10.0.28.212:5173
```

Do not use `localhost` on a physical iPhone because that points to the phone itself, not your Mac.

The native app flow is:

1. SwiftUI app calls `GET /api/dashboard`.
2. `Connect` opens `/mobile-link.html` in Safari Services.
3. The bridge page opens Plaid Link.
4. Plaid returns a `public_token` to `moneyloop://plaid-success`.
5. The app handles that URL, calls `POST /api/plaid/exchange-public-token`, then `POST /api/plaid/sync-transactions`.
6. The backend stores the encrypted Plaid token in `.data/state.json`, so reconnecting is not needed after backend restarts.

## Deploy on Render + Supabase

Use this setup for a fixed HTTPS backend URL.

### 1. Create Supabase project

Create a free Supabase project, then copy its Postgres connection string. Use the pooled/session connection string if Supabase recommends it for serverless-style hosting.

The backend auto-creates this table on first write:

```sql
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2. Create Render web service

You can use `render.yaml` from this repo, or create a web service manually:

```text
Build command: npm install && npm run build
Start command: npm start
Health check: /api/health
```

Required Render environment variables:

```bash
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production
PLAID_PRODUCTS=transactions
PLAID_COUNTRY_CODES=US
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-nano
APP_STORAGE_SECRET=生成一个长随机字符串
APP_USER_ID=demo-user
DATABASE_URL=Supabase Postgres connection string
```

After deploy, verify:

```text
https://your-render-service.onrender.com/api/health
```

It should return:

```json
{
  "ok": true,
  "storage": "postgres"
}
```

### 3. Point iPhone app at Render

In the Money Loop app settings, set:

```text
https://your-render-service.onrender.com
```

For a production app, hide the settings screen and hardcode the Render URL in `ContentView.swift`.
