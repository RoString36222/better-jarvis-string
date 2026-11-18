import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { clean } from './sanitize.mjs'

/**
 * Reading the user's day off the Mac: calendar, texts, missed calls, mail and
 * contacts. Read-only, always — nothing here changes or sends anything.
 *
 * Most of this lives in Apple's own SQLite files, which macOS guards with Full
 * Disk Access. Without it the files still exist but will not open, so every
 * reader tells "no permission" apart from "not on this Mac" and throws
 * NeedsAccess with words the assistant can say aloud. Callers that run in the
 * background (bridge/chief.mjs) catch it and carry on with what they can see.
 *
 * Text written by other people (messages, mail, invites) comes back already
 * through clean() from bridge/sanitize.mjs; it is still untrusted.
 *
 * Mail is read through AppleScript instead: Mail's own database moves between
 * versions, and asking Mail needs only the Automation permission.
 *
 * Every path can be pointed elsewhere with an environment variable, so the
 * readers can be tried on small test databases:
 *   ZEN_MESSAGES_DB, ZEN_CALLS_DB, ZEN_CALENDAR_DB, ZEN_CONTACTS_DB (a list
 *   separated by ':'), ZEN_CAL_BIN ('off' skips EventKit), ZEN_MAIL ('off').
 */

const HOME = homedir()
const STATE = process.env.ZEN_STATE_DIR || join(HOME, '.string')
const env = (k, d) => process.env[k] || d

const PATHS = {
  messages: () => env('ZEN_MESSAGES_DB', join(HOME, 'Library/Messages/chat.db')),
  calls: () => env('ZEN_CALLS_DB', join(HOME, 'Library/Application Support/CallHistoryDB/CallHistory.storedata')),
  calendar: () => env('ZEN_CALENDAR_DB', join(HOME, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb')),
}

/** Seconds between 1970 and 2001, where Apple's clocks start. */
const APPLE_EPOCH = 978307200

// ------------------------------------------------------------------ access

const HOW = {
  fda: 'System Settings → Privacy & Security → Full Disk Access → add it and switch it on, then restart ZEN.',
  calendar: 'System Settings → Privacy & Security → Calendars (or Full Disk Access) → allow it, then restart ZEN.',
  mail:
    'Open Mail, then System Settings → Privacy & Security → Automation → under Terminal (or kitty) ' +
    'switch on Mail. ZEN asks for this the first time it reads Mail.',
}

const NAMES = { messages: 'your Messages', calls: 'your call history', calendar: 'your calendar', contacts: 'your contacts', mail: 'Mail' }

/** The one error a reader throws for "macOS said no". `how` says how to fix it. */
export class NeedsAccess extends Error {
  constructor(source) {
    const how = source === 'calendar' ? HOW.calendar : source === 'mail' ? HOW.mail : HOW.fda
    const what =
      source === 'mail'
        ? 'ZEN needs permission to read Mail.'
        : source === 'calendar'
          ? 'ZEN needs Calendar access or Full Disk Access for the app that runs the bridge (Terminal/kitty) to read your calendar.'
          : `ZEN needs Full Disk Access for the app that runs the bridge (Terminal/kitty) to read ${NAMES[source] ?? source}.`
    super(`${what} ${how}`)
    this.name = 'NeedsAccess'
    this.source = source
    this.how = how
  }
}

/**
 * Opens one of Apple's databases read-only. A file that exists but will not
 * open (SQLite's "unable to open", or EPERM on its folder) is a permission
 * problem; a missing file just means this Mac has no such data.
 */
function openDb(source, file) {
  let exists = false
  try {
    statSync(file)
    exists = true
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') throw new NeedsAccess(source)
  }
  if (!exists) throw new Error(`Can't find the ${source} database on this Mac (${file}).`)
  try {
    const d = new DatabaseSync(file, { readOnly: true })
    // Opening is lazy on some systems: touch the schema so a denial shows now.
    d.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
    return d
  } catch (err) {
    const denied = err?.errcode === 14 || err?.errcode === 23 || /unable to open|authori[sz]ation denied|not authorized/i.test(err?.message ?? '')
    if (denied) throw new NeedsAccess(source)
    throw err
  }
}

/** Runs fn with an open database and always closes it. */
function withDb(source, file, fn) {
  const d = openDb(source, file)
  try {
    return fn(d)
  } finally {
    d.close()
  }
}

/** The columns a table has, so readers survive small schema changes between macOS versions. */
const columns = (d, table) => new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))

const osa = (script, args = [], timeout = 8000) =>
  new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout }, (err, out, stderr) => {
      if (err?.killed) return reject(new Error(`no answer within ${Math.round(timeout / 1000)}s`))
      if (err) return reject(new Error(String(stderr || err.message).trim()))
      resolve(String(out))
    })
  })

// --------------------------------------------------------------- contacts

/** Phone numbers are matched on their last 10 digits, so +91 98…, 098… and 98… are one person. */
export const phoneKey = (s) => String(s ?? '').replace(/\D/g, '').slice(-10)

function contactFiles() {
  if (process.env.ZEN_CONTACTS_DB) return process.env.ZEN_CONTACTS_DB.split(':').filter(Boolean)
  const base = join(HOME, 'Library/Application Support/AddressBook')
  const out = [join(base, 'AddressBook-v22.abcddb')]
  try {
    for (const src of readdirSync(join(base, 'Sources'))) out.push(join(base, 'Sources', src, 'AddressBook-v22.abcddb'))
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') throw new NeedsAccess('contacts')
  }
  return out.filter((f) => existsSync(f))
}

