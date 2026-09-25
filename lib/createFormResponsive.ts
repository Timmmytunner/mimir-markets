/**
 * Responsive layout tokens for /vs/create (market creation).
 * Keeps claim-creation forms usable on narrow viewports without changing
 * chain-as-source-of-truth or wallet/signing behavior.
 */

/** Tailwind grid for stake presets (4 amounts) + custom amount cell. */
export const CREATE_STAKE_PRESET_GRID_CLASS =
  "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5";

/**
 * On the narrowest breakpoint the custom stake field spans both columns so
 * the numeric input stays tappable; from `sm` it sits in a single cell.
 */
export const CREATE_STAKE_CUSTOM_CELL_CLASS =
  "col-span-2 sm:col-span-1 min-h-[2.75rem] w-full min-w-0";

/** Page shell: room for the mobile sticky create CTA. */
export const CREATE_PAGE_SHELL_CLASS =
  "mx-auto w-full max-w-[1280px] px-4 pb-28 sm:px-6 sm:pb-12 lg:pb-12";

/** Fixed bottom create/connect bar — mobile only. */
export const CREATE_MOBILE_CTA_BAR_CLASS =
  "fixed inset-x-0 bottom-0 z-40 border-t border-pv-ink/[0.12] bg-pv-bg/95 px-4 py-3 backdrop-blur-md lg:hidden";

/** Desktop aside CTA — hidden on mobile (served by sticky bar). */
export const CREATE_DESKTOP_CTA_WRAP_CLASS = "hidden lg:block";

/** Challenge ticket: tighter padding and smaller watermark on phones. */
export const CREATE_TICKET_SHELL_CLASS =
  "relative overflow-hidden rounded-2xl border border-pv-ink/[0.12] bg-pv-surface/70 shadow-glow-emerald backdrop-blur-[20px] transition-all duration-200";

export const CREATE_TICKET_BODY_CLASS = "space-y-6 p-4 sm:space-y-8 sm:p-6 md:p-8";

export const CREATE_TICKET_WATERMARK_CLASS =
  "font-display text-[48px] font-bold uppercase tracking-[0.15em] text-pv-ink/[0.02] rotate-[-12deg] sm:text-[72px] md:text-[96px]";

export const CREATE_TICKET_META_GRID_CLASS =
  "grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-2 sm:gap-y-4";

/** Minimum touch target (px) for primary create controls on touch devices. */
export const CREATE_TOUCH_TARGET_MIN_PX = 44;

export type CreateViewportBucket = "mobile" | "tablet" | "desktop";

/**
 * Classify a CSS viewport width into the buckets used by create-form layout.
 * Boundary: mobile < 640, tablet < 1024, else desktop (matches Tailwind sm/lg).
 */
export function createViewportBucket(widthPx: number): CreateViewportBucket {
  if (!Number.isFinite(widthPx) || widthPx < 0) {
    return "mobile";
  }
  if (widthPx < 640) return "mobile";
  if (widthPx < 1024) return "tablet";
  return "desktop";
}

/**
 * Whether the sticky mobile CTA bar should render for this viewport.
 * Desktop keeps the aside CTA only (no duplicate actions).
 */
export function shouldShowMobileCreateCta(widthPx: number): boolean {
  return createViewportBucket(widthPx) !== "desktop";
}

/**
 * Stake preset column count for the active bucket (mirrors the Tailwind grid).
 * Custom amount is an extra cell beyond presets.
 */
export function stakePresetColumnsForViewport(widthPx: number): 2 | 3 | 5 {
  const bucket = createViewportBucket(widthPx);
  if (bucket === "mobile") return 2;
  if (bucket === "tablet") return 3;
  return 5;
}

/**
 * Safe bottom padding (px) so the last form field clears the sticky CTA.
 */
export function createPageBottomPaddingPx(widthPx: number): number {
  return shouldShowMobileCreateCta(widthPx) ? 112 : 48;
}
