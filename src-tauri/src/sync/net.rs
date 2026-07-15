//! The networking actor: one background thread running a dedicated tokio
//! runtime (same pattern as http.rs), owning the iroh endpoint, the gossip
//! swarms (one topic per shared app), and the pull/rekey protocol.
//!
//! Data flow:
//! - gossip carries only tiny `Announce { device, endpoint, seq }` heads;
//! - all data moves over direct QUIC streams (ALPN `nook/sync/1`) via
//!   Pull → Batch* → PullDone;
//! - pulls fire on announce, on join, on gossip neighbor-up, and on a
//!   5-minute tick (the safety net for sleep/wake and gossip hiccups).
//!
//! All sync-layer DB *writes* run inside `spawn_blocking` while holding one
//! async mutex — a single logical writer, so merge transactions never fight
//! each other for the SQLite write lock (UI/HTTP writers are separate and
//! covered by busy_timeout).

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::{presets, Connection};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use iroh_gossip::api::{Event as GossipEvent, GossipSender};
use iroh_gossip::net::{Gossip, GOSSIP_ALPN};
use n0_future::StreamExt;
use rusqlite::Connection as Db;
use serde_json::json;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};

use super::proto::{self, Msg, SYNC_ALPN};
use super::{merge, store, tickets};
use crate::db;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const ONLINE_TIMEOUT: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_secs(5 * 60);
const ANNOUNCE_DEBOUNCE: Duration = Duration::from_millis(300);

// ── Global handles (set once at startup) ────────────────────────────────────

static CMD: OnceLock<mpsc::UnboundedSender<Cmd>> = OnceLock::new();
/// app_id → connected peer EndpointIds (hex) — fed by gossip neighbor events.
static CONNECTED: OnceLock<Arc<RwLock<HashMap<String, HashSet<String>>>>> = OnceLock::new();

fn connected_map() -> Arc<RwLock<HashMap<String, HashSet<String>>>> {
    CONNECTED
        .get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
        .clone()
}

/// Connected-peer counts for the status UI. Works even before/without the
/// actor (empty map).
pub fn connected_peers(app_id: &str) -> usize {
    connected_map().read().map(|m| m.get(app_id).map(|s| s.len()).unwrap_or(0)).unwrap_or(0)
}

pub enum Cmd {
    Share { app_ids: Vec<String>, reply: oneshot::Sender<Result<String>> },
    Invite { app_id: String, reply: oneshot::Sender<Result<String>> },
    Join { ticket: String, reply: oneshot::Sender<Result<Vec<String>>> },
    Leave { app_id: String, reply: oneshot::Sender<Result<()>> },
    RemoveMember { app_id: String, device_id: String, reply: oneshot::Sender<Result<()>> },
    /// From repo.rs after a local write commits (via the notifier hook).
    LocalChange { app_id: String },
    /// From a topic receiver task: a peer announced new changes.
    AnnounceSeen { app_id: String, endpoint: String },
    /// From a topic receiver task: gossip neighbor came/went.
    Neighbor { app_id: String, endpoint: String, up: bool },
    /// A rekey arrived — the topic must be re-derived from the new secret.
    Resubscribe { app_id: String },
}

fn send_cmd(cmd: Cmd) -> Result<()> {
    CMD.get()
        .ok_or_else(|| anyhow!("同期機能が起動していません"))?
        .send(cmd)
        .map_err(|_| anyhow!("同期機能が停止しています"))
}

/// Synchronous bridge for Tauri commands: send + block on the reply.
pub fn request<T>(build: impl FnOnce(oneshot::Sender<Result<T>>) -> Cmd) -> Result<T> {
    let (tx, rx) = oneshot::channel();
    send_cmd(build(tx))?;
    rx.blocking_recv().map_err(|_| anyhow!("同期機能が応答しません"))?
}

/// Fire-and-forget nudge from repo.rs (registered as the change notifier).
pub fn nudge(app_id: &str) {
    let _ = send_cmd(Cmd::LocalChange { app_id: to_owned(app_id) });
}

fn to_owned(s: &str) -> String {
    s.to_string()
}

// ── Startup ─────────────────────────────────────────────────────────────────

/// Spawn the sync runtime. Called once from lib.rs setup (after a successful
/// bootstrap). Failures are logged, not fatal — the app works unshared.
pub fn start(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::unbounded_channel();
    if CMD.set(tx).is_err() {
        return;
    }
    super::set_change_notifier(|app_id| nudge(app_id));
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[nook] sync: tokio runtime failed: {e}");
                return;
            }
        };
        rt.block_on(async move {
            if let Err(e) = actor(app, rx).await {
                eprintln!("[nook] sync: actor exited: {e:#}");
            }
        });
    });
}

