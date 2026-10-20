use super::*;
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;

#[tokio::test]
async fn lifetime_is_cloexec_and_only_writer_close_ends_owner() {
    let (reader, writer) = UnixStream::pair().unwrap();
    let lifetime = GuiLifetime::claim(reader.into_raw_fd()).unwrap();
    let flags = unsafe { libc::fcntl(lifetime.as_raw_fd(), libc::F_GETFD) };
    assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), lifetime.closed())
            .await
            .is_err()
    );
    drop(writer);
    tokio::time::timeout(std::time::Duration::from_secs(1), lifetime.closed())
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn owner_parser_rejects_invalid_application_identity_and_profile() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().canonicalize().unwrap();
    let valid = serde_json::json!({"kind":"gui","appRunId":"a6f126a8-3f0d-4ff2-b64d-a1e5becffdd8","profile":path});
    assert!(parse_owner(&valid.to_string()).is_ok());
    for (key, value) in [
        ("appRunId", "invalid"),
        ("profile", "relative/profile"),
        ("kind", "cli"),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value.into();
        assert!(parse_owner(&invalid.to_string()).is_err());
    }
}
