//! Declarative app-definition model — the single source of truth for what an
//! app *is*. An app is data: a name, some fields, and some views. Both this
//! Rust backend and the Node MCP server materialize the same definition into a
//! physical SQLite table (see `db.rs` and `mcp-server/src/db.ts`).
//!
//! The materialization convention (table name, generated columns, indexes) is
//! documented in `docs/app-definition.md` and MUST stay in sync across both
//! implementations.

use serde::{Deserialize, Serialize};

/// Supported field types. Each maps to a SQLite column affinity used by the
/// generated (virtual) column that mirrors the value out of the JSON blob.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Text,
    Textarea,
    Number,
    Checkbox,
    Select,
    Date,
    /// A hyperlink; stored as the URL string.
    Url,
    /// A monetary amount; stored as a number (see `Field::currency` for display).
    Money,
    /// A star rating; stored as a number 1..=max (see `Field::max`, default 5).
    Rating,
    /// A set of labels; stored as a JSON array of strings. Its generated column
    /// therefore holds the array's JSON text (fine for display; not meant for
    /// range sorting).
    Tags,
    /// An image, stored as a URL / data-URI string shown as a thumbnail.
    Image,
    /// A file attachment, stored as `{ref, name, size}` — or an array of those
    /// when `Field::multiple`. Only the reference lives in the DB; the bytes go
    /// to `<app-data>/files/` (see `files.rs`). Like `Tags`, its generated column
    /// therefore holds JSON text (fine for display; not for range sorting).
    File,
    /// A reference to a record in another app (see `Field::app`); stored as the
    /// target record's integer id.
    Relation,
}

impl FieldType {
    /// SQLite affinity for the generated column mirroring this field.
    pub fn affinity(&self) -> &'static str {
        match self {
            // numeric-valued fields sort/compare correctly with REAL affinity
            FieldType::Number | FieldType::Money | FieldType::Rating => "REAL",
            FieldType::Checkbox | FieldType::Relation => "INTEGER",
            // text / textarea / select / date / url / image are stored as text;
            // tags and file store JSON text (see the FieldType docs above)
            _ => "TEXT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Field {
    /// Stable identifier, also used as the JSON key and (prefixed) column name.
    /// Must match `^[a-z][a-z0-9_]*$`.
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default)]
    pub required: bool,
    /// Choices for `select` fields.
    #[serde(default)]
    pub options: Vec<String>,
    /// When true, an index is created on the generated column.
    #[serde(default)]
    pub indexed: bool,
    /// Optional default applied by the UI when creating a record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// Max number of stars for a `rating` field (defaults to 5 in the UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    /// ISO 4217 currency code for a `money` field (defaults to JPY in the UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// Target app id for a `relation` field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// For `date` fields: surface records whose date is today (OS notification
    /// + sidebar badge).
    #[serde(default)]
    pub remind: bool,
    /// For `file` fields: allow several attachments. The stored value becomes an
    /// array of file refs instead of a single one.
    #[serde(default)]
    pub multiple: bool,
}

