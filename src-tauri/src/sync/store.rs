//! Sync bookkeeping: the change-log schema, this device's identity, the local
//! sequence counter, which apps are shared, and per-peer cursors.
//!
//! Everything here operates on a caller-provided `Connection` (usually a
//! transaction), never opens its own — the caller owns atomicity.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::Change;
use crate::models::AppDefinition;

/// Schema. Called from `db::init` — idempotent.
pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS crdt_changes (
            app_id     TEXT NOT NULL,
            entity     TEXT NOT NULL,
            entity_id  TEXT NOT NULL,
            attr       TEXT NOT NULL,
            value      TEXT,
            hlc        TEXT NOT NULL,
            actor      TEXT NOT NULL,
            seq        INTEGER NOT NULL,
            tombstone  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (app_id, entity, entity_id, attr)
        );
        CREATE INDEX IF NOT EXISTS ix_crdt_app_seq ON crdt_changes(app_id, seq);
        CREATE TABLE IF NOT EXISTS shares (
            app_id     TEXT PRIMARY KEY,
            secret     BLOB NOT NULL,
            epoch      INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS share_members (
            app_id     TEXT NOT NULL,
            device_id  TEXT NOT NULL,
            node_id    TEXT NOT NULL,
            name       TEXT,
            epoch_sent INTEGER NOT NULL DEFAULT 0,
            removed    INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (app_id, device_id)
        );
        CREATE TABLE IF NOT EXISTS sync_cursors (
            app_id         TEXT NOT NULL,
            peer_device    TEXT NOT NULL,
            last_seq_recv  INTEGER NOT NULL DEFAULT 0,
            last_seq_acked INTEGER NOT NULL DEFAULT 0,
            last_sync_at   TEXT,
            PRIMARY KEY (app_id, peer_device)
        );
        "#,
    )?;
    Ok(())
}

// ── Identity & counters ─────────────────────────────────────────────────────

/// This installation's stable actor id (also the LWW tiebreaker). Created
/// lazily; deliberately separate from the iroh node id so network keys can
/// rotate without rewriting history.
pub fn device_id(conn: &Connection) -> Result<String> {
    let existing: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'device_id'", [], |r| r.get(0))
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let bytes: [u8; 16] = rand::random();
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('device_id', ?1)",
        [&id],
    )?;
    Ok(id)
}

/// Next value of the local monotonic sequence — the pull cursor's unit.
/// Every winner row written locally (authored *or* applied) gets a fresh one.
pub fn next_seq(conn: &Connection) -> Result<i64> {
    let cur: i64 = conn
        .query_row("SELECT value FROM settings WHERE key = 'crdt_seq'", [], |r| {
            r.get::<_, String>(0).map(|s| s.parse().unwrap_or(0))
        })
        .optional()?
        .unwrap_or(0);
    let next = cur + 1;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('crdt_seq', ?1)",
        [next.to_string()],
    )?;
    Ok(next)
}

pub fn max_seq(conn: &Connection) -> Result<i64> {
    let cur: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'crdt_seq'", [], |r| r.get(0))
        .optional()?;
    Ok(cur.and_then(|s| s.parse().ok()).unwrap_or(0))
}

// ── Shares ──────────────────────────────────────────────────────────────────

pub fn is_shared(conn: &Connection, app_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM shares WHERE app_id = ?1)",
        [app_id],
        |r| r.get(0),
    )?)
}

