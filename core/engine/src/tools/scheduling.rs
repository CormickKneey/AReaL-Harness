//! 连续可信读取按空闲槽补位；其他调用形成必须排空的串行屏障。

use super::*;
use futures_util::{StreamExt, stream::FuturesUnordered};

impl Engine {
    pub(crate) async fn parallel_read_width(&self, cell: &Cell) -> usize {
        // 插件 hooks 仍保守串行；有限输出与重复失败门禁依赖逐调用结算。
        if cell
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

    pub(crate) fn supports_parallel_read_call(&self, tool: &registry::RegisteredTool) -> bool {
        tool.supports_parallel_reads()
            && !self
                .extensions
                .hooks
                .iter()
                .any(|hook| hook.matcher == "*" || hook.matcher == tool.definition.name)
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
        let width = self.parallel_read_width(cell).await;
        let mut pending = FuturesUnordered::new();
        let mut calls = calls.into_iter();
        let mut admission_error = None;
        let mut stopped = false;
        let mut bytes = 0;
        loop {
            while !stopped && pending.len() < width {
                if cancel.is_cancelled() {
                    admission_error = Some(anyhow::anyhow!("cancelled"));
                    stopped = true;
                    break;
                }
                if !steer.is_empty() {
                    stopped = true;
                    break;
                }
                let Some(call) = calls.next() else { break };
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
                        stopped = true;
                        break;
                    }
                };
                pending.push(result);
                // 历史意图按模型声明顺序落盘；只等意图，不等执行完成。
                if ready.await.is_err() {
                    stopped = true;
                }
            }
            let Some(result) = pending.next().await else {
                break;
            };
            match result
                .map_err(anyhow::Error::from)
                .and_then(|result| result)
            {
                Ok(size) => bytes += size,
                Err(error) => {
                    admission_error.get_or_insert(error);
                    stopped = true;
                }
            }
            // 失败后只结算在途调用；不得补位、跨越写屏障或丢失 UNKNOWN。
        }
        if let Some(error) = admission_error {
            return Err(error);
        }
        Ok(bytes)
    }
}
