use super::{File, MAX_FILE_BYTES, MAX_TREE_BYTES, Tree, excluded, valid_path};
use anyhow::{Context, Result, ensure};
use rustix::fs::{self, Dir, Mode, OFlags};
use std::{
    collections::BTreeSet,
    fs::File as Handle,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 20000;
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);

pub(super) fn read(root: &Path) -> Result<Tree> {
    // Normalize a trailing slash so it cannot bypass NOFOLLOW on the root.
    // The deployment owns the root's ancestors; every entry below this opened
    // directory is untrusted and is resolved relative to a pinned descriptor.
    let root: PathBuf = root.components().collect();
    let directory: Handle = fs::open(&root, READ_FLAGS | OFlags::DIRECTORY, Mode::empty())?.into();
    let mut snapshot = Snapshot::default();
    snapshot.visit(&directory, "", 0)?;
    Ok(snapshot.tree)
}

struct Reap(std::process::Child);
impl std::ops::Deref for Reap {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for Reap {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for Reap {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

pub(super) fn read_source(root: &Path, required: BTreeSet<String>, use_git: bool) -> Result<Tree> {
    use std::process::{Command, Stdio};
    let root: PathBuf = root.components().collect();
    let directory: Handle = fs::open(&root, READ_FLAGS | OFlags::DIRECTORY, Mode::empty())?.into();
    let mut selected = BTreeSet::new();
    // 不执行 hooks、fsmonitor 或任何仓库命令；也不继承 GIT_* 重定向和凭据。
    let (selected_by_git, names) = if use_git {
        let mut child = Reap(
            Command::new("/usr/bin/git")
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_OPTIONAL_LOCKS", "0")
                .current_dir(&root)
                .args([
                    "-c",
                    "core.fsmonitor=false",
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ".",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?,
        );
        let mut names = Vec::new();
        let mut stdout = child.stdout.take().unwrap();
        fs::fcntl_setfl(&stdout, fs::fcntl_getfl(&stdout)? | OFlags::NONBLOCK)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut buffer = [0u8; 8192];
        loop {
            if std::time::Instant::now() >= deadline || names.len() > 2 * 1024 * 1024 {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("Git source enumeration exceeded its time or manifest capacity");
            }
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => names.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.into());
                }
            }
        }
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("Git source enumeration did not settle");
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        (status.success(), names)
    } else {
        (false, Vec::new())
    };
    let mut snapshot = Snapshot {
        project_source: true,
        ..Default::default()
    };
    if selected_by_git {
        for name in names.split(|b| *b == 0).filter(|name| !name.is_empty()) {
            let name = std::str::from_utf8(name).context("non-UTF8 Git source path")?;
            ensure!(valid_path(name), "unsupported tracked source path: {name}");
            selected.insert(name.to_owned());
        }
        selected.extend(required);
        ensure!(
            selected.len() <= MAX_ENTRIES,
            "source selection capacity exceeded"
        );
        let mut prefixes = BTreeSet::new();
        for name in &selected {
            let mut parent = Path::new(name).parent();
            while let Some(path) = parent {
                prefixes.insert(path.to_string_lossy().into_owned());
                parent = path.parent();
            }
        }
        snapshot.selection = Some((selected, prefixes));
    } else {
        // 有 Git 元数据而枚举失败不能退回包含全部忽略产物的另一种输入。
        ensure!(
            !use_git || !root.join(".git").exists(),
            "Git source selection failed; no shared fallback was performed here"
        );
        snapshot.required = required;
    }
    snapshot.visit(&directory, "", 0)?;
    Ok(snapshot.tree)
}

#[derive(Default)]
struct Snapshot {
    tree: Tree,
    bytes: usize,
    entries: usize,
    project_source: bool,
    selection: Option<(
        std::collections::BTreeSet<String>,
        std::collections::BTreeSet<String>,
    )>,
    required: std::collections::BTreeSet<String>,
    ignores: Vec<ignore::gitignore::Gitignore>,
}

impl Snapshot {
    fn visit(&mut self, directory: &Handle, prefix: &str, depth: usize) -> Result<()> {
        ensure!(depth < 40, "source directory depth exceeded");
        let previous_ignores = self.ignores.len();
        if self.project_source && self.selection.is_none() {
            match fs::openat(directory, ".gitignore", READ_FLAGS, Mode::empty()) {
                Ok(fd) => {
                    let mut file: Handle = fd.into();
                    ensure!(file.metadata()?.is_file(), "unsupported .gitignore entry");
                    let mut text = String::new();
                    (&mut file)
                        .take(1024 * 1024 + 1)
                        .read_to_string(&mut text)?;
                    ensure!(text.len() <= 1024 * 1024, ".gitignore exceeds capacity");
                    let mut builder = ignore::gitignore::GitignoreBuilder::new(prefix);
                    for line in text.lines() {
                        builder.add_line(None, line)?;
                    }
                    self.ignores.push(builder.build()?);
                }
                Err(error) if error == rustix::io::Errno::NOENT => {}
                Err(error) => {
                    return Err(error).context("cannot read .gitignore without following links");
                }
            }
        }
        for entry in Dir::read_from(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_str().context("non-UTF8 source name")?;
            if matches!(name, "." | "..") || excluded(name) {
                continue;
            }
            self.entries += 1;
            ensure!(
                self.entries <= MAX_ENTRIES,
                "source entry capacity exceeded"
            );
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            ensure!(valid_path(&path), "invalid source path");
            if let Some((files, directories)) = &self.selection {
                if !files.contains(&path) && !directories.contains(&path) {
                    continue;
                }
            } else if self.project_source {
                let is_dir = entry.file_type() == rustix::fs::FileType::Directory;
                let mut ignored = false;
                for matcher in &self.ignores {
                    let decision = matcher.matched_path_or_any_parents(&path, is_dir);
                    if !decision.is_none() {
                        ignored = decision.is_ignore();
                    }
                }
                let required = self.required.contains(&path)
                    || self
                        .required
                        .iter()
                        .any(|name| name.starts_with(&format!("{path}/")));
                if ignored && !required {
                    continue;
                }
            }
            // Never check a pathname and then reopen it. Type, link count,
            // executable mode and bytes all come from the same opened object.
            let file: Handle = fs::openat(directory, name, READ_FLAGS, Mode::empty())?.into();
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                self.visit(&file, &path, depth + 1)?;
                continue;
            }
            ensure!(
                metadata.is_file() && metadata.len() <= MAX_FILE_BYTES as u64,
                "unsupported source entry or file size at {path} (maximum {MAX_FILE_BYTES} bytes)"
            );
            ensure!(metadata.nlink() == 1, "source hardlinks are unsupported");
            ensure!(self.tree.len() < 10000, "source file capacity exceeded");
            // Concurrent growth cannot bypass the actual byte budget or cause
            // an unbounded allocation. A snapshot is not an atomic filesystem view.
            let limit = MAX_FILE_BYTES.min(MAX_TREE_BYTES - self.bytes);
            let mut bytes = Vec::new();
            (&file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= limit,
                "source snapshot byte capacity exceeded"
            );
            ensure!(file.metadata()?.nlink() == 1, "source file links changed");
            self.bytes += bytes.len();
            self.tree.insert(
                path,
                File {
                    bytes,
                    executable: metadata.mode() & 0o111 != 0,
                },
            );
        }
        self.ignores.truncate(previous_ignores);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn source_projection_preserves_tracked_large_dirty_and_untracked_source_but_not_ignored_products()
     {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("/usr/bin/git")
                    .current_dir(root)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        git(&["init", "-q"]);
        std::fs::write(root.join("tracked.bin"), vec![7u8; 3 * 1024 * 1024]).unwrap();
        std::fs::write(root.join("tracked.txt"), "before").unwrap();
        git(&["add", "tracked.bin", "tracked.txt"]);
        std::fs::write(root.join(".gitignore"), "tracked.bin\nbuild\ndeps\n").unwrap();
        std::fs::write(root.join("tracked.txt"), "dirty source").unwrap();
        std::fs::write(root.join("untracked.py"), "source").unwrap();
        std::fs::create_dir(root.join("build")).unwrap();
        Handle::create(root.join("build/large"))
            .unwrap()
            .set_len(MAX_TREE_BYTES as u64 + 1)
            .unwrap();
        symlink("/outside/private", root.join("deps")).unwrap();
        let source = read_source(root, BTreeSet::new(), true).unwrap();
        assert_eq!(source["tracked.bin"].bytes.len(), 3 * 1024 * 1024);
        assert_eq!(source["tracked.txt"].bytes, b"dirty source");
        assert_eq!(source["untracked.py"].bytes, b"source");
        assert!(
            !source
                .keys()
                .any(|path| path.starts_with("build") || path == "deps")
        );
        let materialized = root.join("build/private-worker");
        super::super::materialize(&source, &materialized).unwrap();
        // 没有 .git 的 worker 仍保留原先已跟踪、后来被忽略的输入。
        assert_eq!(
            read_source(&materialized, source.keys().cloned().collect(), false).unwrap(),
            source
        );
        let mut changed = source.clone();
        changed.get_mut("tracked.txt").unwrap().bytes = b"candidate".to_vec();
        let store = root.join("build/store");
        let hash = super::super::store(&store, &changed).unwrap();
        assert_eq!(super::super::load(&store, &hash).unwrap(), changed);
    }

