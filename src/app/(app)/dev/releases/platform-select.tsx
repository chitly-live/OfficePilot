'use client';

/**
 * PlatformSelect — single-select dropdown that pushes
 * `?platform=` to the URL on change, used on `/dev/releases`.
 *
 * Client island so we can use `useRouter()` + `useSearchParams()` for
 * URL-driven filter state; the parent server page reads the resolved
 * value back from `searchParams`.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PLATFORM_ALL = '__all__';

export interface PlatformSelectProps {
  /** Current platform filter (empty string = all). */
  currentPlatform: string;
  /** Distinct platform options sourced from the DB + canonical list. */
  platformOptions: string[];
}

export function PlatformSelect({
  currentPlatform,
  platformOptions,
}: PlatformSelectProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleChange = (value: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (value === PLATFORM_ALL) {
      params.delete('platform');
    } else {
      params.set('platform', value);
    }
    const qs = params.toString();
    router.replace(qs ? `/dev/releases?${qs}` : '/dev/releases', {
      scroll: false,
    });
  };

  const value = currentPlatform === '' ? PLATFORM_ALL : currentPlatform;

  return (
    <div className="flex flex-col gap-1 sm:max-w-xs">
      <Label htmlFor="releases-platform" className="text-xs">
        Platform
      </Label>
      <Select value={value} onValueChange={handleChange}>
        <SelectTrigger id="releases-platform" className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PLATFORM_ALL}>All platforms</SelectItem>
          {platformOptions.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
