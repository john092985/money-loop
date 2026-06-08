import SafariServices
import SwiftUI

private enum AppConfig {
    static let defaultBackendURL = "https://money-loop.onrender.com"
    static let legacyLocalBackendURL = "http://10.0.28.212:5173"
}

private enum AppPalette {
    static let page = Color(red: 0.94, green: 0.96, blue: 0.95)
}

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = AppConfig.defaultBackendURL
    @StateObject private var store = MoneyLoopStore()
    @State private var draftServerURL = ""
    @State private var linkDestination: LinkDestination?

    var body: some View {
        TabView {
            overviewScreen
                .tabItem {
                    Label("Overview", systemImage: "chart.pie.fill")
                }

            transactionsScreen
                .tabItem {
                    Label("Transactions", systemImage: "list.bullet.rectangle")
                }

            settingsScreen
                .tabItem {
                    Label("Settings", systemImage: "gearshape.fill")
                }
        }
        .tint(.teal)
        .task {
            migrateLegacyBackendURLIfNeeded()
            await store.load(baseURL: serverURL)
        }
        .onOpenURL { url in
            handleCallback(url)
        }
        .sheet(item: $linkDestination) { destination in
            SafariView(url: destination.url)
                .ignoresSafeArea()
        }
    }

    private var overviewScreen: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    heroPanel
                    statStrip
                    insightPanel
                    weekPanel
                    categoriesPanel
                }
                .padding(16)
            }
            .background(AppPalette.page)
            .navigationTitle("Money Loop")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await store.load(baseURL: serverURL) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(store.isLoading)
                    .accessibilityLabel("Reload")
                }
            }
        }
    }

    private var transactionsScreen: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    transactionSummaryCard
                    transactionsPanel
                }
                .padding(16)
            }
            .background(AppPalette.page)
            .navigationTitle("Transactions")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await store.sync(baseURL: serverURL) }
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .disabled(store.isLoading || !store.dashboard.connected)
                    .accessibilityLabel("Sync")
                }
            }
        }
    }

    private var settingsScreen: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("Bank") {
                        Text(store.dashboard.connected ? "Connected" : "Not connected")
                            .foregroundStyle(store.dashboard.connected ? .teal : .secondary)
                    }

                    Button {
                        openPlaidLink()
                    } label: {
                        Label(store.dashboard.connected ? "Reconnect Bank" : "Connect Bank", systemImage: "link")
                    }

                    Button {
                        Task { await store.sync(baseURL: serverURL) }
                    } label: {
                        Label("Sync Transactions", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(store.isLoading || !store.dashboard.connected)
                }

                Section("Backend") {
                    TextField(AppConfig.defaultBackendURL, text: $draftServerURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button("Use Cloud Backend") {
                        draftServerURL = AppConfig.defaultBackendURL
                    }

                    Button("Save Backend") {
                        serverURL = normalizedBackendURL(draftServerURL)
                        Task { await store.load(baseURL: serverURL) }
                    }
                }

                Section("Status") {
                    Text(store.status)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .onAppear {
                draftServerURL = serverURL
            }
        }
    }

    private var heroPanel: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Last 30 days")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white.opacity(0.74))
                    Text("\(store.dashboard.summary.transactionCount) transactions")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.58))
                }

                Spacer()

                StatusPill(connected: store.dashboard.connected)
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Spending")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.58))
                    .textCase(.uppercase)
                Text(store.dashboard.summary.totalExpense, format: .currency(code: "USD"))
                    .font(.system(size: 50, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.55)
                    .lineLimit(1)
            }

            Text(store.dashboard.insight.headline)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white.opacity(0.76))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                Button {
                    openPlaidLink()
                } label: {
                    Label(store.dashboard.connected ? "Reconnect" : "Connect", systemImage: "link")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.mint)

                Button {
                    Task { await store.sync(baseURL: serverURL) }
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .frame(width: 54, height: 44)
                }
                .buttonStyle(.bordered)
                .tint(.white)
                .disabled(store.isLoading || !store.dashboard.connected)
            }
            .font(.headline)
            .controlSize(.large)
        }
        .padding(22)
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.05, green: 0.18, blue: 0.15),
                    Color(red: 0.09, green: 0.33, blue: 0.28),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var statStrip: some View {
        HStack(spacing: 12) {
            StatTile(
                title: "Income",
                value: store.dashboard.summary.totalIncome,
                tint: .teal,
                icon: "arrow.down.left.circle.fill"
            )
            StatTile(
                title: "Net",
                value: store.dashboard.summary.totalIncome - store.dashboard.summary.totalExpense,
                tint: .indigo,
                icon: "equal.circle.fill"
            )
        }
    }

    private var insightPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(title: "Monthly Brief", subtitle: "Auto cleaned and categorized")

            Text(store.dashboard.insight.headline)
                .font(.headline.weight(.heavy))
                .foregroundStyle(.primary)

            VStack(alignment: .leading, spacing: 8) {
                InsightLine(icon: "calendar", text: store.dashboard.insight.month)
                InsightLine(icon: "chart.line.uptrend.xyaxis", text: store.dashboard.insight.week)
            }

            if !store.dashboard.insight.topMerchants.isEmpty {
                HStack(spacing: 8) {
                    ForEach(store.dashboard.insight.topMerchants.prefix(3)) { merchant in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(merchant.name)
                                .font(.caption.weight(.bold))
                                .lineLimit(1)
                            Text(merchant.value, format: .currency(code: "USD"))
                                .font(.caption2.weight(.heavy))
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
            }
        }
        .panelStyle()
    }

    private var weekPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Last 7 Days")
                        .font(.headline)
                    Text("Recent posted spending")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text(store.dashboard.week.summary.totalExpense, format: .currency(code: "USD"))
                    .font(.headline.weight(.heavy))
                    .foregroundStyle(.teal)
            }

            DailyBars(days: store.dashboard.week.dailySpending)

            if let largest = store.dashboard.week.transactions
                .filter({ $0.direction == "expense" })
                .sorted(by: { $0.amount > $1.amount })
                .first {
                HStack(spacing: 10) {
                    Text("Largest")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    Text(largest.merchant)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(1)
                    Spacer()
                    Text(largest.amount, format: .currency(code: "USD"))
                        .font(.subheadline.weight(.heavy))
                        .foregroundStyle(.red)
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                EmptyStateText("No expenses in the last 7 days.")
            }
        }
        .panelStyle()
    }

    private var categoriesPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(title: "Categories", subtitle: "Last 30 days")

            if store.dashboard.summary.categoryBreakdown.isEmpty {
                EmptyStateText("Connect and sync to see category spending.")
            } else {
                VStack(spacing: 10) {
                    ForEach(store.dashboard.summary.categoryBreakdown.prefix(6)) { category in
                        CategoryRow(
                            name: category.name,
                            value: category.value,
                            maxValue: maxCategoryValue
                        )
                    }
                }
            }
        }
        .panelStyle()
    }

    private var transactionsPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            PanelHeader(title: "Recent Transactions", subtitle: "Clean merchant names")

            if store.dashboard.transactions.isEmpty {
                EmptyStateText("No transactions loaded yet.")
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(store.dashboard.transactions.prefix(40)) { transaction in
                        TransactionRow(transaction: transaction)
                    }
                }
            }
        }
        .panelStyle()
    }

    private var transactionSummaryCard: some View {
        HStack(spacing: 12) {
            StatTile(
                title: "Spent",
                value: store.dashboard.summary.totalExpense,
                tint: .red,
                icon: "arrow.up.right.circle.fill"
            )
            StatTile(
                title: "This Week",
                value: store.dashboard.week.summary.totalExpense,
                tint: .teal,
                icon: "calendar.circle.fill"
            )
        }
    }

    private var maxCategoryValue: Double {
        max(store.dashboard.summary.categoryBreakdown.map(\.value).max() ?? 1, 1)
    }

    private func openPlaidLink() {
        let baseURL = normalizedBackendURL(serverURL)
        if baseURL != serverURL {
            serverURL = baseURL
        }

        guard let encodedReturnTo = "moneyloop://plaid-success".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/mobile-link.html?return_to=\(encodedReturnTo)") else {
            store.status = "Invalid server URL."
            return
        }

        linkDestination = LinkDestination(url: url)
    }

    private func handleCallback(_ url: URL) {
        guard url.scheme == "moneyloop", url.host == "plaid-success" else {
            return
        }

        linkDestination = nil

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let publicToken = components.queryItems?.first(where: { $0.name == "public_token" })?.value else {
            store.status = "Missing Plaid public token."
            return
        }

        Task {
            await store.exchange(publicToken: publicToken, baseURL: serverURL)
            await store.sync(baseURL: serverURL)
        }
    }

    private func migrateLegacyBackendURLIfNeeded() {
        if normalizedBackendURL(serverURL) == AppConfig.legacyLocalBackendURL {
            serverURL = AppConfig.defaultBackendURL
        }
    }

    private func normalizedBackendURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 1 else {
            return AppConfig.defaultBackendURL
        }

        return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
    }
}

