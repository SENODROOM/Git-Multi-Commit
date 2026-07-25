/**
 * The rotation pool. One message is consumed per commit, per pair.
 * Deliberately generic so they read plausibly against any project.
 */
export const DEFAULT_MESSAGES = [
  'chore: update project files',
  'refactor: simplify internal helpers',
  'docs: clarify usage notes',
  'chore: tidy up formatting',
  'fix: correct minor inconsistencies',
  'chore: update dependencies',
  'refactor: reorganize module layout',
  'docs: expand inline comments',
  'style: apply consistent formatting',
  'chore: remove unused code',
  'fix: handle edge case in input handling',
  'refactor: extract shared logic',
  'chore: sync latest changes',
  'docs: update documentation',
  'chore: general maintenance pass',
];

export const MESSAGE_COUNT = DEFAULT_MESSAGES.length;
