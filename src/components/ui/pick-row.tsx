'use client';

import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** A details row that opens a short menu of choices (owner, status…). */
export function PickRow({
  label,
  value,
  options,
  selected,
  onPick,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  selected: string;
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="hover:bg-muted data-popup-open:bg-muted -mx-2.5 flex min-h-11 w-[calc(100%+1.25rem)] items-center gap-3 rounded-[14px] px-2.5 text-left transition-colors duration-150 ease-out disabled:pointer-events-none"
      >
        <span className="text-muted-foreground w-36 shrink-0 text-[12.5px]">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-sm font-semibold">
          {value}
        </span>
        {!disabled && (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-64">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.id || 'none'}
            onClick={() => o.id !== selected && onPick(o.id)}
          >
            <span className="flex-1 truncate">{o.label}</span>
            {o.id === selected && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
