//! Wake phrase, the UI-agnostic half: checking the phrase the user picked, cutting the
//! microphone stream into utterances (a simple energy-based voice activity detector), and
//! deciding whether a transcript starts with the phrase. Capture and transcription (Whisper,
//! on this device) live in the desktop shell's `wake.rs`.
//!
//! Privacy: utterances are only held in memory until they are transcribed; nothing here
//! writes audio anywhere.

use std::collections::VecDeque;

/// The phrase offered first.
pub const DEFAULT_WAKE_PHRASE: &str = "Hey Kvistcode";
pub const MAX_WAKE_PHRASE_LEN: usize = 40;
const MIN_WAKE_WORDS: usize = 2;
const MAX_WAKE_WORDS: usize = 5;

/// Why `phrase` can't be a wake phrase, or `None` when it can.
pub fn wake_phrase_problem(phrase: &str) -> Option<String> {
    let phrase = phrase.trim();
    if phrase.is_empty() {
        return Some("Enter a wake phrase, like \u{201c}Hey Kvistcode\u{201d}.".into());
    }
    if phrase.chars().count() > MAX_WAKE_PHRASE_LEN {
        return Some(format!(
            "The wake phrase can be up to {MAX_WAKE_PHRASE_LEN} characters."
        ));
    }
    if !phrase
        .chars()
        .all(|c| c.is_alphabetic() || c.is_whitespace() || matches!(c, '\'' | '\u{2019}' | '-'))
    {
        return Some("Use only words in the wake phrase.".into());
    }
    let words = phrase.split_whitespace().count();
    if words < MIN_WAKE_WORDS {
        return Some(
            "Use at least two words, like \u{201c}Hey Kvistcode\u{201d}, so everyday talk doesn't start it."
                .into(),
        );
    }
    if words > MAX_WAKE_WORDS {
        return Some("Use five words or fewer.".into());
    }
    None
}

// ---------- utterances ----------

const FRAME_MS: usize = 30;
/// Kept from before the voice starts, so the first syllable isn't clipped.
const PREROLL_MS: usize = 300;
/// Loud frames in a row that start an utterance (shorter is a click or a knock).
const ONSET_FRAMES: usize = 3;
/// Quiet this long ends an utterance (a pause between words is shorter).
const END_SILENCE_MS: usize = 450;
/// Utterances with less voice than this are dropped.
const MIN_VOICE_MS: usize = 250;
/// The start of a longer utterance is checked for the phrase as soon as it is this long,
/// so a phrase followed by a long request doesn't wait for the end before it is seen.
pub const HEAD_MS: usize = 3_000;
/// An utterance is cut off here; the rest of it, up to the next pause, is skipped.
pub const MAX_UTTERANCE_MS: usize = 10_000;
/// Below this a frame is silence whatever the room sounds like (dBFS).
const ABSOLUTE_FLOOR_DB: f32 = -58.0;
/// How far above the room's noise a frame must be to start speech, and to keep it going.
const START_MARGIN_DB: f32 = 9.0;
const KEEP_MARGIN_DB: f32 = 5.0;
/// The room's noise is measured from the quietest moments this far back. Words have gaps,
/// so it is measured while someone talks too, and a steady sound (a fan, a hum) can't pass
/// for a voice.
const NOISE_WINDOW_MS: usize = 1_500;
/// Frames this close to the quietest one count as the room's noise (noise isn't perfectly
/// even, so the quietest frame alone is lower than the room's usual level).
const NOISE_SPREAD_DB: f32 = 6.0;
/// Listened to before anything counts as speech, to learn how loud the room is.
const WARMUP_MS: usize = 300;

/// What [`Segmenter::push`] found. Audio is mono at the rate the segmenter was made for.
#[derive(Debug, Clone, PartialEq)]
pub enum Utterance {
    /// The first [`HEAD_MS`] of an utterance that is still going.
    Head { id: u64, audio: Vec<f32> },
    /// A whole utterance (at most [`MAX_UTTERANCE_MS`]).
    Done { id: u64, audio: Vec<f32> },
}

