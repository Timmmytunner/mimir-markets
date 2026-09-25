import { CouncilPanelSkeleton } from "@/components/ui/AsyncPanelSkeleton";

export default function CouncilLoading() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-6 px-4 py-10 sm:px-6 lg:px-8">
      <div
        className="mx-auto h-8 w-72 max-w-full rounded-lg bg-pv-ink/[0.08] motion-safe:animate-pulse motion-reduce:animate-none"
        aria-hidden
      />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <CouncilPanelSkeleton rows={4} />
        <CouncilPanelSkeleton rows={4} className="hidden md:block" />
        <CouncilPanelSkeleton rows={4} className="hidden lg:block" />
        <CouncilPanelSkeleton rows={4} className="hidden xl:block" />
      </div>
    </div>
  );
}
