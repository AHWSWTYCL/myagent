import Foundation
import Combine

/// SSE + HTTP client that connects to myagent's RemoteServer.
///
/// Features:
///   - SSE event id tracking for resumable connections
///   - Auto-reconnect on disconnect with exponential backoff (1s → 2s → 4s → ... → 30s max)
///   - `Last-Event-Id` header on reconnect to resume from last received event
///
/// Usage:
///   let client = RemoteClient(baseURL: "http://localhost:3099")
///   client.connect()
///   client.sendMessage("hello")
///
/// Events arrive via `messages` publisher — subscribe in your ViewModel/View.
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
    private var sseDelegate: SSEDelegate?
    
    /// Last received SSE event id — sent as Last-Event-Id on reconnect
    private var lastEventId: Int = 0
    
    /// Reconnect backoff: seconds to wait before next reconnect attempt
    private var reconnectDelay: Int = 0
    private var reconnectTimer: Timer?

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
        
        // Reset reconnect backoff on explicit connect
        reconnectDelay = 0

        guard let url = URL(string: "\(baseURL)/api/events") else {
            statusText = "Invalid URL"
            return
        }
        
        // Build URLRequest with Last-Event-Id header for resumption
        var request = URLRequest(url: url)
        request.timeoutInterval = 300
        if lastEventId > 0 {
            request.setValue("\(lastEventId)", forHTTPHeaderField: "Last-Event-Id")
        }

        sseDelegate = SSEDelegate(client: self)
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        sseSession = URLSession(
            configuration: config,
            delegate: sseDelegate,
            delegateQueue: nil
        )

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

    func sendMessage(_ text: String) {
        guard let url = URL(string: "\(baseURL)/api/message") else {
            statusText = "Invalid message URL"
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["message": text]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        session.dataTask(with: req) { [weak self] _, _, _ in
            // fire-and-forget — response arrives via SSE
        }.resume()
    }
    
    /// Poll /api/health to check if agent is currently processing
    func checkHealth() async throws -> (isProcessing: Bool, sseClients: Int) {
        guard let url = URL(string: "\(baseURL)/api/health") else {
            throw URLError(.badURL)
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let isProcessing = json["isProcessing"] as? Bool ?? false
        let sseClients = json["sseClients"] as? Int ?? 0
        return (isProcessing, sseClients)
    }

    // MARK: - SSE Data Handling (called from SSEDelegate)

    fileprivate func handleSSEData(_ raw: String) {
        sseBuffer += raw
        let lines = sseBuffer.components(separatedBy: "\n")
        sseBuffer = lines.last ?? ""

        for i in 0..<(lines.count - 1) {
            let line = lines[i]
            
            // Parse event id: "id: N"
            if line.hasPrefix("id: ") {
                let idStr = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                if let id = Int(idStr), id > 0 {
                    lastEventId = id
                }
                continue
            }
            
            // Parse data: "data: {...}"
            guard line.hasPrefix("data: "),
                  let jsonStart = line.firstIndex(of: "{") else { continue }
            
            let jsonStr = String(line[jsonStart...])
            guard let jsonData = jsonStr.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let type = obj["type"] as? String else { continue }
            
            switch type {
            case "connected":
                let clientId = (obj["data"] as? [String: Any])?["clientId"] as? Int ?? 0
                isConnected = true
                statusText = "Connected (#\(clientId))"
                // Reset backoff on successful connection
                reconnectDelay = 0
                
            case "status":
                if let data = obj["data"] as? [String: Any],
                   let text = data["text"] as? String {
                    statusText = text
                }
                
            case "message":
                if let data = obj["data"] as? [String: Any],
                   let role = data["role"] as? String,
                   let content = data["content"] as? String {
                    let msg = ChatMessage(
                        role: role,
                        content: content,
                        timestamp: Date()
                    )
                    messages.append(msg)
                }
                
            case "text":
                if let data = obj["data"] as? [String: Any],
                   let delta = data["delta"] as? String,
                   let lastMsg = messages.last, lastMsg.role == "assistant" {
                    // Append delta to last assistant message (streaming support)
                    let updated = ChatMessage(
                        id: lastMsg.id,
                        role: lastMsg.role,
                        content: lastMsg.content + delta,
                        timestamp: lastMsg.timestamp
                    )
                    messages[messages.count - 1] = updated
                }
                
            case "turnEnd":
                statusText = "Ready"
                
            default:
                break
            }
        }
    }

    fileprivate func handleSSEError(_ error: Error) {
        isConnected = false
        statusText = "Disconnected"
        
        // Clean up
        sseTask?.cancel()
        sseTask = nil
        sseSession?.invalidateAndCancel()
        sseSession = nil
        
        // Auto-reconnect with exponential backoff: 1s → 2s → 4s → ... → 30s max
        let delay: Int
        if reconnectDelay == 0 {
            delay = 1
        } else {
            delay = min(reconnectDelay * 2, 30)
        }
        reconnectDelay = delay
        
        statusText = "Reconnecting in \(delay)s..."
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(delay), repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.connect()
            }
        }
    }
}

// MARK: - SSE URLSessionDataDelegate

private class SSEDelegate: NSObject, URLSessionDataDelegate {
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
            Task { @MainActor [weak self] in
                self?.client?.handleSSEError(error)
            }
        }
    }
}
