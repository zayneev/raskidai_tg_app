export function listenForSafeRefresh(options: {
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  isOnline: () => boolean;
  isVisible: () => boolean;
  onOnlineChange: (online: boolean) => void;
  onRefresh: () => void;
}) {
  const network = () => {
    const current = options.isOnline();
    options.onOnlineChange(current);
    if (current && options.isVisible()) options.onRefresh();
  };
  const visibility = () => {
    if (options.isVisible() && options.isOnline()) options.onRefresh();
  };
  options.windowTarget.addEventListener("online", network);
  options.windowTarget.addEventListener("offline", network);
  options.documentTarget.addEventListener("visibilitychange", visibility);
  return () => {
    options.windowTarget.removeEventListener("online", network);
    options.windowTarget.removeEventListener("offline", network);
    options.documentTarget.removeEventListener("visibilitychange", visibility);
  };
}
