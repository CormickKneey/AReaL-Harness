//! 将 Engine 轨迹事件桥接为关联 Trace/Span 的标准 OTLP LogRecord。

use opentelemetry::{
    logs::{AnyValue, LogRecord, Logger, Severity},
    trace::TraceContextExt,
};
use opentelemetry_sdk::logs::SdkLogger;
use std::{collections::BTreeMap, fmt, sync::OnceLock, time::SystemTime};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_opentelemetry::get_otel_context;
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

#[derive(Clone, Default)]
struct Fields(BTreeMap<String, AnyValue>);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(
            field.name().into(),
            AnyValue::String(value.to_owned().into()),
        );
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), AnyValue::Int(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        if let Ok(value) = i64::try_from(value) {
            self.record_i64(field, value);
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), AnyValue::Double(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), AnyValue::Boolean(value));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.record_str(field, &format!("{value:?}"));
    }
}

pub(super) struct EventLayer {
    logger: Option<SdkLogger>,
    dispatch: OnceLock<tracing::dispatcher::WeakDispatch>,
}

impl EventLayer {
    pub fn new(logger: Option<SdkLogger>) -> Self {
        Self {
            logger,
            dispatch: OnceLock::new(),
        }
    }
}

impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for EventLayer {
    fn on_register_dispatch(&self, dispatch: &tracing::Dispatch) {
        // 事件回调中不能递归读取当前 tracing dispatcher；弱引用也避免订阅器循环持有。
        let _ = self.dispatch.set(dispatch.downgrade());
    }

    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if attrs.metadata().target() != "areal::trajectory" {
            return;
        }
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(fields);
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id)
            && let Some(fields) = span.extensions_mut().get_mut::<Fields>()
        {
            values.record(fields);
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if event.metadata().target() != "areal::trajectory" {
            return;
        }
        let mut fields = Fields::default();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                if let Some(parent) = span.extensions().get::<Fields>() {
                    fields.0.extend(parent.0.clone());
                }
            }
        }
        event.record(&mut fields);
        let Some(span) = ctx.event_span(event) else {
            return;
        };
        let Some(dispatch) = self.dispatch.get().and_then(|weak| weak.upgrade()) else {
            return;
        };
        let Some(context) = get_otel_context(&span.id(), &dispatch) else {
            return;
        };
        let span = context.span();
        let sc = span.span_context();
        if !sc.is_valid() {
            return;
        }
        let Some(logger) = &self.logger else {
            return;
        };
        let mut record = logger.create_log_record();
        if let Some(AnyValue::String(name)) = fields.0.get("event.name") {
            // SDK 要求静态事件名，使用 Engine 定义的有限事件集合。
            let name = match name.as_str() {
                "gen_ai.client.inference.operation.details" => {
                    "gen_ai.client.inference.operation.details"
                }
                "areal.user_prompt" => "areal.user_prompt",
                "areal.tool.call" => "areal.tool.call",
                "areal.tool.result" => "areal.tool.result",
                "areal.context.compacted" => "areal.context.compacted",
                _ => return,
            };
            record.set_event_name(name);
        }
        record.set_timestamp(SystemTime::now());
        record.set_severity_number(Severity::Info);
        record.set_trace_context(sc.trace_id(), sc.span_id(), Some(sc.trace_flags()));
        record.add_attributes(
            fields
                .0
                .into_iter()
                .filter(|(k, _)| !k.starts_with("otel.") && k != "message")
                .map(|(key, value)| {
                    let value = match (key.as_str(), &value) {
                        (
                            "gen_ai.input.messages"
                            | "gen_ai.output.messages"
                            | "gen_ai.tool.call.arguments"
                            | "gen_ai.tool.call.result",
                            AnyValue::String(text),
                        ) => serde_json::from_str(text.as_str())
                            .map(json_value)
                            .unwrap_or(value),
                        _ => value,
                    };
                    (key, value)
                }),
        );
        logger.emit(record);
    }
}

