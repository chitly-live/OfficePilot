'use client';

/**
 * EmployeeProfileForm — `react-hook-form` + zod form for
 * `PATCH /api/users/[id]`.
 *
 * The API authorises field-by-field: ADMIN can set every column;
 * EMPLOYEE-self can only set name / phone / designation / avatarUrl /
 * password (per `EMPLOYEE_SELF_EDITABLE_FIELDS` in
 * `src/app/api/users/[id]/route.ts`). We reflect that split client-side
 * by rendering the admin-only fields as disabled inputs for self users
 * — this is purely UX; the server is still the source of truth.
 *
 * Submission flow:
 *   1. Build a partial PATCH body containing only the fields that
 *      changed. The server already accepts partial bodies; sending a
 *      diff keeps the activity log noise low.
 *   2. POST `Content-Type: application/json` to `/api/users/[id]`.
 *   3. On success → toast + `router.refresh()` to re-pull the page
 *      with the new values.
 *   4. On 4xx/5xx → toast the message; preserve form state.
 *
 * Password change is offered as an optional field in the same form;
 * blank means "no change".
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Role } from '@prisma/client';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ALL_EMPLOYEE_MODULES, type ModuleId } from '@/lib/permissions';

// ---------------------------------------------------------------------------
// Schema (mirrors `userUpdateSchema`, optional fields use `''`)
// ---------------------------------------------------------------------------

const formSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .email('Invalid email address'),
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer'),
  role: z.nativeEnum(Role),
  phone: z
    .string()
    .trim()
    .max(32, 'Phone must be 32 characters or fewer')
    .optional()
    .or(z.literal('')),
  designation: z
    .string()
    .trim()
    .max(100, 'Designation must be 100 characters or fewer')
    .optional()
    .or(z.literal('')),
  joinedAt: z
    .string()
    .min(1, 'Joined date is required')
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  avatarUrl: z
    .string()
    .trim()
    .max(2048, 'URL is too long')
    .url('Invalid URL')
    .optional()
    .or(z.literal('')),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be 200 characters or fewer')
    .optional()
    .or(z.literal('')),
  // Per-module access whitelist (FEATURE-A / v0.1.3). Admin-only on the
  // server; non-admin sessions never see this UI control. `[]` means
  // "all modules" (legacy default); a non-empty subset is the explicit
  // whitelist for the EMPLOYEE. Marked `.optional()` rather than
  // `.default([])` to keep the inferred form input/output types
  // consistent (see note on the create-form schema).
  moduleAccess: z
    .array(z.enum(ALL_EMPLOYEE_MODULES as unknown as [string, ...string[]]))
    .optional(),
});

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmployeeProfileFormProps {
  userId: string;
  isAdmin: boolean;
  initialValues: {
    email: string;
    name: string;
    role: Role;
    phone: string | null;
    designation: string | null;
    joinedAt: string; // YYYY-MM-DD
    avatarUrl: string | null;
    /** Per-module access whitelist as stored on `User.moduleAccess`.
     *  `[]` means "all modules" (legacy default; admin rows always
     *  have `[]`). */
    moduleAccess: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 409) return 'Another user already uses that email.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to edit those fields.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

/** Trimmed comparison: '' is treated as "absent"; otherwise direct
 *  string equality on the trimmed values. */
function differsFromInitial(value: string, initial: string | null): boolean {
  const v = value.trim();
  const i = (initial ?? '').trim();
  return v !== i;
}

/** Multiset equality on two module-access arrays. Order doesn't matter
 *  (the UI may emit in any order) but membership does. */
function moduleAccessEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function EmployeeProfileForm({
  userId,
  isAdmin,
  initialValues,
}: EmployeeProfileFormProps) {
  const router = useRouter();
  const [showPassword, setShowPassword] = React.useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: initialValues.email,
      name: initialValues.name,
      role: initialValues.role,
      phone: initialValues.phone ?? '',
      designation: initialValues.designation ?? '',
      joinedAt: initialValues.joinedAt,
      avatarUrl: initialValues.avatarUrl ?? '',
      password: '',
      moduleAccess: initialValues.moduleAccess,
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  // Track the role the admin is selecting so the module-access section
  // hides when promoting to ADMIN (admins always see everything).
  const watchedRole = form.watch('role');

  async function onSubmit(values: FormValues) {
    // Build a diff against initial values so the PATCH body only
    // contains what actually changed. Server returns 400 on empty
    // body so we early-return with a friendly toast.
    const payload: Record<string, unknown> = {};

    if (values.name.trim() !== (initialValues.name ?? '').trim()) {
      payload.name = values.name.trim();
    }

    // Admin-only fields. Even if the disabled inputs somehow change
    // (devtools), the server enforces the same gate, but we do the
    // honest thing on the client too.
    if (isAdmin) {
      if (values.email.trim() !== initialValues.email.trim()) {
        payload.email = values.email.trim();
      }
      if (values.role !== initialValues.role) {
        payload.role = values.role;
      }
      if (values.joinedAt !== initialValues.joinedAt) {
        payload.joinedAt = new Date(
          `${values.joinedAt}T00:00:00.000Z`,
        ).toISOString();
      }
    }

    if (differsFromInitial(values.phone ?? '', initialValues.phone)) {
      const trimmed = (values.phone ?? '').trim();
      // Phone has a regex validator that rejects empty strings, so
      // we send `undefined` when blank — the server treats undefined
      // as "no change" though, which matches what the user wants.
      // To actually clear a phone, the server needs explicit `null`,
      // but `userUpdateSchema` doesn't accept `null` either (it's
      // string-only). Practical compromise: blank string in the form
      // means "leave as-is" rather than "clear". Documented here.
      if (trimmed !== '') {
        payload.phone = trimmed;
      }
    }
    if (
      differsFromInitial(values.designation ?? '', initialValues.designation)
    ) {
      const trimmed = (values.designation ?? '').trim();
      if (trimmed !== '') {
        payload.designation = trimmed;
      }
    }
    if (differsFromInitial(values.avatarUrl ?? '', initialValues.avatarUrl)) {
      const trimmed = (values.avatarUrl ?? '').trim();
      if (trimmed !== '') {
        payload.avatarUrl = trimmed;
      }
    }

    if (values.password && values.password.length > 0) {
      payload.password = values.password;
    }

    // moduleAccess is admin-only. We compare as a multiset because the
    // checkbox order may not match the stored order. The server further
    // normalises (admin role → []) so we can send the raw form value
    // verbatim.
    if (isAdmin) {
      const next = (values.moduleAccess ?? []) as string[];
      if (!moduleAccessEqual(next, initialValues.moduleAccess)) {
        payload.moduleAccess = next;
      }
    }

    if (Object.keys(payload).length === 0) {
      toast.info('No changes to save.');
      return;
    }

    let res: Response;
    try {
      res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    if (!res.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      toast.error(describeError(body, res.status));
      return;
    }

    toast.success('Profile updated.');
    // Reset just the password field so the next submit doesn't
    // accidentally re-send it; other fields stay in sync via
    // `router.refresh()`.
    form.setValue('password', '');
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-5"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="name"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    disabled={isSubmitting || !isAdmin}
                    {...field}
                  />
                </FormControl>
                {!isAdmin ? (
                  <FormDescription>Admin-only.</FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Role</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isSubmitting || !isAdmin}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={Role.EMPLOYEE}>Employee</SelectItem>
                    <SelectItem value={Role.ADMIN}>Admin</SelectItem>
                  </SelectContent>
                </Select>
                {!isAdmin ? (
                  <FormDescription>Admin-only.</FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="joinedAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Joined</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    disabled={isSubmitting || !isAdmin}
                    {...field}
                  />
                </FormControl>
                {!isAdmin ? (
                  <FormDescription>Admin-only.</FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Phone <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    autoComplete="tel"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="designation"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Designation{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input disabled={isSubmitting} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="avatarUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Avatar URL{' '}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input
                  type="url"
                  autoComplete="off"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/*
          Module access picker (FEATURE-A / v0.1.3). Admin-only.
          When the (admin-only) role select sits at ADMIN we render a
          disabled "All modules" note instead — admins always see every
          module regardless of this column, and the server normalises
          moduleAccess to `[]` on persist when role === ADMIN. Hidden
          entirely for non-admin sessions (self-edit can't reach here).
        */}
        {isAdmin ? (
          watchedRole === Role.ADMIN ? (
            <div
              role="note"
              className="rounded-md border border-dashed border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
            >
              <span className="font-medium text-foreground">Module access:</span>{' '}
              All modules (admins see everything).
            </div>
          ) : (
            <FormField
              control={form.control}
              name="moduleAccess"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Module access</FormLabel>
                  <FormDescription>
                    Choose which sections this employee can see. Leave all
                    unchecked to grant full access (legacy default).
                  </FormDescription>
                  <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
                    {ALL_EMPLOYEE_MODULES.map((mod) => {
                      const value: ModuleId[] =
                        (field.value as ModuleId[] | undefined) ?? [];
                      const checked = value.includes(mod);
                      return (
                        <label
                          key={mod}
                          className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent/40"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={isSubmitting}
                            onCheckedChange={(state) => {
                              const isOn = state === true;
                              if (isOn) {
                                field.onChange([...value, mod]);
                              } else {
                                field.onChange(
                                  value.filter((m) => m !== mod),
                                );
                              }
                            }}
                          />
                          <span className="capitalize">{mod}</span>
                        </label>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          )
        ) : null}

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                New password{' '}
                <span className="text-muted-foreground">
                  (optional — leave blank to keep)
                </span>
              </FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Min. 8 characters"
                    disabled={isSubmitting}
                    className="pr-10"
                    {...field}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={
                      showPassword ? 'Hide password' : 'Show password'
                    }
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span>Saving…</span>
              </>
            ) : (
              'Save changes'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