    #[test]
    fn source_projection_non_git_ignores_nested_products_and_rejects_unignored_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(root.join(".gitignore"), "build/\ndeps\n").unwrap();
        std::fs::create_dir(root.join("build")).unwrap();
        symlink("/outside/private", root.join("build/private")).unwrap();
        symlink("/outside/deps", root.join("deps")).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/.gitignore"), "*.tmp\n!kept.tmp\n").unwrap();
        std::fs::write(root.join("src/hidden.tmp"), "ignored").unwrap();
        std::fs::write(root.join("src/kept.tmp"), "source").unwrap();
        let source = read_source(root, BTreeSet::new(), true).unwrap();
        assert!(source.contains_key("src/kept.tmp"));
        assert!(!source.contains_key("src/hidden.tmp"));
        let required = BTreeSet::from(["src/hidden.tmp".into()]);
        assert_eq!(
            read_source(root, required, true).unwrap()["src/hidden.tmp"].bytes,
            b"ignored"
        );
        symlink("/outside/source", root.join("required.py")).unwrap();
        assert!(read_source(root, BTreeSet::new(), true).is_err());
        std::fs::remove_file(root.join("required.py")).unwrap();
        std::fs::remove_file(root.join(".gitignore")).unwrap();
        symlink("/outside/ignore", root.join(".gitignore")).unwrap();
        assert!(read_source(root, BTreeSet::new(), true).is_err());
    }

