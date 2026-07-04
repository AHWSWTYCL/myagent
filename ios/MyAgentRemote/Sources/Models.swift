import Foundation

/// A chat message displayed in the conversation.
struct ChatMessage: Identifiable, Equatable {
    let id: String
    let role: String   // "user" | "agent" | "system" | "tool"
    let content: String
    let timestamp: Date

    init(id: String = UUID().uuidString,
         role: String,
         content: String,
         timestamp: Date = Date()) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
    }

    var isUser: Bool { role == "user" }
    var isAgent: Bool { role == "agent" }
    var isSystem: Bool { role == "system" }
    var isTool: Bool { role == "tool" }
}
