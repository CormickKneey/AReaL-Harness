use super::*;
use sha2::{Digest, Sha256};

pub(super) fn not_sent(cause: rt::Error) -> rt::Error {
    let code = match cause.code {
        rt::ErrorCode::Unavailable | rt::ErrorCode::StaleHandle | rt::ErrorCode::CleanupFailed => {
            rt::ErrorCode::Conflict
        }
        code => code,
    };
    let mut error = rt::Error::new(
        code,
        format!("file write not submitted: historical file capture failed: {cause}"),
    );
    error.details = Some(json!({
        "reason": "FILE_BEFORE_CAPTURE_FAILED",
        "dispatch": "not_sent",
        "cause": cause
    }));
    error
}

fn invalid(message: impl Into<String>) -> rt::Error {
    rt::Error::new(rt::ErrorCode::InvalidArgument, message)
}

pub(super) fn check_cancel(cancel: &CancellationToken) -> rt::Result<()> {
    if cancel.is_cancelled() {
        return Err(rt::Error::new(
            rt::ErrorCode::ScopeClosed,
            "cancelled before file write submission",
        ));
    }
    Ok(())
}

pub(super) async fn prepare(
    invocation: &extensions::Invocation<'_>,
    client: &Client,
    command: &rt::FileCommand,
) -> rt::Result<()> {
    let (path, expected_sha256) = match command {
        rt::FileCommand::Write {
            path,
            expected: rt::ExpectedFile::Sha256 { value },
            ..
        } => (path, value),
        rt::FileCommand::ApplyPatch {
            path,
            expected_sha256,
            ..
        }
        | rt::FileCommand::ApplyPatches {
            path,
            expected_sha256,
            ..
        } => (path, expected_sha256),
        _ => return Ok(()),
    };
    if !path.starts_with("workspace://repo/") {
        return Ok(());
    }
    let bytes = read_expected_file(
        client,
        invocation.scope,
        path,
        expected_sha256,
        invocation.cancel,
    )
    .await
    .map_err(not_sent)?;
    let media = invocation
        .engine
        .store
        .save_blob("application/octet-stream".into(), bytes)
        .await
        .map_err(|error| not_sent(invalid(error.to_string())))?;
    check_cancel(invocation.cancel).map_err(not_sent)?;
    invocation
        .edit(|execution, _| execution.file_before = Some(media))
        .await
        .map_err(not_sent)?;
    check_cancel(invocation.cancel).map_err(not_sent)
}

async fn read_expected_file(
    client: &Client,
    scope: &str,
    path: &str,
    expected_sha256: &str,
    cancel: &CancellationToken,
) -> rt::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut size = None;
    loop {
        check_cancel(cancel)?;
        let request = rt::FileRequest {
            operation_id: client.operation_id(),
            scope_id: scope.into(),
            command: rt::FileCommand::ReadForHistory {
                path: path.into(),
                offset: bytes.len() as u64,
                max_bytes: rt::MAX_FILE_CHUNK,
            },
        };
        let part = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                return Err(rt::Error::new(rt::ErrorCode::ScopeClosed, "file capture cancelled"));
            }
            result = client.filesystem(request) => result?,
        };
        if part["sha256"].as_str() != Some(expected_sha256) {
            return Err(rt::Error::new(
                rt::ErrorCode::Conflict,
                "file version changed before write; read the file again",
            ));
        }
        let page_size = part["size"]
            .as_u64()
            .ok_or_else(|| invalid("file capture response is missing size"))?;
        if page_size > rt::MAX_EDIT_FILE as u64 {
            return Err(rt::Error::new(
                rt::ErrorCode::ResourceExhausted,
                "file capture exceeds 8 MiB",
            ));
        }
        if size.is_some_and(|size| size != page_size) {
            return Err(invalid("file capture size changed between pages"));
        }
        size = Some(page_size);
        let encoded = part["dataBase64"]
            .as_str()
            .ok_or_else(|| invalid("file capture response is missing dataBase64"))?;
        if encoded.len() > rt::MAX_FILE_CHUNK.div_ceil(3) * 4 {
            return Err(invalid("file capture page exceeds 64 KiB"));
        }
        let chunk = STANDARD
            .decode(encoded)
            .map_err(|error| invalid(format!("invalid file capture bytes: {error}")))?;
        let next_offset = bytes.len() as u64 + chunk.len() as u64;
        let eof = part["eof"]
            .as_bool()
            .ok_or_else(|| invalid("file capture response is missing eof"))?;
        if chunk.len() > rt::MAX_FILE_CHUNK
            || next_offset > page_size
            || part["nextOffset"].as_u64() != Some(next_offset)
            || eof != (next_offset == page_size)
            || chunk.is_empty() && !eof
        {
            return Err(invalid("file capture page is not contiguous or complete"));
        }
        bytes.extend_from_slice(&chunk);
        if eof {
            break;
        }
    }
    check_cancel(cancel)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected_sha256 {
        return Err(invalid("file capture digest does not match expectedSha256"));
    }
    Ok(bytes)
}
