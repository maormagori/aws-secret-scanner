import { LeakTypeSchema, type LeakType } from '../domain/finding.js';

export interface DetectedLeak {
  leakType: LeakType;
  leakValue: string;
}

const ACCESS_KEY_ID_PATTERN = /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])/g;
// Identifier-like forms only (aws_secret, awsSecret, secret-access-key), so prose such as `aws.env | 3 | secret` doesn't match.
const SECRET_KEYWORD_PATTERN = /aws[_\-.\s]?secret|secret[_\-.\s]?access[_\-.\s]?key/i;
// The look-arounds make the 40 characters a whole token, so `key=wJalr…` yields the value after `=`.
const SECRET_ACCESS_KEY_PATTERN = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g;
// A git commit SHA is also 40 characters; real secret keys are base64 and practically never pure lowercase hex.
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function detectLeaks(line: string): DetectedLeak[] {
  const leaks: DetectedLeak[] = [];
  for (const match of line.matchAll(ACCESS_KEY_ID_PATTERN)) {
    leaks.push({ leakType: LeakTypeSchema.enum.aws_access_key_id, leakValue: match[0] });
  }
  if (!SECRET_KEYWORD_PATTERN.test(line)) {
    return leaks;
  }
  for (const match of line.matchAll(SECRET_ACCESS_KEY_PATTERN)) {
    const isGitSha = GIT_SHA_PATTERN.test(match[0]);
    if (isGitSha) {
      continue;
    }
    leaks.push({ leakType: LeakTypeSchema.enum.aws_secret_access_key, leakValue: match[0] });
  }
  return leaks;
}