    #[test]
    fn pinned_directory_survives_path_replacement_without_following_the_new_link() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("safe"), b"source").unwrap();
        std::fs::write(outside.join("secret"), b"outside").unwrap();
        let directory = fs::open(&root, READ_FLAGS | OFlags::DIRECTORY, Mode::empty())
            .unwrap()
            .into();
        std::fs::rename(&root, temp.path().join("old-source")).unwrap();
        symlink(&outside, &root).unwrap();
        let mut snapshot = Snapshot::default();
        snapshot.visit(&directory, "subdirectory", 1).unwrap();
        assert_eq!(snapshot.tree.len(), 1);
        assert_eq!(snapshot.tree["subdirectory/safe"].bytes, b"source");
        assert!(read(&root).is_err());
        assert!(read(&root.join("")).is_err());
    }

    #[test]
    fn rejects_links_special_files_and_oversized_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"private").unwrap();
        let path = root.join("entry");
        symlink(&outside, &path).unwrap();
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        symlink(temp.path(), &path).unwrap();
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&outside, &path).unwrap();
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        Handle::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES as u64 + 1)
            .unwrap();
        assert!(read(&root).is_err());
    }

    #[test]
    fn snapshot_preserves_modes_exclusions_and_total_limits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(root.join("run"), b"script").unwrap();
        std::fs::set_permissions(root.join("run"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        symlink("/unreadable", root.join(".git/ignored")).unwrap();
        let tree = read(root).unwrap();
        assert_eq!(tree.len(), 1);
        assert!(tree["run"].executable);
        assert_eq!(tree["run"].bytes, b"script");
        for index in 0..8 {
            Handle::create(root.join(format!("file-{index}")))
                .unwrap()
                .set_len(MAX_FILE_BYTES as u64)
                .unwrap();
        }
        assert!(read(root).is_err());
    }

    #[test]
    fn concurrent_link_replacement_never_reads_outside_bytes() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"private outside bytes").unwrap();
        let entry = root.join("entry");
        let replacement = temp.path().join("replacement");
        std::fs::write(&entry, b"safe source bytes").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let writer_stop = stop.clone();
        let writer = std::thread::spawn(move || {
            while !writer_stop.load(Ordering::Relaxed) {
                symlink(&outside, &replacement).unwrap();
                std::fs::rename(&replacement, &entry).unwrap();
                std::fs::write(&replacement, b"safe source bytes").unwrap();
                std::fs::rename(&replacement, &entry).unwrap();
            }
        });
        let mut escaped = false;
        for _ in 0..2048 {
            if let Ok(tree) = read(&root) {
                escaped |= tree.values().any(|file| file.bytes != b"safe source bytes");
            }
        }
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert!(!escaped, "snapshot followed a concurrently replaced link");
    }
}
