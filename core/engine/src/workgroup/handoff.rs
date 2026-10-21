//! 隔离 worker 的已提交交接；执行、验证与交付状态仍由 Workgroup 持有。
use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_HANDOFF_BYTES: usize = 32 * 1024 * 1024;

pub(super) fn path(root: &Path, task: &str, generation: u32) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(format!("{task}\0{generation}")));
    root.join("handoffs").join(format!("{key}.json"))
}

pub(super) async fn persist(
    engine: &crate::Engine,
    thread: &str,
    turn: &str,
    path: &Path,
) -> Result<()> {
    let cell = engine.cell(thread).await?;
    let state = cell.state.lock().await;
    let report = crate::agents::snapshot_turn(&state, turn, 0, MAX_HANDOFF_BYTES)?;
    let bytes = serde_json::to_vec(&report)?;
    ensure!(
        bytes.len() <= MAX_HANDOFF_BYTES && report["nextOffset"].is_null(),
        "worker handoff exceeds 32 MiB; original history retained"
    );
    drop(state);
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<()> {
        std::fs::create_dir_all(path.parent().context("handoff has no parent")?)?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })
    .await??;
    Ok(())
}

pub(super) fn read(
    root: &Path,
    task: &str,
    generation: u32,
    offset: usize,
) -> Result<Option<Value>> {
    let path = path(root, task, generation);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.len() <= MAX_HANDOFF_BYTES as u64,
        "invalid worker handoff size"
    );
    let bytes = std::fs::read(&path)?;
    let mut value: Value = serde_json::from_slice(&bytes)?;
    let text = value["text"]
        .as_str()
        .context("worker handoff has no text")?;
    ensure!(
        offset <= text.len() && text.is_char_boundary(offset),
        "offset must be a UTF-8 boundary in the latest handoff; reread from 0 if sourceItemId changed"
    );
    let mut end = offset.saturating_add(8192).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let page = text[offset..end].to_owned();
    let next = (end < text.len()).then_some(end);
    value["text"] = Value::String(page);
    value["offset"] = serde_json::json!(offset);
    value["nextOffset"] = serde_json::json!(next);
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn durable_handoffs_page_utf8_and_do_not_reuse_another_generation() {
        let root = tempfile::tempdir().unwrap();
        let location = path(root.path(), "task", 3);
        std::fs::create_dir_all(location.parent().unwrap()).unwrap();
        let text = "交接证据".repeat(1200);
        let report = json!({"source":"checkpoint","sourceItemId":"committed-item","partial":true,
            "textBytes":text.len(),"text":text,"resourcesReleased":false});
        std::fs::write(location, serde_json::to_vec(&report).unwrap()).unwrap();
        let first = read(root.path(), "task", 3, 0).unwrap().unwrap();
        assert_eq!(first["sourceItemId"], "committed-item");
        assert_eq!(first["resourcesReleased"], false);
        assert_eq!(first["partial"], true);
        let offset = first["nextOffset"].as_u64().unwrap() as usize;
        let last = read(root.path(), "task", 3, offset).unwrap().unwrap();
        assert!(last["nextOffset"].is_null());
        assert_eq!(
            format!(
                "{}{}",
                first["text"].as_str().unwrap(),
                last["text"].as_str().unwrap()
            ),
            text
        );
        assert!(read(root.path(), "task", 4, 0).unwrap().is_none());
        assert!(read(root.path(), "task", 3, 1).is_err());
        assert!(read(root.path(), "task", 3, text.len() + 1).is_err());
    }
}
