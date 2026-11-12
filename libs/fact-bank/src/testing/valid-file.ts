// A full, made-up bank file. Every value here is invented.
export function validFile() {
  return {
    version: '1',
    fields: {
      firstName: 'Sam',
      lastName: 'Example',
      email: 'sam@example.com',
      phone: {
        countryCode: '+44',
        number: '7700 900123',
        country: 'United Kingdom',
      },
      city: 'Leeds',
      country: 'United Kingdom',
      links: {
        linkedin: 'https://www.linkedin.com/in/sam-example',
        github: 'https://github.com/sam-example',
        portfolio: 'https://sam.example',
      },
      resume: 'resume.pdf',
    },
    facts: ['I am a British citizen.', 'I am willing to relocate.'],
    answers: [
      {
        id: 'notice-period',
        question: 'What is your notice period?',
        answer: 'One month.',
      },
      {
        id: 'contractor-rate',
        question: 'What is your day rate?',
        variants: [
          { when: 'The job is a contract role.', answer: 'GBP 500 per day.' },
        ],
      },
    ],
    stories: [
      {
        id: 'migration-project',
        title: 'Database migration',
        story: 'I moved a large service to a new database without downtime.',
        tags: ['databases'],
      },
    ],
    // Loose on purpose: tests change one thing at a time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as Record<string, any>;
}
