import { Suspense } from "react";
import DashboardPageClient from "./DashboardPageClient";
import { DashboardPanelSkeleton } from "@/components/ui/AsyncPanelSkeleton";

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardPanelSkeleton />}>
      <DashboardPageClient />
    </Suspense>
  );
}
