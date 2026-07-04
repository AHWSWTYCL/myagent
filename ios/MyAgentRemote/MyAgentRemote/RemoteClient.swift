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

    // MARK: - Configuration

    private(set) var baseURL: String
    private var session: URLSession!       // for HTTP POST (sendMessage)
    private var sseSession: URLSession?    // for SSE streaming (delegate-based)
    private var sseTask: URLSessionDataTask?
    private var sseBuffer = ""

    // MARK: - Init

    init(baseURL: String = "http://localhost:3099") {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        session = URLSession(configuration: config, delegate: nil, delegateQueue: nil)
    }

    // MARK: - Public API

    func connect() {
        guard sseTask == nil else { return }
        statusText = "Connecting..."

        guard let url = URL(string: "\(baseURL)/api/events") else {
            statusText = "Invalid URL"
            return
        }

        sseDelegate = SSEDelegate(client: self)
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        sseSession = URLSession(
            configuration: config,
            delegate: sseDelegate,
            delegateQueue: nil
        )

        sseTask = sseSession!.dataTask(with: url)
        sseTask?.resume()
    }

    func disconnect() {
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
        connect()
    }

    func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Optimistic UI: show user message immediately
        let userMsg = ChatMessage(role: "user", content: trimmed)
        messages.append(userMsg)

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
                if let error = error {
                    let errMsg = ChatMessage(role: "system", content: "Send failed: \(error.localizedDescription)")
                    self?.messages.append(errMsg)
                    self?.statusText = "Send error"
                } else if let data = data,
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          json["ok"] as? Bool == true {
                    self?.statusText = "Sent ✓"
                } else {
                    self?.statusText = "Unexpected response"
                }
            }
        }.resume()
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

            // Parse "data: {json}" lines
            for line in raw.components(separatedBy: "\n") {
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

        case "message":
            if let msgData = data as? [String: Any],
               let role = msgData["role"] as? String,
               let content = msgData["content"] as? String {
                // Deduplicate: skip if last message is identical
                if let last = messages.last, last.role == role && last.content == content {
                    break
                }
                messages.append(ChatMessage(role: role, content: content))
            }

        case "status":
            if let text = data as? String {
                statusText = text
            }

        case "toolStart":
            if let toolData = data as? [String: Any],
               let name = toolData["name"] as? String {
                let toolMsg = ChatMessage(role: "tool", content: "🔧 Calling \(name)...")
                messages.append(toolMsg)
            }

        case "toolEnd":
            if let toolData = data as? [String: Any],
               let name = toolData["name"] as? String {
                let output = toolData["output"] as? String ?? ""
                let preview = String(output.prefix(200))
                let toolMsg = ChatMessage(role: "tool", content: "✅ \(name): \(preview)\(output.count > 200 ? "..." : "")")
                messages.append(toolMsg)
            }

        case "text":
            // Streaming text delta — append to last agent message or create new
            if let delta = data as? String {
                if let last = messages.last, last.role == "agent" {
                    messages[messages.count - 1] = ChatMessage(
                        id: last.id, role: "agent", content: last.content + delta
                    )
                } else {
                    messages.append(ChatMessage(role: "agent", content: delta))
                }
            }

        case "turnEnd":
            // Mark turn end — could add separator
            break

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
        statusText = "Connection lost: \(reason)"
        isConnected = false
        // Auto-reconnect after 2 seconds (demo)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            self?.connect()
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
