import { useEffect, type ReactNode } from "react";
import { AnimatePresence, type PanInfo } from "motion/react";
import * as m from "motion/react-m";
import { Logo } from "./visual";

export const pageTransition = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -18 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
};

export function ScreenHeader({
  title,
  back,
  action,
  logo = false,
}: {
  title?: string;
  back?: () => void;
  action?: ReactNode;
  logo?: boolean;
}) {
  return (
    <header className={`header ${logo ? "home-header" : "screen-header"}`}>
      {back ? (
        <m.button
          type="button"
          className="header-control"
          onClick={back}
          whileTap={{ scale: 0.94 }}
          aria-label="Назад"
        >
          ‹
        </m.button>
      ) : (
        <span className="header-spacer" />
      )}
      {logo ? (
        <span className="brand">
          <Logo />
        </span>
      ) : (
        <strong className="header-title" title={title}>
          {title}
        </strong>
      )}
      {action ?? <span className="header-spacer" />}
    </header>
  );
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const finishDrag = (
    _: PointerEvent | MouseEvent | TouchEvent,
    info: PanInfo,
  ) => {
    if (info.offset.y > 80 || info.velocity.y > 500) onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <m.div
          className="sheet-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <m.section
            className={`detail-sheet ${className}`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 42,
              mass: 0.9,
            }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={finishDrag}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <button
              type="button"
              className="sheet-close secondary"
              onClick={onClose}
              aria-label="Закрыть"
            >
              ×
            </button>
            {children}
          </m.section>
        </m.div>
      )}
    </AnimatePresence>
  );
}