/// Load-or-create the persistent iroh secret key.
fn iroh_secret(conn: &Db) -> Result<SecretKey> {
    use rusqlite::OptionalExtension;
    let existing: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'iroh_secret'", [], |r| r.get(0))
        .optional()?;
    if let Some(hex) = existing {
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
            .collect::<std::result::Result<_, _>>()?;
        let arr: [u8; 32] = bytes.as_slice().try_into().context("bad iroh_secret")?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    conn.execute("INSERT INTO settings (key, value) VALUES ('iroh_secret', ?1)", [&hex])?;
    Ok(key)
}

// ── The actor ───────────────────────────────────────────────────────────────

struct Topics {
    /// app_id → broadcast sender of the joined gossip topic.
    senders: HashMap<String, GossipSender>,
    /// app_id → abort handle of the receiver task (dropped on re-subscribe).
    tasks: HashMap<String, tokio::task::JoinHandle<()>>,
}

struct Ctx {
    endpoint: Endpoint,
    gossip: Gossip,
    app: tauri::AppHandle,
    /// Serializes every sync-layer DB write (merges, cursor updates).
    write_lock: Arc<Mutex<()>>,
    device_id: String,
    /// app_id → issuer addr from the ticket (bootstrap before members sync).
    issuers: Arc<RwLock<HashMap<String, EndpointAddr>>>,
}

async fn actor(app: tauri::AppHandle, mut rx: mpsc::UnboundedReceiver<Cmd>) -> Result<()> {
    let (secret, device_id) = tokio::task::spawn_blocking(|| -> Result<_> {
        let conn = db::open()?;
        Ok((iroh_secret(&conn)?, store::device_id(&conn)?))
    })
    .await??;

    let endpoint = Endpoint::builder(presets::N0).secret_key(secret).bind().await?;
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let ctx = Arc::new(Ctx {
        endpoint: endpoint.clone(),
        gossip,
        app,
        write_lock: Arc::new(Mutex::new(())),
        device_id,
        issuers: Arc::new(RwLock::new(HashMap::new())),
    });
    let _router = Router::builder(endpoint.clone())
        .accept(GOSSIP_ALPN, ctx.gossip.clone())
        .accept(SYNC_ALPN, SyncProtocol { ctx: ctx.clone() })
        .spawn();

    // Reaching the relay makes our EndpointAddr complete (tickets, inbound
    // dials); don't block the actor forever if offline.
    let _ = tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online()).await;
    eprintln!("[nook] sync: endpoint {} ready", endpoint.id());

    let mut topics = Topics { senders: HashMap::new(), tasks: HashMap::new() };

    // Join swarms of everything already shared, then do a catch-up round.
    let shared = tokio::task::spawn_blocking(|| -> Result<Vec<String>> {
        store::shared_apps(&db::open()?)
    })
    .await??;
    for app_id in shared {
        if let Err(e) = subscribe_topic(&ctx, &mut topics, &app_id).await {
            eprintln!("[nook] sync: subscribe {app_id}: {e:#}");
        }
        pull_from_members(&ctx, &app_id);
    }

    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Debounced announce state: app_id → deadline.
    let mut pending_announce: HashMap<String, tokio::time::Instant> = HashMap::new();

    loop {
        let next_announce = pending_announce.values().min().copied();
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                handle_cmd(&ctx, &mut topics, &mut pending_announce, cmd).await;
            }
            _ = tick.tick() => {
                let apps: Vec<String> = topics.senders.keys().cloned().collect();
                for app_id in apps {
                    pull_from_members(&ctx, &app_id);
                    retry_rekeys(&ctx, &app_id);
                }
            }
            _ = async {
                match next_announce {
                    Some(t) => tokio::time::sleep_until(t).await,
                    None => std::future::pending().await,
                }
            } => {
                let now = tokio::time::Instant::now();
                let due: Vec<String> = pending_announce
                    .iter()
                    .filter(|(_, t)| **t <= now)
                    .map(|(k, _)| k.clone())
                    .collect();
                for app_id in due {
                    pending_announce.remove(&app_id);
                    announce(&ctx, &topics, &app_id).await;
                }
            }
        }
    }
    Ok(())
}

async fn handle_cmd(
    ctx: &Arc<Ctx>,
    topics: &mut Topics,
    pending_announce: &mut HashMap<String, tokio::time::Instant>,
    cmd: Cmd,
) {
    match cmd {
        Cmd::Share { app_ids, reply } => {
            let _ = reply.send(share(ctx, topics, app_ids).await);
        }
        Cmd::Invite { app_id, reply } => {
            let _ = reply.send(make_ticket(ctx, &[app_id]).await);
        }
        Cmd::Join { ticket, reply } => {
            let _ = reply.send(join(ctx, topics, &ticket).await);
        }
        Cmd::Leave { app_id, reply } => {
            let _ = reply.send(leave(ctx, topics, &app_id).await);
        }
        Cmd::RemoveMember { app_id, device_id, reply } => {
            let _ = reply.send(remove_member(ctx, topics, &app_id, &device_id).await);
        }
        Cmd::LocalChange { app_id } => {
            if topics.senders.contains_key(&app_id) {
                pending_announce
                    .entry(app_id)
                    .or_insert_with(|| tokio::time::Instant::now() + ANNOUNCE_DEBOUNCE);
            }
        }
        Cmd::AnnounceSeen { app_id, endpoint } => {
            spawn_pull_from(ctx.clone(), app_id, endpoint, None);
        }
        Cmd::Resubscribe { app_id } => {
            if let Err(e) = subscribe_topic(ctx, topics, &app_id).await {
                eprintln!("[nook] sync: resubscribe {app_id}: {e:#}");
            }
        }
        Cmd::Neighbor { app_id, endpoint, up } => {
            let map = connected_map();
            if let Ok(mut m) = map.write() {
                let set = m.entry(app_id.clone()).or_default();
                if up {
                    set.insert(endpoint.clone());
                } else {
                    set.remove(&endpoint);
                }
            }
            if up {
                // A fresh neighbor: tell them where we are, and catch up from
                // them right away.
                pending_announce
                    .entry(app_id.clone())
                    .or_insert_with(|| tokio::time::Instant::now() + ANNOUNCE_DEBOUNCE);
                spawn_pull_from(ctx.clone(), app_id, endpoint, None);
            }
        }
    }
}

