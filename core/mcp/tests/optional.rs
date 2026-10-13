#![cfg(unix)]
use areal_mcp::{Connections, normalize_plugin_document};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;
fn env() -> BTreeMap<OsString, OsString> {
    [("PATH".into(), std::env::var_os("PATH").unwrap())].into()
}
fn config(root: &Path, mode: &str, required: bool) -> areal_mcp::PluginConfigOutcome {
    let server = |name: &str, mode: &str| required_server(root, name, mode);
    let mut bad = server("bad", mode);
    bad["required"] = json!(required);
    if mode == "missing" {
        bad["command"] = json!("/no-such-mcp-fixture-executable");
    }
    normalize_plugin_document(
        false,
        &json!({"a_good":server("first","ok"),"b_bad":bad,"c_good":server("last","ok")}),
        root,
        root,
    )
    .unwrap()
}
fn required_server(root: &Path, name: &str, mode: &str) -> Value {
    json!({"command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/tests/optional-server.py"),root.join(name),mode],"startup_timeout_ms":2000})
}
fn log(root: &Path, name: &str) -> Vec<Value> {
    std::fs::read_to_string(root.join(name))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
async fn exited(root: &Path, name: &str) {
    let records = log(root, name);
    if records.is_empty() {
        return;
    }
    let pid = records[0]["pid"].as_i64().unwrap() as i32;
    tokio::time::timeout(Duration::from_secs(3), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("failed server must be reaped");
}
#[tokio::test]
async fn optional_startup_and_discovery_failures_keep_only_healthy_siblings() {
    for mode in ["missing", "fail"] {
        let root = tempfile::tempdir().unwrap();
        let configs = config(root.path(), mode, false);
        let result = Connections::connect_plugins(
            &configs.servers,
            &env(),
            root.path(),
            CancellationToken::new(),
        )
        .await;
        assert!(
            result.is_ok(),
            "optional failure must preserve healthy servers"
        );
        let mut connections = result.unwrap();
        assert_eq!(connections.failures().len(), 1);
        assert_eq!(connections.failures()[0].server, "b_bad");
        assert_eq!(
            connections.failures()[0].class,
            if mode == "missing" {
                "startup"
            } else {
                "discovery"
            }
        );
        assert!(
            !serde_json::to_string(connections.failures())
                .unwrap()
                .contains("private-provider-secret")
        );
        assert_eq!(connections.tools().len(), 2);
        assert_eq!(connections.servers().len(), 2);
        for tool in connections.tools() {
            assert!(
                !tool
                    .call_raw(json!({}), CancellationToken::new())
                    .await
                    .unwrap()
                    .is_error
                    .unwrap_or(false)
            );
        }
        exited(root.path(), "bad").await;
        connections.shutdown().await.unwrap();
        exited(root.path(), "first").await;
        exited(root.path(), "last").await;
    }
}
#[tokio::test]
async fn required_failure_and_cancellation_rollback_every_started_server() {
    for mode in ["fail", "hang"] {
        let root = tempfile::tempdir().unwrap();
        let configs = config(root.path(), mode, mode == "fail");
        let cancel = CancellationToken::new();
        let cancellation = cancel.clone();
        let path = root.path().to_owned();
        let watcher = tokio::spawn(async move {
            if mode == "hang" {
                while !log(&path, "bad")
                    .iter()
                    .any(|v| v["method"] == "tools/list")
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                cancellation.cancel();
            }
        });
        assert!(
            Connections::connect_plugins(&configs.servers, &env(), root.path(), cancel)
                .await
                .is_err()
        );
        watcher.await.unwrap();
        exited(root.path(), "first").await;
        exited(root.path(), "bad").await;
        assert!(log(root.path(), "last").is_empty());
    }
}
