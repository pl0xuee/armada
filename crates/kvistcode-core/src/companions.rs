//! Companion software: tools agents and projects commonly need (git, ripgrep, Docker…).
//! A fixed catalog, a fast check for which are installed, and an install plan built from
//! the machine's own package manager.
//!
//! Safety: every command comes from the static catalog below. Nothing here builds a shell
//! string, pipes a download into a shell or uses user input, and nothing installs by itself:
//! the app only runs a plan after an explicit click.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::providers::{resolve_program, resolve_user_program};

/// How long one `--version` check may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    Essentials,
    Languages,
    SearchAndShell,
    Containers,
    RemoteAndAi,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::Essentials => "Essentials",
            Group::Languages => "Languages and build",
            Group::SearchAndShell => "Search and shell",
            Group::Containers => "Containers",
            Group::RemoteAndAi => "Remote and local AI",
        }
    }
}

/// A package manager (or, on a Mac, Apple's own tool installer).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Manager {
    Winget,
    Scoop,
    Choco,
    Brew,
    /// macOS: `xcode-select --install` (git, make and a C compiler).
    XcodeSelect,
    Apt,
    Dnf,
    Pacman,
    Zypper,
    Apk,
}

impl Manager {
    pub const ALL: [Manager; 10] = [
        Manager::Winget,
        Manager::Scoop,
        Manager::Choco,
        Manager::Brew,
        Manager::XcodeSelect,
        Manager::Apt,
        Manager::Dnf,
        Manager::Pacman,
        Manager::Zypper,
        Manager::Apk,
    ];

    /// The program that is run (and looked up on PATH to see if the manager exists).
    pub fn program(self) -> &'static str {
        match self {
            Manager::Winget => "winget",
            Manager::Scoop => "scoop",
            Manager::Choco => "choco",
            Manager::Brew => "brew",
            Manager::XcodeSelect => "xcode-select",
            Manager::Apt => "apt-get",
            Manager::Dnf => "dnf",
            Manager::Pacman => "pacman",
            Manager::Zypper => "zypper",
            Manager::Apk => "apk",
        }
    }

    /// What the person knows it as.
    pub fn name(self) -> &'static str {
        match self {
            Manager::Winget => "winget",
            Manager::Scoop => "Scoop",
            Manager::Choco => "Chocolatey",
            Manager::Brew => "Homebrew",
            Manager::XcodeSelect => "Apple developer tools",
            Manager::Apt => "apt",
            Manager::Dnf => "dnf",
            Manager::Pacman => "pacman",
            Manager::Zypper => "zypper",
            Manager::Apk => "apk",
        }
    }

    /// System-wide managers on Linux need administrator rights.
    fn needs_root(self) -> bool {
        matches!(
            self,
            Manager::Apt | Manager::Dnf | Manager::Pacman | Manager::Zypper | Manager::Apk
        )
    }

    /// Which managers are tried, in order, on each system.
    fn order(os: Os) -> &'static [Manager] {
        match os {
            Os::Windows => &[Manager::Winget, Manager::Scoop, Manager::Choco],
            Os::Mac => &[Manager::Brew],
            // Homebrew on Linux is last: only used when the system's own manager has no package.
            Os::Linux => &[
                Manager::Apt,
                Manager::Dnf,
                Manager::Pacman,
                Manager::Zypper,
                Manager::Apk,
                Manager::Brew,
            ],
        }
    }
}

/// Package names per manager. An empty list means "no clean package": the person gets a
/// download link instead.
pub struct Packages {
    pub winget: &'static [&'static str],
    pub scoop: &'static [&'static str],
    pub choco: &'static [&'static str],
    pub brew: &'static [&'static str],
    pub apt: &'static [&'static str],
    pub dnf: &'static [&'static str],
    pub pacman: &'static [&'static str],
    pub zypper: &'static [&'static str],
    pub apk: &'static [&'static str],
}

const NONE: &[&str] = &[];

impl Packages {
    const fn none() -> Packages {
        Packages {
            winget: NONE,
            scoop: NONE,
            choco: NONE,
            brew: NONE,
            apt: NONE,
            dnf: NONE,
            pacman: NONE,
            zypper: NONE,
            apk: NONE,
        }
    }

    fn for_manager(&self, m: Manager) -> &'static [&'static str] {
        match m {
            Manager::Winget => self.winget,
            Manager::Scoop => self.scoop,
            Manager::Choco => self.choco,
            Manager::Brew => self.brew,
            Manager::XcodeSelect => NONE,
            Manager::Apt => self.apt,
            Manager::Dnf => self.dnf,
            Manager::Pacman => self.pacman,
            Manager::Zypper => self.zypper,
            Manager::Apk => self.apk,
        }
    }
}

/// How Apple's own installer figures in on a Mac.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Apple {
    /// Not part of it.
    No,
    /// Used when Homebrew isn't there.
    Fallback,
    /// The right way to get it, with or without Homebrew.
    Always,
}

pub struct Tool {
    pub id: &'static str,
    pub name: &'static str,
    pub group: Group,
    /// One plain sentence: what it is for.
    pub purpose: &'static str,
    pub recommended: bool,
    /// Program names to look for; the first that runs and gives a version wins.
    pub binaries: &'static [&'static str],
    /// The version's first number must be this (Python 3, not 2).
    pub major: Option<u32>,
    /// Systems this makes sense on (empty: all).
    pub platforms: &'static [Os],
    pub download_url: &'static str,
    pub packages: Packages,
    pub apple: Apple,
    /// On a Mac, `/usr/bin/<name>` is a stub that opens an install dialog when run, until
    /// Apple's developer tools are installed. Never run it to check the version.
    pub apple_stub: bool,
}

