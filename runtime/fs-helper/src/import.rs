//! Narrow trusted-picker import. Paths are never added to ordinary Agent filesystem authority.
use super::*;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
#[derive(Clone, Copy)]
pub enum ImportKind {
    File,
    Directory,
}
pub struct ImportedEntry {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub file_count: usize,
    pub mime_type: Option<String>,
}
pub struct ImportedSelection {
    pub entries: Vec<ImportedEntry>,
    pub file_count: usize,
    pub total_bytes: u64,
}
const FILE_LIMIT: u64 = 16 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 64 * 1024 * 1024;
fn open_absolute(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(invalid("picker path must be absolute"));
    }
    let mut parent: File = fs::open(
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io)?
    .into();
    let parts: Vec<_> = path.components().collect();
    for (index, part) in parts.iter().enumerate() {
        match part {
            Component::RootDir if index == 0 => continue,
            Component::Normal(name) => {
                let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
                let flags = if index + 1 < parts.len() {
                    flags | OFlags::DIRECTORY
                } else {
                    flags
                };
                parent = fs::openat(&parent, *name, flags, Mode::empty())
                    .map_err(io)?
                    .into();
            }
            _ => return Err(invalid("picker path contains an invalid component")),
        }
    }
    Ok(parent)
}
fn mime(name: &str) -> String {
    mime_guess::from_path(name)
        .first_or_octet_stream()
        .to_string()
}
fn accepts(name: &str, accept: &[String]) -> bool {
    let lower = name.to_ascii_lowercase();
    let mime = mime(name);
    accept.is_empty()
        || accept.iter().any(|item| {
            let item = item.to_ascii_lowercase();
            if item.starts_with('.') {
                lower.ends_with(&item)
            } else if let Some(prefix) = item.strip_suffix("/*") {
                mime.starts_with(&format!("{prefix}/"))
            } else {
                item == mime
            }
        })
}
struct Copier<'a> {
    files: usize,
    bytes: u64,
    entries: usize,
    accept: &'a [String],
}
impl Copier<'_> {
    fn copy(
        &mut self,
        mut source: File,
        destination: &File,
        name: &str,
        depth: usize,
    ) -> Result<()> {
        self.entries += 1;
        if self.entries > 512 || depth > 16 {
            return Err(invalid("picker selection exceeds directory budget"));
        }
        let before = source.metadata().map_err(io)?;
        if before.is_dir() {
            fs::mkdirat(destination, name, Mode::from_raw_mode(0o700)).map_err(io)?;
            let target = directory(destination, name)?;
            for entry in fs::Dir::read_from(&source).map_err(io)? {
                let entry = entry.map_err(io)?;
                let child = entry
                    .file_name()
                    .to_str()
                    .map_err(|_| invalid("picker names must be UTF-8"))?;
                if child == "." || child == ".." {
                    continue;
                }
                let fd = fs::openat(
                    &source,
                    child,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                    Mode::empty(),
                )
                .map_err(io)?
                .into();
                self.copy(fd, &target, child, depth + 1)?;
            }
        } else if before.is_file() {
            if before.nlink() != 1
                || before.len() > FILE_LIMIT
                || self.files >= 256
                || !accepts(name, self.accept)
            {
                return Err(invalid(
                    "picker file violates size, type, link or count limits",
                ));
            }
            self.files += 1;
            let mut target: File = fs::openat(
                destination,
                name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(io)?
            .into();
            let mut buffer = [0u8; 65536];
            let mut bytes = 0u64;
            loop {
                let size = source.read(&mut buffer).map_err(io)?;
                if size == 0 {
                    break;
                }
                bytes += size as u64;
                self.bytes += size as u64;
                if bytes > FILE_LIMIT || self.bytes > TOTAL_LIMIT {
                    return Err(invalid("picker selection exceeds byte budget"));
                }
                target.write_all(&buffer[..size]).map_err(io)?;
            }
            let after = source.metadata().map_err(io)?;
            if bytes != before.len()
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                return Err(conflict());
            }
            target.sync_all().map_err(io)?;
        } else {
            return Err(invalid(
                "picker supports only regular files and directories",
            ));
        }
        Ok(())
    }
}
/// Destination must be a fresh, private Core staging directory. Caller removes it on any failure.
pub fn import_selection(
    paths: &[PathBuf],
    destination: &Path,
    kind: ImportKind,
    accept: &[String],
) -> Result<ImportedSelection> {
    if paths.is_empty() || paths.len() > 256 || accept.len() > 64 {
        return Err(invalid("invalid picker selection budget"));
    }
    let destination_fd = open_absolute(destination)?;
    if !destination_fd.metadata().map_err(io)?.is_dir() {
        return Err(invalid("invalid staging directory"));
    }
    let mut copier = Copier {
        files: 0,
        bytes: 0,
        entries: 0,
        accept,
    };
    let mut entries = Vec::new();
    for path in paths {
        let source = open_absolute(path)?;
        let metadata = source.metadata().map_err(io)?;
        if !(match kind {
            ImportKind::File => metadata.is_file(),
            ImportKind::Directory => metadata.is_dir(),
        }) {
            return Err(invalid("picker selection kind mismatch"));
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| invalid("invalid picker filename"))?
            .to_owned();
        let slot = uuid::Uuid::new_v4().to_string();
        fs::mkdirat(&destination_fd, slot.as_str(), Mode::from_raw_mode(0o700)).map_err(io)?;
        let parent = directory(&destination_fd, &slot)?;
        let before = copier.bytes;
        let files_before = copier.files;
        copier.copy(source, &parent, &name, 0)?;
        entries.push(ImportedEntry {
            name: name.clone(),
            path: destination.join(slot).join(&name),
            size: copier.bytes - before,
            file_count: copier.files - files_before,
            mime_type: metadata.is_file().then(|| mime(&name)),
        });
    }
    Ok(ImportedSelection {
        entries,
        file_count: copier.files,
        total_bytes: copier.bytes,
    })
}
