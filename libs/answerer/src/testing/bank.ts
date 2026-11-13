import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFactBank } from '@xapply/fact-bank';
import type { Job } from '../types.js';

const examplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fact-bank',
  'fact-bank.example.yaml',
);

/** The example bank (made-up data), loaded once. */
export const bank = loadFactBank(examplePath);

export const job: Job = {
  title: 'Backend Engineer',
  company: 'Acme Payments',
  location: 'London, United Kingdom',
  source: 'LinkedIn',
  description:
    'Acme Payments is hiring a Backend Engineer to build our card payments platform.\n' +
    'You will run services on Kubernetes and take part in daily code review.\n' +
    'We value clear communication and careful ownership of production systems.',
};
