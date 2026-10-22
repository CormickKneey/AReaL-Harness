use super::*;
use crate::tools::{Backend, DynamicToolHost, Registry};
use areal_protocol::plugin_runtime::*;
use tokio::sync::{mpsc, oneshot};

type CallKey = (String, String, String);
#[derive(Default)]
pub(super) struct Pages {
    registrations: std::sync::RwLock<BTreeMap<String, Arc<Registration>>>,
    calls: std::sync::Mutex<BTreeMap<CallKey, CallHandle>>,
}
struct Registration {
    declaration: PageDeclaration,
    tools: Vec<Arc<FrozenPageTool>>,
}
pub(crate) struct FrozenPageTool {
    pub binding: PageBinding,
    pub host: Arc<dyn DynamicToolHost>,
    pub revoked: CancellationToken,
}
#[derive(Clone)]
struct CallHandle {
    tool: Arc<FrozenPageTool>,
    coordinates: PageCoordinates,
    bytes: usize,
    sender: mpsc::Sender<Command>,
}
pub(crate) enum Command {
    Claim(oneshot::Sender<Result<Value>>),
    Resolve {
        claim_id: Option<String>,
        reply: PageReply,
        ack: oneshot::Sender<Result<Value>>,
    },
}
pub(crate) struct CallLease<'a> {
    pages: &'a Pages,
    key: CallKey,
}
impl Drop for CallLease<'_> {
    fn drop(&mut self) {
        self.pages.calls.lock().unwrap().remove(&self.key);
    }
}
impl Pages {
    pub(super) fn revoke_instance(&self, instance: &str) {
        self.registrations.write().unwrap().retain(|_, r| {
            if r.tools[0].binding.instance_id == instance {
                r.tools[0].revoked.cancel();
                false
            } else {
                true
            }
        });
    }
}
fn key(c: &PageCoordinates) -> CallKey {
    (c.thread_id.clone(), c.turn_id.clone(), c.call_id.clone())
}
fn coordinates_match(c: &PageCoordinates, b: &PageBinding) -> bool {
    c.thread_id == b.thread_id
        && c.registration_id == b.registration_id
        && c.owner_id == b.owner_id
        && c.schema_digest == b.schema_digest
}
fn registration_reply(r: &Registration) -> Value {
    serde_json::to_value(PageRegisterReply {
        registration_id: r.tools[0].binding.registration_id.clone(),
        document_id: r.declaration.document_id.clone(),
        tools: r
            .tools
            .iter()
            .map(|t| PageToolDefinition {
                kind: t.binding.kind,
                name: t.name(),
                schema_digest: t.binding.schema_digest.clone(),
            })
            .collect(),
    })
    .unwrap()
}
impl FrozenPageTool {
    fn definition(&self) -> areal_protocol::ToolDefinition {
        areal_protocol::ToolDefinition {
            name: self.name(),
            description: format!(
                "{} in the retained MCP page {} from {}. Document {}. This page owns unsaved editor state.",
                self.binding.kind.suffix(),
                self.binding.instance_id,
                self.binding.plugin_id,
                self.binding.document_id
            ),
            input_schema: self.binding.kind.input_schema(),
            output_schema: Some(self.binding.kind.output_schema()),
        }
    }
    pub fn name(&self) -> String {
        format!(
            "app_{}_{}",
            self.binding.registration_id.replace('-', ""),
            self.binding.kind.suffix()
        )
    }
}
impl Engine {
    pub(in crate::desktop) async fn retire_changed_page_tools(&self) -> Result<()> {
        let _gate = self.desktop.mcp_apps.mutation.lock().await;
        let store = self.plugin_store()?;
        let current = tokio::task::spawn_blocking(move || store.enabled_revisions())
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        let retired: Vec<_> = self
            .desktop
            .mcp_apps
            .instances
            .write()
            .unwrap()
            .values_mut()
            .filter_map(|instance| {
                if current.get(&instance.plugin) == Some(&instance.digest) {
                    return None;
                }
                instance.page_tools_retired = true;
                Some(instance.instance_id.clone())
            })
            .collect();
        for instance_id in retired {
            self.desktop
                .mcp_apps
                .page_tools
                .revoke_instance(&instance_id);
        }
        Ok(())
    }
    pub async fn mcp_page_tools_register(
        &self,
        host: Arc<dyn DynamicToolHost>,
        input: PageRegister,
    ) -> Result<Value> {
        if input.declaration.version != 1
            || input.declaration.document_id.len() > 64
            || uuid::Uuid::parse_str(&input.declaration.document_id).is_err()
            || uuid::Uuid::parse_str(&input.owner_id).is_err()
            || serde_json::to_vec(&input.declaration)
                .map_err(invalid)?
                .len()
                > 1024
            || input.declaration.tools.is_empty()
            || input.declaration.tools.len() > 2
            || input
                .declaration
                .tools
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != input.declaration.tools.len()
            || host.is_closed()
        {
            return Err(invalid("invalid page-tool declaration or closed Host"));
        }
        let (instance, _, _) = self
            .app_bound(
                host.identity(),
                &input.thread_id,
                &input.instance_id,
                input.generation,
            )
            .await?;
        if instance.page_tools_retired || instance.tool_host_id.as_deref() != Some(host.id()) {
            return Err(invalid("App original Host mismatch"));
        }
        let cell = self.cell(&input.thread_id).await?;
        let _gate = self.desktop.mcp_apps.mutation.lock().await;
        if self.plugin_component(&instance.plugin).await?.digest != instance.digest {
            return Err(invalid("page executor package changed"));
        }
        let state = cell.state.lock().await;
        if host.is_closed()
            || self
                .desktop
                .mcp_apps
                .instances
                .read()
                .unwrap()
                .get(&input.instance_id)
                .is_none_or(|i| i.page_tools_retired)
        {
            return Err(Error::NotFound);
        }
        let mut registrations = self
            .desktop
            .mcp_apps
            .page_tools
            .registrations
            .write()
            .unwrap();
        registrations
            .retain(|_, r| !r.tools[0].host.is_closed() && !r.tools[0].revoked.is_cancelled());
        if let Some(r) = registrations
            .values()
            .find(|r| r.tools[0].binding.instance_id == input.instance_id)
        {
            if r.declaration != input.declaration
                || r.tools[0].binding.owner_id != input.owner_id
                || !Arc::ptr_eq(&r.tools[0].host, &host)
            {
                return Err(Error::Conflict);
            }
            return Ok(registration_reply(r));
        }
        if registrations.len() >= 128
            || registrations
                .values()
                .filter(|r| r.tools[0].binding.tool_host_id == host.id())
                .count()
                >= 32
            || registrations
                .values()
                .filter(|r| {
                    r.tools[0].binding.tool_host_id == host.id()
                        && r.tools[0].binding.owner_id == input.owner_id
                })
                .count()
                >= 8
        {
            return Err(invalid("page-tool registration capacity reached"));
        }
        let registration_id = uuid::Uuid::new_v4().simple().to_string();
        let revoked = CancellationToken::new();
        let tools = input.declaration.tools.iter().map(|kind| {
            let schema_digest = digest(&json!({"version":1,"kind":kind,"input":kind.input_schema(),"output":kind.output_schema(),"bytes":PAGE_BYTES,"documentUnits":PAGE_DOCUMENT_UNITS,"textUnits":PAGE_TEXT_UNITS}))?;
            Ok(Arc::new(FrozenPageTool { binding: PageBinding {
                thread_id: input.thread_id.clone(), cwd: instance.cwd.clone(), instance_id: input.instance_id.clone(),
                apps_epoch: instance.runtime_epoch.clone(), generation: instance.generation, plugin_id: instance.plugin.clone(), plugin_digest: instance.digest.clone(),
                registration_id: registration_id.clone(), tool_host_id: host.id().into(), owner_id: input.owner_id.clone(), document_id: input.declaration.document_id.clone(), kind: *kind, schema_digest,
            }, host: host.clone(), revoked: revoked.clone() }))
        }).collect::<Result<Vec<_>>>()?;
        let registration = Arc::new(Registration {
            declaration: input.declaration,
            tools,
        });
        drop(registrations);
        let mut registry = self
            .managed_registry(&state.thread, cell.research)
            .map_err(invalid)?;
        for tool in &registration.tools {
            registry
                .insert(tool.definition(), Backend::Page(tool.clone()))
                .map_err(invalid)?;
        }
        let reply = registration_reply(&registration);
        self.desktop
            .mcp_apps
            .page_tools
            .registrations
            .write()
            .unwrap()
            .insert(registration_id, registration);
        Ok(reply)
    }
    pub async fn mcp_page_tools_revoke(
        &self,
        host: Arc<dyn DynamicToolHost>,
        input: PageRevoke,
    ) -> Result<Value> {
        let _gate = self.desktop.mcp_apps.mutation.lock().await;
        let mut registrations = self
            .desktop
            .mcp_apps
            .page_tools
            .registrations
            .write()
            .unwrap();
        if let Some(r) = registrations.get(&input.registration_id) {
            let t = &r.tools[0];
            if !Arc::ptr_eq(&t.host, &host)
                || t.binding.thread_id != input.thread_id
                || t.binding.instance_id != input.instance_id
                || t.binding.generation != input.generation
                || t.binding.owner_id != input.owner_id
            {
                return Err(invalid("page-tool owner mismatch"));
            }
            if let Some(instance) = self
                .desktop
                .mcp_apps
                .instances
                .write()
                .unwrap()
                .get_mut(&input.instance_id)
            {
                instance.page_tools_retired = true;
            }
            t.revoked.cancel();
            registrations.remove(&input.registration_id);
        }
        Ok(json!(PageRevoked { revoked: true }))
    }
    pub(crate) fn page_registry(
        &self,
        mut registry: Registry,
        thread: &Thread,
    ) -> anyhow::Result<Registry> {
        for r in self
            .desktop
            .mcp_apps
            .page_tools
            .registrations
            .read()
            .unwrap()
            .values()
        {
            for t in &r.tools {
                if t.binding.thread_id == thread.id
                    && t.binding.cwd == thread.cwd
                    && !t.host.is_closed()
                    && !t.revoked.is_cancelled()
                {
                    registry.insert(t.definition(), Backend::Page(t.clone()))?;
                }
            }
        }
        Ok(registry)
    }
    pub(crate) async fn page_live(&self, tool: &FrozenPageTool) -> Result<()> {
        if tool.host.is_closed()
            || tool.revoked.is_cancelled()
            || tool.binding.apps_epoch != self.desktop.mcp_apps.runtime_epoch
        {
            return Err(invalid("page executor revoked"));
        }
        if self.plugin_component(&tool.binding.plugin_id).await?.digest
            != tool.binding.plugin_digest
        {
            return Err(invalid("page executor package changed"));
        }
        let (i, _, _) = self
            .app_bound(
                tool.host.identity(),
                &tool.binding.thread_id,
                &tool.binding.instance_id,
                tool.binding.generation,
            )
            .await?;
        if i.tool_host_id.as_deref() != Some(tool.host.id())
            || i.cwd != tool.binding.cwd
            || i.digest != tool.binding.plugin_digest
        {
            return Err(invalid("page executor binding changed"));
        }
        let registrations = self
            .desktop
            .mcp_apps
            .page_tools
            .registrations
            .read()
            .unwrap();
        if !registrations
            .get(&tool.binding.registration_id)
            .is_some_and(|r| r.tools.iter().any(|t| t.binding == tool.binding))
        {
            return Err(invalid("page registration unavailable"));
        }
        Ok(())
    }
    pub(crate) fn page_call(
        &self,
        tool: Arc<FrozenPageTool>,
        coordinates: PageCoordinates,
        bytes: usize,
    ) -> Result<(CallLease<'_>, mpsc::Receiver<Command>)> {
        let pages = &self.desktop.mcp_apps.page_tools;
        let mut calls = pages.calls.lock().unwrap();
        let own: Vec<_> = calls
            .values()
            .filter(|c| c.tool.binding.tool_host_id == tool.binding.tool_host_id)
            .collect();
        if own.len() >= 16
            || own.iter().map(|c| c.bytes).sum::<usize>() + bytes > 128 * 1024
            || own
                .iter()
                .filter(|c| c.tool.binding.registration_id == tool.binding.registration_id)
                .count()
                >= 2
        {
            return Err(invalid("page-call capacity reached; no effect"));
        }
        let key = key(&coordinates);
        if calls.contains_key(&key) {
            return Err(Error::Conflict);
        }
        let (sender, receiver) = mpsc::channel(8);
        calls.insert(
            key.clone(),
            CallHandle {
                tool,
                coordinates,
                bytes,
                sender,
            },
        );
        Ok((CallLease { pages, key }, receiver))
    }
    fn page_handle(
        &self,
        host: &Arc<dyn DynamicToolHost>,
        coordinates: &PageCoordinates,
    ) -> Result<Option<CallHandle>> {
        let handle = self
            .desktop
            .mcp_apps
            .page_tools
            .calls
            .lock()
            .unwrap()
            .get(&key(coordinates))
            .cloned();
        if let Some(h) = &handle
            && (h.coordinates != *coordinates
                || !Arc::ptr_eq(&h.tool.host, host)
                || host.is_closed())
        {
            return Err(invalid("page-call owner or coordinates mismatch"));
        }
        Ok(handle)
    }
    pub async fn mcp_page_tools_claim(
        &self,
        host: Arc<dyn DynamicToolHost>,
        input: PageCoordinates,
    ) -> Result<Value> {
        let Some(handle) = self.page_handle(&host, &input)? else {
            return Ok(json!(PageClaimReply::NotGranted {
                reason: PageClaimDenial::Unavailable
            }));
        };
        let (ack, response) = oneshot::channel();
        handle
            .sender
            .try_send(Command::Claim(ack))
            .map_err(|_| invalid("page-call command capacity reached"))?;
        response
            .await
            .map_err(|_| invalid("page invocation completed without a grant"))?
    }
    pub async fn mcp_page_tools_resolve(
        &self,
        host: Arc<dyn DynamicToolHost>,
        input: PageResolve,
    ) -> Result<Value> {
        if serde_json::to_vec(&input.reply).map_err(invalid)?.len() > PAGE_BYTES {
            return Err(invalid("page result exceeds 32 KiB"));
        }
        let coordinates = input.coordinates();
        if let Some(handle) = self.page_handle(&host, &coordinates)? {
            let (ack, response) = oneshot::channel();
            match handle.sender.try_send(Command::Resolve {
                claim_id: input.claim_id.clone(),
                reply: input.reply.clone(),
                ack,
            }) {
                Ok(()) => {
                    if let Ok(reply) = response.await {
                        return reply;
                    }
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    return Err(invalid("page-call command capacity reached"));
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {}
            }
        }
        self.page_receipt(&host, &input).await
    }
    async fn page_receipt(
        &self,
        host: &Arc<dyn DynamicToolHost>,
        input: &PageResolve,
    ) -> Result<Value> {
        if host.is_closed() {
            return Err(invalid("page Host disconnected"));
        }
        let thread = self.read(&input.thread_id, true).await?;
        let page = thread
            .turns
            .iter()
            .find(|t| t.id == input.turn_id)
            .and_then(|t| {
                t.items.iter().find_map(|i| match i {
                    Item::DynamicToolCall {
                        call_id, execution, ..
                    } if call_id == &input.call_id => execution.page.as_ref(),
                    _ => None,
                })
            })
            .ok_or(Error::NotFound)?;
        if page.binding.tool_host_id != host.id()
            || !coordinates_match(&input.coordinates(), &page.binding)
        {
            return Err(invalid("page receipt owner mismatch"));
        }
        match &page.dispatch {
            PageDispatch::Terminal {
                claim_id,
                reply_digest,
                ..
            } if claim_id == &input.claim_id
                && reply_digest
                    == &digest(&serde_json::to_value(&input.reply).map_err(invalid)?)? =>
            {
                Ok(json!(PageAccepted::Accepted))
            }
            _ => Err(Error::Conflict),
        }
    }
}

pub(crate) fn validate_reply(
    tool: &FrozenPageTool,
    arguments: &Value,
    reply: &PageReply,
) -> Result<()> {
    if serde_json::to_vec(reply).map_err(invalid)?.len() > PAGE_BYTES {
        return Err(invalid("page result exceeds 32 KiB"));
    }
    let PageReply::Completed { result } = reply else {
        return Ok(());
    };
    let bound = &tool.binding;
    let valid = match result {
        PageResult::Selection {
            document_id,
            anchor,
            head,
            selected_text,
            truncated,
            ..
        } => {
            let units = selected_text.encode_utf16().count();
            bound.kind == PageToolKind::GetSelection
                && document_id == &bound.document_id
                && *anchor <= PAGE_DOCUMENT_UNITS
                && *head <= PAGE_DOCUMENT_UNITS
                && units <= PAGE_TEXT_UNITS
                && !selected_text.contains('\r')
                && if *truncated {
                    anchor.abs_diff(*head) > PAGE_TEXT_UNITS as u64
                        && (PAGE_TEXT_UNITS - 1..=PAGE_TEXT_UNITS).contains(&units)
                } else {
                    units as u64 == anchor.abs_diff(*head)
                }
        }
        _ if bound.kind == PageToolKind::ApplyPatch => {
            let patch: PagePatch = serde_json::from_value(arguments.clone()).map_err(invalid)?;
            match result {
                PageResult::Applied {
                    document_id,
                    previous_document_revision,
                    document_revision,
                    from,
                    to,
                    inserted_length,
                    ..
                } => {
                    document_id == &bound.document_id
                        && patch.patch.from <= patch.patch.to
                        && (patch.patch.from < patch.patch.to || !patch.patch.insert.is_empty())
                        && *previous_document_revision == patch.expected_document_revision
                        && *document_revision == patch.expected_document_revision + 1
                        && *from == patch.patch.from
                        && *to == patch.patch.to
                        && *inserted_length == patch.patch.insert.encode_utf16().count() as u64
                }
                PageResult::Conflict {
                    document_id,
                    expected_document_revision,
                    document_revision,
                } => {
                    document_id == &bound.document_id
                        && *expected_document_revision == patch.expected_document_revision
                        && *document_revision != patch.expected_document_revision
                }
                PageResult::Rejected {
                    document_id,
                    document_revision,
                    ..
                } => {
                    document_id == &bound.document_id
                        && *document_revision == patch.expected_document_revision
                }
                _ => false,
            }
        }
        _ => false,
    };
    if !valid {
        return Err(invalid(
            "page result contradicts frozen kind, document or arguments",
        ));
    }
    Ok(())
}
