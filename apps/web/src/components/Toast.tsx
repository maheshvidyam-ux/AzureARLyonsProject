import { useCallback, useRef, useState } from "react";

export interface ToastState {
  msg: string;
  seq: number;
}
export type Notify = (msg: string) => void;

export function useToast(): { toast: ToastState | null; notify: Notify } {
  const [toast, setToast] = useState<ToastState | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const notify = useCallback((msg: string) => {
    setToast({ msg, seq: ++seq.current });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2800);
  }, []);
  return { toast, notify };
}

export function ToastHost({ toast }: { toast: ToastState | null }): JSX.Element {
  // keyed on seq so re-raising the same message re-triggers the show animation
  return (
    <div className={`toast${toast ? " show" : ""}`} key={toast?.seq} role="status" aria-live="polite">
      {toast?.msg}
    </div>
  );
}
