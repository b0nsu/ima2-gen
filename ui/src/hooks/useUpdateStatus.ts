import { useSyncExternalStore } from "react";
import { subscribe, getSnapshot, getServerSnapshot, dismiss, download, install } from "../lib/updateStore";

const actions = {
  dismiss: () => { void dismiss(); },
  download: () => { void download(); },
  install: () => { void install(); },
};

export function useUpdateStatus() {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { view, ...actions };
}
