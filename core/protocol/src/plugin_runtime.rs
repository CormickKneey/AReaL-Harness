//! Typed desktop MCP boundaries shared with generated schemas. Secrets remain trusted launch inputs.
use serde_json::Value;
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResult {
    pub thread_id: String,
    pub call_id: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub request_id: String,
    pub id: String,
    pub expected_digest: String,
    pub connect: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Auth {
    pub id: String,
    pub server: String,
    pub operation: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connector {
    pub request_id: String,
    pub id: String,
    pub connector_id: String,
    pub provider: String,
    pub credential_ref: String,
    pub expected_digest: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Apps {
    pub thread_id: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Open {
    pub thread_id: String,
    pub server_id: String,
    pub expected_generation: u64,
    pub tool_name: String,
    pub arguments: Option<Value>,
    pub request_id: String,
    pub file_resource: Option<Value>,
    pub deep_link: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppRequest {
    pub thread_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub request: Value,
    pub request_id: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Close {
    pub thread_id: String,
    pub instance_id: String,
    pub generation: u64,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Extension {
    pub thread_id: String,
    pub server_id: String,
    pub expected_generation: u64,
    pub kind: String,
    pub arguments: Value,
    pub request_id: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Forms {
    pub thread_id: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Respond {
    pub thread_id: String,
    pub request_id: String,
    pub response: Value,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub thread_id: String,
    pub request_id: String,
    pub target: Value,
}
