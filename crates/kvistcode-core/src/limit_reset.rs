//! Reads the moment a usage limit lifts out of a provider's own message.
//!
//! Providers word it differently, and none of it is a contract:
//!
//! * Claude Code: `You've hit your limit · resets 6pm (America/Los_Angeles)`, `resets Nov 5, 3pm (UTC)`,
//!   and the older `Claude AI usage limit reached|1760000000` (unix seconds after a pipe).
//! * Codex: `... try again at 5:47 PM.`, `try again at Nov 5th, 2026 3:02 PM`, `try again in 2 hours 15 minutes`.
//! * Gemini / Grok / API style: `Please retry in 34.2s`, `retry after 30 seconds`, an ISO timestamp.
//!
//! Everything here is defensive: it returns `None` rather than guess wildly, and a time that is not
//! plausible (far in the past or weeks away) is dropped. A bare clock time ("6pm") means its next
//! occurrence in the named zone (this machine's zone when none is named), worked out on the calendar
//! rather than by adding 24 hours, so a daylight-saving change in between does not shift it.
//!
//! The structured reset time that providers also report in account usage (see [`exhausted_reset`])
//! is more reliable than any text; [`best_reset`] combines the two.

use crate::model::AccountUsage;
use jiff::civil::{Date, DateTime, Time, Weekday};
use jiff::tz::{Offset, TimeZone};
use jiff::{Timestamp, Zoned};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

/// A reset further away than this is not believed (a monthly cycle is the longest real one).
const MAX_AHEAD_MS: i64 = 40 * DAY;
/// A time that just passed counts as "now" (the message was written a moment ago).
const GRACE_PAST_MS: i64 = 2 * MINUTE;
/// A window this full is the one that stopped the agent.
const EXHAUSTED_PERCENT: f64 = 99.0;

/// When the limit lifts according to `text` (unix ms), or None.
pub fn parse_reset(text: &str, now_ms: i64, local: &TimeZone) -> Option<i64> {
    let at = parse_raw(text, now_ms, local)?;
    plausible(at, now_ms)
}

/// Keeps a believable instant: a few minutes late counts as now, weeks away or long gone is dropped.
pub fn plausible(at_ms: i64, now_ms: i64) -> Option<i64> {
    if at_ms < now_ms - GRACE_PAST_MS || at_ms > now_ms + MAX_AHEAD_MS {
        return None;
    }
    Some(at_ms.max(now_ms))
}

/// The latest reset among the usage windows that are used up (that is when every limit is lifted).
/// None when no window is full or the full ones name no future reset.
pub fn exhausted_reset(usage: &AccountUsage, now_ms: i64) -> Option<i64> {
    [usage.primary.as_ref(), usage.secondary.as_ref()]
        .into_iter()
        .flatten()
        .filter(|w| w.used_percent >= EXHAUSTED_PERCENT)
        .filter_map(|w| w.resets_at)
        .filter(|r| *r > now_ms && *r <= now_ms + MAX_AHEAD_MS)
        .max()
}

/// Whether an account's usage says nothing is used up *and* the snapshot is newer than `since_ms`
/// (so it was taken after the limit hit, not before it).
pub fn usage_is_clear(usage: &AccountUsage, now_ms: i64, since_ms: i64) -> bool {
    if usage.updated_at <= since_ms {
        return false;
    }
    [usage.primary.as_ref(), usage.secondary.as_ref()]
        .into_iter()
        .flatten()
        .all(|w| w.used_percent < EXHAUSTED_PERCENT || w.resets_at.is_some_and(|r| r <= now_ms))
}

