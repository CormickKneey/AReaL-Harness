//! One operation consumes an active budget across all request/continuation rounds.
//! Only the broker's real human-wait lifetime pauses it; caller/generation
//! cancellation remains independently polled by RequestChannel.
use std::{
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};
#[derive(Debug)]
pub(crate) struct Clock {
    server: String,
    generation: u64,
    owner: Option<String>,
    state: Mutex<State>,
    changed: Notify,
}
#[derive(Debug)]
struct State {
    remaining: Option<Duration>,
    last: Instant,
    pauses: usize,
}
impl State {
    fn account(&mut self) {
        let now = Instant::now();
        if self.pauses == 0 {
            self.remaining = self
                .remaining
                .map(|d| d.saturating_sub(now.duration_since(self.last)));
        }
        self.last = now;
    }
}
impl Clock {
    pub(crate) fn new(
        server: &str,
        generation: u64,
        owner: Option<&str>,
        timeout: Option<Duration>,
    ) -> Arc<Self> {
        Arc::new(Self {
            server: server.into(),
            generation,
            owner: owner.map(str::to_owned),
            state: Mutex::new(State {
                remaining: timeout,
                last: Instant::now(),
                pauses: 0,
            }),
            changed: Notify::new(),
        })
    }
    pub(crate) async fn expired(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let remaining = {
                let mut state = self.state.lock().unwrap();
                state.account();
                if state.remaining == Some(Duration::ZERO) {
                    return;
                }
                if state.pauses == 0 {
                    state.remaining
                } else {
                    None
                }
            };
            let waiting = async {
                match remaining {
                    Some(d) => tokio::time::sleep(d).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {biased;_=&mut changed=>{},_=waiting=>{}}
        }
    }
    fn pause(&self) {
        let mut state = self.state.lock().unwrap();
        state.account();
        state.pauses += 1;
        drop(state);
        self.changed.notify_one();
    }
    fn resume(&self) {
        let mut state = self.state.lock().unwrap();
        state.account();
        state.pauses -= 1;
        drop(state);
        self.changed.notify_one();
    }
}
#[derive(Debug, Default)]
pub(crate) struct Clocks(Mutex<Vec<Weak<Clock>>>);
impl Clocks {
    pub(crate) fn register(&self, clock: &Arc<Clock>) {
        let mut clocks = self.0.lock().unwrap();
        clocks.retain(|c| c.strong_count() > 0);
        clocks.push(Arc::downgrade(clock));
    }
    pub(crate) fn pause(&self, server: &str, generation: u64, owner: Option<&str>) -> Pause {
        let clocks = self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|c| {
                c.server == server
                    && c.generation == generation
                    && owner.is_none_or(|token| c.owner.as_deref() == Some(token))
            })
            .collect::<Vec<_>>();
        for clock in &clocks {
            clock.pause();
        }
        Pause(clocks)
    }
}
pub(crate) struct Pause(Vec<Arc<Clock>>);
impl Drop for Pause {
    fn drop(&mut self) {
        for clock in &self.0 {
            clock.resume();
        }
    }
}
