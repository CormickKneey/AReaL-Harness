//! Planned observable failures: hooks hidden behind unsupported diagnostics; explicit
//! declarations accidentally merge defaults/legacy overlays; malformed config admits
//! execution; timeout seconds/defaults drift; regex/aliases double-dispatch or rewrite
//! event input; MCP recursive interpolation loses JSON types; trust hash changes for
//! ignored/default-equivalent fields, or fails to change for effective definitions.
use areal_plugins::Store;
use serde_json::{Value, json};
use std::{fs, path::Path};
fn write(root: &Path, path: &str, value: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
fn package(manifest: Value, docs: &[(&str, Value)]) -> (tempfile::TempDir, Store) {
    let temp = tempfile::tempdir().unwrap();
    write(
        temp.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        temp.path(),
        "pkg/.codex-plugin/plugin.json",
        &manifest.to_string(),
    );
    for (name, value) in docs {
        write(temp.path(), &format!("pkg/{name}"), &value.to_string());
    }
    let store = Store::open(temp.path().join("state"), temp.path().into(), None).unwrap();
    let detail = store.read("sample@local").unwrap();
    store
        .install(
            &detail.id,
            "user",
            detail.revision,
            &detail.source,
            &detail.source_digest,
        )
        .unwrap();
    (temp, store)
}
#[test]
fn installed_hook_declaration_is_discoverable_without_unsupported_claim() {
    let (_temp, store) = package(
        json!({"name":"sample"}),
        &[(
            "hooks/hooks.json",
            json!({"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo reviewed"}]}]}}),
        )],
    );
    let detail = store.read("sample@local").unwrap();
    assert!(detail.components.iter().any(|c| c == "hooks"));
    assert!(
        !detail
            .diagnostics
            .iter()
            .any(|d| d.contains("not yet supported")),
        "valid fixed-release hooks must become actionable declarations"
    );
    let component = store.enabled_components().unwrap().remove(0);
    assert!(
        !component
            .diagnostics
            .iter()
            .any(|d| d.contains("execution unsupported"))
    );
}

