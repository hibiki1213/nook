// Maps one declarative field to the right editing control. This is the whole
// "form engine" — add a field type here and every app gets it.
import { Input, Checkbox } from "@emobi/ui";
import { Select, Textarea, Stars, TagInput } from "./primitives";
import { FilePicker } from "./FilePicker";
import { ImagePicker } from "./ImagePicker";
import { useRelations } from "./relations";
import { toTags } from "../lib/format";
import type { Field } from "../types";

/** Dropdown over the target app's records (value = record id, a ULID string).
 *  Exported for inline cell editing (CellEditor). */
export function RelationSelect({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (v: string | null) => void;
}) {
  const { optionsOf } = useRelations();
  const options = optionsOf(field.app);
  return (
    <div className="nk-select">
      <select
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">選択…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.title}
          </option>
        ))}
      </select>
      <svg
        className="nk-select-chevron"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

export function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const str = value == null ? "" : String(value);

  switch (field.type) {
    case "text":
      return (
        <Input
          label={field.label}
          required={field.required}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <Input
          label={field.label}
          type="number"
          required={field.required}
          value={str}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "date":
      return (
        <Input
          label={field.label}
          type="date"
          required={field.required}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "textarea":
      return (
        <Textarea
          label={field.label}
          value={str}
          onChange={(v) => onChange(v)}
        />
      );
    case "select":
      return (
        <div className="nk-field">
          <label className="nk-label">
            {field.label}
            {field.required && <span className="nk-req">*</span>}
          </label>
          <Select
            value={str}
            onChange={(v) => onChange(v)}
            options={field.options ?? []}
          />
        </div>
      );
    case "checkbox":
      return (
        <div className="nk-field nk-field-inline">
          <Checkbox
            checked={!!value}
            onChange={(c) => onChange(c)}
            label={field.label}
          />
        </div>
      );
    case "url":
      return (
        <Input
          label={field.label}
          type="url"
          placeholder="https://…"
          required={field.required}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "money":
      return (
        <Input
          label={field.label}
          type="number"
          required={field.required}
          value={str}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "rating":
      return (
        <div className="nk-field">
          <label className="nk-label">
            {field.label}
            {field.required && <span className="nk-req">*</span>}
          </label>
          <Stars
            value={typeof value === "number" ? value : 0}
            max={field.max ?? 5}
            onChange={(v) => onChange(v)}
          />
        </div>
      );
    case "tags":
      return (
        <div className="nk-field">
          <label className="nk-label">
            {field.label}
            {field.required && <span className="nk-req">*</span>}
          </label>
          <TagInput
            value={toTags(value)}
            options={field.options}
            onChange={(v) => onChange(v)}
          />
        </div>
      );
    case "image":
      return (
        <div className="nk-field">
          <label className="nk-label">
            {field.label}
            {field.required && <span className="nk-req">*</span>}
          </label>
          <ImagePicker value={str} onChange={(v) => onChange(v)} />
        </div>
      );
    case "file":
      return (
        <div className="nk-field">
          <label className="nk-label">
            {field.label}
            {field.required && <span className="nk-req">*</span>}
          </label>
          <FilePicker field={field} value={value} onChange={(v) => onChange(v)} />
        </div>
      );
    case "relation":
      return (
        <div className="nk-field">
          <label className="nk-label">
            {field.label}
            {field.required && <span className="nk-req">*</span>}
          </label>
          <RelationSelect field={field} value={value} onChange={(v) => onChange(v)} />
        </div>
      );
    default:
      return null;
  }
}