pub static CATALOG: &[Tool] = &[
    Tool {
        id: "git",
        name: "Git",
        group: Group::Essentials,
        purpose: "Keeps a history of your project; agents need it to work in separate copies and show diffs.",
        recommended: true,
        binaries: &["git"],
        major: None,
        platforms: &[],
        download_url: "https://git-scm.com/downloads",
        packages: Packages {
            winget: &["Git.Git"],
            scoop: &["git"],
            choco: &["git"],
            brew: &["git"],
            apt: &["git"],
            dnf: &["git"],
            pacman: &["git"],
            zypper: &["git"],
            apk: &["git"],
        },
        apple: Apple::Fallback,
        apple_stub: true,
    },
    Tool {
        id: "gh",
        name: "GitHub CLI",
        group: Group::Essentials,
        purpose: "Lets Kvistcode open pull requests and read issues on GitHub for you.",
        recommended: false,
        binaries: &["gh"],
        major: None,
        platforms: &[],
        download_url: "https://cli.github.com",
        packages: Packages {
            winget: &["GitHub.cli"],
            scoop: &["gh"],
            choco: &["gh"],
            brew: &["gh"],
            apt: &["gh"],
            dnf: &["gh"],
            pacman: &["github-cli"],
            zypper: &["gh"],
            apk: &["github-cli"],
        },
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "node",
        name: "Node.js",
        group: Group::Languages,
        purpose: "Runs JavaScript and web projects (Kvistcode keeps its own private copy for agent tools, so this one is only for yours).",
        recommended: false,
        binaries: &["node"],
        major: None,
        platforms: &[],
        download_url: "https://nodejs.org/en/download",
        packages: Packages {
            winget: &["OpenJS.NodeJS.LTS"],
            scoop: &["nodejs-lts"],
            choco: &["nodejs-lts"],
            brew: &["node"],
            apt: &["nodejs", "npm"],
            dnf: &["nodejs", "npm"],
            pacman: &["nodejs", "npm"],
            zypper: &["nodejs-default", "npm-default"],
            apk: &["nodejs", "npm"],
        },
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "python",
        name: "Python 3",
        group: Group::Languages,
        purpose: "Runs Python projects and scripts, which many agent tools and helpers are written in.",
        recommended: false,
        binaries: &["python3", "python"],
        major: Some(3),
        platforms: &[],
        download_url: "https://www.python.org/downloads/",
        packages: Packages {
            winget: &["Python.Python.3.13"],
            scoop: &["python"],
            choco: &["python"],
            brew: &["python"],
            apt: &["python3", "python3-pip", "python3-venv"],
            dnf: &["python3", "python3-pip"],
            pacman: &["python", "python-pip"],
            zypper: &["python3", "python3-pip"],
            apk: &["python3", "py3-pip"],
        },
        apple: Apple::No,
        apple_stub: true,
    },
    Tool {
        id: "uv",
        name: "uv",
        group: Group::Languages,
        purpose: "A fast way to install Python packages and keep each project's Python separate.",
        recommended: false,
        binaries: &["uv"],
        major: None,
        platforms: &[],
        download_url: "https://docs.astral.sh/uv/getting-started/installation/",
        packages: Packages {
            winget: &["astral-sh.uv"],
            scoop: &["uv"],
            choco: &["uv"],
            brew: &["uv"],
            apt: NONE,
            dnf: &["uv"],
            pacman: &["uv"],
            zypper: NONE,
            apk: &["uv"],
        },
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "build",
        name: "Build tools",
        group: Group::Languages,
        purpose: "A compiler and make, which many projects need to build native code.",
        recommended: false,
        binaries: &["make"],
        major: None,
        platforms: &[Os::Mac, Os::Linux],
        download_url: "https://developer.apple.com/xcode/resources/",
        packages: Packages {
            apt: &["build-essential"],
            dnf: &["make", "gcc", "gcc-c++"],
            pacman: &["base-devel"],
            zypper: &["make", "gcc", "gcc-c++"],
            apk: &["build-base"],
            ..Packages::none()
        },
        apple: Apple::Always,
        apple_stub: true,
    },
    Tool {
        id: "ripgrep",
        name: "ripgrep",
        group: Group::SearchAndShell,
        purpose: "Searches through code very fast; agents use it to find things in large projects.",
        recommended: false,
        binaries: &["rg"],
        major: None,
        platforms: &[],
        download_url: "https://github.com/BurntSushi/ripgrep#installation",
        packages: Packages {
            winget: &["BurntSushi.ripgrep.MSVC"],
            scoop: &["ripgrep"],
            choco: &["ripgrep"],
            brew: &["ripgrep"],
            apt: &["ripgrep"],
            dnf: &["ripgrep"],
            pacman: &["ripgrep"],
            zypper: &["ripgrep"],
            apk: &["ripgrep"],
        },
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "jq",
        name: "jq",
        group: Group::SearchAndShell,
        purpose: "Reads and reshapes JSON data on the command line, which agents often do with tool output.",
        recommended: false,
        binaries: &["jq"],
        major: None,
        platforms: &[],
        download_url: "https://jqlang.github.io/jq/download/",
        packages: Packages {
            winget: &["jqlang.jq"],
            scoop: &["jq"],
            choco: &["jq"],
            brew: &["jq"],
            apt: &["jq"],
            dnf: &["jq"],
            pacman: &["jq"],
            zypper: &["jq"],
            apk: &["jq"],
        },
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "docker",
        name: "Docker",
        group: Group::Containers,
        purpose: "Runs projects and databases in containers; install it from Docker's own page.",
        recommended: false,
        binaries: &["docker"],
        major: None,
        platforms: &[],
        download_url: "https://docs.docker.com/get-started/get-docker/",
        packages: Packages::none(),
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "tailscale",
        name: "Tailscale",
        group: Group::RemoteAndAi,
        purpose: "Optional: lets your phone reach Kvistcode from anywhere, not just your home network.",
        recommended: false,
        binaries: &["tailscale"],
        major: None,
        platforms: &[],
        download_url: "https://tailscale.com/download",
        packages: Packages {
            winget: &["Tailscale.Tailscale"],
            ..Packages::none()
        },
        apple: Apple::No,
        apple_stub: false,
    },
    Tool {
        id: "ollama",
        name: "Ollama",
        group: Group::RemoteAndAi,
        purpose: "Runs AI models on this computer; Kvistcode's local-model setup uses it.",
        recommended: false,
        binaries: &["ollama"],
        major: None,
        platforms: &[],
        download_url: "https://ollama.com/download",
        packages: Packages {
            winget: &["Ollama.Ollama"],
            scoop: &["ollama"],
            choco: &["ollama"],
            brew: &["ollama"],
            pacman: &["ollama"],
            ..Packages::none()
        },
        apple: Apple::No,
        apple_stub: false,
    },
];

