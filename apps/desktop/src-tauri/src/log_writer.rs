//! Daily log file writer: created owner-only (0600 on Unix), capped in size per day,
//! and pruned to the last few days. `tracing-appender` offers none of the three.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Most bytes written to one day's file; further lines are dropped.
pub const MAX_DAILY_BYTES: u64 = 20 * 1024 * 1024;
const KEEP_FILES: usize = 7;
const PREFIX: &str = "armada.log";

pub struct CappedLogWriter {
    dir: PathBuf,
    cap: u64,
    day: u64,
    file: Option<File>,
    written: u64,
    notified: bool,
}

fn today() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(days: u64) -> (i64, u32, u32) {
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

impl CappedLogWriter {
    pub fn new(dir: PathBuf) -> io::Result<Self> {
        Self::with_cap(dir, MAX_DAILY_BYTES)
    }

    pub fn with_cap(dir: PathBuf, cap: u64) -> io::Result<Self> {
        let mut w = CappedLogWriter {
            dir,
            cap,
            day: today(),
            file: None,
            written: 0,
            notified: false,
        };
        w.open()?;
        Ok(w)
    }

    fn open(&mut self) -> io::Result<()> {
        let (y, m, d) = civil(self.day);
        let path = self.dir.join(format!("{PREFIX}.{y:04}-{m:02}-{d:02}"));
        let mut opts = OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(&path)?;
        self.written = file.metadata().map(|m| m.len()).unwrap_or(0);
        self.file = Some(file);
        self.notified = false;
        self.prune();
        Ok(())
    }

    fn prune(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut names: Vec<_> = rd
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with(PREFIX))
            .collect();
        names.sort();
        while names.len() > KEEP_FILES {
            let _ = std::fs::remove_file(self.dir.join(names.remove(0)));
        }
    }
}

impl Write for CappedLogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let day = today();
        if day != self.day {
            self.day = day;
            self.open()?;
        }
        let Some(file) = self.file.as_mut() else {
            return Ok(buf.len());
        };
        if self.written >= self.cap {
            if !self.notified {
                self.notified = true;
                let _ = file
                    .write_all(b"-- log size cap reached for today; further lines dropped --\n");
            }
            return Ok(buf.len());
        }
        file.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_723), (2024, 1, 1));
    }

    #[test]
    fn caps_and_restricts_permissions() {
        let dir = std::env::temp_dir().join(format!("armada-logw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut w = CappedLogWriter::with_cap(dir.clone(), 10).unwrap();
        w.write_all(b"0123456789").unwrap();
        w.write_all(b"LATER").unwrap();
        w.flush().unwrap();
        let f = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap();
        let text = std::fs::read_to_string(f.path()).unwrap();
        assert!(text.starts_with("0123456789"));
        assert!(!text.contains("LATER"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(f.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