/// The reset time for a limit that just hit: the later of what the message says and what the
/// account's full windows say (resuming early only trips the limit again; late costs time).
pub fn best_reset(
    message: &str,
    usage: Option<&AccountUsage>,
    now_ms: i64,
    local: &TimeZone,
) -> Option<i64> {
    let from_text = parse_reset(message, now_ms, local);
    let from_usage = usage.and_then(|u| exhausted_reset(u, now_ms));
    match (from_text, from_usage) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

// ---- the text parser ---------------------------------------------------------------------------

fn parse_raw(text: &str, now_ms: i64, local: &TimeZone) -> Option<i64> {
    // Messages can be long (a stack trace, a docs link); the reset clause is near the start of the
    // phrase it belongs to. Work on a bounded, single-line-ish copy.
    let text: String = text.chars().take(2000).collect();
    let lower = text.to_ascii_lowercase();

    // `...limit reached|1760000000`
    if let Some(ms) = pipe_epoch(&lower) {
        return Some(ms);
    }
    // A full timestamp anywhere ("2026-11-05T15:00:00Z", "2026-11-05 15:00 UTC").
    if let Some(ms) = iso_datetime(&text, local) {
        return Some(ms);
    }
    let tz = named_zone(&text);
    for anchor in ANCHORS {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(anchor) {
            let start = from + pos + anchor.len();
            let tail: String = text[start..].chars().take(90).collect();
            if let Some(ms) = parse_tail(&tail, now_ms, tz.as_ref().unwrap_or(local)) {
                return Some(ms);
            }
            from = start;
        }
    }
    None
}

/// Phrases after which the time follows. Order does not matter much; each is tried in turn.
const ANCHORS: &[&str] = &[
    "resets",
    "reset",
    "try again",
    "retry",
    "available again",
    "available at",
    "until",
    "wait",
];

/// `...|1760000000` (seconds) or `...|1760000000000` (milliseconds).
fn pipe_epoch(lower: &str) -> Option<i64> {
    let (_, after) = lower.rsplit_once('|')?;
    let digits: String = after
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    match digits.len() {
        10 => digits.parse::<i64>().ok().map(|s| s * 1000),
        13 => digits.parse::<i64>().ok(),
        _ => None,
    }
}

/// `2026-11-05T15:00:00Z`, `2026-11-05T15:00:00+02:00`, `2026-11-05 15:00 UTC`, `2026-11-05T15:00`.
fn iso_datetime(text: &str, local: &TimeZone) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 16 <= bytes.len() {
        let w = &bytes[i..];
        let looks = w[0..4].iter().all(u8::is_ascii_digit)
            && w[4] == b'-'
            && w[5..7].iter().all(u8::is_ascii_digit)
            && w[7] == b'-'
            && w[8..10].iter().all(u8::is_ascii_digit)
            && (w[10] == b'T' || w[10] == b' ')
            && w[11..13].iter().all(u8::is_ascii_digit)
            && w[13] == b':'
            && w[14..16].iter().all(u8::is_ascii_digit);
        if !looks {
            i += 1;
            continue;
        }
        // Take the rest of the token: seconds, fraction, offset.
        let mut end = i + 16;
        while end < bytes.len()
            && matches!(bytes[end], b'0'..=b'9' | b':' | b'.' | b'+' | b'-' | b'Z')
        {
            end += 1;
        }
        let token = &text[i..end];
        // With an offset or Z, jiff parses it as an instant.
        if let Ok(ts) = token.replace(' ', "T").parse::<Timestamp>() {
            return Some(ts.as_millisecond());
        }
        // Without one: civil time, in a zone named nearby or this machine's.
        let civil_text = token.trim_end_matches('Z');
        if let Ok(dt) = civil_text.replace(' ', "T").parse::<DateTime>() {
            let tz = named_zone(&text[end..]).unwrap_or_else(|| local.clone());
            return resolve(&tz, dt);
        }
        i = end;
    }
    None
}

#[derive(Default, Debug)]
struct Spec {
    hour: Option<i8>,
    minute: i8,
    second: i8,
    month: Option<i8>,
    day: Option<i8>,
    year: Option<i16>,
    weekday: Option<Weekday>,
    plus_days: Option<i64>,
}

/// What follows "resets" / "try again": a relative amount, or a (partial) calendar time.
fn parse_tail(tail: &str, now_ms: i64, tz: &TimeZone) -> Option<i64> {
    let words = words(tail);
    if let Some(ms) = relative(&words) {
        return Some(now_ms.saturating_add(ms));
    }
    absolute(&words, now_ms, tz)
}

