// zen-cal: prints the user's calendar events between two times as JSON, via
// EventKit. ZEN's bridge (bridge/life.mjs) compiles this once into
// ~/.string/bin/zen-cal and runs it; EventKit expands repeating events and
// knows every account (iCloud, Google, Exchange), which reading Calendar's
// database directly does not.
//
//   zen-cal <fromMs> <toMs>   events as a JSON array
//   zen-cal --status          authorization only, never asks
//
// Exit codes: 0 ok, 2 no access (stdout says "needs-access"), 1 bad usage.
import EventKit
import Foundation

let store = EKEventStore()
let args = CommandLine.arguments

func statusWord() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: return "ok"
  case .notDetermined: return "not-determined"
  default: return "needs-access" // denied, restricted, or write-only
  }
}

if args.count >= 2 && args[1] == "--status" {
  print(statusWord())
  exit(0)
}
guard args.count >= 3, let from = Double(args[1]), let to = Double(args[2]) else {
  FileHandle.standardError.write("usage: zen-cal <fromMs> <toMs> | --status\n".data(using: .utf8)!)
  exit(1)
}

// First run asks the user once (the prompt names the app that runs the
// bridge). A semaphore keeps this tool synchronous; the bridge times it out.
if statusWord() == "not-determined" {
  let done = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { _, _ in done.signal() }
  } else {
    store.requestAccess(to: .event) { _, _ in done.signal() }
  }
  _ = done.wait(timeout: .now() + 60)
}
if statusWord() != "ok" {
  print("needs-access")
  exit(2)
}

let linkPattern = try! NSRegularExpression(
  pattern: "https://(meet\\.google\\.com|[\\w.-]*zoom\\.us|teams\\.microsoft\\.com|teams\\.live\\.com|[\\w.-]*webex\\.com)/[^\\s<>\"')]+")
func callLink(_ e: EKEvent) -> String? {
  if let u = e.url?.absoluteString, !u.isEmpty { return u }
  for text in [e.location ?? "", e.notes ?? ""] {
    let r = NSRange(text.startIndex..., in: text)
    if let m = linkPattern.firstMatch(in: text, range: r), let rr = Range(m.range, in: text) {
      return String(text[rr])
    }
  }
  return nil
}

let iso = ISO8601DateFormatter()
let pred = store.predicateForEvents(
  withStart: Date(timeIntervalSince1970: from / 1000), end: Date(timeIntervalSince1970: to / 1000), calendars: nil)
var out: [[String: Any]] = []
for e in store.events(matching: pred) {
  if e.calendar.type == .birthday { continue }
  // Events the user declined are not on their day.
  if let me = e.attendees?.first(where: { $0.isCurrentUser }), me.participantStatus == .declined { continue }
  let others = (e.attendees ?? []).filter { !$0.isCurrentUser && $0.participantType != .room && $0.participantType != .resource }
  var row: [String: Any] = [
    "id": e.eventIdentifier ?? "",
    "title": e.title ?? "(no title)",
    "start": iso.string(from: e.startDate),
    "end": iso.string(from: e.endDate),
    "allDay": e.isAllDay,
    "calendar": e.calendar.title,
    "attendees": others.count,
    "people": others.compactMap { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") },
  ]
  if let l = e.location, !l.isEmpty { row["location"] = l }
  if let u = callLink(e) { row["url"] = u }
  if let n = e.notes, !n.isEmpty { row["notes"] = String(n.prefix(400)) }
  out.append(row)
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
