//! Pre-implementation acceptance failures: local layers missing/replaced, JSON/TOML
//! reordered, config secrets or self-trust reflected publicly, global gate ignored,
//! symlink/FIFO/oversize reads unsafe, malformed sibling poisoning valid sources.
use areal_plugins::hook_sources::configuration_sources;
use areal_plugins::hooks::HookHandler;
use std::{fs, path::Path};
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn json_hook(command: &str) -> String {
    serde_json::json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":command}]}]}})
        .to_string()
}
fn toml_hook(command: &str) -> String {
    format!(
        "[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype='command'\ncommand='{command}'\n"
    )
}
#[test]
fn cumulative_order_and_secret_independent_identity() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let work = t.path().join("work");
    write(&home.join("hooks.json"), &json_hook("user-json"));
    write(
        &home.join("config.toml"),
        &format!(
            "secret='SENTINEL_PRIVATE'\n{}\n[hooks.state.fake]\nenabled=true\ntrusted_hash='IMPORTED_TRUST'\n",
            toml_hook("user-toml")
        ),
    );
    write(&work.join(".codex/hooks.json"), &json_hook("project-json"));
    write(&work.join(".codex/config.toml"), &toml_hook("project-toml"));
    let sources = configuration_sources(&home, &work, None).unwrap();
    assert_eq!(sources.len(), 2);
    let commands: Vec<_> = sources
        .iter()
        .flat_map(|s| &s.plan.entries)
        .map(|e| match &e.handler {
            HookHandler::Command { command, .. } => command.as_str(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(
        commands,
        ["user-json", "user-toml", "project-json", "project-toml"]
    );
    assert!(
        sources
            .iter()
            .all(|s| s.plan.diagnostics.iter().any(|d| d.contains("both")))
    );
    let public = format!("{sources:?}");
    assert!(!public.contains("SENTINEL_PRIVATE"));
    assert!(!public.contains("IMPORTED_TRUST"));
    let digest = sources[0].digest.clone();
    write(
        &home.join("config.toml"),
        &format!("secret='DIFFERENT'\n{}", toml_hook("user-toml")),
    );
    assert_eq!(
        configuration_sources(&home, &work, None).unwrap()[0].digest,
        digest
    );
    write(&home.join("config.toml"), &toml_hook("changed"));
    assert_ne!(
        configuration_sources(&home, &work, None).unwrap()[0].digest,
        digest
    );
}
#[test]
fn global_gate_alias_custom_path_and_project_cannot_self_enable() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let work = t.path().join("work");
    let cfg = t.path().join("external/settings.toml");
    write(&home.join("hooks.json"), &json_hook("user"));
    write(&cfg, "[features]\ncodex_hooks=false\n");
    write(
        &work.join(".codex/config.toml"),
        &format!("[features]\nhooks=true\n{}", toml_hook("project")),
    );
    let s = configuration_sources(&home, &work, Some(&cfg)).unwrap();
    assert!(!s.is_empty());
    assert!(s.iter().all(|s| !s.enabled));
    write(&cfg, "[features]\nhooks=true\ncodex_hooks=false\n");
    assert!(
        configuration_sources(&home, &work, Some(&cfg))
            .unwrap()
            .iter()
            .all(|s| s.enabled)
    );
}
#[test]
fn unsafe_and_invalid_sources_are_diagnostic_only() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let work = t.path().join("work");
    write(&home.join("config.toml"), "secret='SENTINEL_PRIVATE\n");
    write(&work.join(".codex/hooks.json"), &json_hook("valid"));
    let outside = t.path().join("outside.json");
    write(&outside, &json_hook("must-not-follow"));
    std::os::unix::fs::symlink(&outside, home.join("hooks.json")).unwrap();
    let s = configuration_sources(&home, &work, None).unwrap();
    assert!(s[0].plan.entries.is_empty());
    assert!(!s[0].plan.diagnostics.is_empty());
    assert_eq!(s[1].plan.entries.len(), 1);
    assert!(!format!("{s:?}").contains("SENTINEL_PRIVATE"));
    fs::remove_file(home.join("hooks.json")).unwrap();
    write(&home.join("hooks.json"), &"x".repeat(1024 * 1024 + 1));
    assert!(
        configuration_sources(&home, &work, None).unwrap()[0]
            .plan
            .entries
            .is_empty()
    );
}
#[test]
fn same_folder_is_not_loaded_twice() {
    let t = tempfile::tempdir().unwrap();
    let work = t.path().join("work");
    let home = work.join(".codex");
    write(&home.join("hooks.json"), &json_hook("once"));
    write(&home.join("config.toml"), &toml_hook("inline-once"));
    let s = configuration_sources(&home, &work, None).unwrap();
    assert_eq!(s.iter().map(|s| s.plan.entries.len()).sum::<usize>(), 2);
}
