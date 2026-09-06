'use client';

/**
 * Header product switcher. Writes the chosen scope to the `op_product`
 * cookie and refreshes the server components, which read it via
 * `getProductContext()`. Scopes: all products · company-level · one product.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Layers } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PRODUCT_COOKIE, SCOPE_ALL, SCOPE_COMPANY, type ProductOption } from '@/lib/products';
import { cn } from '@/lib/utils';

export interface ProductSwitcherProps {
  products: ProductOption[];
  /** `'all'`, `'company'` or a product slug. */
  current: string;
  companyShort: string;
}

function Dot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color ?? '#94a3b8' }}
    />
  );
}

export function ProductSwitcher({ products, current, companyShort }: ProductSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const active = products.find((p) => p.slug === current);
  const label =
    current === SCOPE_COMPANY
      ? `${companyShort} · company`
      : active
        ? active.name
        : `${companyShort} · all`;

  function choose(value: string) {
    document.cookie = `${PRODUCT_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('max-w-[12rem] gap-2', pending && 'opacity-70')}
          aria-label="Switch product"
        >
          {active ? <Dot color={active.color} /> : <Layers className="h-4 w-4" aria-hidden="true" />}
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Viewing</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => choose(SCOPE_ALL)} className="gap-2">
          <Layers className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1">{companyShort} · all products</span>
          {current === SCOPE_ALL || (!active && current !== SCOPE_COMPANY) ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => choose(SCOPE_COMPANY)} className="gap-2">
          <Dot color="#94a3b8" />
          <span className="flex-1">{companyShort} · company-level only</span>
          {current === SCOPE_COMPANY ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
        </DropdownMenuItem>
        {products.length > 0 ? <DropdownMenuSeparator /> : null}
        {products.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => choose(p.slug)} className="gap-2">
            <Dot color={p.color} />
            <span className="flex-1 truncate">{p.name}</span>
            {current === p.slug ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
        {products.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No products yet. Add them in Settings → Products.
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
