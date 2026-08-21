'use client';

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { createRequest } from '@/lib/api-client';

const EMPTY = {
  customerName: '',
  customerEmail: '',
  title: '',
  description: '',
  category: '',
  budget: '',
};

export function RequestForm({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof typeof EMPTY) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createRequest({
        customerName: form.customerName,
        customerEmail: form.customerEmail,
        title: form.title,
        description: form.description,
        category: form.category,
        budget: Number(form.budget) || 0,
      });
      setForm(EMPTY);
      await onCreated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form card" onSubmit={(event) => void handleSubmit(event)}>
      <h3>New service request</h3>
      <div className="field-row">
        <label className="field">
          <span>Your name</span>
          <input
            data-testid="req-customer-name"
            value={form.customerName}
            onChange={update('customerName')}
            required
          />
        </label>
        <label className="field">
          <span>Your email</span>
          <input
            type="email"
            data-testid="req-customer-email"
            value={form.customerEmail}
            onChange={update('customerEmail')}
            required
          />
        </label>
      </div>
      <label className="field">
        <span>Title</span>
        <input data-testid="req-title" value={form.title} onChange={update('title')} required />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          data-testid="req-description"
          value={form.description}
          onChange={update('description')}
          rows={3}
          required
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Category</span>
          <input
            data-testid="req-category"
            value={form.category}
            onChange={update('category')}
            required
          />
        </label>
        <label className="field">
          <span>Budget</span>
          <input
            type="number"
            min="0"
            data-testid="req-budget"
            value={form.budget}
            onChange={update('budget')}
            required
          />
        </label>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" data-testid="req-submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit request'}
      </button>
    </form>
  );
}
