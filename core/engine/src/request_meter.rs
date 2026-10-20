use crate::model::{ModelEvent, ModelStream};
use areal_protocol::{ModelUsage, context::GenerationStats};
use futures_util::Stream;
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Instant,
};

pub(crate) type Generation = Arc<Mutex<GenerationStats>>;

pub(crate) struct RequestMeter {
    generation: Generation,
    first_content: Option<Instant>,
    content_events: u64,
    usage: Option<ModelUsage>,
    failed: bool,
}

impl RequestMeter {
    pub(crate) fn new(generation: Generation) -> Self {
        {
            let mut stats = generation.lock().unwrap();
            stats.unmeasured_requests += 1;
            stats.missing_usage_requests += 1;
        }
        Self {
            generation,
            first_content: None,
            content_events: 0,
            usage: None,
            failed: false,
        }
    }

    pub(crate) fn wrap(self, stream: ModelStream) -> ModelStream {
        Box::pin(MeteredStream {
            stream,
            meter: Some(self),
        })
    }

    fn observe(&mut self, event: &anyhow::Result<ModelEvent>) {
        match event {
            Ok(ModelEvent::TextDelta(text) | ModelEvent::ReasoningDelta { delta: text, .. })
                if !text.is_empty() =>
            {
                self.first_content.get_or_insert_with(Instant::now);
                self.content_events += 1;
            }
            Ok(ModelEvent::Usage(usage)) => {
                if self.usage.is_none() {
                    let mut stats = self.generation.lock().unwrap();
                    stats.missing_usage_requests -= 1;
                    stats.usage_requests += 1;
                }
                self.usage
                    .get_or_insert_with(Default::default)
                    .add_assign(usage);
            }
            Err(_) => self.failed = true,
            _ => {}
        }
    }

    fn finish(self) {
        let Some((first, usage)) = self.first_content.zip(self.usage) else {
            return;
        };
        let duration = first.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if self.failed || self.content_events < 2 || duration == 0 {
            return;
        }
        let mut stats = self.generation.lock().unwrap();
        stats.output_tokens = stats.output_tokens.saturating_add(usage.output_tokens);
        stats.duration_ms = stats.duration_ms.saturating_add(duration);
        stats.measured_requests += 1;
        stats.unmeasured_requests -= 1;
    }
}

struct MeteredStream {
    stream: ModelStream,
    meter: Option<RequestMeter>,
}
impl Stream for MeteredStream {
    type Item = anyhow::Result<ModelEvent>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let event = self.stream.as_mut().poll_next(context);
        match &event {
            Poll::Ready(Some(event)) => {
                if let Some(meter) = &mut self.meter {
                    meter.observe(event);
                }
            }
            Poll::Ready(None) => {
                if let Some(meter) = self.meter.take() {
                    meter.finish();
                }
            }
            Poll::Pending => {}
        }
        event
    }
}