enum State {
    Idle {
        loud: usize,
    },
    Speech {
        id: u64,
        buf: Vec<f32>,
        voiced: usize,
        quiet: usize,
        head_sent: bool,
    },
    /// Past the maximum: waits for a pause before listening again.
    Skip {
        quiet: usize,
    },
}

/// Cuts a stream of mono samples into utterances: stretches of voice between pauses.
pub struct Segmenter {
    frame_len: usize,
    preroll_len: usize,
    end_frames: usize,
    min_voice_frames: usize,
    head_len: usize,
    max_len: usize,
    pending: Vec<f32>,
    preroll: VecDeque<f32>,
    noise_db: f32,
    /// Loudness of the last frames (dBFS), for the noise level.
    recent: VecDeque<f32>,
    noise_window: usize,
    warmup: usize,
    state: State,
    next_id: u64,
}

fn frame_db(frame: &[f32]) -> f32 {
    let energy = frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32;
    10.0 * (energy + 1e-12).log10()
}

impl Segmenter {
    pub fn new(sample_rate: u32) -> Self {
        let ms = |n: usize| (sample_rate as usize * n / 1000).max(1);
        let frame_len = ms(FRAME_MS);
        Segmenter {
            frame_len,
            preroll_len: ms(PREROLL_MS),
            end_frames: END_SILENCE_MS / FRAME_MS,
            min_voice_frames: MIN_VOICE_MS / FRAME_MS,
            head_len: ms(HEAD_MS),
            max_len: ms(MAX_UTTERANCE_MS),
            pending: Vec::with_capacity(frame_len),
            preroll: VecDeque::with_capacity(ms(PREROLL_MS) + frame_len),
            noise_db: -60.0,
            recent: VecDeque::with_capacity(NOISE_WINDOW_MS / FRAME_MS + 1),
            noise_window: NOISE_WINDOW_MS / FRAME_MS,
            warmup: WARMUP_MS / FRAME_MS,
            state: State::Idle { loud: 0 },
            next_id: 1,
        }
    }

    /// Forget any utterance in progress (the microphone was handed to something else).
    pub fn reset(&mut self) {
        self.pending.clear();
        self.preroll.clear();
        self.state = State::Idle { loud: 0 };
    }

    pub fn push(&mut self, samples: &[f32], out: &mut Vec<Utterance>) {
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (self.frame_len - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == self.frame_len {
                let frame = std::mem::take(&mut self.pending);
                self.frame(&frame, out);
                self.pending = frame;
                self.pending.clear();
            }
        }
    }

