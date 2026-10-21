//! 连续只读工具的有界并发；其他调用在批次之间形成串行屏障。

use super::*;

impl Engine {
    pub(crate) async fn parallel_read_width(&self, cell: &Cell) -> usize {
        // hooks 可能改参或写入，有限输出与重复失败门禁依赖逐调用结算。
        if !self.extensions.hooks.is_empty()
            || cell
                .state
                .lock()
                .await
                .active
                .as_ref()
                .is_some_and(|active| !active.hooks.is_empty())
            || self.limits.max_output_bytes != 0
            || self.limits.max_repeated_tool_failures != 0
        {
            1
        } else {
            self.extensions.policy.parallel_read_calls
        }
    }

    pub(crate) async fn parallel_read_tools(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
        calls: Vec<ToolCall>,
        tool_count: &mut usize,
        tool_limit: usize,
        steer: &mpsc::Receiver<bool>,
    ) -> anyhow::Result<usize> {
        let mut pending = Vec::with_capacity(calls.len());
        let mut admission_error = None;
        for call in calls {
            if !steer.is_empty() {
                break;
            }
            let admission = async {
                self.reserve_agent_tool_call(cell)?;
                *tool_count += 1;
                cell.state.lock().await.active.as_mut().unwrap().tool_calls = *tool_count;
                anyhow::ensure!(
                    tool_limit == 0 || *tool_count <= tool_limit,
                    "turn tool-call limit exceeded"
                );
                let (started, ready) = tokio::sync::oneshot::channel();
                let result = self
                    .start_tool(cell, cancel, call, usize::MAX, Some(started))
                    .await?;
                Ok::<_, anyhow::Error>((result, ready))
            }
            .await;
            let (result, ready) = match admission {
                Ok(pair) => pair,
                Err(error) => {
                    admission_error = Some(error);
                    break;
                }
            };
            pending.push(result);
            // 这里只等待意图，不等待工具完成；失败准入不得越过后继续派发。
            if ready.await.is_err() {
                break;
            }
        }
        // 任一失败也先结算全部在途读取，之后才允许模型续轮或下一串行调用。
        // TaskTracker 继续负责父 Turn 被取消时的收尾与 UNKNOWN 记录。
        let results = futures_util::future::join_all(pending).await;
        let mut bytes = 0;
        for result in results {
            bytes += result??;
        }
        if let Some(error) = admission_error {
            return Err(error);
        }
        Ok(bytes)
    }
}
