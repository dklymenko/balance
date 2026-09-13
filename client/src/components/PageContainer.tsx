import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared page-width wrapper. Keeps content in a comfortable centered column on
// desktop instead of stretching edge-to-edge or sitting in an over-narrow ribbon.
// Mobile (unprefixed): full width with 16px gutters -- unchanged from before.
// Pass a `className` (e.g. a different max-w-*) to override the default width.
export default function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>
      {children}
    </div>
  );
}
