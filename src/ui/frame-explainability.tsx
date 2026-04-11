import type { StoredAttentionFrame } from "../aperture/types.js";
import type { FrameLane } from "../aperture/frame-model.js";
import { explainFrame, signalStrengthLabel } from "../aperture/explainability.js";
import { ATTENTION_CONTEXT_IDS } from "../aperture/attention-context.js";
import {
  ACCENT_BG,
  ACCENT_BORDER,
  ACCENT_COLOR,
  Badge,
  cn,
} from "./chrome.js";
import { judgmentLine, visibleContextItems } from "./frame-helpers.js";

export function ContextItems({ frame }: { frame: StoredAttentionFrame }) {
  const items = visibleContextItems(frame);
  if (items.length === 0) return null;

  return (
    <div className="grid gap-2 md:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "border border-border bg-secondary/50 px-3 py-2",
            item.id === ATTENTION_CONTEXT_IDS.latestComment && "md:col-span-2",
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-sm text-foreground">{item.value ?? "Available"}</div>
        </div>
      ))}
    </div>
  );
}

function ExplainabilityBadges(props: { values: string[]; accent?: boolean }) {
  if (props.values.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.values.map((value) => (
        <Badge
          key={value}
          className={props.accent ? "border-transparent" : "border-border bg-background/70 text-foreground/80"}
          style={props.accent ? { color: ACCENT_COLOR, backgroundColor: ACCENT_BG, borderColor: ACCENT_BORDER } : undefined}
        >
          {value}
        </Badge>
      ))}
    </div>
  );
}

export function InlineExplainability(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
  preferLaneReason?: boolean;
}) {
  const explanation = explainFrame(props.frame, props.lane);
  const chips = [
    ...(explanation.signalStrength ? [signalStrengthLabel(explanation.signalStrength)] : []),
    ...explanation.signals.slice(0, 2),
    ...explanation.relationLabels.slice(0, 1),
  ];
  const label = props.lane === "next" ? "Why next" : props.lane === "ambient" ? "Why ambient" : "Why now";
  const whyNow = explanation.whyNow ?? judgmentLine(props.frame, props.lane);
  const primaryLine = props.lane === "now"
    ? (props.preferLaneReason ? explanation.laneReason : whyNow)
    : whyNow;
  const secondaryLine = props.lane === "now"
    ? (!props.preferLaneReason && whyNow !== explanation.laneReason ? explanation.laneReason : null)
    : explanation.laneReason;

  return (
    <div className="space-y-2 border-l-2 pl-4" style={{ borderColor: ACCENT_COLOR }}>
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-foreground/90">
        {primaryLine}
      </p>
      {secondaryLine ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {secondaryLine}
        </p>
      ) : null}
      {chips.length > 0 ? <ExplainabilityBadges values={chips} accent /> : null}
    </div>
  );
}

export function ExplainabilityPanel(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
  detailOnly?: boolean;
}) {
  const explanation = explainFrame(props.frame, props.lane);
  const strength = !props.detailOnly && explanation.signalStrength ? signalStrengthLabel(explanation.signalStrength) : null;
  const signalValues = props.detailOnly ? explanation.signals.slice(2) : explanation.signals;
  const relationValues = props.detailOnly ? explanation.relationLabels.slice(1) : explanation.relationLabels;
  const reasoningLabel = props.lane === "now" ? "Reasoning" : props.lane === "next" ? "Why it sits here" : "Why it stays quiet";

  if (props.detailOnly && signalValues.length === 0 && relationValues.length === 0 && !explanation.continuity) {
    return null;
  }

  return (
    <div className="space-y-4">
      {!props.detailOnly ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {reasoningLabel}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {explanation.laneReason}
            </p>
          </div>
          {strength ? (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Confidence
              </div>
              <p className="mt-1 text-sm text-foreground/90">{strength}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {signalValues.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {props.detailOnly ? "More signals" : "Signals"}
          </div>
          <ExplainabilityBadges values={signalValues} />
        </div>
      ) : null}
      {relationValues.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {props.detailOnly ? "More thread context" : "Thread context"}
          </div>
          <ExplainabilityBadges values={relationValues} accent />
        </div>
      ) : null}
      {explanation.continuity ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Related activity
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{explanation.continuity}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ExplainabilityStrip(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
}) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <InlineExplainability frame={props.frame} lane={props.lane} />
    </div>
  );
}
