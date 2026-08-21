/**
 * Data access for the marketplace, backed by a single Prisma client.
 *
 * The client is created lazily (first call to `getPrisma`) and memoised on
 * globalThis in non-production so Next.js dev hot-reloads reuse one connection.
 * Lazy creation also means importing this module during `next build` does not
 * require DATABASE_URL — it is only read when a query first runs.
 *
 * This module is the single owner of the Prisma singleton. `status-events.ts`
 * imports `getPrisma` from here and is imported back for the cohesive
 * create/submit operations; the cycle is safe because each side only uses the
 * other inside function bodies (never at module-evaluation time).
 */
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { generateBrief } from './ai-brief';
import { appendStatusEvent } from './status-events';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  const existing = globalForPrisma.prisma;
  if (existing) {
    return existing;
  }
  const client = new PrismaClient();
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client;
  }
  return client;
}

/** Either the root client or an interactive-transaction client. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Service requests are always read with this relation graph attached. */
const requestInclude = {
  customer: true,
  brief: true,
  proposals: { include: { provider: true }, orderBy: { createdAt: 'desc' } },
  statusEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ServiceRequestInclude;

export type ServiceRequestWithRelations = Prisma.ServiceRequestGetPayload<{
  include: typeof requestInclude;
}>;

export async function upsertCustomer(
  name: string,
  email: string,
  db: DbClient = getPrisma(),
) {
  return db.customer.upsert({
    where: { email },
    update: { name },
    create: { name, email },
  });
}

export async function upsertProvider(
  name: string,
  email: string,
  expertise: string,
  db: DbClient = getPrisma(),
) {
  return db.provider.upsert({
    where: { email },
    update: { name, expertise },
    create: { name, email, expertise },
  });
}

export async function getServiceRequest(
  id: string,
  db: DbClient = getPrisma(),
): Promise<ServiceRequestWithRelations | null> {
  return db.serviceRequest.findUnique({ where: { id }, include: requestInclude });
}

export async function listServiceRequests(
  db: DbClient = getPrisma(),
): Promise<ServiceRequestWithRelations[]> {
  return db.serviceRequest.findMany({ include: requestInclude, orderBy: { createdAt: 'desc' } });
}

export interface CreateRequestInput {
  customerName: string;
  customerEmail: string;
  title: string;
  description: string;
  category: string;
  budget: number;
}

/**
 * Create a service request, generate + persist its AI brief, and record the
 * REQUEST_CREATED and BRIEF_GENERATED status events — all in one transaction.
 */
export async function submitServiceRequest(
  input: CreateRequestInput,
): Promise<ServiceRequestWithRelations> {
  const brief = await generateBrief({
    title: input.title,
    description: input.description,
    category: input.category,
    budget: input.budget,
  });

  const id = await getPrisma().$transaction(async (tx) => {
    const customer = await upsertCustomer(input.customerName, input.customerEmail, tx);
    const request = await tx.serviceRequest.create({
      data: {
        title: input.title,
        description: input.description,
        category: input.category,
        budget: input.budget,
        customerId: customer.id,
      },
    });
    await tx.aIBrief.create({ data: { ...brief, requestId: request.id } });
    await appendStatusEvent(
      { requestId: request.id, type: 'REQUEST_CREATED', message: `Request "${request.title}" created` },
      tx,
    );
    await appendStatusEvent(
      {
        requestId: request.id,
        type: 'BRIEF_GENERATED',
        message: `AI brief generated (${brief.source})`,
      },
      tx,
    );
    return request.id;
  });

  const created = await getServiceRequest(id);
  if (!created) {
    throw new Error(`Service request ${id} vanished after creation`);
  }
  return created;
}

export interface CreateProposalInput {
  requestId: string;
  providerName: string;
  providerEmail: string;
  providerExpertise?: string;
  message: string;
  price: number;
}

export type ProposalWithProvider = Prisma.ProposalGetPayload<{ include: { provider: true } }>;

/**
 * Submit a provider proposal for a request, mark the request PROPOSED, and
 * record a PROPOSAL_SUBMITTED status event — in one transaction.
 */
export async function submitProposal(
  input: CreateProposalInput,
): Promise<ProposalWithProvider> {
  return getPrisma().$transaction(async (tx) => {
    const request = await tx.serviceRequest.findUnique({ where: { id: input.requestId } });
    if (!request) {
      throw new Error(`Service request ${input.requestId} not found`);
    }
    const provider = await upsertProvider(
      input.providerName,
      input.providerEmail,
      input.providerExpertise ?? 'General',
      tx,
    );
    const proposal = await tx.proposal.create({
      data: {
        requestId: input.requestId,
        providerId: provider.id,
        message: input.message,
        price: input.price,
      },
      include: { provider: true },
    });
    await tx.serviceRequest.update({ where: { id: input.requestId }, data: { status: 'PROPOSED' } });
    await appendStatusEvent(
      {
        requestId: input.requestId,
        type: 'PROPOSAL_SUBMITTED',
        message: `Proposal from ${provider.name} for ${input.price}`,
        proposalId: proposal.id,
      },
      tx,
    );
    return proposal;
  });
}

export async function listProposals(
  requestId?: string,
  db: DbClient = getPrisma(),
): Promise<ProposalWithProvider[]> {
  return db.proposal.findMany({
    where: requestId ? { requestId } : undefined,
    include: { provider: true },
    orderBy: { createdAt: 'desc' },
  });
}

export type ProposalDecision = 'accept' | 'reject';

/**
 * Accept or reject a proposal. Accepting also rejects the request's other open
 * proposals and closes the request. Records a status event either way.
 */
export async function decideProposal(
  proposalId: string,
  decision: ProposalDecision,
): Promise<ProposalWithProvider> {
  return getPrisma().$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({ where: { id: proposalId } });
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }
    const accepted = decision === 'accept';
    const updated = await tx.proposal.update({
      where: { id: proposalId },
      data: { status: accepted ? 'ACCEPTED' : 'REJECTED' },
      include: { provider: true },
    });
    if (accepted) {
      await tx.proposal.updateMany({
        where: { requestId: proposal.requestId, id: { not: proposalId }, status: 'SUBMITTED' },
        data: { status: 'REJECTED' },
      });
      await tx.serviceRequest.update({
        where: { id: proposal.requestId },
        data: { status: 'ACCEPTED' },
      });
    }
    await appendStatusEvent(
      {
        requestId: proposal.requestId,
        type: accepted ? 'PROPOSAL_ACCEPTED' : 'PROPOSAL_REJECTED',
        message: accepted ? `Proposal ${proposalId} accepted` : `Proposal ${proposalId} rejected`,
        proposalId,
      },
      tx,
    );
    return updated;
  });
}
