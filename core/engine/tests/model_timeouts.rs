use areal_engine::{Engine, Limits, model::HttpModel};
use areal_protocol::{Input, Thread, TurnStatus};
use axum::{
    Router,
    response::sse::{Event, Sse},
    routing::post,
};
use futures_util::{StreamExt, stream};
use serde_json::json;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::Notify;

#[derive(Clone, Copy)]
enum DelayedPhase {
    Headers,
    FirstBody,
    AfterActivity,
    HeadersAndFirstBody,
    CancelledHeaders,
}

async fn delayed_response(phase: DelayedPhase) -> Thread {
    let accepted = Arc::new(Notify::new());
    let observed = accepted.clone();
    let app = Router::new().route(
        "/",
        post(move || {
            let accepted = accepted.clone();
            async move {
                accepted.notify_one();
                if matches!(
                    phase,
                    DelayedPhase::Headers
                        | DelayedPhase::HeadersAndFirstBody
                        | DelayedPhase::CancelledHeaders
                ) {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
                Sse::new(stream::iter(0..3).then(move |index| async move {
                    if matches!(
                        (phase, index),
                        (
                            DelayedPhase::FirstBody | DelayedPhase::HeadersAndFirstBody,
                            0
                        ) | (DelayedPhase::AfterActivity, 1)
                    ) {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                    let data = if index == 0 {
                        json!({"choices":[{"index":0,"delta":{"content":"Verified result"}}]})
                            .to_string()
                    } else if index == 1 {
                        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
                            .to_string()
                    } else {
                        "[DONE]".to_owned()
                    };
                    Ok::<_, Infallible>(Event::default().data(data))
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(HttpModel::new(endpoint, "fixture".into(), None).unwrap()),
        Limits {
            model_request_timeout: Duration::from_secs(5),
            stream_idle_timeout: Duration::from_secs(1),
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("Verify the delayed response")])
        .await
        .unwrap();
    let wait_limit = if matches!(phase, DelayedPhase::CancelledHeaders) {
        tokio::time::timeout(Duration::from_secs(5), observed.notified())
            .await
            .unwrap();
        engine.interrupt(&thread.id, &turn.id).await.unwrap();
        Duration::from_secs(2)
    } else {
        Duration::from_secs(10)
    };
    let result = tokio::time::timeout(wait_limit, engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
    result
}

#[tokio::test]
async fn delayed_response_headers_do_not_use_stream_idle_timeout() {
    let result = delayed_response(DelayedPhase::Headers).await;
    assert_eq!(
        result.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        result.turns[0].error
    );
}

#[tokio::test]
async fn delayed_first_response_body_does_not_use_stream_idle_timeout() {
    let result = delayed_response(DelayedPhase::FirstBody).await;
    assert_eq!(
        result.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        result.turns[0].error
    );
}

#[tokio::test]
async fn response_activity_starts_the_stream_idle_timeout() {
    let result = delayed_response(DelayedPhase::AfterActivity).await;
    assert_eq!(result.turns[0].status, TurnStatus::Failed);
    assert!(
        result.turns[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("model stream idle timeout")
    );
}

#[tokio::test]
async fn first_response_deadline_includes_headers_and_first_body() {
    let result = delayed_response(DelayedPhase::HeadersAndFirstBody).await;
    assert_eq!(result.turns[0].status, TurnStatus::Failed);
    assert!(
        result.turns[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("model request idle timeout")
    );
}

#[tokio::test]
async fn cancellation_during_first_response_keeps_the_settlement_bound() {
    let result = delayed_response(DelayedPhase::CancelledHeaders).await;
    assert_eq!(result.turns[0].status, TurnStatus::Interrupted);
}
