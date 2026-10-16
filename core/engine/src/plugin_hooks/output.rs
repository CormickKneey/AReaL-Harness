//! Single-handler output semantics pinned to Codex 0.162.1 (092d3acd).
//! No execution, approval persistence, aggregation, spilling, or replay lives here.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "decision", rename_all = "camelCase")]
pub enum PermissionDecision {
    Allow,
    Deny { reason: String },
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HookOutput {
    pub context: Option<String>,
    pub warning: Option<String>,
    pub block: Option<String>,
    /// continue:false. For PostToolUse this is replacement feedback, not a Turn stop.
    /// Some("") retains a stop with no supplied reason for lifecycle events.
    pub stop: Option<String>,
    pub continuation: Option<String>,
    pub updated_input: Option<Value>,
    pub permission: Option<PermissionDecision>,
    pub failed: bool,
}
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
fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}
fn reason(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn failed(event: &str) -> HookOutput {
    HookOutput {
        failed: true,
        warning: Some(format!(
            "{event} hook failed or returned unsupported output"
        )),
        ..Default::default()
    }
}
// Validate the complete wire shape before applying semantics. Optional nullable
// fields mirror serde Option; booleans accept omission but never null. Specific
// event names use the shared enum, intentionally not an event-specific const.
fn shape(event: &str, v: &Value) -> bool {
    let Some(object) = v.as_object() else {
        return false;
    };
    for (key, value) in object {
        let valid = match key.as_str() {
            "systemMessage" => value.is_null() || value.is_string(),
            "continue" | "suppressOutput" if event != "Interrupt" => value.is_boolean(),
            "stopReason" if event != "Interrupt" => value.is_null() || value.is_string(),
            "reason"
                if matches!(
                    event,
                    "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SubagentStop"
                ) =>
            {
                value.is_null() || value.is_string()
            }
            "decision" if event == "PreToolUse" => {
                value.is_null() || matches!(value.as_str(), Some("approve" | "block"))
            }
            "decision"
                if matches!(
                    event,
                    "PostToolUse" | "UserPromptSubmit" | "Stop" | "SubagentStop"
                ) =>
            {
                value.is_null() || value.as_str() == Some("block")
            }
            "hookSpecificOutput"
                if matches!(
                    event,
                    "SessionStart"
                        | "SubagentStart"
                        | "PreToolUse"
                        | "PostToolUse"
                        | "PermissionRequest"
                        | "UserPromptSubmit"
                ) =>
            {
                value.is_null() || specific_shape(event, value)
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    true
}
fn specific_shape(event: &str, v: &Value) -> bool {
    let Some(object) = v.as_object() else {
        return false;
    };
    if !v["hookEventName"]
        .as_str()
        .is_some_and(|e| e != "SessionEnd" && EVENTS.contains(&e))
    {
        return false;
    }
    object.iter().all(|(key, value)| match key.as_str() {
        "hookEventName" => true,
        "additionalContext" if event != "PermissionRequest" => value.is_null() || value.is_string(),
        "permissionDecision" if event == "PreToolUse" => {
            value.is_null() || matches!(value.as_str(), Some("allow" | "deny" | "ask"))
        }
        "permissionDecisionReason" if event == "PreToolUse" => value.is_null() || value.is_string(),
        "updatedInput" if event == "PreToolUse" => true,
        "updatedMCPToolOutput" if event == "PostToolUse" => true,
        "decision" if event == "PermissionRequest" => value.is_null() || permission_shape(value),
        _ => false,
    })
}
fn permission_shape(v: &Value) -> bool {
    let Some(object) = v.as_object() else {
        return false;
    };
    matches!(v["behavior"].as_str(), Some("allow" | "deny"))
        && object.iter().all(|(key, value)| match key.as_str() {
            "behavior" | "updatedInput" | "updatedPermissions" => true,
            "interrupt" => value.is_boolean(),
            "message" => value.is_null() || value.is_string(),
            _ => false,
        })
}
pub fn parse(
    event: &str,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
    asynchronous: bool,
) -> HookOutput {
    if !EVENTS.contains(&event) {
        return failed(event);
    }
    if exit_code != Some(0) {
        let mut o = HookOutput::default();
        if exit_code == Some(2) && !asynchronous && !stderr.trim().is_empty() {
            let message = stderr.trim().to_owned();
            match event {
                "PreToolUse" | "PostToolUse" | "UserPromptSubmit" => o.block = Some(message),
                "PermissionRequest" => {
                    o.permission = Some(PermissionDecision::Deny { reason: message })
                }
                "Stop" | "SubagentStop" => o.continuation = Some(message),
                _ => return failed(event),
            }
            return o;
        }
        return failed(event);
    }
    if event == "SessionEnd" || stdout.trim().is_empty() {
        return HookOutput::default();
    }
    let raw = stdout.trim();
    let v = serde_json::from_str::<Value>(raw)
        .ok()
        .filter(|v| shape(event, v));
    let Some(v) = v else {
        if raw.starts_with(['{', '['])
            || event == "Interrupt"
            || (!asynchronous && matches!(event, "Stop" | "SubagentStop"))
        {
            return failed(event);
        }
        return HookOutput {
            context: matches!(event, "SessionStart" | "SubagentStart" | "UserPromptSubmit")
                .then(|| raw.to_owned()),
            ..Default::default()
        };
    };
    let s = &v["hookSpecificOutput"];
    let mut o = HookOutput {
        warning: text(&v["systemMessage"]),
        context: text(&s["additionalContext"]),
        ..Default::default()
    };
    // Async valid-shaped output is informational even if its control semantics
    // are unsupported. Structural malformed output was rejected above.
    if asynchronous {
        return o;
    }
    let continuing = v["continue"].as_bool().unwrap_or(true);
    let suppress = v["suppressOutput"].as_bool().unwrap_or(false);
    let block = v["decision"].as_str() == Some("block");
    let invalid_block = block && reason(&v["reason"]).is_none();
    let mut invalid = false;
    match event {
        "SessionStart" | "PreCompact" | "PostCompact" => {
            if !continuing {
                o.stop = Some(text(&v["stopReason"]).unwrap_or_default());
            }
        }
        "SubagentStart" | "Interrupt" => {}
        "PreToolUse" => {
            invalid = !continuing || !v["stopReason"].is_null() || suppress;
            let specific = !s["permissionDecision"].is_null()
                || !s["permissionDecisionReason"].is_null()
                || !s["updatedInput"].is_null();
            if specific {
                let decision = s["permissionDecision"].as_str();
                if !s["updatedInput"].is_null() && decision != Some("allow") {
                    invalid = true;
                }
                match decision {
                    Some("deny") => {
                        o.block = reason(&s["permissionDecisionReason"]);
                        invalid |= o.block.is_none();
                    }
                    Some("allow") => {
                        o.updated_input =
                            (!s["updatedInput"].is_null()).then(|| s["updatedInput"].clone());
                        invalid |= o.updated_input.is_none();
                    }
                    Some("ask") => invalid = true,
                    _ => invalid |= !s["permissionDecisionReason"].is_null(),
                }
            } else {
                invalid |= v["decision"].as_str() == Some("approve")
                    || invalid_block
                    || (v["decision"].is_null() && !v["reason"].is_null());
                if block {
                    o.block = reason(&v["reason"]);
                }
            }
        }
        "PermissionRequest" => {
            let d = &s["decision"];
            invalid = !continuing
                || !v["stopReason"].is_null()
                || suppress
                || !d["updatedInput"].is_null()
                || !d["updatedPermissions"].is_null()
                || d["interrupt"] == true;
            o.permission = match d["behavior"].as_str() {
                Some("allow") => Some(PermissionDecision::Allow),
                Some("deny") => Some(PermissionDecision::Deny {
                    reason: reason(&d["message"])
                        .unwrap_or_else(|| "PermissionRequest hook denied approval".into()),
                }),
                _ => None,
            };
        }
        "PostToolUse" => {
            invalid = suppress
                || !s["updatedMCPToolOutput"].is_null()
                || invalid_block
                || (!block && continuing && !v["reason"].is_null());
            if invalid {
                o.context = None;
            }
            if !continuing {
                o.stop = Some(
                    reason(&v["reason"])
                        .or_else(|| text(&v["stopReason"]))
                        .unwrap_or_else(|| "PostToolUse hook stopped execution".into()),
                );
                invalid = false; // Runtime gives continue:false priority over unsupported semantics.
            } else if block {
                o.block = text(&v["reason"]);
            }
        }
        "UserPromptSubmit" | "Stop" | "SubagentStop" => {
            if invalid_block {
                o.context = None;
            }
            if !continuing {
                o.stop = Some(text(&v["stopReason"]).unwrap_or_default());
            } else {
                invalid = invalid_block;
                if block {
                    if event == "UserPromptSubmit" {
                        o.block = text(&v["reason"]);
                    } else {
                        o.continuation = reason(&v["reason"]);
                    }
                }
            }
        }
        _ => unreachable!("validated event"),
    }
    if invalid {
        o.context = None;
        o.block = None;
        o.stop = None;
        o.continuation = None;
        o.updated_input = None;
        o.permission = None;
        o.failed = true;
        if o.warning.is_none() {
            o.warning = failed(event).warning;
        }
    }
    o
}
