/**
 * Thin typed fetch helpers used by the client components. They talk to the same
 * route handlers under /api that any other client could call.
 */
import type { HealthDTO, ProposalDTO, ServiceRequestDTO, StatusEventDTO } from './types';

export interface CreateRequestBody {
  customerName: string;
  customerEmail: string;
  title: string;
  description: string;
  category: string;
  budget: number;
}

export interface SubmitProposalBody {
  requestId: string;
  providerName: string;
  providerEmail: string;
  providerExpertise?: string;
  message: string;
  price: number;
}

export interface DecideProposalBody {
  proposalId: string;
  action: 'accept' | 'reject';
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export function listRequests(): Promise<{ requests: ServiceRequestDTO[] }> {
  return jsonFetch('/api/requests');
}

export function createRequest(body: CreateRequestBody): Promise<{ request: ServiceRequestDTO }> {
  return jsonFetch('/api/requests', { method: 'POST', body: JSON.stringify(body) });
}

export function submitProposal(body: SubmitProposalBody): Promise<{ proposal: ProposalDTO }> {
  return jsonFetch('/api/proposals', { method: 'POST', body: JSON.stringify(body) });
}

export function decideProposal(body: DecideProposalBody): Promise<{ proposal: ProposalDTO }> {
  return jsonFetch('/api/proposals', { method: 'PATCH', body: JSON.stringify(body) });
}

export function getStatus(): Promise<{ health: HealthDTO; events: StatusEventDTO[] }> {
  return jsonFetch('/api/status');
}
