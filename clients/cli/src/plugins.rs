//! Thin plugin management client; installation/selection authority stays in Core.
use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(clap::Args)]
pub struct Options {
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    List,
    Read {
        id: String,
    },
    /// Discover a local marketplace from its root.
    MarketplaceAdd {
        root: PathBuf,
    },
    /// Snapshot the currently inspected local package; never execute install scripts.
    Install {
        id: String,
        #[arg(long, default_value = "user", value_parser = ["user", "project"])]
        scope: String,
    },
    Enable {
        id: String,
        #[arg(long, default_value = "user", value_parser = ["user", "project"])]
        scope: String,
    },
    Disable {
        id: String,
        #[arg(long, default_value = "user", value_parser = ["user", "project"])]
        scope: String,
    },
    Uninstall {
        id: String,
    },
    Setup {
        id: String,
        #[arg(long)]
        thread: Option<String>,
    },
    /// Inspect a prior accepted request. Never replay an unknown mutation.
    Submission {
        request_id: String,
    },
}
pub async fn run(options: Options) -> Result<()> {
    let root = areal_local_service::home()?;
    let service_id = areal_local_service::select(
        &root,
        None,
        options.workspace.as_deref(),
        options.data_dir.as_deref(),
    )
    .await
    .context("connect the workspace first with areal service ensure")?;
    let service = areal_local_service::status(&root, &service_id).await?;
    ensure!(
        options.config.is_none(),
        "plugin commands use the running Core configuration; use service ensure/restart to choose --config"
    );
    let list = areal_local_service::rpc(&service, "areal/plugin/list", json!({})).await?;
    let revision = list["revision"]
        .as_u64()
        .context("invalid plugin directory revision")?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (method, mut params, mutation) = match options.command {
        Command::List => {
            println!("{}", serde_json::to_string_pretty(&list)?);
            return Ok(());
        }
        Command::Read { id } => ("areal/plugin/read", json!({"id":id}), false),
        Command::MarketplaceAdd { root } => (
            "areal/marketplace/add",
            json!({"root":root.canonicalize()?,"expectedRevision":revision}),
            true,
        ),
        Command::Install { id, scope } => {
            let selected = list["data"]
                .as_array()
                .context("invalid plugin catalog")?
                .iter()
                .find(|p| p["id"] == id)
                .context("plugin not in catalog; add its local marketplace first")?;
            (
                "areal/plugin/install",
                json!({"id":id,"scope":scope,"expectedRevision":revision,
                "source":selected["source"],"expectedDigest":selected["sourceDigest"]}),
                true,
            )
        }
        Command::Enable { id, scope } => (
            "areal/plugin/configure",
            json!({"id":id,"scope":scope,"enabled":true,"expectedRevision":revision}),
            true,
        ),
        Command::Disable { id, scope } => (
            "areal/plugin/configure",
            json!({"id":id,"scope":scope,"enabled":false,"expectedRevision":revision}),
            true,
        ),
        Command::Uninstall { id } => (
            "areal/plugin/uninstall",
            json!({"id":id,"expectedRevision":revision}),
            true,
        ),
        Command::Setup { id, thread } => {
            let mut p = json!({"id":id});
            if let Some(thread) = thread {
                p["threadId"] = json!(thread);
            }
            ("areal/plugin/setup", p, true)
        }
        Command::Submission { request_id } => {
            ("areal/request/read", json!({"requestId":request_id}), false)
        }
    };
    if mutation {
        params["requestId"] = json!(request_id);
    }
    let result: Value = areal_local_service::rpc(&service, method, params).await
        .with_context(|| if mutation { format!("plugin request {request_id}; if acceptance is unknown, inspect with areal plugin submission {request_id}; no replay was attempted") } else { "plugin read failed".into() })?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
