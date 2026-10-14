//! Conflict-aware write leases. Only admission bookkeeping is globally locked;
//! disjoint paths execute concurrently. Ordinary requests retain conflicting FIFO;
//! trusted hook groups reenter only covered paths within a fixed admission window.
//! After sealing, the next reservation queues behind earlier foreign waiters.
use std::time::Duration;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{sync::Notify, time::Instant};

#[derive(Clone)]
pub(super) struct Participant {
    pub task: String,
    pub hook: bool,
    pub window: Duration,
}

#[derive(Default)]
pub(super) struct Writes {
    root: PathBuf,
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    next: u64,
    requests: BTreeMap<u64, Request>,
    groups: BTreeMap<u64, Group>,
    retired: bool,
}

struct Request {
    paths: Vec<PathBuf>,
    running: bool,
    participant: Option<Participant>,
    group: Option<u64>,
}
struct Group {
    task: String,
    paths: Vec<PathBuf>,
    deadline: Option<Instant>,
    window: Duration,
}
impl State {
    fn sequence(&mut self) -> u64 {
        let id = self.next;
        self.next = self
            .next
            .checked_add(1)
            .expect("write lease sequence exhausted");
        id
    }
    fn group(&mut self, paths: &[PathBuf], participant: Option<&Participant>) -> Option<u64> {
        let participant = participant?;
        let now = Instant::now();
        if let Some((&id, _)) = self
            .groups
            .iter()
            .filter(|(_, g)| {
                g.task == participant.task
                    && g.deadline.is_none_or(|d| now < d)
                    && paths
                        .iter()
                        .all(|p| g.paths.iter().any(|root| p.starts_with(root)))
            })
            .max_by_key(|(id, g)| (g.deadline.is_some(), **id))
        {
            return Some(id);
        }
        // Expansion creates an atomic new reservation; the old covered paths
        // remain reentrant until their own original admission deadline.
        let id = self.sequence();
        self.groups.insert(
            id,
            Group {
                task: participant.task.clone(),
                paths: paths.to_vec(),
                deadline: None,
                window: participant.window,
            },
        );
        Some(id)
    }
    fn collect_groups(&mut self) {
        self.groups
            .retain(|id, _| self.requests.values().any(|r| r.group == Some(*id)));
    }
}

pub(super) struct Lease {
    writes: Arc<Writes>,
    id: u64,
}

fn conflicts(a: &[PathBuf], b: &[PathBuf]) -> bool {
    a.iter()
        .any(|a| b.iter().any(|b| a.starts_with(b) || b.starts_with(a)))
}

