use super::extensions::{Invocation, content_items};
use super::*;
use crate::desktop::mcp_apps::page_tools::{Command, FrozenPageTool, validate_reply};
use areal_protocol::plugin_runtime::*;
use sha2::{Digest, Sha256};
use tokio::time::{Duration, Instant};

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}
fn unavailable(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::Unavailable, error.to_string())
}

impl Invocation<'_> {
    pub(super) async fn invoke_page(
        &self,
        tool: &Arc<FrozenPageTool>,
        arguments: &Value,
    ) -> rt::Result<(bool, Value)> {
        let arguments_digest = digest(arguments);
        self.edit(|execution, _| {
            execution.effective_arguments = Some(arguments.clone());
            execution.page.as_mut().unwrap().dispatch = PageDispatch::Pending {
                arguments_digest: Some(arguments_digest.clone()),
            };
        })
        .await?;
        if self.cancel.is_cancelled() || self.engine.page_live(tool).await.is_err() {
            return self
                .settle_page(
                    arguments_digest,
                    None,
                    PageReply::NoEffect {
                        reason: PageNoEffect::Closed,
                    },
                )
                .await;
        }
        let coordinates = PageCoordinates {
            thread_id: self.thread_id.into(),
            turn_id: self.turn_id.into(),
            call_id: self.call.id.clone(),
            registration_id: tool.binding.registration_id.clone(),
            owner_id: tool.binding.owner_id.clone(),
            schema_digest: tool.binding.schema_digest.clone(),
        };
        let call = self.engine.page_call(
            tool.clone(),
            coordinates.clone(),
            serde_json::to_vec(arguments).unwrap().len(),
        );
        let (_lease, mut commands) = match call {
            Ok(call) => call,
            Err(_) => {
                return self
                    .settle_page(
                        arguments_digest,
                        None,
                        PageReply::NoEffect {
                            reason: PageNoEffect::Unavailable,
                        },
                    )
                    .await;
            }
        };
        if tool
            .host
            .page_tool_notice(PageToolNotice::Pending(coordinates.clone()))
            .await
            .is_err()
        {
            return self
                .settle_page(
                    arguments_digest,
                    None,
                    PageReply::NoEffect {
                        reason: PageNoEffect::Unavailable,
                    },
                )
                .await;
        }
        let mut claim: Option<String> = None;
        let mut cancelling = false;
        let deadline = tokio::time::sleep(Duration::from_secs(10));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                biased;
                _ = tool.host.wait_closed() => {
                    let reply = if claim.is_some() { PageReply::Unknown } else { PageReply::NoEffect { reason: PageNoEffect::Unavailable } };
                    return self.settle_page(arguments_digest, claim, reply).await;
                }
                _ = self.cancel.cancelled(), if !cancelling => {
                    if claim.is_none() { return self.settle_page(arguments_digest, None, PageReply::NoEffect { reason: PageNoEffect::Cancelled }).await; }
                    cancelling = true;
                    deadline.as_mut().reset(Instant::now() + Duration::from_secs(1));
                    let _ = tool.host.page_tool_notice(PageToolNotice::Cancelled { coordinates: coordinates.clone(), claim_id: claim.clone() }).await;
                }
                _ = tool.revoked.cancelled(), if !cancelling => {
                    if claim.is_none() { return self.settle_page(arguments_digest, None, PageReply::NoEffect { reason: PageNoEffect::Closed }).await; }
                    cancelling = true;
                    deadline.as_mut().reset(Instant::now() + Duration::from_secs(1));
                    let _ = tool.host.page_tool_notice(PageToolNotice::Cancelled { coordinates: coordinates.clone(), claim_id: claim.clone() }).await;
                }
                _ = &mut deadline => {
                    if claim.is_some() && !cancelling {
                        cancelling = true;
                        deadline.as_mut().reset(Instant::now() + Duration::from_secs(1));
                        let _ = tool.host.page_tool_notice(PageToolNotice::Cancelled { coordinates: coordinates.clone(), claim_id: claim.clone() }).await;
                    } else {
                        let reply = if claim.is_some() { PageReply::Unknown } else { PageReply::NoEffect { reason: PageNoEffect::Unavailable } };
                        return self.settle_page(arguments_digest, claim, reply).await;
                    }
                }
                command = commands.recv() => match command {
                    Some(Command::Claim(ack)) => {
                        if claim.is_some() || cancelling {
                            let _ = ack.send(Ok(json!(PageClaimReply::NotGranted { reason: PageClaimDenial::AlreadyClaimed })));
                            continue;
                        }
                        if self.cancel.is_cancelled() || self.engine.page_live(tool).await.is_err() {
                            let result = self.settle_page(arguments_digest, None, PageReply::NoEffect { reason: PageNoEffect::Closed }).await;
                            let _ = ack.send(Ok(json!(PageClaimReply::NotGranted { reason: PageClaimDenial::Unavailable })));
                            return result;
                        }
                        let claim_id = uuid::Uuid::new_v4().to_string();
                        if let Err(error) = self.edit(|execution, _| execution.page.as_mut().unwrap().dispatch = PageDispatch::Claimed { arguments_digest: arguments_digest.clone(), claim_id: claim_id.clone() }).await {
                            let _ = ack.send(Err(Error::Invalid("page claim persistence failed; no execution grant".into())));
                            return Err(error);
                        }
                        claim = Some(claim_id.clone());
                        if self.cancel.is_cancelled() || tool.revoked.is_cancelled() || tool.host.is_closed() {
                            let result = self.settle_page(arguments_digest, claim, PageReply::NoEffect { reason: PageNoEffect::Cancelled }).await;
                            let _ = ack.send(Ok(json!(PageClaimReply::NotGranted { reason: PageClaimDenial::Unavailable })));
                            return result;
                        }
                        deadline.as_mut().reset(Instant::now() + Duration::from_secs(30));
                        let _ = ack.send(Ok(json!(PageClaimReply::Granted { claim_id, kind: tool.binding.kind, document_id: tool.binding.document_id.clone(), arguments: arguments.clone() })));
                    }
                    Some(Command::Resolve { claim_id, reply, ack }) => {
                        if claim_id != claim || (claim.is_none() && !matches!(reply, PageReply::NoEffect { .. })) {
                            let _ = ack.send(Err(Error::Conflict));
                            continue;
                        }
                        if let PageReply::Completed { result } = &reply
                            && let Err(error) = self.entry.validate_output(&serde_json::to_value(result).unwrap()) {
                            let _ = ack.send(Err(Error::Invalid(error.to_string())));
                            continue;
                        }
                        if let Err(error) = validate_reply(tool, arguments, &reply) {
                            let _ = ack.send(Err(error));
                            continue;
                        }
                        let result = self.settle_page(arguments_digest, claim, reply).await;
                        let accepted = match &result { Ok(_) => Ok(json!(PageAccepted::Accepted)), Err(error) => Err(Error::Invalid(format!("page terminal persistence failed: {error}"))) };
                        let _ = ack.send(accepted);
                        return result;
                    }
                    None => return self.settle_page(arguments_digest, claim.clone(), if claim.is_some() { PageReply::Unknown } else { PageReply::NoEffect { reason: PageNoEffect::Unavailable } }).await,
                },
            }
        }
    }
    async fn settle_page(
        &self,
        arguments_digest: String,
        claim_id: Option<String>,
        reply: PageReply,
    ) -> rt::Result<(bool, Value)> {
        let outcome = match &reply {
            PageReply::Completed {
                result: PageResult::Selection { .. } | PageResult::Applied { .. },
            } => ToolOutcome::Succeeded,
            PageReply::Completed { .. }
            | PageReply::NoEffect {
                reason: PageNoEffect::Unavailable,
            } => ToolOutcome::Failed,
            PageReply::NoEffect { .. } => ToolOutcome::Cancelled,
            PageReply::Unknown => ToolOutcome::Unknown,
        };
        let value = serde_json::to_value(&reply).map_err(unavailable)?;
        let reply_digest = digest(&value);
        let prepared = self
            .engine
            .prepare_tool_result(self.cell, self.item_id, &self.call.name, &value, None)
            .await
            .map_err(unavailable)?;
        let success = outcome == ToolOutcome::Succeeded;
        self.edit(|execution, content| {
            execution.page.as_mut().unwrap().dispatch = PageDispatch::Terminal {
                arguments_digest: Some(arguments_digest),
                claim_id,
                reply_digest,
            };
            execution.outcome = outcome;
            execution.result_snapshot = prepared.snapshot;
            execution.output_projection = Some(prepared.metrics);
            *content = Some(content_items(&prepared.value));
        })
        .await?;
        Ok((success, value))
    }
}