// ── Topic management ────────────────────────────────────────────────────────

async fn subscribe_topic(ctx: &Arc<Ctx>, topics: &mut Topics, app_id: &str) -> Result<()> {
    // Re-subscribe (rekey) drops the old receiver task first.
    if let Some(t) = topics.tasks.remove(app_id) {
        t.abort();
    }
    topics.senders.remove(app_id);
    if let Ok(mut m) = connected_map().write() {
        m.remove(app_id);
    }

    let app_id_owned = app_id.to_string();
    let (secret, _epoch) = tokio::task::spawn_blocking({
        let app_id = app_id_owned.clone();
        move || -> Result<_> { store::share_secret(&db::open()?, &app_id) }
    })
    .await??;
    let topic = proto::topic_id(&secret, app_id);

    // Bootstrap: the ticket issuer (if we joined) plus every known member.
    let mut bootstrap: Vec<EndpointId> = Vec::new();
    if let Some(addr) = ctx.issuers.read().ok().and_then(|m| m.get(app_id).cloned()) {
        bootstrap.push(addr.id);
    }
    let members = tokio::task::spawn_blocking({
        let app_id = app_id_owned.clone();
        move || -> Result<_> { store::members(&db::open()?, &app_id) }
    })
    .await??;
    for m in &members {
        if m.removed || m.device_id == ctx.device_id {
            continue;
        }
        if let Ok(id) = EndpointId::from_str(&m.node_id) {
            if !bootstrap.contains(&id) {
                bootstrap.push(id);
            }
        }
    }

    let (sender, mut receiver) = ctx.gossip.subscribe(topic, bootstrap).await?.split();
    topics.senders.insert(app_id_owned.clone(), sender);

    // Receiver task: translate gossip events into actor commands.
    let device_id = ctx.device_id.clone();
    let task = tokio::spawn(async move {
        loop {
            match receiver.next().await {
                Some(Ok(GossipEvent::Received(msg))) => {
                    if let Ok(ann) = serde_json::from_slice::<proto::Announce>(&msg.content) {
                        if ann.device_id != device_id {
                            let _ = send_cmd(Cmd::AnnounceSeen {
                                app_id: app_id_owned.clone(),
                                endpoint: ann.endpoint,
                            });
                        }
                    }
                }
                Some(Ok(GossipEvent::NeighborUp(id))) => {
                    let _ = send_cmd(Cmd::Neighbor {
                        app_id: app_id_owned.clone(),
                        endpoint: id.to_string(),
                        up: true,
                    });
                }
                Some(Ok(GossipEvent::NeighborDown(id))) => {
                    let _ = send_cmd(Cmd::Neighbor {
                        app_id: app_id_owned.clone(),
                        endpoint: id.to_string(),
                        up: false,
                    });
                }
                Some(Ok(GossipEvent::Lagged)) => continue,
                Some(Err(e)) => {
                    eprintln!("[nook] sync: gossip receiver error ({app_id_owned}): {e}");
                    break;
                }
                None => break,
            }
        }
    });
    topics.tasks.insert(app_id.to_string(), task);
    Ok(())
}

async fn announce(ctx: &Arc<Ctx>, topics: &Topics, app_id: &str) {
    let Some(sender) = topics.senders.get(app_id) else { return };
    let seq = tokio::task::spawn_blocking(|| -> Result<i64> { store::max_seq(&db::open()?) })
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(0);
    let ann = proto::Announce {
        device_id: ctx.device_id.clone(),
        endpoint: ctx.endpoint.id().to_string(),
        seq,
    };
    if let Ok(bytes) = serde_json::to_vec(&ann) {
        let _ = sender.broadcast(bytes.into()).await;
    }
}

// ── Share / invite / join / leave / remove ──────────────────────────────────

async fn share(ctx: &Arc<Ctx>, topics: &mut Topics, app_ids: Vec<String>) -> Result<String> {
    let ctx2 = ctx.clone();
    let ids = app_ids.clone();
    {
        let _guard = ctx.write_lock.lock().await;
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut conn = db::open()?;
            for app_id in &ids {
                store::start_share(&mut conn, app_id)?;
                let name = device_name(&conn)?;
                super::log::announce_member(
                    &conn,
                    app_id,
                    &ctx2.device_id,
                    &ctx2.endpoint.id().to_string(),
                    name.as_deref(),
                )?;
                store::upsert_member(
                    &conn,
                    app_id,
                    &ctx2.device_id,
                    &ctx2.endpoint.id().to_string(),
                    name.as_deref(),
                )?;
            }
            Ok(())
        })
        .await??;
    }
    for app_id in &app_ids {
        subscribe_topic(ctx, topics, app_id).await?;
    }
    make_ticket(ctx, &app_ids).await
}