/**
 * The address book, loaded once and kept ten minutes: people with their
 * phones and emails, plus quick maps from a phone or an email to a name.
 */
let book = null
function loadBook() {
  if (book && Date.now() - book.at < 10 * 60_000) return book
  const files = contactFiles()
  if (!files.length) throw new Error('No contacts database on this Mac.')
  const people = new Map()
  for (const file of files) {
    withDb('contacts', file, (d) => {
      const nameOf = (r) => [r.f, r.l].filter(Boolean).join(' ').trim() || r.o || r.n || ''
      const person = (r) => {
        const key = `${file}#${r.pk}`
        if (!people.has(key)) people.set(key, { name: nameOf(r), phones: [], emails: [] })
        return people.get(key)
      }
      const rec = 'r.Z_PK pk, r.ZFIRSTNAME f, r.ZLASTNAME l, r.ZORGANIZATION o, r.ZNICKNAME n'
      for (const r of d.prepare(`SELECT ${rec}, p.ZFULLNUMBER v FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`).all()) {
        if (r.v) person(r).phones.push(String(r.v))
      }
      for (const r of d.prepare(`SELECT ${rec}, e.ZADDRESS v FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`).all()) {
        if (r.v) person(r).emails.push(String(r.v))
      }
    })
  }
  const byPhone = new Map()
  const byEmail = new Map()
  const list = [...people.values()].filter((p) => p.name)
  for (const p of list) {
    for (const ph of p.phones) if (phoneKey(ph).length >= 7) byPhone.set(phoneKey(ph), p.name)
    for (const em of p.emails) byEmail.set(em.toLowerCase(), p.name)
  }
  book = { at: Date.now(), list, byPhone, byEmail }
  return book
}

/**
 * The saved name for a phone number or email, or null. Never throws: with no
 * access to contacts a handle simply has no name.
 */
export function contactName(handle) {
  if (!handle) return null
  try {
    const b = loadBook()
    const h = String(handle).trim()
    return h.includes('@') ? (b.byEmail.get(h.toLowerCase()) ?? null) : (b.byPhone.get(phoneKey(h)) ?? null)
  } catch {
    return null
  }
}

/** People whose name contains every word of `query`. Throws NeedsAccess like the other readers. */
export function findContact(query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return loadBook()
    .list.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
    .slice(0, 8)
    .map((p) => ({ name: p.name, phones: [...new Set(p.phones)], emails: [...new Set(p.emails)] }))
}

// --------------------------------------------------------------- messages

/**
 * Newer macOS often leaves `text` empty and keeps the words in
 * attributedBody, an archived NSAttributedString. The string sits right after
 * the "NSString" class name: skip five bytes of class info, read a length
 * (one byte, or 0x81 + two bytes, or 0x82 + three bytes), then that many bytes.
 */
export function decodeAttributed(blob) {
  if (!blob) return ''
  const b = Buffer.from(blob)
  const i = b.indexOf('NSString')
  if (i < 0) return ''
  let p = i + 'NSString'.length + 5
  let len = b[p]
  p += 1
  if (len === 0x81) {
    len = b.readUInt16LE(p)
    p += 2
  } else if (len === 0x82) {
    len = b.readUIntLE(p, 3)
    p += 3
  }
  return b.subarray(p, p + len).toString('utf8')
}

/**
 * iMessages and texts (SMS arrive here through iPhone Text Message
 * Forwarding) since a time, oldest first. Includes the user's own messages
 * (fromMe), which is how "who is still waiting on me" and promise spotting
 * work. Tapbacks and other reactions are left out.
 *
 * @returns {{ id: number, at: number, text: string, fromMe: boolean, handle: string|null, name: string|null,
 *   service: string, chat: string, chatName: string, isGroup: boolean }[]}
 */
export function messages(sinceMs, limit = 500) {
  return withDb('messages', PATHS.messages(), (d) => {
    const mcols = columns(d, 'message')
    // message.date is nanoseconds since 2001 on modern macOS (seconds on old
    // ones); converting in SQL keeps it inside a JS number.
    const ms2001 = 'CASE WHEN m.date > 1000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END'
    const since = sinceMs - APPLE_EPOCH * 1000
    const rows = d
      .prepare(
        `SELECT m.ROWID id, m.text, m.attributedBody ab, ${ms2001} t, m.is_from_me me, m.service,
           ${mcols.has('cache_has_attachments') ? 'm.cache_has_attachments' : '0'} att,
           h.id handle, c.chat_identifier chat, c.display_name chat_name, c.style style
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE ${ms2001} > ?
           ${mcols.has('associated_message_type') ? 'AND coalesce(m.associated_message_type, 0) = 0' : ''}
           ${mcols.has('item_type') ? 'AND coalesce(m.item_type, 0) = 0' : ''}
         ORDER BY t LIMIT ?`,
      )
      .all(since, limit)
    const out = []
    for (const r of rows) {
      const raw = r.text || decodeAttributed(r.ab) || ''
      const text = clean(raw, 4000) || (r.att ? '[attachment]' : '')
      if (!text) continue
      // style 43 = group chat, 45 = one to one.
      const isGroup = r.style === 43
      const name = r.handle ? contactName(r.handle) : null
      out.push({
        id: Number(r.id),
        at: Number(r.t) + APPLE_EPOCH * 1000,
        text,
        raw: raw.slice(0, 4000),
        fromMe: !!r.me,
        handle: r.handle ?? null,
        name,
        service: r.service || 'iMessage',
        chat: r.chat || r.handle || `msg${r.id}`,
        chatName: clean((isGroup ? r.chat_name : null) || name || r.chat_name || r.handle || 'Unknown', 80),
        isGroup,
      })
    }
    return out
  })
}

