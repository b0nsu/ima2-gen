import { useEffect, useLayoutEffect, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useUpdateStatus } from "../hooks/useUpdateStatus";
import { t } from "../i18n";
import { claimUpdateNotice } from "../lib/updateStore";
import { useAppStore } from "../store/useAppStore";
import { UpdateIndicator } from "./UpdateIndicator";

let noticeShown = false;

/** Clear the existing mobile bar without changing its layout or controls. */
function useFloatingUpdateTop(isMobile: boolean, settingsOpen: boolean, uiMode: string): number | undefined {
  const [top, setTop] = useState<number>();
  useLayoutEffect(() => {
    const bar = isMobile && !settingsOpen ? document.querySelector(".mobile-app-bar") : null;
    if (!bar) { setTop(undefined); return; }
    const measure = () => setTop(bar.getBoundingClientRect().bottom + 10);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [isMobile, settingsOpen, uiMode]);
  return top;
}

export function UpdateNoticeHost() {
  useUpdateStatus();
  const isMobile = useIsMobile();
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const uiMode = useAppStore((state) => state.uiMode);
  const top = useFloatingUpdateTop(isMobile, settingsOpen, uiMode);
  useEffect(() => {
    let alive = true;
    void claimUpdateNotice().then((version) => {
      if (!alive || !version || noticeShown) return;
      noticeShown = true;
      useAppStore.getState().showToast(t("update.updatedTo", { version }), false);
    });
    return () => { alive = false; };
  }, []);
  return isMobile && !settingsOpen ? <UpdateIndicator variant="floating" top={top} /> : null;
}