async fn make_ticket(ctx: &Arc<Ctx>, app_ids: &[String]) -> Result<String> {
    let ids = app_ids.to_vec();
    let apps = tokio::task::spawn_blocking(move || -> Result<Vec<tickets::TicketApp>> {
        let conn = db::open()?;
        ids.iter()
            .map(|app_id| {
                let (secret, epoch) = store::share_secret(&conn, app_id)?;
                Ok(tickets::TicketApp {
                    app_id: app_id.clone(),
                    secret: tickets::secret_string(&secret),
                    epoch,
                })
            })
            .collect()
    })
    .await??;
    let ticket = tickets::Ticket { v: 1, apps, issuer: ctx.endpoint.addr() };
    tickets::encode(&ticket)
}

async fn join(ctx: &Arc<Ctx>, topics: &mut Topics, raw: &str) -> Result<Vec<String>> {
    let ticket = tickets::decode(raw)?;

    // Reachability first: a dead issuer means joining can't complete anyway.
    let conn = tokio::time::timeout(
        CONNECT_TIMEOUT,
        ctx.endpoint.connect(ticket.issuer.clone(), SYNC_ALPN),
    )
    .await
    .map_err(|_| anyhow!("発行者に接続できません(オンラインか確認してください)"))?
    .map_err(|e| anyhow!("発行者に接続できません: {e}"))?;
    drop(conn);

    let apps: Vec<String> = ticket.apps.iter().map(|a| a.app_id.clone()).collect();
    {
        let _guard = ctx.write_lock.lock().await;
        let ticket2 = ticket.clone();
        let ctx2 = ctx.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut conn = db::open()?;
            for app in &ticket2.apps {
                let secret = tickets::secret_bytes(app)?;
                store::join_share(&mut conn, &app.app_id, &secret, app.epoch)?;
                let name = device_name(&conn)?;
                super::log::announce_member(
                    &conn,
                    &app.app_id,
                    &ctx2.device_id,
                    &ctx2.endpoint.id().to_string(),
                    name.as_deref(),
                )?;
                store::upsert_member(
                    &conn,
                    &app.app_id,
                    &ctx2.device_id,
                    &ctx2.endpoint.id().to_string(),
                    name.as_deref(),
                )?;
            }
            Ok(())
        })
        .await??;
    }

    for app in &ticket.apps {
        if let Ok(mut m) = ctx.issuers.write() {
            m.insert(app.app_id.clone(), ticket.issuer.clone());
        }
        subscribe_topic(ctx, topics, &app.app_id).await?;
        // First pull, straight from the issuer's full address.
        spawn_pull_from(
            ctx.clone(),
            app.app_id.clone(),
            ticket.issuer.id.to_string(),
            Some(ticket.issuer.clone()),
        );
    }
    Ok(apps)
}

async fn leave(ctx: &Arc<Ctx>, topics: &mut Topics, app_id: &str) -> Result<()> {
    if let Some(t) = topics.tasks.remove(app_id) {
        t.abort();
    }
    topics.senders.remove(app_id);
    if let Ok(mut m) = connected_map().write() {
        m.remove(app_id);
    }
    let app_id = app_id.to_string();
    let _guard = ctx.write_lock.lock().await;
    tokio::task::spawn_blocking(move || -> Result<()> {
        store::leave_share(&db::open()?, &app_id)
    })
    .await??;
    Ok(())
}

async fn remove_member(
    ctx: &Arc<Ctx>,
    topics: &mut Topics,
    app_id: &str,
    device_id: &str,
) -> Result<()> {
    if device_id == ctx.device_id {
        return Err(anyhow!("自分自身は外せません(共有をやめる、を使ってください)"));
    }
    let (old_secret, new_secret, new_epoch) = {
        let _guard = ctx.write_lock.lock().await;
        let app_id2 = app_id.to_string();
        let device2 = device_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<_> {
            let conn = db::open()?;
            let (old_secret, _) = store::share_secret(&conn, &app_id2)?;
            conn.execute(
                "UPDATE share_members SET removed = 1 WHERE app_id = ?1 AND device_id = ?2",
                rusqlite::params![app_id2, device2],
            )?;
            let (new_secret, new_epoch) = store::rotate_secret(&conn, &app_id2)?;
            // We hold the new secret by definition.
            conn.execute(
                "UPDATE share_members SET epoch_sent = ?1 WHERE app_id = ?2 AND device_id = ?3",
                rusqlite::params![new_epoch, app_id2, conn.query_row(
                    "SELECT value FROM settings WHERE key='device_id'", [], |r| r.get::<_, String>(0))?],
            )?;
            // Keep the OLD secret around: it authenticates the Rekey message,
            // and offline members need one retried later (the tick).
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![
                    format!("rekey:{app_id2}"),
                    serde_json::to_string(&json!({
                        "old": tickets::secret_string(&old_secret),
                        "epoch": new_epoch,
                    }))?
                ],
            )?;
            Ok((old_secret, new_secret, new_epoch))
        })
        .await??
    };
    // New epoch → new topic.
    subscribe_topic(ctx, topics, app_id).await?;
    // Hand the new secret to the remaining members (retried by the tick).
    send_rekeys(ctx, app_id, &old_secret, &new_secret, new_epoch).await;
    Ok(())
}

