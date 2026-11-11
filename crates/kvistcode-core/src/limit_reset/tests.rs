use super::*;
use crate::model::{AccountUsage, UsageWindow};

fn tz(name: &str) -> TimeZone {
    TimeZone::get(name).unwrap()
}

/// Unix ms of a wall-clock time in `zone`.
fn at(zone: &str, y: i16, mo: i8, d: i8, h: i8, mi: i8) -> i64 {
    tz(zone)
        .to_ambiguous_zoned(jiff::civil::datetime(y, mo, d, h, mi, 0, 0))
        .compatible()
        .unwrap()
        .timestamp()
        .as_millisecond()
}

const NY: &str = "America/New_York";
const LA: &str = "America/Los_Angeles";

fn parse(text: &str, now: i64, local: &str) -> Option<i64> {
    parse_reset(text, now, &tz(local))
}

#[test]
fn claude_clock_time_with_zone() {
    // 10:00 in New York on an ordinary day; 6pm in Los Angeles is 9pm in New York.
    let now = at(NY, 2026, 10, 14, 10, 0);
    let want = at(LA, 2026, 10, 14, 18, 0);
    assert_eq!(
        parse(
            "You've hit your limit \u{b7} resets 6pm (America/Los_Angeles)",
            now,
            NY
        ),
        Some(want)
    );
    assert_eq!(
        parse(
            "5-hour limit reached \u{2219} resets 6pm (America/Los_Angeles)",
            now,
            NY
        ),
        Some(want)
    );
    assert_eq!(
        parse(
            "You've hit your limit. Resets 6:00 PM (America/Los_Angeles).",
            now,
            NY
        ),
        Some(want)
    );
    assert_eq!(
        parse(
            "limit reached, resets at 6 pm (America/Los_Angeles)",
            now,
            NY
        ),
        Some(want)
    );
    assert_eq!(
        parse("resets 18:00 (America/Los_Angeles)", now, NY),
        Some(want)
    );
}

#[test]
fn clock_time_without_zone_uses_local() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    assert_eq!(
        parse("Usage limit reached. Resets at 5pm", now, NY),
        Some(at(NY, 2026, 10, 14, 17, 0))
    );
    let now_la = at(LA, 2026, 10, 14, 10, 0);
    assert_eq!(
        parse("resets 5:30pm", now_la, LA),
        Some(at(LA, 2026, 10, 14, 17, 30))
    );
}

#[test]
fn a_time_that_passed_today_means_tomorrow() {
    let now = at(NY, 2026, 10, 14, 19, 0);
    assert_eq!(
        parse("resets 6pm", now, NY),
        Some(at(NY, 2026, 10, 15, 18, 0))
    );
    // Midnight crossing.
    let late = at(NY, 2026, 10, 14, 23, 50);
    assert_eq!(
        parse("resets 1am", late, NY),
        Some(at(NY, 2026, 10, 15, 1, 0))
    );
}

#[test]
fn a_time_that_just_passed_counts_as_now() {
    // Written a moment ago and parsed a minute after the reset: do not wait a day.
    let now = at(NY, 2026, 10, 14, 18, 1);
    assert_eq!(parse("resets 6pm", now, NY), Some(now));
    // But 10 minutes past is the next occurrence.
    let later = at(NY, 2026, 10, 14, 18, 10);
    assert_eq!(
        parse("resets 6pm", later, NY),
        Some(at(NY, 2026, 10, 15, 18, 0))
    );
}

#[test]
fn tomorrow_is_calendar_tomorrow_across_the_autumn_change() {
    // US clocks go back on 2026-11-01: that day is 25 hours long. 6pm tomorrow is on the calendar.
    let now = at(NY, 2026, 11, 1, 19, 0);
    let want = at(NY, 2026, 11, 2, 18, 0);
    assert_eq!(parse("resets 6pm", now, NY), Some(want));
    assert_eq!(want - now, 23 * HOUR);
    // From just after midnight (EDT) the same evening is 17h50m + the extra hour away.
    let early = at(NY, 2026, 11, 1, 0, 10);
    let six = at(NY, 2026, 11, 1, 18, 0);
    assert_eq!(parse("resets 6pm", early, NY), Some(six));
    assert_eq!(six - early, 18 * HOUR - 10 * MINUTE + HOUR);
}

