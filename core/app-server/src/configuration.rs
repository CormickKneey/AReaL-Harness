use crate::auth::{Permission, Principal};
use areal_protocol::{
    RpcError,
    desktop::{ModelConfigurationApply, ModelConfigurationRead},
};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};

type Response<'a> = Pin<Box<dyn Future<Output = Result<Value, RpcError>> + Send + 'a>>;

pub trait ModelConfigurationControl: Send + Sync {
    fn read(&self, query: ModelConfigurationRead) -> Response<'_>;
    fn apply(self: Arc<Self>, request: ModelConfigurationApply) -> Response<'static>;
}

areal_protocol::method_catalog! {
    "areal/server/modelConfiguration/read" => Read;
    "areal/server/modelConfiguration/apply" => Mutation;
}

pub(crate) fn authorized(principal: &Principal) -> bool {
    principal.id == "desktop-owner"
        && !principal.token.is_empty()
        && principal.allows(Permission::Manage)
        && principal.allows(Permission::Tools)
        && principal.thread_ids.is_none()
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub(crate) async fn dispatch(
    control: Option<Arc<dyn ModelConfigurationControl>>,
    principal: &Principal,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    if !authorized(principal) {
        return Err(RpcError {
            code: -32003,
            message: "trusted unrestricted desktop configuration host required".into(),
            data: None,
        });
    }
    let control = control.ok_or_else(|| RpcError {
        code: -32601,
        message: "model configuration control is unavailable".into(),
        data: None,
    })?;
    if method == METHODS[0] {
        let query: ModelConfigurationRead = crate::parse(params)?;
        if query
            .request_id
            .as_deref()
            .is_some_and(|id| !identifier(id))
            || query
                .expected_generation
                .as_deref()
                .is_some_and(|id| !identifier(id))
        {
            return Err(RpcError::invalid("invalid model configuration query"));
        }
        control.read(query).await
    } else {
        let request: ModelConfigurationApply = crate::parse(params)?;
        if !identifier(&request.request_id)
            || !identifier(&request.expected_generation)
            || !identifier(&request.expected_applied.revision)
            || !identifier(&request.target_revision)
            || request.credentials.len() > 32
            || request.credentials.iter().any(|(name, value)| {
                !name
                    .strip_prefix("AREAL_CREDENTIAL_")
                    .is_some_and(identifier)
                    || value.trim().is_empty()
                    || value.len() > 16384
                    || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
            })
        {
            return Err(RpcError::invalid(
                "invalid model configuration apply request",
            ));
        }
        control.apply(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_authority_requires_desktop_manage_tools_without_scope() {
        let mut principal = crate::auth::Principal {
            id: "desktop-owner".into(),
            token: "secret".into(),
            permissions: [Permission::Manage, Permission::Tools].into(),
            thread_ids: None,
        };
        assert!(authorized(&principal));
        principal.thread_ids = Some(Default::default());
        assert!(!authorized(&principal));
        principal.thread_ids = None;
        principal.permissions.remove(&Permission::Tools);
        assert!(!authorized(&principal));
        principal.permissions.insert(Permission::Tools);
        principal.id = "other-manager".into();
        assert!(!authorized(&principal));
    }
}