/// Splits into lowercase words with surrounding punctuation trimmed. Parenthesised zone names
/// ("(America/Los_Angeles)") stop the scan: nothing after them belongs to the time.
fn words(tail: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in tail
        .split(|c: char| c.is_whitespace() || c == ',' || c == '\u{b7}' || c == '\u{2022}')
        .filter(|w| !w.is_empty())
    {
        if raw.starts_with('(') {
            // "(UTC)" / "(America/Los_Angeles)": not part of the time words.
            break;
        }
        let w = raw
            .trim_matches(|c: char| c == '.' || c == ';' || c == ')' || c == '!' || c == ':')
            .to_ascii_lowercase();
        if w.is_empty() {
            break;
        }
        // "1h20m" is two amounts: split where a letter is followed by a digit.
        let mut piece = String::new();
        let mut prev_alpha = false;
        for c in w.chars() {
            if prev_alpha && c.is_ascii_digit() {
                out.push(std::mem::take(&mut piece));
            }
            prev_alpha = c.is_ascii_alphabetic();
            piece.push(c);
        }
        out.push(piece);
        if out.len() >= 14 {
            break;
        }
    }
    out
}

const FILLER: &[&str] = &[
    "at",
    "on",
    "around",
    "about",
    "approximately",
    "approx",
    "roughly",
    "~",
    "the",
    "by",
    "in",
    "after",
    "within",
    "for",
    "again",
    "and",
    "of",
    "is",
    "will",
    "be",
    "next",
    "than",
    "another",
    "wait",
];

/// "in 3h", "in 2 hours 15 minutes", "after 30 seconds", "1h 20m", "34.2s". Returns ms.
fn relative(words: &[String]) -> Option<i64> {
    let mut total = 0f64;
    let mut found = false;
    let mut i = 0;
    // Only leading filler is skipped, so a clock time ("at 6 pm") is not read as "6 p...".
    while i < words.len() && FILLER.contains(&words[i].as_str()) {
        i += 1;
    }
    while i < words.len() {
        let w = words[i].as_str();
        if w == "and" || w == "," {
            i += 1;
            continue;
        }
        let (num_part, unit_part) = split_number(w)?;
        let (value, unit) = if unit_part.is_empty() {
            // "2 hours": the unit is the next word.
            let u = words.get(i + 1)?;
            i += 1;
            (num_part, u.as_str())
        } else {
            (num_part, unit_part)
        };
        let factor = unit_ms(unit)?;
        total += value * factor as f64;
        found = true;
        i += 1;
        // Stop at the first word that is not another amount.
        if let Some(next) = words.get(i) {
            if next != "and" && split_number(next).is_none() {
                break;
            }
        }
    }
    (found && total.is_finite() && total >= 0.0).then_some(total.round() as i64)
}

/// "3h" -> (3.0, "h"); "34.2s" -> (34.2, "s"); "2" -> (2.0, ""); "pm" -> None.
fn split_number(w: &str) -> Option<(f64, &str)> {
    let end = w
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_digit() || *c == '.'))
        .map_or(w.len(), |(i, _)| i);
    if end == 0 {
        return None;
    }
    let value = w[..end].parse::<f64>().ok()?;
    Some((value, &w[end..]))
}

fn unit_ms(unit: &str) -> Option<i64> {
    Some(match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1000,
        "m" | "min" | "mins" | "minute" | "minutes" => MINUTE,
        "h" | "hr" | "hrs" | "hour" | "hours" => HOUR,
        "d" | "day" | "days" => DAY,
        "w" | "wk" | "wks" | "week" | "weeks" => 7 * DAY,
        _ => return None,
    })
}

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
const WEEKDAYS: [(&str, Weekday); 7] = [
    ("monday", Weekday::Monday),
    ("tuesday", Weekday::Tuesday),
    ("wednesday", Weekday::Wednesday),
    ("thursday", Weekday::Thursday),
    ("friday", Weekday::Friday),
    ("saturday", Weekday::Saturday),
    ("sunday", Weekday::Sunday),
];

fn month_of(w: &str) -> Option<i8> {
    if w.len() < 3 {
        return None;
    }
    let w = if w == "sept" { "sep" } else { w };
    MONTHS
        .iter()
        .position(|m| *m == w || (w.len() == 3 && m.starts_with(w)))
        .map(|i| i as i8 + 1)
}

