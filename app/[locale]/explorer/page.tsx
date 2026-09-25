import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import ExploreClient from "./ExploreClient";
import { ExplorerPanelSkeleton } from "@/components/ui/AsyncPanelSkeleton";

type ExplorePageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({
  params,
}: ExplorePageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "explore" });
  const tMeta = await getTranslations({ locale, namespace: "metadata" });
  const siteLine = tMeta("title");
  const brand = siteLine.split("—")[0]?.trim() ?? "Mimir";
  const pageTitle = `${t("title")} · ${brand}`;
  return {
    title: pageTitle,
    description: t("subtitle"),
    openGraph: {
      title: pageTitle,
      description: t("subtitle"),
    },
  };
}

export default function ExplorePage() {
  return (
    <Suspense fallback={<ExploreLoading />}>
      <ExploreClient />
    </Suspense>
  );
}
function ExploreLoading() {
  return <ExplorerPanelSkeleton />;
}