/**
 * The user's own latest messages in their one-to-one chat with a phone
 * number or address, oldest first: how they write to this person (language,
 * length, emoji), so a drafted reply sounds like them.
 * @returns {{ at: number, text: string }[]}
 */
export function sentTo(handle, limit = 10) {
  const h = String(handle ?? '').trim()
  if (!h) return []
  return withDb('messages', PATHS.messages(), (d) => {
    const key = h.includes('@') ? h.toLowerCase() : phoneKey(h)
    const ids = d
      .prepare('SELECT ROWID id, id handle FROM handle')
      .all()
      .filter((r) => (h.includes('@') ? String(r.handle).toLowerCase() === key : phoneKey(r.handle) === key && key.length >= 7))
      .map((r) => Number(r.id))
    if (!ids.length) return []
    const ms2001 = 'CASE WHEN m.date > 1000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END'
    const rows = d
      .prepare(
        `SELECT m.text, m.attributedBody ab, ${ms2001} t FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
         WHERE m.is_from_me = 1 AND coalesce(c.style, 45) != 43 AND chj.handle_id IN (${ids.map(() => '?').join(',')})
         ORDER BY t DESC LIMIT ?`,
      )
      .all(...ids, limit * 2)
    return rows
      .map((r) => ({ at: Number(r.t) + APPLE_EPOCH * 1000, text: clean(r.text || decodeAttributed(r.ab), 300) }))
      .filter((r) => r.text)
      .slice(0, limit)
      .reverse()
  })
}

// ------------------------------------------------------------ missed calls

/**
 * Missed incoming calls since a time (phone, FaceTime and WhatsApp calls the
 * iPhone shares with the Mac), oldest first, with how many times the same
 * number rang unanswered in the 30 minutes before — two or more reads as urgent.
 */
export function missedCalls(sinceMs) {
  return withDb('calls', PATHS.calls(), (d) => {
    const since = sinceMs / 1000 - APPLE_EPOCH
    const rows = d
      .prepare(
        `SELECT Z_PK pk, ZDATE date, ZADDRESS addr, ZNAME name, ZSERVICE_PROVIDER svc FROM ZCALLRECORD
         WHERE coalesce(ZANSWERED, 0) = 0 AND coalesce(ZORIGINATED, 0) = 0 AND ZDATE > ? ORDER BY ZDATE`,
      )
      .all(since)
    const repeats = d.prepare(
      `SELECT count(*) c FROM ZCALLRECORD WHERE ZADDRESS = ? AND coalesce(ZANSWERED, 0) = 0
         AND coalesce(ZORIGINATED, 0) = 0 AND ZDATE BETWEEN ? AND ?`,
    )
    return rows.map((r) => {
      const saved = contactName(r.addr)
      const via = /whatsapp/i.test(r.svc || '') ? 'WhatsApp' : /facetime/i.test(r.svc || '') ? 'FaceTime' : 'phone'
      return {
        id: Number(r.pk),
        at: Math.round((Number(r.date) + APPLE_EPOCH) * 1000),
        handle: r.addr ?? null,
        name: saved || r.name || null,
        saved: !!saved,
        via,
        repeated: r.addr ? Number(repeats.get(r.addr, r.date - 1800, r.date).c) : 1,
      }
    })
  })
}

// --------------------------------------------------------------- calendar

/**
 * Calendar events overlapping [fromMs, toMs], soonest first:
 * { id, title, start, end (ms), allDay, location, calendar, attendees (other
 * people, a count), people (their names), url (a call link if there is one),
 * notes, source }.
 *
 * EventKit first, through a small Swift program (bridge/swift/calendar.swift)
 * compiled once into ~/.string/bin/zen-cal: it sees every account and expands
 * repeating events properly. If that cannot run or has no permission,
 * Calendar's own database is read instead (needs Full Disk Access). Answers
 * are kept for a minute; the agenda and the background loop ask often.
 */
const calCache = new Map()
export async function calendar(fromMs, toMs) {
  const key = `${fromMs}|${toMs}`
  const hit = calCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.events
  let events = null
  let ekDenied = false
  try {
    events = await eventKit(fromMs, toMs)
  } catch (err) {
    ekDenied = err instanceof NeedsAccess
  }
  if (!events) {
    try {
      events = calendarDb(fromMs, toMs)
    } catch (err) {
      // Either way the fix is one of the two permissions; say both.
      if (err instanceof NeedsAccess || ekDenied) throw new NeedsAccess('calendar')
      throw err
    }
  }
  events.sort((a, b) => a.start - b.start)
  if (calCache.size > 50) calCache.clear()
  calCache.set(key, { at: Date.now(), events })
  return events
}

const CAL_SRC = fileURLToPath(new URL('./swift/calendar.swift', import.meta.url))
const CAL_PLIST = fileURLToPath(new URL('./swift/Info.plist', import.meta.url))
const calBin = () => env('ZEN_CAL_BIN', join(STATE, 'bin', 'zen-cal'))