/// Push `Rekey` to every active member whose epoch_sent is stale.
async fn send_rekeys(ctx: &Arc<Ctx>, app_id: &str, old_secret: &[u8], new_secret: &[u8], new_epoch: i64) {
    let members = {
        let app_id = app_id.to_string();
        tokio::task::spawn_blocking(move || store::members(&db::open()?, &app_id))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default()
    };
    for m in members {
        if m.removed || m.device_id == ctx.device_id || m.epoch_sent >= new_epoch {
            continue;
        }
        let Ok(target) = EndpointId::from_str(&m.node_id) else { continue };
        let msg = Msg::Rekey {
            app_id: app_id.to_string(),
            epoch: new_epoch,
            secret: tickets::secret_string(new_secret),
            auth: proto::rekey_auth(old_secret, app_id, new_epoch, new_secret),
        };
        let ctx = ctx.clone();
        let app_id = app_id.to_string();
        let device = m.device_id.clone();
        tokio::spawn(async move {
            let ok = async {
                let conn = tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    ctx.endpoint.connect(target, SYNC_ALPN),
                )
                .await
                .map_err(|_| anyhow!("timeout"))??;
                let (mut send, mut recv) = conn.open_bi().await?;
                proto::write_msg(&mut send, &msg).await?;
                send.finish()?;
                matches!(proto::read_msg(&mut recv).await?, Some(Msg::RekeyOk))
                    .then_some(())
                    .ok_or_else(|| anyhow!("rekey rejected"))
            }
            .await
            .is_ok();
            if ok {
                let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                    db::open()?.execute(
                        "UPDATE share_members SET epoch_sent = ?1 WHERE app_id = ?2 AND device_id = ?3",
                        rusqlite::params![new_epoch, app_id, device],
                    )?;
                    Ok(())
                })
                .await;
            }
        });
    }
}

