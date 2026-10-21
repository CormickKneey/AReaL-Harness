use serde_json::Value;

pub(crate) fn normalize(schema: &mut Value) {
    let mut references = Vec::new();
    rebase(schema, "", "", &mut references);
    for reference in references {
        assert!(
            schema.pointer(&reference[1..]).is_some(),
            "unresolved schema reference: {reference}"
        );
    }
}

fn child_pointer(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn rebase(schema: &mut Value, at: &str, inherited_scope: &str, references: &mut Vec<String>) {
    let Some(map) = schema.as_object_mut() else {
        return;
    };
    let scope = if map.contains_key("$schema") || map.get("$defs").is_some_and(Value::is_object) {
        at
    } else {
        inherited_scope
    };
    map.remove("$schema");
    if let Some(Value::String(reference)) = map.get_mut("$ref")
        && (reference == "#" || reference.starts_with("#/"))
    {
        *reference = format!("#{scope}{}", &reference[1..]);
        references.push(reference.clone());
    }
    for (key, value) in map {
        let pointer = child_pointer(at, key);
        match key.as_str() {
            "$defs" | "definitions" | "properties" | "patternProperties" | "dependentSchemas"
            | "dependencies" => {
                if let Some(children) = value.as_object_mut() {
                    for (name, child) in children {
                        rebase(child, &child_pointer(&pointer, name), scope, references);
                    }
                }
            }
            "allOf"
            | "anyOf"
            | "oneOf"
            | "prefixItems"
            | "items"
            | "additionalItems"
            | "additionalProperties"
            | "unevaluatedItems"
            | "unevaluatedProperties"
            | "propertyNames"
            | "contains"
            | "not"
            | "if"
            | "then"
            | "else"
            | "contentSchema" => {
                if let Some(children) = value.as_array_mut() {
                    for (index, child) in children.iter_mut().enumerate() {
                        rebase(
                            child,
                            &child_pointer(&pointer, &index.to_string()),
                            scope,
                            references,
                        );
                    }
                } else {
                    rebase(value, &pointer, scope, references);
                }
            }
            _ => {}
        }
    }
}