/**
 * Builds zen-cal the first time it is needed (a few seconds with swiftc).
 * The Info.plist is linked into the binary: macOS refuses to ask for calendar
 * permission on behalf of a program that does not say why it wants it.
 */
let building = null
function ensureCalBin() {
  const bin = calBin()
  if (bin === 'off') return Promise.resolve(null)
  if (existsSync(bin)) return Promise.resolve(bin)
  building ??= new Promise((resolve) => {
    mkdirSync(dirname(bin), { recursive: true })
    execFile(
      'swiftc',
      ['-O', '-o', bin, CAL_SRC, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', CAL_PLIST],
      { timeout: 120_000 },
      (err, _out, stderr) => {
        if (err) console.warn('[life] could not build zen-cal, using the Calendar database instead:', String(stderr || err.message).trim().slice(0, 200))
        resolve(err ? null : bin)
      },
    )
  })
  return building
}

function runCal(args, timeout) {
  return ensureCalBin().then(
    (bin) =>
      new Promise((resolve, reject) => {
        if (!bin) return reject(new Error('zen-cal is not available'))
        execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
          if (String(out).trim() === 'needs-access') return reject(new NeedsAccess('calendar'))
          if (err) return reject(err)
          resolve(String(out))
        })
      }),
  )
}

async function eventKit(fromMs, toMs) {
  // The first run may show macOS's permission prompt and wait for an answer.
  const out = await runCal([String(Math.round(fromMs)), String(Math.round(toMs))], 75_000)
  const rows = JSON.parse(out)
  return rows.map((e) => ({
    id: e.id,
    title: clean(e.title, 200) || '(no title)',
    start: Date.parse(e.start),
    end: Date.parse(e.end),
    allDay: !!e.allDay,
    location: e.location ? clean(e.location, 200) : null,
    calendar: e.calendar ?? null,
    attendees: Number(e.attendees) || 0,
    people: (e.people ?? []).map((p) => clean(p, 80)).filter(Boolean),
    url: e.url ?? null,
    notes: e.notes ? clean(e.notes, 400) : null,
    source: 'eventkit',
  }))
}

/** 'ok' | 'not-determined' | 'needs-access' | 'unavailable' — never shows a prompt. */
export const eventKitStatus = () => runCal(['--status'], 10_000).then((s) => s.trim(), () => 'unavailable')