pub fn find(id: &str) -> Option<&'static Tool> {
    CATALOG.iter().find(|t| t.id == id)
}

impl Tool {
    pub fn on(&self, os: Os) -> bool {
        self.platforms.is_empty() || self.platforms.contains(&os)
    }
}

/// How the install gets administrator rights, where it needs them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Elevation {
    /// Already running as the administrator (root).
    Root,
    /// Put `sudo` in front; it asks for the password in the terminal.
    Sudo,
    /// Not root and no `sudo`: system installs aren't offered.
    Unavailable,
}

/// What to run for one install. `program` is a bare name; [`run_command`] decides where the
/// real file comes from.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct InstallPlan {
    pub manager: Manager,
    /// The command as a person would type it, shown before anything runs.
    pub display_command: String,
    pub program: String,
    pub args: Vec<String>,
}

fn plan_args(m: Manager, pkgs: &[&'static str]) -> Vec<&'static str> {
    let mut args: Vec<&'static str> = match m {
        Manager::Winget => vec![
            "install",
            "--exact",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--id",
        ],
        Manager::Scoop => vec!["install"],
        Manager::Choco => vec!["install", "-y"],
        Manager::Brew => vec!["install"],
        Manager::XcodeSelect => return vec!["--install"],
        Manager::Apt => vec!["install", "-y"],
        Manager::Dnf => vec!["install", "-y"],
        Manager::Pacman => vec!["-S", "--needed", "--noconfirm"],
        Manager::Zypper => vec!["--non-interactive", "install"],
        Manager::Apk => vec!["add"],
    };
    args.extend_from_slice(pkgs);
    args
}

/// The install for `tool` on `os` with the package managers found, or None when there is no
/// safe route (the person then gets the download page). Pure: nothing is run or looked up.
pub fn install_plan(
    tool: &Tool,
    os: Os,
    available: &[Manager],
    elevation: Elevation,
) -> Option<InstallPlan> {
    if !tool.on(os) {
        return None;
    }
    let usable = |m: &Manager| {
        available.contains(m)
            && !tool.packages.for_manager(*m).is_empty()
            && !(m.needs_root() && elevation == Elevation::Unavailable)
    };
    if os == Os::Mac {
        // Apple's own installer is not a package manager, so it is chosen here by name.
        let brew = usable(&Manager::Brew);
        if tool.apple == Apple::Always || (tool.apple == Apple::Fallback && !brew) {
            return Some(build_plan(Manager::XcodeSelect, &[], elevation));
        }
    }
    let manager = Manager::order(os).iter().copied().find(usable)?;
    let pkgs = tool.packages.for_manager(manager);
    // winget takes one package per command.
    let pkgs = if manager == Manager::Winget {
        &pkgs[..1]
    } else {
        pkgs
    };
    Some(build_plan(manager, pkgs, elevation))
}

fn build_plan(manager: Manager, pkgs: &[&'static str], elevation: Elevation) -> InstallPlan {
    let mut words: Vec<&str> = Vec::new();
    if manager.needs_root() && elevation == Elevation::Sudo {
        words.push("sudo");
    }
    words.push(manager.program());
    words.extend(plan_args(manager, pkgs));
    InstallPlan {
        manager,
        display_command: words.join(" "),
        program: words[0].to_string(),
        args: words[1..].iter().map(|w| w.to_string()).collect(),
    }
}

// ---------------------------------------------------------------- version parsing

/// The first version-looking number (`2.45.2`) in a tool's `--version` output.
/// Handles `git version 2.45.2.windows.1`, `v20.11.1`, `jq-1.7.1`, `Python 3.12.3`,
/// `Docker version 27.3.1, build abc`, `gh version 2.45.0 (2024-03-04)`.
pub fn parse_version(output: &str) -> Option<String> {
    output
        .split(|c: char| c.is_whitespace() || ",()[];:".contains(c))
        .find_map(version_token)
}

fn version_token(token: &str) -> Option<String> {
    // Drop a prefix like `v` or `jq-`.
    let start = token.find(|c: char| c.is_ascii_digit())?;
    if !token[..start]
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == '-')
    {
        return None;
    }
    let run: String = token[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let run = run.trim_end_matches('.');
    let parts: Vec<&str> = run.split('.').collect();
    (parts.len() >= 2 && parts.iter().all(|p| !p.is_empty())).then(|| run.to_string())
}

fn major_matches(tool: &Tool, version: &str) -> bool {
    match tool.major {
        None => true,
        Some(m) => {
            version
                .split('.')
                .next()
                .and_then(|p| p.parse::<u32>().ok())
                == Some(m)
        }
    }
}

// ---------------------------------------------------------------- detection

/// What the list shows for one tool.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInfo {
    pub id: String,
    pub name: String,
    pub group: String,
    pub purpose: String,
    pub recommended: bool,
    pub installed: bool,
    pub version: Option<String>,
    /// There is a one-click install here (otherwise the person gets the download page).
    pub installable: bool,
    /// The exact command the install will run.
    pub install_command: Option<String>,
    /// The package manager it uses.
    pub manager: Option<String>,
    pub download_url: String,
}

/// Package managers found on this machine (using Kvistcode's own PATH, which includes
/// Homebrew and similar). A system manager (apt, dnf…) counts only when it is in a
/// root-owned system folder, because that is the only one that will be run as the administrator.
pub fn detect_managers(os: Os) -> Vec<Manager> {
    Manager::ALL
        .into_iter()
        .filter(|m| Manager::order(os).contains(m))
        .filter(|m| {
            if m.needs_root() {
                trusted_system_program(m.program()).is_some()
            } else {
                resolve_program(m.program()).is_some()
            }
        })
        .collect()
}

pub fn detect_elevation() -> Elevation {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            return Elevation::Root;
        }
    }
    if trusted_system_program("sudo").is_some() {
        Elevation::Sudo
    } else {
        Elevation::Unavailable
    }
}

