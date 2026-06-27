import { describe, expect, it } from 'vitest';
import {
  decideProposal,
  getServiceRequest,
  listProposals,
  listServiceRequests,
  submitProposal,
  submitServiceRequest,
} from '@/lib/repository';

const requestInput = {
  customerName: 'Test Customer',
  customerEmail: 'customer@test.local',
  title: 'Build an AI search feature',
  description: 'We want semantic search over our internal documentation.',
  category: 'Search',
  budget: 4000,
};

describe('repository', () => {
  it('creates a request with a brief and the two opening status events', async () => {
    const request = await submitServiceRequest(requestInput);
    expect(request.brief).not.toBeNull();
    expect(request.brief?.source).toBe('deterministic-fallback');
    expect(request.status).toBe('OPEN');
    expect(request.statusEvents.map((event) => event.type)).toEqual([
      'REQUEST_CREATED',
      'BRIEF_GENERATED',
    ]);
  });

  it('lists requests newest first', async () => {
    await submitServiceRequest(requestInput);
    await submitServiceRequest({ ...requestInput, title: 'Second request' });
    const all = await listServiceRequests();
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe('Second request');
  });

  it('reuses a customer by email across requests', async () => {
    await submitServiceRequest(requestInput);
    await submitServiceRequest({ ...requestInput, title: 'Another' });
    const all = await listServiceRequests();
    const customerIds = new Set(all.map((request) => request.customerId));
    expect(customerIds.size).toBe(1);
  });

  it('lets a provider submit a proposal and marks the request PROPOSED', async () => {
    const request = await submitServiceRequest(requestInput);
    const proposal = await submitProposal({
      requestId: request.id,
      providerName: 'Acme AI',
      providerEmail: 'team@acme.test',
      message: 'We can deliver this in three weeks.',
      price: 3500,
    });
    expect(proposal.status).toBe('SUBMITTED');
    expect(proposal.provider.name).toBe('Acme AI');

    const after = await getServiceRequest(request.id);
    expect(after?.status).toBe('PROPOSED');
    expect(after?.proposals).toHaveLength(1);
  });

  it('accepts one proposal, rejects the rest, and closes the request', async () => {
    const request = await submitServiceRequest(requestInput);
    const first = await submitProposal({
      requestId: request.id,
      providerName: 'Provider A',
      providerEmail: 'a@providers.test',
      message: 'Option A',
      price: 1000,
    });
    const second = await submitProposal({
      requestId: request.id,
      providerName: 'Provider B',
      providerEmail: 'b@providers.test',
      message: 'Option B',
      price: 2000,
    });

    const accepted = await decideProposal(first.id, 'accept');
    expect(accepted.status).toBe('ACCEPTED');

    const proposals = await listProposals(request.id);
    const secondAfter = proposals.find((proposal) => proposal.id === second.id);
    expect(secondAfter?.status).toBe('REJECTED');

    const after = await getServiceRequest(request.id);
    expect(after?.status).toBe('ACCEPTED');
    expect(after?.statusEvents.map((event) => event.type)).toContain('PROPOSAL_ACCEPTED');
  });

  it('rejects a proposal without closing the request', async () => {
    const request = await submitServiceRequest(requestInput);
    const proposal = await submitProposal({
      requestId: request.id,
      providerName: 'Provider C',
      providerEmail: 'c@providers.test',
      message: 'Option C',
      price: 1500,
    });

    const rejected = await decideProposal(proposal.id, 'reject');
    expect(rejected.status).toBe('REJECTED');

    const after = await getServiceRequest(request.id);
    // Request stays PROPOSED (still open to other proposals) after a rejection.
    expect(after?.status).toBe('PROPOSED');
    expect(after?.statusEvents.map((event) => event.type)).toContain('PROPOSAL_REJECTED');
  });

  it('throws when proposing against a missing request', async () => {
    await expect(
      submitProposal({
        requestId: 'does-not-exist',
        providerName: 'X',
        providerEmail: 'x@providers.test',
        message: 'm',
        price: 1,
      }),
    ).rejects.toThrow();
  });
});