struct StatTile: View {
    let title: String
    let value: Double
    let tint: Color
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon)
                .font(.title3.weight(.bold))
                .foregroundStyle(tint)

            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)

            Text(value, format: .currency(code: "USD"))
                .font(.title3.weight(.heavy))
                .foregroundStyle(tint)
                .minimumScaleFactor(0.65)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: .black.opacity(0.04), radius: 14, y: 8)
    }
}

struct StatusPill: View {
    let connected: Bool
    
    var body: some View {
        Label(connected ? "Live" : "Setup", systemImage: connected ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
            .font(.caption.weight(.heavy))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.white.opacity(0.16))
            .clipShape(Capsule())
    }
}

struct DailyBars: View {
    let days: [DailySpending]

    private var maxAmount: Double {
        max(days.map(\.amount).max() ?? 1, 1)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            ForEach(days) { day in
                VStack(spacing: 7) {
                    GeometryReader { proxy in
                        VStack {
                            Spacer()
                            RoundedRectangle(cornerRadius: 999)
                                .fill(Color.mint)
                                .frame(height: max(day.amount / maxAmount * proxy.size.height, day.amount > 0 ? 8 : 0))
                        }
                    }
                    .frame(height: 84)
                    .frame(maxWidth: .infinity)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(Capsule())

                    Text(day.label)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }
}

struct CategoryRow: View {
    let name: String
    let value: Double
    let maxValue: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(name)
                    .font(.subheadline.weight(.bold))
                Spacer()
                Text(value, format: .currency(code: "USD"))
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(.secondary)
            }

            GeometryReader { proxy in
                RoundedRectangle(cornerRadius: 999)
                    .fill(Color(.secondarySystemGroupedBackground))
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 999)
                            .fill(Color.teal)
                            .frame(width: proxy.size.width * max(value / maxValue, 0.03))
                    }
            }
            .frame(height: 9)
        }
    }
}

