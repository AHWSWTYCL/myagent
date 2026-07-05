import Foundation
import Combine

/// SSE + HTTP client that connects to myagent's RemoteServer.
///
/// Usage:
///   let client = RemoteClient(baseURL: "http://localhost:3099")
///   client.connect()
///   client.sendMessage("hello")
///
/// Events arrive via `events` publisher — subscribe in your ViewModel/View.
@MainActor
final class RemoteClient: ObservableObject {
    // MARK: - Published state

    @Published private(set) var isConnected = false
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var statusText: String = "Disconnected"
    @Published private(set) var isGenerating = false

    // MARK: - Configuration

    private(set) var baseURL: String
    private var session: URLSession!       // for HTTP POST (sendMessage/abort)
    private var sseSession: URLSession?    // for SSE streaming (delegate-based)
    private var sseTask: URLSessionDataTask?
    private var sseBuffer = ""

    /// Last received SSE event id — sent as Last-Event-Id on reconnect so the
    /// server can replay from its ring buffer instead of losing history.
    private var lastEventId: Int = 0

    /// Reconnect backoff in seconds: 1 → 2 → 4 → ... → 30 max.
    private var reconnectDelay: Int = 0
    private var reconnectTimer: Timer?

    /// Maps an in-flight tool call's id to its index in `messages`, so the
    /// matching toolEnd event updates the same card instead of appending a new one.
    private var toolCallIndex: [String: Int] = [:]

    // MARK: - Persistence