#[test]
fn spring_forward_gap_and_autumn_overlap() {
    // 02:30 does not exist on 2026-03-08 in New York: taken as 03:30 EDT.
    let now = at(NY, 2026, 3, 8, 0, 30);
    assert_eq!(
        parse("resets 2:30am", now, NY),
        Some(at(NY, 2026, 3, 8, 3, 30))
    );
    // 01:30 happens twice on 2026-11-01: the first (EDT).
    let now = at(NY, 2026, 11, 1, 0, 10);
    let first = parse("resets 1:30am", now, NY).unwrap();
    let zoned = Timestamp::from_millisecond(first).unwrap().to_zoned(tz(NY));
    assert_eq!(
        zoned.offset().seconds(),
        -4 * 3600,
        "the earlier, daylight-time one"
    );
    assert_eq!((zoned.hour(), zoned.minute()), (1, 30));
}

#[test]
fn utc_and_abbreviations() {
    let now = at("UTC", 2026, 10, 14, 10, 0);
    assert_eq!(
        parse("resets 3pm (UTC)", now, NY),
        Some(at("UTC", 2026, 10, 14, 15, 0))
    );
    assert_eq!(
        parse("resets 3pm UTC", now, NY),
        Some(at("UTC", 2026, 10, 14, 15, 0))
    );
    assert_eq!(
        parse("try again at 3:00 PM PST", now, NY),
        Some(at("UTC", 2026, 10, 14, 23, 0))
    );
    // "tomorrow" in a named zone is that zone's tomorrow.
    assert_eq!(
        parse("resets tomorrow 9am (Europe/Berlin)", now, NY),
        Some(at("Europe/Berlin", 2026, 10, 15, 9, 0))
    );
}

#[test]
fn unknown_zone_name_falls_back_to_local() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    assert_eq!(
        parse("resets 6pm (Mars/Olympus_Mons)", now, NY),
        Some(at(NY, 2026, 10, 14, 18, 0))
    );
}

#[test]
fn dates_and_weekdays() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    assert_eq!(
        parse("resets Oct 20, 3pm (America/New_York)", now, LA),
        Some(at(NY, 2026, 10, 20, 15, 0))
    );
    assert_eq!(
        parse("resets Nov 5 at 3pm", now, NY),
        Some(at(NY, 2026, 11, 5, 15, 0))
    );
    assert_eq!(
        parse("try again at Nov 5th, 2026 3:02 PM", now, NY),
        Some(at(NY, 2026, 11, 5, 15, 2))
    );
    assert_eq!(
        parse("resets 5 Nov 9:00", now, NY),
        Some(at(NY, 2026, 11, 5, 9, 0))
    );
    assert_eq!(
        parse("resets November 5", now, NY),
        Some(at(NY, 2026, 11, 5, 0, 0))
    );
    // 2026-10-14 is a Wednesday.
    assert_eq!(
        parse("resets Thursday 9am", now, NY),
        Some(at(NY, 2026, 10, 15, 9, 0))
    );
    assert_eq!(
        parse("resets Wed 9am", now, NY),
        Some(at(NY, 2026, 10, 21, 9, 0))
    );
    assert_eq!(
        parse("resets Wed 5pm", now, NY),
        Some(at(NY, 2026, 10, 14, 17, 0))
    );
    // A date already past without a year is next year's.
    assert_eq!(
        parse("resets Jan 2, 9am", at(NY, 2026, 12, 20, 9, 0), NY),
        Some(at(NY, 2027, 1, 2, 9, 0))
    );
}

