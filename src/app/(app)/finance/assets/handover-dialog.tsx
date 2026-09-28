'use client';

/**
 * Hand an asset to someone, move it, or take it back. The previous holder's
 * row is closed on the chosen date, so the history stays complete.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { AssetStatus } from '@prisma/client';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ASSET_STATUS_LABELS } from '@/lib/assets';

import { requestJson, todayLocalDateKey } from '../finance-ui';
import type { AssetPeopleOption } from './asset-dialog';

const COMPANY = 'company';
const AUTO = 'auto';

export interface HandoverDialogProps {
  assetId: string;
  assetName: string;
  currentHolderName: string;
  people: AssetPeopleOption;
}

export function HandoverDialog({ assetId, assetName, currentHolderName, people }: HandoverDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [holder, setHolder] = React.useState(COMPANY);
  const [date, setDate] = React.useState(todayLocalDateKey());
  const [location, setLocation] = React.useState('');
  const [note, setNote] = React.useState('');
  const [status, setStatus] = React.useState(AUTO);
  const [saving, setSaving] = React.useState(false);

  const reset = () => {
    setHolder(COMPANY);
    setDate(todayLocalDateKey());
    setLocation('');
    setNote('');
    setStatus(AUTO);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [kind, id] = holder.split(':');
    setSaving(true);
    const result = await requestJson(`/api/finance/assets/${assetId}/assign`, {
      method: 'POST',
      json: {
        date,
        ...(kind === 'user' ? { toUserId: id } : {}),
        ...(kind === 'party' ? { toPartyId: id } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(status !== AUTO ? { status } : {}),
      },
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(kind === COMPANY ? `${assetName} is back with the company.` : 'Handed over.');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
          <span>Hand over</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hand over {assetName}</DialogTitle>
          <DialogDescription>
            Now with <span className="font-medium text-foreground">{currentHolderName}</span>. Their
            hand-over closes on the date below and the new one starts.
          </DialogDescription>
        </DialogHeader>

        <form id="handover-form" onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="handover-to">To</Label>
            <Select value={holder} onValueChange={setHolder} disabled={saving}>
              <SelectTrigger id="handover-to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={COMPANY}>Back to the company</SelectItem>
                {people.users.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Team</SelectLabel>
                    {people.users.map((u) => (
                      <SelectItem key={u.id} value={`user:${u.id}`}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {people.parties.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Parties</SelectLabel>
                    {people.parties.map((p) => (
                      <SelectItem key={p.id} value={`party:${p.id}`}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="handover-date">On</Label>
              <Input
                id="handover-date"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="handover-status">Status</Label>
              <Select value={status} onValueChange={setStatus} disabled={saving}>
                <SelectTrigger id="handover-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>Automatic</SelectItem>
                  {Object.values(AssetStatus).map((s) => (
                    <SelectItem key={s} value={s}>
                      {ASSET_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="handover-location">
              Where <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="handover-location"
              placeholder="Office cupboard, their home, service centre…"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={120}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="handover-note">
              Note <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="handover-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              disabled={saving}
            />
          </div>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="handover-form" disabled={saving || !date}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            <span>Save</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
