//! Hybrid logical clock. Timestamps are 21-char fixed-width strings
//! (`{unix_ms:015}-{counter:05x}`) so **plain string comparison equals causal
//! comparison** — SQLite and Rust can order them without parsing.
//!
//! The clock state lives in the `settings` table (`hlc_last`) and is updated
//! inside the same transaction as the change that consumes the timestamp, so
//! a crash can never hand out a duplicate.

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

const KEY: &str = "hlc_last";
/// 5 hex digits. Overflow within one millisecond bumps the millisecond.
const MAX_COUNTER: u32 = 0xF_FFFF;
/// Remote timestamps this far ahead of our wall clock are accepted (rejecting
/// them would break convergence) but logged — someone's clock is broken.
const SKEW_WARN_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc {
    pub ms: u64,
    pub counter: u32,
}

impl Hlc {
    pub fn format(&self) -> String {
        format!("{:015}-{:05x}", self.ms, self.counter)
    }

    pub fn parse(s: &str) -> Option<Hlc> {
        let (ms, c) = s.split_once('-')?;
        if ms.len() != 15 || c.len() != 5 {
            return None;
        }
        Some(Hlc {
            ms: ms.parse().ok()?,
            counter: u32::from_str_radix(c, 16).ok()?,
        })
    }

    /// The wall-clock milliseconds a timestamp string was minted at (for
    /// deriving created_at on merged rows).
    pub fn ms_of(s: &str) -> Option<u64> {
        Hlc::parse(s).map(|h| h.ms)
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load(conn: &Connection) -> Result<Hlc> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0))
        .optional()?;
    Ok(raw.and_then(|s| Hlc::parse(&s)).unwrap_or(Hlc { ms: 0, counter: 0 }))
}

fn save(conn: &Connection, h: Hlc) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [KEY, &h.format()],
    )?;
    Ok(())
}

/// Timestamp a local event.
pub fn next(conn: &Connection) -> Result<String> {
    next_at(conn, now_ms())
}

pub fn next_at(conn: &Connection, now: u64) -> Result<String> {
    let last = load(conn)?;
    let mut h = if now > last.ms {
        Hlc { ms: now, counter: 0 }
    } else {
        Hlc { ms: last.ms, counter: last.counter + 1 }
    };
    if h.counter > MAX_COUNTER {
        h = Hlc { ms: h.ms + 1, counter: 0 };
    }
    save(conn, h)?;
    Ok(h.format())
}

/// Fold the largest remote timestamp of an applied batch into the clock, so
/// our next local write is causally after everything we have seen.
pub fn observe(conn: &Connection, remote: &str) -> Result<()> {
    observe_at(conn, remote, now_ms())
}

pub fn observe_at(conn: &Connection, remote: &str, now: u64) -> Result<()> {
    let Some(r) = Hlc::parse(remote) else {
        return Ok(()); // malformed remote hlc — nothing to learn from it
    };
    if r.ms > now + SKEW_WARN_MS {
        eprintln!("[nook] sync: remote clock is {}s ahead of ours", (r.ms - now) / 1000);
    }
    let last = load(conn)?;
    let ms = now.max(last.ms).max(r.ms);
    let counter = match (ms == last.ms, ms == r.ms) {
        (true, true) => last.counter.max(r.counter) + 1,
        (true, false) => last.counter + 1,
        (false, true) => r.counter + 1,
        (false, false) => 0,
    };
    let mut h = Hlc { ms, counter };
    if h.counter > MAX_COUNTER {
        h = Hlc { ms: h.ms + 1, counter: 0 };
    }
    save(conn, h)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        conn
    }

    #[test]
    fn format_parse_roundtrip_and_width() {
        let h = Hlc { ms: 1784732190123, counter: 0xa };
        let s = h.format();
        assert_eq!(s.len(), 21);
        assert_eq!(Hlc::parse(&s), Some(h));
        assert_eq!(Hlc::ms_of(&s), Some(1784732190123));
        assert_eq!(Hlc::parse("garbage"), None);
        assert_eq!(Hlc::parse(""), None);
    }

    #[test]
    fn string_order_equals_numeric_order() {
        let samples = [
            Hlc { ms: 0, counter: 0 },
            Hlc { ms: 0, counter: 1 },
            Hlc { ms: 1, counter: 0 },
            Hlc { ms: 999, counter: MAX_COUNTER },
            Hlc { ms: 1_000, counter: 0 },
            Hlc { ms: 1784732190123, counter: 5 },
            Hlc { ms: u64::MAX / 1000, counter: 0 },
        ];
        for a in &samples {
            for b in &samples {
                assert_eq!(
                    a.format().cmp(&b.format()),
                    a.cmp(b),
                    "string vs numeric order diverged for {a:?} / {b:?}"
                );
            }
        }
    }

    #[test]
    fn local_timestamps_are_strictly_monotonic() {
        let conn = mem();
        // Same wall-clock instant, repeatedly: counter must climb.
        let mut prev = next_at(&conn, 1000).unwrap();
        for _ in 0..100 {
            let cur = next_at(&conn, 1000).unwrap();
            assert!(cur > prev);
            prev = cur;
        }
        // Wall clock going BACKWARD must not regress the HLC.
        let cur = next_at(&conn, 500).unwrap();
        assert!(cur > prev);
        // Wall clock jumping forward resets the counter.
        let cur2 = next_at(&conn, 2000).unwrap();
        assert!(cur2 > cur);
        assert!(cur2.ends_with("-00000"));
    }

    #[test]
    fn observe_puts_next_local_after_remote() {
        let conn = mem();
        let remote = Hlc { ms: 9_000, counter: 7 }.format();
        observe_at(&conn, &remote, 1000).unwrap(); // our wall clock is behind
        let local = next_at(&conn, 1001).unwrap();
        assert!(local > remote, "{local} must sort after {remote}");
    }

    #[test]
    fn counter_overflow_bumps_the_millisecond() {
        let conn = mem();
        save(&conn, Hlc { ms: 1000, counter: MAX_COUNTER }).unwrap();
        let s = next_at(&conn, 1000).unwrap();
        assert_eq!(Hlc::parse(&s).unwrap(), Hlc { ms: 1001, counter: 0 });
    }
}
