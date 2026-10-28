//! Detects runnable project commands (package.json scripts, Cargo, Makefile, justfile,
//! pytest, Go) in a folder, for the workspace panel's Scripts tab. Detection only reads
//! files. The UI refers to a script by `id` and the shell re-detects it to get the
//! command, so the webview never supplies a command line.

use std::path::Path;

use serde::Serialize;

/// Largest manifest we read.
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Most scripts listed per source.
const MAX_PER_SOURCE: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    /// Stable id: `<source>:<name>`.
    pub id: String,
    /// Group heading: `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `make`, `just`, `python`, `go`.
    pub source: String,
    pub name: String,
    /// The command line run in a shell in the folder.
    pub command: String,
}

fn script(source: &str, name: &str, command: String) -> ProjectScript {
    ProjectScript {
        id: format!("{source}:{name}"),
        source: source.into(),
        name: name.into(),
        command,
    }
}

/// Names that are safe to put on a shell command line unquoted.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('-')
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '/' | '@' | '+')
        })
}

fn read(dir: &Path, name: &str) -> Option<String> {
    let path = dir.join(name);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

pub fn detect_scripts(dir: &Path) -> Vec<ProjectScript> {
    let mut out = Vec::new();
    out.extend(node_scripts(dir));
    out.extend(cargo_scripts(dir));
    out.extend(make_scripts(dir));
    out.extend(just_scripts(dir));
    out.extend(python_scripts(dir));
    out.extend(go_scripts(dir));
    out
}

/// The script with this id, if it is (still) detected in `dir`.
pub fn find_script(dir: &Path, id: &str) -> Option<ProjectScript> {
    detect_scripts(dir).into_iter().find(|s| s.id == id)
}

fn node_scripts(dir: &Path) -> Vec<ProjectScript> {
    let Some(raw) = read(dir, "package.json") else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    let exists = |f: &str| dir.join(f).is_file();
    let pm = if exists("pnpm-lock.yaml") {
        "pnpm"
    } else if exists("yarn.lock") {
        "yarn"
    } else if exists("bun.lockb") || exists("bun.lock") {
        "bun"
    } else {
        "npm"
    };
    scripts
        .iter()
        .filter(|(name, v)| v.is_string() && safe_name(name))
        .take(MAX_PER_SOURCE)
        .map(|(name, _)| script(pm, name, format!("{pm} run {name}")))
        .collect()
}

fn cargo_scripts(dir: &Path) -> Vec<ProjectScript> {
    if !dir.join("Cargo.toml").is_file() {
        return Vec::new();
    }
    [
        ("build", "cargo build"),
        ("test", "cargo test"),
        ("run", "cargo run"),
        ("clippy", "cargo clippy --all-targets"),
    ]
    .into_iter()
    .map(|(n, c)| script("cargo", n, c.into()))
    .collect()
}

fn make_scripts(dir: &Path) -> Vec<ProjectScript> {
    let Some(raw) = ["Makefile", "makefile", "GNUmakefile"]
        .iter()
        .find_map(|f| read(dir, f))
    else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for line in raw.lines() {
        // Recipes are indented; assignments, comments and directives aren't targets.
        if line.starts_with(['\t', ' ', '#']) {
            continue;
        }
        let Some((head, rest)) = line.split_once(':') else {
            continue;
        };
        // `X := y`, `X ::= y` and `X:=y` are variable assignments.
        if rest.starts_with('=') || rest.starts_with(":=") {
            continue;
        }
        for t in head.split_whitespace() {
            if t.starts_with('.') || t.contains('%') || t.contains('$') || !safe_name(t) {
                continue;
            }
            if !names.iter().any(|n| n == t) {
                names.push(t.to_string());
            }
        }
    }
    names
        .into_iter()
        .take(MAX_PER_SOURCE)
        .map(|n| {
            let c = format!("make {n}");
            script("make", &n, c)
        })
        .collect()
}

fn just_scripts(dir: &Path) -> Vec<ProjectScript> {
    let Some(raw) = ["justfile", "Justfile", ".justfile"]
        .iter()
        .find_map(|f| read(dir, f))
    else {
        return Vec::new();
    };
    let mut out: Vec<ProjectScript> = Vec::new();
    for line in raw.lines() {
        if line.starts_with(['\t', ' ', '#']) {
            continue;
        }
        // `name:` or `name: deps`; recipes taking parameters need arguments, so skipped.
        let Some((head, rest)) = line.split_once(':') else {
            continue;
        };
        if rest.starts_with('=') || head.contains('=') || head.contains(char::is_whitespace) {
            continue;
        }
        let name = head.trim();
        if name.starts_with('_') || name.starts_with('[') || !safe_name(name) {
            continue;
        }
        if !out.iter().any(|s| s.name == name) {
            out.push(script("just", name, format!("just {name}")));
        }
        if out.len() >= MAX_PER_SOURCE {
            break;
        }
    }
    out
}

fn python_scripts(dir: &Path) -> Vec<ProjectScript> {
    let pytest = read(dir, "pyproject.toml").is_some_and(|t| t.contains("pytest"))
        || dir.join("pytest.ini").is_file();
    if pytest {
        vec![script("python", "pytest", "python -m pytest".into())]
    } else {
        Vec::new()
    }
}

fn go_scripts(dir: &Path) -> Vec<ProjectScript> {
    if !dir.join("go.mod").is_file() {
        return Vec::new();
    }
    [
        ("test", "go test ./..."),
        ("build", "go build ./..."),
        ("vet", "go vet ./..."),
    ]
    .into_iter()
    .map(|(n, c)| script("go", n, c.into()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("armada-scripts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(d: &Path, f: &str, c: &str) {
        std::fs::write(d.join(f), c).unwrap();
    }

    fn ids(d: &Path) -> Vec<String> {
        detect_scripts(d).into_iter().map(|s| s.id).collect()
    }

    #[test]
    fn package_json_uses_the_lockfile_manager_and_skips_unsafe_names() {
        let d = tmp();
        write(
            &d,
            "package.json",
            r#"{"scripts":{"build":"vite build","dev:web":"vite","x;rm -rf":"no","--bad":"no"}}"#,
        );
        assert_eq!(ids(&d), ["npm:build", "npm:dev:web"]);
        write(&d, "pnpm-lock.yaml", "");
        let s = detect_scripts(&d);
        assert_eq!(s[0].command, "pnpm run build");
        std::fs::remove_file(d.join("pnpm-lock.yaml")).unwrap();
        write(&d, "bun.lock", "");
        assert_eq!(detect_scripts(&d)[0].command, "bun run build");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn cargo_and_go() {
        let d = tmp();
        write(&d, "Cargo.toml", "[package]\n");
        write(&d, "go.mod", "module x\n");
        let i = ids(&d);
        assert!(i.contains(&"cargo:clippy".to_string()));
        assert!(i.contains(&"go:test".to_string()));
        assert_eq!(find_script(&d, "go:test").unwrap().command, "go test ./...");
        assert!(find_script(&d, "go:nope").is_none());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn makefile_targets() {
        let d = tmp();
        write(
            &d,
            "Makefile",
            "CC := gcc\nFOO=bar\n.PHONY: all test\nall: build\n\tcc x\nbuild test: deps\n\techo\n%.o: %.c\n\tcc\n$(OUT): x\n",
        );
        assert_eq!(ids(&d), ["make:all", "make:build", "make:test"]);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn justfile_recipes_without_parameters() {
        let d = tmp();
        write(
            &d,
            "justfile",
            "set shell := [\"bash\"]\nversion := \"1\"\n# c\ndefault:\n  just --list\ntest: build\n  cargo test\ndeploy env:\n  x\n_private:\n  y\n[private]\n",
        );
        assert_eq!(ids(&d), ["just:default", "just:test"]);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn pytest_only_when_configured() {
        let d = tmp();
        write(&d, "pyproject.toml", "[project]\nname='x'\n");
        assert!(ids(&d).is_empty());
        write(&d, "pyproject.toml", "[tool.pytest.ini_options]\n");
        assert_eq!(ids(&d), ["python:pytest"]);
        std::fs::remove_dir_all(d).ok();
    }
}
