//! 可重建的工作概览；不包含历史正文、执行配置或新的持久状态。
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewRequest {
    pub filter: Option<Filter>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Filter {
    #[default]
    All,
    Active,
    Attention,
}
#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSummary {
    pub attention_ref: String,
    pub kind: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub interaction_id: Option<String>,
    pub question_id: Option<String>,
    pub summary: String,
    pub status: String,
}
#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub state: String,
    pub turn_id: Option<String>,
    pub turn_status: Option<crate::TurnStatus>,
    pub run_status: Option<crate::tasks::RunStatus>,
}
#[derive(Clone, Debug, Default, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueSummary {
    pub pending_count: usize,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub kind: String,
    pub thread_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub title: String,
    pub source_updated_at: Option<i64>,
    pub execution: Execution,
    pub attention_refs: Vec<AttentionSummary>,
    pub attention_count: usize,
    pub attention_complete: bool,
    pub result_available: bool,
    pub available_actions: Vec<String>,
    pub queue: QueueSummary,
    pub workers: Vec<crate::tasks::TaskWorker>,
    pub worker_count: usize,
    pub workers_complete: bool,
    pub summary_truncated: bool,
}
#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OverviewPage {
    pub data: Vec<WorkItem>,
    pub next_cursor: Option<String>,
    pub complete: bool,
}
