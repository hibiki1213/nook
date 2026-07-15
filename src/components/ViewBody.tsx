import type { AppDefinition, RecordRow, View } from "../types";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { CalendarView } from "./CalendarView";
import { GalleryView } from "./GalleryView";
import { SummaryView } from "./SummaryView";
import { ChartView } from "./ChartView";
import { HeatmapView } from "./HeatmapView";

/** Everything a view might call back into the app shell with. */
export interface ViewHandlers {
  onOpen: (r: RecordRow) => void;
  onToggle: (r: RecordRow, fieldId: string, checked: boolean) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onMove: (r: RecordRow, fieldId: string, value: string) => void;
  /** Single-field inline edit (table cells). */
  onEdit: (r: RecordRow, fieldId: string, value: unknown) => void;
}

/** Renders one non-page view. Shared by AppView (single view) and PageView
 *  (each block). Page views are handled by the caller — never passed here. */
export function ViewBody({
  app,
  view,
  records,
  handlers,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  handlers: ViewHandlers;
}) {
  const { onOpen, onToggle, onCreate, onDelete, onMove, onEdit } = handlers;
  switch (view.type) {
    case "board":
      return (
        <BoardView app={app} view={view} records={records} onOpen={onOpen} onMove={onMove} />
      );
    case "calendar":
      return <CalendarView app={app} view={view} records={records} onOpen={onOpen} />;
    case "gallery":
      return (
        <GalleryView
          app={app}
          view={view}
          records={records}
          onOpen={onOpen}
          onCreate={onCreate}
        />
      );
    case "summary":
      return <SummaryView app={app} view={view} records={records} />;
    case "chart":
      return <ChartView app={app} view={view} records={records} />;
    case "heatmap":
      return <HeatmapView app={app} view={view} records={records} />;
    default:
      return (
        <TableView
          app={app}
          view={view}
          records={records}
          onOpen={onOpen}
          onToggle={onToggle}
          onCreate={onCreate}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      );
  }
}