// ---------------------------------------------------------------- trusted programs

/// Where `sudo` and the system package managers may come from. Kvistcode's PATH also holds
/// folders the person can write to (~/.local/bin, ~/.npm-global/bin, version-manager shims),
/// and anything in them could pose as `sudo` or `apt-get` and get the administrator password.
#[cfg(unix)]
const TRUSTED_DIRS: [&str; 6] = [
    "/usr/bin",
    "/usr/local/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    // NixOS puts the setuid sudo here.
    "/run/wrappers/bin",
];

/// Whether a file with this owner and mode may be run as the administrator: owned by root and
/// not writable by its group or anyone else.
#[cfg(unix)]
fn safe_owner_and_mode(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

/// `name` in the first of `dirs` that has it as a regular, executable file that
/// [`safe_owner_and_mode`] accepts. Never looks anywhere else (no PATH).
#[cfg(unix)]
fn trusted_in(name: &str, dirs: &[&Path]) -> Option<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if name.is_empty() || name.contains('/') {
        return None;
    }
    dirs.iter().find_map(|dir| {
        let path = dir.join(name);
        // metadata follows symlinks: what counts is the file that would really run.
        let meta = std::fs::metadata(&path).ok()?;
        (meta.is_file()
            && meta.permissions().mode() & 0o111 != 0
            && safe_owner_and_mode(meta.uid(), meta.mode()))
        .then_some(path)
    })
}

/// `name` (`sudo`, `apt-get`…) as an absolute path in a root-owned system folder, or None.
#[cfg(unix)]
pub fn trusted_system_program(name: &str) -> Option<PathBuf> {
    let dirs: Vec<&Path> = TRUSTED_DIRS.iter().map(Path::new).collect();
    trusted_in(name, &dirs)
}

#[cfg(not(unix))]
pub fn trusted_system_program(_name: &str) -> Option<PathBuf> {
    None
}

/// What to start for `plan`: the program and its arguments. Administrator installs use the
/// absolute paths of `sudo` and the package manager from [`trusted_system_program`]; the
/// shown command is the same words without the folders. Everything else is looked up
/// as usual (Homebrew and winget live in the person's own folders by design).
pub fn run_command(plan: &InstallPlan) -> Result<(PathBuf, Vec<String>), String> {
    let missing = |name: &str| {
        format!("{name} isn't available on this computer, so Kvistcode can't run the install.")
    };
    if !plan.manager.needs_root() {
        let exe = resolve_program(&plan.program).ok_or_else(|| missing(&plan.program))?;
        return Ok((exe, plan.args.clone()));
    }
    let manager_program = plan.manager.program();
    if plan.program == "sudo" {
        let sudo = trusted_system_program("sudo").ok_or_else(|| missing("sudo"))?;
        let manager =
            trusted_system_program(manager_program).ok_or_else(|| missing(manager_program))?;
        if plan.args.first().map(String::as_str) != Some(manager_program) {
            return Err("The install options changed. Check again and try once more.".into());
        }
        let mut args = vec![manager.to_string_lossy().into_owned()];
        args.extend(plan.args.iter().skip(1).cloned());
        Ok((sudo, args))
    } else {
        let manager =
            trusted_system_program(&plan.program).ok_or_else(|| missing(&plan.program))?;
        Ok((manager, plan.args.clone()))
    }
}

/// The plan, if it is still the one the person confirmed (by the command they were shown).
/// The list is checked ahead of the click, so what would run now can differ from the dialog.
pub fn confirmed_plan(plan: InstallPlan, confirmed: &str) -> Result<InstallPlan, String> {
    if plan.display_command == confirmed {
        Ok(plan)
    } else {
        Err("The install options changed. Check again and try once more.".into())
    }
}