#[test]
fn relative_amounts() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    let in_ms = |ms: i64| Some(now + ms);
    assert_eq!(parse("resets in 3h", now, NY), in_ms(3 * HOUR));
    assert_eq!(
        parse("try again in 2 hours 15 minutes", now, NY),
        in_ms(2 * HOUR + 15 * MINUTE)
    );
    assert_eq!(
        parse("Try again in 1 hr 20 min.", now, NY),
        in_ms(HOUR + 20 * MINUTE)
    );
    assert_eq!(
        parse("try again in 3 days 2 hours 5 minutes", now, NY),
        in_ms(3 * DAY + 2 * HOUR + 5 * MINUTE)
    );
    assert_eq!(parse("Please retry in 34.2s", now, NY), in_ms(34_200));
    assert_eq!(parse("retry after 30 seconds", now, NY), in_ms(30_000));
    assert_eq!(
        parse("rate limit exceeded; retry in 1h20m", now, NY),
        in_ms(HOUR + 20 * MINUTE)
    );
    assert_eq!(
        parse("resets in about 45 minutes", now, NY),
        in_ms(45 * MINUTE)
    );
}

#[test]
fn epoch_and_iso_timestamps() {
    let now = 1_760_000_000_000 - 3 * HOUR;
    assert_eq!(
        parse("Claude AI usage limit reached|1760000000", now, NY),
        Some(1_760_000_000_000)
    );
    assert_eq!(
        parse("Claude AI usage limit reached|1760000000000", now, NY),
        Some(1_760_000_000_000)
    );
    let now = at("UTC", 2026, 11, 5, 9, 0);
    assert_eq!(
        parse("quota exhausted until 2026-11-05T15:00:00Z", now, NY),
        Some(at("UTC", 2026, 11, 5, 15, 0))
    );
    assert_eq!(
        parse("resets at 2026-11-05T15:00:00+02:00", now, NY),
        Some(at("UTC", 2026, 11, 5, 13, 0))
    );
    assert_eq!(
        parse("resets at 2026-11-05 15:00 (Europe/Berlin)", now, NY),
        Some(at("Europe/Berlin", 2026, 11, 5, 15, 0))
    );
}

#[test]
fn nonsense_and_implausible_times_are_none() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    for text in [
        "",
        "Internal error",
        "rate limit exceeded",
        "429 Too Many Requests",
        "Reset your password to continue",
        "resets soon",
        "resets in a while",
        "see https://chatgpt.com/codex/settings/usage for details",
        "resets 25:99",
        "resets 13pm",
    ] {
        assert_eq!(parse(text, now, NY), None, "{text:?}");
    }
    // Far away or long gone.
    assert_eq!(parse("resets in 90 days", now, NY), None);
    assert_eq!(parse("resets 2020-01-01T00:00:00Z", now, NY), None);
    assert_eq!(
        parse("Claude AI usage limit reached|1000000000", now, NY),
        None
    );
}

#[test]
fn survives_hostile_input() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    let long = format!("resets {}", "9".repeat(5000));
    assert_eq!(parse(&long, now, NY), None);
    assert_eq!(
        parse(
            "resets \u{1F600}\u{1F600} 6\u{e9}pm \u{4e2d}\u{6587}",
            now,
            NY
        ),
        None
    );
    let _ = parse("reset", now, NY);
    let _ = parse("|", now, NY);
    let _ = parse("resets 99999999999999999999999d", now, NY);
    let _ = parse("resets ::: ... ,,,", now, NY);
}

#[test]
fn a_message_with_a_link_and_a_reset() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    let text = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:47 PM.";
    assert_eq!(parse(text, now, NY), Some(at(NY, 2026, 10, 14, 17, 47)));
}

fn window(used: f64, resets: Option<i64>) -> UsageWindow {
    UsageWindow {
        used_percent: used,
        window_mins: None,
        resets_at: resets,
    }
}