pub fn shared_apps(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT app_id FROM shares ORDER BY app_id")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn share_secret(conn: &Connection, app_id: &str) -> Result<(Vec<u8>, i64)> {
    conn.query_row(
        "SELECT secret, epoch FROM shares WHERE app_id = ?1",
        [app_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .with_context(|| format!("app is not shared: {app_id}"))
}

/// Start sharing an app that exists locally: create the share row and seed the
/// change log with the full current state (definition + every record), so a
/// joiner's from-zero pull is just a normal pull. One transaction.
pub fn start_share(conn: &mut Connection, app_id: &str) -> Result<Vec<u8>> {
    let tx = conn.transaction()?;
    if is_shared(&tx, app_id)? {
        let (secret, _) = share_secret(&tx, app_id)?;
        tx.commit()?;
        return Ok(secret);
    }
    let secret: [u8; 32] = rand::random();
    tx.execute(
        "INSERT INTO shares (app_id, secret, epoch) VALUES (?1, ?2, 0)",
        params![app_id, secret.as_slice()],
    )?;

    // Definition → change log (None = "everything is new").
    let raw: String = tx
        .query_row("SELECT definition FROM apps WHERE id = ?1", [app_id], |r| r.get(0))
        .with_context(|| format!("app not found: {app_id}"))?;
    let def: AppDefinition = serde_json::from_str(&raw).context("invalid app definition")?;
    super::log::definition_changed(&tx, app_id, None, &def)?;

    // Records → change log.
    let rows: Vec<(String, String)> = {
        let mut stmt =
            tx.prepare(&format!("SELECT id, data FROM \"{}\"", def.table_name()))?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, data) in rows {
        let data: serde_json::Value =
            serde_json::from_str(&data).unwrap_or_else(|_| serde_json::json!({}));
        super::log::record_created(&tx, app_id, &id, &data)?;
    }
    tx.commit()?;
    Ok(secret.to_vec())
}

/// Join a share created elsewhere: record the secret so pulled changes are
/// accepted and logged-through. Refuses if the app already exists locally
/// (merging two unrelated apps with the same id is not supported in v1).
pub fn join_share(conn: &mut Connection, app_id: &str, secret: &[u8], epoch: i64) -> Result<()> {
    if !crate::models::is_safe_ident(app_id) {
        return Err(anyhow!("unsafe app id in ticket: {app_id}"));
    }
    let tx = conn.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM apps WHERE id = ?1)",
        [app_id],
        |r| r.get(0),
    )?;
    if exists && !is_shared(&tx, app_id)? {
        return Err(anyhow!(
            "同じ id のアプリ '{app_id}' が既にあります。共有に参加するには、先に既存アプリを削除するか名前を変えてください"
        ));
    }
    tx.execute(
        "INSERT INTO shares (app_id, secret, epoch) VALUES (?1, ?2, ?3)
         ON CONFLICT(app_id) DO UPDATE SET secret=excluded.secret, epoch=excluded.epoch",
        params![app_id, secret, epoch],
    )?;
    tx.commit()?;
    Ok(())
}

/// Stop sharing (this device leaves). Local data stays; the change log rows
/// for the app are kept too (harmless, and rejoining reuses them).
pub fn leave_share(conn: &Connection, app_id: &str) -> Result<()> {
    conn.execute("DELETE FROM shares WHERE app_id = ?1", [app_id])?;
    conn.execute("DELETE FROM share_members WHERE app_id = ?1", [app_id])?;
    conn.execute("DELETE FROM sync_cursors WHERE app_id = ?1", [app_id])?;
    Ok(())
}

/// Rotate the share secret (member removal). Members must re-learn the new
/// secret via a Rekey message; `epoch_sent` tracks who has it.
pub fn rotate_secret(conn: &Connection, app_id: &str) -> Result<(Vec<u8>, i64)> {
    let secret: [u8; 32] = rand::random();
    conn.execute(
        "UPDATE shares SET secret = ?1, epoch = epoch + 1 WHERE app_id = ?2",
        params![secret.as_slice(), app_id],
    )?;
    let (_, epoch) = share_secret(conn, app_id)?;
    Ok((secret.to_vec(), epoch))
}

// ── Change rows ─────────────────────────────────────────────────────────────

/// Upsert a winner row with a fresh local seq. The caller has already decided
/// the change wins (or authored it).
pub fn put_winner(conn: &Connection, c: &Change) -> Result<i64> {
    let seq = next_seq(conn)?;
    conn.execute(
        "INSERT INTO crdt_changes (app_id, entity, entity_id, attr, value, hlc, actor, seq, tombstone)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(app_id, entity, entity_id, attr) DO UPDATE SET
             value=excluded.value, hlc=excluded.hlc, actor=excluded.actor,
             seq=excluded.seq, tombstone=excluded.tombstone",
        params![c.app_id, c.entity, c.entity_id, c.attr, c.value, c.hlc, c.actor, seq, c.tombstone as i64],
    )?;
    Ok(seq)
}

