//! TUI、CLI 与可信 Desktop Main 共用的本地服务入口。
mod client;
mod spec;
pub mod storage;

pub use client::{bind, ensure, list, probe, reconnect, rpc, status, stop};
pub use spec::{LaunchSpec, LocalArgs};

pub fn home() -> anyhow::Result<std::path::PathBuf> {
    let path = match std::env::var_os("AREAL_HARNESS_HOME") {
        Some(path) => path.into(),
        None => std::env::home_dir()
            .ok_or_else(|| anyhow::anyhow!("home unavailable"))?
            .join(".areal-harness"),
    };
    storage::canonical_pending(&path)
}