fn weekday_of(w: &str) -> Option<Weekday> {
    if w.len() < 3 {
        return None;
    }
    WEEKDAYS
        .iter()
        .find(|(name, _)| *name == w || (w.len() <= 5 && name.starts_with(w.trim_end_matches('.'))))
        .map(|(_, d)| *d)
}

/// "6pm", "6:30pm", "6:30", "18:00", "5:47:10 pm". Also "6" or "6:30" followed by a separate "pm".
fn clock(word: &str, next: Option<&str>) -> Option<(i8, i8, i8, bool)> {
    let (digits, suffix) = match word.find(|c: char| c.is_ascii_alphabetic()) {
        Some(i) => (&word[..i], &word[i..]),
        None => (word, ""),
    };
    let meridiem = match suffix {
        "am" | "a.m" | "a.m." => Some(false),
        "pm" | "p.m" | "p.m." => Some(true),
        "" => match next {
            Some("am") | Some("a.m.") | Some("a.m") => Some(false),
            Some("pm") | Some("p.m.") | Some("p.m") => Some(true),
            _ => None,
        },
        _ => return None,
    };
    let parts: Vec<&str> = digits.split(':').collect();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || p.len() > 2) {
        return None;
    }
    let nums: Vec<i8> = parts
        .iter()
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    // A lone number needs am/pm to be a time ("6" alone is a day or noise).
    if nums.len() == 1 && meridiem.is_none() {
        return None;
    }
    let (mut h, m, s) = (
        nums[0],
        nums.get(1).copied().unwrap_or(0),
        nums.get(2).copied().unwrap_or(0),
    );
    if m > 59 || s > 59 {
        return None;
    }
    match meridiem {
        Some(pm) => {
            if !(1..=12).contains(&h) {
                return None;
            }
            h %= 12;
            if pm {
                h += 12;
            }
        }
        None => {
            if h > 23 {
                return None;
            }
        }
    }
    Some((h, m, s, meridiem.is_some()))
}

/// "5th" -> 5, "05" -> 5; None for anything else.
fn day_number(w: &str) -> Option<i8> {
    let digits = w
        .trim_end_matches("st")
        .trim_end_matches("nd")
        .trim_end_matches("rd")
        .trim_end_matches("th");
    if digits.is_empty() || digits.len() > 2 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let d: i8 = digits.parse().ok()?;
    (1..=31).contains(&d).then_some(d)
}

