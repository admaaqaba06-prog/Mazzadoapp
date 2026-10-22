// The server's governorate list must not drift from the client's.
//
// `functions/pickupDetails.js` carries its own copy of the twelve governorate
// ids because Cloud Functions cannot import a .ts file from src/. A copy with
// nothing holding it to the original is a copy that goes stale: the client adds
// a governorate, sellers start picking it, and the server rejects every one of
// those submissions with "pick the governorate" — a validation error pointing
// at a field the seller filled in correctly.
//
// src/utils/jordanCities.ts is the source of truth. This reads it as TEXT
// rather than importing it, so the test needs no TS pipeline and still fails
// the moment the two disagree.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CITY_IDS } from './pickupDetails.js';

function clientCityIds() {
  const src = readFileSync(new URL('../src/utils/jordanCities.ts', import.meta.url), 'utf8');
  const start = src.indexOf('JORDAN_GOVERNORATES: JordanGovernorate[] = [');
  expect(start, 'JORDAN_GOVERNORATES was renamed — update this parity guard').toBeGreaterThan(-1);
  const end = src.indexOf('];', start);
  const block = src.slice(start, end);
  return [...block.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
}

describe('governorate list parity', () => {
  it('reads a non-empty list from the client, so this guard cannot pass vacuously', () => {
    expect(clientCityIds().length).toBeGreaterThan(5);
  });

  it('matches the client exactly, in the same order', () => {
    expect(CITY_IDS).toEqual(clientCityIds());
  });
});