/// Tick-driven rekey retry for members that were offline during the rotation.
/// The old secret (which authenticates the Rekey) is persisted in settings
/// under `rekey:<app>` until every active member has the new epoch.
fn retry_rekeys(ctx: &Arc<Ctx>, app_id: &str) {
    let ctx = ctx.clone();
    let app_id = app_id.to_string();
    tokio::spawn(async move {
        let pending = {
            let app_id = app_id.clone();
            tokio::task::spawn_blocking(move || -> Result<Option<(Vec<u8>, Vec<u8>, i64)>> {
                use rusqlite::OptionalExtension;
                let conn = db::open()?;
                let raw: Option<String> = conn
                    .query_row(
                        "SELECT value FROM settings WHERE key = ?1",
                        [format!("rekey:{app_id}")],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(raw) = raw else { return Ok(None) };
                let v: serde_json::Value = serde_json::from_str(&raw)?;
                let epoch = v["epoch"].as_i64().unwrap_or(0);
                let old = tickets::secret_bytes(&tickets::TicketApp {
                    app_id: app_id.clone(),
                    secret: v["old"].as_str().unwrap_or_default().to_string(),
                    epoch,
                })?;
                let (cur_secret, cur_epoch) = store::share_secret(&conn, &app_id)?;
                if cur_epoch != epoch {
                    // A newer rotation superseded this one; drop the stale entry.
                    conn.execute("DELETE FROM settings WHERE key = ?1", [format!("rekey:{app_id}")])?;
                    return Ok(None);
                }
                let stale = store::members(&conn, &app_id)?
                    .into_iter()
                    .any(|m| !m.removed && m.epoch_sent < epoch);
                if !stale {
                    conn.execute("DELETE FROM settings WHERE key = ?1", [format!("rekey:{app_id}")])?;
                    return Ok(None);
                }
                Ok(Some((old, cur_secret, epoch)))
            })
            .await
        };
        if let Ok(Ok(Some((old_secret, new_secret, epoch)))) = pending {
            send_rekeys(&ctx, &app_id, &old_secret, &new_secret, epoch).await;
        }
    });
}

// ── Pulls ───────────────────────────────────────────────────────────────────

/// Pull from every known member of an app (the periodic safety net).
fn pull_from_members(ctx: &Arc<Ctx>, app_id: &str) {
    let ctx = ctx.clone();
    let app_id = app_id.to_string();
    tokio::spawn(async move {
        let members = {
            let app_id = app_id.clone();
            tokio::task::spawn_blocking(move || store::members(&db::open()?, &app_id))
                .await
                .ok()
                .and_then(|r| r.ok())
                .unwrap_or_default()
        };
        for m in members {
            if m.removed || m.device_id == ctx.device_id {
                continue;
            }
            spawn_pull_from(ctx.clone(), app_id.clone(), m.node_id, None);
        }
    });
}

/// One pull conversation with one peer, as a background task.
fn spawn_pull_from(ctx: Arc<Ctx>, app_id: String, endpoint_hex: String, addr: Option<EndpointAddr>) {
    tokio::spawn(async move {
        if let Err(e) = pull_from(&ctx, &app_id, &endpoint_hex, addr).await {
            eprintln!("[nook] sync: pull {app_id} from {}: {e:#}", &endpoint_hex[..8.min(endpoint_hex.len())]);
        }
    });
}

async fn pull_from(
    ctx: &Arc<Ctx>,
    app_id: &str,
    endpoint_hex: &str,
    addr: Option<EndpointAddr>,
) -> Result<()> {
    // Auth material + cursor come from the DB.
    let (secret, epoch) = {
        let app_id = app_id.to_string();
        tokio::task::spawn_blocking(move || store::share_secret(&db::open()?, &app_id)).await??
    };

    let conn = match addr {
        Some(addr) => {
            tokio::time::timeout(CONNECT_TIMEOUT, ctx.endpoint.connect(addr, SYNC_ALPN))
                .await
                .map_err(|_| anyhow!("connect timeout"))??
        }
        None => {
            let id = EndpointId::from_str(endpoint_hex).context("bad endpoint id")?;
            tokio::time::timeout(CONNECT_TIMEOUT, ctx.endpoint.connect(id, SYNC_ALPN))
                .await
                .map_err(|_| anyhow!("connect timeout"))??
        }
    };
    let (mut send, mut recv) = conn.open_bi().await?;

    // We don't know the peer's device id until PullDone — cursor is keyed by
    // device, so resolve it via the endpoint→device mapping in share_members
    // (fall back to 0 = full pull; dedupe by LWW makes that merely wasteful).
    let peer_device: Option<String> = {
        let app_id = app_id.to_string();
        let hex = endpoint_hex.to_string();
        tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            use rusqlite::OptionalExtension;
            Ok(db::open()?
                .query_row(
                    "SELECT device_id FROM share_members WHERE app_id = ?1 AND node_id = ?2",
                    rusqlite::params![app_id, hex],
                    |r| r.get(0),
                )
                .optional()?)
        })
        .await??
    };
    let cursor = match &peer_device {
        Some(dev) => {
            let app_id = app_id.to_string();
            let dev = dev.clone();
            tokio::task::spawn_blocking(move || store::cursor_recv(&db::open()?, &app_id, &dev))
                .await??
        }
        None => 0,
    };

    proto::write_msg(
        &mut send,
        &Msg::Pull {
            app_id: app_id.to_string(),
            epoch,
            device_id: ctx.device_id.clone(),
            auth: proto::pull_auth(&secret, &ctx.device_id),
            cursor,
        },
    )
    .await?;
    send.finish()?;

    let mut applied_apps: std::collections::BTreeSet<String> = Default::default();
    let mut max_remote_seq = cursor;
    loop {
        match proto::read_msg(&mut recv).await? {
            Some(Msg::Batch { changes }) => {
                if changes.is_empty() {
                    continue;
                }
                max_remote_seq = max_remote_seq.max(changes.iter().map(|c| c.seq).max().unwrap_or(0));
                let _guard = ctx.write_lock.lock().await;
                let stats = tokio::task::spawn_blocking(move || -> Result<merge::Applied> {
                    let mut conn = db::open()?;
                    merge::apply_remote(&mut conn, &changes)
                })
                .await??;
                applied_apps.extend(stats.apps);
            }
            Some(Msg::PullDone { device_id, my_seq, your_seq_i_have }) => {
                let app_id2 = app_id.to_string();
                let dev = device_id.clone();
                let _guard = ctx.write_lock.lock().await;
                tokio::task::spawn_blocking(move || -> Result<()> {
                    let conn = db::open()?;
                    store::set_cursor_recv(&conn, &app_id2, &dev, my_seq.max(0))?;
                    store::set_cursor_acked(&conn, &app_id2, &dev, your_seq_i_have.max(0))?;
                    Ok(())
                })
                .await??;
                break;
            }
            Some(Msg::Err { message }) => return Err(anyhow!("peer refused: {message}")),
            Some(_) => return Err(anyhow!("unexpected message during pull")),
            None => break,
        }
    }
    let _ = max_remote_seq;

    for app in applied_apps {
        let _ = ctx.app.emit("nook://sync-applied", json!({ "appId": app }));
    }
    Ok(())
}

// ── Inbound protocol (the server half) ──────────────────────────────────────

#[derive(Clone)]
struct SyncProtocol {
    ctx: Arc<Ctx>,
}

impl std::fmt::Debug for SyncProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncProtocol")
    }
}

fn acc_err(e: anyhow::Error) -> AcceptError {
    AcceptError::from_err(std::io::Error::other(format!("{e:#}")))
}

impl ProtocolHandler for SyncProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let msg = proto::read_msg(&mut recv).await.map_err(acc_err)?;
        match msg {
            Some(Msg::Pull { app_id, epoch, device_id, auth, cursor }) => {
                if let Err(e) =
                    serve_pull(&self.ctx, &mut send, &app_id, epoch, &device_id, &auth, cursor).await
                {
                    let _ = proto::write_msg(&mut send, &Msg::Err { message: format!("{e:#}") }).await;
                }
            }
            Some(Msg::Rekey { app_id, epoch, secret, auth }) => {
                match serve_rekey(&self.ctx, &app_id, epoch, &secret, &auth).await {
                    Ok(()) => {
                        let _ = proto::write_msg(&mut send, &Msg::RekeyOk).await;
                    }
                    Err(e) => {
                        let _ = proto::write_msg(&mut send, &Msg::Err { message: format!("{e:#}") }).await;
                    }
                }
            }
            _ => {}
        }
        let _ = send.finish();
        connection.closed().await;
        Ok(())
    }
}