struct TransactionRow: View {
    let transaction: BankTransaction

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color(.secondarySystemGroupedBackground))
                .frame(width: 38, height: 38)
                .overlay {
                    Text(String(transaction.merchant.prefix(1)))
                        .font(.subheadline.weight(.heavy))
                }

            VStack(alignment: .leading, spacing: 3) {
                Text(transaction.merchant)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                Text("\(shortDate(transaction.date)) · \(transaction.category)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(transaction.detailText)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(abs(transaction.amount), format: .currency(code: "USD"))
                .font(.subheadline.weight(.heavy))
                .foregroundStyle(transaction.direction == "income" ? .teal : .red)
        }
        .padding(.vertical, 10)
    }

    private func shortDate(_ date: String) -> String {
        date.dropFirst(5).replacingOccurrences(of: "-", with: "/")
    }
}

struct InsightLine: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(.teal)
                .frame(width: 16)

            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PanelHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.headline)
            Text(subtitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyStateText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

extension View {
    func panelStyle() -> some View {
        padding(16)
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .shadow(color: .black.opacity(0.05), radius: 18, y: 10)
    }
}

@MainActor
final class MoneyLoopStore: ObservableObject {
    @Published var dashboard = Dashboard.empty
    @Published var status = "Ready."
    @Published var isLoading = false

    func load(baseURL: String) async {
        await perform("Loading...") {
            dashboard = try await MoneyLoopAPI(baseURL: baseURL).dashboard()
            status = dashboard.connected ? "Connected. Sync when ready." : "Connect your bank to begin."
        }
    }

    func exchange(publicToken: String, baseURL: String) async {
        await perform("Saving bank connection...") {
            try await MoneyLoopAPI(baseURL: baseURL).exchange(publicToken: publicToken)
            dashboard = try await MoneyLoopAPI(baseURL: baseURL).dashboard()
            status = "Bank connected."
        }
    }

    func sync(baseURL: String) async {
        await perform("Syncing and classifying...") {
            dashboard = try await MoneyLoopAPI(baseURL: baseURL).sync()
            status = "Updated \(dashboard.transactions.count) transactions."
        }
    }

    private func perform(_ loadingStatus: String, action: () async throws -> Void) async {
        isLoading = true
        status = loadingStatus

        do {
            try await action()
        } catch {
            status = error.localizedDescription
        }

        isLoading = false
    }
}

struct MoneyLoopAPI {
    let baseURL: String

    private var normalizedBaseURL: String {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
    }

    func dashboard() async throws -> Dashboard {
        try await request(path: "/api/dashboard")
    }

    func exchange(publicToken: String) async throws {
        let body = ["public_token": publicToken]
        let _: EmptyResponse = try await request(
            path: "/api/plaid/exchange-public-token",
            method: "POST",
            body: body
        )
    }

    func sync() async throws -> Dashboard {
        try await request(path: "/api/plaid/sync-transactions", method: "POST")
    }

    private func request<Response: Decodable, Body: Encodable>(
        path: String,
        method: String = "GET",
        body: Body? = Optional<String>.none
    ) async throws -> Response {
        guard let url = URL(string: normalizedBaseURL + path) else {
            throw MoneyLoopError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              200..<300 ~= httpResponse.statusCode else {
            let serverError = try? JSONDecoder().decode(ServerError.self, from: data)
            throw MoneyLoopError.server(serverError?.error ?? "Request failed.")
        }

        if Response.self == EmptyResponse.self {
            return EmptyResponse() as! Response
        }

        return try JSONDecoder().decode(Response.self, from: data)
    }
}

enum MoneyLoopError: LocalizedError {
    case invalidURL
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Invalid server URL."
        case .server(let message):
            message
        }
    }
}