use areal_plugins::hooks::{HookEvent, HookHandler, normalize};
fn plan(value: Value) -> areal_plugins::hooks::HookPlan {
    let (_temp, store) = package(json!({"name":"sample"}), &[("hooks/hooks.json", value)]);
    normalize(&store.enabled_components().unwrap()[0]).unwrap()
}
#[test]
fn declaration_override_fallback_and_immutable_snapshot() {
    let default =
        json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"default"}]}]}});
    let custom =
        json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"custom"}]}]}});
    for (declaration, expected) in [
        (json!("./custom.json"), "custom"),
        (json!({"hooks":{}}), "empty"),
        (json!([]), "default"),
        (json!(false), "default"),
        (json!("bad.json"), "default"),
        (json!(["./missing.json"]), "empty"),
        (json!(["./custom.json", {}]), "default"),
    ] {
        let (temp, store) = package(
            json!({"name":"sample","hooks":declaration}),
            &[
                ("hooks/hooks.json", default.clone()),
                ("custom.json", custom.clone()),
            ],
        );
        let c = store.enabled_components().unwrap().remove(0);
        let p = normalize(&c).unwrap();
        if expected == "empty" {
            assert!(p.entries.is_empty());
        } else {
            assert_eq!(p.entries.len(), 1);
            assert!(
                matches!(&p.entries[0].handler,HookHandler::Command{command,..} if command==expected)
            );
        }
        write(temp.path(), "pkg/custom.json", "{}");
        assert_eq!(
            normalize(&store.enabled_components().unwrap()[0])
                .unwrap()
                .entries
                .len(),
            p.entries.len(),
            "installed snapshot independent of live source"
        );
    }
    // A portable inline overlay replaces the legacy overlay as a whole.
    let portable = json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","extensions":{"com.openai":{}}});
    let (_temp, store) = package(
        json!({"name":"sample","hooks":"./custom.json"}),
        &[
            ("plugin.json", portable),
            ("hooks/hooks.json", default),
            ("custom.json", custom),
        ],
    );
    assert!(
        matches!(&normalize(&store.enabled_components().unwrap()[0]).unwrap().entries[0].handler,HookHandler::Command{command,..} if command=="default")
    );
}
#[test]
fn fixed_event_matchers_aliases_timeouts_and_options() {
    let p = plan(json!({"description":"fixture","hooks":{
        "PreToolUse":[{"matcher":"Write|Edit","extra":"ignored","hooks":[{"type":"command","command":"patch","command_windows":"windows patch","timeout":0,"statusMessage":"checking","additionalContextLimit":0,"unknown":"ignored"}]},{"matcher":"^mcp__.*__write.*$","hooks":[{"type":"command","command":"regex"}]},{"matcher":"Bash","hooks":[{"type":"command","command":"shell"}]},{"matcher":"Agent","hooks":[{"type":"command","command":"spawn"}]},{"matcher":"[","hooks":[{"type":"command","command":"invalid"}]}],
        "SessionEnd":[{"matcher":"clear|other","hooks":[{"type":"command","command":"end","async":true,"timeout":99,"additionalContextLimit":8},{"type":"mcp_tool","server":"s","tool":"t"}]}],
        "Interrupt":[{"matcher":"[","hooks":[{"type":"command","command":"interrupt"}]}],
        "Stop":[{"matcher":"[","hooks":[{"type":"command","command":"stop"}]}],
        "FutureEvent":"ignored"
    }}));
    assert_eq!(p.entries.len(), 7);
    let patch = &p.entries[0];
    assert_eq!(patch.timeout_secs, 1);
    assert_eq!(patch.additional_context_limit, Some(0));
    assert_eq!(patch.status_message.as_deref(), Some("checking"));
    assert!(patch.matches(HookEvent::PreToolUse, &["apply_patch"]));
    assert!(!patch.matches(HookEvent::PostToolUse, &["apply_patch"]));
    assert!(!patch.matches(HookEvent::PreToolUse, &["WriteFile"]));
    assert!(p.entries[1].matches(HookEvent::PreToolUse, &["mcp__files__write_file"]));
    assert_eq!(p.entries[1].timeout_secs, 600);
    assert!(p.entries[2].matches(HookEvent::PreToolUse, &["shell"]));
    assert!(!p.entries[2].matches(HookEvent::PreToolUse, &["BashOutput"]));
    assert!(p.entries[3].matches(HookEvent::PreToolUse, &["spawn_agent"]));
    let end = p
        .entries
        .iter()
        .find(|d| d.event == HookEvent::SessionEnd)
        .unwrap();
    assert_eq!(end.timeout_secs, 3);
    assert!(!end.r#async);
    assert_eq!(end.additional_context_limit, None);
    assert!(end.matches(HookEvent::SessionEnd, &["clear"]));
    assert!(!end.matches(HookEvent::SessionEnd, &["startup"]));
    let interrupt = p
        .entries
        .iter()
        .find(|d| d.event == HookEvent::Interrupt)
        .unwrap();
    assert_eq!(interrupt.timeout_secs, 1);
    assert!(interrupt.matches(HookEvent::Interrupt, &[]));
    assert!(
        p.entries
            .iter()
            .find(|d| d.event == HookEvent::Stop)
            .unwrap()
            .matches(HookEvent::Stop, &[])
    );
    assert!(p.diagnostics.iter().any(|d| d.contains("matcher")));
    assert!(
        p.diagnostics
            .iter()
            .any(|d| d.contains("SessionEnd") && d.contains("MCP"))
    );
    assert!(
        p.diagnostics
            .iter()
            .any(|d| d.contains("additionalContextLimit"))
    );
}
#[test]
fn typed_mcp_templates_and_fixed_schema_rejection() {
    let p = plan(
        json!({"hooks":{"PostToolUse":[{"hooks":[{"type":"mcp_tool","server":"review","tool":"check","input":{"whole":"${tool_input}","nested":["${tool_input.count}",{"x":"result=${tool_response.ok}"}],"${tool_name}":"${tool_name}"},"timeout":12,"async":true}]}],"SessionStart":[{"hooks":[{"type":"prompt","prompt":"ignored"},{"type":"agent"},{"type":"command","command":" "}]}]}}),
    );
    assert_eq!(p.entries.len(), 1);
    assert!(!p.entries[0].r#async);
    assert_eq!(p.entries[0].timeout_secs, 12);
    let rendered=p.entries[0].handler.render_input(&json!({"tool_name":"apply_patch","tool_input":{"count":3,"flag":true},"tool_response":{"ok":false}})).unwrap();
    assert_eq!(
        rendered,
        json!({"whole":{"count":3,"flag":true},"nested":[3,{"x":"result=false"}],"${tool_name}":"apply_patch"})
    );
    assert!(
        p.entries[0]
            .handler
            .render_input(&json!({"tool_name":"apply_patch"}))
            .is_err()
    );
    assert!(p.diagnostics.iter().any(|d| d.contains("prompt")));
    assert!(p.diagnostics.iter().any(|d| d.contains("agent")));
    for invalid in [
        json!({"hooks":{},"unknown":1}),
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"valid"},{"type":"new_handler"}]}]}}),
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t","input":{"x":null}}]}]}}),
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"c","timeout":1.5}]}]}}),
    ] {
        let p = plan(invalid);
        assert!(p.entries.is_empty());
        assert!(!p.diagnostics.is_empty());
    }
    let missing = plan(
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t","input":{"v":"${items.0}"}}]}]}}),
    );
    assert!(
        missing.entries[0]
            .handler
            .render_input(&json!({"items":["a"]}))
            .is_err(),
        "fixed path resolver does not index arrays"
    );
}
#[test]
fn definition_digest_tracks_effective_identity_not_package_or_ignored_fields() {
    let def = |extra: Value| {
        let mut handler = json!({"type":"command","command":"echo unchanged"});
        handler
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        plan(json!({"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[handler]}]}}))
            .entries
            .remove(0)
    };
    let original = def(json!({}));
    for equivalent in [
        json!({"timeout":600}),
        json!({"additionalContextLimit":2500}),
        json!({"ignored":"different"}),
    ] {
        assert_eq!(original.digest, def(equivalent).digest);
    }
    for changed in [
        json!({"timeout":601}),
        json!({"additionalContextLimit":0}),
        json!({"command":"different"}),
        json!({"async":true}),
        json!({"statusMessage":"changed"}),
    ] {
        assert_ne!(original.digest, def(changed).digest);
    }
    assert_eq!(original.id, original.digest);
    let other = plan(
        json!({"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo unchanged"}]}]}}),
    );
    assert_ne!(original.digest, other.entries[0].digest);
}
