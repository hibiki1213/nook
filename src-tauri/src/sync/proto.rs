//! Wire protocol for the direct QUIC sync streams (ALPN `nook/sync/1`).
//! JSON messages behind a u32-BE length prefix — small, debuggable, and the
//! payloads (change batches) are JSON anyway.

use anyhow::{anyhow, Result};
use iroh::endpoint::{RecvStream, SendStream};
use serde::{Deserialize, Serialize};

use super::Change;

pub const SYNC_ALPN: &[u8] = b"nook/sync/1";

/// Hard cap on a single frame — a batch of 500 changes stays far below this;
/// anything bigger is a broken or hostile peer.
const MAX_FRAME: u32 = 8 * 1024 * 1024;

/// How many changes go into one Batch frame.
pub const BATCH_SIZE: i64 = 500;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    /// "Send me app_id's winners above `cursor`." `auth` proves knowledge of
    /// the share secret for `epoch`, bound to the requester's device id.
    Pull {
        app_id: String,
        epoch: i64,
        device_id: String,
        auth: String,
        cursor: i64,
    },
    Batch {
        changes: Vec<Change>,
    },
    /// End of a pull. `my_seq` = server's current max seq for future pulls;
    /// `your_seq_i_have` = how much of the requester's data the server holds
    /// (feeds the "未送信" counter).
    PullDone {
        device_id: String,
        my_seq: i64,
        your_seq_i_have: i64,
    },
    /// Secret rotation after a member removal, authenticated with the OLD
    /// secret. `secret` is base64 of the new 32-byte secret.
    Rekey {
        app_id: String,
        epoch: i64,
        secret: String,
        auth: String,
    },
    RekeyOk,
    Err {
        message: String,
    },
}

pub async fn write_msg(stream: &mut SendStream, msg: &Msg) -> Result<()> {
    let bytes = serde_json::to_vec(msg)?;
    let len = u32::try_from(bytes.len()).map_err(|_| anyhow!("frame too large"))?;
    if len > MAX_FRAME {
        return Err(anyhow!("frame too large: {len}"));
    }
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

/// `Ok(None)` = clean end of stream.
pub async fn read_msg(stream: &mut RecvStream) -> Result<Option<Msg>> {
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(_) => return Ok(None), // EOF (or reset) — treat as end
    }
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(anyhow!("incoming frame too large: {len}"));
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await?;
    Ok(Some(serde_json::from_slice(&buf)?))
}

// ── Authentication & topic derivation ──────────────────────────────────────
// All keyed on the 32-byte share secret: knowing it IS membership.

fn keyed(secret: &[u8], msg: &[u8]) -> String {
    let key: [u8; 32] = secret.try_into().expect("share secret must be 32 bytes");
    blake3::keyed_hash(&key, msg).to_hex().to_string()
}

pub fn pull_auth(secret: &[u8], device_id: &str) -> String {
    keyed(secret, format!("nook-pull:{device_id}").as_bytes())
}

pub fn rekey_auth(old_secret: &[u8], app_id: &str, epoch: i64, new_secret: &[u8]) -> String {
    let mut msg = format!("nook-rekey:{app_id}:{epoch}:").into_bytes();
    msg.extend_from_slice(new_secret);
    keyed(old_secret, &msg)
}

/// Gossip topic for one shared app: derivable only with the current secret,
/// so a removed member can't even find the new swarm.
pub fn topic_id(secret: &[u8], app_id: &str) -> iroh_gossip::proto::TopicId {
    let key: [u8; 32] = secret.try_into().expect("share secret must be 32 bytes");
    let hash = blake3::keyed_hash(&key, format!("nook-topic:{app_id}").as_bytes());
    iroh_gossip::proto::TopicId::from_bytes(*hash.as_bytes())
}

/// Constant-time-ish comparison is overkill here (auth values are one-shot,
/// high-entropy), but cheap: compare hashes of both sides.
pub fn auth_eq(a: &str, b: &str) -> bool {
    blake3::hash(a.as_bytes()) == blake3::hash(b.as_bytes())
}

/// The gossip announcement: "device X (endpoint E) is at seq N".
#[derive(Debug, Serialize, Deserialize)]
pub struct Announce {
    pub device_id: String,
    pub endpoint: String, // hex EndpointId
    pub seq: i64,
}