async fn serve_pull(
    ctx: &Arc<Ctx>,
    send: &mut iroh::endpoint::SendStream,
    app_id: &str,
    epoch: i64,
    device_id: &str,
    auth: &str,
    cursor: i64,
) -> Result<()> {
    let (secret, our_epoch) = {
        let app_id = app_id.to_string();
        tokio::task::spawn_blocking(move || store::share_secret(&db::open()?, &app_id)).await??
    };
    if epoch != our_epoch {
        return Err(anyhow!("epoch mismatch (invite expired?)"));
    }
    if !proto::auth_eq(&proto::pull_auth(&secret, device_id), auth) {
        return Err(anyhow!("auth failed"));
    }

    let mut at = cursor;
    loop {
        let batch = {
            let app_id = app_id.to_string();
            tokio::task::spawn_blocking(move || {
                store::pull_since(&db::open()?, &app_id, at, proto::BATCH_SIZE)
            })
            .await??
        };
        let done = (batch.len() as i64) < proto::BATCH_SIZE;
        if !batch.is_empty() {
            at = batch.iter().map(|c| c.seq).max().unwrap_or(at);
            proto::write_msg(send, &Msg::Batch { changes: batch }).await?;
        }
        if done {
            break;
        }
    }

    let (my_seq, your_seq_i_have, my_device) = {
        let app_id = app_id.to_string();
        let dev = device_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(i64, i64, String)> {
            let conn = db::open()?;
            Ok((
                store::max_seq(&conn)?,
                store::cursor_recv(&conn, &app_id, &dev)?,
                store::device_id(&conn)?,
            ))
        })
        .await??
    };
    proto::write_msg(
        send,
        &Msg::PullDone { device_id: my_device, my_seq, your_seq_i_have },
    )
    .await?;

    // The requester now holds everything up to my_seq (optimistically).
    {
        let app_id = app_id.to_string();
        let dev = device_id.to_string();
        let _guard = ctx.write_lock.lock().await;
        tokio::task::spawn_blocking(move || -> Result<()> {
            store::set_cursor_acked(&db::open()?, &app_id, &dev, my_seq)?;
            Ok(())
        })
        .await??;
    }
    Ok(())
}

async fn serve_rekey(
    ctx: &Arc<Ctx>,
    app_id: &str,
    new_epoch: i64,
    new_secret_str: &str,
    auth: &str,
) -> Result<()> {
    let new_secret = tickets::secret_bytes(&tickets::TicketApp {
        app_id: app_id.to_string(),
        secret: new_secret_str.to_string(),
        epoch: new_epoch,
    })?;
    let (cur_secret, cur_epoch) = {
        let app_id = app_id.to_string();
        tokio::task::spawn_blocking(move || store::share_secret(&db::open()?, &app_id)).await??
    };
    if new_epoch <= cur_epoch {
        return Ok(()); // already rotated (idempotent)
    }
    if !proto::auth_eq(&proto::rekey_auth(&cur_secret, app_id, new_epoch, &new_secret), auth) {
        return Err(anyhow!("rekey auth failed"));
    }
    {
        let app_id2 = app_id.to_string();
        let ns = new_secret.clone();
        let _guard = ctx.write_lock.lock().await;
        tokio::task::spawn_blocking(move || -> Result<()> {
            db::open()?.execute(
                "UPDATE shares SET secret = ?1, epoch = ?2 WHERE app_id = ?3",
                rusqlite::params![ns, new_epoch, app_id2],
            )?;
            Ok(())
        })
        .await??;
    }
    // Move to the new topic.
    let _ = send_cmd(Cmd::LocalChange { app_id: app_id.to_string() });
    let _ = send_cmd(Cmd::Resubscribe { app_id: app_id.to_string() });
    Ok(())
}

// settings helper shared by share/join.
pub fn device_name(conn: &Db) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = 'device_name'", [], |r| r.get(0))
        .optional()?)
}

#[cfg(test)]
mod tests {
    //! Real-iroh integration: two endpoints in one process, temp DBs, one
    //! full pull conversation over QUIC. `#[ignore]`d because it opens real
    //! sockets (and may touch the n0 relay) — run before releases with
    //! `cargo test -- --ignored`.

