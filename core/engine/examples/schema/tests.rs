use serde_json::{Value, json};

fn standalone(mut schema: Value) -> Value {
    super::standalone::normalize(&mut schema);
    schema
}

fn validate(schema: &Value, valid: Value, invalid: Value) {
    let validator = jsonschema::validator_for(schema).unwrap();
    assert!(
        validator.is_valid(&valid),
        "valid payload rejected: {valid}"
    );
    assert!(
        !validator.is_valid(&invalid),
        "invalid payload accepted: {invalid}"
    );
}

#[test]
fn reference_siblings_remain_constraints() {
    let schema = standalone(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$defs":{"Text":{"type":"string","minLength":3}},
        "$ref":"#/$defs/Text", "maxLength":4
    }));
    validate(&schema, json!("abc"), json!("abcde"));
}

#[test]
fn nested_scopes_keep_names_and_escaped_pointers() {
    let schema = standalone(json!({
        "type":"object", "additionalProperties":false,
        "required":["left/~", "right", "bare"],
        "properties":{
            "left/~":{
                "$schema":"https://json-schema.org/draft/2020-12/schema",
                "$defs":{"Item/~":{"type":"string"}},
                "$ref":"#/$defs/Item~1~0"
            },
            "right":{
                "$schema":"http://json-schema.org/draft-07/schema#",
                "definitions":{"Item":{"type":"integer"}},
                "$ref":"#/definitions/Item"
            },
            "bare":{"$defs":{"Item":{"type":"boolean"}},"$ref":"#/$defs/Item"}
        }
    }));
    validate(
        &schema,
        json!({"left/~":"text","right":7,"bare":true}),
        json!({"left/~":7,"right":"text","bare":true}),
    );
    assert_eq!(
        schema["properties"]["left/~"]["$ref"],
        "#/properties/left~1~0/$defs/Item~1~0"
    );
    assert_eq!(
        schema["properties"]["right"]["$ref"],
        "#/properties/right/definitions/Item"
    );
    assert!(schema["properties"]["right"].get("$schema").is_none());
}

#[test]
fn root_reference_recurses_within_its_embedded_document() {
    let schema = standalone(json!({
        "type":"object", "required":["node"], "properties":{"node":{
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "type":"object", "required":["value"], "additionalProperties":false,
            "properties":{"value":{"type":"integer"}, "next":{"$ref":"#"}}
        }}
    }));
    validate(
        &schema,
        json!({"node":{"value":1,"next":{"value":2,"next":{"value":3}}}}),
        json!({"node":{"value":1,"next":{"value":2,"next":{"value":"bad"}}}}),
    );
}

#[test]
fn definitions_payload_property_does_not_create_a_schema_scope() {
    let schema = standalone(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$defs":{"Entry":{"type":"integer"}},
        "type":"object", "required":["definitions"],
        "properties":{"definitions":{"type":"array","items":{"$ref":"#/$defs/Entry"}}}
    }));
    validate(
        &schema,
        json!({"definitions":[1,2]}),
        json!({"definitions":["bad"]}),
    );
}

#[test]
fn unresolved_local_references_fail_generation() {
    let result = std::panic::catch_unwind(|| standalone(json!({"$ref":"#/missing"})));
    assert!(result.is_err());
}

#[test]
fn every_desktop_export_compiles_independently() {
    let output = crate::desktop_schema();
    let groups = [
        "requests",
        "responses",
        "notifications",
        "serverRequests",
        "serverResponses",
    ];
    for (name, value) in output.as_object().unwrap() {
        if name == "apiVersion" {
            continue;
        }
        if groups.contains(&name.as_str()) {
            for (method, schema) in value.as_object().unwrap() {
                jsonschema::validator_for(schema)
                    .unwrap_or_else(|error| panic!("{name}/{method}: {error}"));
            }
        } else {
            jsonschema::validator_for(value).unwrap_or_else(|error| panic!("{name}: {error}"));
        }
    }
}

