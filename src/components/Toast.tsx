// Lightweight toast system. HIG: don't alert on success — show a quiet,
// self-dismissing confirmation; keep errors until acknowledged. Also carries
// the Undo affordance for destructive actions.
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CloseIcon } from "./icons";

type ToastType = "success" | "error" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastOptions {
  type?: ToastType;
  action?: ToastAction;
  /** ms before auto-dismiss; 0 to persist. Defaults by type. */
  duration?: number;
}

const ToastContext = createContext<(message: string, opts?: ToastOptions) => void>(
  () => undefined,
);

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = nextId.current++;
      const type = opts.type ?? "info";
      const duration =
        opts.duration ?? (type === "error" ? 8000 : opts.action ? 6000 : 3200);
      setToasts((ts) => [...ts, { id, message, type, action: opts.action }]);
      if (duration > 0) setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="nk-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`nk-toast is-${t.type}`} role="status">
            <span className="nk-toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="nk-toast-action"
                onClick={() => {
                  t.action!.onClick();
                  remove(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="nk-toast-close"
              aria-label="閉じる"
              onClick={() => remove(t.id)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