struct EmptyResponse: Decodable {}

struct ServerError: Decodable {
    let error: String
}

struct Dashboard: Decodable {
    let connected: Bool
    let summary: Summary
    let insight: SpendingInsight
    let week: WeekSummary
    let transactions: [BankTransaction]

    enum CodingKeys: String, CodingKey {
        case connected
        case summary
        case insight
        case week
        case transactions
    }

    init(
        connected: Bool,
        summary: Summary,
        insight: SpendingInsight,
        week: WeekSummary,
        transactions: [BankTransaction]
    ) {
        self.connected = connected
        self.summary = summary
        self.insight = insight
        self.week = week
        self.transactions = transactions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        connected = try container.decodeIfPresent(Bool.self, forKey: .connected) ?? false
        summary = try container.decodeIfPresent(Summary.self, forKey: .summary) ?? .empty
        insight = try container.decodeIfPresent(SpendingInsight.self, forKey: .insight) ?? .empty
        week = try container.decodeIfPresent(WeekSummary.self, forKey: .week) ?? .empty
        transactions = try container.decodeIfPresent([BankTransaction].self, forKey: .transactions) ?? []
    }

    static let empty = Dashboard(
        connected: false,
        summary: .empty,
        insight: .empty,
        week: .empty,
        transactions: []
    )
}

struct Summary: Decodable {
    let totalExpense: Double
    let totalIncome: Double
    let transactionCount: Int
    let categoryBreakdown: [CategoryBreakdown]

    static let empty = Summary(
        totalExpense: 0,
        totalIncome: 0,
        transactionCount: 0,
        categoryBreakdown: []
    )
}

struct WeekSummary: Decodable {
    let transactions: [BankTransaction]
    let summary: Summary
    let dailySpending: [DailySpending]

    static let empty = WeekSummary(transactions: [], summary: .empty, dailySpending: [])
}

struct SpendingInsight: Decodable {
    let headline: String
    let month: String
    let week: String
    let topCategoryName: String?
    let topMerchants: [TopMerchant]

    enum CodingKeys: String, CodingKey {
        case headline
        case month
        case week
        case topCategoryName
        case topMerchants
    }

    init(
        headline: String,
        month: String,
        week: String,
        topCategoryName: String?,
        topMerchants: [TopMerchant]
    ) {
        self.headline = headline
        self.month = month
        self.week = week
        self.topCategoryName = topCategoryName
        self.topMerchants = topMerchants
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        headline = try container.decodeIfPresent(String.self, forKey: .headline) ?? Self.empty.headline
        month = try container.decodeIfPresent(String.self, forKey: .month) ?? Self.empty.month
        week = try container.decodeIfPresent(String.self, forKey: .week) ?? Self.empty.week
        topCategoryName = try container.decodeIfPresent(String.self, forKey: .topCategoryName)
        topMerchants = try container.decodeIfPresent([TopMerchant].self, forKey: .topMerchants) ?? []
    }

    static let empty = SpendingInsight(
        headline: "Connect and sync to generate a spending summary.",
        month: "No spending categories yet.",
        week: "Weekly comparison will appear after sync.",
        topCategoryName: nil,
        topMerchants: []
    )
}

struct TopMerchant: Decodable, Identifiable {
    let name: String
    let value: Double

    var id: String { name }
}

struct DailySpending: Decodable, Identifiable {
    let date: String
    let label: String
    let amount: Double

    var id: String { date }
}

struct CategoryBreakdown: Decodable, Identifiable {
    let name: String
    let value: Double

    var id: String { name }
}

struct BankTransaction: Decodable, Identifiable {
    let id: String
    let date: String
    let rawMerchant: String?
    let merchant: String
    let amount: Double
    let direction: String
    let category: String
    let subcategory: String?
    let location: String?
    let confidence: Double?
    let pending: Bool

    var detailText: String {
        var parts = [String]()

        if let subcategory, !subcategory.isEmpty {
            parts.append(subcategory)
        }

        if let location, !location.isEmpty {
            parts.append(location)
        }

        if let confidence {
            parts.append("\(Int((confidence * 100).rounded()))% confident")
        }

        return parts.isEmpty ? rawMerchant ?? "Cleaned merchant" : parts.joined(separator: " · ")
    }
}

struct LinkDestination: Identifiable {
    let url: URL

    var id: String { url.absoluteString }
}

#Preview {
    ContentView()
}
