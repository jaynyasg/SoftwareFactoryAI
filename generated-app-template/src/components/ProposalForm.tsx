'use client';

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { submitProposal } from '@/lib/api-client';
import type { ServiceRequestDTO } from '@/lib/types';

const EMPTY = {
  requestId: '',
  providerName: '',
  providerEmail: '',
  providerExpertise: '',
  message: '',
  price: '',
};

export function ProposalForm({
  requests,
  onSubmitted,
}: {
  requests: ServiceRequestDTO[];
  onSubmitted: () => void | Promise<void>;
}) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof typeof EMPTY) {
    return (
      event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => setForm((current) => ({ ...current, [key]: event.target.value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitProposal({
        requestId: form.requestId,
        providerName: form.providerName,
        providerEmail: form.providerEmail,
        providerExpertise: form.providerExpertise || undefined,
        message: form.message,
        price: Number(form.price) || 0,
      });
      setForm(EMPTY);
      await onSubmitted();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form card" onSubmit={(event) => void handleSubmit(event)}>
      <h3>Submit a proposal</h3>
      <label className="field">
        <span>Request</span>
        <select
          data-testid="prop-request-select"
          value={form.requestId}
          onChange={update('requestId')}
          required
        >
          <option value="">Select a request…</option>
          {requests.map((request) => (
            <option key={request.id} value={request.id}>
              {request.title}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Provider name</span>
          <input
            data-testid="prop-provider-name"
            value={form.providerName}
            onChange={update('providerName')}
            required
          />
        </label>
        <label className="field">
          <span>Provider email</span>
          <input
            type="email"
            data-testid="prop-provider-email"
            value={form.providerEmail}
            onChange={update('providerEmail')}
            required
          />
        </label>
      </div>
      <label className="field">
        <span>Expertise (optional)</span>
        <input
          data-testid="prop-provider-expertise"
          value={form.providerExpertise}
          onChange={update('providerExpertise')}
        />
      </label>
      <label className="field">
        <span>Message</span>
        <textarea
          data-testid="prop-message"
          value={form.message}
          onChange={update('message')}
          rows={3}
          required
        />
      </label>
      <label className="field">
        <span>Price</span>
        <input
          type="number"
          min="0"
          data-testid="prop-price"
          value={form.price}
          onChange={update('price')}
          required
        />
      </label>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" data-testid="prop-submit" disabled={submitting || !form.requestId}>
        {submitting ? 'Submitting…' : 'Submit proposal'}
      </button>
    </form>
  );
}
