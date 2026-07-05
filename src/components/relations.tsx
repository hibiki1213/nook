// Relation resolution: an app's relation fields point at other apps' records by
// integer id. The provider (mounted once per open app in AppView) fetches every
// target app's definition + records so cells and pickers resolve synchronously.
// Local data, so eagerly loading whole target apps is cheap.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getApp, listRecords } from "../api";
import type { AppDefinition, RecordRow } from "../types";

interface TargetData {
  def: AppDefinition;
  records: RecordRow[];
}

export interface RelationOption {
  id: number;
  title: string;
}

interface RelationApi {
  /** Display title of record `id` in app `appId`, or null if unresolvable. */
  titleOf: (appId: string | undefined, id: unknown) => string | null;
  /** Pickable records of app `appId` (id + display title). */
  optionsOf: (appId: string | undefined) => RelationOption[];
}

const RelationContext = createContext<RelationApi>({
  titleOf: () => null,
  optionsOf: () => [],
});

export const useRelations = () => useContext(RelationContext);

function titleField(def: AppDefinition) {
  return def.fields.find((f) => f.type === "text") ?? def.fields[0];
}

function recordTitle(def: AppDefinition, r: RecordRow): string {
  const f = titleField(def);
  const v = f ? r.data[f.id] : undefined;
  const s = v == null ? "" : String(v);
  return s || `#${r.id}`;
}

export function RelationProvider({
  app,
  children,
}: {
  app: AppDefinition;
  children: ReactNode;
}) {
  const [targets, setTargets] = useState<Record<string, TargetData>>({});

  // Distinct target app ids referenced by this app's relation fields.
  const targetKey = useMemo(
    () =>
      [
        ...new Set(
          app.fields
            .filter((f) => f.type === "relation" && f.app)
            .map((f) => f.app as string),
        ),
      ]
        .sort()
        .join(","),
    [app],
  );

  useEffect(() => {
    if (!targetKey) {
      setTargets({});
      return;
    }
    let alive = true;
    (async () => {
      const next: Record<string, TargetData> = {};
      for (const id of targetKey.split(",")) {
        try {
          const [def, records] = await Promise.all([getApp(id), listRecords(id)]);
          next[id] = { def, records };
        } catch {
          // Target app was deleted or never existed — cells fall back to #id.
        }
      }
      if (alive) setTargets(next);
    })();
    return () => {
      alive = false;
    };
  }, [targetKey]);

  const api = useMemo<RelationApi>(
    () => ({
      titleOf: (appId, id) => {
        if (!appId) return null;
        const t = targets[appId];
        const n = Number(id);
        if (!t || !Number.isFinite(n)) return null;
        const r = t.records.find((r) => r.id === n);
        return r ? recordTitle(t.def, r) : null;
      },
      optionsOf: (appId) => {
        if (!appId) return [];
        const t = targets[appId];
        if (!t) return [];
        return t.records.map((r) => ({ id: r.id, title: recordTitle(t.def, r) }));
      },
    }),
    [targets],
  );

  return (
    <RelationContext.Provider value={api}>{children}</RelationContext.Provider>
  );
}