    use super::*;
    use crate::models::AppDefinition;
    use crate::sync::log;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    const DEF: &str = r#"{
        "id":"tasks","name":"Tasks",
        "fields":[{"id":"title","label":"Title","type":"text"}],
        "views":[{"id":"all","name":"All","type":"table"}]
    }"#;

    fn temp_db(name: &str) -> Db {
        let dir = std::env::temp_dir().join(format!("nook-sync-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Db::open(dir.join(name)).unwrap();
        crate::db::init(&conn).unwrap();
        conn
    }

    fn seeded_node(name: &str) -> (Db, Vec<u8>) {
        let mut conn = temp_db(name);
        let def: AppDefinition = serde_json::from_str(DEF).unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, icon, definition) VALUES (?1,?2,NULL,?3)",
            rusqlite::params![def.id, def.name, DEF],
        )
        .unwrap();
        crate::db::ensure_table(&conn, &def).unwrap();
        let secret = store::start_share(&mut conn, "tasks").unwrap();
        (conn, secret)
    }

    /// Serve pulls for one DB on a raw accept loop (the test-local stand-in
    /// for SyncProtocol, which is hardwired to the app's global DB path).
    async fn serve(endpoint: Endpoint, db: Arc<StdMutex<Db>>, secret: Vec<u8>) {
        while let Some(incoming) = endpoint.accept().await {
            let db = db.clone();
            let secret = secret.clone();
            tokio::spawn(async move {
                let Ok(connection) = incoming.await else { return };
                let Ok((mut send, mut recv)) = connection.accept_bi().await else { return };
                let Ok(Some(Msg::Pull { app_id, device_id, auth, cursor, .. })) =
                    proto::read_msg(&mut recv).await
                else {
                    return;
                };
                if !proto::auth_eq(&proto::pull_auth(&secret, &device_id), &auth) {
                    let _ = proto::write_msg(&mut send, &Msg::Err { message: "auth failed".into() })
                        .await;
                    let _ = send.finish();
                    // Wait for delivery — dropping the connection would RST
                    // the stream before the refusal reaches the peer.
                    connection.closed().await;
                    return;
                }
                let (batch, my_seq, me) = {
                    let conn = db.lock().unwrap();
                    (
                        store::pull_since(&conn, &app_id, cursor, i64::MAX).unwrap(),
                        store::max_seq(&conn).unwrap(),
                        store::device_id(&conn).unwrap(),
                    )
                };
                let _ = proto::write_msg(&mut send, &Msg::Batch { changes: batch }).await;
                let _ = proto::write_msg(
                    &mut send,
                    &Msg::PullDone { device_id: me, my_seq, your_seq_i_have: 0 },
                )
                .await;
                let _ = send.finish();
                connection.closed().await;
            });
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "opens real sockets; run with --ignored before releases"]
    async fn pull_over_real_quic_converges_and_rejects_bad_auth() {
        // Node A: has data, serves pulls.
        let (conn_a, secret) = seeded_node("a.db");
        conn_a
            .execute(
                "INSERT INTO \"d_tasks\" (id, data) VALUES ('01AAAAAAAAAAAAAAAAAAAAAAAA', json(?1))",
                [r#"{"title":"hello from a"}"#],
            )
            .unwrap();
        log::record_created(&conn_a, "tasks", "01AAAAAAAAAAAAAAAAAAAAAAAA", &json!({"title":"hello from a"}))
            .unwrap();
        let db_a = Arc::new(StdMutex::new(conn_a));

        let ep_a = Endpoint::builder(presets::N0)
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let addr_a = ep_a.addr();
        tokio::spawn(serve(ep_a.clone(), db_a.clone(), secret.clone()));

        // Node B: joins with the ticket secret and pulls everything.
        let (mut conn_b, _own) = {
            let mut conn = temp_db("b.db");
            // b joins rather than creates: register the share secret only.
            store::join_share(&mut conn, "tasks", &secret, 0).unwrap();
            (conn, ())
        };
        let dev_b = store::device_id(&conn_b).unwrap();

        let ep_b = Endpoint::builder(presets::N0)
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let conn = tokio::time::timeout(Duration::from_secs(10), ep_b.connect(addr_a.clone(), SYNC_ALPN))
            .await
            .expect("connect timed out")
            .expect("connect failed");
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        proto::write_msg(
            &mut send,
            &Msg::Pull {
                app_id: "tasks".into(),
                epoch: 0,
                device_id: dev_b.clone(),
                auth: proto::pull_auth(&secret, &dev_b),
                cursor: 0,
            },
        )
        .await
        .unwrap();
        send.finish().unwrap();

        let mut got_done = false;
        while let Some(msg) = proto::read_msg(&mut recv).await.unwrap() {
            match msg {
                Msg::Batch { changes } => {
                    merge::apply_remote(&mut conn_b, &changes).unwrap();
                }
                Msg::PullDone { .. } => {
                    got_done = true;
                    break;
                }
                other => panic!("unexpected: {other:?}"),
            }
        }
        assert!(got_done);
        let title: String = conn_b
            .query_row(
                "SELECT json_extract(data,'$.title') FROM \"d_tasks\" WHERE id='01AAAAAAAAAAAAAAAAAAAAAAAA'",
                [],
                |r| r.get(0),
            )
            .expect("record must exist on b after the pull");
        assert_eq!(title, "hello from a");
        // The definition came over too.
        let def_ok: bool = conn_b
            .query_row("SELECT EXISTS(SELECT 1 FROM apps WHERE id='tasks')", [], |r| r.get(0))
            .unwrap();
        assert!(def_ok);

        // Wrong secret → the server must refuse before sending any data.
        let evil = [9u8; 32];
        let conn = ep_b.connect(addr_a, SYNC_ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        proto::write_msg(
            &mut send,
            &Msg::Pull {
                app_id: "tasks".into(),
                epoch: 0,
                device_id: dev_b.clone(),
                auth: proto::pull_auth(&evil, &dev_b),
                cursor: 0,
            },
        )
        .await
        .unwrap();
        send.finish().unwrap();
        match proto::read_msg(&mut recv).await.unwrap() {
            Some(Msg::Err { .. }) => {}
            other => panic!("expected auth rejection, got {other:?}"),
        }

        ep_b.close().await;
    }
}