/// Current winner's (hlc, actor, tombstone) for a key, if any.
pub fn winner(
    conn: &Connection,
    app_id: &str,
    entity: &str,
    entity_id: &str,
    attr: &str,
) -> Result<Option<(String, String, bool)>> {
    Ok(conn
        .query_row(
            "SELECT hlc, actor, tombstone FROM crdt_changes
             WHERE app_id=?1 AND entity=?2 AND entity_id=?3 AND attr=?4",
            params![app_id, entity, entity_id, attr],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .optional()?)
}

/// Winner rows of one app above a cursor, in seq order — the pull payload.
pub fn pull_since(conn: &Connection, app_id: &str, after_seq: i64, limit: i64) -> Result<Vec<Change>> {
    let mut stmt = conn.prepare(
        "SELECT app_id, entity, entity_id, attr, value, hlc, actor, seq, tombstone
         FROM crdt_changes WHERE app_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![app_id, after_seq, limit], |r| {
            Ok(Change {
                app_id: r.get(0)?,
                entity: r.get(1)?,
                entity_id: r.get(2)?,
                attr: r.get(3)?,
                value: r.get(4)?,
                hlc: r.get(5)?,
                actor: r.get(6)?,
                seq: r.get(7)?,
                tombstone: r.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ── Cursors & members ───────────────────────────────────────────────────────

pub fn cursor_recv(conn: &Connection, app_id: &str, peer: &str) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT last_seq_recv FROM sync_cursors WHERE app_id=?1 AND peer_device=?2",
            params![app_id, peer],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

pub fn set_cursor_recv(conn: &Connection, app_id: &str, peer: &str, seq: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_cursors (app_id, peer_device, last_seq_recv, last_sync_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(app_id, peer_device) DO UPDATE SET
             last_seq_recv=max(last_seq_recv, excluded.last_seq_recv),
             last_sync_at=datetime('now')",
        params![app_id, peer, seq],
    )?;
    Ok(())
}

pub fn set_cursor_acked(conn: &Connection, app_id: &str, peer: &str, seq: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_cursors (app_id, peer_device, last_seq_acked, last_sync_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(app_id, peer_device) DO UPDATE SET
             last_seq_acked=max(last_seq_acked, excluded.last_seq_acked),
             last_sync_at=datetime('now')",
        params![app_id, peer, seq],
    )?;
    Ok(())
}

/// Changes of `app_id` not yet confirmed held by every active member — the
/// "未送信" number in the status panel. 0 when there are no other members.
pub fn pending_out(conn: &Connection, app_id: &str, me: &str) -> Result<i64> {
    let min_acked: Option<i64> = conn
        .query_row(
            "SELECT min(c.last_seq_acked) FROM share_members m
             LEFT JOIN sync_cursors c ON c.app_id = m.app_id AND c.peer_device = m.device_id
             WHERE m.app_id = ?1 AND m.device_id != ?2 AND m.removed = 0",
            params![app_id, me],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(min_acked) = min_acked else { return Ok(0) };
    Ok(conn.query_row(
        "SELECT count(*) FROM crdt_changes WHERE app_id = ?1 AND seq > ?2",
        params![app_id, min_acked],
        |r| r.get(0),
    )?)
}

pub fn upsert_member(
    conn: &Connection,
    app_id: &str,
    device_id: &str,
    node_id: &str,
    name: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO share_members (app_id, device_id, node_id, name)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(app_id, device_id) DO UPDATE SET
             node_id=excluded.node_id,
             name=coalesce(excluded.name, share_members.name)",
        params![app_id, device_id, node_id, name],
    )?;
    Ok(())
}

pub struct Member {
    pub device_id: String,
    pub node_id: String,
    pub name: Option<String>,
    pub epoch_sent: i64,
    pub removed: bool,
}

pub fn members(conn: &Connection, app_id: &str) -> Result<Vec<Member>> {
    let mut stmt = conn.prepare(
        "SELECT device_id, node_id, name, epoch_sent, removed
         FROM share_members WHERE app_id = ?1 ORDER BY device_id",
    )?;
    let rows = stmt
        .query_map([app_id], |r| {
            Ok(Member {
                device_id: r.get(0)?,
                node_id: r.get(1)?,
                name: r.get(2)?,
                epoch_sent: r.get(3)?,
                removed: r.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
