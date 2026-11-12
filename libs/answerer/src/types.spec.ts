import { describe, expect, it } from 'vitest';
import { CHOICE_TYPES, FIELD_TYPES, TEXT_TYPES } from './types.js';

describe('field types', () => {
  it('lists exactly the nine field types', () => {
    expect([...FIELD_TYPES]).toEqual([
      'text',
      'textarea',
      'number',
      'select',
      'radio',
      'checkbox-group',
      'checkbox',
      'file',
      'typeahead',
    ]);
  });

  it('keeps CHOICE_TYPES and TEXT_TYPES inside FIELD_TYPES', () => {
    for (const t of [...CHOICE_TYPES, ...TEXT_TYPES]) {
      expect(FIELD_TYPES).toContain(t);
    }
  });
});