    fn frame(&mut self, frame: &[f32], out: &mut Vec<Utterance>) {
        let db = frame_db(frame);
        self.recent.push_back(db);
        if self.recent.len() > self.noise_window {
            self.recent.pop_front();
        }
        let quietest = self.recent.iter().copied().fold(f32::INFINITY, f32::min);
        let (sum, n) = self
            .recent
            .iter()
            .filter(|d| **d <= quietest + NOISE_SPREAD_DB)
            .fold((0.0, 0), |(s, n), d| (s + d, n + 1));
        let room = (sum / n.max(1) as f32).max(-90.0);
        if self.warmup > 0 {
            self.warmup -= 1;
            self.noise_db = room;
            self.preroll.extend(frame.iter().copied());
            let excess = self.preroll.len().saturating_sub(self.preroll_len);
            self.preroll.drain(..excess);
            return;
        }
        // Follows the room quickly when it gets quieter, slowly when it gets louder.
        let rate = if room < self.noise_db { 0.3 } else { 0.05 };
        self.noise_db += (room - self.noise_db) * rate;
        let start = db > ABSOLUTE_FLOOR_DB && db > self.noise_db + START_MARGIN_DB;
        let keep = db > ABSOLUTE_FLOOR_DB && db > self.noise_db + KEEP_MARGIN_DB;
        match &mut self.state {
            State::Idle { loud } => {
                self.preroll.extend(frame.iter().copied());
                let excess = self.preroll.len().saturating_sub(self.preroll_len);
                self.preroll.drain(..excess);
                if start {
                    *loud += 1;
                } else {
                    *loud = 0;
                }
                if *loud >= ONSET_FRAMES {
                    let id = self.next_id;
                    self.next_id += 1;
                    let buf: Vec<f32> = self.preroll.drain(..).collect();
                    self.state = State::Speech {
                        id,
                        buf,
                        voiced: ONSET_FRAMES,
                        quiet: 0,
                        head_sent: false,
                    };
                }
            }
            State::Speech {
                id,
                buf,
                voiced,
                quiet,
                head_sent,
            } => {
                buf.extend_from_slice(frame);
                // A frame only a little above the room neither ends a pause nor extends it.
                if start {
                    *voiced += 1;
                    *quiet = 0;
                } else if keep {
                    *voiced += 1;
                } else {
                    *quiet += 1;
                }
                if !*head_sent && buf.len() >= self.head_len {
                    *head_sent = true;
                    out.push(Utterance::Head {
                        id: *id,
                        audio: buf[..self.head_len].to_vec(),
                    });
                }
                let ended = *quiet >= self.end_frames;
                let too_long = buf.len() >= self.max_len;
                if ended || too_long {
                    if *voiced >= self.min_voice_frames {
                        let mut audio = std::mem::take(buf);
                        // Keep a little of the trailing pause, not all of it.
                        if ended {
                            let trailing = (*quiet).saturating_sub(5) * self.frame_len;
                            audio.truncate(audio.len().saturating_sub(trailing));
                        }
                        audio.truncate(self.max_len);
                        out.push(Utterance::Done { id: *id, audio });
                    }
                    self.state = if too_long && !ended {
                        State::Skip { quiet: 0 }
                    } else {
                        State::Idle { loud: 0 }
                    };
                }
            }
            State::Skip { quiet } => {
                *quiet = if keep { 0 } else { *quiet + 1 };
                if *quiet >= self.end_frames {
                    self.state = State::Idle { loud: 0 };
                }
            }
        }
    }
}

// ---------- matching ----------

/// A transcript that starts with the wake phrase.
#[derive(Debug, Clone, PartialEq)]
pub struct WakeMatch {
    /// What was said after the phrase, if anything worth passing on.
    pub request: Option<String>,
    /// How close the heard words were to the phrase (0..=1).
    pub score: f32,
}

/// How close a transcript must sound to the phrase. Lower lets everyday talk in
/// ("hey, quick code review"), and a false wake sends what follows to OpenAI.
const MATCH_THRESHOLD: f32 = 0.85;
/// Words that may come before the phrase ("okay, hey Kvistcode").
const MAX_LEADING_WORDS: usize = 2;
/// What Whisper tends to add to silence after a short phrase; not a request.
const FILLERS: &[&str] = &[
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "you",
    "okay",
    "ok",
    "um",
    "uh",
    "hmm",
];

struct Word {
    end: usize,
    norm: String,
}

fn words(text: &str) -> Vec<Word> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            cur.extend(c.to_lowercase());
        } else if matches!(c, '\'' | '\u{2019}') && !cur.is_empty() {
            // "what's" stays one word.
        } else if !cur.is_empty() {
            out.push(Word {
                end: i,
                norm: std::mem::take(&mut cur),
            });
        }
    }
    if !cur.is_empty() {
        out.push(Word {
            end: text.len(),
            norm: cur,
        });
    }
    out
}

/// A rough sound-alike key: letters that Whisper confuses for the same sound are folded
/// together ("Quist", "Kvist", "Kwist" all become "kvist"), doubled letters collapsed.
fn sound_key(text: &str) -> Vec<char> {
    let s: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let next = s.get(i + 1).copied();
        let (mapped, step): (&[char], usize) = match (s[i], next) {
            ('p', Some('h')) => (&['f'], 2),
            ('q', Some('u')) => (&['k', 'v'], 2),
            ('c', Some('k')) => (&['k'], 2),
            ('w', Some('h')) => (&['v'], 2),
            ('c' | 'q', _) => (&['k'], 1),
            ('w', _) => (&['v'], 1),
            ('z', _) => (&['s'], 1),
            ('y', _) => (&['i'], 1),
            ('x', _) => (&['k', 's'], 1),
            _ => (std::slice::from_ref(&s[i]), 1),
        };
        for &c in mapped {
            if out.last() != Some(&c) {
                out.push(c);
            }
        }
        i += step;
    }
    out
}

