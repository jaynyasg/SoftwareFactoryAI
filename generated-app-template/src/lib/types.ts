/**
 * JSON-serialisable DTOs describing the API contract between the server route
 * handlers and the browser. These are plain interfaces (no Prisma imports) so
 * client components can use them without pulling server code into the bundle.
 * Dates are serialised to ISO strings over the wire.
 */

export interface CustomerDTO {
  id: string;
  name: string;
  email: string;
}

export interface ProviderDTO {
  id: string;
  name: string;
  email: string;
  expertise: string;
}

export interface BriefDTO {
  id: string;
  summary: string;
  scope: string;
  successCriteria: string;
  suggestedBudget: number;
  source: string;
}

export interface StatusEventDTO {
  id: string;
  type: string;
  message: string;
  proposalId: string | null;
  createdAt: string;
}

export interface ProposalDTO {
  id: string;
  message: string;
  price: number;
  status: string;
  createdAt: string;
  provider: ProviderDTO;
}

export interface ServiceRequestDTO {
  id: string;
  title: string;
  description: string;
  category: string;
  budget: number;
  status: string;
  createdAt: string;
  customer: CustomerDTO;
  brief: BriefDTO | null;
  proposals: ProposalDTO[];
  statusEvents: StatusEventDTO[];
}

export interface HealthDTO {
  status: 'ok' | 'degraded';
  database: boolean;
  requestCount: number;
  proposalCount: number;
  timestamp: string;
}
