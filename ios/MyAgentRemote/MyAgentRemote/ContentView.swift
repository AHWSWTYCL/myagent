import SwiftUI

// MARK: - Color palette (Claude-inspired, adaptive light/dark)

private extension Color {
    private static func adaptive(dark: CGFloat, light: CGFloat) -> Color {
        Color(uiColor: UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(white: dark, alpha: 1)
                : UIColor(white: light, alpha: 1)
        })
    }

    static let claudeBg      = adaptive(dark: 0.08, light: 0.98)   // 主背景
    static let claudeCard    = adaptive(dark: 0.14, light: 0.90)   // 用户气泡
    static let claudeCodeBg  = adaptive(dark: 0.06, light: 0.94)   // 代码块背景
    static let claudeMuted   = adaptive(dark: 0.45, light: 0.45)   // 辅助文字
    static let claudeBorder  = adaptive(dark: 0.18, light: 0.85)   // 分割线/输入框边框
    static let claudeBarBg   = adaptive(dark: 0.10, light: 0.94)   // 状态栏/输入栏背景
    static let claudeText    = adaptive(dark: 0.90, light: 0.10)   // 主文字（气泡/正文）
    static let claudeOnCard  = adaptive(dark: 1.00, light: 0.05)   // 气泡内文字
}

// MARK: - Main view

struct ContentView: View {
    @StateObject private var client = RemoteClient()
    @State private var inputText = ""
    @FocusState private var isInputFocused: Bool
    @State private var serverURL = "http://localhost:3099"
    @State private var showingSettings = false

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            messageList
            inputBar
        }
        .background(Color.claudeBg)
        .onAppear { client.connect() }
        .onDisappear { client.disconnect() }
        .sheet(isPresented: $showingSettings) {
            SettingsSheet(serverURL: $serverURL) {
                client.reconnect(to: serverURL)
                showingSettings = false
            }
        }
    }

    // MARK: - Status bar

    private var statusBar: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(client.isConnected ? Color.green : Color.red)
                .frame(width: 6, height: 6)

            Text(client.statusText)
                .font(.caption2)
                .foregroundColor(.claudeMuted)

            Spacer()

            Button {
                showingSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.caption)
                    .foregroundColor(.claudeMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.claudeBarBg)
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if client.messages.isEmpty {
                        emptyState
                    }

                    ForEach(Array(client.messages.enumerated()), id: \.element.id) { idx, msg in
                        let prev = idx > 0 ? client.messages[idx - 1] : nil
                        MessageRow(
                            message: msg,
                            showTimestamp: shouldShowTimestamp(msg, prev: prev),
                            isConsecutive: isConsecutive(msg, prev: prev),
                            onRetry: { client.sendMessage($0) }
                        )
                    }

                    // 底部留白，避免最后一条被输入框遮挡
                    Color.clear.frame(height: 12)
                        .id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            .onChange(of: client.messages.last?.content) { _, _ in
                withAnimation {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }

    // ── Timestamp logic ──────────────────────────────────────────

    private func shouldShowTimestamp(_ msg: ChatMessage, prev: ChatMessage?) -> Bool {
        guard let prev else { return true }
        if msg.role != prev.role { return true }
        return msg.timestamp.timeIntervalSince(prev.timestamp) > 300 // 5 min
    }

    private func isConsecutive(_ msg: ChatMessage, prev: ChatMessage?) -> Bool {
        guard let prev else { return false }
        return msg.role == prev.role
            && msg.timestamp.timeIntervalSince(prev.timestamp) <= 300
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer().frame(height: 80)
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 36))
                .foregroundColor(.claudeMuted)
            Text("Send a message to start")
                .font(.body)
                .foregroundColor(.claudeMuted)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Message myagent...", text: $inputText, axis: .vertical)
                .focused($isInputFocused)
                .lineLimit(1...6)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.claudeCard)
                .cornerRadius(20)
                .foregroundColor(.claudeOnCard)
                .submitLabel(.send)
                .onSubmit { send() }

            actionButton
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.claudeBarBg)
    }

    @ViewBuilder
    private var actionButton: some View {
        if client.isGenerating {
            Button(action: { client.abort() }) {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 28))
                    .foregroundColor(.red)
            }
        } else {
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundColor(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? .claudeMuted : .claudeOnCard)
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.sendMessage(text)
        inputText = ""
    }
}

// MARK: - Settings sheet (server URL)

