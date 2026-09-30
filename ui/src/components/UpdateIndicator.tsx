import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { useUpdateStatus } from "../hooks/useUpdateStatus";
import { useI18n } from "../i18n";
import type { UpdateView } from "../lib/updateStatus";
import { useAppStore } from "../store/useAppStore";

type VisibleUpdate = Exclude<UpdateView, { kind: "hidden" }>;

function IconUpdate() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16V8m-4 4 4-4 4 4" />
    </svg>
  );
}

function updateLabel(view: VisibleUpdate, t: ReturnType<typeof useI18n>["t"]): string {
  const key = view.kind === "npm" ? "available" : {
    available: "download", downloading: "downloading", downloaded: "ready", error: "retry",
  }[view.phase];
  return t(`update.${key}`, { version: view.version, progress: view.kind === "desktop" ? view.progress ?? 0 : 0 });
}

function usePopoverDismiss(open: boolean, root: RefObject<HTMLSpanElement | null>, button: RefObject<HTMLButtonElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, root, button, close]);
}

function UpdatePopover({ view, id, dismiss }: { view: Extract<UpdateView, { kind: "npm" }>; id: string; dismiss: () => void }) {
  const { t } = useI18n();
  const copyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { copyButton.current?.focus(); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.command);
      useAppStore.getState().showToast(t("update.copied"), false);
    } catch (error) { console.warn("[update] copy failed", error); }
  };
  return (
    <div id={id} className="update-popover" role="dialog" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t("update.popoverTitle", { version: view.version })}</h2>
      <p>{t("update.runCommand")}</p>
      <code>{view.command}</code>
      <div className="update-popover__actions">
        <button type="button" ref={copyButton} onClick={() => { void copy(); }}>{t("update.copy")}</button>
        {view.releaseUrl ? <a href={view.releaseUrl} target="_blank" rel="noopener noreferrer">{t("update.whatsNew")}</a> : null}
        <button type="button" onClick={dismiss}>{t("update.dismiss")}</button>
      </div>
    </div>
  );
}

export function UpdateIndicator({ variant = "strip", trailing = false, top }: { variant?: "strip" | "floating"; trailing?: boolean; top?: number }) {
  const { view, dismiss, download, install } = useUpdateStatus();
  const { t } = useI18n();
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const close = useCallback(() => setOpenVersion(null), []);
  const open = view.kind === "npm" && openVersion === view.version;
  usePopoverDismiss(open, root, button, close);
  if (view.kind === "hidden") return null;
  const label = updateLabel(view, t);
  const downloading = view.kind === "desktop" && view.phase === "downloading";
  const onClick = () => {
    if (view.kind === "npm") setOpenVersion(open ? null : view.version);
    else if (view.phase === "downloaded") install();
    else if (!downloading) download();
  };
  const trailingClass = trailing ? " sidebar-top__btn--trailing" : "";
  return (
    <span ref={root} className={`update-indicator-anchor update-indicator-anchor--${variant}${trailingClass}`} style={variant === "floating" ? { top } : undefined}>
      <button type="button" ref={button} className={`sidebar-top__btn update-indicator update-indicator--${variant}${trailingClass}`}
        aria-label={label} title={label} aria-disabled={downloading || undefined} onClick={onClick}
        aria-haspopup={view.kind === "npm" ? "dialog" : undefined}
        aria-expanded={view.kind === "npm" ? open : undefined} aria-controls={open ? id : undefined}>
        <IconUpdate /><span className="update-indicator__dot" aria-hidden="true" />
        {variant === "floating" ? <span aria-hidden="true">{downloading ? `${view.progress ?? 0}%` : `v${view.version}`}</span> : null}
      </button>
      {open && view.kind === "npm" ? <UpdatePopover view={view} id={id} dismiss={dismiss} /> : null}
    </span>
  );
}
