import { useCallback, useEffect, useState } from "react";
import { listApps } from "./api";
import { initImages } from "./lib/images";
import type { AppSummary } from "./types";
import { Sidebar } from "./components/Sidebar";
import { AppView } from "./components/AppView";

export default function App() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [selected, setSelected] = useState<string>("");

  const refreshApps = useCallback(async () => {
    const list = await listApps();
    setApps(list);
    setSelected((prev) =>
      list.some((a) => a.id === prev) ? prev : list[0]?.id ?? "",
    );
  }, []);

  useEffect(() => {
    // Resolve the images dir once so local image refs render synchronously.
    void initImages();
    refreshApps();
    // Poll so apps created by Claude (via MCP) show up without a restart.
    const t = setInterval(refreshApps, 4000);
    return () => clearInterval(t);
  }, [refreshApps]);

  return (
    <div className="nk-root">
      <Sidebar apps={apps} selected={selected} onSelect={setSelected} />
      <main className="nk-main">
        {selected ? (
          <AppView key={selected} appId={selected} onDeleted={refreshApps} />
        ) : (
          <div className="nk-empty-state">アプリを選択してください</div>
        )}
      </main>
    </div>
  );
}
