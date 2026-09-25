"use client";

/**
 * One line chart for both agent P&L and basket NAV.
 *
 * Inline SVG rather than a charting library: this is a path, a baseline and a
 * hover readout — a chart dependency would ship more JavaScript than the rest of
 * the page. Colours come from theme tokens so it inverts with the palette.
 *
 * The line draws itself on mount via stroke-dashoffset, which animates on the
 * compositor rather than by re-rendering React on every frame. Anyone who asked
 * their system not to animate gets the finished line immediately.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface ChartPoint {
  timestamp: number;
  /** Display units — USDC for both NAV and cumulative P&L. */
  value: number;
}

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 180;
const PAD_X = 10;
const PAD_Y = 14;

function formatDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(5, 10);
}

export function PerformanceChart({
  points,
  baseline,
  label,
  valueSuffix = " USDC",
  emptyMessage = "No settled results in this window yet.",
  invalidMessage = "Performance data is unavailable.",
  height = 180,
}: {
  points: ChartPoint[];
  /** The line drawn as "flat": starting NAV, or zero for cumulative P&L. */
  baseline: number;
  label: string;
  valueSuffix?: string;
  emptyMessage?: string;
  invalidMessage?: string;
  height?: number;
}) {
  const gradientId = useId();
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const invalid = !Number.isFinite(baseline) || points.some((point) =>
    !Number.isFinite(point.timestamp) || point.timestamp <= 0 || !Number.isFinite(point.value)
  );

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return setDrawn(true);
    // Next frame, so the dashoffset transition has an initial value to move from.
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, [points.length]);

  const geometry = useMemo(() => {
    if (invalid || points.length === 0) return null;
    const values = points.map((point) => point.value);
    const min = Math.min(baseline, ...values);
    const max = Math.max(baseline, ...values);
    // A flat series would divide by zero; give it a nominal band so it centres.
    const span = max - min || Math.max(1, Math.abs(max) * 0.02);

    const x = (index: number) =>
      PAD_X + (index / Math.max(1, points.length - 1)) * (VIEW_WIDTH - PAD_X * 2);
    const y = (value: number) =>
      VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);

    // A single point has no line; draw a short flat stub so the dot has context.
    const coords = points.map((point, index) => ({ x: x(index), y: y(point.value) }));
    const line = points.length === 1
      ? `M${PAD_X},${coords[0].y} L${VIEW_WIDTH - PAD_X},${coords[0].y}`
      : coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const area = `${line} L${(points.length === 1 ? VIEW_WIDTH - PAD_X : coords.at(-1)!.x).toFixed(1)},${VIEW_HEIGHT - PAD_Y} L${PAD_X},${VIEW_HEIGHT - PAD_Y} Z`;

    return { coords, line, area, baselineY: y(baseline) };
  }, [points, baseline, invalid]);

  if (invalid) {
    return (
      <div
        role="alert"
        className="border border-pv-danger/30 bg-pv-danger/[0.06] px-4 py-12 text-center text-sm text-pv-muted"
      >
        {invalidMessage}
      </div>
    );
  }

  if (!geometry) {
    return (
      <div className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-12 text-center text-sm text-pv-muted">
        {emptyMessage}
      </div>
    );
  }

  const last = points.at(-1)!;
  const up = last.value >= baseline;
  const stroke = up ? "rgb(var(--pv-accent))" : "rgb(var(--pv-danger))";
  const active = hover === null ? points.length - 1 : hover;
  const activePoint = points[active];
  const activeCoord = geometry.coords[active];
  const length = pathRef.current?.getTotalLength?.() ?? 2000;

  return (
    <figure className="border border-pv-ink/[0.1] bg-pv-surface/40 p-3">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        style={{ height }}
        className="w-full touch-none"
        role="img"
        aria-label={`${label}: ${points.length} point${points.length === 1 ? "" : "s"}, ending at ${last.value.toFixed(2)}${valueSuffix}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        <line
          x1={PAD_X} x2={VIEW_WIDTH - PAD_X}
          y1={geometry.baselineY} y2={geometry.baselineY}
          stroke="rgb(var(--pv-ink) / 0.18)" strokeWidth="1" strokeDasharray="3 4"
        />

        <path
          d={geometry.area}
          fill={`url(#${gradientId})`}
          style={{ opacity: drawn ? 1 : 0, transition: "opacity 600ms ease-out 250ms" }}
        />
        <path
          ref={pathRef}
          d={geometry.line}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: length,
            strokeDashoffset: drawn ? 0 : length,
            transition: "stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />

        {/* Hover targets: one invisible column per point, so the pointer never has
            to find a 4px dot. */}
        {points.map((point, index) => (
          <rect
            key={`${point.timestamp}-${index}`}
            x={index === 0 ? 0 : (geometry.coords[index - 1].x + geometry.coords[index].x) / 2}
            y={0}
            width={
              index === points.length - 1
                ? VIEW_WIDTH
                : (geometry.coords[index + 1].x - geometry.coords[index].x) / 2
                  + (index === 0 ? geometry.coords[index].x : (geometry.coords[index].x - geometry.coords[index - 1].x) / 2)
            }
            height={VIEW_HEIGHT}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}

        {hover !== null && (
          <line
            x1={activeCoord.x} x2={activeCoord.x} y1={PAD_Y} y2={VIEW_HEIGHT - PAD_Y}
            stroke="rgb(var(--pv-ink) / 0.2)" strokeWidth="1"
          />
        )}
        <circle
          cx={activeCoord.x}
          cy={activeCoord.y}
          r="4"
          fill={stroke}
          style={{ opacity: drawn ? 1 : 0, transition: "opacity 300ms ease-out 700ms" }}
        />
      </svg>

      <figcaption className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
        <span>{formatDay(points[0].timestamp)}</span>
        <span className="text-pv-text">
          {formatDay(activePoint.timestamp)} · {activePoint.value.toFixed(2)}{valueSuffix}
        </span>
        <span>{formatDay(last.timestamp)}</span>
      </figcaption>
    </figure>
  );
}
