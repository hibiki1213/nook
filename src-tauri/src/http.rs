//! A tiny localhost-only HTTP API so the external MCP server (pure JavaScript,
//! launched by Claude Desktop) can drive the same operations the UI uses,
//! without ever touching the database file directly. The app is the single
//! owner/writer of the DB.
//!
//! Bound to 127.0.0.1 only — never exposed off the machine.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::repo;

pub const ADDR: &str = "127.0.0.1:8765";

/// Contract version for the routes below — bumped **only** on a breaking change.
/// The MCP server refuses to run against a mismatched app, so the two can never
/// drift silently. (They ship together, but a stale extension can linger inside
/// Claude Desktop after the app is updated.)
pub const API_VERSION: u32 = 1;

/// Runs forever on a background thread. A bind failure is logged but does not
/// crash the app (the UI still works; only Claude integration is unavailable).
pub fn serve() {
    let server = match Server::http(ADDR) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[nook] local API could not bind {ADDR}: {e}");
            return;
        }
    };
    eprintln!("[nook] local API listening on http://{ADDR}");

    for mut request in server.incoming_requests() {
        let (code, body) = handle(&mut request);
        let header =
            Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
                .expect("valid header");
        let response = Response::from_string(body)
            .with_status_code(code)
            .with_header(header);
        let _ = request.respond(response);
    }
}

fn handle(request: &mut Request) -> (u16, String) {
    // Read the body first (ends the &mut borrow), then read method/url.
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    let method = request.method().clone();
    let url = request.url().to_string();

    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match route(&method, &segs, query, &body) {
        Ok(v) => (200, v.to_string()),
        Err(e) => (400, json!({ "error": format!("{:#}", e) }).to_string()),
    }
}

fn route(method: &Method, segs: &[&str], query: &str, body: &str) -> Result<Value> {
    // Path segments bind as `&&str` (match ergonomics); deref coercion turns them
    // into `&str` at the repo call sites.
    match (method, segs) {
        (Method::Get, []) | (Method::Get, ["health"]) => Ok(json!({
            "ok": true,
            "service": "nook",
            "version": env!("CARGO_PKG_VERSION"),
            "apiVersion": API_VERSION,
        })),

        (Method::Get, ["apps"]) => Ok(Value::Array(repo::list_apps()?)),
        (Method::Post, ["apps"]) => repo::create_app(parse(body)?),
        (Method::Get, ["apps", id]) => repo::get_app(id),
        (Method::Post, ["apps", id, "fields"]) => repo::add_field(id, parse(body)?),

        (Method::Get, ["apps", id, "records"]) => Ok(Value::Array(repo::list_records(
            id,
            query_param(query, "view").as_deref(),
        )?)),
        (Method::Post, ["apps", id, "records"]) => repo::create_record(id, parse(body)?),
        (Method::Patch, ["apps", id, "records", rid]) => {
            repo::update_record(id, parse_id(rid)?, parse(body)?)
        }
        (Method::Delete, ["apps", id, "records", rid]) => repo::delete_record(id, parse_id(rid)?),

        _ => Err(anyhow!("no route for {} /{}", method_str(method), segs.join("/"))),
    }
}

fn parse(body: &str) -> Result<Value> {
    serde_json::from_str(body).context("invalid JSON body")
}

fn parse_id(s: &str) -> Result<i64> {
    s.parse::<i64>().context("record id must be an integer")
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        pair.split_once('=').and_then(|(k, v)| {
            (k == key).then(|| v.replace('+', " "))
        })
    })
}

fn method_str(m: &Method) -> String {
    m.as_str().to_string()
}
