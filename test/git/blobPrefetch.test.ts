import { describe, expect, it } from 'vitest';
import { listBlobShas, listMissingShas } from '../../src/git/blobPrefetch.js';

const ZERO_SHA = '0'.repeat(40);
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const ADDED_SHA = 'c'.repeat(40);
const SUBMODULE_SHA = 'd'.repeat(40);

describe('listBlobShas', () => {
  it('collects both sides, skips all-zero shas and submodules, and lists each blob once', () => {
    const diffTreeLines = [
      `:100644 100644 ${OLD_SHA} ${NEW_SHA} M\treadme.md`,
      `:000000 100644 ${ZERO_SHA} ${ADDED_SHA} A\tnew.env`,
      `:100644 000000 ${NEW_SHA} ${ZERO_SHA} D\tgone.md`,
      `:160000 160000 ${SUBMODULE_SHA} ${SUBMODULE_SHA} M\tvendor/lib`,
    ];

    expect(listBlobShas(diffTreeLines)).toEqual([OLD_SHA, NEW_SHA, ADDED_SHA]);
  });

  it('returns nothing for no lines', () => {
    expect(listBlobShas([])).toEqual([]);
  });
});

describe('listMissingShas', () => {
  it('keeps only the shas git reports missing', () => {
    expect(listMissingShas([`${OLD_SHA} blob 12`, `${NEW_SHA} missing`])).toEqual([NEW_SHA]);
  });
});