fn absolute(words: &[String], now_ms: i64, tz: &TimeZone) -> Option<i64> {
    let mut spec = Spec::default();
    let mut got_time = false;
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let next = words.get(i + 1).map(String::as_str);
        if let Some((h, m, s, _)) = (!got_time).then(|| clock(w, next)).flatten() {
            spec.hour = Some(h);
            spec.minute = m;
            spec.second = s;
            got_time = true;
            // "6 pm": the meridiem word is consumed with it.
            if matches!(next, Some("am" | "pm" | "a.m." | "p.m." | "a.m" | "p.m"))
                && !w.chars().any(|c| c.is_ascii_alphabetic())
            {
                i += 1;
            }
        } else if w == "noon" {
            spec.hour = Some(12);
            got_time = true;
        } else if w == "midnight" {
            spec.hour = Some(0);
            got_time = true;
        } else if w == "today" {
            spec.plus_days = Some(0);
        } else if w == "tomorrow" {
            spec.plus_days = Some(1);
        } else if let Some(mo) = month_of(w) {
            spec.month = Some(mo);
            // "Nov 5" / "November 5th"
            if let Some(d) = next.and_then(day_number) {
                spec.day = Some(d);
                i += 1;
            }
        } else if let Some(d) = day_number(w).filter(|_| next.and_then(month_of).is_some()) {
            // "5 Nov"
            spec.day = Some(d);
            spec.month = next.and_then(month_of);
            i += 1;
        } else if let Some(y) = (w.len() == 4)
            .then(|| w.parse::<i16>().ok())
            .flatten()
            .filter(|y| (2000..=2100).contains(y))
        {
            spec.year = Some(y);
        } else if let Some(wd) = weekday_of(w) {
            spec.weekday = Some(wd);
        } else if !FILLER.contains(&w)
            && !got_time
            && spec.month.is_none()
            && spec.weekday.is_none()
        {
            // Something that is not a time right after the anchor ("reset your password"): stop.
            if i == 0 {
                return None;
            }
        }
        i += 1;
    }
    if !got_time && spec.month.is_none() && spec.weekday.is_none() && spec.plus_days.is_none() {
        return None;
    }
    // A date alone ("resets Nov 5") means the start of that day.
    let hour = spec.hour.unwrap_or(0);
    let now = Timestamp::from_millisecond(now_ms)
        .ok()?
        .to_zoned(tz.clone());
    let time = Time::new(hour, spec.minute, spec.second, 0).ok()?;
    let today = now.date();

    let date = if let (Some(mo), Some(d)) = (spec.month, spec.day) {
        let year = spec.year.unwrap_or(today.year());
        let mut date = Date::new(year, mo, d).ok()?;
        // No year given and the date already passed: it is next year's.
        if spec.year.is_none() && resolve_date(tz, date, time).is_some_and(|t| t < now_ms - DAY) {
            date = Date::new(year + 1, mo, d).ok()?;
        }
        date
    } else if let Some(wd) = spec.weekday {
        let mut date = today;
        for _ in 0..7 {
            if date.weekday() == wd {
                break;
            }
            date = date.tomorrow().ok()?;
        }
        // Today's weekday but the time has gone: next week.
        if date == today && resolve_date(tz, date, time).is_some_and(|t| t < now_ms - GRACE_PAST_MS)
        {
            date = date.checked_add(jiff::Span::new().days(7)).ok()?;
        }
        date
    } else if let Some(plus) = spec.plus_days {
        today.checked_add(jiff::Span::new().days(plus)).ok()?
    } else {
        // Clock only: its next occurrence.
        let mut date = today;
        if resolve_date(tz, date, time).is_some_and(|t| t < now_ms - GRACE_PAST_MS) {
            date = date.tomorrow().ok()?;
        }
        date
    };
    resolve_date(tz, date, time)
}

fn resolve_date(tz: &TimeZone, date: Date, time: Time) -> Option<i64> {
    resolve(tz, date.to_datetime(time))
}

/// A civil time in `tz` as an instant. In the spring-forward gap the time does not exist: it is
/// taken as the same wall time after the jump; in the autumn overlap the earlier of the two.
fn resolve(tz: &TimeZone, dt: DateTime) -> Option<i64> {
    let zoned: Zoned = tz.to_ambiguous_zoned(dt).compatible().ok()?;
    Some(zoned.timestamp().as_millisecond())
}

// ---- time zones ---------------------------------------------------------------------------------

/// The zone a message names: "(America/Los_Angeles)", "UTC", "PST". None when it names none.
fn named_zone(text: &str) -> Option<TimeZone> {
    for raw in text.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',') {
        let w = raw.trim_matches(|c: char| c == '.' || c == ';' || c == ':');
        if w.is_empty() {
            continue;
        }
        if w.contains('/')
            && w.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
        {
            if let Ok(tz) = TimeZone::get(w) {
                return Some(tz);
            }
            continue;
        }
        if let Some(tz) = abbreviation(w) {
            return Some(tz);
        }
    }
    None
}

/// Common abbreviations as fixed offsets. Ambiguous ones (IST, CST in China) are left out.
fn abbreviation(w: &str) -> Option<TimeZone> {
    let hours: i8 = match w {
        "UTC" | "GMT" | "Z" | "UT" => return Some(TimeZone::UTC),
        "PST" => -8,
        "PDT" => -7,
        "MST" => -7,
        "MDT" => -6,
        "CST" => -6,
        "CDT" => -5,
        "EST" => -5,
        "EDT" => -4,
        "BST" => 1,
        "CET" => 1,
        "CEST" => 2,
        _ => return None,
    };
    Some(TimeZone::fixed(Offset::constant(hours)))
}

#[cfg(test)]
mod tests;