impl Writes {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            ..Self::default()
        }
    }
    pub fn retire(&self) {
        self.state.lock().unwrap().retired = true;
        self.changed.notify_waiters();
    }
    #[cfg(test)]
    pub async fn acquire(self: &Arc<Self>, paths: Vec<PathBuf>) -> Lease {
        self.acquire_participant(paths, None).await
    }
    pub async fn acquire_participant(
        self: &Arc<Self>,
        paths: Vec<PathBuf>,
        participant: Option<Participant>,
    ) -> Lease {
        // All authorized paths are under the canonical, bound workspace. Its
        // spelling (including non-ASCII parent directories) is not a conflict key.
        let paths: Vec<_> = paths
            .into_iter()
            .map(|p| {
                p.strip_prefix(&self.root)
                    .map_or_else(|_| p.clone(), PathBuf::from)
            })
            .collect();
        // Case-insensitive filesystems must not treat aliases as independent
        // writers. Non-ASCII components conservatively lock their ancestor;
        // filesystem-specific Unicode folding is not approximated as exact.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let paths: Vec<PathBuf> = paths
            .into_iter()
            .map(|path| {
                let mut key = PathBuf::new();
                for component in path.components() {
                    let text = component.as_os_str().to_string_lossy();
                    if !text.is_ascii() {
                        break;
                    }
                    key.push(text.to_ascii_lowercase());
                }
                key
            })
            .collect();
        let id = {
            let mut state = self.state.lock().unwrap();
            let group = state.group(&paths, participant.as_ref());
            let id = state.sequence();
            state.requests.insert(
                id,
                Request {
                    paths,
                    running: false,
                    participant,
                    group,
                },
            );
            id
        };
        // Own the registration before the first await: dropping a queued future
        // removes its reservation, including on deadline, panic or cancellation.
        let lease = Lease {
            writes: self.clone(),
            id,
        };
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let wake = {
                let mut state = self.state.lock().unwrap();
                let own = &state.requests[&id];
                if own.group.is_some_and(|g| {
                    let g = &state.groups[&g];
                    g.deadline.is_some_and(|d| Instant::now() >= d)
                }) {
                    let paths = own.paths.clone();
                    let participant = own.participant.clone();
                    let group = state.group(&paths, participant.as_ref());
                    state.requests.get_mut(&id).unwrap().group = group;
                    state.collect_groups();
                }
                let own = &state.requests[&id];
                let priority = own.group.unwrap_or(id);
                let paths = own.group.map_or(&own.paths, |g| &state.groups[&g].paths);
                let blocked = state.retired
                    || state.requests.iter().any(|(&other, request)| {
                        if other == id {
                            return false;
                        }
                        if own.group.is_some() && own.group == request.group {
                            return !own.participant.as_ref().is_some_and(|p| p.hook)
                                && !request.participant.as_ref().is_some_and(|p| p.hook)
                                && (request.running || other < id)
                                && conflicts(&own.paths, &request.paths);
                        }
                        let other_paths = request
                            .group
                            .map_or(&request.paths, |g| &state.groups[&g].paths);
                        let group_running = request.group.is_some_and(|g| {
                            state
                                .requests
                                .values()
                                .any(|r| r.group == Some(g) && r.running)
                        });
                        (request.running
                            || group_running
                            || request.group.unwrap_or(other) < priority)
                            && conflicts(paths, other_paths)
                    });
                if !blocked {
                    let group = own.group;
                    state.requests.get_mut(&id).unwrap().running = true;
                    if let Some(g) = group {
                        let group = state.groups.get_mut(&g).unwrap();
                        if group.deadline.is_none() {
                            group.deadline = Some(Instant::now() + group.window);
                        }
                    }
                    return lease;
                }
                own.group.and_then(|g| state.groups[&g].deadline)
            };
            if let Some(deadline) = wake {
                tokio::select! { _=notified=>{}, _=tokio::time::sleep_until(deadline)=>{} }
            } else {
                notified.await;
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.writes.state.lock().unwrap();
        if !state.retired {
            state.requests.remove(&self.id);
            state.collect_groups();
        }
        drop(state);
        self.writes.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn entered(writes: &Writes, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while writes.state.lock().unwrap().requests.len() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn disjoint_writes_pass_a_blocked_writer_but_conflicting_writes_are_fifo() {
        let writes = Arc::new(Writes::default());
        let first = writes.acquire(vec!["/repo/a/one".into()]).await;
        let queued = tokio::spawn({
            let writes = writes.clone();
            async move { writes.acquire(vec!["/repo/a".into()]).await }
        });
        entered(&writes, 2).await;
        let disjoint = tokio::time::timeout(
            Duration::from_secs(1),
            writes.acquire(vec!["/repo/b/two".into()]),
        )
        .await
        .unwrap();
        let later = tokio::spawn({
            let writes = writes.clone();
            async move { writes.acquire(vec!["/repo/a/two".into()]).await }
        });
        entered(&writes, 4).await;
        assert!(!queued.is_finished() && !later.is_finished());
        drop(first);
        let enclosing = tokio::time::timeout(Duration::from_secs(1), queued)
            .await
            .unwrap()
            .unwrap();
        assert!(!later.is_finished());
        drop(enclosing);
        drop(
            tokio::time::timeout(Duration::from_secs(1), later)
                .await
                .unwrap()
                .unwrap(),
        );
        drop(disjoint);
        assert!(writes.state.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn cancelling_a_waiter_releases_its_entire_multi_path_reservation() {
        let writes = Arc::new(Writes::default());
        let first = writes.acquire(vec!["/repo/a".into()]).await;
        let waiter = tokio::spawn({
            let writes = writes.clone();
            async move {
                writes
                    .acquire(vec!["/repo/a".into(), "/repo/b".into()])
                    .await
            }
        });
        entered(&writes, 2).await;
        waiter.abort();
        assert!(matches!(waiter.await, Err(error) if error.is_cancelled()));
        let other = tokio::time::timeout(
            Duration::from_secs(1),
            writes.acquire(vec!["/repo/b".into()]),
        )
        .await
        .unwrap();
        drop((first, other));
        assert!(writes.state.lock().unwrap().requests.is_empty());
    }
}