fn usage(p: Option<UsageWindow>, s: Option<UsageWindow>, updated_at: i64) -> AccountUsage {
    AccountUsage {
        primary: p,
        secondary: s,
        fable: None,
        plan: None,
        updated_at,
    }
}

#[test]
fn exhausted_windows_set_the_reset() {
    let now = 1_000_000;
    let u = usage(
        Some(window(100.0, Some(now + 5 * HOUR))),
        Some(window(40.0, Some(now + DAY))),
        now,
    );
    assert_eq!(exhausted_reset(&u, now), Some(now + 5 * HOUR));
    let both = usage(
        Some(window(100.0, Some(now + 5 * HOUR))),
        Some(window(99.5, Some(now + DAY))),
        now,
    );
    assert_eq!(
        exhausted_reset(&both, now),
        Some(now + DAY),
        "every limit must lift"
    );
    let none = usage(Some(window(60.0, Some(now + HOUR))), None, now);
    assert_eq!(exhausted_reset(&none, now), None);
    let stale = usage(Some(window(100.0, Some(now - HOUR))), None, now);
    assert_eq!(
        exhausted_reset(&stale, now),
        None,
        "a finished period says nothing"
    );
    let unknown = usage(Some(window(100.0, None)), None, now);
    assert_eq!(exhausted_reset(&unknown, now), None);
}

#[test]
fn best_reset_takes_the_later_of_text_and_usage() {
    let now = at(NY, 2026, 10, 14, 10, 0);
    let l = tz(NY);
    let text_at = at(NY, 2026, 10, 14, 15, 0);
    let late = usage(Some(window(100.0, Some(text_at + 2 * HOUR))), None, now);
    let early = usage(Some(window(100.0, Some(text_at - HOUR))), None, now);
    assert_eq!(
        best_reset("resets 3pm", Some(&late), now, &l),
        Some(text_at + 2 * HOUR)
    );
    assert_eq!(
        best_reset("resets 3pm", Some(&early), now, &l),
        Some(text_at)
    );
    assert_eq!(best_reset("resets 3pm", None, now, &l), Some(text_at));
    assert_eq!(
        best_reset("boom", Some(&late), now, &l),
        Some(text_at + 2 * HOUR)
    );
    assert_eq!(best_reset("boom", None, now, &l), None);
}

#[test]
fn usage_is_clear_needs_a_fresh_snapshot() {
    let now = 10 * HOUR;
    let hit = 5 * HOUR;
    let fresh_ok = usage(Some(window(10.0, Some(now + HOUR))), None, now - 1);
    assert!(usage_is_clear(&fresh_ok, now, hit));
    let old = usage(Some(window(10.0, Some(now + HOUR))), None, hit - 1);
    assert!(
        !usage_is_clear(&old, now, hit),
        "taken before the limit hit"
    );
    let full = usage(Some(window(100.0, Some(now + HOUR))), None, now - 1);
    assert!(!usage_is_clear(&full, now, hit));
    let lifted = usage(Some(window(100.0, Some(now - 1))), None, now - 1);
    assert!(usage_is_clear(&lifted, now, hit), "its period has ended");
}

#[test]
fn the_fable_window_only_holds_fable_agents() {
    let now = 10 * HOUR;
    let mut u = usage(Some(window(20.0, Some(now + HOUR))), None, now - 1);
    u.fable = Some(window(100.0, Some(now + 3 * DAY)));
    let opus = for_model(&u, Some("opus"));
    assert_eq!(exhausted_reset(&opus, now), None);
    assert!(usage_is_clear(&opus, now, 5 * HOUR));
    for m in [Some("fable"), Some("claude-fable-5-2[1m]")] {
        let f = for_model(&u, m);
        assert_eq!(exhausted_reset(&f, now), Some(now + 3 * DAY));
        assert!(!usage_is_clear(&f, now, 5 * HOUR));
    }
    assert!(for_model(&u, None).fable.is_none());
}
