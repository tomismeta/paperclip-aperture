import { useEffect, useRef, useState, type ReactNode } from "react";

// Uses inline styles because the host Tailwind JIT won't scan plugin bundles
// for arbitrary values.
export const ACCENT_COLOR = "#007ACC";
export const ACCENT_BG = `${ACCENT_COLOR}14`;
export const ACCENT_BORDER = `${ACCENT_COLOR}33`;
export const ACCENT_BG_STYLE: React.CSSProperties = { backgroundColor: ACCENT_COLOR };

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function useAccentColor<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.style.setProperty("color", ACCENT_COLOR, "important");
  });
  return ref;
}

export function Accent({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useAccentColor<HTMLSpanElement>();
  return <span ref={ref} className={className}>{children}</span>;
}

export function QuietMark({ size = "sm" }: { size?: "sm" | "md" }) {
  const dimension = size === "md" ? 10 : 8;
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full border"
      style={{ width: dimension, height: dimension, borderColor: ACCENT_BORDER }}
    />
  );
}

export function useWideLayout(minWidth = 1024) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia(`(min-width: ${minWidth}px)`);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [minWidth]);

  return matches;
}

export function UnreadDot(props: { visible: boolean; tone?: "default" | "muted"; reserveSpace?: boolean }) {
  const tone = props.tone ?? "default";
  if (!props.visible && !props.reserveSpace) return null;

  const style = props.visible
    ? tone === "muted"
      ? { backgroundColor: ACCENT_BORDER }
      : ACCENT_BG_STYLE
    : { backgroundColor: "transparent" };

  return <span className="inline-block h-2 w-2 rounded-full shrink-0" style={style} aria-label={props.visible ? "Unread attention item" : undefined} />;
}

export function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
      <path d="M8.5 1.5h6v6" />
      <path d="M14.5 1.5l-7 7" />
    </svg>
  );
}

function SkeletonLine(props: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-secondary/80", props.className)} aria-hidden="true" />;
}

export function MessageCard(props: {
  title: string;
  body: string;
  accent?: boolean;
}) {
  return (
    <div className="border border-border bg-card p-4 shadow-sm">
      <div className={cn("text-sm font-medium", props.accent && "text-foreground")}>
        {props.title}
      </div>
      <div className="mt-1 text-sm text-muted-foreground">{props.body}</div>
    </div>
  );
}

export function WidgetLoadingState({ label }: { label: string }) {
  return (
    <div className="border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <SkeletonLine className="mt-0.5 h-3 w-3 rounded-full" />
        <div className="flex-1 space-y-2">
          <SkeletonLine className="h-3 w-20" />
          <SkeletonLine className="h-4 w-48" />
        </div>
        <SkeletonLine className="h-3 w-24" />
      </div>
      <div className="sr-only">{label}</div>
    </div>
  );
}

export function PageLoadingState({ label }: { label: string }) {
  return (
    <div className="space-y-5" aria-label={label}>
      <div className="border border-border bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <SkeletonLine className="h-4 w-44" />
          <SkeletonLine className="h-8 w-28" />
        </div>
      </div>
      <div className="border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <SkeletonLine className="h-4 w-36" />
        </div>
        <div className="space-y-4 px-4 py-5 sm:px-6">
          <SkeletonLine className="h-3 w-16" />
          <SkeletonLine className="h-7 w-2/3" />
          <div className="flex gap-2">
            <SkeletonLine className="h-6 w-24" />
            <SkeletonLine className="h-6 w-20" />
            <SkeletonLine className="h-6 w-16" />
          </div>
          <SkeletonLine className="h-10 w-56" />
        </div>
      </div>
      <div className="border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <SkeletonLine className="h-3 w-12" />
        </div>
        <div className="space-y-3 px-4 py-4 sm:px-6">
          <SkeletonLine className="h-4 w-full" />
          <SkeletonLine className="h-4 w-5/6" />
          <SkeletonLine className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

export function StatusToast({ message }: { message: string | null }) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 transition-all duration-200",
        message ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
      aria-live="polite"
      aria-atomic="true"
    >
      {message ? (
        <div className="min-w-72 max-w-md rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {message}
        </div>
      ) : null}
    </div>
  );
}

export function Badge(props: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        props.className,
      )}
      style={props.style}
    >
      {props.children}
    </span>
  );
}

export function ActionButton(props: {
  label: string;
  tone: "primary" | "danger" | "secondary" | "accent";
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const toneClass =
    props.tone === "primary"
      ? "bg-green-700 text-white hover:bg-green-600"
      : props.tone === "accent"
        ? "text-white"
      : props.tone === "danger"
        ? "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
        : "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50";

  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={props.disabled}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium",
        "transition-[color,background-color,border-color,box-shadow,opacity,filter]",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:pointer-events-none disabled:opacity-50",
        props.disabled && /…|\.\.\./.test(props.label) && "animate-pulse",
        toneClass,
        props.className,
      )}
      style={props.tone === "accent" ? { ...ACCENT_BG_STYLE, filter: hovered && !props.disabled ? "brightness(1.08)" : undefined } : undefined}
    >
      {props.label}
    </button>
  );
}

export function QueueMovementBadge({ movement }: { movement?: "up" | "down" }) {
  if (!movement) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: ACCENT_COLOR,
        backgroundColor: ACCENT_BG,
        borderColor: ACCENT_BORDER,
      }}
    >
      <span aria-hidden="true">{movement === "up" ? "\u2191" : "\u2193"}</span>
      {movement === "up" ? "moved up" : "moved down"}
    </span>
  );
}
