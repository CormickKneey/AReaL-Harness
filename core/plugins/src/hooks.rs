//! Declarative Codex 0.162.1 hooks; never executes commands or grants tool permission.
//! Contract: openai/codex 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d,
//! config/src/hook_config.rs and hooks/src/engine/{discovery,matcher,mcp_runner}.rs.
//! Definition digests are AReaL-private; callers must also bind the installed package digest.
use crate::{ComponentDocument, InstalledComponents, package};
use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::LazyLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEvent {
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    PreCompact,
    PostCompact,
    SessionStart,
    SessionEnd,
    UserPromptSubmit,
    SubagentStart,
    SubagentStop,
    Stop,
    Interrupt,
}
impl HookEvent {
    pub const ALL: [Self; 12] = [
        Self::PreToolUse,
        Self::PermissionRequest,
        Self::PostToolUse,
        Self::PreCompact,
        Self::PostCompact,
        Self::SessionStart,
        Self::SessionEnd,
        Self::UserPromptSubmit,
        Self::SubagentStart,
        Self::SubagentStop,
        Self::Stop,
        Self::Interrupt,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PermissionRequest => "PermissionRequest",
            Self::PostToolUse => "PostToolUse",
            Self::PreCompact => "PreCompact",
            Self::PostCompact => "PostCompact",
            Self::SessionStart => "SessionStart",
            Self::SessionEnd => "SessionEnd",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::Stop => "Stop",
            Self::Interrupt => "Interrupt",
        }
    }
    fn ignores_matcher(self) -> bool {
        matches!(self, Self::UserPromptSubmit | Self::Stop | Self::Interrupt)
    }
    fn tool_event(self) -> bool {
        matches!(
            self,
            Self::PreToolUse | Self::PermissionRequest | Self::PostToolUse
        )
    }
    fn has_context(self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PostToolUse
                | Self::SessionStart
                | Self::UserPromptSubmit
                | Self::SubagentStart
        )
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HookHandler {
    Command {
        command: String,
        command_windows: Option<String>,
    },
    Mcp {
        server: String,
        tool: String,
        input: Value,
    },
}
impl HookHandler {
    /// Expand only MCP argument values. Whole placeholders preserve JSON types;
    /// keys, canonical tool names and shell command text are never rewritten here.
    pub fn render_input(&self, event_input: &Value) -> Result<Value> {
        match self {
            Self::Mcp { input, .. } => render_value(input, event_input),
            Self::Command { .. } => anyhow::bail!("command hook has no MCP input template"),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct HookDefinition {
    pub id: String,
    pub digest: String,
    pub origin: String,
    pub event: HookEvent,
    pub matcher: Option<String>,
    pub handler: HookHandler,
    pub timeout_secs: u64,
    pub status_message: Option<String>,
    pub additional_context_limit: Option<usize>,
    pub r#async: bool,
    #[serde(skip)]
    compiled: Matcher,
}
impl HookDefinition {
    /// Candidates contain the event's tool/source/reason/agent-type/trigger value.
    /// Legacy aliases are matching-only and never alter the input delivered to a hook.
    pub fn matches(&self, event: HookEvent, candidates: &[&str]) -> bool {
        if self.event != event {
            return false;
        }
        if self.compiled.matches(None) {
            return true;
        }
        candidates.iter().any(|candidate| {
            self.compiled.matches(Some(candidate))
                || event.tool_event()
                    && aliases(candidate)
                        .iter()
                        .any(|alias| self.compiled.matches(Some(alias)))
        })
    }
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct HookPlan {
    pub entries: Vec<HookDefinition>,
    pub diagnostics: Vec<String>,
}
#[derive(Clone, Debug)]
enum Matcher {
    All,
    Exact(String),
    Regex(Regex),
}
impl Matcher {
    fn new(pattern: Option<&str>) -> Result<Self> {
        Ok(match pattern {
            None | Some("" | "*") => Self::All,
            Some(p)
                if p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '|') =>
            {
                Self::Exact(p.into())
            }
            Some(p) => Self::Regex(Regex::new(p)?),
        })
    }
    fn matches(&self, value: Option<&str>) -> bool {
        match self {
            Self::All => true,
            Self::Exact(p) => value.is_some_and(|v| p.split('|').any(|p| p == v)),
            Self::Regex(p) => value.is_some_and(|v| p.is_match(v)),
        }
    }
}
fn aliases(name: &str) -> &'static [&'static str] {
    match name {
        "apply_patch" => &["Write", "Edit"],
        "spawn_agent" => &["Agent"],
        "shell" => &["Bash"],
        _ => &[],
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    #[serde(default, rename = "description")]
    _description: Option<String>,
    #[serde(default)]
    hooks: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
struct Group {
    #[serde(default)]
    matcher: Option<String>,
    #[serde(default)]
    hooks: Vec<Handler>,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Handler {
    #[serde(rename = "command")]
    Command {
        command: String,
        #[serde(default, rename = "commandWindows", alias = "command_windows")]
        command_windows: Option<String>,
        #[serde(default)]
        timeout: Option<u64>,
        #[serde(default)]
        r#async: bool,
        #[serde(default, rename = "statusMessage")]
        status_message: Option<String>,
        #[serde(default, rename = "additionalContextLimit")]
        additional_context_limit: Option<usize>,
    },
    #[serde(rename = "mcp_tool")]
    Mcp {
        server: String,
        tool: String,
        #[serde(default, deserialize_with = "mcp_input")]
        input: Map<String, Value>,
        #[serde(default)]
        timeout: Option<u64>,
        #[serde(default, rename = "statusMessage")]
        status_message: Option<String>,
    },
    #[serde(rename = "prompt")]
    Prompt {},
    #[serde(rename = "agent")]
    Agent {},
}
fn mcp_input<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Map<String, Value>, D::Error> {
    let value = Map::<String, Value>::deserialize(d)?;
    fn representable(v: &Value) -> bool {
        match v {
            Value::Null => false,
            Value::Number(n) => n.as_u64().is_none_or(|n| n <= i64::MAX as u64),
            Value::Array(v) => v.iter().all(representable),
            Value::Object(v) => v.values().all(representable),
            _ => true,
        }
    }
    if !value.values().all(representable) {
        return Err(serde::de::Error::custom(
            "MCP hook input must be representable as TOML",
        ));
    }
    Ok(value)
}
fn parse(value: &Value) -> Result<Vec<(HookEvent, Vec<Group>)>> {
    let mut file: RawFile = serde_json::from_value(value.clone())?;
    HookEvent::ALL
        .into_iter()
        .map(|event| {
            Ok((
                event,
                match file.hooks.remove(event.as_str()) {
                    Some(groups) => serde_json::from_value(groups)?,
                    None => vec![],
                },
            ))
        })
        .collect()
}

/// Fixed-release manifest normalization: valid declarations override the default;
/// empty/invalid declarations fall back, but a valid empty inline object suppresses it.
pub(crate) fn discover(
    declaration: Option<&Value>,
    files: &package::Files,
    portable: bool,
    diagnostics: &mut Vec<String>,
) -> Vec<ComponentDocument> {
    enum Source {
        Paths(Vec<String>),
        Inline(Vec<Value>),
    }
    let validate_path = |path: &str| -> Option<String> {
        let path = path.strip_prefix("./")?;
        package::relative(path).ok()
    };
    let source = match declaration {
        Some(Value::String(path)) => validate_path(path).map(|p| Source::Paths(vec![p])),
        Some(Value::Array(values)) if values.iter().all(Value::is_string) => {
            let paths: Vec<_> = values
                .iter()
                .filter_map(|v| validate_path(v.as_str().unwrap()))
                .collect();
            (!paths.is_empty()).then_some(Source::Paths(paths))
        }
        Some(value @ Value::Object(_)) if parse(value).is_ok() => {
            Some(Source::Inline(vec![value.clone()]))
        }
        Some(Value::Array(values))
            if !values.is_empty() && values.iter().all(|v| v.is_object() && parse(v).is_ok()) =>
        {
            Some(Source::Inline(values.clone()))
        }
        _ => None,
    };
    if declaration.is_some() && source.is_none() {
        diagnostics.push(
            "hooks: invalid or empty declaration; using default hooks/hooks.json when present"
                .into(),
        );
    }
    // Invalid members of a path list are ignored while valid paths still replace defaults.
    if let Some(Value::Array(values)) = declaration {
        if values.iter().all(Value::is_string)
            && values
                .iter()
                .any(|v| validate_path(v.as_str().unwrap()).is_none())
        {
            diagnostics.push(
                "hooks: ignored invalid path; paths must start with ./ and stay inside the package"
                    .into(),
            );
        }
    }
    let source = source.unwrap_or_else(|| {
        Source::Paths(if files.contains_key("hooks/hooks.json") {
            vec!["hooks/hooks.json".into()]
        } else {
            vec![]
        })
    });
    match source {
        Source::Inline(values) => values
            .into_iter()
            .enumerate()
            .map(|(index, value)| ComponentDocument {
                portable,
                origin: format!("plugin.json#hooks[{index}]"),
                value,
            })
            .collect(),
        Source::Paths(paths) => paths
            .into_iter()
            .filter_map(|origin| {
                let value = files
                    .get(&origin)
                    .ok_or_else(|| anyhow::anyhow!("missing hooks document"))
                    .and_then(|f| serde_json::from_slice::<Value>(&f.bytes).map_err(Into::into))
                    .and_then(|value| {
                        parse(&value)?;
                        Ok(value)
                    });
                match value {
                    Ok(value) => Some(ComponentDocument {
                        portable,
                        origin,
                        value,
                    }),
                    Err(error) => {
                        diagnostics.push(format!("hooks: {origin}: {error}"));
                        None
                    }
                }
            })
            .collect(),
    }
}

pub fn normalize(component: &InstalledComponents) -> Result<HookPlan> {
    normalize_documents(&component.hook_documents, &component.diagnostics)
}

pub(crate) fn normalize_documents(
    documents: &[ComponentDocument],
    diagnostics: &[String],
) -> Result<HookPlan> {
    let mut plan = HookPlan {
        entries: vec![],
        diagnostics: diagnostics
            .iter()
            .filter(|d| d.starts_with("hooks:"))
            .cloned()
            .collect(),
    };
    for document in documents {
        let groups = match parse(&document.value) {
            Ok(groups) => groups,
            Err(e) => {
                plan.diagnostics
                    .push(format!("hooks: {}: {e}", document.origin));
                continue;
            }
        };
        for (event, groups) in groups {
            for group in groups {
                let matcher = if event.ignores_matcher() {
                    None
                } else {
                    group.matcher
                };
                let compiled = match Matcher::new(matcher.as_deref()) {
                    Ok(m) => m,
                    Err(_) => {
                        plan.diagnostics.push(format!(
                            "hooks: {}: invalid {} matcher",
                            document.origin,
                            event.as_str()
                        ));
                        continue;
                    }
                };
                for handler in group.hooks {
                    let (
                        handler,
                        timeout,
                        status_message,
                        additional_context_limit,
                        runs_async,
                        identity,
                    ) = match handler {
                        Handler::Command {
                            command,
                            command_windows,
                            timeout,
                            r#async,
                            status_message,
                            additional_context_limit,
                        } => {
                            let effective = if cfg!(windows) {
                                command_windows.as_deref().unwrap_or(&command)
                            } else {
                                &command
                            };
                            if effective.trim().is_empty() {
                                plan.diagnostics.push(format!(
                                    "hooks: {}: skipping empty command",
                                    document.origin
                                ));
                                continue;
                            }
                            let timeout = timeout_for(
                                event,
                                timeout,
                                &document.origin,
                                &mut plan.diagnostics,
                            );
                            let context = if event.has_context() {
                                additional_context_limit
                            } else {
                                if additional_context_limit.is_some() {
                                    plan.diagnostics.push(format!(
                                        "hooks: {}: ignoring additionalContextLimit for {}",
                                        document.origin,
                                        event.as_str()
                                    ));
                                }
                                None
                            };
                            let runs_async = r#async && event != HookEvent::SessionEnd;
                            if r#async && !runs_async {
                                plan.diagnostics.push(format!(
                                    "hooks: {}: running async SessionEnd hook synchronously",
                                    document.origin
                                ));
                            }
                            let mut identity = json!({"type":"command","command":effective,"timeout":timeout,"async":r#async});
                            if let Some(status) = &status_message {
                                identity["statusMessage"] = json!(status);
                            }
                            if let Some(limit) = context.filter(|limit| *limit != 2500) {
                                identity["additionalContextLimit"] = json!(limit);
                            }
                            (
                                HookHandler::Command {
                                    command,
                                    command_windows,
                                },
                                timeout,
                                status_message,
                                context,
                                runs_async,
                                identity,
                            )
                        }
                        Handler::Mcp {
                            server,
                            tool,
                            input,
                            timeout,
                            status_message,
                        } => {
                            if event == HookEvent::SessionEnd {
                                plan.diagnostics.push(format!(
                                    "hooks: {}: SessionEnd MCP hooks are not supported",
                                    document.origin
                                ));
                                continue;
                            }
                            if server.trim().is_empty() || tool.trim().is_empty() {
                                plan.diagnostics.push(format!(
                                    "hooks: {}: MCP server and tool must not be empty",
                                    document.origin
                                ));
                                continue;
                            }
                            let timeout = timeout_for(
                                event,
                                timeout,
                                &document.origin,
                                &mut plan.diagnostics,
                            );
                            let mut identity = json!({"type":"mcp_tool","server":server,"tool":tool,"input":input,"timeout":timeout});
                            if let Some(status) = &status_message {
                                identity["statusMessage"] = json!(status);
                            }
                            (
                                HookHandler::Mcp {
                                    server,
                                    tool,
                                    input: Value::Object(input),
                                },
                                timeout,
                                status_message,
                                None,
                                false,
                                identity,
                            )
                        }
                        Handler::Prompt {} | Handler::Agent {} => {
                            let kind = if matches!(handler, Handler::Prompt {}) {
                                "prompt"
                            } else {
                                "agent"
                            };
                            plan.diagnostics.push(format!(
                                "hooks: {}: {kind} hooks are not supported",
                                document.origin
                            ));
                            continue;
                        }
                    };
                    // Config-derived identity intentionally excludes source position/package bytes.
                    // The Core trust record binds this hash together with component.digest.
                    let identity =
                        json!({"event":event.as_str(),"matcher":matcher,"handler":identity});
                    let digest = format!(
                        "sha256:{:x}",
                        Sha256::digest(serde_json::to_vec(&identity)?)
                    );
                    plan.entries.push(HookDefinition {
                        id: digest.clone(),
                        digest,
                        origin: document.origin.clone(),
                        event,
                        matcher: matcher.clone(),
                        handler,
                        timeout_secs: timeout,
                        status_message,
                        additional_context_limit,
                        r#async: runs_async,
                        compiled: compiled.clone(),
                    });
                }
            }
        }
    }
    Ok(plan)
}
fn timeout_for(
    event: HookEvent,
    value: Option<u64>,
    origin: &str,
    diagnostics: &mut Vec<String>,
) -> u64 {
    if matches!(event, HookEvent::SessionEnd | HookEvent::Interrupt) {
        if value.is_some_and(|v| v > 3) {
            diagnostics.push(format!(
                "hooks: {origin}: clamping {} timeout to 3 seconds",
                event.as_str()
            ));
        }
        value.unwrap_or(1).clamp(1, 3)
    } else {
        value.unwrap_or(600).max(1)
    }
}
fn render_value(value: &Value, input: &Value) -> Result<Value> {
    match value {
        Value::Object(map) => Ok(Value::Object(
            map.iter()
                .map(|(k, v)| Ok((k.clone(), render_value(v, input)?)))
                .collect::<Result<_>>()?,
        )),
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|v| render_value(v, input))
                .collect::<Result<_>>()?,
        )),
        Value::String(text) => {
            static PATTERN: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"\$\{([^{}]+)\}").expect("static placeholder regex"));
            let captures: Vec<_> = PATTERN.captures_iter(text).collect();
            let path = |path: &str| -> Result<Value> {
                path.split('.')
                    .try_fold(input, |value, key| {
                        value.get(key).with_context(|| {
                            format!("hook input placeholder ${{{path}}} was not found")
                        })
                    })
                    .cloned()
            };
            if captures.len() == 1
                && captures[0]
                    .get(0)
                    .is_some_and(|m| m.start() == 0 && m.end() == text.len())
            {
                return path(&captures[0][1]);
            }
            let mut rendered = String::new();
            let mut offset = 0;
            for capture in captures {
                let m = capture.get(0).context("invalid template capture")?;
                rendered.push_str(&text[offset..m.start()]);
                let value = path(&capture[1])?;
                match value {
                    Value::String(value) => rendered.push_str(&value),
                    value => rendered.push_str(&serde_json::to_string(&value)?),
                }
                offset = m.end();
            }
            rendered.push_str(&text[offset..]);
            Ok(Value::String(rendered))
        }
        _ => Ok(value.clone()),
    }
}
