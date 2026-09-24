//! 持久任务、独立通信频道与客户端控制契约。
use crate::{desktop::Question, goals::GoalUsage};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum InteractionMode {
    #[default]
    Interactive,
    Asynchronous,
    Headless,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskMode {
    Foreground,
    Scheduled,
    Background,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingForInput,
    WaitingForAgents,
    Paused,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}
impl RunStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    /// UTC Unix 秒；间隔以该时间为锚点，避免执行耗时导致漂移。
    pub at: i64,
    pub interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCreate {
    pub request_id: String,
    pub mode: TaskMode,
    pub objective: String,
    pub thread_id: Option<String>,
    pub interaction_mode: Option<InteractionMode>,
    pub schedule: Option<Schedule>,
    pub token_budget: Option<u64>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskControl {
    pub request_id: String,
    pub task_id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelReply {
    /// 回复操作的幂等键，与原问题的 questionId 分开。
    pub request_id: String,
    pub task_id: String,
    pub run_id: String,
    pub question_id: String,
    pub answers: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTarget {
    pub task_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskList {
    pub after: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelRead {
    pub task_id: String,
    pub after_sequence: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub id: String,
    /// 每次新增或状态变化递增；客户端按 id 替换，不重复追加。
    pub sequence: u64,
    pub run_id: String,
    pub author: String,
    pub kind: String,
    pub status: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub questions: Vec<Question>,
    pub required: bool,
    pub in_reply_to: Option<String>,
    pub answers: Option<BTreeMap<String, String>>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    #[serde(default)]
    pub workers: Vec<TaskWorker>,
    pub id: String,
    pub thread_id: Option<String>,
    pub goal_id: Option<String>,
    pub status: RunStatus,
    pub reason: Option<String>,
    pub scheduled_at: i64,
    pub completed_at: Option<i64>,
    pub usage: GoalUsage,
    pub wait_requested: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorker {
    pub thread_id: String,
    pub turn_id: String,
    pub status: String,
    pub settled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub revision: u64,
    pub channel_sequence: u64,
    pub owner: String,
    pub mode: TaskMode,
    pub interaction_mode: InteractionMode,
    pub objective: String,
    pub thread_id: Option<String>,
    pub schedule: Option<Schedule>,
    pub next_run_at: Option<i64>,
    pub paused: bool,
    pub cancelled: bool,
    pub token_budget: Option<u64>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
    pub runs: Vec<TaskRun>,
    pub messages: Vec<ChannelMessage>,
}
