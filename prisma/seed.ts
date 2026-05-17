/**
 * Prisma seed script (SPEC.md §2.3, §3.1).
 *
 * Idempotent: creates exactly one admin user from env vars and a fixed set of
 * default `Setting` rows. Re-running this script must never fail or duplicate.
 *
 * Run via:  npx prisma db seed
 */

import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const BCRYPT_COST = 12;

interface SeedSetting {
  key: string;
  value: string;
}

const DEFAULT_SETTINGS: SeedSetting[] = [
  { key: 'claude_model', value: 'claude-sonnet-4-6' },
  { key: 'daily_digest_hour', value: '9' },
  { key: 'currency', value: 'INR' },
  { key: 'daily_digest_enabled', value: 'true' },
];

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must be set in the environment before seeding.',
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const admin = await prisma.user.upsert({
    where: { email },
    // On re-run we refresh the password hash and ensure the account is active
    // and still ADMIN, but we leave name/profile fields untouched.
    update: {
      passwordHash,
      role: Role.ADMIN,
      isActive: true,
    },
    create: {
      email,
      passwordHash,
      name: 'Admin',
      role: Role.ADMIN,
      isActive: true,
    },
    select: { id: true, email: true, role: true, isActive: true },
  });

  console.log(
    `[seed] admin user upserted: id=${admin.id} email=${admin.email} role=${admin.role} isActive=${admin.isActive}`,
  );
}

async function seedDefaultSettings(): Promise<void> {
  for (const { key, value } of DEFAULT_SETTINGS) {
    // Idempotent: only create if missing. Never overwrite an existing
    // configured value (e.g. an admin who changed `claude_model`).
    const result = await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
    console.log(`[seed] setting ensured: ${result.key}=${result.value}`);
  }
}

async function main(): Promise<void> {
  console.log('[seed] starting…');
  await seedAdmin();
  await seedDefaultSettings();
  console.log('[seed] done.');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