const CALL_LINK = /https:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|[\w.-]*webex\.com)\/[^\s<>"')]+/

/**
 * The fallback: Calendar's database. One-off events are rows; repeating ones
 * are one row plus a Recurrence rule, expanded here for the common shapes
 * (every N days, weeks — on listed weekdays —, months or years), skipping
 * deleted dates and occurrences that were moved (those are their own rows).
 */
function calendarDb(fromMs, toMs) {
  return withDb('calendar', PATHS.calendar(), (d) => {
    const ic = columns(d, 'CalendarItem')
    const col = (c) => (ic.has(c) ? `i.${c}` : 'NULL')
    // All-day events are stored at UTC midnight, so the window is widened a
    // day each way and trimmed once their real local times are known.
    const a = fromMs / 1000 - APPLE_EPOCH - 86400
    const b = toMs / 1000 - APPLE_EPOCH + 86400
    const select = `SELECT i.ROWID id, i.summary title, i.start_date s, i.end_date e, coalesce(i.all_day, 0) all_day,
        c.title calendar, l.title location, ${col('description')} notes, ${col('url')} url,
        ${col('conference_url')} conf, ${col('has_recurrences')} rec, ${col('orig_item_id')} orig, ${col('status')} status
      FROM CalendarItem i JOIN Calendar c ON c.ROWID = i.calendar_id LEFT JOIN Location l ON l.ROWID = i.location_id
      WHERE coalesce(i.entity_type, 2) = 2 AND c.title NOT LIKE '%Birthday%'`
    const hasRec = ic.has('has_recurrences') && d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'Recurrence'").get()
    const once = d.prepare(`${select} ${hasRec ? 'AND coalesce(i.has_recurrences, 0) = 0' : ''} AND i.start_date < ? AND i.end_date > ?`).all(b, a)
    const out = once.map((r) => ({ r, s: r.s, e: r.e }))

    if (hasRec) {
      const moved = new Set(
        ic.has('orig_item_id')
          ? d.prepare('SELECT orig_item_id o, orig_date od FROM CalendarItem WHERE orig_item_id > 0').all().map((x) => `${x.o}:${Math.round(x.od)}`)
          : [],
      )
      const hasEx = !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ExceptionDate'").get()
      const rules = d
        .prepare(
          `${select.replace('WHERE', 'JOIN Recurrence rc ON rc.owner_id = i.ROWID WHERE')} AND i.has_recurrences = 1 AND i.start_date < ?`,
        )
        .all(b)
      const ruleOf = d.prepare('SELECT frequency f, interval n, count cnt, end_date until, specifier spec FROM Recurrence WHERE owner_id = ?')
      const exOf = hasEx ? d.prepare('SELECT date FROM ExceptionDate WHERE owner_id = ?') : null
      for (const r of rules) {
        const rule = ruleOf.get(r.id)
        if (!rule) continue
        const skip = new Set((exOf?.all(r.id) ?? []).map((x) => Math.round(x.date)))
        for (const s of occurrences(r.s, rule, a, b, r.e - r.s)) {
          if (skip.has(Math.round(s)) || moved.has(`${r.id}:${Math.round(s)}`)) continue
          out.push({ r, s, e: s + (r.e - r.s) })
        }
      }
    }

    const pcols = d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'Participant'").get() ? columns(d, 'Participant') : null
    const hasIdentity = pcols && !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'Identity'").get()
    const people = pcols
      ? d.prepare(
          `SELECT p.email${hasIdentity ? ', n.display_name name' : ', NULL name'} FROM Participant p
           ${hasIdentity && pcols.has('identity_id') ? 'LEFT JOIN Identity n ON n.ROWID = p.identity_id' : ''}
           WHERE p.owner_id = ? ${pcols.has('is_self') ? 'AND coalesce(p.is_self, 0) = 0' : ''}`,
        )
      : null

    return out
      .filter(({ r }) => r.status !== 3) // 3 = cancelled
      .map(({ r, s, e }) => {
        const who = people ? people.all(r.id).filter((p) => !/resource\.calendar\.google\.com|^c_[a-z0-9]+@group\.calendar/.test(p.email || '')) : []
        const allDay = !!r.all_day
        return {
          id: `${r.id}:${Math.round(s)}`,
          title: clean(r.title, 200) || '(no title)',
          start: allDay ? floatingDay(s) : (s + APPLE_EPOCH) * 1000,
          end: allDay ? floatingDay(e) : (e + APPLE_EPOCH) * 1000,
          allDay,
          location: r.location ? clean(r.location, 200) : null,
          calendar: r.calendar || null,
          attendees: who.length,
          people: who.map((p) => clean(p.name || (p.email || '').split('@')[0], 80)).filter(Boolean),
          url: r.conf || r.url || CALL_LINK.exec(`${r.location || ''} ${r.notes || ''}`)?.[0] || null,
          notes: r.notes ? clean(r.notes, 400) : null,
          source: 'sqlite',
        }
      })
      .filter((e) => e.end > fromMs && e.start < toMs)
  })
}

/** All-day events are stored as a UTC midnight; the day they mean is that date here. */
function floatingDay(s2001) {
  const u = new Date((s2001 + APPLE_EPOCH) * 1000)
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime()
}

const DAYCODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

/** Start times (seconds since 2001) of a repeating event inside [a, b], walking local wall-clock time so DST is right. */
function occurrences(first, rule, a, b, dur) {
  const out = []
  const step = Math.max(1, Number(rule.n) || 1)
  const until = rule.until ? Number(rule.until) : Infinity
  const max = Number(rule.cnt) || Infinity
  const toS = (dt) => dt.getTime() / 1000 - APPLE_EPOCH
  const start = new Date((first + APPLE_EPOCH) * 1000)
  // Weekly rules may name several weekdays: "D=0MO,0WE,0FR".
  const days = rule.f === 2 && rule.spec ? [...String(rule.spec).matchAll(/\d?([A-Z]{2})/g)].map((m) => DAYCODE[m[1]]).filter((x) => x !== undefined) : []
  let n = 0
  for (let k = 0; k < 5000; k++) {
    const base = new Date(start)
    if (rule.f === 1) base.setDate(base.getDate() + k * step)
    else if (rule.f === 2) base.setDate(base.getDate() + k * 7 * step)
    else if (rule.f === 3) base.setMonth(base.getMonth() + k * step)
    else if (rule.f === 4) base.setFullYear(base.getFullYear() + k * step)
    else break
    let batch = [base]
    if (days.length) {
      const sunday = new Date(base)
      sunday.setDate(base.getDate() - base.getDay())
      batch = days
        .map((wd) => {
          const x = new Date(sunday)
          x.setDate(sunday.getDate() + wd)
          return x
        })
        .filter((x) => x >= start)
        .sort((p, q) => p - q)
    }
    for (const dt of batch) {
      const s = toS(dt)
      if (s > until || n >= max || s >= b) return out
      n++
      if (s + dur > a) out.push(s)
    }
  }
  return out
}

// ------------------------------------------------------------------- mail

const SEP = String.fromCharCode(31)
const ROW = String.fromCharCode(30)

/**
 * Recent messages in Mail's inbox since a time, newest first: { id, at,
 * from, fromName, subject, read, snippet }. Asks Mail itself, so it needs the
 * Automation permission, not Full Disk Access. Mail is never launched for
 * this: if it is closed, there is nothing new to read. Gives up after 8s.
 */
export async function mail(sinceMs, limit = 20) {
  if (process.env.ZEN_MAIL === 'off') return []
  const running = await osa('application "Mail" is running', [], 4000).catch(() => 'false')
  if (running.trim() !== 'true') return []
  const secs = Math.max(60, Math.round((Date.now() - sinceMs) / 1000))
  const script = `on run argv
  set cutoff to (current date) - (item 1 of argv as integer)
  set maxN to item 2 of argv as integer
  set us to ASCII character 31
  set rs to ASCII character 30
  set out to ""
  tell application "Mail"
    set msgs to (messages of inbox whose date received > cutoff)
    set n to 0
    repeat with m in msgs
      set n to n + 1
      if n > maxN then exit repeat
      set snip to ""
      try
        set snip to text 1 thru 200 of (content of m)
      on error
        try
          set snip to content of m
        end try
      end try
      set out to out & (id of m) & us & ((date received of m) as «class isot» as string) & us & (sender of m) & us & (subject of m) & us & (read status of m) & us & snip & rs
    end repeat
  end tell
  return out
end run`
  let out
  try {
    out = await osa(script, [String(secs), String(limit)], 8000)
  } catch (err) {
    if (/-1743|not authori[sz]ed|not allowed/i.test(err.message)) throw new NeedsAccess('mail')
    throw new Error(`Mail did not answer: ${err.message}`)
  }
  return out
    .split(ROW)
    .map((r) => r.split(SEP))
    .filter((f) => f.length >= 6 && f[0].trim())
    .map(([id, date, sender, subject, read, ...rest]) => {
      const m = /^(.*?)\s*<([^>]+)>$/.exec(sender.trim())
      return {
        id: id.trim(),
        // «class isot» is local wall-clock time without a zone; Date reads it as local.
        at: Date.parse(date.trim()) || Date.now(),
        from: (m ? m[2] : sender).trim(),
        fromName: clean(m ? m[1].replace(/^"|"$/g, '') : '', 80) || null,
        subject: clean(subject, 200) || '(no subject)',
        read: read.trim() === 'true',
        snippet: clean(rest.join(' ').replace(/\s+/g, ' '), 200),
      }
    })
    .sort((a, b) => b.at - a.at)
}

/**
 * The whole text of one mail, by the id mail() gave. Only for the few
 * messages that already look worth it (a flight booking, say): asking Mail
 * for every body would be slow, and most mail is not read this closely.
 * Cleaned like everything else other people wrote; still untrusted. 8s, then
 * it gives up.
 */
export async function mailBody(id, max = 8000) {
  if (process.env.ZEN_MAIL === 'off') return ''
  if (!/^\d+$/.test(String(id ?? '').trim())) throw new Error('Not a Mail message id.')
  const script = `on run argv
  tell application "Mail"
    set m to first message of inbox whose id is (item 1 of argv as integer)
    return content of m
  end tell
end run`
  try {
    return clean(await osa(script, [String(id).trim()], 8000), max)
  } catch (err) {
    if (/-1743|not authori[sz]ed|not allowed/i.test(err.message)) throw new NeedsAccess('mail')
    throw new Error(`Mail did not answer: ${err.message}`)
  }
}

const mailErr = (err) =>
  /-1743|not authori[sz]ed|not allowed/i.test(err.message) ? new NeedsAccess('mail') : new Error(`Mail did not answer: ${err.message}`)

/** Splits "Name <a@b.c>" into its parts; a bare address has no name. */
function splitSender(s) {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(String(s ?? '').trim())
  return { address: (m ? m[2] : String(s ?? '')).trim(), name: clean(m ? m[1].replace(/^"|"$/g, '') : '', 80) || null }
}

/**
 * One inbox message in enough detail to reply to it: who sent it, who else
 * it went to (for reply all), its subject and date, and its text (to quote
 * if Mail leaves the reply empty). By the id mail() gives. Untrusted, like
 * every word someone else wrote.
 */
export async function mailMessage(id) {
  if (!/^\d+$/.test(String(id ?? '').trim())) throw new Error('Not a Mail message id.')
  const script = `on run argv
  set us to ASCII character 31
  set rs to ASCII character 30
  tell application "Mail"
    set m to first message of inbox whose id is (item 1 of argv as integer)
    set tos to ""
    repeat with r in to recipients of m
      set tos to tos & (address of r) & us
    end repeat
    set ccs to ""
    repeat with r in cc recipients of m
      set ccs to ccs & (address of r) & us
    end repeat
    set body to ""
    try
      set body to content of m
    end try
    return (id of m as string) & rs & (sender of m) & rs & (subject of m) & rs & ((date received of m) as string) & rs & tos & rs & ccs & rs & body
  end tell
end run`
  let out
  try {
    out = await osa(script, [String(id).trim()], 10_000)
  } catch (err) {
    if (/-1728|can.t get/i.test(err.message)) throw new Error('That message is no longer in the inbox.')
    throw mailErr(err)
  }
  const [mid, sender, subject, date, tos, ccs, ...rest] = out.replace(/\n$/, '').split(ROW)
  const list = (s) => String(s ?? '').split(SEP).map((a) => a.trim()).filter(Boolean)
  const from = splitSender(sender)
  return {
    id: mid.trim(),
    from: from.address,
    fromName: from.name,
    subject: clean(subject, 200) || '(no subject)',
    date: String(date ?? '').trim(),
    to: list(tos),
    cc: list(ccs),
    body: rest.join(ROW).slice(0, 20_000),
  }
}

/**
 * Inbox headers only (no bodies, so it stays quick) for the last `days`:
 * { id, at, from, fromName, subject }, newest first. Used to find "the mail
 * from Rahul about the invoice" when the user wants to reply to it.
 */
export async function mailHeaders(days = 30, limit = 400) {
  const script = `on run argv
  set cutoff to (current date) - ((item 1 of argv as integer) * days)
  set maxN to item 2 of argv as integer
  set us to ASCII character 31
  set rs to ASCII character 30
  set out to ""
  tell application "Mail"
    set msgs to (messages of inbox whose date received > cutoff)
    set n to 0
    repeat with m in msgs
      set n to n + 1
      if n > maxN then exit repeat
      set out to out & (id of m) & us & ((date received of m) as «class isot» as string) & us & (sender of m) & us & (subject of m) & rs
    end repeat
  end tell
  return out
end run`
  let out
  try {
    out = await osa(script, [String(days), String(limit)], 20_000)
  } catch (err) {
    throw mailErr(err)
  }
  return out
    .split(ROW)
    .map((r) => r.split(SEP))
    .filter((f) => f.length >= 4 && f[0].trim())
    .map(([id, date, sender, ...subject]) => {
      const s = splitSender(sender)
      return { id: id.trim(), at: Date.parse(date.trim()) || 0, from: s.address, fromName: s.name, subject: clean(subject.join(' '), 200) || '(no subject)' }
    })
    .sort((a, b) => b.at - a.at)
}

/**
 * The user's Mail accounts and the addresses each can send from:
 * [{ name, addresses }]. Account names are the user's own labels ("Work",
 * "iCloud"), which is what "send it from my work account" matches against.
 */
export async function mailAccounts() {
  const script = `set us to ASCII character 31
set rs to ASCII character 30
set out to ""
tell application "Mail"
  set names to name of every account
  set addrLists to email addresses of every account
end tell
repeat with i from 1 to count of names
  set addrs to ""
  repeat with e in item i of addrLists
    set addrs to addrs & (contents of e) & us
  end repeat
  set out to out & (item i of names) & us & addrs & rs
end repeat
return out`
  let out
  try {
    out = await osa(script, [], 10_000)
  } catch (err) {
    throw mailErr(err)
  }
  return out
    .split(ROW)
    .map((r) => r.split(SEP).map((s) => s.trim()).filter(Boolean))
    .filter((f) => f.length >= 2)
    .map(([name, ...addresses]) => ({ name, addresses }))
}

// ----------------------------------------------------------------- access

/**
 * Which sources ZEN can read right now: 'ok', 'needs-access' or 'error'.
 * `notes` says why for anything not ok. Never shows a permission prompt
 * except Mail's (asking Mail is the only way to learn whether it is allowed).
 */
export async function access() {
  const notes = {}
  const probe = (source, fn) => {
    try {
      fn()
      return 'ok'
    } catch (err) {
      notes[source] = err.message
      return err instanceof NeedsAccess ? 'needs-access' : 'error'
    }
  }
  const messagesS = probe('messages', () => withDb('messages', PATHS.messages(), () => {}))
  const callsS = probe('calls', () => withDb('calls', PATHS.calls(), () => {}))
  const contactsS = probe('contacts', () => loadBook())

  let calendarS
  const ek = await eventKitStatus()
  if (ek === 'ok') calendarS = 'ok'
  else {
    calendarS = probe('calendar', () => withDb('calendar', PATHS.calendar(), () => {}))
    if (calendarS !== 'ok') {
      calendarS = 'needs-access'
      notes.calendar =
        ek === 'not-determined'
          ? 'ZEN will ask for calendar access the first time it reads your calendar. ' + HOW.calendar
          : new NeedsAccess('calendar').message
    }
  }

  let mailS = 'ok'
  if (process.env.ZEN_MAIL === 'off') {
    mailS = 'error'
    notes.mail = 'Mail reading is switched off (ZEN_MAIL=off).'
  } else if ((await osa('application "Mail" is running', [], 4000).catch(() => 'false')).trim() !== 'true') {
    mailS = 'error'
    notes.mail = 'Mail is not open, so there is nothing to read. Open Mail and leave it running.'
  } else {
    try {
      await osa('tell application "Mail" to count of accounts', [], 8000)
    } catch (err) {
      const denied = /-1743|not authori[sz]ed|not allowed/i.test(err.message)
      mailS = denied ? 'needs-access' : 'error'
      notes.mail = denied ? new NeedsAccess('mail').message : err.message
    }
  }

  return { calendar: calendarS, messages: messagesS, calls: callsS, mail: mailS, contacts: contactsS, notes }
}

// ------------------------------------------------------- people in your mail

/**
 * An address book built from the user's own mail: everyone who wrote to them
 * and everyone they wrote to, with how often and how recently.
 *
 * Contacts only knows the people someone bothered to save, and reading it
 * needs Full Disk Access. "Mail my HR" needs neither: the user has written to
 * HR dozens of times, and the Sent mailbox says exactly where. Mail is slow to
 * walk (~9s for 1,500 inbox and 300 sent messages), so the book is built in
 * the background, kept in memory and on disk, and refreshed every few hours;
 * a lookup never waits on Mail.
 *
 * Two kinds of address are left out on purpose: no-reply robots (nobody means
 * them), and internationalised lookalike domains (xn--…, "nàmmayatri.in"),
 * which is what an impostor's address looks like. ZEN must never pick one of
 * those for "my HR", however often it appears.
 */
const PEOPLE_FILE = join(STATE, 'mail_people.json')
const PEOPLE_TTL = 6 * 3_600_000
let people = null
let peopleAt = 0
let peopleBuild = null

const ROBOT = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?|alerts?)([._-]|@)/i
const LOOKALIKE = (address) => /(^|\.|@)xn--/i.test(address) || /[^\x00-\x7f]/.test(address)

