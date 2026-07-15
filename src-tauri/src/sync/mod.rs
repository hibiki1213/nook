//! P2P sync: a field-level last-writer-wins CRDT over per-app change logs,
//! carried peer-to-peer by iroh. Design doc: the plan's "delta-state" model —
//! `crdt_changes` keeps only the current winner per (app, entity, entity_id,
//! attr) key, so anti-entropy is "send every winner row above your cursor"
//! and the log never grows past the live key count (plus record tombstones).
//!
//! Module map:
//! - `clock` — hybrid logical clock (HLC); string order == causal order
//! - `store` — schema + bookkeeping (device id, seq counter, shares, cursors)
//! - `log`   — recording local writes (called from repo.rs inside its txs)
//! - `merge` — applying remote batches (LWW, delete-wins, definition rebuild)

pub mod clock;
pub mod log;
pub mod merge;
pub mod net;
pub mod proto;
pub mod store;
pub mod tickets;

use serde::{Deserialize, Serialize};

/// One replicated cell: the current winner for its (app, entity, entity_id,
/// attr) key. This struct is both the storage row and the wire format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Change {
    pub app_id: String,
    /// "record" | "field" | "view" | "meta"
    pub entity: String,
    /// record: the record ULID / field, view: the field/view id /
    /// meta: "name" | "icon" | "description" | "field_order" | "view_order"
    ///       | "member.<device_id>"
    pub entity_id: String,
    /// record: a field id, or "$exists" (row presence) /
    /// field, view: "$def" / meta: "$value"
    pub attr: String,
    /// JSON-encoded value text ("null" is a legitimate value).
    /// `None` only for tombstones.
    pub value: Option<String>,
    pub hlc: String,
    /// Writing device's id — the LWW tiebreaker for equal HLCs.
    pub actor: String,
    /// Sender-local sequence number (the pull cursor). Reassigned to a fresh
    /// local seq when the change is applied, so forwarding works transitively.
    pub seq: i64,
    pub tombstone: bool,
}

impl Change {
    /// LWW ordering: a change beats another iff (hlc, actor) is greater.
    pub fn beats(&self, other_hlc: &str, other_actor: &str) -> bool {
        (self.hlc.as_str(), self.actor.as_str()) > (other_hlc, other_actor)
    }
}

/// Hook the network layer registers so repo.rs can nudge it after a local
/// write commits ("something changed in <app> — consider announcing").
/// A no-op until sync networking is up; never blocks the writer.
static NOTIFIER: std::sync::OnceLock<Box<dyn Fn(&str) + Send + Sync>> =
    std::sync::OnceLock::new();

pub fn set_change_notifier(f: impl Fn(&str) + Send + Sync + 'static) {
    let _ = NOTIFIER.set(Box::new(f));
}

pub fn notify_change(app_id: &str) {
    if let Some(f) = NOTIFIER.get() {
        f(app_id);
    }
}
