//! Invite tickets: `nook1<base32>` strings a user pastes into the join box.
//! Contents: the share secret(s) — possession = membership — plus the
//! issuer's EndpointAddr as the first hop (later peers are learned from the
//! member list and resolved via n0 DNS lookup).

use anyhow::{anyhow, Context, Result};
use data_encoding::BASE32_NOPAD;
use serde::{Deserialize, Serialize};

const PREFIX: &str = "nook1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketApp {
    pub app_id: String,
    /// base64 of the 32-byte share secret.
    pub secret: String,
    pub epoch: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub v: u32,
    /// Multiple entries when relation-dependent apps are shared together.
    pub apps: Vec<TicketApp>,
    pub issuer: iroh::EndpointAddr,
}

pub fn encode(ticket: &Ticket) -> Result<String> {
    let json = serde_json::to_vec(ticket)?;
    Ok(format!("{PREFIX}{}", BASE32_NOPAD.encode(&json).to_lowercase()))
}

pub fn decode(s: &str) -> Result<Ticket> {
    let s = s.trim();
    let body = s
        .strip_prefix(PREFIX)
        .ok_or_else(|| anyhow!("招待チケットの形式が違います(nook1… で始まる文字列)"))?;
    let bytes = BASE32_NOPAD
        .decode(body.to_uppercase().as_bytes())
        .context("チケットを読み取れません")?;
    let ticket: Ticket = serde_json::from_slice(&bytes).context("チケットの中身が壊れています")?;
    if ticket.v != 1 {
        return Err(anyhow!("このチケットは新しいバージョンの Nook で作られています"));
    }
    for app in &ticket.apps {
        let secret = secret_bytes(app)?;
        if secret.len() != 32 {
            return Err(anyhow!("チケットの鍵が壊れています"));
        }
    }
    Ok(ticket)
}

pub fn secret_bytes(app: &TicketApp) -> Result<Vec<u8>> {
    BASE32_NOPAD
        .decode(app.secret.to_uppercase().as_bytes())
        .context("チケットの鍵を読み取れません")
}

pub fn secret_string(secret: &[u8]) -> String {
    BASE32_NOPAD.encode(secret).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let secret = [7u8; 32];
        let t = Ticket {
            v: 1,
            apps: vec![TicketApp {
                app_id: "tasks".into(),
                secret: secret_string(&secret),
                epoch: 3,
            }],
            issuer: iroh::EndpointAddr::new(
                "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
                    .parse()
                    .unwrap(),
            ),
        };
        let s = encode(&t).unwrap();
        assert!(s.starts_with("nook1"));
        let back = decode(&s).unwrap();
        assert_eq!(back.apps[0].app_id, "tasks");
        assert_eq!(secret_bytes(&back.apps[0]).unwrap(), secret.to_vec());
        assert_eq!(back.issuer.id, t.issuer.id);
        // Whitespace tolerance (pasted from chat apps).
        assert!(decode(&format!("  {s}\n")).is_ok());
        assert!(decode("garbage").is_err());
    }
}
