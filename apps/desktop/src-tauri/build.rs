use std::path::PathBuf;

/// Shown if the mobile companion (apps/remote) hasn't been built yet. Only allowed in
/// debug builds, or in release builds that explicitly opt in with
/// `ARMADA_ALLOW_MISSING_REMOTE=1`.
const PLACEHOLDER: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Armada</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0D10;color:#E6EAEF;
font:16px/1.5 system-ui,sans-serif;padding:24px;text-align:center}code{color:#4FC3F7}</style></head>
<body><div><h1>Armada</h1><p>The mobile companion wasn't included in this build.<br>
Run <code>npm run build</code> in <code>apps/remote</code> and rebuild Armada.</p></div></body></html>"#;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("remote.html");
    let built = manifest_dir.join("../../remote/dist/index.html");
    println!("cargo:rerun-if-changed={}", built.display());
    println!("cargo:rerun-if-env-changed=ARMADA_ALLOW_MISSING_REMOTE");

    match std::fs::read(&built) {
        Ok(html) => std::fs::write(&out, html).expect("writing remote.html"),
        Err(e) => {
            // PROFILE is "release" for release and every profile inheriting from it.
            let release = std::env::var("PROFILE").as_deref() == Ok("release");
            let allow_missing = std::env::var("ARMADA_ALLOW_MISSING_REMOTE").as_deref() == Ok("1");
            if release && !allow_missing {
                panic!(
                    "the mobile companion is missing ({}: {e}). Build it with \
                     `npm ci && npm run build` in apps/remote, or set \
                     ARMADA_ALLOW_MISSING_REMOTE=1 to ship a placeholder page instead.",
                    built.display()
                );
            }
            println!(
                "cargo:warning=apps/remote/dist/index.html not found; embedding a placeholder \
                 mobile companion page"
            );
            std::fs::write(&out, PLACEHOLDER).expect("writing remote.html");
        }
    }
    // tauri-build links its Windows manifest (Common Controls v6) into the app binary
    // only; test binaries using `tauri::test` then die at load with
    // STATUS_ENTRYPOINT_NOT_FOUND. Have the linker embed the same manifest everywhere.
    let msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if msvc {
        let manifest = manifest_dir.join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("tauri build");
    } else {
        tauri_build::build();
    }
}
