'use client';

/**
 * Settings → Products: list, add, rename, recolour, (de)activate the
 * business lines under the company. Self-fetching so the settings form
 * doesn't need to know about products.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { ProductPublic } from '@/lib/schemas/products';

const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

export function ProductsPanel() {
  const router = useRouter();
  const [items, setItems] = React.useState<ProductPublic[] | null>(null);
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState(PALETTE[0]);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      if (!res.ok) throw new Error('load failed');
      const body = (await res.json()) as { items: ProductPublic[] };
      setItems(body.items);
    } catch {
      toast.error('Could not load products.');
      setItems([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), color, sortOrder: (items?.length ?? 0) + 1 }),
      });
      if (!res.ok) {
        toast.error(await readError(res, 'Could not add product.'));
        return;
      }
      toast.success('Product added.');
      setName('');
      setColor(PALETTE[((items?.length ?? 0) + 1) % PALETTE.length]);
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, data: Record<string, unknown>, okMessage: string) {
    const res = await fetch(`/api/products/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      toast.error(await readError(res, 'Could not update product.'));
      return false;
    }
    toast.success(okMessage);
    await load();
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
        Products are the business lines under the company (e.g. Chitly, Arrows Go). Every
        Finance entry can be tagged with one; employees, bank accounts, cards and salaries
        stay company-level. Use the switcher in the top bar to view one product at a time.
      </div>

      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="product-name">New product</Label>
          <Input
            id="product-name"
            placeholder="Arrows Go"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="product-color">Colour</Label>
          <div className="flex items-center gap-1" id="product-color" role="radiogroup" aria-label="Colour">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                onClick={() => setColor(c)}
                className="h-6 w-6 rounded-full border-2"
                style={{ backgroundColor: c, borderColor: color === c ? '#111827' : 'transparent' }}
              />
            ))}
          </div>
        </div>
        <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          <span>Add</span>
        </Button>
      </form>

      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-full"
                style={{ backgroundColor: p.color ?? '#94a3b8' }}
              />
              <Input
                aria-label={`Name of ${p.name}`}
                className="h-8 max-w-xs"
                value={editing[p.id] ?? p.name}
                onChange={(e) => setEditing((s) => ({ ...s, [p.id]: e.target.value }))}
                onBlur={async () => {
                  const next = (editing[p.id] ?? p.name).trim();
                  if (next && next !== p.name) {
                    await patch(p.id, { name: next }, 'Renamed.');
                  }
                  setEditing((s) => {
                    const { [p.id]: _drop, ...rest } = s;
                    void _drop;
                    return rest;
                  });
                }}
              />
              <span className="font-mono text-xs text-muted-foreground">/{p.slug}</span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                {p.isActive ? 'Active' : 'Inactive'}
                <Switch
                  checked={p.isActive}
                  aria-label={`${p.name} active`}
                  onCheckedChange={(checked) =>
                    patch(p.id, { isActive: checked }, checked ? 'Product activated.' : 'Product deactivated.')
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
