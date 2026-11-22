import { describe, expect, it } from 'vitest';
import { LeakTypeSchema } from '../../src/domain/finding.js';
import { detectLeaks } from '../../src/scanner/detector.js';

const ACCESS_KEY_ID = LeakTypeSchema.enum.aws_access_key_id;
const SECRET_ACCESS_KEY = LeakTypeSchema.enum.aws_secret_access_key;
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('detectLeaks', () => {
  it('finds an AKIA access key id', () => {
    expect(detectLeaks('key = "AKIAIOSFODNN7EXAMPLE"')).toEqual([
      { leakType: ACCESS_KEY_ID, leakValue: 'AKIAIOSFODNN7EXAMPLE' },
    ]);
  });

  it('finds an ASIA temporary access key id', () => {
    expect(detectLeaks('ASIAIOSFODNN7EXAMPLE')).toEqual([
      { leakType: ACCESS_KEY_ID, leakValue: 'ASIAIOSFODNN7EXAMPLE' },
    ]);
  });

  it('ignores AKIA followed by only 15 characters', () => {
    expect(detectLeaks('AKIAIOSFODNN7EXAMPL')).toEqual([]);
  });

  it('ignores an AKIA run that is part of a longer token', () => {
    expect(detectLeaks('AKIAIOSFODNN7EXAMPLEX')).toEqual([]);
  });

  it('ignores a lowercase akia id', () => {
    expect(detectLeaks('akiaiosfodnn7example')).toEqual([]);
  });

  it('finds exactly the 40-character secret after the keyword', () => {
    expect(detectLeaks(`aws_secret_access_key=${EXAMPLE_SECRET}`)).toEqual([
      { leakType: SECRET_ACCESS_KEY, leakValue: EXAMPLE_SECRET },
    ]);
  });

  it('ignores a 40-character string without a secret keyword', () => {
    expect(detectLeaks(`checksum=${EXAMPLE_SECRET}`)).toEqual([]);
  });

  it.each(['AWS_SECRET_ACCESS_KEY', 'aws_secret_access_key', 'awsSecretAccessKey', 'secretAccessKey', 'aws secret'])(
    'finds a secret after the keyword %s',
    (keyword) => {
      expect(detectLeaks(`${keyword}: ${EXAMPLE_SECRET}`)).toEqual([
        { leakType: SECRET_ACCESS_KEY, leakValue: EXAMPLE_SECRET },
      ]);
    },
  );

  it('ignores a markdown table row where aws and secret are separate words', () => {
    const fixtureLine =
      '| 9 | 27de6e3aefa563a013c264ccb33a317520ed8608 | 2025-01-03T10:00:00Z | Alice Dev <alice@example.com> | config/aws.env | 3 | secret key | wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY | main |';

    expect(detectLeaks(fixtureLine)).toEqual([]);
  });

  it('ignores a git commit sha on a line with a secret keyword', () => {
    expect(detectLeaks('aws_secret_access_key: 27de6e3aefa563a013c264ccb33a317520ed8608')).toEqual([]);
  });

  it('returns two findings for two keys on one line', () => {
    expect(detectLeaks(`AWS_SECRET_ACCESS_KEY=${EXAMPLE_SECRET} id=AKIAIOSFODNN7EXAMPLE`)).toEqual([
      { leakType: ACCESS_KEY_ID, leakValue: 'AKIAIOSFODNN7EXAMPLE' },
      { leakType: SECRET_ACCESS_KEY, leakValue: EXAMPLE_SECRET },
    ]);
  });
});