/// The plan for a catalog tool on this machine, or why there is none.
pub async fn plan_for(id: &str) -> Result<InstallPlan, String> {
    let tool = find(id).ok_or_else(|| "That isn't on the list.".to_string())?;
    let (managers, elevation) =
        tokio::task::spawn_blocking(|| (detect_managers(Os::current()), detect_elevation()))
            .await
            .map_err(|e| e.to_string())?;
    install_plan(tool, Os::current(), &managers, elevation).ok_or_else(|| {
        format!(
            "{} can't be installed with one click on this computer. Use the download page.",
            tool.name
        )
    })
}

/// [`plan_for`], refused unless it is the command the person confirmed.
pub async fn confirmed_plan_for(id: &str, confirmed: &str) -> Result<InstallPlan, String> {
    confirmed_plan(plan_for(id).await?, confirmed)
}

/// What running `program --version` gave.
enum Probe {
    /// It ran and exited successfully: its output.
    Ran(String),
    /// Still running after two seconds (it exists; a broken shim fails fast instead).
    Slow,
    /// It failed to start or exited with an error: not usable.
    Failed,
}

/// Runs `program --version`, for at most two seconds.
async fn probe(program: &Path) -> Probe {
    let run = tokio::time::timeout(
        PROBE_TIMEOUT,
        crate::accounts::quiet_command(program)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await;
    let out = match run {
        Err(_) => return Probe::Slow,
        Ok(Err(_)) => return Probe::Failed,
        Ok(Ok(out)) if !out.status.success() => return Probe::Failed,
        Ok(Ok(out)) => out,
    };
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    // Python 2 prints its version on stderr.
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Probe::Ran(text)
}

/// Whether Apple's developer tools are installed (so `/usr/bin/git` is real, not a stub).
async fn apple_tools_installed() -> bool {
    let run = crate::accounts::quiet_command("xcode-select")
        .arg("-p")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, run).await,
        Ok(Ok(s)) if s.success()
    )
}

/// Whether `tool` is installed and its version. Binaries are tried in order, on the person's
/// own PATH; one that runs but prints no version still counts as installed (unless the tool
/// needs a certain major), one that fails does not.
async fn detect_tool(tool: &'static Tool, os: Os) -> (bool, Option<String>) {
    let mut seen_unreadable = false;
    for name in tool.binaries {
        let Some(path) = resolve_user_program(name) else {
            continue;
        };
        if os == Os::Mac
            && tool.apple_stub
            && path == PathBuf::from("/usr/bin").join(name)
            && !apple_tools_installed().await
        {
            continue;
        }
        let text = match probe(&path).await {
            Probe::Ran(text) => text,
            Probe::Slow => {
                seen_unreadable = true;
                continue;
            }
            Probe::Failed => continue,
        };
        match parse_version(&text) {
            Some(v) if major_matches(tool, &v) => return (true, Some(v)),
            Some(_) => {}
            None => seen_unreadable = true,
        }
    }
    // Found but silent (slow, or a different `--version` style): present, version unknown.
    (seen_unreadable && tool.major.is_none(), None)
}

