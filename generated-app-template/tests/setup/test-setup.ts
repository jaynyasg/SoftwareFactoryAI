import { afterAll, beforeEach } from 'vitest';
import { getPrisma } from '@/lib/repository';

/**
 * Truncate every table before each test so cases are independent and
 * deterministic. Deletion order respects foreign keys.
 */
beforeEach(async () => {
  const db = getPrisma();
  await db.statusEvent.deleteMany();
  await db.proposal.deleteMany();
  await db.aIBrief.deleteMany();
  await db.serviceRequest.deleteMany();
  await db.provider.deleteMany();
  await db.customer.deleteMany();
});

afterAll(async () => {
  await getPrisma().$disconnect();
});
