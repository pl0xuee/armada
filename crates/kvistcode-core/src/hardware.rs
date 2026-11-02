//! What this computer can run locally: RAM, GPU vendor and memory, free disk for
//! model downloads. Uses only OS tools (`nvidia-smi`, `sysctl`, PowerShell, `/proc`,
//! `/sys`), each with a short timeout; anything unreadable is reported as unknown
//! rather than guessed. Blocking: call from `spawn_blocking`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// "nvidia", "amd", "intel", "apple" or "other".
    pub vendor: String,
    pub vram_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    /// "macos", "windows" or "linux".
    pub os: String,
    pub ram_bytes: Option<u64>,
    pub gpus: Vec<GpuInfo>,
    /// CPU and GPU share memory (Apple Silicon).
    pub unified_memory: bool,
    /// How models will most likely run: "gpu", "unified" or "cpu".
    pub accel: String,
    /// Memory a model plus its context can use, when it can be worked out.
    pub model_memory_bytes: Option<u64>,
    /// Where Ollama keeps models, and the free space there (this computer only).
    pub models_dir: Option<String>,
    pub disk_free_bytes: Option<u64>,
}

const GIB: u64 = 1 << 30;

// ---- parsers (pure) ------------------------------------------------------------

/// `MemTotal:  16314880 kB` from `/proc/meminfo`.
pub fn parse_meminfo(text: &str) -> Option<u64> {
    let kb = text
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kb * 1024)
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB).
pub fn parse_nvidia_smi(text: &str) -> Vec<GpuInfo> {
    text.lines()
        .filter_map(|l| {
            let (name, mem) = l.rsplit_once(',')?;
            let mib = mem.trim().parse::<u64>().ok()?;
            Some(GpuInfo {
                name: name.trim().to_string(),
                vendor: "nvidia".into(),
                vram_bytes: Some(mib * 1024 * 1024),
            })
        })
        .collect()
}

pub fn vendor_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") || n.contains("rtx") {
        "nvidia"
    } else if n.contains("amd") || n.contains("radeon") {
        "amd"
    } else if n.contains("intel") {
        "intel"
    } else if n.contains("apple") {
        "apple"
    } else {
        "other"
    }
}

/// Lines of `name|bytes` (Windows registry read through PowerShell).
pub fn parse_name_bytes(text: &str) -> Vec<GpuInfo> {
    text.lines()
        .filter_map(|l| {
            let (name, bytes) = l.split_once('|')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(GpuInfo {
                name: name.to_string(),
                vendor: vendor_of(name).into(),
                vram_bytes: bytes.trim().parse::<u64>().ok().filter(|b| *b > 0),
            })
        })
        .collect()
}

/// Memory a model can use, given what was found.
pub fn model_memory(
    ram: Option<u64>,
    gpus: &[GpuInfo],
    unified: bool,
) -> (&'static str, Option<u64>) {
    if unified {
        return ("unified", ram.map(|r| r / 10 * 7));
    }
    // Discrete GPUs with a known size: Ollama splits a model across same-vendor GPUs.
    let vram: u64 = gpus
        .iter()
        .filter(|g| g.vendor == "nvidia" || g.vendor == "amd")
        .filter_map(|g| g.vram_bytes)
        .sum();
    if vram >= 2 * GIB {
        return ("gpu", Some(vram));
    }
    ("cpu", ram.map(|r| r / 10 * 6))
}

// ---- detection ---------------------------------------------------------------

/// Runs a program with a timeout, returning stdout on success.
fn run(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().ok()?;
                return status.success().then_some(text);
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn is_arm_mac() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn detect_ram() -> Option<u64> {
    if cfg!(target_os = "linux") {
        return parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?);
    }
    if cfg!(target_os = "macos") {
        return run("sysctl", &["-n", "hw.memsize"], Duration::from_secs(3))?
            .trim()
            .parse()
            .ok();
    }
    run(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
        ],
        Duration::from_secs(8),
    )?
    .trim()
    .parse()
    .ok()
}

#[cfg(target_os = "linux")]
fn drm_gpus() -> Vec<GpuInfo> {
    let mut out = Vec::new();
    let Ok(dir) = std::fs::read_dir("/sys/class/drm") else {
        return out;
    };
    for e in dir.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // Only "card0", "card1" (not "card0-HDMI-A-1").
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let dev = e.path().join("device");
        let vendor = std::fs::read_to_string(dev.join("vendor")).unwrap_or_default();
        let vendor = match vendor.trim() {
            "0x1002" => "amd",
            "0x10de" => continue, // NVIDIA is read through nvidia-smi
            "0x8086" => "intel",
            _ => "other",
        };
        let vram = std::fs::read_to_string(dev.join("mem_info_vram_total"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|b| *b > 0);
        out.push(GpuInfo {
            name: format!("{} GPU", if vendor == "amd" { "AMD" } else { "Intel" }),
            vendor: vendor.into(),
            vram_bytes: vram,
        });
    }
    out
}

