use crate::{LaunchSpec, storage};
use anyhow::{Context, Result, bail, ensure};
use areal_protocol::service::{Identity, Request, Response, Service, State, VERSION};
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::{Instant, timeout},
};

pub async fn ensure(spec: &LaunchSpec) -> Result<Service> {
    ensure_inner(spec, None, false).await
}

pub async fn restart(spec: &LaunchSpec, cancel: bool) -> Result<Service> {
    ensure_inner(spec, Some(cancel), false).await
}

async fn ensure_inner(
    spec: &LaunchSpec,
    restart: Option<bool>,
    reconnect: bool,
) -> Result<Service> {
    let directory = spec.directory()?;
    storage::private_dir(&spec.home.join("services"))?;
    storage::private_dir(&directory)?;
    let _startup = startup_lock(&directory).await?;
    if reconnect {
        let record: Service = storage::read(&directory.join("service.json"))?;
        ensure!(
            record.state == State::Ready,
            "service was explicitly stopped; open a new client or run areal service ensure to restart it"
        );
    }
    let deadline = Instant::now() + Duration::from_secs(65);
    let data = spec.args.data_dir.as_ref().unwrap();
    std::fs::create_dir_all(data)?;
    let host_lock = data.join("service.lock");
    if !storage::available(&host_lock)? {
        let service = status(&spec.home, &spec.service_id).await
            .context("service has an active owner but cannot be reached; inspect its log, do not start a second Core")?;
        ensure!(
            Some(&service.identity.workspace) == spec.args.workspace.as_ref(),
            "data directory is bound to a different workspace"
        );
        if restart.is_none() && check_compatible(spec, &service, &directory).is_ok() {
            // 等待文件监听完成一次更新；CLI/环境覆盖变化仍需要重启继承新上下文。
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let state = rpc(&service, "areal/server/status", json!({})).await?;
                if state["configuration"]["modelRevision"].as_str()
                    == spec.components.get("model").map(String::as_str)
                {
                    return Ok(service);
                }
                if Instant::now() >= deadline {
                    bail!(
                        "model configuration has not been applied; the running service is unchanged. Inspect its configuration error or run `areal service restart` to inherit updated credentials"
                    );
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        if restart.is_none() {
            let previous: std::collections::BTreeMap<String, String> =
                storage::read(&directory.join("components.json"))?;
            for key in [
                "workspace",
                "permissions",
                "runtime",
                "deployment",
                "model-inputs",
            ] {
                if previous
                    .get(key)
                    .is_some_and(|value| spec.components.get(key) != Some(value))
                {
                    check_compatible(spec, &service, &directory)?;
                }
            }
        }
        stop_unlocked(&spec.home, &spec.service_id, restart.unwrap_or(false)).await
            .context("configuration requires a restart; wait for background work to finish, or run `areal service restart --cancel` to explicitly cancel it")?;
        if !reconnect {
            eprintln!("Restarting local service with the updated configuration");
        }
    }
    ensure!(
        storage::store_available(data)?,
        "another Core owns this data directory without a reusable service endpoint; use --endpoint or stop that Core explicitly"
    );
    if data.join("service-workspace").exists() {
        let bound: PathBuf = storage::read(&data.join("service-workspace"))?;
        ensure!(
            Some(&bound) == spec.args.workspace.as_ref(),
            "data directory is bound to a different workspace: {}",
            bound.display()
        );
    }
    let log = storage::open_private(&directory.join("host.log"), true)?;
    log.set_len(0)?;
    // 与现有 launcher 一样由系统 Python 持有原生进程，兼容 macOS 开发二进制的 AMFI 检查。
    let mut command = tokio::process::Command::new("/usr/bin/python3");
    command
        .args([
            "-I",
            "-S",
            "-c",
            "import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))",
        ])
        .arg(spec.bin_dir.join("areal-service-host"));
    command
        .current_dir(&spec.launch_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(log)
        .kill_on_drop(false);
    // setsid 使后台服务不再属于首个终端的会话和前台进程组。
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().context("start service host")?;
    let mut input = child.stdin.take().unwrap();
    input.write_all(&serde_json::to_vec(spec)?).await?;
    input.shutdown().await?;
    drop(input);
    loop {
        if let Some(exit) = child.try_wait()? {
            let diagnostic =
                std::fs::read_to_string(directory.join("host.log")).unwrap_or_default();
            bail!(
                "service host exited ({exit}); log: {}\n{}",
                directory.join("host.log").display(),
                diagnostic.chars().take(4000).collect::<String>()
            );
        }
        if let Ok(service) = status(&spec.home, &spec.service_id).await
            && service.state == State::Ready
        {
            check_compatible(spec, &service, &directory)?;
            // 后台 wait 回收同进程内退出的子进程；客户端退出不会发送终止信号。
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Ok(service);
        }
        ensure!(
            Instant::now() < deadline,
            "service startup timed out; inspect {}",
            directory.join("host.log").display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn startup_lock(directory: &Path) -> Result<std::fs::File> {
    let startup = storage::open_private(&directory.join("start.lock"), true)?;
    let deadline = Instant::now() + Duration::from_secs(65);
    loop {
        match startup.try_lock_exclusive() {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(e) => return Err(e).context("waiting for the concurrent service launch"),
        }
    }
    Ok(startup)
}

pub async fn reconnect(spec: &LaunchSpec) -> Result<Service> {
    ensure_inner(spec, None, true).await
}

fn check_compatible(spec: &LaunchSpec, service: &Service, directory: &Path) -> Result<()> {
    ensure!(
        service.state == State::Ready,
        "service is not accepting connections: {:?}",
        service.state
    );
    ensure!(
        service.identity.protocol_version == VERSION
            && service.identity.service_id == spec.service_id
            && Some(&service.identity.data_dir) == spec.args.data_dir.as_ref(),
        "service identity mismatch"
    );
    if service.identity.config_fingerprint != spec.fingerprint {
        let previous: std::collections::BTreeMap<String, String> =
            storage::read(&directory.join("components.json"))?;
        let changed: Vec<_> = spec
            .components
            .iter()
            .filter(|(k, v)| previous.get(*k) != Some(*v))
            .map(|(k, _)| k.as_str())
            .collect();
        bail!(
            "service configuration conflict ({}) for instance {}; run `areal service restart` in its workspace, or use another --data-dir",
            changed.join(", "),
            spec.service_id
        );
    }
    Ok(())
}

/// 日常控制按工作区选择；多数据目录时要求显式消歧，不猜测要停止的服务。
pub async fn select(
    root: &Path,
    instance: Option<&str>,
    workspace: Option<&Path>,
    data: Option<&Path>,
) -> Result<String> {
    if let Some(instance) = instance {
        return Ok(instance.into());
    }
    let workspace = workspace
        .map(Path::to_path_buf)
        .unwrap_or(std::env::current_dir()?)
        .canonicalize()?;
    let data = data.map(storage::canonical_pending).transpose()?;
    let matches: Vec<_> = list(root)
        .await?
        .into_iter()
        .filter(|s| {
            s.identity.workspace == workspace
                && data.as_ref().is_none_or(|p| p == &s.identity.data_dir)
        })
        .collect();
    ensure!(
        !matches.is_empty(),
        "no service for this workspace; run `areal service ensure` first"
    );
    ensure!(
        matches.len() == 1,
        "multiple services for this workspace; specify --data-dir or --instance"
    );
    Ok(matches[0].identity.service_id.clone())
}

pub async fn request(root: &Path, id: &str, request: Request) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    ensure!(directory.is_dir(), "unknown service instance: {id}");
    storage::private_dir(&directory)?;
    let connection = timeout(
        Duration::from_secs(2),
        UnixStream::connect(directory.join("control.sock")),
    )
    .await??;
    let (read, mut write) = connection.into_split();
    let mut bytes = serde_json::to_vec(&request)?;
    bytes.push(b'\n');
    write.write_all(&bytes).await?;
    let mut reader = BufReader::new(read.take(256 * 1024));
    let mut line = String::new();
    // 服务仅在私有 socket 上返回有界的一行响应。
    use tokio::io::AsyncReadExt;
    timeout(Duration::from_secs(65), reader.read_line(&mut line)).await??;
    match serde_json::from_str(&line)? {
        Response::Ok { service } => Ok(*service),
        Response::Error { message } => bail!("{message}"),
    }
}

pub async fn status(root: &Path, id: &str) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    let mut record: Service = storage::read(&directory.join("service.json"))?;
    ensure!(
        record.identity.service_id == id && record.identity.protocol_version == VERSION,
        "invalid service record"
    );
    if storage::available(&record.identity.data_dir.join("service.lock"))? {
        record.state = if record.state != State::Unavailable
            && storage::store_available(&record.identity.data_dir)?
        {
            State::Stopped
        } else {
            State::Unavailable
        };
        return Ok(record);
    }
    let live = request(root, id, Request::Status { version: VERSION }).await?;
    ensure!(
        live.identity == record.identity,
        "service generation changed; retry discovery"
    );
    if live.state == State::Ready {
        probe(&live).await?;
    }
    Ok(live)
}

pub async fn list(root: &Path) -> Result<Vec<Service>> {
    let directory = root.join("services");
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().join("service.json").exists() {
            continue;
        }
        match status(root, &id).await {
            Ok(service) => out.push(service),
            Err(_) => {
                let mut record: Service = storage::read(&entry.path().join("service.json"))?;
                record.state = State::Unavailable;
                out.push(record);
            }
        }
    }
    out.sort_by(|a, b| a.identity.service_id.cmp(&b.identity.service_id));
    Ok(out)
}

pub async fn stop(root: &Path, id: &str, cancel: bool) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    stop_unlocked(root, id, cancel).await
}

async fn stop_unlocked(root: &Path, id: &str, cancel: bool) -> Result<Service> {
    let mut service = status(root, id).await?;
    if service.state == State::Stopped {
        return Ok(service);
    }
    request(
        root,
        id,
        Request::Stop {
            version: VERSION,
            generation: service.identity.generation.clone(),
            cancel,
        },
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while !storage::available(&service.identity.data_dir.join("service.lock"))? {
        ensure!(
            Instant::now() < deadline,
            "service cleanup is not confirmed; inspect {}",
            service.log_file.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ensure!(
        storage::store_available(&service.identity.data_dir)?,
        "Core still owns the store; cleanup is not confirmed"
    );
    let settled: Service = storage::read(&storage::registry(root, id)?.join("service.json"))?;
    ensure!(
        settled.identity.generation == service.identity.generation
            && settled.state == State::Stopped,
        "service did not confirm clean shutdown or has already restarted; inspect {}",
        service.log_file.display()
    );
    service.state = State::Stopped;
    Ok(service)
}

fn token(service: &Service) -> Result<String> {
    let auth: Value = storage::read(&service.auth_file)?;
    Ok(auth["principals"][0]["token"]
        .as_str()
        .context("missing service token")?
        .into())
}

fn http_endpoint(service: &Service) -> Result<reqwest::Url> {
    let endpoint = reqwest::Url::parse(&service.endpoint)?;
    ensure!(
        endpoint.scheme() == "ws"
            && matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.path() == "/"
            && endpoint.query().is_none()
            && endpoint.fragment().is_none(),
        "service endpoint must be loopback"
    );
    let mut url = endpoint;
    url.set_scheme("http").unwrap();
    Ok(url)
}

pub async fn probe(service: &Service) -> Result<()> {
    let mut url = http_endpoint(service)?;
    url.set_path("/areal/service");
    let identity: Identity = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?
        .get(url)
        .bearer_auth(token(service)?)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        identity == service.identity,
        "Core identity/generation does not match the service record"
    );
    Ok(())
}

/// 返回仅供打开浏览器的一次性 URL；调用方不得写入日志或发现描述。
pub async fn browser_login_url(service: &Service) -> Result<String> {
    probe(service).await?;
    let mut url = http_endpoint(service)?;
    url.set_path("/areal/auth/bootstrap");
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?
        .post(url.clone())
        .bearer_auth(token(service)?)
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "browser login could not be prepared; rerun areal web or sign in manually at {}",
        service.web_url
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 4096,
            "invalid browser login response"
        );
        bytes.extend_from_slice(&chunk);
    }
    let ticket: areal_protocol::service::BrowserBootstrap = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid browser login response"))?;
    ensure!(
        ticket.code.len() == 64
            && ticket.code.bytes().all(|c| c.is_ascii_hexdigit())
            && (1..=60).contains(&ticket.expires_in),
        "invalid browser login response"
    );
    // 固定已校验的 loopback origin 和路径，不信任服务返回的跳转地址。
    url.set_path("/ui");
    url.set_fragment(Some(&format!("bootstrap={}", ticket.code)));
    Ok(url.into())
}

pub async fn rpc(service: &Service, method: &str, params: Value) -> Result<Value> {
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let mut request = service.endpoint.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", token(service)?).parse()?,
    );
    timeout(Duration::from_secs(62), async {
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await?;
        socket.send(Message::Text(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"areal_service_host","version":env!("CARGO_PKG_VERSION")}}}).to_string().into())).await?;
        loop {
            let message = socket.next().await.context("Core disconnected during initialize")??;
            if let Message::Text(text) = message {
                let reply: Value = serde_json::from_str(&text)?;
                if reply["id"] == 1 {
                    ensure!(reply.get("result").is_some(), "Core initialization failed");
                    break;
                }
            }
        }
        socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).await?;
        socket.send(Message::Text(json!({"id":2,"method":method,"params":params}).to_string().into())).await?;
        while let Some(message) = socket.next().await {
            if let Message::Text(text) = message? {
                let reply: Value = serde_json::from_str(&text)?;
                if reply["id"] == 2 {
                    ensure!(reply.get("error").is_none(), "Core request failed: {}", reply["error"]);
                    return Ok(reply["result"].clone());
                }
            }
        }
        bail!("Core disconnected before replying")
    }).await?
}

pub async fn bind(root: &Path, workspace: &Path, data: &Path) -> Result<PathBuf> {
    let workspace = workspace.canonicalize()?;
    let data = data.canonicalize()?;
    ensure!(
        workspace.is_dir()
            && data.is_dir()
            && !data.starts_with(&workspace)
            && !root.starts_with(&workspace),
        "invalid workspace/data placement"
    );
    let lock = storage::open_private(&data.join("service.lock"), true)?;
    lock.try_lock_exclusive()
        .context("stop the service before binding its data")?;
    let directory = root.join("workspaces");
    storage::private_dir(&directory)?;
    let mapping = directory.join(format!(
        "{}.json",
        storage::digest(workspace.as_os_str().as_encoded_bytes())
    ));
    let mapping_lock = storage::open_private(&mapping.with_extension("lock"), true)?;
    mapping_lock
        .try_lock_exclusive()
        .context("another workspace binding is in progress")?;
    if mapping.exists() {
        ensure!(
            storage::read::<PathBuf>(&mapping)? == data,
            "workspace is already bound to another data directory"
        );
    }
    storage::bind_workspace(&data, &workspace)?;
    storage::write(&mapping, &data)?;
    Ok(data)
}
