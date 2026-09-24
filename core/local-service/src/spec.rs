use crate::storage;
use anyhow::{Context, Result, ensure};
use areal_config::{ConfigInputs, ConfigOverrides, ConfigSource};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

/// 所有本地入口共用启动参数；客户端外观不属于服务配置。
#[derive(Clone, Default, clap::Args, Serialize, Deserialize)]
#[group(multiple = true)]
#[serde(deny_unknown_fields)]
pub struct LocalArgs {
    #[arg(long)]
    pub permissions: Option<String>,
    #[arg(long)]
    pub scratch: Option<PathBuf>,
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub workspace: Option<PathBuf>,
    #[arg(long)]
    pub data_dir: Option<PathBuf>,
    #[arg(long)]
    pub allow_write: bool,
    #[arg(long)]
    pub workgroup_policy: Option<PathBuf>,
    #[arg(long, requires = "workgroup_policy")]
    pub workgroup_toolchain: Option<PathBuf>,
    #[arg(long)]
    pub allow_network: bool,
    #[arg(long)]
    pub allow_concurrent_writes: bool,
    #[arg(long)]
    pub command_timeout_ms: Option<u64>,
    #[arg(long)]
    pub command_output_bytes: Option<u64>,
    #[arg(long)]
    pub model_endpoint: Option<String>,
    #[arg(long)]
    pub model_protocol: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long)]
    pub model_provider: Option<String>,
    #[arg(long)]
    pub api_key_env: Option<String>,
    #[arg(long)]
    pub desktop_config: Option<PathBuf>,
}

impl LocalArgs {
    pub fn launcher_args(&self) -> Vec<OsString> {
        let mut out = Vec::new();
        for (name, value) in [
            ("scratch", &self.scratch),
            ("config", &self.config),
            ("workspace", &self.workspace),
            ("data-dir", &self.data_dir),
            ("workgroup-policy", &self.workgroup_policy),
            ("workgroup-toolchain", &self.workgroup_toolchain),
            ("desktop-config", &self.desktop_config),
        ] {
            if let Some(value) = value {
                out.extend([format!("--{name}").into(), value.as_os_str().to_owned()]);
            }
        }
        for (name, value) in [
            ("permissions", &self.permissions),
            ("model-endpoint", &self.model_endpoint),
            ("model-protocol", &self.model_protocol),
            ("model", &self.model),
            ("model-provider", &self.model_provider),
            ("api-key-env", &self.api_key_env),
        ] {
            if let Some(value) = value {
                out.push(format!("--{name}={value}").into());
            }
        }
        for (name, enabled) in [
            ("allow-write", self.allow_write),
            ("allow-network", self.allow_network),
            ("allow-concurrent-writes", self.allow_concurrent_writes),
        ] {
            if enabled {
                out.push(format!("--{name}").into());
            }
        }
        for (name, value) in [
            ("command-timeout-ms", self.command_timeout_ms),
            ("command-output-bytes", self.command_output_bytes),
        ] {
            if let Some(value) = value {
                out.push(format!("--{name}={value}").into());
            }
        }
        out
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    pub args: LocalArgs,
    pub home: PathBuf,
    pub bin_dir: PathBuf,
    pub launch_cwd: PathBuf,
    pub service_id: String,
    pub fingerprint: String,
    pub components: BTreeMap<String, String>,
}

impl LaunchSpec {
    pub fn resolve(args: &LocalArgs) -> Result<Self> {
        Self::in_bin(
            args,
            std::env::current_exe()?
                .parent()
                .context("binary directory")?
                .to_path_buf(),
        )
    }