fn turn() -> Value {
    json!({"id":"turn", "items":[], "status":"completed", "error":null,
    "generation":{"outputTokens":8,"durationMs":25,"measuredRequests":1,"unmeasuredRequests":0,"usageRequests":1,"missingUsageRequests":0},
    "instructionAttribution":{"sha256":"digest","parts":[
        {"kind":"rules","name":"root","estimatedTokens":4,"children":[
            {"kind":"skills","name":"child","estimatedTokens":3,"children":[
                {"kind":"other","name":"leaf","estimatedTokens":2}
            ]}
        ]}
    ]}})
}

#[test]
fn recursive_turn_constraints_survive_all_embedding_boundaries() {
    let output = crate::desktop_schema();
    let valid = turn();
    let mut invalid_tokens = valid.clone();
    invalid_tokens["instructionAttribution"]["parts"][0]["children"][0]["children"][0]["estimatedTokens"] =
        json!("bad");
    let mut invalid_kind = valid.clone();
    invalid_kind["instructionAttribution"]["parts"][0]["children"][0]["children"][0]["kind"] =
        json!("unknown");
    for invalid in [invalid_tokens, invalid_kind] {
        validate(&output["turn"], valid.clone(), invalid.clone());
        for method in ["areal/turn/start", "turn/start"] {
            validate(
                &output["responses"][method],
                json!({"turn":valid}),
                json!({"turn":invalid}),
            );
        }
        validate(
            &output["notifications"]["turn/completed"],
            json!({"threadId":"thread","turn":valid}),
            json!({"threadId":"thread","turn":invalid}),
        );
        let thread = |turn| {
            json!({"id":"thread","sessionId":"session","parentThreadId":null,
            "preview":"","modelProvider":"test","createdAt":1,"updatedAt":1,
            "status":{"type":"idle"},"cwd":"/tmp","cliVersion":"test","source":"test","ephemeral":false,"turns":[turn]})
        };
        validate(&output["thread"], thread(valid.clone()), thread(invalid));
    }
}

#[test]
fn provider_fields_and_embedded_input_keep_strict_validation() {
    let output = crate::desktop_schema();
    let valid = json!({"id":"test","revision":1,"endpoint":"https://example.test",
        "protocol":"openai","models":["model"],"credentialRef":null,"parameters":{},
        "contextSource":"user", "modelParameters":{"model":{"contextWindowTokens":8192}},
        "modelCapabilities":{"model":{"tools":true,"vision":false,"reasoning":true,"reasoningEffortOptions":["low","high"]}}});
    let mut invalid = valid.clone();
    invalid["modelCapabilities"]["model"]["unknown"] = json!(true);
    validate(&output["provider"], valid.clone(), invalid);
    let mut invalid = valid.clone();
    invalid["unknown"] = json!(true);
    validate(&output["provider"], valid, invalid);
    validate(
        &output["requests"]["turn/start"],
        json!({"threadId":"thread","input":[{"type":"text","text":"hello"}]}),
        json!({"threadId":"thread","input":[{"type":"text","text":"hello","unknown":true}]}),
    );
    validate(
        &output["responses"]["areal/plugin/hooks/list"],
        json!({"data":[{"pluginId":"plugin","installedDigest":"digest","definitionDigest":"digest","definitions":[],"diagnostics":[]}]}),
        json!({"data":[{"pluginId":"plugin","installedDigest":"digest","definitionDigest":"digest","definitions":"bad","diagnostics":[]}]}),
    );
}

#[test]
fn native_host_exports_compile_and_embedded_runtime_error_is_constrained() {
    let output = crate::native_host_schema();
    for (name, schema) in output.as_object().unwrap() {
        if name != "protocolVersion" {
            jsonschema::validator_for(schema).unwrap_or_else(|error| panic!("{name}: {error}"));
        }
    }
    validate(
        &output["coreToHost"],
        json!({"type":"fileResult","callId":"call","requestId":1,"error":{"code":"INVALID_ARGUMENT","message":"bad input"}}),
        json!({"type":"fileResult","callId":"call","requestId":1,"error":{"code":"unknown","message":"bad input"}}),
    );
}
