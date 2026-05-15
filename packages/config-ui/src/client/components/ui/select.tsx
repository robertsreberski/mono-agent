import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight native-select primitive styled to match the shadcn input
 * field. The standalone design-system uses a radix Popper combobox; the
 * config form only needs short enum lists (sdk/cli, none/low/.../max),
 * so a styled native select gives the same visual outcome with zero
 * additional Popper / portal cost.
 */
export interface SelectProps extends React.ComponentProps<"select"> {
  readonly placeholder?: string;
}

export function Select({
  className,
  children,
  placeholder,
  value,
  ...props
}: SelectProps): React.JSX.Element {
  return (
    <div className="relative">
      <select
        data-slot="select"
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 pr-8 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        value={value}
        {...props}
      >
        {placeholder !== undefined ? (
          <option value="">{placeholder}</option>
        ) : null}
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}

function ChevronDown({
  className,
  "aria-hidden": ariaHidden,
}: {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={ariaHidden}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
