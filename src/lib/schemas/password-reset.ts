/**
 * Zod schemas for the self-service password reset endpoints.
 *
 *   • POST /api/auth/forgot-password → `forgotPasswordSchema`
 *   • POST /api/auth/reset-password  → `resetPasswordSchema`
 *
 * The password rule is the same `passwordField` the Employees module
 * uses, so a self-service reset can't set anything an admin couldn't.
 */

import { z } from 'zod';

import {
  RESET_TOKEN_MAX_LENGTH,
  RESET_TOKEN_MIN_LENGTH,
} from '@/lib/password-reset';
import { passwordField } from '@/lib/schemas/users';

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(254, 'Email is too long')
    .email('Enter a valid email address'),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .trim()
    .min(RESET_TOKEN_MIN_LENGTH, 'Invalid reset link')
    .max(RESET_TOKEN_MAX_LENGTH, 'Invalid reset link'),
  password: passwordField,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
