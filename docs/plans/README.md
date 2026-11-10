# Plans

Design work that is **decided or being decided but not yet shipped**, one file
per plan. A plan is a decision record, not documentation: once it is done, the
behaviour it describes belongs in the real docs (`docs/render-api.md`,
`docs/deployment.md`, `AGENTS.md`) and the plan keeps only the reasoning and the
alternatives that were rejected.

## Convention

- **One plan, one file:** `NNNN-slug.md`, zero-padded, monotonically increasing.
  Numbers are never reused and never renumbered — `0001` is how a plan is
  referred to in a commit message or a conversation.
- **A header block of `Key: value` lines**, nothing before it in the file:

  ```
  Status: draft
  Created: 2026-11-09
  Updated: 2026-11-09
  Touches: server.mjs, src/lib/server/auth.mjs
  Depends on: —
  Supersedes: —
  ```

- **`Status` is one of five lowercase words**, so it stays greppable:

  | Status        | Means                                        |
  | ------------- | -------------------------------------------- |
  | `draft`       | still being designed, decisions open         |
  | `approved`    | decisions closed, ready to implement         |
  | `in-progress` | implementation underway                      |
  | `done`        | shipped                                      |
  | `abandoned`   | not doing it; the body says why              |

- **Nothing moves.** A finished plan stays where it is with `Status: done`.
  Archiving by moving breaks every link and every number. There is no
  `archive/`.
- **No index file.** A hand-maintained index rots the first week it is not
  updated. List with a command instead:

  ```bash
  rg '^Status:' docs/plans                 # every plan and its status
  rg -l '^Status: approved' docs/plans     # only the ones ready to build
  ```

  On Windows, `Select-String '^Status:' docs/plans/*.md` does the same.

- **Sections are optional.** Use the ones the plan needs; a two-paragraph plan
  does not need seven headings. `Open decisions` and `Not covered` are worth
  keeping for any plan someone else has to implement.

## Why so little

Every extra artefact — a roadmap, a board, a per-plan folder, a status field in
three places — is one more thing that can disagree with the code. Two sources of
truth is the failure mode being avoided here. The plan holds *why* and *what*
(the decisions, the rejected options). The repository holds *how* (current
behaviour, in code and in `docs/`). When they disagree, the repository wins and
the plan is corrected or closed.
