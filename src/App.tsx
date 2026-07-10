import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@emobi/ui";
import { dueCounts, listApps } from "./api";
import { ACCENTS, setAccent } from "./lib/accent";
import { initFiles } from "./lib/files";
import { initImages } from "./lib/images";
import type { AppSummary } from "./types";
import { Sidebar } from "./components/Sidebar";
import { AppView } from "./components/AppView";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { NewAppModal } from "./components/NewAppModal";
import {
  EditIcon,
  GearIcon,
  PlusIcon,
  SidebarIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from "./components/icons";

export default function App() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [due, setDue] = useState<Record<string, number>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newAppOpen, setNewAppOpen] = useState(false);
  // Set right after 新規アプリ so the freshly mounted AppView opens its builder.
  const [builderAppId, setBuilderAppId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("nk-sidebar") !== "collapsed",
  );
  // AppView registers its "new record" / "edit app" openers here so the
  // palette can invoke them.
  const newRecordRef = useRef<(() => void) | null>(null);
  const editAppRef = useRef<(() => void) | null>(null);
  const { setTheme } = useTheme();

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      localStorage.setItem("nk-sidebar", open ? "collapsed" : "open");
      return !open;
    });
  }, []);

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
    // Resolve the images/files dirs once so local refs render synchronously.
    void initImages();
    void initFiles();
    refreshApps();
    // Poll so apps created by Claude (via MCP) show up without a restart.
    const t = setInterval(refreshApps, 4000);
    return () => clearInterval(t);
  }, [refreshApps]);

  // The sidebar clears the macOS traffic lights — but fullscreen hides them,
  // so the clearance must come
  // and go with it. CSS keys off the attribute, React off the state.
  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return; // plain-browser dev (vite without tauri) — no window API
    }
    const sync = async () => {
      document.documentElement.dataset.fullscreen = String(
        await win.isFullscreen(),
      );
    };
    void sync();
    const unlisten = win.onResized(sync);
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // ⌘K — command palette. ⌘B — sidebar (VS Code muscle memory).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];
    if (selected) {
      cmds.push(
        {
          id: "new-record",
          label: "新規レコード",
          hint: "⌘N",
          icon: <PlusIcon size={16} />,
          run: () => newRecordRef.current?.(),
        },
        {
          id: "edit-app",
          label: "アプリを編集",
          icon: <EditIcon size={16} />,
          run: () => editAppRef.current?.(),
        },
      );
    }
    cmds.push({
      id: "new-app",
      label: "新規アプリ",
      icon: <PlusIcon size={16} />,
      run: () => setNewAppOpen(true),
    });
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
        id: "sidebar:toggle",
        label: "サイドバーを表示 / 隠す",
        hint: "⌘B",
        icon: <SidebarIcon size={16} />,
        run: toggleSidebar,
      },
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
      {
        id: "settings",
        label: "設定を開く",
        icon: <GearIcon size={16} />,
        run: () => setSettingsOpen(true),
      },
    );
    for (const a of ACCENTS) {
      cmds.push({
        id: `accent:${a.id}`,
        label: `アクセント: ${a.label}`,
        icon: <span className="nk-cmd-dot" style={{ background: a.dot }} />,
        run: () => setAccent(a.id),
      });
    }
    return cmds;
  }, [apps, selected, setTheme]);

  return (
    <div className="nk-root">
      <Sidebar
        apps={apps}
        selected={selected}
        onSelect={setSelected}
        due={due}
        collapsed={!sidebarOpen}
        onToggle={toggleSidebar}
        onOpenSettings={() => setSettingsOpen(true)}
        onNewApp={() => setNewAppOpen(true)}
      />
      <main className="nk-main">
        {selected ? (
          <AppView
            key={selected}
            appId={selected}
            onDeleted={refreshApps}
            onChanged={refreshApps}
            newRecordRef={newRecordRef}
            editAppRef={editAppRef}
            autoOpenBuilder={selected === builderAppId}
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
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {newAppOpen && (
        <NewAppModal
          onClose={() => setNewAppOpen(false)}
          onCreated={async (appId) => {
            setNewAppOpen(false);
            setBuilderAppId(appId);
            await refreshApps();
            setSelected(appId);
          }}
        />
      )}
    </div>
  );
}
