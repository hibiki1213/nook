import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@emobi/ui";
import { dueCounts, listApps } from "./api";
import { initImages } from "./lib/images";
import type { AppSummary } from "./types";
import { Sidebar } from "./components/Sidebar";
import { AppView } from "./components/AppView";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { PlusIcon, SunIcon, MoonIcon, MonitorIcon } from "./components/icons";

export default function App() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [due, setDue] = useState<Record<string, number>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  // AppView registers its "new record" opener here so the palette can invoke it.
  const newRecordRef = useRef<(() => void) | null>(null);
  const { setTheme } = useTheme();

  const refreshApps = useCallback(async () => {
    const list = await listApps();
    setApps(list);
    setSelected((prev) =>
      list.some((a) => a.id === prev) ? prev : list[0]?.id ?? "",
    );
    // Due badges ride the same poll; a failure only skips the badges.
    try {
      const d = await dueCounts();
      setDue(Object.fromEntries(d.map((x) => [x.appId, x.count])));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Resolve the images dir once so local image refs render synchronously.
    void initImages();
    refreshApps();
    // Poll so apps created by Claude (via MCP) show up without a restart.
    const t = setInterval(refreshApps, 4000);
    return () => clearInterval(t);
  }, [refreshApps]);

  // ⌘K / Ctrl+K — command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];
    if (selected) {
      cmds.push({
        id: "new-record",
        label: "新規レコード",
        hint: "⌘N",
        icon: <PlusIcon size={16} />,
        run: () => newRecordRef.current?.(),
      });
    }
    for (const a of apps) {
      cmds.push({
        id: `app:${a.id}`,
        label: a.name,
        hint: "アプリを開く",
        icon: <span className="nk-cmd-emoji">{a.icon ?? "🗂"}</span>,
        run: () => setSelected(a.id),
      });
    }
    cmds.push(
      {
        id: "theme:light",
        label: "テーマ: ライト",
        icon: <SunIcon size={16} />,
        run: () => setTheme("light"),
      },
      {
        id: "theme:dark",
        label: "テーマ: ダーク",
        icon: <MoonIcon size={16} />,
        run: () => setTheme("dark"),
      },
      {
        id: "theme:system",
        label: "テーマ: 自動",
        icon: <MonitorIcon size={16} />,
        run: () => setTheme("system"),
      },
    );
    return cmds;
  }, [apps, selected, setTheme]);

  return (
    <div className="nk-root">
      <Sidebar apps={apps} selected={selected} onSelect={setSelected} due={due} />
      <main className="nk-main">
        {selected ? (
          <AppView
            key={selected}
            appId={selected}
            onDeleted={refreshApps}
            newRecordRef={newRecordRef}
          />
        ) : (
          <div className="nk-empty-state">アプリを選択してください</div>
        )}
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
