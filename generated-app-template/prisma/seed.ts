/**
 * Deterministic seed: a couple of customers and providers plus one sample
 * service request with its AI brief and opening status events. Uses fixed ids
 * and upserts so it is idempotent and safe to re-run (dev, e2e bootstrap).
 *
 * Note: the `AIBrief` model is exposed on the client as `prisma.aIBrief`
 * (Prisma lower-cases only the first letter of the model name).
 */
import { PrismaClient } from '@prisma/client';
import { generateBrief } from '../src/lib/ai-brief';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const customers = [
    { id: 'cust_ada', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'cust_grace', name: 'Grace Hopper', email: 'grace@example.com' },
  ];
  for (const customer of customers) {
    await prisma.customer.upsert({
      where: { id: customer.id },
      update: { name: customer.name, email: customer.email },
      create: customer,
    });
  }

  const providers = [
    {
      id: 'prov_acme',
      name: 'Acme AI Studio',
      email: 'studio@acme.example',
      expertise: 'LLM apps, RAG, chatbots',
    },
    {
      id: 'prov_globex',
      name: 'Globex ML',
      email: 'ml@globex.example',
      expertise: 'Computer vision, MLOps',
    },
  ];
  for (const provider of providers) {
    await prisma.provider.upsert({
      where: { id: provider.id },
      update: { name: provider.name, email: provider.email, expertise: provider.expertise },
      create: provider,
    });
  }

  const requestId = 'req_seed_chatbot';
  const request = {
    id: requestId,
    title: 'Customer support chatbot',
    description:
      'We need an AI chatbot to triage and answer customer support tickets, with a clean handoff to human agents for anything it cannot resolve.',
    category: 'Conversational AI',
    budget: 8000,
    customerId: 'cust_ada',
  };
  await prisma.serviceRequest.upsert({
    where: { id: requestId },
    update: request,
    create: request,
  });

  const brief = await generateBrief({
    title: request.title,
    description: request.description,
    category: request.category,
    budget: request.budget,
  });
  await prisma.aIBrief.upsert({
    where: { requestId },
    update: { ...brief, requestId },
    create: { ...brief, requestId },
  });

  await prisma.statusEvent.upsert({
    where: { id: 'evt_seed_created' },
    update: {},
    create: {
      id: 'evt_seed_created',
      type: 'REQUEST_CREATED',
      message: `Request "${request.title}" created`,
      requestId,
    },
  });
  await prisma.statusEvent.upsert({
    where: { id: 'evt_seed_brief' },
    update: {},
    create: {
      id: 'evt_seed_brief',
      type: 'BRIEF_GENERATED',
      message: `AI brief generated (${brief.source})`,
      requestId,
    },
  });

  console.log('Seed complete: 2 customers, 2 providers, 1 sample request with brief.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
