const GITHUB_PREFIX = 'https://github.com/';
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type ParsedRepoUrl = { kind: 'valid'; repoUrl: string } | { kind: 'invalid'; reason: string };

export function parseRepoUrl(input: string): ParsedRepoUrl {
  const ownerAndRepo = removeSuffix(removeSuffix(removePrefix(input, GITHUB_PREFIX), '/'), '.git');
  const parts = ownerAndRepo.split('/');
  if (parts.length !== 2) {
    return { kind: 'invalid', reason: `Expected owner/repo or ${GITHUB_PREFIX}owner/repo, got "${input}"` };
  }
  const [owner, repo] = parts;
  if (!isValidName(owner) || !isValidName(repo)) {
    return { kind: 'invalid', reason: `Invalid owner or repo name in "${input}"` };
  }
  return { kind: 'valid', repoUrl: `${GITHUB_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}` };
}

function isValidName(name: string | undefined): name is string {
  if (name === undefined || name === '.' || name === '..') {
    return false;
  }
  return NAME_PATTERN.test(name);
}

function removePrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function removeSuffix(text: string, suffix: string): string {
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}
