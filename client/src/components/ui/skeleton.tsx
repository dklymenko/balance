import { cn } from "@/lib/utils";

// A neutral loading placeholder. Use it wherever data is being fetched so a
// screen never shows a real-looking "$0" / "empty" state before the data
// arrives -- distinguish "loading" from "confirmed empty".
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-secondary", className)}
      {...props}
    />
  );
}
