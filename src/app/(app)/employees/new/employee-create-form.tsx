'use client';

/**
 * EmployeeCreateForm — `react-hook-form` + zod form for `POST /api/users`.
 *
 * Mirrors the API's `userCreateSchema` so client and server validate
 * the same shape. On submit:
 *   1. Posts JSON to `/api/users` (admin-only on the server side).
 *   2. On success → redirect to `/employees/[id]`.
 *   3. On 4xx/5xx → toast the error and stay on the form.
 *
 * The form has a "generate password" affordance per SPEC §5.2 #2
 * ("password (auto-generate option)"). The generated value is stored
 * in plaintext in the form state so the admin can copy it before
 * submitting; it is NEVER echoed back from the server (the API
 * returns the public projection without `passwordHash`).
 *
 * Field-level notes:
 *   • `joinedAt` is a date input — easy to drive without a popover
 *     calendar dependency, and matches the `@db.Date` storage
 *     granularity.
 *   • `role` defaults to `EMPLOYEE` per `userCreateSchema`.
 *   • Optional fields (`phone`, `designation`, `avatarUrl`) are
 *     submitted as `undefined` when blank so the server applies its
 *     own defaults (NULL columns).
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
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
// Schema (client-side mirror of `userCreateSchema`)
// ---------------------------------------------------------------------------

/**
 * Form-side schema. Kept in sync with `userCreateSchema` in
 * `src/lib/schemas/users.ts` but slightly relaxed for UX:
 *   • Strings stay as strings (no coercion to Date here — we send
 *     a YYYY-MM-DD string, and the API's `z.coerce.date()` parses
 *     it on the way in).
 *   • Optional fields use `''` to mean "absent", which we strip on
 *     submit before posting.
 */
const formSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be 200 characters or fewer'),
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
    // YYYY-MM-DD from the native date input.
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  avatarUrl: z
    .string()
    .trim()
    .max(2048, 'URL is too long')
    .url('Invalid URL')
    .optional()
    .or(z.literal('')),
  // Per-module access whitelist (FEATURE-A / v0.1.3). Empty array means
  // "all modules" per the legacy/back-compat default; admins ignore the
  // field entirely. Each entry is a known module ID — keeping the enum
  // in sync with `ALL_EMPLOYEE_MODULES` via a runtime cast is fine here
  // because zod validates membership on submit. Marked `.optional()`
  // rather than `.default([])` so the inferred form type stays
  // `string[] | undefined` (with `.default()` the input vs output types
  // diverge and react-hook-form's `Resolver<TFieldValues>` generic
  // disagrees with the resolved type).
  moduleAccess: z
    .array(z.enum(ALL_EMPLOYEE_MODULES as unknown as [string, ...string[]]))
    .optional(),
});

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Today's date in `YYYY-MM-DD` for the date input default. */
function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Generate a 16-character random password using
 * `crypto.getRandomValues` (browser-native). Mixes upper / lower /
 * digits / symbols for a reasonable default; admin can edit before
 * submitting if they want something memorable.
 */
function generatePassword(length = 16): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  // `crypto` is always defined in the browser; we're inside a
  // 'use client' boundary, so this never runs server-side.
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out;
}

// ---------------------------------------------------------------------------
// API response types (what we care about)
// ---------------------------------------------------------------------------

interface CreatedUser {
  id: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

/** Pull a useful message out of a JSON error body. */
function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 409) {
    return 'A user with that email already exists.';
  }
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'Only administrators can create employees.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function EmployeeCreateForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = React.useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      password: '',
      name: '',
      role: Role.EMPLOYEE,
      phone: '',
      designation: '',
      joinedAt: today(),
      avatarUrl: '',
      // Empty default = "all modules" (legacy/back-compat). Admin can
      // tick any subset before submit; admin rows ignore this regardless.
      moduleAccess: [],
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  // Watching role so we hide the module-access section for ADMIN — the
  // server ignores the value for admins anyway, but visually noisy.
  const watchedRole = form.watch('role');

  async function onSubmit(values: FormValues) {
    // Strip empty strings on optional fields and convert the date
    // string to ISO so the API's `z.coerce.date()` parses it cleanly.
    const payload: Record<string, unknown> = {
      email: values.email,
      password: values.password,
      name: values.name,
      role: values.role,
      joinedAt: new Date(`${values.joinedAt}T00:00:00.000Z`).toISOString(),
      // Always send moduleAccess so the server's "normalise admin → []"
      // path runs deterministically. For employees this carries the
      // ticked subset (or `[]` for the legacy default).
      moduleAccess: values.moduleAccess ?? [],
    };
    if (values.phone && values.phone.trim() !== '') {
      payload.phone = values.phone.trim();
    }
    if (values.designation && values.designation.trim() !== '') {
      payload.designation = values.designation.trim();
    }
    if (values.avatarUrl && values.avatarUrl.trim() !== '') {
      payload.avatarUrl = values.avatarUrl.trim();
    }

    let res: Response;
    try {
      res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    let body: ApiErrorBody | CreatedUser | null = null;
    try {
      body = (await res.json()) as ApiErrorBody | CreatedUser;
    } catch {
      body = null;
    }

    if (!res.ok) {
      const msg = describeError(body as ApiErrorBody | null, res.status);
      toast.error(msg);
      return;
    }

    const created = body as CreatedUser | null;
    if (!created?.id) {
      toast.error('Unexpected response from the server.');
      return;
    }

    toast.success('Employee created.');
    // Hard navigation so the new employee's profile renders against
    // a freshly issued response (no client cache from the list page).
    router.replace(`/employees/${created.id}`);
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
                    placeholder="Lal Singh"
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
                    placeholder="lal@chitly.live"
                    autoComplete="off"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <div className="flex items-stretch gap-2">
                  <div className="relative flex-1">
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const generated = generatePassword();
                      form.setValue('password', generated, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                      setShowPassword(true);
                    }}
                    disabled={isSubmitting}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    <span>Generate</span>
                  </Button>
                </div>
              </FormControl>
              <FormDescription>
                Share this password with the new user once. They can change
                it after signing in (admin reset is also available).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
                  disabled={isSubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={Role.EMPLOYEE}>Employee</SelectItem>
                    <SelectItem value={Role.ADMIN}>Admin</SelectItem>
                  </SelectContent>
                </Select>
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
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
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
                    placeholder="+91 98765 43210"
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
                  <Input
                    placeholder="Marketing Lead"
                    disabled={isSubmitting}
                    {...field}
                  />
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
                  placeholder="https://…"
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
          Module access picker (FEATURE-A / v0.1.3). Hidden for ADMIN
          because admins always see every module regardless — the server
          normalises moduleAccess to `[]` on persist for admin rows. We
          keep the field registered with react-hook-form even when
          hidden so the controlled state never goes stale if the user
          flips role back to EMPLOYEE.
        */}
        {watchedRole === Role.EMPLOYEE ? (
          <FormField
            control={form.control}
            name="moduleAccess"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Module access</FormLabel>
                <FormDescription>
                  Choose which sections this employee can see. Leave all
                  unchecked to grant full access (legacy default). Admins
                  see everything regardless.
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
                              field.onChange(value.filter((m) => m !== mod));
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
        ) : (
          <div
            role="note"
            className="rounded-md border border-dashed border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
          >
            Admins see all modules. Module access is only configurable
            for employees.
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => router.push('/employees')}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span>Creating…</span>
              </>
            ) : (
              'Create employee'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
