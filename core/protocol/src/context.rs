use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenerationStats {
    pub output_tokens: u64,
    pub duration_ms: u64,
    pub measured_requests: u64,
    pub unmeasured_requests: u64,
    pub usage_requests: u64,
    pub missing_usage_requests: u64,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ContextPartKind {
    SystemPrompt,
    Rules,
    Skills,
    ToolDefinitions,
    Conversation,
    Summary,
    Attachments,
    ToolResults,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextPart {
    pub kind: ContextPartKind,
    pub name: String,
    pub estimated_tokens: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ContextPart>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstructionAttribution {
    pub sha256: String,
    pub parts: Vec<ContextPart>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextBasis {
    pub provider: String,
    pub model: String,
    pub configuration_revision: u64,
    pub default_model_revision: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    pub window_tokens: usize,
    pub output_reserve_tokens: usize,
    pub input_limit_tokens: usize,
    pub window_source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextEstimate {
    pub tokens: u64,
    pub parts: Vec<ContextPart>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextScope {
    AssembledRequest { sequence: u64 },
    RecordedHistory,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ContextUnavailable {
    AwaitingRequest,
    ModelUnavailable,
    InstructionBasisChanged,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextUsage {
    Ready {
        basis: ContextBasis,
        budget: ContextBudget,
        scope: ContextScope,
        estimate: ContextEstimate,
    },
    Unavailable {
        basis: ContextBasis,
        budget: Option<ContextBudget>,
        reason: ContextUnavailable,
    },
}
