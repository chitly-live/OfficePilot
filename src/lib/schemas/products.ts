/**
 * Zod schemas for `/api/products`.
 */

import { z } from 'zod';

import { slugify } from '@/lib/products';

const nameField = z.string().trim().min(1, 'Name is required').max(60, 'Name must be 60 characters or fewer');
const colorField = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #6366f1');

export const productCreateSchema = z
  .object({
    name: nameField,
    slug: z.string().trim().max(40).optional(),
    color: colorField.optional(),
    sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .transform((v) => ({
    ...v,
    slug: slugify(v.slug && v.slug.length > 0 ? v.slug : v.name),
  }))
  .refine((v) => v.slug.length > 0, { message: 'Slug cannot be empty', path: ['slug'] })
  .refine((v) => v.slug !== 'all' && v.slug !== 'company', {
    message: '"all" and "company" are reserved',
    path: ['slug'],
  });

export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = z
  .object({
    name: nameField.optional(),
    color: colorField.nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const productProjection = {
  id: true,
  name: true,
  slug: true,
  color: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ProductPublic = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};
