use crate::{InstalledSkill, PluginDetail};
use anyhow::{Context, Result, bail, ensure};
use rustix::fs::{Dir, Mode, OFlags, open, openat};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};
const MAX_FILES: usize = 4096;
const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(crate) struct PackageFile {
    pub bytes: Vec<u8>,
    pub executable: bool,
}
impl std::ops::Deref for PackageFile {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}
pub(crate) type Files = BTreeMap<String, PackageFile>;

/// Open every ancestor without following links, then enumerate/read only through
/// anchored descriptors. Concurrent source edits may fail or form a new snapshot;
/// they cannot redirect reads outside the selected package.
pub(crate) fn directory(path: &Path) -> Result<File> {
    ensure!(path.is_absolute(), "package root must be absolute");
    let mut dir = File::from(open(
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    for c in path.components() {
        match c {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(n) => {
                dir = File::from(openat(
                    &dir,
                    n,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )?);
            }
            _ => bail!("parent traversal rejected"),
        }
    }
    Ok(dir)
}
/// Catalogs are untrusted inputs too. Bound actual reads (not just the initial
/// stat), and never open a FIFO or link using the blocking filesystem APIs.
pub(crate) fn read_catalog(root: &Path, path: &Path) -> Result<Vec<u8>> {
    let relative = path
        .strip_prefix(root)
        .context("catalog outside marketplace root")?;
    let mut dir = directory(root)?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            bail!("invalid catalog path")
        };
        let last = components.peek().is_none();
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let mut file = File::from(openat(
            &dir,
            name,
            if last {
                flags
            } else {
                flags | OFlags::DIRECTORY
            },
            Mode::empty(),
        )?);
        if !last {
            dir = file;
            continue;
        }
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.nlink() == 1,
            "catalog must be a regular single-link file"
        );
        const LIMIT: u64 = 1024 * 1024;
        ensure!(metadata.len() <= LIMIT, "marketplace exceeds 1 MiB");
        let mut bytes = Vec::new();
        file.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= LIMIT as usize, "marketplace exceeds 1 MiB");
        let after = file.metadata()?;
        ensure!(
            after.nlink() == 1
                && after.len() == metadata.len()
                && after.mtime() == metadata.mtime()
                && after.mtime_nsec() == metadata.mtime_nsec(),
            "marketplace changed during read"
        );
        return Ok(bytes);
    }
    bail!("catalog file missing")
}
pub(crate) fn snapshot(root: &Path) -> Result<Files> {
    fn walk(
        dir: &File,
        prefix: &str,
        files: &mut Files,
        bytes: &mut usize,
        entries: &mut usize,
    ) -> Result<()> {
        for entry in Dir::read_from(dir)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .to_str()
                .context("non-UTF8 package path")?;
            if name == "." || name == ".." || name == ".git" {
                continue;
            }
            *entries += 1;
            ensure!(*entries <= 8192, "package exceeds 8192 filesystem entries");
            let path = if prefix.is_empty() {
                name.into()
            } else {
                format!("{prefix}/{name}")
            };
            let mut file = File::from(
                openat(
                    dir,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .with_context(|| format!("unsafe package entry {path}"))?,
            );
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                walk(&file, &path, files, bytes, entries)?;
            } else {
                ensure!(
                    metadata.is_file() && metadata.nlink() == 1,
                    "package entry must be a regular single-link file: {path}"
                );
                ensure!(files.len() < MAX_FILES, "package exceeds 4096 files");
                ensure!(
                    metadata.len() <= MAX_BYTES as u64,
                    "package file exceeds 64 MiB: {path}"
                );
                let mut data = Vec::new();
                file.by_ref()
                    .take((MAX_BYTES - *bytes + 1) as u64)
                    .read_to_end(&mut data)?;
                *bytes += data.len();
                ensure!(*bytes <= MAX_BYTES, "package exceeds 64 MiB total");
                let after = file.metadata()?;
                ensure!(
                    after.nlink() == 1
                        && after.len() == metadata.len()
                        && after.mtime() == metadata.mtime()
                        && after.mtime_nsec() == metadata.mtime_nsec(),
                    "package changed during read: {path}"
                );
                files.insert(
                    path,
                    PackageFile {
                        bytes: data,
                        executable: metadata.mode() & 0o111 != 0,
                    },
                );
            }
        }
        Ok(())
    }
    let mut files = Files::new();
    walk(&directory(root)?, "", &mut files, &mut 0, &mut 0)?;
    Ok(files)
}
pub(crate) fn digest(files: &Files) -> String {
    let mut h = Sha256::new();
    for (p, b) in files {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p.as_bytes());
        h.update((b.len() as u64).to_le_bytes());
        h.update([u8::from(b.executable)]);
        h.update(&b.bytes);
    }
    format!("{:x}", h.finalize())
}
pub(crate) fn relative(s: &str) -> Result<String> {
    ensure!(
        !s.is_empty() && !s.contains('\\'),
        "invalid package-relative path: {s}"
    );
    let p = Path::new(s);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(n) => out.push(n),
            Component::CurDir => {}
            _ => bail!("package path escape rejected: {s}"),
        }
    }
    ensure!(!out.as_os_str().is_empty(), "empty package-relative path");
    Ok(out.to_str().context("invalid path")?.into())
}
fn json(files: &Files, path: &str) -> Result<Option<Value>> {
    files
        .get(path)
        .map(|v| serde_json::from_slice(&v.bytes).with_context(|| format!("invalid {path}")))
        .transpose()
}
fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().into()
}
fn paths(v: &Value) -> Result<Vec<String>> {
    match v {
        Value::String(s) => Ok(vec![relative(s)?]),
        Value::Array(a) => a
            .iter()
            .map(|v| relative(v.as_str().context("component path must be string")?))
            .collect(),
        _ => bail!("component paths must be string or array"),
    }
}
fn declaration(v: &Value, files: &Files, label: &str, diagnostics: &mut Vec<String>) -> Result<()> {
    match v {
        Value::String(s) => {
            let p = relative(s)?;
            if !files.contains_key(&p) {
                diagnostics.push(format!("{label}: declared optional file missing: {p}"));
            }
        }
        Value::Array(a) => {
            for x in a {
                declaration(x, files, label, diagnostics)?;
            }
        }
        Value::Object(_) => {}
        _ => diagnostics.push(format!("{label}: unsupported optional declaration: {v}")),
    }
    Ok(())
}
fn asset(v: &Value, files: &Files, diagnostics: &mut Vec<String>) -> Result<()> {
    if let Some(s) = v.as_str() {
        let p = relative(s)?;
        if !files.contains_key(&p) {
            diagnostics.push(format!("interface: optional asset missing: {p}"));
        }
    } else {
        diagnostics.push("interface: optional asset must be a relative path".into());
    }
    Ok(())
}
pub(crate) fn parse(files: &Files, id: &str, source: &Path, cache: &Path) -> Result<PluginDetail> {
    // Unrelated/malformed root JSON is not a recognized portable manifest and
    // may coexist with a valid compatibility package.
    let root = json(files, "plugin.json").unwrap_or(None);
    let portable = root
        .as_ref()
        .and_then(|v| v.get("$schema"))
        .and_then(Value::as_str)
        .is_some_and(|s| s.contains("agent-plugins.org/"));
    if portable {
        ensure!(
            root.as_ref().unwrap()["$schema"]
                == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "unsupported Agent Plugins schema; compatibility fallback prohibited"
        );
    }
    let legacy_path = [
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".cursor-plugin/plugin.json",
    ]
    .into_iter()
    .find(|p| files.contains_key(*p));
    // A valid inline object replaces the whole overlay, including an empty object.
    let inline = root
        .as_ref()
        .and_then(|r| r.pointer("/extensions/com.openai"))
        .filter(|v| v.is_object());
    let legacy = if portable && inline.is_some() {
        None
    } else {
        legacy_path.map(|p| json(files, p)).transpose()?.flatten()
    };
    let manifest = if portable {
        root.as_ref().unwrap()
    } else {
        legacy.as_ref().context("no supported plugin manifest")?
    };
    let overlay = if portable {
        inline.or(legacy.as_ref()).unwrap_or(&Value::Null)
    } else {
        manifest
    };
    let mut name = text(manifest, "name");
    if !portable && name.trim().is_empty() {
        name = source
            .file_name()
            .and_then(|n| n.to_str())
            .context("legacy source basename missing")?
            .into();
    }
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
        "invalid plugin name"
    );
    let mut d = PluginDetail {
        revision: 0,
        id: id.into(),
        name: name.clone(),
        display_name: overlay
            .pointer("/interface/displayName")
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .into(),
        description: text(manifest, "description"),
        version: manifest
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        installed: false,
        installed_version: None,
        installed_digest: None,
        installed_skills: vec![],
        installed_onboarding_skill: None,
        enabled: false,
        source: source.into(),
        source_digest: digest(files),
        catalog_source: serde_json::json!({"type":"local","path":source}),
        policy: serde_json::json!({"installation":"AVAILABLE","authentication":"ON_INSTALL"}),
        interface: crate::metadata::interface(overlay.get("interface"), Some(files), cache),
        source_kind: None,
        resolved_commit: None,
        package_version: None,
        integrity: None,
        components: vec![],
        diagnostics: vec![],
        skills: vec![],
        onboarding_skill: None,
    };
    if let Some(interface) = overlay.get("interface") {
        if !interface.is_object() {
            d.diagnostics
                .push("interface: optional metadata must be an object".into());
        }
        for key in ["composerIcon", "logo", "logoDark", "iconSmall", "iconLarge"] {
            if let Some(value) = interface.get(key) {
                asset(value, files, &mut d.diagnostics)?;
            }
        }
        if let Some(value) = interface.get("screenshots") {
            if let Some(values) = value.as_array() {
                for value in values {
                    asset(value, files, &mut d.diagnostics)?;
                }
            } else {
                d.diagnostics
                    .push("interface: screenshots must be an array".into());
            }
        }
    }
    let roots = if portable {
        vec!["skills".into()]
    } else {
        overlay
            .get("skills")
            .map(paths)
            .transpose()?
            .unwrap_or_else(|| vec!["skills".into()])
    };
    let onboarding_value = if portable && inline.is_some() {
        overlay.get("onboardingSkill")
    } else {
        overlay
            .pointer("/extensions/com.openai/onboardingSkill")
            .or_else(|| overlay.get("onboardingSkill"))
    };
    let onboarding = if let Some(value) = onboarding_value {
        if let Some(path) = value.as_str() {
            Some(relative(path)?)
        } else {
            d.diagnostics
                .push("onboardingSkill: optional path must be a string".into());
            None
        }
    } else {
        None
    };
    let revision = digest(files);
    let mut selected = BTreeMap::new();
    for root in roots {
        let direct = if root.ends_with("/SKILL.md") {
            root.clone()
        } else {
            format!("{root}/SKILL.md")
        };
        if files.contains_key(&direct) {
            selected.insert(direct, ());
            continue;
        }
        let prefix = format!("{root}/");
        for p in files.keys() {
            if let Some(rest) = p.strip_prefix(&prefix) {
                if rest.ends_with("/SKILL.md") && rest.split('/').count() == 2 {
                    selected.insert(p.clone(), ());
                }
            }
        }
        if overlay.get("skills").is_some() && !portable {
            ensure!(
                files.keys().any(|p| p.starts_with(&prefix)),
                "declared skill directory missing: {root}"
            );
        }
    }
    for (path, ()) in selected {
        let skillroot = Path::new(&path).parent().unwrap();
        let stem = skillroot
            .file_name()
            .unwrap()
            .to_str()
            .context("invalid skill name")?;
        let raw = std::str::from_utf8(&files[&path])?;
        let mut meta = Value::Null;
        if let Some(rest) = raw.strip_prefix("---\n") {
            let end = rest
                .find("\n---")
                .or_else(|| rest.find("\n..."))
                .context("unterminated skill frontmatter")?;
            ensure!(end <= 32768, "skill frontmatter exceeds 32 KiB");
            meta = serde_yaml_ng::from_str(&rest[..end])?;
        }
        let mut implicit = true;
        let policy_path = format!("{}/agents/openai.yaml", skillroot.display());
        if let Some(raw) = files.get(&policy_path) {
            let policy: Value =
                serde_yaml_ng::from_slice(raw).context("invalid agents/openai.yaml")?;
            if let Some(v) = policy.pointer("/policy/allow_implicit_invocation") {
                implicit = v
                    .as_bool()
                    .context("allow_implicit_invocation must be boolean")?;
            }
            if let Some(deps) = policy.get("dependencies") {
                d.diagnostics.push(format!(
                    "skill {stem} declared dependencies (not yet resolved): {deps}"
                ));
            }
        }
        let sid = format!(
            "plugin-{:x}-{}",
            Sha256::digest(format!("{id}/{path}").as_bytes()),
            stem.chars()
                .filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
                .take(40)
                .collect::<String>()
        );
        // Admission matches Engine Skill::load before anything enters durable
        // history; a bad record must never poison startup rehydration.
        let name = meta.get("name").and_then(Value::as_str).unwrap_or(stem);
        let description = meta
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        ensure!(
            !name.is_empty() && name.len() <= 256 && description.len() <= 4096,
            "invalid skill metadata: {path} (name must be 1..256 bytes; description at most 4096 bytes)"
        );
        let valid_id = |value: &str| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
        };
        ensure!(
            valid_id(&sid) && valid_id(&revision),
            "invalid generated skill identity: {path}"
        );
        let onboarding_match = onboarding
            .as_ref()
            .is_some_and(|p| p == &path || Path::new(p) == skillroot);
        if onboarding_match {
            d.onboarding_skill = Some(sid.clone());
        }
        d.skills.push(InstalledSkill {
            id: sid,
            revision: revision.clone(),
            root: cache.join(skillroot),
            package_root: cache.into(),
            plugin_id: id.into(),
            name: name.into(),
            description: description.into(),
            allow_implicit_invocation: implicit,
            onboarding: onboarding_match,
        });
    }
    if onboarding.is_some() && d.onboarding_skill.is_none() {
        d.diagnostics
            .push("onboardingSkill: optional path does not identify a declared skill".into());
    }
    if !d.skills.is_empty() {
        d.components.push("skills".into());
    }
    let mcp = if portable {
        files.contains_key("mcp.json")
    } else {
        overlay.get("mcpServers").is_some() || files.contains_key(".mcp.json")
    };
    if !portable {
        if let Some(v) = overlay.get("mcpServers") {
            declaration(v, files, "mcp", &mut d.diagnostics)?;
        }
    }
    if mcp {
        d.components.push("mcp".into());
        d.diagnostics
            .push("MCP declarations require explicit digest trust and connection".into());
    }
    if overlay.get("hooks").is_some() || files.contains_key("hooks/hooks.json") {
        crate::hooks::discover(overlay.get("hooks"), files, portable, &mut d.diagnostics);
        d.components.push("hooks".into());
        d.diagnostics.push("hooks: declarations do not execute during discovery; explicit hook definition trust is required".into());
    }
    for (key, default, label) in [("apps", ".app.json", "apps")] {
        let present = if let Some(v) = overlay.get(key) {
            declaration(v, files, label, &mut d.diagnostics)?;
            true
        } else {
            files.contains_key(default)
        };
        if present {
            d.components.push(label.into());
            d.diagnostics
                .push("Connector IDs require explicit mapping and account authentication".into());
        }
    }
    if let Some(commands) = overlay.get("commands") {
        for path in match commands {
            Value::String(path) => vec![path.as_str()],
            Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        } {
            relative(path)?;
        }
        d.diagnostics
            .push("explicit legacy commands declaration: migration not yet supported".into());
    } else if files.keys().any(|p| p.starts_with("commands/")) {
        d.diagnostics
            .push("legacy commands migration not yet supported".into());
    }
    Ok(d)
}
