import SafariServices
import SwiftUI

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "http://10.0.28.212:5173"
    @StateObject private var store = MoneyLoopStore()
    @State private var draftServerURL = ""
    @State private var isShowingSettings = false
    @State private var linkDestination: LinkDestination?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    balancePanel
                    miniStats
                    weekPanel
                    categoriesPanel
                    transactionsPanel
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Money Loop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await store.load(baseURL: serverURL) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload")
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        draftServerURL = serverURL
                        isShowingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .task {
                await store.load(baseURL: serverURL)
            }
            .onOpenURL { url in
                handleCallback(url)
            }
            .sheet(item: $linkDestination) { destination in
                SafariView(url: destination.url)
                    .ignoresSafeArea()
            }
            .sheet(isPresented: $isShowingSettings) {
                settingsSheet
            }
        }
    }

    private var balancePanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Last 30 days")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white.opacity(0.74))
                Spacer()
                Text("\(store.dashboard.summary.transactionCount) txns")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white.opacity(0.74))
            }

            Text(store.dashboard.summary.totalExpense, format: .currency(code: "USD"))
                .font(.system(size: 46, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.62)
                .lineLimit(1)

            Text(store.status)
                .font(.callout)
                .foregroundStyle(.white.opacity(0.78))

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
                    Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.white)
                .disabled(store.isLoading || !store.dashboard.connected)
            }
            .font(.headline)
            .controlSize(.large)
        }
        .padding(20)
        .background(Color(red: 0.06, green: 0.16, blue: 0.13))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var miniStats: some View {
        HStack(spacing: 10) {
            StatTile(title: "Income", value: store.dashboard.summary.totalIncome, tint: .teal)
            StatTile(
                title: "Net",
                value: store.dashboard.summary.totalIncome - store.dashboard.summary.totalExpense,
                tint: .indigo
            )
            SmallTextTile(title: "AI", value: "Auto", tint: .blue)
        }
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
            PanelHeader(title: "Transactions", subtitle: "Recent month only")

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

    private var settingsSheet: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    TextField("http://10.0.28.212:5173", text: $draftServerURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    Text("Use your Mac LAN IP with port 5173 on a physical iPhone. localhost only works in the iOS Simulator.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isShowingSettings = false }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        serverURL = draftServerURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        isShowingSettings = false
                        Task { await store.load(baseURL: serverURL) }
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var maxCategoryValue: Double {
        max(store.dashboard.summary.categoryBreakdown.map(\.value).max() ?? 1, 1)
    }

    private func openPlaidLink() {
        guard let encodedReturnTo = "moneyloop://plaid-success".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(serverURL)/mobile-link.html?return_to=\(encodedReturnTo)") else {
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
}

struct StatTile: View {
    let title: String
    let value: Double
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            Text(value, format: .currency(code: "USD"))
                .font(.headline.weight(.heavy))
                .foregroundStyle(tint)
                .minimumScaleFactor(0.65)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct SmallTextTile: View {
    let title: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.headline.weight(.heavy))
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
        guard let url = URL(string: baseURL + path) else {
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
    let week: WeekSummary
    let transactions: [BankTransaction]

    static let empty = Dashboard(
        connected: false,
        summary: .empty,
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
    let merchant: String
    let amount: Double
    let direction: String
    let category: String
    let pending: Bool
}

struct LinkDestination: Identifiable {
    let url: URL

    var id: String { url.absoluteString }
}

#Preview {
    ContentView()
}
