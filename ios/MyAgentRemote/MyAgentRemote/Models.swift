import Foundation

/// Status of a tool call shown as a collapsible card.
enum ToolCallStatus: String, Codable {
    case running
    case done
}

/// A chat message displayed in the conversation.
struct ChatMessage: Identifiable, Equatable, Codable {
    let id: String
    let role: String   // "user" | "agent" | "system" | "tool"
    var content: String
    let timestamp: Date

    // Tool call card state (role == "tool" only)
    var toolName: String?
    var toolStatus: ToolCallStatus?
    var toolOutput: String?

    // Set on a failed send so the UI can offer a retry action.
    var failedRetryText: String?

    init(id: String = UUID().uuidString,
         role: String,
         content: String,
         timestamp: Date = Date(),
         toolName: String? = nil,
         toolStatus: ToolCallStatus? = nil,
         toolOutput: String? = nil,
         failedRetryText: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.toolName = toolName
        self.toolStatus = toolStatus
        self.toolOutput = toolOutput
        self.failedRetryText = failedRetryText
    }

    var isUser: Bool { role == "user" }
    var isAgent: Bool { role == "agent" }
    var isSystem: Bool { role == "system" }
    var isTool: Bool { role == "tool" }
}