    pub fn in_bin(args: &LocalArgs, bin_dir: PathBuf) -> Result<Self> {
        let launch_cwd = std::env::current_dir()?.canonicalize()?;
        let workspace = args
            .workspace
            .as_ref()
            .unwrap_or(&launch_cwd)
            .canonicalize()?;
        ensure!(workspace.is_dir(), "workspace must be a directory");
        let inputs = ConfigInputs {
            cwd: launch_cwd.clone(),
            homedir: std::env::home_dir(),
            env: std::env::vars_os().collect(),
            config_file: args.config.clone(),
            overrides: ConfigOverrides {
                permissions: args.permissions.clone(),
                listen: Some("127.0.0.1:0".into()),
                data_dir: args.data_dir.clone(),
                model: args.model.clone(),
                model_provider: args.model_provider.clone(),
                model_endpoint: args.model_endpoint.clone(),
                model_protocol: args.model_protocol.clone(),
                api_key_env: args.api_key_env.clone(),
                ..Default::default()
            },
        };
        let config = areal_config::load_management_config(&inputs)?;
        config.credential(&inputs)?;
        let root = storage::canonical_pending(&config.home)?;
        let workspace_key = storage::digest(workspace.as_os_str().as_encoded_bytes());
        let mapping = root
            .join("workspaces")
            .join(format!("{workspace_key}.json"));
        let data = if matches!(
            config.sources.get("server.data_dir"),
            Some(ConfigSource::Default)
        ) {
            if mapping.exists() {
                storage::read::<PathBuf>(&mapping)?
            } else {
                let legacy = root.join("state");
                if legacy.is_dir()
                    && std::fs::read_dir(&legacy)?
                        .filter_map(Result::ok)
                        .any(|entry| entry.path().extension().is_some_and(|e| e == "json"))
                {
                    eprintln!(
                        "Existing history remains at {}. Use --data-dir to open it, or areal service bind to select it for this workspace.",
                        legacy.display()
                    );
                }
                root.join("instances")
                    .join(&workspace_key[..24])
                    .join("state")
            }
        } else {
            config.data_dir.clone()
        };
        let data = storage::canonical_pending(&data)?;
        ensure!(
            !data.starts_with(&workspace) && !root.starts_with(&workspace),
            "service state and registry must be outside the workspace"
        );
        let bin_dir = bin_dir.canonicalize()?;
        let mut binaries = BTreeMap::new();
        let rg = areal_runtime_host_tools::bundled_rg(&bin_dir)
            .context("builtin rg deployment check failed")?;
        binaries.insert("builtin-rg", storage::file_digest(&rg)?);
        for name in [
            "areal-server",
            "areal-runtime",
            "areal-runtime-fs",
            "areal-service-host",
        ] {
            let path = bin_dir
                .join(name)
                .canonicalize()
                .with_context(|| format!("missing {name}; run make build"))?;
            // 比较文件内容，避免原路径被重新构建后静默复用旧服务。
            binaries.insert(name, storage::file_digest(&path)?);
        }
        let mut resolved = args.clone();
        resolved.workspace = Some(workspace.clone());
        resolved.data_dir = Some(data.clone());
        resolved.config = config.config_file.clone();
        for path in [
            &mut resolved.scratch,
            &mut resolved.workgroup_policy,
            &mut resolved.workgroup_toolchain,
            &mut resolved.desktop_config,
        ]
        .into_iter()
        .flatten()
        {
            *path = path.canonicalize()?;
        }
        let mut effective = config.diagnostic(false);
        effective["server"]["data_dir"] = json!(data);
        // 默认模型单独按版本比较；热更新不改变部署身份。
        effective.as_object_mut().unwrap().remove("model");
        let mut files = BTreeMap::new();
        for (key, path) in [
            ("extensions", config.tool_extensions_file.as_ref()),
            ("deployment", resolved.desktop_config.as_ref()),
            ("workgroup", resolved.workgroup_policy.as_ref()),
        ] {
            if let Some(path) = path {
                files.insert(key, (path, storage::file_digest(path)?));
            }
        }
        let mut components = BTreeMap::new();
        let model_environment: BTreeMap<_, _> = config
            .sources
            .iter()
            .filter_map(|(field, source)| {
                if field.starts_with("model.")
                    && let ConfigSource::Env { name } = source
                {
                    Some((
                        name,
                        inputs
                            .env
                            .get(std::ffi::OsStr::new(name))
                            .map(|v| v.to_string_lossy()),
                    ))
                } else {
                    None
                }
            })
            .collect();
        for (key, value) in [
            (
                "model-inputs",
                json!({"environment":model_environment,"cli":[args.model.clone(),args.model_provider.clone(),args.model_endpoint.clone(),args.model_protocol.clone(),args.api_key_env.clone()]}),
            ),
            ("workspace", json!(workspace)),
            ("configuration", effective),
            (
                "permissions",
                json!({"policy":config.permissions,"scratch":resolved.scratch,
                    "sandbox":"full-access","allowConcurrentWrites":args.allow_concurrent_writes}),
            ),
            (
                "runtime",
                json!({"timeout":args.command_timeout_ms.unwrap_or(300000),
                "output":args.command_output_bytes.unwrap_or(8*1024*1024),"toolchain":resolved.workgroup_toolchain}),
            ),
            ("deployment", json!(files)),
            ("binaries", json!(binaries)),
        ] {
            components.insert(key.into(), storage::digest(&serde_json::to_vec(&value)?));
        }
        let fingerprint = storage::digest(&serde_json::to_vec(&components)?);
        components.insert("model".into(), config.model.fingerprint());
        let service_id = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
        storage::registry(&root, &service_id)?;
        Ok(Self {
            args: resolved,
            home: root,
            bin_dir,
            launch_cwd,
            service_id,
            fingerprint,
            components,
        })
    }

    pub fn directory(&self) -> Result<PathBuf> {
        storage::registry(&self.home, &self.service_id)
    }
}
