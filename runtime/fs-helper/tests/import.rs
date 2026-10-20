//! Native-picker boundary: descriptor traversal, snapshots, limits, and no source writes.
use areal_runtime_fs::{ImportKind, import_selection};
#[test]
fn picker_snapshots_and_rejects_links_and_budgets() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let source = root.join("picked");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("data.txt"), "first").unwrap();
    let out = root.join("out");
    std::fs::create_dir(&out).unwrap();
    let summary = import_selection(
        std::slice::from_ref(&source),
        &out,
        ImportKind::Directory,
        &[".txt".into()],
    )
    .unwrap();
    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.total_bytes, 5);
    std::fs::write(source.join("data.txt"), "changed").unwrap();
    assert_eq!(
        std::fs::read_to_string(summary.entries[0].path.join("data.txt")).unwrap(),
        "first"
    );
    std::os::unix::fs::symlink(source.join("data.txt"), source.join("link.txt")).unwrap();
    let out2 = root.join("out2");
    std::fs::create_dir(&out2).unwrap();
    assert!(
        import_selection(
            std::slice::from_ref(&source),
            &out2,
            ImportKind::Directory,
            &[]
        )
        .is_err()
    );
    std::os::unix::fs::symlink(&source, root.join("alias")).unwrap();
    assert!(
        import_selection(&[root.join("alias/data.txt")], &out2, ImportKind::File, &[]).is_err()
    );
    let large = root.join("large");
    std::fs::File::create(&large)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    assert!(import_selection(&[large], &out2, ImportKind::File, &[]).is_err());
    let mismatch = root.join("binary.bin");
    std::fs::write(&mismatch, "bytes").unwrap();
    assert!(import_selection(&[mismatch], &out2, ImportKind::File, &[".txt".into()]).is_err());
}
