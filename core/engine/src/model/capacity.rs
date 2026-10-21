//! 同一次实际请求的容量所有者共享退避边界；独立调用适配器仍保持原重试策略。

use super::*;
use std::{future::Future, sync::Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RequestPhase {
    Waiting,
    Active,
    Backoff,
}

type RetryBudget = Box<dyn Fn() -> Result<()> + Send + Sync>;
type Observer = Box<dyn Fn(RequestPhase) + Send + Sync>;

pub(crate) struct RequestCapacity {
    semaphore: Arc<Semaphore>,
    permit: Mutex<Option<OwnedSemaphorePermit>>,
    reserve_retry: RetryBudget,
    observer: Option<Observer>,
    cancel: Option<CancellationToken>,
}

tokio::task_local! {
    static REQUEST_CAPACITIES: Vec<Arc<RequestCapacity>>;
}

impl RequestCapacity {
    pub(crate) fn new(
        semaphore: Arc<Semaphore>,
        permit: OwnedSemaphorePermit,
        reserve_retry: RetryBudget,
        observer: Option<Observer>,
        cancel: Option<CancellationToken>,
    ) -> Arc<Self> {
        Arc::new(Self {
            semaphore,
            permit: Mutex::new(Some(permit)),
            reserve_retry,
            observer,
            cancel,
        })
    }

    pub(crate) fn current_cancel() -> Option<CancellationToken> {
        REQUEST_CAPACITIES
            .try_with(|owners| owners.iter().find_map(|owner| owner.cancel.clone()))
            .ok()
            .flatten()
    }

    pub(crate) async fn scope<T>(self: &Arc<Self>, future: impl Future<Output = T>) -> T {
        let mut owners = REQUEST_CAPACITIES
            .try_with(Clone::clone)
            .unwrap_or_default();
        owners.push(self.clone());
        REQUEST_CAPACITIES.scope(owners, future).await
    }

    fn suspend(&self) {
        let permit = self.permit.lock().unwrap().take();
        if let Some(permit) = permit {
            if let Some(observer) = &self.observer {
                observer(RequestPhase::Backoff);
            }
            drop(permit);
        }
    }

    async fn resume(&self) -> Result<()> {
        if let Some(observer) = &self.observer {
            observer(RequestPhase::Waiting);
        }
        let admission = self.semaphore.clone().acquire_owned();
        let permit = if let Some(cancel) = &self.cancel {
            tokio::select! { biased;
                _ = cancel.cancelled() => bail!("cancelled before HTTP retry admission"),
                permit = admission => permit?,
            }
        } else {
            admission.await?
        };
        // 每次再次取得容量都重新记账；预算拒绝时不会发出网络请求。
        (self.reserve_retry)()?;
        *self.permit.lock().unwrap() = Some(permit);
        if let Some(observer) = &self.observer {
            observer(RequestPhase::Active);
        }
        Ok(())
    }
}

impl Drop for RequestCapacity {
    fn drop(&mut self) {
        self.suspend();
    }
}

pub(super) async fn retry_after(delay: Duration) -> Result<()> {
    let owners = REQUEST_CAPACITIES
        .try_with(Clone::clone)
        .unwrap_or_default();
    // 先结束当前请求，按相反顺序归还所有嵌套许可；重新准入保持原锁顺序。
    for owner in owners.iter().rev() {
        owner.suspend();
    }
    if let Some(cancel) = RequestCapacity::current_cancel() {
        tokio::select! { biased;
            _ = cancel.cancelled() => bail!("cancelled during HTTP retry backoff"),
            _ = tokio::time::sleep(delay) => {},
        }
    } else {
        tokio::time::sleep(delay).await;
    }
    for owner in &owners {
        owner.resume().await?;
    }
    Ok(())
}
