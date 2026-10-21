//! 共享作者的租约覆盖实际副作用与进程生命周期，不占用无副作用的模型等待。

use crate::*;
use sha2::{Digest, Sha256};

pub(crate) struct Version {
    files: BTreeMap<String, (String, u32)>,
}

impl Version {
    fn read(root: &Path) -> anyhow::Result<Self> {
        use rustix::fs::{self, Dir, Mode, OFlags};
        use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
        const FLAGS: OFlags = OFlags::RDONLY
            .union(OFlags::DIRECTORY)
            .union(OFlags::NOFOLLOW)
            .union(OFlags::CLOEXEC)
            .union(OFlags::NONBLOCK);
        fn visit(
            dir: &File,
            prefix: &str,
            depth: usize,
            version: &mut Version,
            budget: &mut usize,
            entries: &mut usize,
        ) -> anyhow::Result<()> {
            anyhow::ensure!(
                depth < 40,
                "shared workspace depth exceeds version capacity"
            );
            for entry in Dir::read_from(dir)? {
                let entry = entry?;
                let name = entry
                    .file_name()
                    .to_str()
                    .map_err(|_| anyhow::anyhow!("shared workspace has a non-UTF8 path"))?;
                if matches!(name, "." | "..") {
                    continue;
                }
                *entries += 1;
                anyhow::ensure!(
                    *entries <= 20000,
                    "shared workspace entry version capacity exceeded"
                );
                let path = if prefix.is_empty() {
                    name.to_owned()
                } else {
                    format!("{prefix}/{name}")
                };
                anyhow::ensure!(
                    path.len() <= 4096,
                    "shared workspace path exceeds version capacity"
                );
                let mut file: File = fs::openat(
                    dir,
                    name,
                    FLAGS.difference(OFlags::DIRECTORY),
                    Mode::empty(),
                )?
                .into();
                let metadata = file.metadata()?;
                let mode = metadata.mode() & 0o7777;
                if metadata.is_dir() {
                    version
                        .files
                        .insert(path.clone(), ("directory".into(), mode));
                    visit(&file, &path, depth + 1, version, budget, entries)?;
                    continue;
                }
                anyhow::ensure!(
                    name != ".git",
                    "linked Git metadata cannot be completely versioned inside this workspace"
                );
                anyhow::ensure!(
                    metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= *budget as u64,
                    "shared workspace contains an unsupported or oversized version input: {path}"
                );
                let mut hash = Sha256::new();
                let mut bytes = 0;
                let mut buffer = [0u8; 32768];
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    bytes += count;
                    anyhow::ensure!(
                        bytes <= *budget,
                        "shared workspace byte version capacity exceeded"
                    );
                    hash.update(&buffer[..count]);
                }
                let after = file.metadata()?;
                anyhow::ensure!(
                    after.len() == bytes as u64
                        && after.nlink() == 1
                        && after.mode() & 0o7777 == mode,
                    "shared workspace changed during version observation: {path}"
                );
                *budget -= bytes;
                version
                    .files
                    .insert(path, (format!("{:x}", hash.finalize()), mode));
            }
            Ok(())
        }
        let directory: File = fs::open(root, FLAGS, Mode::empty())?.into();
        let mut version = Self {
            files: BTreeMap::from([(
                String::new(),
                ("directory".into(), directory.metadata()?.mode() & 0o7777),
            )]),
        };
        // 版本闭包包含忽略产物和本地 Git 状态；源码投影不能证明共享环境没有变化。
        visit(
            &directory,
            "",
            0,
            &mut version,
            &mut (64 * 1024 * 1024),
            &mut 0,
        )?;
        Ok(version)
    }
    fn changes(&self, next: &Self) -> Vec<String> {
        self.files
            .keys()
            .chain(next.files.keys())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .filter(|path| self.files.get(*path) != next.files.get(*path))
            .take(33)
            .cloned()
            .collect()
    }
}

impl Engine {
    async fn current_workspace_version(&self, cell: &Arc<Cell>) -> anyhow::Result<Version> {
        let root = self
            .runtime
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no owned source Runtime"))?
            .workspace
            .clone();
        anyhow::ensure!(
            !self.store.root().canonicalize()?.starts_with(&root),
            "Core state overlaps the shared workspace"
        );
        let (sent, received) = tokio::sync::oneshot::channel();
        // 可信只读版本任务也加入 Turn 清理，取消不能提前发布资源已释放。
        cell.state
            .lock()
            .await
            .active
            .as_ref()
            .unwrap()
            .tools
            .spawn(async move {
                let result = tokio::task::spawn_blocking(move || Version::read(&root)).await;
                let _ = sent.send(result);
            });
        received.await??
    }

