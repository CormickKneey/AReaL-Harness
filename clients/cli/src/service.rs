//! 可信桌面 Main 可直接 exec 此 JSON 入口；浏览器只访问 Core HTTP/WS。
use anyhow::{Result, ensure};
use areal_local_service::{LaunchSpec, LocalArgs};
use clap::Subcommand;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum ServiceCommand {
    /// 复用兼容的本地服务；不存在时启动。
    Ensure {
        #[command(flatten)]
        local: Box<LocalArgs>,
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Status {
        #[arg(long)]
        instance: String,
        #[arg(long)]
        json: bool,
    },
    /// 默认拒绝停止仍在工作的实例；--cancel 显式取消并结算。
    Stop {
        #[arg(long)]
        instance: String,
        #[arg(long)]
        cancel: bool,
        #[arg(long)]
        json: bool,
    },
    /// 将已有历史绑定到工作区；要求服务已停止且历史属于该工作区。
    Bind {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

pub async fn execute(command: ServiceCommand) -> Result<()> {
    let root = areal_local_service::home()?;
    let value = match command {
        ServiceCommand::Ensure { local, .. } => {
            serde_json::to_value(areal_local_service::ensure(&LaunchSpec::resolve(&local)?).await?)?
        }
        ServiceCommand::List { .. } => {
            serde_json::to_value(areal_local_service::list(&root).await?)?
        }
        ServiceCommand::Status { instance, .. } => {
            serde_json::to_value(areal_local_service::status(&root, &instance).await?)?
        }
        ServiceCommand::Stop {
            instance, cancel, ..
        } => serde_json::to_value(areal_local_service::stop(&root, &instance, cancel).await?)?,
        ServiceCommand::Bind {
            workspace,
            data_dir,
            ..
        } => {
            serde_json::json!({"dataDir":areal_local_service::bind(&root, &workspace, &data_dir).await?})
        }
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

pub async fn web(local: LocalArgs, json: bool) -> Result<()> {
    let service = areal_local_service::ensure(&LaunchSpec::resolve(&local)?).await?;
    if !json {
        let opener = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "/usr/bin/xdg-open"
        };
        let result = tokio::process::Command::new(opener)
            .arg(&service.web_url)
            .status()
            .await?;
        ensure!(
            result.success(),
            "could not open browser; visit {}",
            service.web_url
        );
    }
    println!("{}", serde_json::to_string_pretty(&service)?);
    Ok(())
}
