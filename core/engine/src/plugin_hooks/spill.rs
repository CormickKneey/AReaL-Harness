//! Codex 0.162.1 uses UTF-8 bytes / 4 as the approximate token budget,
//! retains both ends and budgets the recovery footer before the preview.
use super::*;
fn tokens(text: &str) -> usize {
    text.len().saturating_add(3) / 4
}
fn preview(text: &str, limit: usize) -> String {
    let bytes = limit.saturating_mul(4);
    if text.len() <= bytes {
        return text.into();
    }
    let head = text.floor_char_boundary(bytes / 2);
    let tail = text.ceil_char_boundary(text.len().saturating_sub(bytes - bytes / 2));
    let removed = text.len().saturating_sub(bytes).saturating_add(3) / 4;
    format!(
        "Warning: truncated output (original token count: {})\nTotal output lines: {}\n\n{}…{removed} tokens truncated…{}",
        tokens(text),
        text.lines().count(),
        &text[..head],
        &text[tail..]
    )
}
impl Engine {
    pub(super) async fn spill_hook_context(
        &self,
        cell: &Cell,
        invocation: &str,
        text: String,
        limit: usize,
    ) -> String {
        if limit == 0 || tokens(&text) <= limit {
            return text;
        }
        // Core-owned retained files remain in the admitted service home, rather than
        // an unowned temp path that Runtime's deployment cannot necessarily read.
        let directory = self.store.root().join("hook_outputs").join(&cell.id);
        let path = directory.join(format!("{invocation}.txt"));
        if tokio::fs::create_dir_all(&directory).await.is_err()
            || tokio::fs::write(&path, &text).await.is_err()
        {
            return preview(&text, limit);
        }
        let footer = format!("\n\nFull hook output saved to: {}", path.display());
        format!(
            "{}{footer}",
            preview(&text, limit.saturating_sub(tokens(&footer)))
        )
    }
}
