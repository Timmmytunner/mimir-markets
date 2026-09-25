/**
 * Loading skeletons for async panels (dashboard, explorer, council, market).
 * Layout-stable placeholders — no wallet addresses, amounts, or analytics fields.
 */

interface AsyncPanelSkeletonProps {
  className?: string;
  /** Accessible label; never include addresses or balances. */
  label?: string;
}

function ShimmerBlock({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg bg-pv-ink/[0.08] motion-safe:animate-pulse motion-reduce:animate-none motion-reduce:opacity-90 ${className}`}
      aria-hidden
    />
  );
}

/** Generic async panel shell used by route fallbacks and inline widgets. */
export function AsyncPanelSkeleton({
  className = "",
  label = "Loading panel",
}: AsyncPanelSkeletonProps) {
  return (
    <div
      className={`rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 ${className}`}
      aria-busy
      aria-label={label}
      role="status"
    >
      <span className="sr-only">{label}</span>
      <ShimmerBlock className="mb-4 h-3 w-28" />
      <ShimmerBlock className="mb-2 h-5 w-full" />
      <ShimmerBlock className="mb-4 h-5 w-3/4" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <ShimmerBlock className="h-12" />
        <ShimmerBlock className="h-12" />
        <ShimmerBlock className="h-12 col-span-2 sm:col-span-1" />
      </div>
    </div>
  );
}

/** Council verdict / persona grid placeholder (matches CouncilVoteWidget). */
export function CouncilPanelSkeleton({
  className = "",
  rows = 6,
}: {
  className?: string;
  rows?: number;
}) {
  return (
    <section
      className={`rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 lg:min-h-[20rem] ${className}`}
      aria-busy
      aria-label="Loading council panel"
      role="status"
    >
      <span className="sr-only">Loading council panel</span>
      <ShimmerBlock className="h-3 w-32" />
      <ShimmerBlock className="mt-2 h-4 w-2/3" />
      <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {Array.from({ length: rows }).map((_, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-2 rounded-lg border border-pv-border/30 bg-pv-surface2/20 px-2.5 py-1.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <ShimmerBlock className="size-7 shrink-0 rounded-full" />
              <ShimmerBlock className="h-3 w-24" />
            </div>
            <ShimmerBlock className="h-3 w-16" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Market / VS page primary loading surface (replaces spinner-only state). */
export function MarketPanelSkeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`mx-auto max-w-3xl space-y-6 px-4 py-12 ${className}`}
      aria-busy
      aria-label="Loading market panel"
      role="status"
    >
      <span className="sr-only">Loading market panel</span>
      <ShimmerBlock className="mx-auto h-8 w-48" />
      <ShimmerBlock className="mx-auto h-4 w-72 max-w-full" />
      <div className="card space-y-4 p-6">
        <ShimmerBlock className="h-6 w-full" />
        <ShimmerBlock className="h-6 w-5/6" />
        <div className="grid grid-cols-2 gap-3 pt-2">
          <ShimmerBlock className="h-24" />
          <ShimmerBlock className="h-24" />
        </div>
        <ShimmerBlock className="h-11 w-full" />
      </div>
      <AsyncPanelSkeleton label="Loading market side panel" />
    </div>
  );
}

/** Compact rivalry / series list placeholder on the market page. */
export function RivalryPanelSkeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-xl border border-pv-ink/[0.08] bg-pv-bg/30 p-4 sm:p-5 ${className}`}
      aria-busy
      aria-label="Loading rivalry panel"
      role="status"
    >
      <span className="sr-only">Loading rivalry panel</span>
      <div className="space-y-3">
        <ShimmerBlock className="h-14 w-full" />
        <ShimmerBlock className="h-14 w-full" />
        <ShimmerBlock className="h-14 w-5/6" />
      </div>
    </div>
  );
}

/** Dashboard async strip used by route loading.tsx / Suspense fallbacks. */
export function DashboardPanelSkeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`space-y-8 py-6 ${className}`}
      aria-busy
      aria-label="Loading dashboard"
      role="status"
    >
      <span className="sr-only">Loading dashboard</span>
      <div className="space-y-4">
        <ShimmerBlock className="h-10 w-48 sm:h-12 sm:w-56" />
        <ShimmerBlock className="h-4 max-w-md" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <ShimmerBlock key={i} className="min-h-[5.75rem] sm:min-h-[6.25rem]" />
        ))}
      </div>
      <ShimmerBlock className="h-40 w-full" />
      <div className="space-y-3">
        <ShimmerBlock className="h-16 w-full" />
        <ShimmerBlock className="h-16 w-full" />
        <ShimmerBlock className="h-16 w-full" />
      </div>
    </div>
  );
}

/** Explorer grid placeholder aligned with ArenaCardSkeleton density. */
export function ExplorerPanelSkeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`space-y-6 px-4 py-8 sm:px-6 lg:px-8 ${className}`}
      aria-busy
      aria-label="Loading explorer"
      role="status"
    >
      <span className="sr-only">Loading explorer</span>
      <ShimmerBlock className="h-8 w-40" />
      <ShimmerBlock className="h-10 w-full max-w-2xl sm:h-12" />
      <ShimmerBlock className="h-11 w-full max-w-2xl" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="card relative flex h-52 flex-col gap-4 overflow-hidden border-pv-ink/[0.12] bg-pv-surface p-6"
          >
            <div className="flex justify-between">
              <ShimmerBlock className="h-6 w-20" />
              <ShimmerBlock className="h-6 w-24" />
            </div>
            <ShimmerBlock className="h-7 w-full" />
            <ShimmerBlock className="h-7 w-[85%]" />
            <ShimmerBlock className="mt-auto h-9 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default AsyncPanelSkeleton;
