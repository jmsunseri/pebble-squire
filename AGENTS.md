# Agent Rules

## Git

- **NEVER** run `git commit`, `git push`, `git reset`, `git rebase`, or any other git mutation unless the user has given explicit, unambiguous permission for that specific operation.
- **ALWAYS** ask for confirmation before committing or pushing, even if the user previously said "commit and push" earlier in the conversation. Permission does not carry over to future operations.
- A message like "commit and push" from the user grants permission for that exact operation at that moment only.
- If the user has told you "don't commit until I say so", remain in that mode until they explicitly tell you otherwise.
- When in doubt, ask. It is better to confirm twice than to commit or push once without permission.
- Do not create pull requests, tags, or releases without explicit permission.

## Workflow

1. Make the requested code or file changes.
2. Run tests or verification steps if appropriate.
3. Show the user a summary of the diff.
4. Ask for explicit permission before committing: e.g., "Do you want me to commit these changes?"
5. Only after the user says yes, run `git commit` (and `git push` only if separately approved).
