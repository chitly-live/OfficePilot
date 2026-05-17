'use client';

/**
 * `<GenerateActionsButton />` — client component for the "Generate now"
 * trigger on `/ai/actions`. POSTs to `/api/ai/actions` and refreshes
 * the server-rendered list when fresh actions land.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export function GenerateActionsButton() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const generate = async () => {
    setPending(true);
    try {
      const res = await fetch('/api/ai/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { items?: unknown[] };
      const count = Array.isArray(body.items) ? body.items.length : 0;
      toast.success(`Generated ${count} action${count === 1 ? '' : 's'}`);
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't generate: ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Button onClick={generate} disabled={pending}>
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
      <span className="ml-2">Generate now</span>
    </Button>
  );
}