private struct SettingsSheet: View {
    @Binding var serverURL: String
    var onReconnect: () -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("Server URL") {
                    TextField("http://localhost:3099", text: $serverURL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                        .focused($isFocused)
                }
                Section {
                    Button("Reconnect") { onReconnect() }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Message row (avatar + content + timestamp)

private struct MessageRow: View {
    let message: ChatMessage
    let showTimestamp: Bool
    let isConsecutive: Bool
    let onRetry: (String) -> Void

    var body: some View {
        VStack(alignment: message.isUser ? .trailing : .leading, spacing: 2) {
            // Timestamp (centered, only when needed)
            if showTimestamp {
                HStack {
                    Spacer()
                    Text(formatTime(message.timestamp))
                        .font(.caption2)
                        .foregroundColor(.claudeMuted)
                    Spacer()
                }
                .padding(.top, isConsecutive ? 2 : 10)
                .padding(.bottom, 4)
            }

            HStack(alignment: .top, spacing: 8) {
                // Avatar — agent left, user right (no avatar for user)
                if message.isAgent || message.isSystem {
                    avatar
                        .padding(.top, 2)
                }

                // Content
                if message.isUser {
                    Spacer(minLength: 40)
                }

                if message.isTool {
                    ToolCallCard(message: message)
                } else {
                    MarkdownText(content: message.content, isUser: message.isUser)
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = message.content
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }

                    if let retryText = message.failedRetryText {
                        Button {
                            onRetry(retryText)
                        } label: {
                            Label("Retry", systemImage: "arrow.clockwise")
                                .font(.caption)
                        }
                        .padding(.top, 2)
                    }
                }

                if !message.isUser {
                    Spacer(minLength: 40)
                }
            }
        }
    }

    // MARK: - Avatar

    private var avatar: some View {
        let (icon, color): (String, Color) = {
            if message.isAgent { return ("sparkles", .orange) }
            return ("info.circle", .claudeMuted)
        }()

        return Image(systemName: icon)
            .font(.caption)
            .foregroundColor(color)
            .frame(width: 24, height: 24)
            .background(color.opacity(0.15))
            .clipShape(Circle())
    }

    // MARK: - Helpers

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private func formatTime(_ date: Date) -> String {
        Self.timeFormatter.string(from: date)
    }
}

// MARK: - Tool call card (collapsible)

private struct ToolCallCard: View {
    let message: ChatMessage
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if message.toolStatus == .done {
                    withAnimation { isExpanded.toggle() }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "hammer")
                        .font(.caption)
                        .foregroundColor(.blue)

                    Text(message.toolName ?? "tool")
                        .font(.footnote)
                        .foregroundColor(.claudeText)

                    Spacer()

                    if message.toolStatus == .running {
                        ProgressView()
                            .scaleEffect(0.7)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundColor(.green)
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundColor(.claudeMuted)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            if isExpanded, let output = message.toolOutput, !output.isEmpty {
                Text(output)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.claudeMuted)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Color.claudeCodeBg)
        .cornerRadius(10)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.claudeBorder, lineWidth: 0.5)
        )
        .padding(.vertical, 2)
    }
}

// MARK: - Markdown-aware text renderer

/// Renders text with basic Markdown support:
/// - Code blocks (```...```) get monospace font + dark background
/// - Regular text uses SwiftUI's built-in Markdown (bold, italic, links, inline code)
private struct MarkdownText: View {
    let content: String
    let isUser: Bool

    var body: some View {
        renderMixed(content)
    }

    @ViewBuilder
    private func renderMixed(_ text: String) -> some View {
        let segments = parseCodeBlocks(text)

        if segments.count == 1, case .regular = segments[0] {
            // No code blocks — simple path
            regularText(segments[0].content)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                    switch seg {
                    case .regular(let s):
                        regularText(s)
                    case .code(let s):
                        codeBlock(s)
                    }
                }
            }
        }
    }

    // ── Parsing ──────────────────────────────────────────────────

    private enum Segment {
        case regular(String)
        case code(String)
        var content: String {
            switch self {
            case .regular(let s): return s
            case .code(let s): return s
            }
        }
    }

    private func parseCodeBlocks(_ text: String) -> [Segment] {
        let parts = text.components(separatedBy: "```")
        var segments: [Segment] = []

        for (i, part) in parts.enumerated() {
            guard !part.isEmpty else { continue }
            if i % 2 == 0 {
                segments.append(.regular(part))
            } else {
                // Strip optional language identifier on first line
                let lines = part.split(separator: "\n", omittingEmptySubsequences: false)
                let code = lines.dropFirst().joined(separator: "\n")
                segments.append(.code(code.isEmpty ? part : code))
            }
        }

        return segments
    }

    // ── Text builders ────────────────────────────────────────────

    @ViewBuilder
    private func regularText(_ text: String) -> some View {
        let attributed = (try? AttributedString(markdown: text,
               options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
             ?? AttributedString(text)

        if isUser {
            Text(attributed)
                .foregroundColor(.claudeOnCard)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.claudeCard)
                .cornerRadius(18)
        } else {
            Text(attributed)
                .foregroundColor(.claudeText)
                .padding(.vertical, 1)
        }
    }

    @ViewBuilder
    private func codeBlock(_ code: String) -> some View {
        Text(code)
            .font(.system(.footnote, design: .monospaced))
            .foregroundColor(.claudeText)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.claudeCodeBg)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.claudeBorder, lineWidth: 0.5)
            )
    }
}

// MARK: - Preview

#Preview {
    ContentView()
}
