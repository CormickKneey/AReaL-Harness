// Fixed Codex 092d3acd behavioral cases, selected before implementation.
// Distinguish fail-open invalid decisions from effective controls, stderr exit2
// from stdout, strict wire shape from permissive known event-name enum, and
// async informational output from synchronous effects. This does not execute hooks.
#[path = "../src/plugin_hooks/output.rs"]
mod output;
use output::{PermissionDecision, parse};
use serde_json::json;
const EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "SubagentStart",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "Interrupt",
];
#[test]
fn exits_are_event_specific_and_do_not_parse_nonzero_stdout() {
    for event in EVENTS {
        let o = parse(event, Some(0), "", "ignored", false);
        assert!(!o.failed, "{event}");
        for code in [None, Some(1), Some(3), Some(2)] {
            let o = parse(event, code, r#"{"continue":false}"#, "", false);
            assert!(o.failed, "{event}");
            assert!(
                o.stop.is_none()
                    && o.block.is_none()
                    && o.permission.is_none()
                    && o.continuation.is_none()
            );
        }
        let o = parse(event, Some(2), "{invalid", " reason ", false);
        match *event {
            "PreToolUse" | "PostToolUse" | "UserPromptSubmit" => {
                assert_eq!(o.block.as_deref(), Some("reason"))
            }
            "PermissionRequest" => assert!(
                matches!(o.permission,Some(PermissionDecision::Deny{ref reason}) if reason=="reason")
            ),
            "Stop" | "SubagentStop" => assert_eq!(o.continuation.as_deref(), Some("reason")),
            _ => assert!(o.failed, "{event}"),
        }
        let a = parse(event, Some(2), "", "reason", true);
        assert!(
            a.failed && a.block.is_none() && a.permission.is_none() && a.continuation.is_none()
        );
    }
}
#[test]
fn plain_and_structural_json_boundaries() {
    for event in EVENTS {
        let o = parse(event, Some(0), " plain ", "", false);
        assert_eq!(
            o.context.as_deref(),
            if matches!(
                *event,
                "SessionStart" | "SubagentStart" | "UserPromptSubmit"
            ) {
                Some("plain")
            } else {
                None
            }
        );
        assert_eq!(
            o.failed,
            matches!(*event, "Stop" | "SubagentStop" | "Interrupt")
        );
        for raw in [
            "[]",
            "{",
            r#"{"unknown":true}"#,
            r#"{"systemMessage":123}"#,
            r#"{"continue":null}"#,
        ] {
            assert_eq!(
                parse(event, Some(0), raw, "", false).failed,
                *event != "SessionEnd",
                "{event}: {raw}"
            );
        }
    }
    assert!(!parse("Stop", Some(0), "plain", "", true).failed);
    assert!(parse("Stop", Some(0), "[]", "", true).failed);
    assert!(parse("unknown", Some(0), "", "", false).failed);
}
#[test]
fn pre_tool_specific_precedence_rewrite_is_not_permission() {
    let s = json!({"decision":"block","reason":"legacy","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"new"}}});
    let o = parse("PreToolUse", Some(0), &s.to_string(), "", false);
    assert_eq!(o.updated_input, Some(json!({"command":"new"})));
    assert!(o.block.is_none() && o.permission.is_none() && !o.failed);
    for specific in [
        json!({"permissionDecision":"ask"}),
        json!({"permissionDecision":"allow"}),
        json!({"permissionDecision":"deny","permissionDecisionReason":" "}),
        json!({"updatedInput":{}}),
        json!({"permissionDecisionReason":"orphan"}),
        json!({"permissionDecision":"deny","permissionDecisionReason":"deny","updatedInput":{}}),
    ] {
        let mut s = specific;
        s["hookEventName"] = json!("PreToolUse");
        s["additionalContext"] = json!("ctx");
        let raw = json!({"systemMessage":"notice","hookSpecificOutput":s}).to_string();
        let o = parse("PreToolUse", Some(0), &raw, "", false);
        assert!(
            o.failed && o.context.is_none() && o.block.is_none() && o.updated_input.is_none(),
            "{raw}"
        );
        assert_eq!(o.warning.as_deref(), Some("notice"));
        let a = parse("PreToolUse", Some(0), &raw, "", true);
        assert!(!a.failed && a.block.is_none() && a.updated_input.is_none());
        assert_eq!(a.context.as_deref(), Some("ctx"));
    }
    for raw in [
        r#"{"decision":"approve"}"#,
        r#"{"reason":"orphan"}"#,
        r#"{"continue":false}"#,
        r#"{"stopReason":""}"#,
        r#"{"suppressOutput":true}"#,
    ] {
        assert!(parse("PreToolUse", Some(0), raw, "", false).failed);
    }
    let o = parse(
        "PreToolUse",
        Some(0),
        r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":" no "}}"#,
        "",
        false,
    );
    assert_eq!(o.block.as_deref(), Some("no"));
}
#[test]
fn permission_reserved_fields_fall_back_without_grants() {
    for extra in [
        json!({"updatedInput":{}}),
        json!({"updatedPermissions":[]}),
        json!({"interrupt":true}),
    ] {
        let mut decision = extra;
        decision["behavior"] = json!("allow");
        let raw =
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":decision}})
                .to_string();
        let o = parse("PermissionRequest", Some(0), &raw, "", false);
        assert!(o.failed && o.permission.is_none());
    }
    for behavior in ["allow", "deny"] {
        let raw=json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":behavior,"message":" ","updatedInput":null,"interrupt":false}}}).to_string();
        let o = parse("PermissionRequest", Some(0), &raw, "", false);
        assert!(!o.failed);
        match o.permission.unwrap() {
            PermissionDecision::Allow => assert_eq!(behavior, "allow"),
            PermissionDecision::Deny { reason } => {
                assert_eq!(reason, "PermissionRequest hook denied approval")
            }
        }
        assert!(
            parse("PermissionRequest", Some(0), &raw, "", true)
                .permission
                .is_none()
        );
    }
}
#[test]
fn stop_priority_and_post_feedback_do_not_conflate_control() {
    for event in ["Stop", "SubagentStop"] {
        let o = parse(
            event,
            Some(0),
            r#"{"decision":"block","reason":" retry "}"#,
            "",
            false,
        );
        assert_eq!(o.continuation.as_deref(), Some("retry"));
        let o = parse(
            event,
            Some(0),
            r#"{"continue":false,"decision":"block","reason":""}"#,
            "",
            false,
        );
        assert_eq!(o.stop, Some(String::new()));
        assert!(!o.failed && o.continuation.is_none());
    }
    let raw = r#"{"continue":false,"reason":"feedback","suppressOutput":true,"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedMCPToolOutput":{},"additionalContext":"discard"}}"#;
    let o = parse("PostToolUse", Some(0), raw, "", false);
    assert_eq!(o.stop.as_deref(), Some("feedback"));
    assert!(o.block.is_none() && o.context.is_none() && !o.failed);
    let o = parse(
        "PostToolUse",
        Some(0),
        r#"{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedMCPToolOutput":{}}}"#,
        "",
        false,
    );
    assert!(o.failed && o.block.is_none());
    let o = parse("PostToolUse", Some(0), r#"{"continue":false}"#, "", false);
    assert_eq!(
        o.stop.as_deref(),
        Some("PostToolUse hook stopped execution")
    );
}
#[test]
fn lifecycle_controls_and_shared_event_name_quirk() {
    for event in [
        "SessionStart",
        "PreCompact",
        "PostCompact",
        "UserPromptSubmit",
        "Stop",
        "SubagentStop",
    ] {
        let o = parse(
            event,
            Some(0),
            r#"{"continue":false,"stopReason":"halt"}"#,
            "",
            false,
        );
        assert_eq!(o.stop.as_deref(), Some("halt"), "{event}");
    }
    assert!(
        parse("SubagentStart", Some(0), r#"{"continue":false}"#, "", false)
            .stop
            .is_none()
    );
    for name in ["Stop", "PreToolUse", "Interrupt"] {
        let raw = json!({"hookSpecificOutput":{"hookEventName":name,"additionalContext":"ctx"}})
            .to_string();
        let o = parse("SessionStart", Some(0), &raw, "", false);
        assert_eq!(o.context.as_deref(), Some("ctx"));
    }
    for specific in [
        json!({"additionalContext":"ctx"}),
        json!({"hookEventName":"SessionEnd"}),
        json!({"hookEventName":"SessionStart","updatedInput":{}}),
    ] {
        assert!(
            parse(
                "SessionStart",
                Some(0),
                &json!({"hookSpecificOutput":specific}).to_string(),
                "",
                false
            )
            .failed
        );
    }
    assert!(parse("Stop", Some(0), r#"{"hookSpecificOutput":{}}"#, "", false).failed);
    assert!(parse("Interrupt", Some(0), r#"{"continue":true}"#, "", false).failed);
}