    pub(crate) async fn initialize_workspace_view(
        &self,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
    ) -> anyhow::Result<()> {
        let pinned = cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .is_some_and(|active| active.workspace_exclusive);
        if pinned {
            return Ok(());
        }
        let assigned = cell
            .state
            .lock()
            .await
            .thread
            .desktop
            .as_ref()
            .is_some_and(|d| {
                d.execution_policy.exclusive_write || d.execution_policy.deferred_write
            });
        if !assigned || self.runtime.is_none() {
            return Ok(());
        }
        let guard = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("cancelled before shared source observation"),
            guard = self.workspace_gate.clone().read_owned() => guard,
        };
        let version = self.current_workspace_version(cell).await;
        drop(guard);
        match version {
            Ok(version) => {
                cell.state
                    .lock()
                    .await
                    .active
                    .as_mut()
                    .unwrap()
                    .workspace_version = Some(version)
            }
            Err(error) => {
                cell.emit(
                    "areal/workspace/lease",
                    json!({"status":"pinned","reason":tools::prefix(&error.to_string(),1024)}),
                );
                // 无法证明源版本时保留原整轮互斥，不以不可表示的源码换取不安全并行。
                let guard = tokio::select! { biased;
                    _ = cancel.cancelled() => anyhow::bail!("cancelled before conservative writer admission"),
                    guard = self.workspace_gate.clone().write_owned() => guard,
                };
                self.ensure_workspace_processes_settled().await?;
                let mut state = cell.state.lock().await;
                let active = state.active.as_mut().unwrap();
                active.workspace_exclusive = true;
                active.workspace_lease_pinned = true;
                active.deferred_workspace_guard = Some(guard);
            }
        }
        Ok(())
    }

    pub(crate) async fn check_workspace_version(
        &self,
        cell: &Arc<Cell>,
        call_id: &str,
    ) -> Option<areal_runtime_protocol::Error> {
        let current = self.current_workspace_version(cell).await;
        let mut state = cell.state.lock().await;
        let active = state.active.as_mut().unwrap();
        let Ok(current) = current else {
            active.workspace_lease_pinned = true;
            active.workspace_version.as_ref()?;
            active.workspace_conflict_call = Some(call_id.to_owned());
            return Some(areal_runtime_protocol::Error::new(
                areal_runtime_protocol::ErrorCode::Conflict,
                "WORKSPACE_CHANGED_BEFORE_EXECUTION: this call was NOT executed because the shared workspace version is no longer verifiable. Inspect current inputs before a new decision; the lease remains pinned.",
            ));
        };
        let changes = active
            .workspace_version
            .as_ref()
            .map(|old| old.changes(&current))
            .unwrap_or_default();
        active.workspace_version = Some(current);
        if changes.is_empty() {
            return None;
        }
        active.workspace_conflict_call = Some(call_id.to_owned());
        Some(areal_runtime_protocol::Error::new(areal_runtime_protocol::ErrorCode::Conflict,
            tools::prefix(&format!("WORKSPACE_CHANGED_BEFORE_EXECUTION: this call was NOT executed. Read current evidence and reconsider; no mutation was replayed. Changed source path examples while this writer yielded: {changes:?}"), 4096).to_owned()))
    }

    pub(crate) async fn yield_settled_workspace_lease(&self, cell: &Arc<Cell>) {
        let _resources = cell.resource_gate.lock().await;
        let (scope, thread_id, turn_id) = {
            let state = cell.state.lock().await;
            let Some(active) = state.active.as_ref() else {
                return;
            };
            if active.deferred_workspace_guard.is_none()
                || active.workspace_lease_pinned
                || active.workspace_conflict_call.is_some()
            {
                return;
            }
            (
                active.scope.clone(),
                state.thread.id.clone(),
                active.id.clone(),
            )
        };
        if let Some(scope) = scope {
            let Some(runtime) = &self.runtime else {
                return;
            };
            let Ok(info) = runtime
                .client
                .call::<_, areal_runtime_protocol::ScopeInfo>("scope.get", json!({"scopeId":scope}))
                .await
            else {
                return;
            };
            // 查询失败、清理未知、仍在运行及身份不一致时均保留租约。
            if info.scope_id != scope
                || info.owner.task_id != format!("{thread_id}/{turn_id}")
                || info.active_processes != 0
                || info.cleanup_error.is_some()
            {
                return;
            }
        }
        let Ok(version) = self.current_workspace_version(cell).await else {
            return;
        };
        let guard = {
            let mut state = cell.state.lock().await;
            let Some(active) = state.active.as_mut() else {
                return;
            };
            if active.id != turn_id || active.workspace_lease_pinned {
                return;
            }
            active.workspace_exclusive = false;
            active.workspace_version = Some(version);
            active.deferred_workspace_guard.take()
        };
        drop(guard);
        cell.emit(
            "areal/workspace/lease",
            json!({"threadId":thread_id,"turnId":turn_id,
            "status":"yielded","reason":"managed effects settled before model admission"}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn version_includes_ignored_runtime_files_and_local_git_state() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join(".gitignore"), "runtime/\n").unwrap();
        std::fs::create_dir(temp.path().join("runtime")).unwrap();
        std::fs::create_dir(temp.path().join(".git")).unwrap();
        std::fs::write(temp.path().join(".git/HEAD"), "first").unwrap();
        std::fs::write(temp.path().join("runtime/input"), "old").unwrap();
        let before = Version::read(temp.path()).unwrap();
        std::fs::write(temp.path().join("runtime/input"), "new").unwrap();
        std::fs::write(temp.path().join(".git/HEAD"), "second").unwrap();
        let changes = before.changes(&Version::read(temp.path()).unwrap());
        assert!(changes.contains(&"runtime/input".to_owned()));
        assert!(changes.contains(&".git/HEAD".to_owned()));
    }

    #[test]
    fn version_does_not_follow_external_git_metadata_or_dependency_links() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        symlink("/outside/dependency", temp.path().join("deps")).unwrap();
        assert!(Version::read(temp.path()).is_err());
        std::fs::remove_file(temp.path().join("deps")).unwrap();
        std::fs::write(temp.path().join(".git"), "gitdir: /outside/worktree").unwrap();
        assert!(Version::read(temp.path()).is_err());
    }
}