/// Every catalog tool for this system with whether it is installed. All checks run at once,
/// each limited to two seconds; nothing here needs the network.
pub async fn list() -> Vec<CompanionInfo> {
    let os = Os::current();
    let (managers, elevation) =
        tokio::task::spawn_blocking(|| (detect_managers(Os::current()), detect_elevation()))
            .await
            .unwrap_or_else(|_| (Vec::new(), Elevation::Unavailable));
    let mut probes = tokio::task::JoinSet::new();
    let tools: Vec<&'static Tool> = CATALOG.iter().filter(|t| t.on(os)).collect();
    for (i, tool) in tools.iter().enumerate() {
        let tool: &'static Tool = tool;
        probes.spawn(async move { (i, detect_tool(tool, os).await) });
    }
    let mut found = vec![(false, None); tools.len()];
    while let Some(res) = probes.join_next().await {
        if let Ok((i, r)) = res {
            found[i] = r;
        }
    }
    tools
        .into_iter()
        .zip(found)
        .map(|(tool, (installed, version))| {
            let plan = install_plan(tool, os, &managers, elevation);
            CompanionInfo {
                id: tool.id.into(),
                name: tool.name.into(),
                group: tool.group.label().into(),
                purpose: tool.purpose.into(),
                recommended: tool.recommended,
                installed,
                version,
                installable: plan.is_some(),
                install_command: plan.as_ref().map(|p| p.display_command.clone()),
                manager: plan.as_ref().map(|p| p.manager.name().into()),
                download_url: tool.download_url.into(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(id: &str, os: Os, managers: &[Manager], e: Elevation) -> Option<InstallPlan> {
        install_plan(find(id).unwrap(), os, managers, e)
    }

    fn cmd(p: &Option<InstallPlan>) -> &str {
        &p.as_ref().unwrap().display_command
    }

    #[test]
    fn catalog_ids_are_unique_and_complete() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|t| t.id).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
        assert!((9..=12).contains(&n));
        for t in CATALOG {
            assert!(!t.name.is_empty() && !t.binaries.is_empty(), "{}", t.id);
            assert!(
                t.purpose.ends_with('.') && t.purpose.len() < 140,
                "{}",
                t.id
            );
            assert!(t.download_url.starts_with("https://"), "{}", t.id);
            assert!(!t.purpose.contains("Armada"), "{}", t.id);
        }
        assert!(find("git").unwrap().recommended);
        assert_eq!(CATALOG.iter().filter(|t| t.recommended).count(), 1);
        assert!(find("nope").is_none());
        assert!(find("git; rm -rf /").is_none());
    }

    #[test]
    fn every_command_is_fixed_words_without_shell_characters() {
        let all_managers: Vec<Manager> = Manager::ALL.to_vec();
        for t in CATALOG {
            for os in [Os::Windows, Os::Mac, Os::Linux] {
                for e in [Elevation::Root, Elevation::Sudo] {
                    // Each manager on its own, so every package list is covered.
                    let mut sets: Vec<Vec<Manager>> =
                        all_managers.iter().map(|m| vec![*m]).collect();
                    sets.push(all_managers.clone());
                    for set in sets {
                        let Some(p) = install_plan(t, os, &set, e) else {
                            continue;
                        };
                        for word in std::iter::once(&p.program).chain(p.args.iter()) {
                            assert!(!word.is_empty());
                            assert!(
                                word.chars().all(|c| c.is_ascii_alphanumeric()
                                    || matches!(c, '-' | '.' | '_' | '+' | '@')),
                                "{}: unsafe word {word:?}",
                                t.id
                            );
                        }
                        assert!(!matches!(
                            p.program.as_str(),
                            "sh" | "bash" | "cmd" | "curl" | "powershell"
                        ));
                        let words: Vec<&str> = p.display_command.split(' ').collect();
                        assert_eq!(words[0], p.program);
                        assert_eq!(
                            &words[1..],
                            p.args.iter().map(String::as_str).collect::<Vec<_>>()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn winget_installs_one_package_per_command() {
        for t in CATALOG {
            assert!(t.packages.winget.len() <= 1, "{}", t.id);
        }
    }

    #[test]
    fn windows_prefers_winget_then_scoop_then_choco() {
        let all = [Manager::Choco, Manager::Scoop, Manager::Winget];
        let p = plan("git", Os::Windows, &all, Elevation::Unavailable);
        assert_eq!(p.as_ref().unwrap().manager, Manager::Winget);
        assert_eq!(
            cmd(&p),
            "winget install --exact --source winget --accept-package-agreements \
             --accept-source-agreements --id Git.Git"
        );
        let p = plan(
            "ripgrep",
            Os::Windows,
            &[Manager::Choco, Manager::Scoop],
            Elevation::Sudo,
        );
        assert_eq!(cmd(&p), "scoop install ripgrep");
        let p = plan("jq", Os::Windows, &[Manager::Choco], Elevation::Sudo);
        assert_eq!(cmd(&p), "choco install -y jq");
        assert!(plan("jq", Os::Windows, &[], Elevation::Sudo).is_none());
        // Never sudo on Windows.
        assert!(!cmd(&plan(
            "git",
            Os::Windows,
            &[Manager::Winget],
            Elevation::Sudo
        ))
        .contains("sudo"));
    }

    #[test]
    fn mac_uses_brew_and_git_falls_back_to_apple_tools() {
        let p = plan("git", Os::Mac, &[Manager::Brew], Elevation::Sudo);
        assert_eq!(cmd(&p), "brew install git");
        let p = plan("git", Os::Mac, &[], Elevation::Sudo);
        assert_eq!(cmd(&p), "xcode-select --install");
        assert_eq!(p.unwrap().manager, Manager::XcodeSelect);
        // Without Homebrew everything else gets the download page.
        assert!(plan("ripgrep", Os::Mac, &[], Elevation::Sudo).is_none());
        assert!(plan("jq", Os::Mac, &[], Elevation::Sudo).is_none());
        // Build tools always come from Apple, even with Homebrew.
        let p = plan("build", Os::Mac, &[Manager::Brew], Elevation::Sudo);
        assert_eq!(cmd(&p), "xcode-select --install");
        // Docker has no package route.
        assert!(plan("docker", Os::Mac, &[Manager::Brew], Elevation::Sudo).is_none());
        // Tailscale only has a package on Windows.
        assert!(plan("tailscale", Os::Mac, &[Manager::Brew], Elevation::Sudo).is_none());
    }

    #[test]
    fn linux_uses_sudo_unless_root() {
        let p = plan("git", Os::Linux, &[Manager::Apt], Elevation::Sudo).unwrap();
        assert_eq!(p.program, "sudo");
        assert_eq!(p.args, ["apt-get", "install", "-y", "git"]);
        assert_eq!(p.display_command, "sudo apt-get install -y git");
        let p = plan("git", Os::Linux, &[Manager::Apt], Elevation::Root).unwrap();
        assert_eq!(p.program, "apt-get");
        assert_eq!(p.display_command, "apt-get install -y git");
        // Not root and no sudo: no system install.
        assert!(plan("git", Os::Linux, &[Manager::Apt], Elevation::Unavailable).is_none());
    }

    #[test]
    fn linux_commands_per_manager() {
        let e = Elevation::Sudo;
        assert_eq!(
            cmd(&plan("git", Os::Linux, &[Manager::Dnf], e)),
            "sudo dnf install -y git"
        );
        assert_eq!(
            cmd(&plan("gh", Os::Linux, &[Manager::Pacman], e)),
            "sudo pacman -S --needed --noconfirm github-cli"
        );
        assert_eq!(
            cmd(&plan("jq", Os::Linux, &[Manager::Zypper], e)),
            "sudo zypper --non-interactive install jq"
        );
        assert_eq!(
            cmd(&plan("ripgrep", Os::Linux, &[Manager::Apk], e)),
            "sudo apk add ripgrep"
        );
        assert_eq!(
            cmd(&plan("node", Os::Linux, &[Manager::Apt], e)),
            "sudo apt-get install -y nodejs npm"
        );
        assert_eq!(
            cmd(&plan("build", Os::Linux, &[Manager::Pacman], e)),
            "sudo pacman -S --needed --noconfirm base-devel"
        );
    }

    #[test]
    fn linux_falls_through_to_a_manager_that_has_the_package() {
        // uv has no apt package: Homebrew on Linux (no sudo) is used when it is there.
        let p = plan(
            "uv",
            Os::Linux,
            &[Manager::Apt, Manager::Brew],
            Elevation::Sudo,
        );
        assert_eq!(cmd(&p), "brew install uv");
        assert!(plan("uv", Os::Linux, &[Manager::Apt], Elevation::Sudo).is_none());
        // With no sudo, Homebrew is still an option.
        let p = plan(
            "jq",
            Os::Linux,
            &[Manager::Apt, Manager::Brew],
            Elevation::Unavailable,
        );
        assert_eq!(cmd(&p), "brew install jq");
    }

    #[test]
    fn tools_without_a_safe_route_have_no_plan() {
        let all = Manager::ALL;
        for os in [Os::Windows, Os::Mac, Os::Linux] {
            assert!(plan("docker", os, &all, Elevation::Root).is_none());
        }
        assert!(plan("tailscale", Os::Linux, &all, Elevation::Root).is_none());
        assert!(plan("ollama", Os::Linux, &[Manager::Apt], Elevation::Root).is_none());
        assert_eq!(
            cmd(&plan(
                "tailscale",
                Os::Windows,
                &[Manager::Winget],
                Elevation::Root
            ))
            .split(' ')
            .next_back(),
            Some("Tailscale.Tailscale")
        );
    }

    #[test]
    fn build_tools_are_not_offered_on_windows() {
        let t = find("build").unwrap();
        assert!(!t.on(Os::Windows) && t.on(Os::Mac) && t.on(Os::Linux));
        assert!(plan("build", Os::Windows, &Manager::ALL, Elevation::Root).is_none());
    }

    #[test]
    fn version_parsing() {
        let v = |s: &str| parse_version(s);
        assert_eq!(v("git version 2.45.2\n").as_deref(), Some("2.45.2"));
        assert_eq!(v("git version 2.45.2.windows.1").as_deref(), Some("2.45.2"));
        assert_eq!(
            v("git version 2.39.5 (Apple Git-154)").as_deref(),
            Some("2.39.5")
        );
        assert_eq!(v("v20.11.1\n").as_deref(), Some("20.11.1"));
        assert_eq!(v("Python 3.12.3").as_deref(), Some("3.12.3"));
        assert_eq!(
            v("gh version 2.45.0 (2024-03-04)\nhttps://github.com/cli/cli/releases/tag/v2.45.0")
                .as_deref(),
            Some("2.45.0")
        );
        assert_eq!(
            v("ripgrep 14.1.0 (rev 4649aa9700)\n\nfeatures:+pcre2").as_deref(),
            Some("14.1.0")
        );
        assert_eq!(v("jq-1.7.1").as_deref(), Some("1.7.1"));
        assert_eq!(
            v("uv 0.4.18 (a1b2c3d 2024-10-01)").as_deref(),
            Some("0.4.18")
        );
        assert_eq!(
            v("Docker version 27.3.1, build ce12230").as_deref(),
            Some("27.3.1")
        );
        assert_eq!(
            v("GNU Make 4.3\nBuilt for x86_64-pc-linux-gnu").as_deref(),
            Some("4.3")
        );
        assert_eq!(
            v("1.76.1\n  tailscale commit: abc").as_deref(),
            Some("1.76.1")
        );
        assert_eq!(
            v("Warning: could not connect to a running Ollama instance\nWarning: client version is 0.3.12")
                .as_deref(),
            Some("0.3.12")
        );
        assert_eq!(v(""), None);
        assert_eq!(
            v("Python was not found; run without arguments to install from the Microsoft Store"),
            None
        );
        assert_eq!(v("build 20241001"), None);
    }

    #[test]
    fn python_must_be_version_3() {
        let py = find("python").unwrap();
        assert!(major_matches(py, "3.12.3"));
        assert!(!major_matches(py, "2.7.18"));
        assert!(major_matches(find("git").unwrap(), "2.45.2"));
    }

    #[test]
    fn unknown_ids_have_no_plan() {
        let r = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let err = r.block_on(plan_for("rm -rf /")).unwrap_err();
        assert!(err.contains("isn't on the list"));
    }

    #[test]
    fn list_matches_the_catalog_and_finishes_quickly() {
        let r = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let start = std::time::Instant::now();
        let list = r.block_on(list());
        assert!(start.elapsed() < Duration::from_secs(5));
        let os = Os::current();
        assert_eq!(list.len(), CATALOG.iter().filter(|t| t.on(os)).count());
        for c in &list {
            assert_eq!(c.installable, c.install_command.is_some());
            assert!(c.installed || c.version.is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_gives_up_on_a_program_that_hangs() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("kvistcode-companion-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let hang = dir.join("hang");
        std::fs::write(&hang, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o755)).unwrap();
        let quick = dir.join("quick");
        std::fs::write(&quick, "#!/bin/sh\necho 'quick version 1.2.3'\n").unwrap();
        std::fs::set_permissions(&quick, std::fs::Permissions::from_mode(0o755)).unwrap();
        let r = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // A shim with no version selected: errors out, so it isn't an installed tool.
        let broken = dir.join("broken");
        std::fs::write(&broken, "#!/bin/sh\necho 'no version set' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = std::time::Instant::now();
        assert!(matches!(r.block_on(probe(&hang)), Probe::Slow));
        assert!(start.elapsed() < Duration::from_secs(4));
        let Probe::Ran(out) = r.block_on(probe(&quick)) else {
            panic!("the quick program ran");
        };
        assert_eq!(parse_version(&out).as_deref(), Some("1.2.3"));
        assert!(matches!(r.block_on(probe(&broken)), Probe::Failed));
        assert!(matches!(
            r.block_on(probe(&dir.join("missing"))),
            Probe::Failed
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_install_runs_only_the_command_that_was_confirmed() {
        let p = plan("git", Os::Linux, &[Manager::Apt], Elevation::Sudo).unwrap();
        let shown = p.display_command.clone();
        assert_eq!(confirmed_plan(p.clone(), &shown).unwrap(), p);
        // The options changed between the dialog and the click (another manager, root or not).
        for stale in [
            "sudo dnf install -y git",
            "apt-get install -y git",
            "sudo apt-get install -y git ",
            "",
        ] {
            let err = confirmed_plan(p.clone(), stale).unwrap_err();
            assert_eq!(
                err,
                "The install options changed. Check again and try once more."
            );
        }
    }

    #[test]
    fn unknown_and_flag_like_ids_are_refused_before_anything_else() {
        let r = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        for id in ["-rf", "--help", "", "git ", "GIT", "../git", "git;ls"] {
            let err = r
                .block_on(confirmed_plan_for(id, "sudo apt-get install -y git"))
                .unwrap_err();
            assert!(err.contains("isn't on the list"), "{id:?}: {err}");
        }
    }

    #[cfg(unix)]
    mod trusted {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        #[cfg(unix)]
        #[test]
        fn only_root_owned_files_nobody_else_can_write_pass() {
            assert!(safe_owner_and_mode(0, 0o100755));
            assert!(safe_owner_and_mode(0, 0o104755)); // setuid sudo
            assert!(!safe_owner_and_mode(1000, 0o100755));
            assert!(!safe_owner_and_mode(0, 0o100775)); // group-writable
            assert!(!safe_owner_and_mode(0, 0o100757)); // world-writable
            assert!(!safe_owner_and_mode(0, 0o100777));
        }

        fn scratch() -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("kvistcode-trust-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn file(dir: &Path, name: &str, mode: u32) {
            let f = dir.join(name);
            std::fs::write(&f, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).unwrap();
        }

        #[cfg(unix)]
        #[test]
        fn a_file_in_a_folder_the_person_owns_is_never_trusted_as_root() {
            let dir = scratch();
            file(&dir, "sudo", 0o755);
            file(&dir, "loose", 0o777);
            file(&dir, "plain", 0o644);
            // SAFETY: geteuid has no preconditions and cannot fail.
            let root = unsafe { libc::geteuid() } == 0;
            // Owned by us: only acceptable when we are root ourselves.
            assert_eq!(trusted_in("sudo", &[&dir]).is_some(), root);
            // Writable by anyone, or not runnable: never.
            assert!(trusted_in("loose", &[&dir]).is_none());
            assert!(trusted_in("plain", &[&dir]).is_none());
            assert!(trusted_in("absent", &[&dir]).is_none());
            // A name is a name, not a path.
            for bad in ["", "../sudo", "/usr/bin/sudo", "a/b"] {
                assert!(trusted_in(bad, &[&dir]).is_none(), "{bad:?}");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[cfg(unix)]
        #[test]
        fn a_trusted_name_comes_from_the_first_folder_that_has_it() {
            let (a, b) = (scratch(), scratch());
            file(&a, "tool", 0o777); // unsafe: skipped
            file(&b, "tool", 0o755);
            // SAFETY: geteuid has no preconditions and cannot fail.
            if unsafe { libc::geteuid() } == 0 {
                assert_eq!(trusted_in("tool", &[&a, &b]), Some(b.join("tool")));
            } else {
                assert!(trusted_in("tool", &[&a, &b]).is_none());
            }
            let _ = std::fs::remove_dir_all(&a);
            let _ = std::fs::remove_dir_all(&b);
        }

        #[cfg(unix)]
        #[test]
        fn the_system_paths_never_come_from_path() {
            // Whatever PATH holds, the answer is a file in one of the fixed system folders.
            for name in ["sudo", "apt-get", "pacman", "dnf"] {
                if let Some(p) = trusted_system_program(name) {
                    assert!(p.is_absolute());
                    assert!(
                        TRUSTED_DIRS
                            .iter()
                            .any(|d| p.parent() == Some(Path::new(d))),
                        "{p:?}"
                    );
                }
            }
        }

        #[cfg(unix)]
        #[test]
        fn administrator_installs_run_absolute_paths_for_sudo_and_the_manager() {
            let p = install_plan(
                find("git").unwrap(),
                Os::Linux,
                &[Manager::Apt],
                Elevation::Sudo,
            )
            .unwrap();
            match run_command(&p) {
                Ok((exe, args)) => {
                    assert!(exe.is_absolute() && exe.ends_with("sudo"));
                    assert!(Path::new(&args[0]).is_absolute());
                    assert!(args[0].ends_with("apt-get"));
                    assert_eq!(args[1..], p.args[1..]);
                }
                // No safe sudo or apt-get on this machine: refused, not looked up on PATH.
                Err(e) => assert!(e.contains("isn't available"), "{e}"),
            }
            // A plan whose first argument is not its package manager is not run.
            let mut odd = p.clone();
            odd.args[0] = "evil".into();
            assert!(run_command(&odd).is_err());
        }
    }
}