impl Field {
    /// Cross-property requirements serde can't express.
    pub fn validate(&self) -> Result<(), String> {
        if self.field_type == FieldType::Relation {
            match &self.app {
                Some(a) if is_safe_ident(a) => {}
                _ => {
                    return Err(format!(
                        "relation field '{}' requires `app` (target app id, ^[a-z][a-z0-9_]*$)",
                        self.id
                    ))
                }
            }
        }
        if self.remind && self.field_type != FieldType::Date {
            return Err(format!(
                "`remind` is only valid on date fields (field '{}')",
                self.id
            ));
        }
        if self.multiple && self.field_type != FieldType::File {
            return Err(format!(
                "`multiple` is only valid on file fields (field '{}')",
                self.id
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortSpec {
    pub field: String,
    /// "asc" | "desc"
    #[serde(default = "default_dir")]
    pub dir: String,
}

fn default_dir() -> String {
    "asc".to_string()
}

/// One aggregate metric for a `summary` view (e.g. sum of an amount field).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    /// Field id to aggregate. Ignored (may be empty) when `func` is "count".
    #[serde(default)]
    pub field: String,
    /// "sum" | "avg" | "count" | "min" | "max".
    #[serde(rename = "fn", default = "default_metric_fn")]
    pub func: String,
}

fn default_metric_fn() -> String {
    "count".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// camelCase so JSON keys like `groupBy`/`dateField` round-trip (the explicit
// `type` rename below still wins for `view_type`). Without this, serde looked
// for `group_by` and silently dropped the seed's `groupBy`.
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    /// "table" | "board" | "calendar" | "gallery" | "summary" | "chart" | "heatmap"
    #[serde(rename = "type", default = "default_view_type")]
    pub view_type: String,
    /// Fields shown as columns (table view).
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub sort: Vec<SortSpec>,
    /// select-field id to group by (board view; also the grouping for summary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// date-field id records are placed on (calendar view).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_field: Option<String>,
    /// image-field id shown as the card image (gallery view).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_field: Option<String>,
    /// aggregate shown by a summary/chart/heatmap view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<Metric>,
    /// chart style for a `chart` view: "line" | "area".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_type: Option<String>,
    /// time bucket for a `chart` x-axis: "day" | "week" | "month".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
}

fn default_view_type() -> String {
    "table".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppDefinition {
    /// Stable id — must match `^[a-z][a-z0-9_]*$`; used to derive the table name.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fields: Vec<Field>,
    #[serde(default)]
    pub views: Vec<View>,
}

impl AppDefinition {
    /// Physical table name for this app's records.
    pub fn table_name(&self) -> String {
        format!("d_{}", self.id)
    }

    pub fn field(&self, id: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.id == id)
    }

    pub fn view(&self, id: &str) -> Option<&View> {
        self.views.iter().find(|v| v.id == id)
    }
}

/// Identifiers coming from a definition are interpolated into DDL/DML where they
/// cannot be bound as parameters, so they must be strictly validated. Values are
/// always bound as parameters and never pass through here.
pub fn is_safe_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false)
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_camelcase_config_roundtrips() {
        // Regression: camelCase view keys must survive the Rust round-trip (they
        // were silently dropped before `rename_all = "camelCase"` on View).
        let j = r#"{"id":"t","name":"T","fields":[],"views":[
            {"id":"b","name":"B","type":"board","groupBy":"status"},
            {"id":"c","name":"C","type":"calendar","dateField":"due"},
            {"id":"g","name":"G","type":"gallery","imageField":"cover"},
            {"id":"s","name":"S","type":"summary","groupBy":"cat","metric":{"field":"amount","fn":"sum"}},
            {"id":"ch","name":"Ch","type":"chart","dateField":"due","chartType":"line","bucket":"month","metric":{"field":"amount","fn":"sum"}}
        ]}"#;
        let def: AppDefinition = serde_json::from_str(j).unwrap();
        let back = serde_json::to_string(&def).unwrap();
        for key in [
            "groupBy", "dateField", "imageField", "\"type\":\"summary\"", "\"fn\":\"sum\"",
            "chartType", "\"bucket\":\"month\"",
        ] {
            assert!(back.contains(key), "{key} was dropped: {back}");
        }
        assert_eq!(def.views[0].group_by.as_deref(), Some("status"));
        assert_eq!(def.views[1].date_field.as_deref(), Some("due"));
        assert_eq!(def.views[2].image_field.as_deref(), Some("cover"));
        let m = def.views[3].metric.as_ref().unwrap();
        assert_eq!((m.field.as_str(), m.func.as_str()), ("amount", "sum"));
        assert_eq!(def.views[4].chart_type.as_deref(), Some("line"));
        assert_eq!(def.views[4].bucket.as_deref(), Some("month"));
    }

    #[test]
    fn file_field_accepts_multiple_and_stores_as_text() {
        let ok: Field = serde_json::from_str(
            r#"{"id":"papers","label":"過去問","type":"file","multiple":true}"#,
        )
        .unwrap();
        assert!(ok.validate().is_ok());
        assert!(ok.multiple);
        // Like `tags`, the generated column holds JSON text.
        assert_eq!(ok.field_type.affinity(), "TEXT");

        // A single-attachment file field is the default.
        let single: Field =
            serde_json::from_str(r#"{"id":"syllabus","label":"S","type":"file"}"#).unwrap();
        assert!(single.validate().is_ok());
        assert!(!single.multiple);
    }

    #[test]
    fn multiple_is_rejected_on_non_file_fields() {
        let bad: Field =
            serde_json::from_str(r#"{"id":"labels","label":"L","type":"tags","multiple":true}"#)
                .unwrap();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn relation_field_requires_target_app() {
        let ok: Field = serde_json::from_str(
            r#"{"id":"author","label":"A","type":"relation","app":"people"}"#,
        )
        .unwrap();
        assert!(ok.validate().is_ok());
        assert_eq!(ok.field_type.affinity(), "INTEGER");

        let missing: Field =
            serde_json::from_str(r#"{"id":"author","label":"A","type":"relation"}"#).unwrap();
        assert!(missing.validate().is_err());

        let unsafe_target: Field = serde_json::from_str(
            r#"{"id":"author","label":"A","type":"relation","app":"People!"}"#,
        )
        .unwrap();
        assert!(unsafe_target.validate().is_err());
    }
}
