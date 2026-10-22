use super::*;

fn rule(zone: &str, frequency: &str, anchor: &str, time: &str) -> Value {
    json!({"version":1,"rule":{"kind":"calendar","timeZone":zone,"frequency":frequency,"interval":1,"localTime":time,"anchorDate":anchor},"misfire":{"kind":"skip","maxLatenessSeconds":300},"overlap":"skip"})
}

#[tokio::test]
async fn calendar_public_preview_uses_literal_utc_and_strict_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(
        areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
            .unwrap(),
    );
    let engine = Engine::open(dir.path(), model, areal_engine::Limits::default()).unwrap();
    let owner = auth::Principal::embedded();
    assert!(METHODS.contains(&"areal/task/schedule/preview"));
    assert!(METHODS.contains(&"areal/task/schedule/context"));
    assert_eq!(
        auth::permission("areal/task/schedule/preview"),
        auth::Permission::Observe
    );
    assert_eq!(
        auth::permission("areal/task/schedule/context"),
        auth::Permission::Observe
    );
    let mut cases = vec![
        (
            "shanghai-weekdays",
            rule("Asia/Shanghai", "weekly", "2026-10-23", "09:00"),
        ),
        (
            "new-york-gap",
            rule("America/New_York", "daily", "2026-03-07", "02:30"),
        ),
        (
            "new-york-fold",
            rule("America/New_York", "daily", "2026-10-31", "01:30"),
        ),
        (
            "shanghai-month31",
            rule("Asia/Shanghai", "monthly", "2026-01-31", "09:00"),
        ),
        (
            "shanghai-last-leap",
            rule("Asia/Shanghai", "monthly", "2028-01-31", "09:00"),
        ),
    ];
    cases[0].1["rule"]["weekdays"] = json!([1, 2, 3, 4, 5]);
    cases[3].1["rule"]["monthDays"] = json!([31]);
    cases[4].1["rule"]["monthDays"] = json!(["last"]);
    let literals: Value = serde_json::from_str(include_str!("calendar-literals.json")).unwrap();
    for (name, schedule) in &cases {
        let expected: Vec<_> = literals["cases"][name]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["at"].clone())
            .collect();
        let result = dispatch(
            &engine,
            &owner,
            "areal/task/schedule/preview",
            json!({"schedule":schedule,"from":expected[0],"count":5}),
        )
        .await
        .unwrap();
        let actual: Vec<_> = result["occurrences"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["at"].clone())
            .collect();
        assert_eq!(actual, expected, "{name}");
    }
    let valid = cases[0].1.clone();
    let mut invalid = vec![];
    for (field, value) in [
        ("timeZone", json!("Invalid/Zone")),
        ("weekdays", json!([1, 1])),
        ("weekdays", json!([0])),
        ("weekdays", json!([])),
        ("weekdays", Value::Null),
        ("interval", json!(0)),
        ("localTime", json!("24:00")),
        ("anchorDate", json!("2026-02-30")),
        ("monthDays", json!([1])),
        ("extra", json!(true)),
    ] {
        let mut input = valid.clone();
        input["rule"][field] = value;
        invalid.push(input);
    }
    let thread = engine.create(engine.default_cwd()).await.unwrap();
    let before = dispatch(&engine, &owner, "areal/task/list", json!({}))
        .await
        .unwrap();
    for (i, input) in invalid.iter().enumerate() {
        assert!(
            dispatch(
                &engine,
                &owner,
                "areal/task/schedule/preview",
                json!({"schedule":input,"count":5})
            )
            .await
            .is_err(),
            "invalid preview {i}"
        );
        assert!(dispatch(&engine,&owner,"areal/task/create",json!({"requestId":format!("invalid-{i}"),"mode":"scheduled","objective":"reject","threadId":thread.id,"scheduleV2":input})).await.is_err(), "invalid create {i}");
    }
    assert!(
        dispatch(
            &engine,
            &owner,
            "areal/task/schedule/preview",
            json!({"schedule":valid,"count":11})
        )
        .await
        .is_err()
    );
    assert_eq!(
        dispatch(&engine, &owner, "areal/task/list", json!({}))
            .await
            .unwrap(),
        before
    );
    engine.shutdown().await;
}