// OTLP LogRecord 支持嵌套属性；SDK 没有 Null 变体时保留 JSON 字面量。
fn json_value(value: serde_json::Value) -> AnyValue {
    use serde_json::Value;
    match value {
        Value::Null => AnyValue::String("null".into()),
        Value::Bool(value) => AnyValue::Boolean(value),
        Value::String(value) => AnyValue::String(value.into()),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                AnyValue::Int(value)
            } else if value.is_f64() {
                AnyValue::Double(value.as_f64().unwrap())
            } else {
                AnyValue::String(value.to_string().into())
            }
        }
        Value::Array(values) => values.into_iter().map(json_value).collect(),
        Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| (key, json_value(value)))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::{logs::LoggerProvider as _, trace::TracerProvider as _};
    use opentelemetry_sdk::{
        logs::{InMemoryLogExporter, SdkLoggerProvider},
        trace::{InMemorySpanExporter, SdkTracerProvider},
    };
    use tracing_subscriber::{filter::filter_fn, layer::SubscriberExt};

    #[test]
    fn events_preserve_content_and_correlate_with_spans_even_without_trace_export() {
        for export_traces in [true, false] {
            let logs = InMemoryLogExporter::default();
            let logger = SdkLoggerProvider::builder()
                .with_simple_exporter(logs.clone())
                .build();
            let traces = InMemorySpanExporter::default();
            let mut builder = SdkTracerProvider::builder();
            if export_traces {
                builder = builder.with_simple_exporter(traces.clone());
            }
            let provider = builder.build();
            let subscriber = tracing_subscriber::registry()
                .with(
                    tracing_opentelemetry::layer()
                        .with_tracer(provider.tracer("test"))
                        .with_filter(filter_fn(|metadata| {
                            metadata.is_span() && metadata.target() == "areal::trajectory"
                        })),
                )
                .with(EventLayer::new(Some(logger.logger("test"))));
            let input =
                r#"[{"role":"user","parts":[{"type":"text","content":"原始输入 token=abc"}]}]"#;
            let output = r#"[{"role":"assistant","parts":[{"type":"text","content":"原始输出"}]}]"#;
            tracing::subscriber::with_default(subscriber, || {
                let root = tracing::info_span!(target: "areal::trajectory", "invoke_agent", gen_ai.conversation.id = "session");
                let _root = root.enter();
                let span = tracing::info_span!(target: "areal::trajectory", "chat",
                    gen_ai.input.messages = input,
                    gen_ai.output.messages = tracing::field::Empty,
                    gen_ai.usage.input_tokens = tracing::field::Empty);
                let _entered = span.enter();
                span.record("gen_ai.output.messages", output);
                span.record("gen_ai.usage.input_tokens", 42u64);
                tracing::event!(target: "areal::trajectory", tracing::Level::INFO, { "event.name" = "gen_ai.client.inference.operation.details" });
                tracing::warn!("unrelated diagnostic");
            });
            provider.force_flush().unwrap();
            logger.force_flush().unwrap();
            let records = logs.get_emitted_logs().unwrap();
            assert_eq!(records.len(), 1);
            let record = &records[0].record;
            assert_eq!(
                record.event_name(),
                Some("gen_ai.client.inference.operation.details")
            );
            let attrs: BTreeMap<_, _> = record
                .attributes_iter()
                .map(|(key, value)| (key.as_str(), value.clone()))
                .collect();
            assert_eq!(
                attrs["gen_ai.input.messages"],
                json_value(serde_json::from_str(input).unwrap())
            );
            assert_eq!(
                attrs["gen_ai.output.messages"],
                json_value(serde_json::from_str(output).unwrap())
            );
            assert_eq!(
                attrs["gen_ai.conversation.id"],
                AnyValue::String("session".into())
            );
            assert_eq!(attrs["gen_ai.usage.input_tokens"], AnyValue::Int(42));
            let context = record.trace_context().unwrap();
            assert_ne!(context.trace_id, opentelemetry::TraceId::INVALID);
            assert_ne!(context.span_id, opentelemetry::SpanId::INVALID);
            let spans = traces.get_finished_spans().unwrap();
            if export_traces {
                let chat = spans.iter().find(|s| s.name == "chat").unwrap();
                let root = spans.iter().find(|s| s.name == "invoke_agent").unwrap();
                assert_eq!(chat.parent_span_id, root.span_context.span_id());
                assert_eq!(context.trace_id, chat.span_context.trace_id());
                assert_eq!(context.span_id, chat.span_context.span_id());
            } else {
                assert!(spans.is_empty());
            }
            logger.shutdown().unwrap();
            provider.shutdown().unwrap();
        }
    }
}
