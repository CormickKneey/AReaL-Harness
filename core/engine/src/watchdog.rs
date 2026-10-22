//! 网络重试策略；环境变量由 Config 解析，Engine 只接收显式配置。

use crate::model;
use std::time::Duration;
use tokio::time::Instant;

pub(crate) struct ResponseDeadline {
    first_event: Option<Instant>,
    stream_idle_timeout: Duration,
}

impl ResponseDeadline {
    pub(crate) fn new(request_timeout: Duration, stream_idle_timeout: Duration) -> Self {
        Self {
            first_event: Some(Instant::now() + request_timeout),
            stream_idle_timeout,
        }
    }

    pub(crate) fn deadline(&self) -> Instant {
        self.first_event
            .unwrap_or_else(|| Instant::now() + self.stream_idle_timeout)
    }

    pub(crate) fn observe_event(&mut self) {
        self.first_event = None;
    }

    pub(crate) fn idle_error(&self, purpose: &str) -> anyhow::Error {
        let phase = if self.first_event.is_some() {
            "request"
        } else {
            "stream"
        };
        idle_error(&format!("{purpose} {phase}"))
    }
}

pub(crate) fn exhausted(
    mode: areal_config::NetworkRetryMode,
    error: &anyhow::Error,
    retries: usize,
) -> bool {
    mode == areal_config::NetworkRetryMode::Bounded
        && retries >= 5
        && model::is_network_error(error)
}

pub(crate) fn retry_delay(
    disabled: bool,
    mode: areal_config::NetworkRetryMode,
    error: &anyhow::Error,
    retries: usize,
) -> Option<Duration> {
    if disabled || !model::is_network_error(error) || exhausted(mode, error, retries) {
        return None;
    }
    // 有限模式计入当前请求的恢复次数；持续模式只限制退避，保留既有行为。
    Some(Duration::from_millis(
        (250u64 << retries.min(7)).min(30_000),
    ))
}

pub(crate) fn idle_error(phase: &str) -> anyhow::Error {
    anyhow::Error::new(model::ModelFailure::ResponseTimeout)
        .context(format!("{phase} idle timeout"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrarily_many_network_retries_have_a_bounded_backoff() {
        let error = model::ModelFailure::Transport.into();
        assert_eq!(
            retry_delay(
                false,
                areal_config::NetworkRetryMode::Persistent,
                &error,
                usize::MAX
            ),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            retry_delay(
                true,
                areal_config::NetworkRetryMode::Persistent,
                &error,
                usize::MAX
            ),
            None
        );
    }

    #[test]
    fn bounded_mode_recovers_transient_errors_and_stops_at_the_limit() {
        use areal_config::NetworkRetryMode::Bounded;
        let error = model::ModelFailure::Transport.into();
        assert_eq!(
            retry_delay(false, Bounded, &error, 0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            retry_delay(false, Bounded, &error, 4),
            Some(Duration::from_secs(4))
        );
        assert_eq!(retry_delay(false, Bounded, &error, 5), None);
        assert_eq!(retry_delay(true, Bounded, &error, 0), None);
    }
}