    private static let persistenceURL: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("chat_history.json")
    }()

    private var saveTask: Task<Void, Never>?

    private static func loadPersistedMessages() -> [ChatMessage] {
        guard let data = try? Data(contentsOf: persistenceURL),
              let decoded = try? JSONDecoder().decode([ChatMessage].self, from: data) else {
            return []
        }
        return decoded
    }

    /// Debounced write-to-disk — avoids hammering the filesystem while text streams in.
    private func scheduleSave() {
        saveTask?.cancel()
        let snapshot = messages
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            try? data.write(to: Self.persistenceURL, options: .atomic)
            _ = self
        }
    }

    // MARK: - Init

    init(baseURL: String = "http://localhost:3099") {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        session = URLSession(configuration: config, delegate: nil, delegateQueue: nil)
        messages = Self.loadPersistedMessages()
    }

    // MARK: - Public API

    func connect() {
        guard sseTask == nil else { return }
        statusText = "Connecting..."

        guard let url = URL(string: "\(baseURL)/api/events") else {
            statusText = "Invalid URL"
            return
        }

        reconnectTimer?.invalidate()
        reconnectTimer = nil

        sseDelegate = SSEDelegate(client: self)
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        sseSession = URLSession(
            configuration: config,
            delegate: sseDelegate,
            delegateQueue: nil
        )

        // Resume from last received event after a disconnect instead of
        // silently dropping whatever the server broadcast while we were down.
        var request = URLRequest(url: url)
        request.timeoutInterval = 300
        if lastEventId > 0 {
            request.setValue("\(lastEventId)", forHTTPHeaderField: "Last-Event-Id")
        }

        sseTask = sseSession!.dataTask(with: request)
        sseTask?.resume()
    }

    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        sseTask?.cancel()
        sseTask = nil
        sseSession?.invalidateAndCancel()
        sseSession = nil
        isConnected = false
        statusText = "Disconnected"
    }

    func reconnect(to newURL: String) {
        disconnect()
        baseURL = newURL
        messages = []
        toolCallIndex = [:]
        lastEventId = 0
        reconnectDelay = 0
        connect()
    }

    func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Optimistic UI: show user message immediately
        let userMsg = ChatMessage(role: "user", content: trimmed)
        messages.append(userMsg)
        isGenerating = true
        scheduleSave()

        // POST to /api/message
        guard let url = URL(string: "\(baseURL)/api/message") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: String] = ["message": trimmed]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        statusText = "Sending..."

        session.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let ok = error == nil
                    && data != nil
                    && (try? JSONSerialization.jsonObject(with: data!) as? [String: Any])?["ok"] as? Bool == true

                if ok {
                    self.statusText = "Sent ✓"
                } else {
                    let reason = error?.localizedDescription ?? "Unexpected response"
                    let errMsg = ChatMessage(role: "system", content: "Send failed: \(reason)", failedRetryText: trimmed)
                    self.messages.append(errMsg)
                    self.statusText = "Send error"
                    self.isGenerating = false
                    self.scheduleSave()
                }
            }
        }.resume()
    }

    /// Interrupts the current turn — mirrors pressing Esc in the TUI.
    func abort() {
        guard let url = URL(string: "\(baseURL)/api/abort") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        session.dataTask(with: request) { _, _, _ in }.resume()
    }

    // MARK: - SSE via delegate-based URLSession

    private var sseDelegate: SSEDelegate?

    // MARK: - SSE event processing

    fileprivate func handleSSEData(_ chunk: String) {
        sseBuffer += chunk

        // SSE messages are separated by double newlines
        while let range = sseBuffer.range(of: "\n\n") {
            let raw = String(sseBuffer[..<range.lowerBound])
            sseBuffer = String(sseBuffer[range.upperBound...])

            // Each message is "id: N\ndata: {json}" — track id for Last-Event-Id resumption
            for line in raw.components(separatedBy: "\n") {
                if line.hasPrefix("id: "), let id = Int(line.dropFirst(4)) {
                    lastEventId = id
                    continue
                }

                guard line.hasPrefix("data: "),
                      let jsonData = line.dropFirst(6).data(using: .utf8) else { continue }

                do {
                    if let obj = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                       let type = obj["type"] as? String {
                        handleSSEEvent(type: type, data: obj["data"])
                    }
                } catch {
                    // skip malformed events
                }
            }
        }
    }

    private func handleSSEEvent(type: String, data: Any?) {
        switch type {
        case "connected":
            isConnected = true
            statusText = "Connected ✓"
            reconnectDelay = 0

        case "message":
            if let msgData = data as? [String: Any],
               let role = msgData["role"] as? String,
               let content = msgData["content"] as? String {
                // Deduplicate: skip if last message is identical
                if let last = messages.last, last.role == role && last.content == content {
                    break
                }
                messages.append(ChatMessage(role: role, content: content))
                scheduleSave()
            }

        case "status":
            if let text = data as? String {
                statusText = text
            }

        case "toolStart":
            if let toolData = data as? [String: Any],
               let callId = toolData["callId"] as? String,
               let name = toolData["name"] as? String {
                let toolMsg = ChatMessage(role: "tool", content: "", toolName: name, toolStatus: .running)
                messages.append(toolMsg)
                toolCallIndex[callId] = messages.count - 1
                scheduleSave()
            }

        case "toolEnd":
            if let toolData = data as? [String: Any],
               let callId = toolData["callId"] as? String,
               let name = toolData["name"] as? String {
                let output = toolData["output"] as? String ?? ""
                if let idx = toolCallIndex[callId], idx < messages.count {
                    messages[idx].toolStatus = .done
                    messages[idx].toolOutput = output
                } else {
                    // toolStart was missed (e.g. reconnect mid-call) — show a completed card anyway
                    messages.append(ChatMessage(role: "tool", content: "", toolName: name, toolStatus: .done, toolOutput: output))
                }
                toolCallIndex.removeValue(forKey: callId)
                scheduleSave()
            }

        case "text":
            // Streaming text delta — append to last agent message or create new
            if let delta = data as? String {
                if let last = messages.last, last.role == "agent" {
                    messages[messages.count - 1].content += delta
                } else {
                    messages.append(ChatMessage(role: "agent", content: delta))
                }
                scheduleSave()
            }

        case "turnEnd":
            isGenerating = false

        default:
            break
        }
    }

    fileprivate func handleSSEError(_ error: Error) {
        let nsError = error as NSError
        let reason: String
        if nsError.domain == NSPOSIXErrorDomain && nsError.code == 61 {
            reason = "Server not reachable"
        } else if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case -1004: reason = "Could not connect to server"
            case -1001: reason = "Request timed out"
            case -1009: reason = "No internet connection"
            default:    reason = nsError.localizedDescription
            }
        } else {
            reason = nsError.localizedDescription
        }
        isConnected = false
        sseTask = nil
        sseSession?.invalidateAndCancel()
        sseSession = nil

        // Exponential backoff: 1s → 2s → 4s → ... → 30s max
        let delay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 30)
        reconnectDelay = delay
        statusText = "Connection lost: \(reason). Reconnecting in \(delay)s..."

        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(delay), repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.connect()
            }
        }
    }
}

// MARK: - SSE Delegate

private final class SSEDelegate: NSObject, URLSessionDataDelegate {
    weak var client: RemoteClient?

    init(client: RemoteClient) {
        self.client = client
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        Task { @MainActor [weak self] in
            self?.client?.handleSSEData(text)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            // 忽略主动取消（如 reconnect 时的 disconnect）
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            Task { @MainActor [weak self] in
                self?.client?.handleSSEError(error)
            }
        }
    }
}