#[cfg(not(target_os = "linux"))]
fn drm_gpus() -> Vec<GpuInfo> {
    Vec::new()
}

fn detect_gpus() -> Vec<GpuInfo> {
    let mut gpus = Vec::new();
    if let Some(text) = run(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
        Duration::from_secs(4),
    ) {
        gpus.extend(parse_nvidia_smi(&text));
    }
    gpus.extend(drm_gpus());
    if cfg!(windows) {
        const SCRIPT: &str = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }";
        if let Some(text) = run(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
            Duration::from_secs(8),
        ) {
            for g in parse_name_bytes(&text) {
                // nvidia-smi already gave the NVIDIA cards, with better numbers.
                if g.vendor != "nvidia" || gpus.is_empty() {
                    gpus.push(g);
                }
            }
        }
    }
    if is_arm_mac() {
        gpus.push(GpuInfo {
            name: "Apple Silicon GPU".into(),
            vendor: "apple".into(),
            vram_bytes: None,
        });
    }
    gpus
}

/// Where Ollama keeps its models on this computer.
pub fn models_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("OLLAMA_MODELS").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".ollama").join("models"))
}

/// Free bytes on the volume holding `path` (its nearest existing parent).
pub fn disk_free(path: &Path) -> Option<u64> {
    let mut p = path;
    while !p.exists() {
        p = p.parent()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }
    #[cfg(windows)]
    {
        let drive = p.to_string_lossy().chars().next()?;
        if !drive.is_ascii_alphabetic() {
            return None;
        }
        run(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("(Get-PSDrive -Name '{drive}').Free"),
            ],
            Duration::from_secs(8),
        )?
        .trim()
        .parse()
        .ok()
    }
}

static BASE: OnceLock<Hardware> = OnceLock::new();

/// RAM, GPUs and the memory a model can use. Detected once per run; free disk
/// space is read fresh every time.
pub fn detect() -> Hardware {
    let mut hw = BASE
        .get_or_init(|| {
            let ram = detect_ram();
            let gpus = detect_gpus();
            let unified = is_arm_mac();
            let (accel, mem) = model_memory(ram, &gpus, unified);
            Hardware {
                os: os_name().into(),
                ram_bytes: ram,
                gpus,
                unified_memory: unified,
                accel: accel.into(),
                model_memory_bytes: mem,
                models_dir: None,
                disk_free_bytes: None,
            }
        })
        .clone();
    let dir = models_dir();
    hw.disk_free_bytes = dir.as_deref().and_then(disk_free);
    hw.models_dir = dir.map(|d| d.to_string_lossy().into_owned());
    hw
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_meminfo() {
        let t = "MemTotal:       32654920 kB\nMemFree:  1 kB\n";
        assert_eq!(parse_meminfo(t), Some(32654920 * 1024));
        assert_eq!(parse_meminfo("nothing"), None);
    }

    #[test]
    fn reads_nvidia_smi() {
        let g =
            parse_nvidia_smi("NVIDIA GeForce RTX 4090, 24564\nNVIDIA RTX A2000, 12282\nbad line\n");
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].name, "NVIDIA GeForce RTX 4090");
        assert_eq!(g[0].vram_bytes, Some(24564 * 1024 * 1024));
        assert!(parse_nvidia_smi("").is_empty());
    }

    #[test]
    fn reads_windows_registry_lines() {
        let g =
            parse_name_bytes("AMD Radeon RX 7900 XTX|25753026560\nIntel(R) UHD Graphics|\n|5\n");
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].vendor, "amd");
        assert_eq!(g[0].vram_bytes, Some(25753026560));
        assert_eq!(g[1].vendor, "intel");
        assert_eq!(g[1].vram_bytes, None);
    }

    #[test]
    fn works_out_model_memory() {
        let nv = vec![GpuInfo {
            name: "x".into(),
            vendor: "nvidia".into(),
            vram_bytes: Some(24 * GIB),
        }];
        assert_eq!(
            model_memory(Some(64 * GIB), &nv, false),
            ("gpu", Some(24 * GIB))
        );
        assert_eq!(
            model_memory(Some(32 * GIB), &[], true),
            ("unified", Some(32 * GIB / 10 * 7))
        );
        assert_eq!(model_memory(Some(16 * GIB), &[], false).0, "cpu");
        // An iGPU with unknown memory doesn't count as a GPU.
        let igpu = vec![GpuInfo {
            name: "Intel".into(),
            vendor: "intel".into(),
            vram_bytes: Some(GIB),
        }];
        assert_eq!(model_memory(Some(16 * GIB), &igpu, false).0, "cpu");
        assert_eq!(model_memory(None, &[], false), ("cpu", None));
    }

    #[test]
    fn free_disk_of_a_real_folder() {
        assert!(disk_free(&std::env::temp_dir()).is_some_and(|b| b > 0));
        assert!(run("definitely-not-a-program-xyz", &[], Duration::from_secs(1)).is_none());
    }
}