const PEOPLE_SCRIPT = `on run argv
  set nIn to item 1 of argv as integer
  set nOut to item 2 of argv as integer
  set us to ASCII character 31
  set rs to ASCII character 30
  set out to ""
  tell application "Mail"
    set c to count of messages of inbox
    if c > nIn then set c to nIn
    if c > 0 then
      set ss to sender of messages 1 thru c of inbox
      set ds to date received of messages 1 thru c of inbox
      repeat with i from 1 to c
        set out to out & "in" & us & (item i of ss) & us & ((item i of ds) as «class isot» as string) & rs
      end repeat
    end if
    try
      set sm to sent mailbox
      set c2 to count of messages of sm
      if c2 > nOut then set c2 to nOut
      repeat with i from 1 to c2
        set m to message i of sm
        set d to (date sent of m) as «class isot» as string
        repeat with r in (to recipients of m)
          set out to out & "out" & us & (name of r) & " <" & (address of r) & ">" & us & d & rs
        end repeat
      end repeat
    end try
  end tell
  return out
end run`

/** "Name <a@b>" or "a@b" -> { name, address } (address lower-cased). */
function splitAddress(s) {
  const t = String(s ?? '').trim()
  const m = /^"?(.*?)"?\s*<([^>]+)>$/.exec(t)
  const address = (m ? m[2] : t).trim().toLowerCase()
  const name = clean(m ? m[1] : '', 80).replace(/^["']|["']$/g, '').trim()
  return { name: name && name.toLowerCase() !== address ? name : '', address }
}

function loadPeople() {
  if (people) return people
  try {
    const saved = JSON.parse(readFileSync(PEOPLE_FILE, 'utf8'))
    people = Array.isArray(saved.people) ? saved.people : []
    peopleAt = Number(saved.at) || 0
  } catch {
    people = []
  }
  return people
}

/**
 * Rebuilds the book from Mail. Resolves to the list, or to the old one when
 * Mail is closed or says no. One build at a time.
 */
export function refreshMailPeople() {
  if (peopleBuild) return peopleBuild
  peopleBuild = (async () => {
    try {
      if (process.env.ZEN_MAIL === 'off') return loadPeople()
      const running = await osa('application "Mail" is running', [], 4000).catch(() => 'false')
      if (running.trim() !== 'true') return loadPeople()
      const out = await osa(PEOPLE_SCRIPT, ['1500', '300'], 60_000)
      const book = new Map()
      for (const row of out.split(ROW)) {
        const [dir, who, when] = row.split(SEP)
        if (dir !== 'in' && dir !== 'out') continue
        const { name, address } = splitAddress(who)
        if (!address.includes('@') || ROBOT.test(address) || LOOKALIKE(address)) continue
        const at = Date.parse(when) || 0
        const p = book.get(address) ?? { name: '', address, sent: 0, received: 0, last: 0 }
        if (name && (!p.name || dir === 'out')) p.name = name
        if (dir === 'out') p.sent++
        else p.received++
        p.last = Math.max(p.last, at)
        book.set(address, p)
      }
      people = [...book.values()]
      peopleAt = Date.now()
      mkdirSync(dirname(PEOPLE_FILE), { recursive: true })
      writeFileSync(`${PEOPLE_FILE}.tmp`, JSON.stringify({ at: peopleAt, people }))
      renameSync(`${PEOPLE_FILE}.tmp`, PEOPLE_FILE)
      console.log(`[life] mail people: ${people.length} addresses`)
      return people
    } catch (err) {
      console.warn('[life] mail people:', err?.message ?? err)
      return loadPeople()
    } finally {
      peopleBuild = null
    }
  })()
  return peopleBuild
}

/** True when the book is missing or old; callers kick off refreshMailPeople(). */
export const mailPeopleStale = () => (loadPeople(), !people.length || Date.now() - peopleAt > PEOPLE_TTL)

/**
 * Words people use for a role, matched against names and the local part of
 * addresses as whole words ("hr" must not match "chris").
 */
const ROLES = {
  hr: ['hr', 'human resources', 'humanresources', 'people', 'people ops', 'peopleops', 'people team', 'payroll', 'talent', 'hrbp', 'hr team'],
  payroll: ['payroll', 'salary', 'hr'],
  finance: ['finance', 'accounts', 'accounting', 'reimbursement', 'reimbursements', 'expenses', 'ap'],
  it: ['it', 'helpdesk', 'help desk', 'it support', 'itsupport', 'support', 'servicedesk'],
  admin: ['admin', 'facilities', 'office admin'],
  travel: ['travel', 'travel desk', 'traveldesk'],
  recruiting: ['recruiting', 'recruitment', 'talent', 'hiring', 'careers'],
  legal: ['legal', 'compliance'],
}

const words = (s) => String(s ?? '').toLowerCase().replace(/[._+-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const hasPhrase = (hay, phrase) => ` ${hay} `.includes(` ${phrase} `)

/**
 * Who in the user's mail best fits "HR", "Priya", "my manager's Rahul"…
 * Ranked by how much the user has written to them (sent counts triple: who
 * you write to is who you mean), then received, then recency.
 * @returns {{ name: string, address: string, sent: number, received: number, last: number, score: number }[]}
 */
export function matchMailPeople(query) {
  const q = words(String(query ?? '').replace(/^(my|our|the)\s+/i, ''))
  if (!q) return []
  const terms = ROLES[q] ?? [q]
  const now = Date.now()
  return loadPeople()
    .map((p) => {
      const hay = `${words(p.name)} ${words(p.address.split('@')[0])}`
      const hit = terms.some((t) => hasPhrase(hay, words(t)))
      if (!hit) return null
      const ageDays = (now - (p.last || 0)) / 86_400_000
      const score = p.sent * 3 + p.received + Math.max(0, 5 - ageDays / 30)
      return { ...p, score }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
}

/** The whole book (cached; may be empty until the first build finishes). */
export const allMailPeople = () => loadPeople()
