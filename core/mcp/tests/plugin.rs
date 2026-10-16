use areal_mcp::normalize_plugin_document;
use serde_json::json;
#[test]
fn portable_partial_failure_and_redaction() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let outcome=normalize_plugin_document(true,&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{
 "valid":{"type":"stdio","command":"python3","args":["${PLUGIN_ROOT}/script.py"],"env":{"SECRET":"literal-private"}},
 "bad":{"type":"streamable-http","url":"https://user:literal-private@example.com"},
 "sse":{"type":"sse","url":"https://example.com"},"escape":{"type":"stdio","command":"./../escape"}
 }}),root.path(),data.path()).unwrap();
    assert_eq!(outcome.servers.len(), 1);
    assert_eq!(outcome.diagnostics.len(), 3);
    assert!(!format!("{outcome:?}").contains("literal-private"));
    assert!(
        !outcome.servers["valid"]
            .redacted_view()
            .to_string()
            .contains("literal-private")
    );
}
#[test]
fn unsupported_schema_and_explicit_null_rejected() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        normalize_plugin_document(
            true,
            &json!({"$schema":"2","mcpServers":{}}),
            root.path(),
            root.path()
        )
        .is_err()
    );
    let o=normalize_plugin_document(true,&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"x":{"type":"stdio","command":"x","cwd":null}}}),root.path(),root.path()).unwrap();
    assert_eq!(o.diagnostics.len(), 1);
}
#[test]
fn legacy_policy_and_credential_references_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let o=normalize_plugin_document(false,&json!({"mcpServers":{"x":{"url":"https://example.com/mcp","bearer_token_env_var":"TOKEN","http_headers":{"X-Private":"literal-private"},"env_http_headers":{"X-Key":"KEY"},"enabled_tools":["a","b"],"disabled_tools":["b"],"tools":{"a":{"approval_mode":"prompt"}},"default_tools_approval_mode":"writes","tool_timeout_sec":12,"enabled":true,"oauth":{"clientId":"fixture","clientSecret":"oauth-private"}}}}),root.path(),root.path()).unwrap();
    assert!(o.diagnostics.is_empty(), "{:?}", o.diagnostics);
    let s = &o.servers["x"];
    assert_eq!(s.policy().disabled_tools, vec!["b"]);
    assert!(!format!("{s:?}").contains("private"));
}

#[test]
fn portable_openai_auth_preserves_valid_siblings_and_reports_codex_difference() {
    let root = tempfile::tempdir().unwrap();
    let value = json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"oauth":{"type":"streamable-http","url":"https://example.com/mcp","extensions":{"com.openai":{"auth":{"type":"oauth","client":{"mode":"provided","clientId":"docs-client","tokenEndpointAuthMethod":"none"},"baseScopes":["docs:read"]}}}},"ordinary":{"type":"stdio","command":"test"}}});
    let outcome = normalize_plugin_document(true, &value, root.path(), root.path()).unwrap();
    assert_eq!(outcome.servers.len(), 2);
    assert!(outcome.servers["oauth"].auth_policy().is_some());
    assert!(
        outcome
            .diagnostics
            .iter()
            .any(|d| d.server == "oauth" && d.message.contains("Codex"))
    );
    let legacy = normalize_plugin_document(
        false,
        &json!({"server":{"url":"https://example.com/mcp","auth":"oauth"}}),
        root.path(),
        root.path(),
    )
    .unwrap();
    assert!(legacy.servers["server"].auth_policy().is_some());
}