fn similarity(a: &[char], b: &[char]) -> f32 {
    let longest = a.len().max(b.len());
    if longest == 0 {
        return 1.0;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    1.0 - prev[b.len()] as f32 / longest as f32
}

/// Whether `transcript` starts with something that sounds like `phrase` (a couple of words
/// may come first). Words may be split or joined differently ("Kvist code").
pub fn match_wake(transcript: &str, phrase: &str) -> Option<WakeMatch> {
    let target: String = words(phrase).into_iter().map(|w| w.norm).collect();
    let target = sound_key(&target);
    let phrase_words = words(phrase).len();
    let heard = words(transcript);
    if target.is_empty() || heard.is_empty() {
        return None;
    }
    let mut best: Option<(f32, usize)> = None;
    for start in 0..=MAX_LEADING_WORDS.min(heard.len() - 1) {
        let mut joined = String::new();
        for (end, word) in heard.iter().enumerate().skip(start).take(phrase_words + 2) {
            joined.push_str(&word.norm);
            let score = similarity(&sound_key(&joined), &target);
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, end));
            }
        }
    }
    let (score, last) = best?;
    if score < MATCH_THRESHOLD {
        return None;
    }
    let rest = transcript[heard[last].end..]
        .trim_start_matches(|c: char| {
            c.is_whitespace() || ",.;:!?-\u{2013}\u{2014}\u{2026}".contains(c)
        })
        .trim_end();
    let rest_norm: String = words(rest)
        .iter()
        .map(|w| w.norm.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let request = (rest.chars().filter(|c| c.is_alphabetic()).count() >= 2
        && !FILLERS.contains(&rest_norm.as_str()))
    .then(|| rest.to_string());
    Some(WakeMatch { request, score })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_phrase() {
        assert_eq!(wake_phrase_problem(DEFAULT_WAKE_PHRASE), None);
        assert_eq!(wake_phrase_problem("  hej   kompis "), None);
        assert_eq!(wake_phrase_problem("Okay it's go-time"), None);
        assert_eq!(wake_phrase_problem("Привет помощник"), None);
        assert!(wake_phrase_problem("  ")
            .unwrap()
            .starts_with("Enter a wake phrase"));
        assert!(wake_phrase_problem(&"ab ".repeat(14))
            .unwrap()
            .contains("40 characters"));
        assert!(wake_phrase_problem("Hey R2D2")
            .unwrap()
            .contains("only words"));
        assert!(wake_phrase_problem("Hey, you")
            .unwrap()
            .contains("only words"));
        assert!(wake_phrase_problem("Kvistcode")
            .unwrap()
            .contains("at least two"));
        assert!(wake_phrase_problem("a b c d e f")
            .unwrap()
            .contains("five words"));
    }

    #[test]
    fn hears_the_phrase_said_several_ways() {
        for heard in [
            "Hey Kvistcode.",
            "Hey, Kvistcode!",
            "hey kvist code",
            "Hey Quistcode",
            "Hey Kwist code.",
            "Hey Twistcode.",
            "Okay, hey Kvistcode.",
            "Hay Kvistcode",
        ] {
            let m = match_wake(heard, DEFAULT_WAKE_PHRASE);
            assert!(m.is_some(), "{heard}");
            assert_eq!(m.unwrap().request, None, "{heard}");
        }
    }

    #[test]
    fn ignores_talk_that_only_sounds_a_bit_alike() {
        for heard in [
            "Hey, can you pass me the code?",
            "I pushed the code to GitHub.",
            "Hey Chris, do you want coffee?",
            "Twist the cord a little.",
            "The visitor code is on the list.",
            "Let me check the kiosk code.",
            "Hey, quick code review?",
            "Hey, list code first.",
            "Hey Vista code",
            "Hey, what's up?",
            "Thank you.",
            "We talked about Kvistcode yesterday and then hey Kvistcode",
            "",
        ] {
            assert_eq!(match_wake(heard, DEFAULT_WAKE_PHRASE), None, "{heard}");
        }
    }

    #[test]
    fn passes_on_what_comes_after_the_phrase() {
        let m = match_wake(
            "Hey Kvistcode, what are my agents doing?",
            DEFAULT_WAKE_PHRASE,
        )
        .unwrap();
        assert_eq!(m.request.as_deref(), Some("what are my agents doing?"));
        let m = match_wake(
            "Hey Kvist code. Start a new agent in the website project.",
            DEFAULT_WAKE_PHRASE,
        )
        .unwrap();
        assert_eq!(
            m.request.as_deref(),
            Some("Start a new agent in the website project.")
        );
        // Whisper's sign-off on a short clip isn't a request.
        let m = match_wake("Hey Kvistcode. Thank you.", DEFAULT_WAKE_PHRASE).unwrap();
        assert_eq!(m.request, None);
    }

    #[test]
    fn works_with_other_phrases() {
        assert!(match_wake("Hello computer, open settings", "Hello computer").is_some());
        assert!(match_wake("Hej kompis", "Hej kompis").is_some());
        assert_eq!(match_wake("Hello, how are you", "Hello computer"), None);
    }

    fn tone(rate: u32, ms: usize, amp: f32) -> Vec<f32> {
        let n = rate as usize * ms / 1000;
        (0..n)
            .map(|i| amp * (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / rate as f32).sin())
            .collect()
    }

    /// Speech-like: syllables with short gaps (a steady tone is a hum, not a voice).
    fn speech(rate: u32, ms: usize, amp: f32) -> Vec<f32> {
        let mut v = Vec::new();
        while v.len() < rate as usize * ms / 1000 {
            v.extend(tone(rate, 240, amp));
            v.extend(vec![0.0; rate as usize * 60 / 1000]);
        }
        v.truncate(rate as usize * ms / 1000);
        v
    }

    fn noise(rate: u32, ms: usize, amp: f32, seed: &mut u32) -> Vec<f32> {
        let n = rate as usize * ms / 1000;
        (0..n)
            .map(|_| {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 17;
                *seed ^= *seed << 5;
                amp * ((*seed as f32 / u32::MAX as f32) * 2.0 - 1.0)
            })
            .collect()
    }

    fn run(rate: u32, parts: &[Vec<f32>], chunk: usize) -> Vec<Utterance> {
        let mut seg = Segmenter::new(rate);
        let mut out = Vec::new();
        let all: Vec<f32> = parts.concat();
        for c in all.chunks(chunk) {
            seg.push(c, &mut out);
        }
        out
    }

    #[test]
    fn cuts_speech_at_pauses() {
        let rate = 16_000;
        let mut seed = 7;
        let quiet = |ms, seed: &mut u32| noise(rate, ms, 0.002, seed);
        let parts = vec![
            quiet(1000, &mut seed),
            tone(rate, 800, 0.2),
            quiet(200, &mut seed), // a pause between words doesn't end it
            tone(rate, 400, 0.2),
            quiet(900, &mut seed),
            tone(rate, 60, 0.3), // a click
            quiet(900, &mut seed),
            tone(rate, 500, 0.1),
            quiet(800, &mut seed),
        ];
        let out = run(rate, &parts, 517);
        assert_eq!(
            out.len(),
            2,
            "{:?}",
            out.iter()
                .map(|u| match u {
                    Utterance::Head { id, .. } => format!("head {id}"),
                    Utterance::Done { id, audio } => format!("done {id} {}", audio.len()),
                })
                .collect::<Vec<_>>()
        );
        let Utterance::Done { id, audio } = &out[0] else {
            panic!()
        };
        assert_eq!(*id, 1);
        // Both words, the pre-roll and a little of the pause after.
        let secs = audio.len() as f32 / rate as f32;
        assert!((1.5..2.0).contains(&secs), "{secs}");
        assert!(matches!(&out[1], Utterance::Done { id: 2, .. }));
    }

    #[test]
    fn long_speech_sends_its_start_early_then_is_cut_off() {
        let rate = 48_000;
        let mut seed = 3;
        let parts = vec![
            noise(rate, 600, 0.002, &mut seed),
            speech(rate, 12_000, 0.2),
            noise(rate, 600, 0.002, &mut seed),
            speech(rate, 700, 0.2),
            noise(rate, 800, 0.002, &mut seed),
        ];
        let out = run(rate, &parts, 480);
        let kinds: Vec<(bool, u64, usize)> = out
            .iter()
            .map(|u| match u {
                Utterance::Head { id, audio } => (true, *id, audio.len()),
                Utterance::Done { id, audio } => (false, *id, audio.len()),
            })
            .collect();
        assert_eq!(kinds.len(), 3, "{kinds:?}");
        assert_eq!(kinds[0], (true, 1, rate as usize * HEAD_MS / 1000));
        assert_eq!(
            kinds[1],
            (false, 1, rate as usize * MAX_UTTERANCE_MS / 1000)
        );
        // The rest of the long one is skipped; the next one after a pause is heard.
        assert!(!kinds[2].0 && kinds[2].1 == 2);
    }

    fn summary(out: &[Utterance], rate: u32) -> Vec<String> {
        out.iter()
            .map(|u| match u {
                Utterance::Head { id, .. } => format!("head {id}"),
                Utterance::Done { id, audio } => {
                    format!("done {id} {:.2}s", audio.len() as f32 / rate as f32)
                }
            })
            .collect()
    }

    #[test]
    fn a_steady_noisy_room_is_not_speech() {
        let rate = 16_000;
        let mut seed = 11;
        // Noise from the very first moment, then words over it, then noise again.
        let mut parts = vec![noise(rate, 4000, 0.05, &mut seed)];
        let words: Vec<f32> = speech(rate, 900, 0.4)
            .into_iter()
            .zip(noise(rate, 900, 0.05, &mut seed))
            .map(|(a, b)| a + b)
            .collect();
        parts.push(words.clone());
        parts.push(noise(rate, 1500, 0.05, &mut seed));
        parts.push(words);
        parts.push(noise(rate, 1500, 0.05, &mut seed));
        let out = run(rate, &parts, 320);
        let got = summary(&out, rate);
        assert_eq!(got.len(), 2, "{got:?}");
        for u in &out {
            let Utterance::Done { audio, .. } = u else {
                panic!("{got:?}")
            };
            let secs = audio.len() as f32 / rate as f32;
            assert!((0.9..1.6).contains(&secs), "{got:?}");
        }
    }

    #[test]
    fn a_hum_that_starts_later_stops_counting_as_speech() {
        let rate = 16_000;
        let mut seed = 5;
        let hum = |ms| tone(rate, ms, 0.1);
        let words: Vec<f32> = speech(rate, 900, 0.5)
            .into_iter()
            .zip(hum(900))
            .map(|(a, b)| a + b)
            .collect();
        let parts = vec![
            noise(rate, 800, 0.002, &mut seed),
            // A fan switched on: steady, and much louder than the room was.
            hum(6_000),
            words,
            hum(2_500),
        ];
        let out = run(rate, &parts, 480);
        let got = summary(&out, rate);
        // The hum is taken for a voice at first, but only until it is learned as the
        // room's sound; the words over it are then heard on their own.
        let done: Vec<f32> = out
            .iter()
            .filter_map(|u| match u {
                Utterance::Done { audio, .. } => Some(audio.len() as f32 / rate as f32),
                _ => None,
            })
            .collect();
        assert_eq!(done.len(), 2, "{got:?}");
        assert!(done[0] < 4.5, "the hum ran on: {got:?}");
        assert!((0.9..1.8).contains(&done[1]), "{got:?}");
    }
}
