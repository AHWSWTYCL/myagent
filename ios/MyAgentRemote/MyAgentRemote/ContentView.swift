import SwiftUI

struct ContentView: View {
    @StateObject private var client = RemoteClient()
    @State private var inputText = ""
    @FocusState private var isInputFocused: Bool
    @State private var serverURL = "http://localhost:3099"

    var body: some View {
        VStack(spacing: 0) {
            // ── Status bar ──────────────────────────────────────
            statusBar

            // ── Message list ────────────────────────────────────
            messageList

            // ── Input bar ───────────────────────────────────────
            inputBar
        }
        .onAppear { client.connect() }
        .onDisappear { client.disconnect() }
    }

    // MARK: - Status bar

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(client.isConnected ? Color.green : Color.red)
                .frame(width: 8, height: 8)

            Text(client.statusText)
                .font(.caption)
                .foregroundColor(.secondary)

            Spacer()

            // Connection settings
            Menu {
                TextField("Server URL", text: $serverURL)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                Button("Reconnect") {
                    client.reconnect(to: serverURL)
                }
            } label: {
                Image(systemName: "gearshape")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.systemGray6))
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if client.messages.isEmpty {
                        emptyState
                    }

                    ForEach(client.messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: client.messages.count) {
                if let lastId = client.messages.last?.id {
                    withAnimation {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
            .onTapGesture {
                // Dismiss keyboard when tapping the message area
                isInputFocused = false
            }
        }
        .background(Color(.systemBackground))
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer().frame(height: 80)
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))
            Text("Connected to myagent")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Send a message to start chatting")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
            Spacer().frame(height: 40)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Type a message...", text: $inputText, axis: .vertical)
                .focused($isInputFocused)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(.systemGray6))
                .cornerRadius(20)
                .lineLimit(1...5)
                .onSubmit { send() }

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? .gray.opacity(0.3) : .blue)
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
        .overlay(
            Rectangle()
                .frame(height: 0.5)
                .foregroundColor(Color(.separator)),
            alignment: .top
        )
    }

    // MARK: - Actions

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        client.sendMessage(text)
        inputText = ""
        isInputFocused = false
    }
}

// MARK: - Message bubble

private struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.isAgent || message.isSystem || message.isTool {
                // Agent/system/tool messages: left-aligned
                avatar(for: message.role)
                bubbleContent
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                // User messages: right-aligned
                bubbleContent
                    .frame(maxWidth: .infinity, alignment: .trailing)
                avatar(for: message.role)
            }
        }
    }

    private var bubbleContent: some View {
        VStack(alignment: message.isUser ? .trailing : .leading, spacing: 2) {
            Text(message.content)
                .font(.body)
                .foregroundColor(message.isUser ? .white : .primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(bubbleColor)
                .cornerRadius(16)

            Text(formatTime(message.timestamp))
                .font(.caption2)
                .foregroundColor(.secondary)
                .padding(.horizontal, 4)
        }
    }

    private var bubbleColor: Color {
        switch message.role {
        case "user":   return .blue
        case "agent":  return Color(.systemGray5)
        case "system": return Color.orange.opacity(0.15)
        case "tool":   return Color.purple.opacity(0.15)
        default:       return Color(.systemGray5)
        }
    }

    private func avatar(for role: String) -> some View {
        let (icon, color): (String, Color) = {
            switch role {
            case "user":   return ("person.circle.fill", .blue)
            case "agent":  return ("brain.head.profile", .green)
            case "system": return ("gearshape.circle.fill", .orange)
            case "tool":   return ("wrench.circle.fill", .purple)
            default:       return ("questionmark.circle", .gray)
            }
        }()

        return Image(systemName: icon)
            .font(.title3)
            .foregroundColor(color)
            .frame(width: 28)
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private func formatTime(_ date: Date) -> String {
        Self.timeFormatter.string(from: date)
    }
}

// MARK: - Preview

#Preview {
    ContentView()
}
